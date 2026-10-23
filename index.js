import 'dotenv/config';
import Fastify from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

import { generateFleetReport, uploadReportToSupabase } from './reports.js';
import { sendReportByEmail, sendMfaEmail } from './src/services/mailer.js';
import { processSakaMessage } from './sakaAi.js';
import { runHealthCheck, runConversationRefinement, logSystemError, logChatTranscript, ensureSentinelTables } from './src/workers/sentinel.js';
import { ensureSuperadminTables, handleSuperadminFlow } from './src/services/superadmin.js';
import {
  SUBSCRIPTION_TIERS,
  getTierLocalPrice,
  initializePaystackCheckout,
  verifyPaystackSignature
} from './src/services/paystack.js';

// 1. Initialize Fastify Server
const fastify = Fastify({ logger: true });

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

// Helper: E.164 Phone Country & Regional Format Parser
function detectCountryFromPhone(phone) {
  if (!phone) return { country: 'International', country_code: 'GLOBAL', plate_example: 'ABC 1234', default_units: 'metric', currency: 'USD' };
  const clean = phone.replace(/[^\d+]/g, '');
  const full = clean.startsWith('+') ? clean : `+${clean}`;

  if (full.startsWith('+254')) return { country: 'Kenya', country_code: 'KE', plate_example: 'KDA 123A', default_units: 'metric', currency: 'KES' };
  if (full.startsWith('+1')) return { country: 'United States', country_code: 'US', plate_example: '7ABC123', default_units: 'imperial', currency: 'USD' };
  if (full.startsWith('+44')) return { country: 'United Kingdom', country_code: 'GB', plate_example: 'AB12 CDE', default_units: 'imperial', currency: 'GBP' };
  if (full.startsWith('+27')) return { country: 'South Africa', country_code: 'ZA', plate_example: 'CA 123-456', default_units: 'metric', currency: 'ZAR' };
  if (full.startsWith('+234')) return { country: 'Nigeria', country_code: 'NG', plate_example: 'ABC-123XY', default_units: 'metric', currency: 'NGN' };
  if (full.startsWith('+255')) return { country: 'Tanzania', country_code: 'TZ', plate_example: 'T123 ABC', default_units: 'metric', currency: 'TZS' };
  if (full.startsWith('+256')) return { country: 'Uganda', country_code: 'UG', plate_example: 'UBD 123A', default_units: 'metric', currency: 'UGX' };
  if (full.startsWith('+250')) return { country: 'Rwanda', country_code: 'RW', plate_example: 'RAA 123A', default_units: 'metric', currency: 'RWF' };
  if (full.startsWith('+61')) return { country: 'Australia', country_code: 'AU', plate_example: '1ABC23', default_units: 'metric', currency: 'AUD' };
  if (full.startsWith('+49')) return { country: 'Germany', country_code: 'DE', plate_example: 'B-MW 1234', default_units: 'metric', currency: 'EUR' };
  if (full.startsWith('+33')) return { country: 'France', country_code: 'FR', plate_example: 'AB-123-CD', default_units: 'metric', currency: 'EUR' };
  if (full.startsWith('+91')) return { country: 'India', country_code: 'IN', plate_example: 'MH 12 AB 1234', default_units: 'metric', currency: 'INR' };
  if (full.startsWith('+971')) return { country: 'United Arab Emirates', country_code: 'AE', plate_example: 'A 12345', default_units: 'metric', currency: 'AED' };

  return { country: 'International', country_code: 'GLOBAL', plate_example: 'ABC 1234', default_units: 'metric', currency: 'USD' };
}

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
        if (ownerPhone) await sendMetaWhatsAppMessage(ownerPhone, alertText);
        if (driverPhone && driverPhone !== ownerPhone) await sendMetaWhatsAppMessage(driverPhone, alertText);

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

      if (ownerPhone) {
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
          await sendMetaWhatsAppMessage(phone, alertMessage);

          // 2. Notify Assigned Driver if present
          if (rem.vehicles?.assigned_driver_id) {
            const { data: drvProfile } = await supabase
              .from('profiles')
              .select('phone_number')
              .eq('id', rem.vehicles.assigned_driver_id)
              .maybeSingle();
            if (drvProfile?.phone_number && drvProfile.phone_number !== phone) {
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
          await sendMetaWhatsAppMessage(drvPhone, alertMsg);

          // 2. Notify Owners of vehicles assigned to this driver
          const { data: assignedVehicles } = await supabase
            .from('vehicles')
            .select('plate_number, profiles!vehicles_owner_id_fkey(phone_number)')
            .eq('assigned_driver_id', drv.id);

          if (assignedVehicles) {
            for (const av of assignedVehicles) {
              const ownerPhone = av.profiles?.phone_number;
              if (ownerPhone && ownerPhone !== drvPhone) {
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
  try {
    const body = request.body || {};

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messageObj = value?.messages?.[0];

      if (!messageObj) {
        return reply.status(200).send({ status: 'ignored_non_message_event' });
      }

      const senderPhone = messageObj.from; // e.g. "254712345678"
      let messageText = messageObj.text?.body || '';
      let mediaParts = [];

      // Download Image Media for Vision Receipt Parsing
      if (messageObj.type === 'image' && messageObj.image) {
        const mediaId = messageObj.image.id;
        try {
          // 1. Get Media URL
          const mediaUrlRes = await fetch(`https://graph.facebook.com/v17.0/${mediaId}`, {
             headers: { 'Authorization': `Bearer ${process.env.META_WHATSAPP_TOKEN}` }
          });
          const mediaUrlData = await mediaUrlRes.json();
          if (mediaUrlData.url) {
             // 2. Download Binary Data
             const mediaRes = await fetch(mediaUrlData.url, {
                headers: { 'Authorization': `Bearer ${process.env.META_WHATSAPP_TOKEN}` }
             });
             const arrayBuffer = await mediaRes.arrayBuffer();
             const buffer = Buffer.from(arrayBuffer);
             
             mediaParts.push({
               inlineData: {
                 data: buffer.toString("base64"),
                 mimeType: messageObj.image.mime_type || "image/jpeg"
               }
             });
             if (!messageText) messageText = "Here is a receipt image for expense parsing.";
          }
        } catch (err) {
          fastify.log.error('Failed to download WhatsApp media:', err);
        }
      }

      fastify.log.info(`Incoming Meta WhatsApp message from ${senderPhone}: "${messageText}"`);
      logChatTranscript(supabase, senderPhone, 'user', messageText);

      // Superadmin Intercept Middleware
      const superadminRes = await handleSuperadminFlow(supabase, senderPhone, messageText);
      if (superadminRes.isSuperadmin) {
        if (superadminRes.reply) {
          await sendMetaWhatsAppMessage(senderPhone, superadminRes.reply);
          logChatTranscript(supabase, senderPhone, 'assistant', superadminRes.reply);
        }
        return reply.status(200).send({ status: 'superadmin_handled' });
      }

      let session = chatSessions.get(senderPhone) || { history: [], lastActive: Date.now() };
      session.lastActive = Date.now();

      const formattedPhone = senderPhone.startsWith('+') ? senderPhone : `+${senderPhone}`;
      const countryInfo = detectCountryFromPhone(formattedPhone);

      let { data: profileData } = await supabase
        .from('profiles')
        .select('*')
        .eq('phone_number', formattedPhone)
        .maybeSingle();

      // Auto-create or lock profile country
      if (!profileData) {
        const { data: newProfile, error: profileErr } = await supabase
          .from('profiles')
          .insert([{ 
            phone_number: formattedPhone, 
            full_name: 'WhatsApp User',
            country: countryInfo.country,
            country_code: countryInfo.country_code,
            unit_system: countryInfo.default_units,
            preferred_language: 'English',
            is_active: true
          }])
          .select()
          .maybeSingle();
          
        if (profileErr) {
          fastify.log.error('Failed to auto-create profile:', profileErr);
        } else {
          profileData = newProfile;
          fastify.log.info(`Auto-created profile for ${formattedPhone} locked to ${countryInfo.country}`);
        }
      } else if (!profileData.country || !profileData.country_code) {
        await supabase
          .from('profiles')
          .update({
            country: profileData.country || countryInfo.country,
            country_code: profileData.country_code || countryInfo.country_code,
            unit_system: profileData.unit_system || countryInfo.default_units
          })
          .eq('id', profileData.id);
        profileData.country = profileData.country || countryInfo.country;
        profileData.country_code = profileData.country_code || countryInfo.country_code;
      }

      let { data: existingVehicles } = await supabase
        .from('vehicles')
        .select('*')
        .is('deleted_at', null)
        .or(`owner_id.eq.${profileData?.id || '00000000-0000-0000-0000-000000000000'},assigned_driver_id.eq.${profileData?.id || '00000000-0000-0000-0000-000000000000'}`);

      const hasVehicleRegistered = existingVehicles && existingVehicles.length > 0;
      const targetLang = profileData?.preferred_language || 'English';

      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
      const globalEmailMatch = messageText.match(emailRegex);

      let aiResult;
      if (globalEmailMatch && session.pendingReport) {
        aiResult = {
          intent: 'REQUEST_REPORT',
          extracted_data: {
            target_email: globalEmailMatch[0].toLowerCase(),
            plate_number: session.pendingReport.plateNumber,
            report_type: session.pendingReport.reportType
          },
          reply_message: ''
        };
      } else {
        aiResult = await processSakaMessage(targetLang, messageText, session.history, mediaParts);
      }

      // Soft-Deactivation Account Lock Check
      if (profileData && (profileData.is_active === false || profileData.deleted_at) && aiResult.intent !== 'REACTIVATE_ACCOUNT') {
        const reactivateMsg = `Your Saka account is currently deactivated. To restore your profile and access your vehicles, reply "REACTIVATE".`;
        await sendMetaWhatsAppMessage(senderPhone, reactivateMsg);
        return reply.status(200).send({ status: 'account_deactivated' });
      }
      
      fastify.log.info(`Saka AI Intent Classified: ${aiResult.intent}`, aiResult.extracted_data);

      const universalPlateRegex = /\b[A-Z0-9-]{3,10}\b/i;
      const plateMatch = messageText.match(universalPlateRegex);
      if (plateMatch && !aiResult.extracted_data.plate_number) {
        if (existingVehicles?.some(v => v.plate_number.toUpperCase() === plateMatch[0].toUpperCase())) {
          aiResult.extracted_data.plate_number = plateMatch[0].toUpperCase();
        }
      }

      let activeVehicle = null;
      const reqPlate = aiResult.extracted_data.plate_number;
      if (reqPlate) {
        activeVehicle = existingVehicles?.find(v => v.plate_number.toUpperCase() === reqPlate.toUpperCase()) || null;
      }
      if (!activeVehicle && hasVehicleRegistered && existingVehicles.length === 1) {
        activeVehicle = existingVehicles[0];
      }

      let customReply = aiResult.reply_message;

      // Quick-Action Handling for "Renewed" / Service Completion
      if (messageText.toLowerCase().trim() === 'renewed' || aiResult.intent === 'COMPLETE_REMINDER') {
        try {
          if (activeVehicle) {
            const { data: activeReminders } = await supabase
              .from('reminders')
              .select('*')
              .eq('vehicle_id', activeVehicle.id)
              .eq('status', 'active');

            if (activeReminders && activeReminders.length > 0) {
              for (const rem of activeReminders) {
                await supabase.from('reminders').update({ status: 'completed' }).eq('id', rem.id);

                let newTarget = null;
                let newLastServ = null;
                let newDueDate = null;

                if (rem.threshold_unit === 'distance') {
                  const currentOdo = parseFloat(activeVehicle.odometer_reading || 0);
                  const interval = parseFloat(rem.interval_value || 10000);
                  newLastServ = currentOdo;
                  newTarget = currentOdo + interval;
                } else if (rem.threshold_unit === 'hours') {
                  const currentHours = parseFloat(activeVehicle.operating_hours || 0);
                  const interval = parseFloat(rem.interval_value || 250);
                  newLastServ = currentHours;
                  newTarget = currentHours + interval;
                } else {
                  const months = rem.interval_months || 12;
                  const d = new Date();
                  d.setMonth(d.getMonth() + months);
                  newDueDate = d.toISOString();
                }

                await supabase.from('reminders').insert([{
                  vehicle_id: activeVehicle.id,
                  profile_id: profileData?.id || null,
                  reminder_type: rem.reminder_type,
                  due_date: newDueDate || rem.due_date,
                  threshold_unit: rem.threshold_unit || 'date',
                  target_value: newTarget,
                  last_service_value: newLastServ,
                  interval_value: rem.interval_value,
                  interval_months: rem.interval_months,
                  status: 'active'
                }]);
              }
              customReply = `Awesome! Marked active compliance reminders as completed for ${activeVehicle.plate_number} and scheduled the next recurring service cycle.`;
            } else {
              customReply = `No active compliance reminders pending for ${activeVehicle.plate_number}.`;
            }
          } else {
            await supabase.from('reminders').update({ status: 'completed' }).eq('status', 'active');
            customReply = `Awesome! Marked active compliance reminders as completed. Good to go!`;
          }
        } catch (renErr) {
          fastify.log.error('Renewal update error:', renErr);
        }
      }

      // 1. REGISTER_VEHICLE & Multi-Turn Progressive Onboarding Flow
      else if (
        aiResult.intent === 'REGISTER_VEHICLE' || 
        onboardingStore.has(senderPhone) || 
        (!hasVehicleRegistered && ['LOG_EXPENSE', 'UPDATE_MILEAGE', 'LOG_EARNINGS', 'SET_REMINDER', 'MANAGE_VEHICLE'].includes(aiResult.intent))
      ) {
        const userTierKey = profileData?.subscription_tier || 'free';
        const currentTier = SUBSCRIPTION_TIERS[userTierKey] || SUBSCRIPTION_TIERS.free;
        const currentVehicleCount = existingVehicles ? existingVehicles.length : 0;
        const isNewRegistrationStart = !onboardingStore.has(senderPhone);

        if (isNewRegistrationStart && currentVehicleCount >= currentTier.vehicleLimit) {
          let nextTierKey = 'solo_pro';
          if (userTierKey === 'solo_pro') nextTierKey = 'growth';
          else if (userTierKey === 'growth') nextTierKey = 'scale';
          else if (userTierKey === 'scale') nextTierKey = 'unlimited';
          else if (userTierKey === 'unlimited') nextTierKey = 'unlimited';

          const checkout = await initializePaystackCheckout({
            supabase,
            userPhone: senderPhone,
            targetTierKey: nextTierKey,
            billingInterval: 'monthly',
            userEmail: profileData?.email,
            userId: profileData?.id,
            currency: countryInfo.currency
          });

          const targetTierObj = SUBSCRIPTION_TIERS[nextTierKey];
          customReply = `⚠️ *Vehicle Capacity Limit Reached*\n\nYour current plan (*${currentTier.name}*) allows a maximum of ${currentTier.vehicleLimit} vehicle(s).\n\nTo add more vehicles, please upgrade to the *${targetTierObj.name}* plan (${checkout.priceInfo.formattedPrice}/month).\n\n👉 *Upgrade Link:* ${checkout.checkoutUrl}`;
          onboardingStore.delete(senderPhone);
        } else {
          let obState = onboardingStore.get(senderPhone) || {
            step: 1,
            language: profileData?.preferred_language || 'English',
            unit_system: profileData?.unit_system || countryInfo.default_units,
            country: profileData?.country || countryInfo.country,
            country_code: profileData?.country_code || countryInfo.country_code,
            plate_number: null,
            make_model: null,
            year: null,
            other_details: null,
            asset_type: 'ICE',
            odometer_reading: '0',
            operating_hours: '0'
          };

        const ext = aiResult.extracted_data || {};
        if (ext.preferred_language) obState.language = ext.preferred_language;
        if (ext.unit_system) obState.unit_system = ext.unit_system.toLowerCase();
        if (ext.country) obState.country = ext.country;
        if (ext.plate_number) obState.plate_number = ext.plate_number.toUpperCase();
        if (ext.make_model) obState.make_model = ext.make_model;
        if (ext.year) obState.year = parseInt(ext.year);
        if (ext.other_details) obState.other_details = ext.other_details;

        // Step 1: Language & Measurement Units
        if (obState.step === 1) {
          if (messageText && !ext.plate_number) {
            if (/swahili/i.test(messageText)) obState.language = 'Swahili';
            else if (/french|français/i.test(messageText)) obState.language = 'French';
            else if (/spanish|español/i.test(messageText)) obState.language = 'Spanish';
            else if (/german|deutsch/i.test(messageText)) obState.language = 'German';

            if (/imperial|miles|gallons/i.test(messageText)) obState.unit_system = 'imperial';
            else if (/metric|km|liters/i.test(messageText)) obState.unit_system = 'metric';
          }

          await supabase.from('profiles').update({
            preferred_language: obState.language,
            unit_system: obState.unit_system
          }).eq('id', profileData.id);

          obState.step = 2;
          onboardingStore.set(senderPhone, obState);

          customReply = `*Step 2 of 6:* Country Confirmation 🌍\nBased on your phone number (+${senderPhone.slice(0,4)}...), I detected your country as *${obState.country}*. Reply 'Yes' to confirm, or type your country name if different.`;
        }

        // Step 2: Country Confirmation
        else if (obState.step === 2) {
          if (messageText) {
            if (/yes|yep|yeah|confirm|ok|sure|correct/i.test(messageText.trim())) {
              // confirmed
            } else if (messageText.trim().length > 2) {
              obState.country = messageText.trim();
            }
          }

          await supabase.from('profiles').update({ country: obState.country }).eq('id', profileData.id);

          obState.step = 3;
          onboardingStore.set(senderPhone, obState);

          const localExample = countryInfo.plate_example || 'ABC 1234';
          customReply = `*Step 3 of 6:* Vehicle Registration Plate 🚘\nWhat is your vehicle's plate number or registration code? (e.g., *${localExample}*)`;
        }

        // Step 3: Plate Number
        else if (obState.step === 3) {
          const plateCandidate = obState.plate_number || ext.plate_number || (messageText.trim().length >= 2 ? messageText.trim().toUpperCase() : null);
          if (!plateCandidate) {
            customReply = `Please provide a valid plate number (e.g., *${countryInfo.plate_example}*).`;
          } else {
            obState.plate_number = plateCandidate.toUpperCase();
            obState.step = 4;
            onboardingStore.set(senderPhone, obState);

            customReply = `*Step 4 of 6:* Make & Model 🚗\nWhat is the make and model of your vehicle? (e.g., 'Toyota Fielder', 'Ford Transit', or 'Tesla Model 3')`;
          }
        }

        // Step 4: Make & Model
        else if (obState.step === 4) {
          const modelCandidate = obState.make_model || ext.make_model || (messageText.trim().length >= 2 ? messageText.trim() : null);
          if (!modelCandidate) {
            customReply = `Please specify the make and model of your vehicle (e.g., Toyota Fielder).`;
          } else {
            obState.make_model = modelCandidate;
            obState.step = 5;
            onboardingStore.set(senderPhone, obState);

            customReply = `*Step 5 of 6:* Year of Manufacture 📅 (Mandatory)\nWhat year was your vehicle manufactured? (e.g., 2018)`;
          }
        }

        // Step 5: Year of Manufacture (Mandatory)
        else if (obState.step === 5) {
          const matchYear = obState.year || ext.year || messageText.match(/\b(19\d\d|20[0-2]\d)\b/)?.[0];
          const parsedYear = matchYear ? parseInt(matchYear) : null;

          if (!parsedYear || parsedYear < 1900 || parsedYear > new Date().getFullYear() + 1) {
            customReply = `⚠️ Year of manufacture is mandatory. Please reply with a valid 4-digit year (e.g., 2018).`;
          } else {
            obState.year = parsedYear;
            obState.step = 6;
            onboardingStore.set(senderPhone, obState);

            customReply = `*Step 6 of 6:* Additional Details 📝 (Optional)\nAny extra details or custom notes? (e.g., 'Silver, Odometer 45,000 km, EV') or reply *'Skip'* to finish.`;
          }
        }

        // Step 6: Other Details / Custom Notes (Optional) -> Finalize Registration
        else if (obState.step === 6) {
          if (messageText && !/skip|none|no|done/i.test(messageText.trim())) {
            obState.other_details = ext.other_details || messageText.trim();
          }

          try {
            const token = `SK-PASSBOOK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
            const { data: newVeh, error } = await supabase.from('vehicles').insert([{
              owner_id: profileData.id,
              plate_number: obState.plate_number.toUpperCase(),
              make_model: obState.make_model,
              year_of_manufacture: obState.year,
              other_details: obState.other_details || null,
              asset_type: obState.asset_type || 'ICE',
              unit_system: obState.unit_system || 'metric',
              odometer_reading: parseFloat(obState.odometer_reading) || 0,
              operating_hours: parseFloat(obState.operating_hours) || 0,
              qr_passbook_token: token
            }]).select().single();

            onboardingStore.delete(senderPhone);

            if (error) {
              fastify.log.error('Vehicle registration DB error:', error);
              customReply = `Oops, something went wrong while registering your vehicle. Please try again.`;
            } else {
              customReply = `🎉 *Vehicle Registered Successfully!*\n\n🚘 *${newVeh.plate_number}* (${newVeh.year_of_manufacture} ${newVeh.make_model})\n• Units: ${newVeh.unit_system.toUpperCase()}\n• Country: ${obState.country}\n• Passbook Token: \`${token}\`\n\nYou can now log expenses, update odometer/operating hours, track earnings, or set service reminders!`;
            }
          } catch (regErr) {
            fastify.log.error('Vehicle registration exception:', regErr);
            customReply = `Failed to complete registration. Please try again.`;
          }
        }
        }
      }

      // 2. LOG_EXPENSE
      else if (aiResult.intent === 'LOG_EXPENSE') {
        const userTierKey = profileData?.subscription_tier || 'free';
        const currentTier = SUBSCRIPTION_TIERS[userTierKey] || SUBSCRIPTION_TIERS.free;

        if (mediaParts && mediaParts.length > 0 && !currentTier.hasPremiumFeatures) {
          const checkout = await initializePaystackCheckout({
            supabase,
            userPhone: senderPhone,
            targetTierKey: 'solo_pro',
            billingInterval: 'monthly',
            userEmail: profileData?.email,
            userId: profileData?.id,
            currency: countryInfo.currency
          });

          customReply = `🔒 *Premium Feature: AI Receipt Scanning*\n\nAutomatic fuel receipt photo parsing is a premium feature.\n\nUpgrade to *Solo Pro* (${checkout.priceInfo.formattedPrice}/month) to automatically extract fuel liters, total expenditure, and date from receipt photos!\n\n👉 *Upgrade Link:* ${checkout.checkoutUrl}`;
        } else if (!activeVehicle && existingVehicles?.length > 1) {
          const listStr = existingVehicles.map((v, i) => `${i + 1}️⃣ *${v.plate_number}* (${v.make_model})`).join('\n');
          customReply = `You have multiple registered vehicles. Please specify which vehicle to log this expense for:\n\n${listStr}`;
        } else if (!activeVehicle && existingVehicles?.length === 0) {
          customReply = `No registered vehicles found. Reply with 'register vehicle' to add your vehicle.`;
        } else {
          const ext = aiResult.extracted_data;
          const targetPlate = activeVehicle?.plate_number || ext.plate_number || 'Vehicle';
          const amount = ext.amount || '0';

          try {
            const payload = {
              vehicle_id: activeVehicle?.id || null,
              driver_id: profileData?.id || null,
              expense_type: ext.expense_type || 'Fuel Purchase',
              amount: parseFloat(amount),
              fuel_liters: ext.fuel_liters ? parseFloat(ext.fuel_liters) : null,
              kwh_charged: ext.kwh_charged ? parseFloat(ext.kwh_charged) : null,
              operating_hours: ext.operating_hours ? parseFloat(ext.operating_hours) : null,
              is_full_tank: ext.is_full_tank || false,
              notes: ext.message_body || 'Logged via WhatsApp'
            };
            if (ext.date) {
               payload.created_at = `${ext.date}T12:00:00Z`;
            }
            await supabase.from('expense_logs').insert([payload]);
            const currencyStr = countryInfo.currency || 'KES';
            customReply = `Logged expense of ${currencyStr} ${amount} for vehicle *${targetPlate}*.`;

            if (activeVehicle) {
              if (ext.operating_hours) {
                await supabase.from('vehicles').update({ operating_hours: parseFloat(ext.operating_hours) }).eq('id', activeVehicle.id);
                await evaluateServiceThresholds(activeVehicle, ext.operating_hours, 'hours');
              }
              if (ext.odometer_reading) {
                await supabase.from('vehicles').update({ odometer_reading: parseFloat(ext.odometer_reading) }).eq('id', activeVehicle.id);
                await evaluateServiceThresholds(activeVehicle, ext.odometer_reading, 'distance');
              } else if (activeVehicle.odometer_reading) {
                await evaluateServiceThresholds(activeVehicle, activeVehicle.odometer_reading, 'distance');
              }

              if (activeVehicle.owner_id !== profileData?.id) {
                await queueOwnerNotification(activeVehicle.owner_id, activeVehicle.id, profileData.id, 'LOG_EXPENSE', `Expense Logged: ${ext.expense_type || 'Fuel Purchase'} - ${currencyStr} ${amount}`);
              }
            }
          } catch (expErr) {
            fastify.log.error('Expense logging error:', expErr);
            customReply = "Sorry, I ran into an issue logging that expense.";
          }
        }
      }

      // 3. UPDATE_MILEAGE
      else if (aiResult.intent === 'UPDATE_MILEAGE') {
        if (!activeVehicle && existingVehicles?.length > 1) {
          const listStr = existingVehicles.map((v, i) => `${i + 1}️⃣ *${v.plate_number}* (${v.make_model})`).join('\n');
          customReply = `You have multiple registered vehicles. Please specify which vehicle to update metrics for:\n\n${listStr}`;
        } else if (!activeVehicle && existingVehicles?.length === 0) {
          customReply = `No registered vehicles found. Reply with 'register vehicle' to add your vehicle.`;
        } else {
          const ext = aiResult.extracted_data;
          const odoMatch = messageText.match(/[\d,]+\s?(km|miles)/i);
          const newOdo = parseFloat(ext.odometer_reading || (odoMatch ? odoMatch[0] : messageText)) || 0;
          const newHours = ext.operating_hours ? parseFloat(ext.operating_hours) : null;
          const newChargeCycles = ext.charge_cycles ? parseFloat(ext.charge_cycles) : null;

          try {
            const updatePayload = {};
            if (newOdo > 0) updatePayload.odometer_reading = newOdo;
            if (newHours !== null) updatePayload.operating_hours = newHours;
            if (newChargeCycles !== null) updatePayload.charge_cycles = newChargeCycles;

            await supabase.from('vehicles').update(updatePayload).eq('id', activeVehicle.id);
            const unitLabel = (activeVehicle.unit_system || 'metric') === 'imperial' ? 'Miles' : 'KM';
            customReply = `Updated metrics for *${activeVehicle.plate_number}*: ${newOdo ? `Odometer ${newOdo} ${unitLabel}` : ''} ${newHours ? `Operating Hours ${newHours}` : ''}.`;

            if (newOdo > 0) await evaluateServiceThresholds(activeVehicle, newOdo, 'distance');
            if (newHours !== null) await evaluateServiceThresholds(activeVehicle, newHours, 'hours');

            if (activeVehicle.owner_id !== profileData?.id) {
              await queueOwnerNotification(activeVehicle.owner_id, activeVehicle.id, profileData.id, 'UPDATE_MILEAGE', `Metrics Updated: Odometer ${newOdo} ${unitLabel} | Hours: ${newHours || 'N/A'}`);
            }
          } catch (updateErr) {
            fastify.log.error('Mileage update error:', updateErr);
            customReply = "Sorry, I ran into an issue updating vehicle metrics.";
          }
        }
      }

      // 12. CONFIGURE_BUSINESS_MODE
      else if (aiResult.intent === 'CONFIGURE_BUSINESS_MODE') {
        const ext = aiResult.extracted_data;
        const targetPlate = ext.plate_number || activeVehicle?.plate_number;
        const targetVehicle = existingVehicles?.find(v => v.plate_number === targetPlate) || activeVehicle;

        if (!targetVehicle) {
          customReply = "I need to know which vehicle to configure. Please provide the plate number.";
        } else {
          try {
            const updatePayload = {
              is_business: ext.is_business !== null ? ext.is_business : true,
              opt_in_earnings: ext.opt_in_earnings !== null ? ext.opt_in_earnings : true,
              audit_report_frequency: ext.audit_report_frequency || 'on_demand'
            };
            if (ext.unit_system) {
              updatePayload.unit_system = ext.unit_system.toLowerCase();
            }
            await supabase.from('vehicles').update(updatePayload).eq('id', targetVehicle.id);
            
            const mode = ext.is_business === false ? "Personal Mode" : "Business Mode";
            const optInStr = ext.opt_in_earnings === false ? "Earnings Tracking Disabled" : "Earnings Tracking Enabled";
            const freqStr = ext.audit_report_frequency === 'daily' ? 'Daily' : ext.audit_report_frequency === 'weekly' ? 'Weekly' : 'On-Demand';
            const unitStr = ext.unit_system ? `\n- Unit System: ${ext.unit_system.toUpperCase()}` : '';
            customReply = `Configuration updated for ${targetVehicle.plate_number}:\n- ${mode}\n- ${optInStr}\n- Audit Frequency: ${freqStr}${unitStr}`;
          } catch (cfgErr) {
            fastify.log.error('Config update error:', cfgErr);
            customReply = "Sorry, I couldn't update the vehicle configuration right now.";
          }
        }
      }

      // 4. LOG_EARNINGS
      else if (aiResult.intent === 'LOG_EARNINGS') {
        if (!activeVehicle && existingVehicles?.length > 1) {
          const listStr = existingVehicles.map((v, i) => `${i + 1}️⃣ *${v.plate_number}* (${v.make_model})`).join('\n');
          customReply = `You have multiple registered vehicles. Please specify which vehicle to log earnings for:\n\n${listStr}`;
        } else if (!activeVehicle && existingVehicles?.length === 0) {
          customReply = `No registered vehicles found. Reply with 'register vehicle' to add your vehicle.`;
        } else {
          const ext = aiResult.extracted_data;
          const revenue = ext.revenue_amount || '0';
          const currencyStr = countryInfo.currency || 'KES';
          const targetVehicle = activeVehicle;
          
          if (targetVehicle && !(targetVehicle.metadata?.opt_in_earnings) && !(targetVehicle.opt_in_earnings)) {
             customReply = `Your vehicle *${targetVehicle.plate_number}* is not configured for earnings tracking. Reply "Enable business mode and set daily audits" to opt-in.`;
          } else {
            try {
              await supabase.from('private_earnings').insert([{
                vehicle_id: targetVehicle?.id || null,
                driver_id: profileData?.id || null,
                revenue_amount: parseFloat(revenue),
                currency: currencyStr,
                trip_count: ext.trip_count || 1,
                notes: ext.message_body || 'Earnings logged via WhatsApp'
              }]);
              customReply = `Recorded revenue of ${currencyStr} ${revenue} for *${targetVehicle?.plate_number || 'vehicle'}*. Great work!`;

              if (targetVehicle && targetVehicle.owner_id !== profileData?.id) {
                await queueOwnerNotification(targetVehicle.owner_id, targetVehicle.id, profileData.id, 'LOG_EARNINGS', `Revenue Logged: ${currencyStr} ${revenue} (${ext.trip_count || 1} trips)`);
              }
            } catch (earnErr) {
              fastify.log.error('Earnings logging error:', earnErr);
              customReply = "Sorry, I ran into an issue logging earnings.";
            }
          }
        }
      }

      // 5. ASSIGN_DRIVER
      else if (aiResult.intent === 'ASSIGN_DRIVER') {
        const ext = aiResult.extracted_data;
        const driverName = ext.driver_name_or_id || 'Driver';
        const rawPhone = ext.driver_phone;
        const driverPhone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null;
        const driverEmail = ext.driver_email ? ext.driver_email.toLowerCase() : null;
        const driverLicenseExpiry = ext.driver_license_expiry || null;
        const driverLicenseNumber = ext.driver_license_number || null;

        if (!activeVehicle) {
          customReply = "You don't have an active vehicle to assign a driver to.";
        } else if (!driverEmail || !driverLicenseExpiry) {
          customReply = `To assign driver ${driverName} to ${activeVehicle.plate_number}, please provide both their Valid Email Address and Driver License Expiry Date (YYYY-MM-DD).`;
        } else {
          try {
            let driverProfile = null;
            if (driverPhone) {
              const { data: pByPhone } = await supabase.from('profiles').select('*').eq('phone_number', driverPhone).maybeSingle();
              driverProfile = pByPhone;
            }
            if (!driverProfile && driverEmail) {
              const { data: pByEmail } = await supabase.from('profiles').select('*').eq('email', driverEmail).maybeSingle();
              driverProfile = pByEmail;
            }

            if (!driverProfile) {
              const newPhone = driverPhone || `+254${Math.floor(700000000 + Math.random() * 90000000)}`;
              const { data: createdP } = await supabase.from('profiles').insert([{
                phone_number: newPhone,
                email: driverEmail,
                full_name: driverName,
                driver_license_number: driverLicenseNumber,
                driver_license_expiry: new Date(driverLicenseExpiry).toISOString(),
                is_active: true
              }]).select().single();
              driverProfile = createdP;
            } else {
              await supabase.from('profiles').update({
                email: driverEmail,
                driver_license_number: driverLicenseNumber || driverProfile.driver_license_number,
                driver_license_expiry: new Date(driverLicenseExpiry).toISOString(),
                is_active: true
              }).eq('id', driverProfile.id);
            }

            await supabase.from('vehicles').update({
              assigned_driver_id: driverProfile.id,
              metadata: { ...(activeVehicle.metadata || {}), assigned_driver: driverName }
            }).eq('id', activeVehicle.id);

            if (driverProfile.phone_number) {
              await sendMetaWhatsAppMessage(driverProfile.phone_number, `🚘 You have been assigned as the official driver for vehicle *${activeVehicle.plate_number}* (${activeVehicle.make_model}). You can log expenses, earnings, and update mileage anytime via chat!`);
            }

            customReply = `Driver ${driverName} (${driverEmail}) successfully assigned to ${activeVehicle.plate_number}. License Expiry: ${driverLicenseExpiry}.`;
          } catch (driverErr) {
            fastify.log.error('Driver assignment error:', driverErr);
            customReply = `Failed to assign driver. Please verify details and try again.`;
          }
        }
      }

      // 6. TRANSFER_VEHICLE
      else if (aiResult.intent === 'TRANSFER_VEHICLE') {
        const recipientPhone = aiResult.extracted_data.to_owner_phone;
        const cleanRecipientPhone = recipientPhone ? (recipientPhone.startsWith('+') ? recipientPhone : `+${recipientPhone}`) : null;

        if (!activeVehicle) {
          customReply = "You don't have an active vehicle to transfer.";
        } else if (!cleanRecipientPhone) {
          customReply = "Please provide the phone number of the recipient to transfer vehicle ownership.";
        } else {
          try {
            let { data: recipientProfile } = await supabase
              .from('profiles')
              .select('id, full_name, phone_number')
              .eq('phone_number', cleanRecipientPhone)
              .maybeSingle();

            if (!recipientProfile) {
              const { data: newRecipient } = await supabase
                .from('profiles')
                .insert([{ phone_number: cleanRecipientPhone, full_name: 'New Vehicle Owner' }])
                .select()
                .single();
              recipientProfile = newRecipient;
            }

            const newPassbookToken = `SK-PASSBOOK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

            await supabase
              .from('vehicles')
              .update({
                owner_id: recipientProfile.id,
                assigned_driver_id: null,
                qr_passbook_token: newPassbookToken
              })
              .eq('id', activeVehicle.id);

            await supabase.from('passbook_transfers').insert([{
              vehicle_id: activeVehicle.id,
              from_owner_id: profileData?.id || null,
              to_owner_phone: cleanRecipientPhone,
              status: 'completed'
            }]);

            await sendMetaWhatsAppMessage(cleanRecipientPhone, `🎉 Ownership of vehicle *${activeVehicle.plate_number}* (${activeVehicle.make_model}) has been transferred to you! Your new Passbook Token is: *${newPassbookToken}*.`);

            customReply = `Vehicle *${activeVehicle.plate_number}* has been successfully transferred to ${cleanRecipientPhone}. Historical financial logs remain preserved in audit history.`;
          } catch (transferErr) {
            fastify.log.error('Passbook transfer error:', transferErr);
            customReply = `Failed to execute passbook transfer. Please verify recipient phone number.`;
          }
        }
      }

      // 13. DEACTIVATE_ACCOUNT
      else if (aiResult.intent === 'DEACTIVATE_ACCOUNT') {
        const inputCode = aiResult.extracted_data?.confirmation_code || messageText.match(/\b\d{6}\b/)?.[0];
        const storedOtpObj = deactivationOtpStore.get(senderPhone);

        if (!profileData?.email) {
          customReply = "⚠️ To request account deactivation, you must have a verified email address on file. Please provide a valid email address first.";
        } else if (inputCode && storedOtpObj && storedOtpObj.otp === inputCode && Date.now() < storedOtpObj.expiresAt) {
          const nowIso = new Date().toISOString();
          await supabase
            .from('profiles')
            .update({ is_active: false, deleted_at: nowIso, subscription_status: 'deactivated' })
            .eq('id', profileData.id);

          await supabase
            .from('vehicles')
            .update({ deleted_at: nowIso })
            .eq('owner_id', profileData.id);

          deactivationOtpStore.delete(senderPhone);
          chatSessions.delete(senderPhone);

          customReply = "✅ *Account Soft-Deleted*\nYour profile and registered vehicles have been soft-deleted to protect historical audit logs. You can reactivate anytime by messaging 'REACTIVATE'.";
        } else {
          const deactivationCode = Math.floor(100000 + Math.random() * 900000).toString();
          deactivationOtpStore.set(senderPhone, { otp: deactivationCode, expiresAt: Date.now() + 300000, email: profileData.email });

          try {
            await sendMfaEmail(profileData.email, deactivationCode);
            customReply = `⚠️ *Account Deactivation MFA Initiated*\nA secure 6-digit confirmation code has been dispatched *only* to your verified email (*${profileData.email}*). Reply with the 6-digit code within 5 minutes to finalize deactivation.`;
          } catch (mfaErr) {
            fastify.log.error('MFA Email sending error:', mfaErr);
            customReply = `Failed to send verification email to ${profileData.email}. Please ensure your email is correct and try again.`;
          }
        }
      }

      // 14. REACTIVATE_ACCOUNT
      else if (aiResult.intent === 'REACTIVATE_ACCOUNT') {
        if (profileData) {
          await supabase
            .from('profiles')
            .update({ is_active: true, deleted_at: null, subscription_status: 'active' })
            .eq('id', profileData.id);

          await supabase
            .from('vehicles')
            .update({ deleted_at: null })
            .eq('owner_id', profileData.id);

          customReply = "🎉 Welcome back! Your Saka account and vehicles have been reactivated successfully.";
        } else {
          customReply = "No deactivated profile found for this number.";
        }
      }

      // 7. SET_REMINDER
      else if (aiResult.intent === 'SET_REMINDER') {
        const ext = aiResult.extracted_data;
        const userTierKey = profileData?.subscription_tier || 'free';
        const currentTier = SUBSCRIPTION_TIERS[userTierKey] || SUBSCRIPTION_TIERS.free;

        const reminderType = ext.reminder_type || 'Compliance / Document';
        const dueDateParsed = ext.due_date ? new Date(ext.due_date) : new Date(Date.now() + 30 * 86400000);
        const thresholdUnit = ext.threshold_unit || (ext.target_value ? 'distance' : 'date');

        if ((thresholdUnit === 'distance' || thresholdUnit === 'hours') && !currentTier.hasPremiumFeatures) {
          const checkout = await initializePaystackCheckout({
            supabase,
            userPhone: senderPhone,
            targetTierKey: 'solo_pro',
            billingInterval: 'monthly',
            userEmail: profileData?.email,
            userId: profileData?.id,
            currency: countryInfo.currency
          });

          customReply = `🔒 *Premium Feature: Dynamic Threshold Alerts*\n\nOdometer and operating hour threshold service reminders are premium features.\n\nUpgrade to *Solo Pro* (${checkout.priceInfo.formattedPrice}/month) to enable dynamic distance and hour threshold service reminders!\n\n👉 *Upgrade Link:* ${checkout.checkoutUrl}`;
        } else {
          const targetValue = ext.target_value ? parseFloat(ext.target_value) : null;
          const intervalValue = ext.interval_value ? parseFloat(ext.interval_value) : null;
          const intervalMonths = ext.interval_months ? parseInt(ext.interval_months) : 12;

          try {
            const lastServ = thresholdUnit === 'hours' 
              ? parseFloat(activeVehicle?.operating_hours || 0) 
              : parseFloat(activeVehicle?.odometer_reading || 0);

            await supabase.from('reminders').insert([{
              vehicle_id: activeVehicle?.id || null,
              profile_id: profileData?.id || null,
              reminder_type: reminderType,
              due_date: dueDateParsed ? dueDateParsed.toISOString() : null,
              threshold_unit: thresholdUnit,
              target_value: targetValue,
              last_service_value: lastServ,
              interval_value: intervalValue,
              interval_months: intervalMonths,
              status: 'active'
            }]);

            if (thresholdUnit === 'date') {
              customReply = `Date reminder set: ${reminderType} due on ${dueDateParsed.toDateString()} for ${activeVehicle?.plate_number || 'your vehicle'}.`;
            } else {
              customReply = `Threshold reminder set: ${reminderType} set for target ${targetValue} ${thresholdUnit === 'hours' ? 'Operating Hours' : 'KM/Miles'} on ${activeVehicle?.plate_number || 'your vehicle'}.`;
            }
          } catch (remErr) {
            fastify.log.error('Reminder insertion error:', remErr);
          }
        }
      }

      // 8. REQUEST_REPORT
      else if (aiResult.intent?.toUpperCase() === 'REQUEST_REPORT') {
        const userTierKey = profileData?.subscription_tier || 'free';
        const currentTier = SUBSCRIPTION_TIERS[userTierKey] || SUBSCRIPTION_TIERS.free;

        if (!currentTier.hasPremiumFeatures) {
          const checkout = await initializePaystackCheckout({
            supabase,
            userPhone: senderPhone,
            targetTierKey: 'solo_pro',
            billingInterval: 'monthly',
            userEmail: profileData?.email,
            userId: profileData?.id,
            currency: countryInfo.currency
          });

          customReply = `🔒 *Premium Feature: PDF Audit Reports*\n\nGenerating cryptographically verified PDF audit reports is a premium feature.\n\nUpgrade to *Solo Pro* (${checkout.priceInfo.formattedPrice}/month) to unlock downloadable PDF reports!\n\n👉 *Upgrade Link:* ${checkout.checkoutUrl}`;
        } else {
          try {
            console.log('[REQUEST_REPORT] Handler triggered.');
          const plateNumber = (aiResult.extracted_data.plate_number || activeVehicle?.plate_number || 'KDA 123A').toUpperCase();
          console.log(`[REQUEST_REPORT] Resolved plateNumber: ${plateNumber}`);
          
          console.log('[REQUEST_REPORT] Resolving targetEmail...');
          let targetEmail = aiResult.extracted_data.target_email || profileData?.email || null;
          console.log(`[REQUEST_REPORT] Initial targetEmail (from AI/profile): ${targetEmail}`);

          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
          const emailMatch = messageText.match(emailRegex);
          if (emailMatch && !targetEmail) {
            targetEmail = emailMatch[0].toLowerCase();
            console.log(`[REQUEST_REPORT] targetEmail matched from regex: ${targetEmail}`);
          }

          console.log(`[REQUEST_REPORT] Final resolved targetEmail: ${targetEmail}`);

          if (targetEmail && profileData && profileData.email !== targetEmail) {
            console.log(`[REQUEST_REPORT] Updating profile email from ${profileData.email} to ${targetEmail}`);
            await supabase
              .from('profiles')
              .update({ email: targetEmail, email_verified: true })
              .eq('id', profileData.id);
            fastify.log.info(`Saved/Updated profile email to ${targetEmail}`);
          }

          let reportVehicleId = activeVehicle?.id;
          let reportOdometer = activeVehicle?.odometer_reading || '0';
          
          if (!reportVehicleId || activeVehicle?.plate_number !== plateNumber) {
            const { data: vData } = await supabase
              .from('vehicles')
              .select('id, odometer_reading')
              .eq('plate_number', plateNumber)
              .maybeSingle();
            
            if (vData) {
              reportVehicleId = vData.id;
              reportOdometer = vData.odometer_reading || '0';
            }
          }

          let actualFuelLiters = 0;
          let actualTotalCost = 0;
          let actualBurnRate = '0.0';
          let vehicleReminders = [];
          let recentOps = [];
          let assignedDriver = null;

          if (reportVehicleId) {
            const { data: vDataFull } = await supabase
              .from('vehicles')
              .select('metadata')
              .eq('id', reportVehicleId)
              .maybeSingle();
            
            if (vDataFull && vDataFull.metadata) {
               assignedDriver = vDataFull.metadata.assigned_driver || null;
            }

            const { data: expenses } = await supabase
              .from('expense_logs')
              .select('amount, fuel_liters, expense_type, created_at')
              .eq('vehicle_id', reportVehicleId)
              .order('created_at', { ascending: false });

            const { data: earnings } = await supabase
              .from('private_earnings')
              .select('revenue_amount, logged_at')
              .eq('vehicle_id', reportVehicleId)
              .order('logged_at', { ascending: false });

            let allOps = [];

            if (expenses && expenses.length > 0) {
              actualTotalCost = expenses.reduce((sum, exp) => sum + (Number(exp.amount) || 0), 0);
              actualFuelLiters = expenses.reduce((sum, exp) => sum + (Number(exp.fuel_liters) || 0), 0);
              
              allOps = allOps.concat(expenses.map(e => ({
                 created_at: e.created_at,
                 type: e.expense_type || 'Expense',
                 value: `- KES ${Number(e.amount || 0).toLocaleString('en-US')}`
              })));
            }

            if (earnings && earnings.length > 0) {
              allOps = allOps.concat(earnings.map(e => ({
                 created_at: e.logged_at,
                 type: 'Revenue Logging',
                 value: `+ KES ${Number(e.revenue_amount || 0).toLocaleString('en-US')}`
              })));
            }

            allOps.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            recentOps = allOps.slice(0, 3);
            
            const odoMatch = String(reportOdometer).match(/[\d,.]+/);
            const odoNum = odoMatch ? parseFloat(odoMatch[0].replace(/,/g, '')) : 0;
            
            if (odoNum > 0 && actualFuelLiters > 0) {
              actualBurnRate = (odoNum / actualFuelLiters).toFixed(1); // KM/L
            }

            const { data: rems } = await supabase
              .from('reminders')
              .select('reminder_type, due_date')
              .eq('vehicle_id', reportVehicleId)
              .eq('status', 'active')
              .order('due_date', { ascending: true })
              .limit(5);

            if (rems) {
               vehicleReminders = rems;
            }
          }

          const reportData = {
            plateNumber: plateNumber,
            reportType: aiResult.extracted_data.report_type || 'Vehicle Report',
            fuelLiters: actualFuelLiters.toFixed(1),
            kwhCharged: expenses ? expenses.reduce((sum, e) => sum + (Number(e.kwh_charged) || 0), 0).toFixed(1) : '0',
            operatingHours: activeVehicle?.operating_hours ? Number(activeVehicle.operating_hours).toFixed(1) : '0',
            chargeCycles: activeVehicle?.charge_cycles ? Number(activeVehicle.charge_cycles).toString() : '0',
            totalCost: actualTotalCost.toLocaleString('en-US'),
            burnRate: actualBurnRate,
            unitSystem: activeVehicle?.unit_system || profileData?.unit_system || 'metric',
            assetType: activeVehicle?.asset_type || 'ICE',
            status: reportVehicleId ? 'Verified & Active' : 'Unregistered',
            assignedDriver: assignedDriver,
            reminders: vehicleReminders,
            recentOperations: recentOps
          };

          console.log('[REQUEST_REPORT] Generating PDF buffer...');
          const pdfBuffer = await generateFleetReport(reportData);
          console.log(`[REQUEST_REPORT] PDF buffer generated successfully. Size: ${pdfBuffer ? pdfBuffer.length : 'undefined'} bytes.`);

          console.log('[REQUEST_REPORT] Uploading to Supabase...');
          const publicUrl = await uploadReportToSupabase(supabase, pdfBuffer, plateNumber);
          console.log(`[REQUEST_REPORT] Report uploaded. URL: ${publicUrl}`);

          if (targetEmail) {
            try {
              console.log(`[REQUEST_REPORT] Attempting to send report via email to ${targetEmail}...`);
              await sendReportByEmail(targetEmail, plateNumber, pdfBuffer);
              console.log(`[REQUEST_REPORT] Email sent successfully to ${targetEmail}.`);
              fastify.log.info(`Email report successfully dispatched to ${targetEmail} via Resend`);
            } catch (mailErr) {
              console.log(`[REQUEST_REPORT] Error caught while sending email: ${mailErr.message}`);
              fastify.log.error('Resend email dispatch error:', mailErr.message);
            }
          } else {
            console.log('[REQUEST_REPORT] No targetEmail found. Skipping email dispatch.');
          }

          if (targetEmail) {
            customReply = `Here is your audit report for ${plateNumber}:\n\n${publicUrl}\n\n(A copy was also successfully emailed to ${targetEmail}!)`;
            delete session.pendingReport;
          } else {
            session.pendingReport = {
              plateNumber: plateNumber,
              reportType: reportData.reportType
            };
            customReply = `Here is your audit report for ${plateNumber}:\n\n${publicUrl}\n\nPlease reply with your email address if you would like me to email a copy of this report to you.`;
          }
          console.log(`[REQUEST_REPORT] Handler finished successfully.`);
        } catch (reportErr) {
          console.log(`[REQUEST_REPORT] Global catch triggered: ${reportErr.message}`);
          fastify.log.error('Report Generation/Dispatch Error:', reportErr);
          customReply = 'Sorry, I ran into an issue generating that report. Please try again.';
        }
        }
      }

      // 15. UPGRADE_SUBSCRIPTION
      else if (aiResult.intent === 'UPGRADE_SUBSCRIPTION') {
        const userTierKey = profileData?.subscription_tier || 'free';
        const currentTier = SUBSCRIPTION_TIERS[userTierKey] || SUBSCRIPTION_TIERS.free;
        const userCurrency = countryInfo.currency || 'USD';

        const soloMonthly = await initializePaystackCheckout({
          supabase,
          userPhone: senderPhone,
          targetTierKey: 'solo_pro',
          billingInterval: 'monthly',
          userEmail: profileData?.email,
          userId: profileData?.id,
          currency: userCurrency
        });

        const soloAnnual = await initializePaystackCheckout({
          supabase,
          userPhone: senderPhone,
          targetTierKey: 'solo_pro',
          billingInterval: 'annual',
          userEmail: profileData?.email,
          userId: profileData?.id,
          currency: userCurrency
        });

        const growthMonthly = await initializePaystackCheckout({
          supabase,
          userPhone: senderPhone,
          targetTierKey: 'growth',
          billingInterval: 'monthly',
          userEmail: profileData?.email,
          userId: profileData?.id,
          currency: userCurrency
        });

        customReply = `⭐ *Saka Subscription Plans*\n\n` +
          `Current Plan: *${currentTier.name}*\n\n` +
          `1️⃣ *Solo Pro* (Up to 2 vehicles, 100% Premium Features Unlocked)\n` +
          `• Monthly: ${soloMonthly.priceInfo.formattedPrice}/mo\n` +
          `  👉 Checkout: ${soloMonthly.checkoutUrl}\n` +
          `• Annual (Save 30%): ${soloAnnual.priceInfo.formattedPrice}/yr\n` +
          `  👉 Checkout: ${soloAnnual.checkoutUrl}\n\n` +
          `2️⃣ *Growth* (Up to 5 vehicles, full access)\n` +
          `• Monthly: ${growthMonthly.priceInfo.formattedPrice}/mo\n` +
          `  👉 Checkout: ${growthMonthly.checkoutUrl}\n\n` +
          `Click any link above to complete your subscription securely via Paystack!`;
      }

      // 9. CONTACT_SUPPORT
      else if (aiResult.intent === 'CONTACT_SUPPORT') {
        const ext = aiResult.extracted_data;
        try {
          await supabase.from('support_tickets').insert([{
            user_id: profileData?.id || null,
            whatsapp_number: senderPhone,
            issue_category: ext.issue_category || 'General Inquiry',
            message_body: ext.message_body || messageText,
            status: 'open'
          }]);
          customReply = `Support ticket created. Our team will review and get back to you shortly.`;
        } catch (ticketErr) {
          fastify.log.error('Support ticket error:', ticketErr);
        }
      }

      // 10. LIST_VEHICLES
      else if (aiResult.intent === 'LIST_VEHICLES') {
        if (!existingVehicles || existingVehicles.length === 0) {
          customReply = "You don't have any vehicles registered yet. Would you like to register one now?";
        } else {
          const vehicleList = existingVehicles.map(v => 
            `- *${v.plate_number}* (${v.make_model || 'Unknown Make/Model'})`
          ).join('\n');
          customReply = `Here are your registered vehicles:\n${vehicleList}`;
        }
      }

      // 11. MANAGE_VEHICLE
      else if (aiResult.intent === 'MANAGE_VEHICLE') {
        const targetPlate = aiResult.extracted_data.plate_number;
        
        if (!existingVehicles || existingVehicles.length === 0) {
          customReply = "You don't have any vehicles registered to manage. Say 'register vehicle' to start.";
        } else if (targetPlate) {
          const v = existingVehicles.find(v => v.plate_number === targetPlate.toUpperCase());
          if (v) {
            customReply = `⚙️ *Managing ${v.plate_number}*\nMake/Model: ${v.make_model}\nOdometer: ${v.odometer_reading} km\n\nReply with what you'd like to do:\n1️⃣ Log Expense\n2️⃣ Update Mileage\n3️⃣ Request Report`;
          } else {
            customReply = `I couldn't find a vehicle with plate *${targetPlate}*. Please verify and try again.`;
          }
        } else {
          const vehicleList = existingVehicles.map((v, i) => 
            `${i + 1}️⃣ *${v.plate_number}* (${v.make_model})`
          ).join('\n');
          customReply = `Which vehicle would you like to manage? Reply with the plate number:\n\n${vehicleList}`;
        }
      }

      const sanitizedReply = customReply.trim();

      session.history.push({ role: 'user', parts: [{ text: messageText }] });
      session.history.push({ role: 'model', parts: [{ text: sanitizedReply }] });
      if (session.history.length > 20) session.history = session.history.slice(-20);
      chatSessions.set(senderPhone, session);

      await sendMetaWhatsAppMessage(senderPhone, sanitizedReply);
      logChatTranscript(supabase, senderPhone, 'assistant', sanitizedReply);
      return reply.status(200).send({ status: 'success' });
    }

    return reply.status(404).send({ error: 'Not a WhatsApp API event' });
  } catch (err) {
    fastify.log.error('Meta Webhook error:', err);
    return reply.status(500).send({ error: 'Internal server error handling webhook.' });
  }
}

fastify.post('/webhook', handleWhatsAppWebhook);
fastify.post('/webhook/whatsapp', handleWhatsAppWebhook);
fastify.post('/api/whatsapp/webhook', handleWhatsAppWebhook);

// 9. Saka Sentinel Worker Protected API Endpoint
fastify.post('/api/sentinel/run', async (request, reply) => {
  const sentinelSecret = process.env.SENTINEL_SECRET || 'saka_sentinel_secret_2026';
  const authHeader = request.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (request.headers['x-sentinel-secret'] || request.body?.secret);

  if (!token || token !== sentinelSecret) {
    return reply.status(401).send({
      status: 'error',
      error: 'Unauthorized: Invalid or missing SENTINEL_SECRET'
    });
  }

  try {
    fastify.log.info('Running Saka Sentinel Worker (Health Check + Conversation Refinement)...');
    const healthCheckResult = await runHealthCheck(supabase);
    const refinementResult = await runConversationRefinement(supabase);

    return reply.status(200).send({
      status: 'success',
      timestamp: new Date().toISOString(),
      actions: {
        health_check: healthCheckResult,
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

    const port = process.env.PORT || 3000;
    await fastify.listen({ port: Number(port), host: '0.0.0.0' });
    serverStarted = true;
    console.log(`🚀 Saka Fleet Meta-Native Backend is live and listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();