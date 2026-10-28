import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

import { generateFleetReport, uploadReportToSupabase } from './reports.js';
import { sendReportByEmail, sendMfaEmail } from './src/services/mailer.js';
import { processSakaMessage } from './sakaAi.js';
import { runHealthCheck, runConversationRefinement, evaluateConversationalFriction, logSystemError, logChatTranscript, ensureSentinelTables, scanCloudRunAnomalies } from './src/workers/sentinel.js';
import { ensureSuperadminTables, isSuperadminPhone, sendMorningExecutiveBriefing } from './src/services/superadmin.js';
import { ensureVehicleTableColumns } from './src/services/vehicles.js';
import whatsappRoutes, { handleWhatsAppWebhook as handleWhatsAppWebhookRoute } from './src/routes/whatsapp.js';
import {
  SUBSCRIPTION_TIERS,
  getTierLocalPrice,
  initializePaystackCheckout,
  verifyPaystackSignature
} from './src/services/paystack.js';
import { processImpendingTrialReminders } from './src/services/coupons.js';

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


// 2. Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

// Helper: Evaluate Service Thresholds (75%, 25%, 5%, 0% Due, Overdue)
async function evaluateServiceThresholds(vehicle, currentVal, unitType) {
  if (!vehicle || !currentVal) return;
  try {
    const { data: activeReminders } = await supabase
      .from('reminders')
      .select('*, profiles!reminders_profile_id_fkey(phone_number)')
      .eq('vehicle_id', vehicle.id)
      .eq('status', 'active')
      .eq('threshold_unit', unitType);

    if (!activeReminders || activeReminders.length === 0) return;

    const numericCurrent = parseFloat(currentVal) || 0;
    const isImperial = (vehicle.unit_system || 'metric').toLowerCase() === 'imperial';

    let unitLabel = 'KM';
    if (unitType === 'distance') unitLabel = isImperial ? 'Miles' : 'KM';
    else if (unitType === 'hours') unitLabel = 'Hours';
    else if (unitType === 'kwh') unitLabel = 'kWh';
    else if (unitType === 'cycles') unitLabel = 'Cycles';

    for (const rem of activeReminders) {
      const target = parseFloat(rem.target_value);
      const lastServ = parseFloat(rem.last_service_value || 0);
      if (!target || target <= lastServ) continue;

      const interval = target - lastServ;
      const remaining = target - numericCurrent;
      const remainingRatio = remaining / interval;

      const ownerPhone = vehicle.profiles?.phone_number || rem.profiles?.phone_number;
      const driverPhone = vehicle.assigned_driver_profile?.phone_number;

      let alertText = null;
      let updateCol = null;

      if (remainingRatio <= 0.75 && remainingRatio > 0.25 && !rem.notified_75p) {
        alertText = `🛠️ *Service Reminder (${vehicle.plate_number})*\n${rem.reminder_type} is approaching. Current: ${numericCurrent} ${unitLabel}, Target: ${target} ${unitLabel} (${Math.round(remainingRatio * 100)}% remaining).`;
        updateCol = 'notified_75p';
      } else if (remainingRatio <= 0.25 && remainingRatio > 0.05 && !rem.notified_25p) {
        alertText = `⚠️ *Service Warning (${vehicle.plate_number})*\n${rem.reminder_type} due soon! Remaining: ${Math.round(remaining)} ${unitLabel}. Target: ${target} ${unitLabel}.`;
        updateCol = 'notified_25p';
      } else if (remainingRatio <= 0.05 && remainingRatio > 0 && !rem.notified_5p) {
        alertText = `🚨 *URGENT Service Alert (${vehicle.plate_number})*\n${rem.reminder_type} due imminently! Remaining: ${Math.round(remaining)} ${unitLabel}.`;
        updateCol = 'notified_5p';
      } else if (remainingRatio <= 0 && remainingRatio > -0.05 && !rem.notified_0p) {
        alertText = `‼️ *CRITICAL: Service Due Now (${vehicle.plate_number})*\n${rem.reminder_type} reached target ${target} ${unitLabel}! Perform service & reply "Renewed ${rem.reminder_type}".`;
        updateCol = 'notified_0p';
      } else if (remainingRatio <= -0.05 && !rem.notified_overdue) {
        alertText = `🚨 *OVERDUE Service Alert (${vehicle.plate_number})*\n${rem.reminder_type} is OVERDUE by ${Math.abs(Math.round(remaining))} ${unitLabel}! Target was ${target} ${unitLabel}, current is ${numericCurrent} ${unitLabel}.`;
        updateCol = 'notified_overdue';
      }

      if (alertText && updateCol) {
        if (ownerPhone && canDeliverVehicleAlert(ownerPhone, vehicle)) await sendMetaWhatsAppMessage(ownerPhone, alertText);
        if (driverPhone && driverPhone !== ownerPhone && canDeliverVehicleAlert(driverPhone, vehicle)) await sendMetaWhatsAppMessage(driverPhone, alertText);

        await supabase.from('reminders').update({ [updateCol]: true }).eq('id', rem.id);
      }
    }
  } catch (err) {
    console.error('Error evaluating service thresholds:', err);
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
        const msg = `🔔 *Driver Activity Summary (${plate})*\nDriver *${driverName}* submitted:\n👉 ${item.details_summary}`;
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
// Worker: Process Impending 3-Day Trial Reminders and 15-Day Overdue Winback Offers
setInterval(() => {
  processImpendingTrialReminders({ supabase, sendWhatsAppMessageFn: sendMetaWhatsAppMessage }).catch(err => {
    console.error('[Worker] Error processing impending trial reminders:', err);
  });
}, 15 * 60 * 1000); // Check every 15 minutes



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
          <p style="font-size: 12px; color: #94a3b8;">Cryptographically Verified by Saka AI • <a href="https://sakafleet.com" style="color: #38BDF8;">sakafleet.com</a></p>
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
// PROACTIVE COMPLIANCE REMINDER CRON ENGINE
// ==========================================

async function processComplianceReminders() {
  fastify.log.info('Running daily compliance reminder scan...');

  try {
    const now = new Date();

    const { data: reminders, error } = await supabase
      .from('reminders')
      .select(`
        id,
        reminder_type,
        due_date,
        notified_30d,
        notified_7d,
        notified_48h,
        notified_1d,
        vehicles (plate_number, make_model, assigned_driver_id),
        profiles (phone_number, full_name)
      `)
      .eq('status', 'active');

    if (error || !reminders) {
      fastify.log.error('Failed to fetch reminders for cron check:', error);
      return;
    }

    for (const rem of reminders) {
      const dueDate = new Date(rem.due_date);
      const diffTime = dueDate - now;
      const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      const phone = rem.profiles?.phone_number;
      const plate = rem.vehicles?.plate_number || 'Fleet Vehicle';
      const docType = rem.reminder_type;

      if (!phone) continue;

      let alertMessage = null;
      let updateField = null;

      if (daysLeft <= 30 && daysLeft > 7 && !rem.notified_30d) {
        alertMessage = `Heads up! The ${docType} for ${plate} expires in about 30 days (${dueDate.toDateString()}). Time to plan renewal!`;
        updateField = 'notified_30d';
      } else if (daysLeft <= 7 && daysLeft > 2 && !rem.notified_7d) {
        alertMessage = `Action required: ${docType} for ${plate} expires in ${daysLeft} days (${dueDate.toDateString()}). Reply "Renewed" once updated.`;
        updateField = 'notified_7d';
      } else if (daysLeft <= 2 && daysLeft > 1 && !rem.notified_48h) {
        alertMessage = `URGENT: ${docType} for ${plate} expires in 48 hours (${dueDate.toDateString()}). Please renew immediately!`;
        updateField = 'notified_48h';
      } else if (daysLeft <= 1 && daysLeft >= 0 && !rem.notified_1d) {
        alertMessage = `URGENT: ${docType} for ${plate} expires TOMORROW (${dueDate.toDateString()}). Please renew immediately!`;
        updateField = 'notified_1d';
      } else if (daysLeft < 0 && !rem.notified_1d) {
        alertMessage = `CRITICAL: ${docType} for ${plate} is OVERDUE (expired on ${dueDate.toDateString()}).`;
        updateField = 'notified_1d';
      }

        if (alertMessage && updateField) {
          // 1. Notify Owner
          if (phone && canDeliverVehicleAlert(phone, rem.vehicles)) {
            await sendMetaWhatsAppMessage(phone, alertMessage);
          }

          // 2. Notify Assigned Driver if present
          if (rem.vehicles?.assigned_driver_id) {
            const { data: drvProfile } = await supabase
              .from('profiles')
              .select('phone_number')
              .eq('id', rem.vehicles.assigned_driver_id)
              .maybeSingle();
            if (drvProfile?.phone_number && drvProfile.phone_number !== phone && canDeliverVehicleAlert(drvProfile.phone_number, rem.vehicles)) {
              await sendMetaWhatsAppMessage(drvProfile.phone_number, `[Driver Notice] ${alertMessage}`);
            }
          }

          await supabase
            .from('reminders')
            .update({ [updateField]: true })
            .eq('id', rem.id);

          fastify.log.info(`Compliance alert sent to ${phone} for reminder ID ${rem.id} (${daysLeft} days left)`);
        }
    }
  } catch (cronErr) {

    // B. Driver License Expirations Compliance Scan
    const { data: driversWithLicense } = await supabase
      .from('profiles')
      .select('id, phone_number, full_name, driver_license_number, driver_license_expiry, license_notified_30d, license_notified_7d, license_notified_48h, license_notified_1d')
      .not('driver_license_expiry', 'is', null)
      .eq('is_active', true);

    if (driversWithLicense) {
      for (const drv of driversWithLicense) {
        const expiryDate = new Date(drv.driver_license_expiry);
        const diffTime = expiryDate - now;
        const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const drvPhone = drv.phone_number;
        const drvName = drv.full_name || drvPhone;
        if (!drvPhone) continue;

        let alertMsg = null;
        let updateCol = null;

        if (daysLeft <= 30 && daysLeft > 7 && !drv.license_notified_30d) {
          alertMsg = `Driver License Notice: Your driver license expires in 30 days (${expiryDate.toDateString()}). Please plan renewal.`;
          updateCol = 'license_notified_30d';
        } else if (daysLeft <= 7 && daysLeft > 2 && !drv.license_notified_7d) {
          alertMsg = `Action Required: Your driver license expires in ${daysLeft} days (${expiryDate.toDateString()}).`;
          updateCol = 'license_notified_7d';
        } else if (daysLeft <= 2 && daysLeft > 1 && !drv.license_notified_48h) {
          alertMsg = `URGENT: Your driver license expires in 48 hours (${expiryDate.toDateString()}). Renew immediately!`;
          updateCol = 'license_notified_48h';
        } else if (daysLeft <= 1 && daysLeft >= 0 && !drv.license_notified_1d) {
          alertMsg = `URGENT: Your driver license expires TOMORROW (${expiryDate.toDateString()}).`;
          updateCol = 'license_notified_1d';
        } else if (daysLeft < 0 && !drv.license_notified_1d) {
          alertMsg = `CRITICAL: Your driver license is OVERDUE (expired ${expiryDate.toDateString()}).`;
          updateCol = 'license_notified_1d';
        }

        if (alertMsg && updateCol) {
          // 1. Notify Driver
          if (drvPhone && canDeliverVehicleAlert(drvPhone, null)) {
            await sendMetaWhatsAppMessage(drvPhone, alertMsg);
          }

          // 2. Notify Owners of vehicles assigned to this driver
          const { data: assignedVehicles } = await supabase
            .from('vehicles')
            .select('plate_number, owner_phone, profiles!vehicles_owner_id_fkey(phone_number)')
            .eq('assigned_driver_id', drv.id);

          if (assignedVehicles) {
            for (const av of assignedVehicles) {
              const ownerPhone = av.owner_phone || av.profiles?.phone_number;
              if (ownerPhone && ownerPhone !== drvPhone && canDeliverVehicleAlert(ownerPhone, av)) {
                const ownerAlert = `⚠️ *Driver License Expiry Alert (${av.plate_number})*\nAssigned driver *${drvName}*'s license expires in ${daysLeft} days (${expiryDate.toDateString()}).`;
                await sendMetaWhatsAppMessage(ownerPhone, ownerAlert);
              }
            }
          }

          await supabase
            .from('profiles')
            .update({ [updateCol]: true })
            .eq('id', drv.id);
        }
      }
    }

    fastify.log.error('Error running compliance reminder cron:', cronErr);
  }
}

// Run daily
setInterval(processComplianceReminders, 24 * 60 * 60 * 1000);

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
        const msg = `📊 Your Fleet Auto-Audit Report is ready.\n\nNet Earnings Today: KES ${(fleetTotalEarnings - fleetTotalExpenses).toFixed(2)}\nView PDF: ${reportUrl}`;
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
      fastify.log.info('🌅 Dispatching automated 8:00 AM executive morning briefing to superadmin...');
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
}, 10 * 60 * 1000); // Run friction evaluation every 10 minutes

// Sentinel Cloud Run Log Polling (Anomalies & Timeouts)
setInterval(async () => {
  try {
    await scanCloudRunAnomalies(supabase);
  } catch (err) {
    console.warn('[Sentinel Cloud Run Anomaly Loop Warning]:', err.message);
  }
}, 2 * 60 * 1000); // Run anomaly evaluation every 2 minutes

// ==========================================
// SENTINEL HORIZON — WEEKLY FEATURE EVOLUTION (Sundays 20:00 EAT)
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
      fastify.log.info('🌟 Sentinel Horizon: synthesizing weekly feature evolution blueprint...');
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

    if (event.event === 'charge.success') {
      const data = event.data || {};
      const metadata = data.metadata || {};
      if (metadata.type === 'passbook_transfer_fee' || metadata.transfer_id) {
        const transferId = metadata.transfer_id;
        await supabase.from('passbook_transfers').update({
          transfer_fee_paid: true,
          payment_reference: data.reference || null
        }).eq('id', transferId);

        if (phone) {
          const cleanPhone = phone.startsWith('+') ? phone : `+${phone}`;
          await sendMetaWhatsAppMessage(cleanPhone, `✅ *Transfer Fee Payment Confirmed!* 💳\n\nYour transfer payment has been received. Please reply **'ACCEPT'** to verify your email and receive your digital passbook!`);
        }
        return reply.status(200).send({ status: 'success', transfer_fee_handled: true });
      }

      const phone = metadata.phone_number;
      const targetTier = metadata.target_tier || 'solo_pro';
      const billingInterval = metadata.billing_interval || 'monthly';
      const userId = metadata.user_id;

      const now = new Date();
      let expiresAt = new Date(now);
      if (billingInterval === 'annual') {
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      } else {
        expiresAt.setDate(expiresAt.getDate() + 30);
      }

      let query = supabase.from('profiles').update({
        subscription_tier: targetTier,
        subscription_status: 'active',
        billing_interval: billingInterval,
        subscription_expires_at: expiresAt.toISOString(),
        paystack_customer_code: data.customer?.customer_code || null,
        paystack_subscription_code: data.subscription_code || data.reference || null,
        updated_at: now.toISOString()
      });

      if (userId) {
        query = query.eq('id', userId);
      } else if (phone) {
        const cleanPhone = phone.startsWith('+') ? phone : `+${phone}`;
        query = query.eq('phone_number', cleanPhone);
      }

      const { data: updatedProfile, error: updateErr } = await query.select().single();

      if (updateErr) {
        fastify.log.error('Failed to update subscription profile on Paystack charge.success:', updateErr);
      } else {
        const tierInfo = SUBSCRIPTION_TIERS[targetTier] || SUBSCRIPTION_TIERS.solo_pro;
        const targetPhone = phone || updatedProfile?.phone_number;
        if (targetPhone) {
          const successMsg = `🎉 *Subscription Upgrade Successful!*\n\nYour account has been upgraded to *${tierInfo.name}* (${billingInterval}).\n• Vehicle Limit: ${tierInfo.vehicleLimit === Infinity ? 'Unlimited' : tierInfo.vehicleLimit}\n• Premium Features: Unlocked 🚀\n\nThank you for choosing Saka!`;
          await sendMetaWhatsAppMessage(targetPhone, successMsg);
        }
      }
    }

    return reply.status(200).send({ status: 'success' });
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
    await scanCloudRunAnomalies(supabase);

    return reply.status(200).send({
      status: 'success',
      timestamp: new Date().toISOString(),
      actions: {
        health_check: healthCheckResult,
        conversational_friction: frictionResult,
        conversation_refinement: refinementResult
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
      console.error('❌ Supabase connection test failed:', pingErr.message);
      process.exit(1);
    }
    console.log('✅ Supabase connected successfully.');

    // Ensure Sentinel Worker & Superadmin Feature Set Tables exist
    await ensureSentinelTables(supabase);
    await ensureSuperadminTables(supabase);
    await ensureVehicleTableColumns(supabase);

    const port = process.env.PORT || 3000;
    await fastify.listen({ port: Number(port), host: '0.0.0.0' });
    serverStarted = true;
    console.log(`🚀 Saka Fleet Meta-Native Backend is live and listening on port ${port}`);
    // Cloud Run Startup Self-Announcement
    const isProduction = process.env.NODE_ENV === 'production' || process.env.K_SERVICE;
    const currentRevision = process.env.K_REVISION || process.env.COMMIT_SHA || process.env.RENDER_GIT_COMMIT;
    if (isProduction && currentRevision && process.env.SUPERADMIN_PHONE) {
      const { data: config } = await supabase.from('system_config').select('value').eq('key', 'last_deployed_revision').maybeSingle();
      if (!config || config.value !== currentRevision) {
        await supabase.from('system_config').upsert([{ key: 'last_deployed_revision', value: currentRevision }]);
        const waMsg = `🚀 *Saka Fleet Live on Cloud Run!* 🛠️\n\n• *Revision:* \`${currentRevision}\`\n• *Status:* Healthy & Listening\n• *Timestamp:* ${new Date().toLocaleString()}\n\n_Automated startup hook dispatched to Superadmin._`;
        await sendMetaWhatsAppMessage(process.env.SUPERADMIN_PHONE, waMsg).catch(() => {});
        console.log(`[Deployment Alert] Startup announcement sent to Superadmin for revision: ${currentRevision}`);
      }
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();