import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';

import { generateFleetReport, uploadReportToSupabase } from './reports.js';
import { sendReportByEmail, sendMfaEmail } from './src/services/mailer.js';
import { processSakaMessage } from './sakaAi.js';
import { runHealthCheck, runConversationRefinement, evaluateConversationalFriction, monitorActiveConversations, logSystemError, logChatTranscript, ensureSentinelTables, scanCloudRunAnomalies } from './src/workers/sentinel.js';
import { ensureSuperadminTables, isSuperadminPhone, sendMorningExecutiveBriefing, maybeSendAiBudgetAlert } from './src/services/superadmin.js';
import { ensureVehicleTableColumns } from './src/services/vehicles.js';
import whatsappRoutes, { handleWhatsAppWebhook as handleWhatsAppWebhookRoute } from './src/routes/whatsapp.js';
import { verifyPaystackSignature } from './src/services/paystack.js';
import { runReminderSweep } from './src/services/maintenanceReminders.js';
import { ensureComplianceCatalog, reviewComplianceCatalog, COMPLIANCE_CATALOG_VERSION } from './src/services/complianceCatalog.js';
import { expireStaleAssignments } from './src/services/driverAssignments.js';
import {
  runRemediationScan,
  refreshRemediationSynthesis,
  checkRemediationPlanTriggers,
  sendRemediationDigest,
  maybeSendUrgentRemediationAlert,
  checkRemediationExecutionRetry,
  ensureRemediationTables,
  checkRemediationDispatchVerification,
  REMEDIATION_SCAN_INTERVAL_MS,
  REMEDIATION_SYNTHESIS_INTERVAL_MS,
  REMEDIATION_DIGEST_HOURS
} from './src/workers/remediation.js';
import { createResilientClient } from './src/services/supabaseClient.js';
import { ensureAiUsageLogsTable, installAiUsageSink, installAiBudgetGuard } from './src/services/aiUsageLog.js';
import {
  ensureAiModelRegistryTables,
  installModelRuntime,
  runModelScoutCycle,
  monitorModelHealth,
  AI_MODEL_SCOUT_INTERVAL_MS
} from './src/services/aiModelRegistry.js';
import { ensureFuelEconomySchema } from './src/services/fuelEconomy.js';
import { ensureReceiptsTable } from './src/services/receipts.js';
import { ensureChatSessionsTable } from './src/services/sessionStore.js';
import { drainQueue, getQueueStats } from './src/services/messageQueue.js';
import { processPendingFollowUps } from './src/services/followups.js';
import { handlePaystackEvent } from './src/services/subscriptions.js';
import { ensureSubscriptionSchema } from './src/db/subscriptionSchema.js';
import { runTrialLifecycleSweep } from './src/services/trialEngine.js';

// 1. Initialize Fastify Server
const fastify = Fastify({ logger: true });

// Register Fastify Rate Limiter for Abuse Prevention
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'],
  errorResponseBuilder: (request, context) => {
    return {
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum ${context.max} requests per ${context.after} allowed.`,
      date: new Date().toISOString()
    };
  }
});

// Attach Sentinel Error Handler
fastify.setErrorHandler(async (error, request, reply) => {
  fastify.log.error(error);
  await logSystemError(supabase, error, request.raw.url || request.routerPath || 'unknown');
  reply.status(error.statusCode || 500).send({
    error: error.name || 'InternalServerError',
    message: error.message || 'An unexpected error occurred.'
  });
});

// Enable raw body string retention for HMAC webhooks
fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    req.rawBody = body.toString('utf8');
    const json = JSON.parse(req.rawBody || '{}');
    done(null, json);
  } catch (err) {
    done(err, undefined);
  }
});


// 2. Initialize Supabase Client (pooled + per-request timeout)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createResilientClient(supabaseUrl, supabaseServiceKey);

// Memory Stores with 24-hour expiry cleanup
const otpStore = new Map();
const emailOtpStore = new Map();
const onboardingStore = new Map(); 
const chatSessions = new Map(); // phone -> { history: [{role, parts}], lastActive: timestamp }
const deactivationOtpStore = new Map(); // phone -> { otp: string, expiresAt: number }

// Note: Country/region detection is centralized in src/routes/whatsapp.js
// (single source of truth) and imported where needed.

// Helper: Queue Delayed Owner Summary Notification (5 minutes)
async function queueOwnerNotification(ownerId, vehicleId, driverId, actionType, detailsSummary) {
  if (!ownerId || ownerId === driverId) return; // Don't notify if driver IS the owner
  try {
    const scheduledFor = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await supabase.from('pending_owner_notifications').insert([{
      owner_id: ownerId,
      vehicle_id: vehicleId,
      driver_id: driverId,
      action_type: actionType,
      details_summary: detailsSummary,
      scheduled_for: scheduledFor,
      processed: false
    }]);
    console.log(`[Queue] 5-min delayed owner notification queued for vehicle ${vehicleId}`);
  } catch (err) {
    console.error('[Queue Error] Failed to queue owner notification:', err);
  }
}

// Helper: Guard Sentinel boundaries so Superadmin doesn't receive general vehicle reminders
function canDeliverVehicleAlert(targetPhone, vehicle) {
  if (!targetPhone) return false;
  if (isSuperadminPhone(targetPhone)) {
    if (!vehicle) return false;
    const cleanAdmin = targetPhone.replace(/[^\d]/g, '');
    const ownerPhone = (vehicle.owner_phone || vehicle.profiles?.phone_number || vehicle.owner?.phone_number || '').replace(/[^\d]/g, '');
    const driverPhone = (vehicle.assigned_driver_profile?.phone_number || vehicle.driver?.phone_number || '').replace(/[^\d]/g, '');
    return cleanAdmin === ownerPhone || cleanAdmin === driverPhone;
  }
  return true;
}

// Boot-time env parity probe (masked). Makes Meta/Paystack secret drift visible
// in the very first Cloud Run log lines instead of a silent webhook 403 storm.
function logWebhookEnvParity() {
  const placeholder = 'meta_app_secret_sakafleet_2026';
  const metaSecret = String(process.env.META_APP_SECRET || '');
  const metaState = !metaSecret
    ? 'MISSING — inbound Meta signature verification is DISABLED (fail-open)'
    : (metaSecret === placeholder
      ? `set (len ${metaSecret.length}) ⚠️ PLACEHOLDER VALUE — real Meta webhooks will 403`
      : `set (len ${metaSecret.length})`);
  console.log(`[ENV] META_APP_SECRET: ${metaState}`);
  for (const key of ['META_VERIFY_TOKEN', 'META_PHONE_NUMBER_ID', 'META_WHATSAPP_TOKEN', 'PAYSTACK_SECRET_KEY', 'PAYSTACK_PUBLIC_KEY']) {
    const value = String(process.env[key] || '');
    console.log(`[ENV] ${key}: ${value ? `set (len ${value.length})` : 'MISSING'}`);
  }
}

// Worker: Process 5-Minute Delayed Owner Notifications
async function processPendingOwnerNotifications() {
  try {
    const nowIso = new Date().toISOString();
    const { data: pending, error } = await supabase
      .from('pending_owner_notifications')
      .select(`
        id,
        action_type,
        details_summary,
        owner:profiles!pending_owner_notifications_owner_id_fkey (phone_number, full_name),
        driver:profiles!pending_owner_notifications_driver_id_fkey (phone_number, full_name),
        vehicle:vehicles!pending_owner_notifications_vehicle_id_fkey (plate_number)
      `)
      .eq('processed', false)
      .lte('scheduled_for', nowIso);

    if (error || !pending || pending.length === 0) return;

    for (const item of pending) {
      const ownerPhone = item.owner?.phone_number;
      const driverName = item.driver?.full_name || item.driver?.phone_number || 'Assigned Driver';
      const plate = item.vehicle?.plate_number || 'Vehicle';

      if (ownerPhone && canDeliverVehicleAlert(ownerPhone, item.vehicle)) {
        const msg = `ðŸ”” *Driver Activity Summary (${plate})*\nDriver *${driverName}* submitted:\nðŸ‘‰ ${item.details_summary}`;
        await sendMetaWhatsAppMessage(ownerPhone, msg);
      }

      await supabase
        .from('pending_owner_notifications')
        .update({ processed: true })
        .eq('id', item.id);
    }
  } catch (err) {
    console.error('Error processing pending owner notifications:', err);
  }
}

setInterval(processPendingOwnerNotifications, 30000); // Check every 30s

// Worker: background follow-up lane (v1.16.0). Slow jobs (fleet reports, deep
// audits) finish here and arrive as a follow-up message while the user keeps
// chatting — Saka never blocks the conversation.
setInterval(() => {
  processPendingFollowUps({
    supabase,
    sendFn: (phone, text) => sendMetaWhatsAppMessage(phone, text)
  }).catch((err) => console.warn('[Worker] Follow-up sweep failed:', err.message));
}, 30000);

// Worker: Account-trial lifecycle — activation reward, T+7 nudge, T-3 digest +
// account extension-offer dispatch, T-24h, T-0 expiry -> Free with PAUSED
// vehicles, and the 15-day winback. ONE worker since v1.16.0: the legacy
// VIN-bound reminder worker was retired so trials never double-message.
setInterval(() => {
  runTrialLifecycleSweep({ supabase, sendWhatsAppFn: sendMetaWhatsAppMessage }).catch(err => {
    console.error('[Worker] Error processing trial lifecycle sweep:', err);
  });
}, 15 * 60 * 1000); // Check every 15 minutes

// Worker: Universal Reminder Sweep — evaluates distance (km/mi) and
// operating-hours thresholds against live readings AND the date-based expiry
// ladder (insurance, inspection/MOT, licensing, permits, driver licences,
// general deadlines) at 30d / 14d / 7d / 24h / overdue.
async function runMaintenanceReminderSweep() {
  try {
    const result = await runReminderSweep({
      supabase,
      sendFn: (phone, text) => sendMetaWhatsAppMessage(phone, text),
      canDeliver: canDeliverVehicleAlert
    });
    if (result?.alerts) {
      console.log(`[Reminders] Sweep: ${result.vehiclesChecked} vehicle(s), ${result.evaluated} reminder(s), ${result.alerts} alert(s), ${result.dispatched} dispatched (${result.expiry?.overdue || 0} expiry item(s) overdue).`);
    }
  } catch (err) {
    console.error('[Worker] Reminder sweep failed:', err.message);
  }
}
setTimeout(runMaintenanceReminderSweep, 90 * 1000); // First pass shortly after boot
setInterval(runMaintenanceReminderSweep, 30 * 60 * 1000); // Every 30 minutes

// Worker: expire driver assignment requests the driver never accepted (48h).
async function runDriverAssignmentExpiry() {
  try {
    const result = await expireStaleAssignments({ supabase });
    if (result?.expired) {
      console.log(`[Assignments] Expired ${result.expired} stale driver assignment(s).`);
    }
  } catch (err) {
    console.error('[Worker] Driver assignment expiry failed:', err.message);
  }
}
setTimeout(runDriverAssignmentExpiry, 5 * 60 * 1000);
setInterval(runDriverAssignmentExpiry, 6 * 60 * 60 * 1000);

// Worker (Sentinel): weekly compliance catalog staleness review. Legal rules
// are NEVER auto-changed — a human must re-verify stale entries.
async function runComplianceCatalogReview() {
  try {
    const result = await reviewComplianceCatalog({ supabase });
    if (result?.stale?.length) {
      const list = result.stale
        .map((entry) => `• ${entry.countryCode} (review by ${String(entry.nextReviewAt).slice(0, 10)})`)
        .join('\n');
      if (process.env.SUPERADMIN_PHONE) {
        await sendMetaWhatsAppMessage(
          process.env.SUPERADMIN_PHONE,
          `🗂️ *Compliance Catalog Review Due (v${COMPLIANCE_CATALOG_VERSION})*\n\n${list}\n\nPlease re-verify these requirements against current law and ship an override or code release. No rules were changed automatically.`
        ).catch(() => {});
      }
      console.log(`[Sentinel] ${result.stale.length} compliance catalog entr(ies) need review.`);
    }
  } catch (err) {
    console.error('[Worker] Compliance catalog review failed:', err.message);
  }
}
setTimeout(runComplianceCatalogReview, 10 * 60 * 1000);
setInterval(runComplianceCatalogReview, 7 * 24 * 60 * 60 * 1000);



setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of chatSessions.entries()) {
    if (now - session.lastActive > 86400000) {
      chatSessions.delete(phone);
    }
  }
}, 3600000);

// Helper: Send WhatsApp Message via Meta Cloud API
async function sendMetaWhatsAppMessage(toPhone, messageBody) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;
  
  if (!phoneNumberId || !token) {
    console.error('Meta WhatsApp credentials missing from environment variables.');
    return null;
  }

  const cleanTo = toPhone.replace('whatsapp:', '').replace('+', '').trim();

  try {
    const response = await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'text',
        text: { body: messageBody }
      })
    });

    const data = await response.json();
    console.log('Meta WhatsApp API Response:', JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error('Meta Cloud API Error Response:', data);
    }
    return data;
  } catch (err) {
    console.error('Failed to dispatch Meta WhatsApp message:', err);
    return null;
  }
}

// 5. Health Check Route
fastify.get('/', async (request, reply) => {
  return { 
    status: 'online', 
    service: 'Saka Backend SaaS (Meta Cloud API & Supabase Persisted)', 
    timestamp: new Date().toISOString() 
  };
});

// 5.1 Warm/liveness probe for Cloud Run (cheap, no DB I/O).
fastify.get('/healthz', async () => ({
  status: 'ok',
  uptimeSeconds: Math.round(process.uptime()),
  queue: getQueueStats(),
  timestamp: new Date().toISOString()
}));

// 6. WhatsApp & Email Auth OTP Request Endpoint (Mandatory Email)
fastify.post('/api/auth/whatsapp/request', async (request, reply) => {
  const { phone, email } = request.body || {};
  if (!phone || !email) return reply.status(400).send({ error: 'Phone number and mandatory email are required' });

  const cleanPhone = phone.startsWith('+') ? phone : `+${phone}`;
  
  // Generate WhatsApp OTP
  const whatsappOtp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(cleanPhone, { otp: whatsappOtp, expiresAt: Date.now() + 300000 });

  // Generate Email OTP
  const emailOtp = Math.floor(100000 + Math.random() * 900000).toString();
  emailOtpStore.set(email.toLowerCase(), { otp: emailOtp, phone: cleanPhone, expiresAt: Date.now() + 300000 });

  // Dispatch WhatsApp OTP
  const waMessage = `Your Saka Admin verification code is: *${whatsappOtp}*. Valid for 5 minutes.`;
  await sendMetaWhatsAppMessage(cleanPhone, waMessage);

  // Dispatch Email OTP via Resend (Clean HTML, no fake attachment)
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    await resend.emails.send({
      from: 'Saka Assistant <reports@reports.sakafleet.com>',
      to: email,
      subject: 'Saka Email Verification Code',
      text: `Your Saka email verification code is: ${emailOtp}. Valid for 5 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #070913; color: #f8fafc; padding: 24px; border-radius: 12px;">
          <h2 style="color: #38BDF8; margin-top: 0;">Saka Verification</h2>
          <p>Hello,</p>
          <p>Your email verification code is:</p>
          <h1 style="color: #38BDF8; letter-spacing: 2px;">${emailOtp}</h1>
          <p>This code is valid for 5 minutes.</p>
          <hr style="border: 0; border-top: 1px solid #1e293b; margin: 20px 0;" />
          <p style="font-size: 12px; color: #94a3b8;">Cryptographically Verified by Saka AI â€¢ <a href="https://sakafleet.com" style="color: #38BDF8;">sakafleet.com</a></p>
        </div>
      `
    });
    fastify.log.info(`Email OTP successfully dispatched to ${email}`);
  } catch (mailErr) {
    fastify.log.error('Failed to send Email OTP:', mailErr.message);
  }

  return { success: true, message: 'OTP sent to WhatsApp and Email successfully.' };
});

// 7. WhatsApp & Email Auth OTP Verify Endpoint (Mandatory Email Linking & Verification)
fastify.post('/api/auth/whatsapp/verify', async (request, reply) => {
  const { phone, otp, email, emailOtp } = request.body || {};
  if (!phone || !otp || !email || !emailOtp) {
    return reply.status(400).send({ success: false, error: 'Phone, WhatsApp OTP, Email, and Email OTP are all required.' });
  }

  const cleanPhone = phone.startsWith('+') ? phone : `+${phone}`;
  const lowerEmail = email.toLowerCase();

  // Verify WhatsApp OTP
  const waRecord = otpStore.get(cleanPhone);
  if (!waRecord || waRecord.expiresAt < Date.now() || waRecord.otp !== otp) {
    return reply.status(400).send({ success: false, error: 'Invalid or expired WhatsApp OTP.' });
  }

  // Verify Email OTP
  const emailRecord = emailOtpStore.get(lowerEmail);
  if (!emailRecord || emailRecord.expiresAt < Date.now() || emailRecord.otp !== emailOtp) {
    return reply.status(400).send({ success: false, error: 'Invalid or expired Email OTP.' });
  }

  otpStore.delete(cleanPhone);
  emailOtpStore.delete(lowerEmail);

  // Upsert Profile with verified email
  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('phone_number', cleanPhone)
    .maybeSingle();

  if (profile) {
    await supabase
      .from('profiles')
      .update({ email: lowerEmail, email_verified: true })
      .eq('id', profile.id);
    profile.email = lowerEmail;
    profile.email_verified = true;
  } else {
    const { data: newProfile, err } = await supabase
      .from('profiles')
      .insert([{ phone_number: cleanPhone, email: lowerEmail, email_verified: true, full_name: 'Asset Owner' }])
      .select()
      .single();
    profile = newProfile;
  }

  return {
    success: true,
    message: 'Authentication and mandatory email verification successful.',
    profile: profile || { phone_number: cleanPhone, email: lowerEmail, email_verified: true, subscription_tier: 'free', full_name: 'Asset Owner' }
  };
});

// ==========================================
// Compliance & expiry reminders (insurance, inspection/MOT, licences, permits,
// general deadlines and driver licences) are now evaluated by the universal
// expiry engine in maintenanceReminders.evaluateExpiryReminders(), invoked by
// runReminderSweep() every 30 minutes (see runMaintenanceReminderSweep above).


// ==========================================
// DAILY END-OF-SHIFT AUTO-AUDIT CRON ENGINE
// ==========================================

async function processAutoAudits() {
  fastify.log.info('Running daily auto-audit scan...');
  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Group vehicles by owner
    const { data: vehicles, error } = await supabase
      .from('vehicles')
      .select(`
        id,
        plate_number,
        make_model,
        owner_id,
        audit_report_frequency,
        profiles!vehicles_owner_id_fkey (phone_number, full_name)
      `)
      .eq('is_business', true)
      .eq('opt_in_earnings', true);

    if (error || !vehicles) {
      fastify.log.error('Failed to fetch vehicles for auto-audit:', error);
      return;
    }

    const ownersMap = new Map();
    for (const v of vehicles) {
      const freq = v.audit_report_frequency || 'on_demand';
      let shouldSend = false;
      if (freq === 'daily') shouldSend = true;
      else if (freq === 'weekly' && now.getDay() === 0) shouldSend = true;

      if (!shouldSend) continue;

      const phone = v.profiles?.phone_number;
      if (!phone) continue;

      if (!ownersMap.has(phone)) {
        ownersMap.set(phone, {
          profile: v.profiles,
          vehicles: []
        });
      }
      ownersMap.get(phone).vehicles.push(v);
    }

    for (const [phone, ownerData] of ownersMap.entries()) {
      let fleetTotalEarnings = 0;
      let fleetTotalExpenses = 0;
      let fleetTotalFuel = 0;
      let recentOps = [];

      for (const v of ownerData.vehicles) {
        // Earnings
        const { data: earnings } = await supabase
          .from('private_earnings')
          .select('revenue_amount')
          .eq('vehicle_id', v.id)
          .gte('logged_at', `${todayStr}T00:00:00Z`);

        const vEarn = earnings ? earnings.reduce((sum, e) => sum + Number(e.revenue_amount), 0) : 0;
        fleetTotalEarnings += vEarn;

        // Expenses
        const { data: expenses } = await supabase
          .from('expense_logs')
          .select('amount, fuel_liters')
          .eq('vehicle_id', v.id)
          .gte('created_at', `${todayStr}T00:00:00Z`);

        const vExp = expenses ? expenses.reduce((sum, e) => sum + Number(e.amount), 0) : 0;
        const vFuel = expenses ? expenses.reduce((sum, e) => sum + Number(e.fuel_liters || 0), 0) : 0;
        
        fleetTotalExpenses += vExp;
        fleetTotalFuel += vFuel;

        recentOps.push({ type: `Earnings: ${v.plate_number}`, value: `KES ${vEarn.toFixed(2)}`, created_at: todayStr });
        recentOps.push({ type: `Expenses: ${v.plate_number}`, value: `KES ${vExp.toFixed(2)}`, created_at: todayStr });
      }

      const reportData = {
        plateNumber: 'All Registered Assets',
        reportType: 'Asset Auto-Audit',
        assignedDriver: ownerData.profile?.full_name || 'Asset Owner',
        fuelLiters: fleetTotalFuel.toFixed(2),
        totalCost: fleetTotalExpenses.toFixed(2),
        burnRate: 'N/A',
        status: `Earnings: KES ${fleetTotalEarnings.toFixed(2)} | Net: KES ${(fleetTotalEarnings - fleetTotalExpenses).toFixed(2)}`,
        reminders: [],
        recentOperations: recentOps
      };

      try {
        const pdfBuffer = await generateFleetReport(reportData);
        const reportUrl = await uploadReportToSupabase(supabase, pdfBuffer, `Fleet_${Date.now()}`);
        const msg = `ðŸ“Š Your Fleet Auto-Audit Report is ready.\n\nNet Earnings Today: KES ${(fleetTotalEarnings - fleetTotalExpenses).toFixed(2)}\nView PDF: ${reportUrl}`;
        await sendMetaWhatsAppMessage(phone, msg);
        fastify.log.info(`Auto-audit sent to ${phone} for entire fleet.`);
      } catch (repErr) {
        fastify.log.error(`Failed to generate auto-audit for fleet owner ${phone}:`, repErr);
      }
    }
  } catch (err) {
    fastify.log.error('Error in auto-audit cron:', err);
  }
}

let lastAuditRunDay = null;
setInterval(() => {
  const now = new Date();
  const currentDay = now.getDate();
  const currentHour = now.getHours();
  // Run at 8 PM (20:00) local time
  if (currentHour === 20 && lastAuditRunDay !== currentDay) {
    lastAuditRunDay = currentDay;
    processAutoAudits();
  }
}, 30 * 60 * 1000); // check every 30 minutes

fastify.post('/api/cron/auto-audits', async (request, reply) => {
  await processAutoAudits();
  return { success: true, message: 'Auto-audit scan executed manually.' };
});

fastify.post('/api/cron/check-reminders', async (request, reply) => {
  await processComplianceReminders();
  return { success: true, message: 'Compliance reminder scan executed manually.' };
});

// ==========================================
// AUTOMATED 8:00 AM MORNING EXECUTIVE BRIEFING CRON
// ==========================================
let lastMorningBriefingDate = null;
async function checkMorningBriefingSchedule() {
  try {
    const now = new Date();
    // Kenya / East Africa Time is UTC+3
    const nairobiHour = (now.getUTCHours() + 3) % 24;
    const nairobiMinute = now.getUTCMinutes();
    const todayStr = now.toISOString().split('T')[0];

    if (nairobiHour === 8 && nairobiMinute <= 5 && lastMorningBriefingDate !== todayStr) {
      lastMorningBriefingDate = todayStr;
      fastify.log.info('ðŸŒ… Dispatching automated 8:00 AM executive morning briefing to superadmin...');
      await sendMorningExecutiveBriefing(supabase);
    }
  } catch (err) {
    fastify.log.error('Error running morning executive briefing schedule:', err);
  }
}
setInterval(checkMorningBriefingSchedule, 60000); // Check every minute

fastify.post('/api/cron/morning-briefing', async (request, reply) => {
  const result = await sendMorningExecutiveBriefing(supabase);
  return { success: true, message: 'Morning executive briefing sent.', briefing: result };
});

// Sentinel Autonomous Conversational Friction Optimization Loop
setInterval(async () => {
  try {
    await evaluateConversationalFriction(supabase);
  } catch (err) {
    console.warn('[Sentinel Friction Loop Warning]:', err.message);
  }
}, 5 * 60 * 1000); // Run friction evaluation every 5 minutes

// Sentinel Real-Time Conversation Recovery Loop â€” rescues users stalled mid-quiz.
setInterval(async () => {
  try {
    await monitorActiveConversations(supabase);
  } catch (err) {
    console.warn('[Sentinel Stall Monitor Warning]:', err.message);
  }
}, Number(process.env.SENTINEL_STALL_INTERVAL_MS || 5 * 60 * 1000));

// Sentinel Cloud Run Log Polling (Anomalies & Timeouts)
setInterval(async () => {
  try {
    await scanCloudRunAnomalies(supabase);
  } catch (err) {
    console.warn('[Sentinel Cloud Run Anomaly Loop Warning]:', err.message);
  }
}, 2 * 60 * 1000); // Run anomaly evaluation every 2 minutes

// ==========================================
// SENTINEL HORIZON â€” WEEKLY FEATURE EVOLUTION (Sundays 20:00 EAT)
// ==========================================
let lastHorizonDate = null;
async function checkHorizonSchedule() {
  try {
    const now = new Date();
    const nairobiHour = (now.getUTCHours() + 3) % 24;
    const nairobiMinute = now.getUTCMinutes();
    const todayStr = now.toISOString().split('T')[0];

    // Sunday === 0
    if (now.getUTCDay() === 0 && nairobiHour === 20 && nairobiMinute <= 5 && lastHorizonDate !== todayStr) {
      lastHorizonDate = todayStr;
      fastify.log.info('ðŸŒŸ Sentinel Horizon: synthesizing weekly feature evolution blueprint...');
      const { generateWeeklyFeaturePlan } = await import('./src/workers/sentinel.js');
      await generateWeeklyFeaturePlan(supabase);
    }
  } catch (err) {
    fastify.log.error('Error running Sentinel Horizon schedule:', err);
  }
}
setInterval(checkHorizonSchedule, 60000); // Check every minute

fastify.post('/api/cron/sentinel-horizon', async (request, reply) => {
  const { generateWeeklyFeaturePlan } = await import('./src/workers/sentinel.js');
  const result = await generateWeeklyFeaturePlan(supabase);
  return { success: true, horizon: result };
});

// ==========================================
// AUTONOMOUS REMEDIATION PIPELINE (v1.11.0)
// Continuous scan (60s) → tiered AI synthesis → threshold-triggered Cline plans
// → twice-daily adaptive digests → Superadmin approval → nonce-gated CI execution.
// Requires REMEDIATION_AUTONOMY=on|true|1 for plan dispatch/execution (kill switch, default off).
// ==========================================
let lastRemediationDigestKey = null;
let remediationScanInFlight = false;

async function runRemediationScanTick() {
  if (remediationScanInFlight) return;
  remediationScanInFlight = true;
  try {
    await runRemediationScan(supabase);
    await checkRemediationPlanTriggers(supabase);
    await maybeSendUrgentRemediationAlert(supabase);
  } catch (err) {
    console.warn('[Remediation Scan Warning]:', err.message);
  } finally {
    remediationScanInFlight = false;
  }
}

setInterval(runRemediationScanTick, Math.max(15000, REMEDIATION_SCAN_INTERVAL_MS));
setInterval(() => {
  refreshRemediationSynthesis(supabase).catch((err) => {
    console.warn('[Remediation Synthesis Warning]:', err.message);
  });
}, REMEDIATION_SYNTHESIS_INTERVAL_MS);
setInterval(() => {
  checkRemediationExecutionRetry(supabase).catch((err) => {
    console.warn('[Remediation Retry Warning]:', err.message);
  });
}, 30 * 60 * 1000);

// Dispatch verification watchdog (v1.16.0): a plan dispatched to GitHub that
// never produces a proposal means the CI leg is dead. Alert the Superadmin once
// per signature (this is what caught the silent workflow failure).
setInterval(() => {
  checkRemediationDispatchVerification(supabase).catch((err) => {
    console.warn('[Remediation Dispatch Verify Warning]:', err.message);
  });
}, 15 * 60 * 1000);

// AI budget guardrail (v1.14.0): alerts at AI_BUDGET_ALERT_PCT and 100%
// (deduped per Nairobi day). Notification-only — routing enforcement lives in
// aiClient's chain builder via installAiBudgetGuard().
setInterval(() => {
  maybeSendAiBudgetAlert(supabase).catch((err) => {
    console.warn('[AI Budget Alert Warning]:', err.message);
  });
}, 5 * 60 * 1000);

// Model Watchdog (v1.17.0): weekly discovery/benchmark cycle (self-gated by
// AI_MODEL_SCOUT_ENABLED) + a 30-minute health watchdog that auto-rolls-back a
// regressed canary. Both are deterministic and cost zero tokens unless a
// candidate is actually benchmarked.
setInterval(() => {
  runModelScoutCycle(supabase).catch((err) => {
    console.warn('[Model Scout Warning]:', err.message);
  });
}, AI_MODEL_SCOUT_INTERVAL_MS);

setInterval(() => {
  monitorModelHealth(supabase)
    .then((result) => {
      for (const rollback of result.rollbacks || []) {
        if (!rollback.rolledBack || !process.env.SUPERADMIN_PHONE) continue;
        sendMetaWhatsAppMessage(
          process.env.SUPERADMIN_PHONE,
          `🧠 *Model Watchdog auto-rollback*\n\n${rollback.tierSlot}: \`${rollback.from}\` → \`${rollback.to}\`\n` +
          `Reason: ${rollback.reason} (error rate ${(rollback.activeErrorRate * 100).toFixed(1)}% over ${result.windowHours}h)\n\n` +
          '_The previous model is active again — no action needed._'
        ).catch(() => {});
      }
    })
    .catch((err) => console.warn('[Model Health Warning]:', err.message));
}, 30 * 60 * 1000);

async function checkRemediationDigestSchedule() {
  try {
    const now = new Date();
    const nairobiHour = (now.getUTCHours() + 3) % 24;
    const nairobiMinute = now.getUTCMinutes();
    const todayStr = now.toISOString().split('T')[0];
    const slot = nairobiHour < 12 ? 'AM' : 'PM';
    const digestKey = `${todayStr}-${slot}`;

    if (REMEDIATION_DIGEST_HOURS.includes(nairobiHour) && nairobiMinute <= 5 && lastRemediationDigestKey !== digestKey) {
      lastRemediationDigestKey = digestKey;
      fastify.log.info('🩺 Dispatching remediation digest to superadmin...');
      await sendRemediationDigest(supabase);
    }
  } catch (err) {
    fastify.log.error('Error running remediation digest schedule:', err);
  }
}
setInterval(checkRemediationDigestSchedule, 60000);

fastify.post('/api/cron/remediation-audit', async (request, reply) => {
  const scan = await runRemediationScan(supabase);
  const synthesis = await refreshRemediationSynthesis(supabase, { force: true });
  return { success: true, remediation_scan: scan, synthesis };
});

fastify.post('/api/cron/remediation-plan', async (request, reply) => {
  const result = await checkRemediationPlanTriggers(supabase);
  return { success: true, remediation_plan: result };
});

fastify.post('/api/cron/remediation-digest', async (request, reply) => {
  const digest = await sendRemediationDigest(supabase, { force: true });
  const retried = await checkRemediationExecutionRetry(supabase);
  return { success: true, digest, retry: retried };
});


// ==========================================
// PAYSTACK WEBHOOK HANDLERS
// ==========================================

async function handlePaystackWebhook(request, reply) {
  try {
    const signature = request.headers['x-paystack-signature'];
    const rawBody = request.rawBody || JSON.stringify(request.body || {});

    if (!verifyPaystackSignature(rawBody, signature)) {
      fastify.log.warn('Paystack webhook signature verification failed.');
      return reply.status(400).send({ error: 'Invalid Paystack signature' });
    }

    const event = request.body || {};
    fastify.log.info(`Paystack Webhook Event Received: ${event.event}`);
    const data = event.data || {};
    const metadata = data.metadata || {};

    // Legacy one-time passbook transfer fee (handled here, not in the ledger).
    if (event.event === 'charge.success' && (metadata.type === 'passbook_transfer_fee' || metadata.transfer_id)) {
      await supabase.from('passbook_transfers').update({
        transfer_fee_paid: true,
        payment_reference: data.reference || null
      }).eq('id', metadata.transfer_id);

      if (metadata.phone_number) {
        const cleanPhone = metadata.phone_number.startsWith('+') ? metadata.phone_number : `+${metadata.phone_number}`;
        await sendMetaWhatsAppMessage(cleanPhone, `✅ *Transfer Fee Payment Confirmed!* 💳\n\nYour transfer payment has been received. Please reply **'ACCEPT'** to verify your email and receive your digital passbook!`);
      }
      return reply.status(200).send({ status: 'success', transfer_fee_handled: true });
    }

    // v1.15.0 state machine: subscription.create, invoice.*, subscription.disable,
    // subscription.not_renew, fleet_addon charges and legacy tier charges.
    const result = await handlePaystackEvent({
      supabase,
      event,
      sendWhatsAppFn: sendMetaWhatsAppMessage,
      log: fastify.log
    });

    return reply.status(200).send({ status: 'success', ...result });
  } catch (err) {
    fastify.log.error('Paystack webhook error:', err);
    return reply.status(500).send({ error: 'Internal Server Error handling Paystack webhook' });
  }
}

fastify.post('/webhook/paystack', handlePaystackWebhook);
fastify.post('/api/paystack/webhook', handlePaystackWebhook);

// ==========================================
// 8. Meta WhatsApp Webhook Integration
// ==========================================

async function handleWhatsAppWebhookVerification(request, reply) {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken) {
    fastify.log.info('Meta WhatsApp webhook verified successfully.');
    return reply.status(200).send(challenge);
  } else {
    return reply.status(403).send('Forbidden');
  }
}

fastify.get('/webhook', handleWhatsAppWebhookVerification);
fastify.get('/webhook/whatsapp', handleWhatsAppWebhookVerification);
fastify.get('/api/whatsapp/webhook', handleWhatsAppWebhookVerification);

async function handleWhatsAppWebhook(request, reply) {
  return handleWhatsAppWebhookRoute(request, reply, fastify);
}

fastify.post('/webhook', handleWhatsAppWebhook);
fastify.post('/webhook/whatsapp', handleWhatsAppWebhook);
fastify.post('/api/whatsapp/webhook', handleWhatsAppWebhook);

// [Refactored to src/routes/whatsapp.js]

























// 9. Saka Sentinel Worker Protected API Endpoint
fastify.post('/api/sentinel/run', async (request, reply) => {
  const sentinelSecret = process.env.SENTINEL_SECRET || 'saka_sentinel_secret_2026';
  const xSecret = request.headers['x-sentinel-secret'];
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = xSecret || bearerToken;

  if (!token || token !== sentinelSecret) {
    return reply.status(401).send({
      status: 'error',
      error: 'Unauthorized: Invalid or missing SENTINEL_SECRET'
    });
  }

  try {
    fastify.log.info('Running Saka Sentinel Worker (Health Check + Conversational Friction + Conversation Refinement)...');
    const healthCheckResult = await runHealthCheck(supabase);
    const frictionResult = await evaluateConversationalFriction(supabase);
    const refinementResult = await runConversationRefinement(supabase);
    const stallResult = await monitorActiveConversations(supabase);
    await scanCloudRunAnomalies(supabase);

    return reply.status(200).send({
      status: 'success',
      timestamp: new Date().toISOString(),
      actions: {
        health_check: healthCheckResult,
        conversational_friction: frictionResult,
        conversation_refinement: refinementResult,
        conversation_stall_recovery: stallResult
      }
    });
  } catch (err) {
    fastify.log.error('Sentinel execution failed:', err);
    await logSystemError(supabase, err, '/api/sentinel/run');
    return reply.status(500).send({
      status: 'error',
      message: 'Sentinel execution failed',
      error: err.message
    });
  }
});

// 10. Start the Fastify Server
let serverStarted = false;
const start = async () => {
  if (serverStarted) return;
  try {
    // Verify Supabase connection before starting
    const { error: pingErr } = await supabase.from('profiles').select('id').limit(1);
    if (pingErr) {
      console.error('âŒ Supabase connection test failed:', pingErr.message);
      process.exit(1);
    }
    console.log('âœ… Supabase connected successfully.');

    // Ensure Sentinel Worker & Superadmin Feature Set Tables exist
    await ensureSentinelTables(supabase);
    await ensureSuperadminTables(supabase);
    await ensureRemediationTables(supabase);
    await ensureAiUsageLogsTable(supabase);
    await ensureAiModelRegistryTables(supabase);
    await ensureSubscriptionSchema({ label: 'boot.ensureSubscriptionSchema' });
    installAiUsageSink(supabase);
    installAiBudgetGuard(supabase);
    await installModelRuntime(supabase);
    await ensureVehicleTableColumns(supabase);
    await ensureFuelEconomySchema(supabase);
    await ensureReceiptsTable(supabase);
    await ensureComplianceCatalog({ supabase });
    await ensureChatSessionsTable(supabase);

    logWebhookEnvParity();

    const port = process.env.PORT || 3000;
    await fastify.listen({ port: Number(port), host: '0.0.0.0' });
    serverStarted = true;
    console.log(`ðŸš€ Saka Fleet Meta-Native Backend is live and listening on port ${port}`);
    // Cloud Run Startup Self-Announcement
    const isProduction = process.env.NODE_ENV === 'production' || process.env.K_SERVICE;
    const currentRevision = process.env.K_REVISION || process.env.COMMIT_SHA || process.env.RENDER_GIT_COMMIT;
    if (isProduction && currentRevision && process.env.SUPERADMIN_PHONE) {
      const { data: config } = await supabase.from('system_config').select('value').eq('key', 'last_deployed_revision').maybeSingle();
      if (!config || config.value !== currentRevision) {
        await supabase.from('system_config').upsert([{ key: 'last_deployed_revision', value: currentRevision }]);
        const waMsg = `ðŸš€ *Saka Fleet Live on Cloud Run!* ðŸ› ï¸\n\nâ€¢ *Revision:* \`${currentRevision}\`\nâ€¢ *Status:* Healthy & Listening\nâ€¢ *Timestamp:* ${new Date().toLocaleString()}\n\n_Automated startup hook dispatched to Superadmin._`;
        await sendMetaWhatsAppMessage(process.env.SUPERADMIN_PHONE, waMsg).catch(() => {});
        console.log(`[Deployment Alert] Startup announcement sent to Superadmin for revision: ${currentRevision}`);
      }
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};


// Graceful shutdown: flush per-user queues so in-flight onboarding/quiz turns
// complete before Cloud Run terminates the instance.
const shutdown = async (signal) => {
  try {
    console.log(`[Shutdown] ${signal} received â€” draining message queue (${JSON.stringify(getQueueStats())})...`);
    const drained = await drainQueue(12000);
    if (!drained) console.warn('[Shutdown] Queue drain timed out; exiting.');
    await fastify.close();
  } catch (err) {
    console.error('[Shutdown] Error:', err.message);
  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();