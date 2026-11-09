import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
// v1.90.0 (Phase 28B) — security hardening seams (each pinned by test_security).
import { buildErrorHandler } from './src/services/errorHandler.js';
import { registerSecurityHeaders } from './src/services/securityHeaders.js';
import { rateLimitKeyGenerator } from './src/services/rateLimitIdentity.js';

import { generateFleetReport, uploadReportToSupabase } from './reports.js';
import { sendReportByEmail, sendMfaEmail, sendEmailOtp } from './src/services/mailer.js';
import { processSakaMessage } from './sakaAi.js';
import { runHealthCheck, runConversationRefinement, evaluateConversationalFriction, monitorActiveConversations, logSystemError, logChatTranscript, ensureSentinelTables, scanCloudRunAnomalies, sendProactiveWhatsApp, sendWhatsAppTemplateMessage } from './src/workers/sentinel.js';
import { ensureSuperadminTables, isSuperadminPhone, sendMorningExecutiveBriefing, maybeSendAiBudgetAlert } from './src/services/superadmin.js';
import { ensureVehicleTableColumns } from './src/services/vehicles.js';
import { ensureCountrySttLocaleColumn } from './src/services/countryBucket.js';
import { ensureTrialSchemaDefaults } from './src/services/trialSchema.js';
import { handleWhatsAppWebhook as handleWhatsAppWebhookRoute, handleWhatsAppWebhookVerification } from './src/routes/whatsapp/webhook.js';
import { verifyPaystackSignature } from './src/services/paystack.js';
import { runReminderSweep } from './src/services/maintenanceReminders.js';
import { runWeeklyReportsSweep } from './src/workers/weeklyReports.js';
import { runMonthlyReportsSweep } from './src/workers/monthlyReports.js';
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
import { detectCountryFromPhone, buildGlobalContext, formatMoney } from './src/services/globalization.js';
import { formatNairobiDate } from './src/services/dateParser.js';
import { runDeepAudit, isDeepAuditEnabled, parseDeepAuditSchedule } from './src/services/deepAudit.js';
import { handleInboundSupportEmail } from './src/services/customerCare.js';
import { handleInboundEmail } from './src/services/inboundEmail.js';
import { ensureAiUsageLogsTable, installAiUsageSink, installAiBudgetGuard } from './src/services/aiUsageLog.js';
import { ensureTurnLatencyTable } from './src/services/turnLatency.js';
import { buildStatusResponse, isStatusAuthorized } from './src/services/statusProbe.js';
import { auditEnv, envTemplateKeys, envStatusSummary } from './src/services/envAudit.js';
import { runConvEvalTick } from './src/workers/convEval.js';
import { sendEvalDigest } from './src/services/evalDigest.js';
import { ensureConvEvalTable, getConvEvalConfig } from './src/services/convEval.js';
import { announceRevisionLive } from './src/services/deployLiveAlert.js';
import { resolveProactiveMode } from './src/services/proactiveTemplates.js';
import {
  ensureAiModelRegistryTables,
  installModelRuntime,
  runModelScoutCycle,
  monitorModelHealth,
  AI_MODEL_SCOUT_INTERVAL_MS
} from './src/services/aiModelRegistry.js';
import { ensureFuelEconomySchema } from './src/services/fuelEconomy.js';
import { ensureEarningTypeSchema } from './src/services/earningCatalog.js';
import {
  ensureShortLinksTable,
  resolveShortCode,
  shortenUrl,
  shortLinkStatus,
  verifyShortLinkRoute,
  shortLinkNotFoundHtml,
  SHORT_LINK_PROBE_PATH,
  SHORT_LINK_PROBE_TAG
} from './src/services/linkShortener.js';
import { ensureReceiptsTable, pruneOldReceipts } from './src/services/receipts.js';
// v1.84.0 (Phase 23) — the vehicle document vault (boot ensure next to receipts).
import { ensureVehicleDocumentsTable } from './src/services/vehicleDocuments.js';
import { ensureOcrRequestsTable, pruneOcrTelemetry } from './src/services/ocrTelemetry.js';
import { ensureChatSessionsTable } from './src/services/sessionStore.js';
import { registerDashboardRoutes } from './src/routes/dashboard.js';
import { ensureDashboardTable, pruneExpiredDashboardSessions } from './src/services/dashboard.js';
import {
  sanitizeOnboardPayload,
  createWebOnboardSession,
  verifyWebOnboardCode,
  resendWebOnboardCode,
  completeWebOnboarding,
  checkSignupAvailability,
  ensureWebOnboardOtpTable,
  inspectExistingSignup,
  notifyExistingSignup,
  auditWebOnboardEvent,
  pruneExpiredWebOnboardOtps
} from './src/services/webOnboarding.js';
import { ensureLaunchAwardTable, getLaunchAwardStatus } from './src/services/launchAwards.js';
import { upsertIncident } from './src/services/incidents.js';
import { ensureFeatureNoticeSchema } from './src/services/featureNotice.js';
import { ensureContactNudgeSchema } from './src/services/contactNudge.js';
import { drainQueue, getQueueStats } from './src/services/messageQueue.js';
import { processPendingFollowUps } from './src/services/followups.js';
import { handlePaystackEvent } from './src/services/subscriptions.js';
import { ensureSubscriptionSchema } from './src/db/subscriptionSchema.js';
import { runTrialLifecycleSweep } from './src/services/trialEngine.js';

// 1. Initialize Fastify Server
// v1.90.0 (Phase 28B) — trustProxy lets request.ip resolve through the Google
// Frontend; the rate limiter below nevertheless keys on the RIGHTMOST
// x-forwarded-for hop explicitly (rateLimitIdentity.js), which is the one
// address the GFE appends and a caller can never forge.
const fastify = Fastify({ logger: true, trustProxy: true });

// Register Fastify Rate Limiter for Abuse Prevention
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'],
  keyGenerator: rateLimitKeyGenerator,
  errorResponseBuilder: (request, context) => {
    return {
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum ${context.max} requests per ${context.after} allowed.`,
      date: new Date().toISOString()
    };
  }
});

// v1.90.0 (Phase 28B) — HSTS on HTTPS responses + a 308 for explicit plain
// HTTP, with the status probes exempt (Google's edge intercepts /healthz and
// platform health checks must never be redirected).
registerSecurityHeaders(fastify);

// v1.39.0 — CORS for the marketing site only: the web onboarding surface and
// the public health probe. Every other route stays closed to browsers.
const LANDING_ORIGINS = (process.env.LANDING_ORIGINS || 'https://sakafleet.com,https://www.sakafleet.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CORS_PATHS = ['/api/onboard', '/api/onboard/check', '/api/onboard/verify', '/api/onboard/resend', '/api/onboard/launch-status', '/healthz', '/api/health'];
fastify.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (!origin) return;
  const path = (request.raw.url || '').split('?')[0];
  if (!CORS_PATHS.includes(path)) return;
  const allowed = LANDING_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  if (!allowed) return;
  reply.header('access-control-allow-origin', origin);
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  reply.header('access-control-allow-headers', 'content-type');
  reply.header('access-control-max-age', '600');
  if (request.method === 'OPTIONS') reply.code(204).send();
});

// v1.90.0 (Phase 28B) — the Sentinel error handler is installed right after the
// Supabase client below (it needs the client; the client needs the module body
// to finish). Behaviour: full detail to logs, ONE generic line to the caller.

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

// Attach Sentinel Error Handler (v1.90.0 — generic client copy, full detail in
// fastify.log + error_logs; statusCode/name preserved for callers that branch).
fastify.setErrorHandler(buildErrorHandler({ supabase, log: fastify.log, logSystemError }));

// Memory Stores with 24-hour expiry cleanup
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
        const msg = `🔔 *Driver Activity Summary (${plate})*\nDriver *${driverName}* submitted:\n👉 ${item.details_summary}`;
        // v1.63.1 — Phase 1 completion: window-safe proactive kind (fallback text above is byte-identical).
        await sendMetaWhatsAppMessage(ownerPhone, msg, 'driver_activity', { plate, driver: driverName });
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
    sendFn: (phone, text, kind, templateVars) => sendMetaWhatsAppMessage(phone, text, kind, templateVars)
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

// Worker: always-on self-learning (v1.28.8). Before this, conversation
// refinement only ran through the external Sentinel endpoint — the database had
// no stored learnings at all. The tick is bounded, overlap-guarded and can be
// tuned with SENTINEL_LEARN_INTERVAL_MS (default 15 min).
const SENTINEL_LEARN_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.SENTINEL_LEARN_INTERVAL_MS || 15 * 60 * 1000)
);
let learnTickInFlight = false;
setInterval(async () => {
  if (learnTickInFlight) return;
  learnTickInFlight = true;
  try {
    const result = await runConversationRefinement(supabase);
    if (result?.status === 'success') {
      console.log(`[Worker] Self-learning tick complete (prompt updated: ${Boolean(result.saka_core_prompt_updated)}).`);
    }
  } catch (err) {
    console.warn('[Worker] Self-learning tick skipped:', err.message);
  } finally {
    learnTickInFlight = false;
  }
}, SENTINEL_LEARN_INTERVAL_MS);

// Worker: Universal Reminder Sweep — evaluates distance (km/mi) and
// operating-hours thresholds against live readings AND the date-based expiry
// ladder (insurance, inspection/MOT, licensing, permits, driver licences,
// general deadlines) at 30d / 14d / 7d / 24h / overdue.
async function runMaintenanceReminderSweep() {
  try {
    const result = await runReminderSweep({
      supabase,
      sendFn: (phone, text, _vehicle, kind, templateVars) => sendMetaWhatsAppMessage(phone, text, kind, templateVars),
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

// Worker (Phase 10, P3-4): weekly report opt-in sweep — Monday 08:00 EAT.
// The 30-minute tick is a cheap gate check; the worker itself only runs inside
// the Monday 08:00–08:05 window and dedupes on the Nairobi day marker in
// system_config (claim-first, at-least-once — see weeklyReports.js).
async function runWeeklyReportSweep() {
  try {
    const result = await runWeeklyReportsSweep({
      supabase,
      sendFn: (phone, text, _profile, kind) => sendMetaWhatsAppMessage(phone, text, kind)
    });
    if (result?.sent) {
      console.log(`[WeeklyReports] sent ${result.sent} weekly summary(ies) for ${result.date} (${result.skippedEmpty} empty garage(s), ${result.failed} failed).`);
    }
  } catch (err) {
    console.error('[Worker] Weekly report sweep failed:', err.message);
  }
}
setTimeout(runWeeklyReportSweep, 5 * 60 * 1000); // First check after boot
setInterval(runWeeklyReportSweep, 30 * 60 * 1000); // Every 30 minutes (gated inside)

// Worker (Phase 16, v1.77.0): monthly PDF summary sweep — 1st of the month at
// 08:00 EAT. The 30-minute tick is a cheap gate check; the worker only runs in
// the 1st/08:00–08:05 window and dedupes on the Nairobi day marker in
// system_config (claim-first; an un-migrated opt-in column releases the mark).
async function runMonthlyReportSweep() {
  try {
    const result = await runMonthlyReportsSweep({ supabase });
    if (result?.sent) {
      console.log(`[MonthlyReports] emailed ${result.sent} monthly summary(ies) for ${result.monthLabel} (${result.skippedEmpty} empty garage(s), ${result.skippedNoEmail} without email, ${result.failed} failed).`);
    } else if (result?.reason === 'column-missing') {
      console.warn('[MonthlyReports] profiles.monthly_report_opt_in is missing — run npm run migrate:monthly-reports.');
    }
  } catch (err) {
    console.error('[Worker] Monthly report sweep failed:', err.message);
  }
}
setTimeout(runMonthlyReportSweep, 6 * 60 * 1000); // First check after boot
setInterval(runMonthlyReportSweep, 30 * 60 * 1000); // Every 30 minutes (gated inside)

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
async function sendMetaWhatsAppMessage(toPhone, messageBody, kind = null, templateVars = null) {
  // v1.63.0 - proactive kinds ride an approved Meta template when configured
  // (META_TPL_<KIND>); unset knobs keep today's free-form text (sec 182).
  const mode = kind ? resolveProactiveMode({ kind, templateVars }) : { mode: 'text' };
  if (mode.mode === 'template') {
    const templateSent = await sendWhatsAppTemplateMessage(toPhone, mode.templateName, { variables: mode.variables || [] });
    if (templateSent) return { messaging_product: 'whatsapp', sent: true, template: mode.templateName };
    // Fall through: the text path still delivers inside the 24-hour window.
  }

  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;
  
  if (!phoneNumberId || !token) {
    console.error('Meta WhatsApp credentials missing from environment variables.');
    return null;
  }

  const cleanTo = toPhone.replace('whatsapp:', '').replace('+', '').trim();

  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
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

/**
 * v1.39.0 — template-based WhatsApp message for business-initiated contact
 * (the web-signup welcome). Only fires when an approved template name is
 * configured; otherwise the website's wa.me deep link and Saka's first-message
 * greeting carry the flow. Dispatch failures are logged, never fatal.
 */
async function sendMetaWhatsAppTemplate(toPhone, templateName, { languageCode = 'en', components = [] } = {}) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!phoneNumberId || !token || !templateName) return null;
  const cleanTo = String(toPhone || '').replace('whatsapp:', '').replace('+', '').trim();
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'template',
        template: { name: templateName, language: { code: languageCode }, components }
      })
    });
    const data = await response.json();
    if (!response.ok) console.error('Meta WhatsApp Template Error:', data);
    return data;
  } catch (err) {
    console.error('Failed to dispatch Meta WhatsApp template:', err.message);
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
// Served on /healthz plus /api/health and /internal/status: Google's edge
// intercepts /healthz on some deployments, so the aliases keep the revision
// metadata reachable (v1.24.4).
const statusProbeHandler = async (request) => {
  const headers = request?.headers || {};
  // v1.32.4 — env/secret parity is disclosed to a secret-bearing operator only,
  // and only as names/booleans (never a value, see src/services/envAudit.js).
  const envAudit = isStatusAuthorized(headers)
    ? envStatusSummary(auditEnv(process.env, { templateKeys: envTemplateKeys() }))
    : null;
  return buildStatusResponse({
    headers,
    uptimeSeconds: process.uptime(),
    queue: getQueueStats(),
    // v1.32.4 — is the branded short-link base actually serving /r/<code>?
    shortLinks: shortLinkStatus(),
    envAudit
  });
};
fastify.get('/healthz', statusProbeHandler);
fastify.get('/api/health', statusProbeHandler);
fastify.get('/internal/status', statusProbeHandler);

// 5.2 Short links (v1.32.0): every long user-facing URL is presented as a
// short, branded URL; this route resolves it and redirects.
// v1.32.4 — a probe route lets the app verify ITSELF that short links work on
// the branded base before it sends any (an unverified domain shipped dead links
// on 2026-11-01). Unknown/expired codes now get an honest 404 page instead of a
// silent redirect to the marketing site.
fastify.get(SHORT_LINK_PROBE_PATH, async (request, reply) => {
  reply.header('x-saka-shortlink', SHORT_LINK_PROBE_TAG);
  reply.header('cache-control', 'no-store');
  return { service: 'saka-shortlink', route: SHORT_LINK_PROBE_PATH, ok: true };
});

fastify.get('/r/:code', async (request, reply) => {
  const target = await resolveShortCode(supabase, request.params?.code);
  if (target) return reply.redirect(target);
  reply.header('cache-control', 'no-store');
  return reply.code(404).type('text/html; charset=utf-8').send(shortLinkNotFoundHtml());
});
// ==========================================
// 8. WEB ONBOARDING (v1.39.0) — sakafleet.com signup handshake.
// The welcome trial is NOT started here (rule 26): trials begin when the user
// registers their first asset with Saka on WhatsApp.
// ==========================================

/**
 * v1.40.0 — web-onboarding failures feed the Sentinel pipeline: the error is
 * persisted to error_logs (scanned every 60s) and repeated signatures raise a
 * backend incident so the remediation flow can propose and (when approved)
 * ship a fix.
 */
async function logWebOnboardFailure(err, route, details = {}) {
  console.error(`[WebOnboard] ${route} failed:`, err?.message);
  try {
    await logSystemError(supabase, err, route);
    const message = err?.message || String(err);
    await upsertIncident(supabase, {
      signature: `web onboarding ${route}`,
      category: 'web_onboard_error',
      message: `${message} ${JSON.stringify(details || {}).slice(0, 300)}`,
      source: route
    });
  } catch (auditErr) {
    console.warn('[WebOnboard] failure telemetry failed:', auditErr.message);
  }
}

/** v1.40.0 — the welcome message Saka sends after web verification. */
function webOnboardWelcomeText(firstName) {
  const name = firstName && firstName.length >= 2 ? `, ${firstName}` : '';
  return `👋 *Welcome to Saka Fleet${name}!* I'm Saka — your vehicle's co-pilot. 🚗\n\nYour email is verified and your account is ready.\n\nNext up: reply with your vehicle details — or type *Register* — and your 30-day full-featured trial begins. 🎉\n\n🌍 *Want a different language?* Reply in the language you'd like (e.g. "Swahili" or "Français") and I'll switch.`;
}

fastify.post('/api/onboard', async (request, reply) => {
  const clean = sanitizeOnboardPayload(request.body);
  if (!clean.ok) return reply.status(400).send({ success: false, error: clean.error });
  const { firstName, lastName, email, phone, preferredLanguage, utm, launchOptIn } = clean.data;
  if (!supabase) return reply.status(503).send({ success: false, error: 'Database unavailable. Please try again shortly.' });

  try {
    // v1.40.0 — never re-onboard an already-verified account: the site shows
    // "you're all set" and points straight to WhatsApp.
    const existing = await inspectExistingSignup(supabase, { email, phone });
    if (existing.state === 'verified' || existing.state === 'email_exists') {
      await auditWebOnboardEvent(supabase, 'WEB_ONBOARD_EXISTING', { email, phone, profileId: existing.profile?.id, matchedBy: existing.matchedBy });
      await notifyExistingSignup(supabase, { profile: existing.profile, email, phone, sendWhatsApp: sendMetaWhatsAppMessage });
      return {
        success: true,
        already_verified: true,
        message: 'You are already registered. Continue on WhatsApp — Saka is waiting for you.'
      };
    }

    const sessionRow = await createWebOnboardSession(supabase, { email, phone, firstName, lastName });
    if (!sessionRow.ok) return reply.status(502).send({ success: false, error: 'We could not start your onboarding. Please try again.' });

    try {
      await sendEmailOtp(email, sessionRow.code);
    } catch (emailErr) {
      await logWebOnboardFailure(emailErr, '/api/onboard', { email, phone, stage: 'email_dispatch' });
      return reply.status(502).send({ success: false, error: 'The verification email could not be sent. Please check the address and try again.' });
    }

    const profileResult = await completeWebOnboarding(supabase, { email, phone, firstName, lastName, verified: false, preferredLanguage, utm, launchOptIn });
    return {
      success: true,
      onboard_token: sessionRow.token,
      profile_created: profileResult.ok,
      message: 'Verification code sent to your email.'
    };
  } catch (err) {
    await logWebOnboardFailure(err, '/api/onboard', { email, phone, stage: 'onboard' });
    return reply.status(500).send({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

fastify.post('/api/onboard/check', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
  // v1.59.2 — live signup availability: the website checks the email and number
  // as the user types so the Continue button stays greyed until both are free.
  // Anti-enumeration: a tight per-route rate limit; answers are per-field only.
  const body = request.body || {};
  const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 120) : null;
  const phoneRaw = typeof body.phone === 'string' ? body.phone.trim().slice(0, 20) : null;
  if (!emailRaw && !phoneRaw) {
    return reply.status(400).send({ success: false, error: 'Provide an email or a phone number.' });
  }
  if (emailRaw && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(emailRaw)) {
    return reply.status(400).send({ success: false, error: 'A valid email is required.' });
  }
  if (!supabase) return reply.status(200).send({ success: false });
  try {
    const result = await checkSignupAvailability(supabase, { email: emailRaw, phone: phoneRaw });
    if (!result.ok) return reply.status(200).send({ success: false });
    return { success: true, email: result.email, phone: result.phone, verified: result.verified };
  } catch (err) {
    console.warn('[WebOnboard] availability check failed:', err.message);
    return reply.status(200).send({ success: false });
  }
});

fastify.post('/api/onboard/verify', async (request, reply) => {
  const { onboard_token, code } = request.body || {};
  if (!onboard_token || !/^\d{6}$/.test(String(code || ''))) {
    return reply.status(400).send({ success: false, error: 'A valid session token and 6-digit code are required.' });
  }
  if (!supabase) return reply.status(503).send({ success: false, error: 'Database unavailable. Please try again shortly.' });

  try {
    const result = await verifyWebOnboardCode(supabase, { token: onboard_token, code: String(code) });
    if (!result.ok) return reply.status(400).send({ success: false, error: result.error || 'Invalid or expired code.' });

    // v1.40.0 — proactive welcome: Saka messages the user instead of waiting
    // for them to message Saka. Template first (business-initiated, needs an
    // approved template), then a plain-text attempt (works inside Meta's
    // 24-hour window, rejected harmlessly outside it). The website's wa.me
    // deep link remains as the guaranteed channel.
    let firstName = '';
    try {
      const { data: profileRow } = await supabase.from('profiles').select('full_name').eq('phone_number', result.phone).maybeSingle();
      firstName = String(profileRow?.full_name || '').split(' ')[0] || '';
    } catch { /* name lookup is best-effort */ }

    const templateName = process.env.META_WELCOME_TEMPLATE_NAME;
    if (templateName && result.phone) {
      sendMetaWhatsAppTemplate(result.phone, templateName, {
        // The approved template MUST use {{1}} for the first name; the parameter is always
        // sent (fallback "there") so a nameless profile can never break the dispatch.
        components: [{ type: 'body', parameters: [{ type: 'text', text: firstName || 'there' }] }]
      }).catch((err) => console.warn('[WebOnboard] Welcome template failed:', err.message));
    } else if (result.phone) {
      sendMetaWhatsAppMessage(result.phone, webOnboardWelcomeText(firstName))
        .then((metaRes) => {
          if (metaRes?.error) console.warn('[WebOnboard] Plain welcome not delivered (expected outside the 24h window):', JSON.stringify(metaRes.error).slice(0, 200));
        })
        .catch((err) => console.warn('[WebOnboard] Plain welcome dispatch failed:', err.message));
    }

    return { success: true, message: 'Email verified. Welcome to Saka Fleet!' };
  } catch (err) {
    await logWebOnboardFailure(err, '/api/onboard/verify', { token: String(onboard_token).slice(0, 8), stage: 'verify' });
    return reply.status(500).send({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

fastify.post('/api/onboard/resend', async (request, reply) => {
  const { onboard_token } = request.body || {};
  if (!onboard_token) return reply.status(400).send({ success: false, error: 'A session token is required.' });
  if (!supabase) return reply.status(503).send({ success: false, error: 'Database unavailable. Please try again shortly.' });

  try {
    const result = await resendWebOnboardCode(supabase, { token: onboard_token });
    if (!result.ok) {
      const status = result.retryAfterSeconds ? 429 : 400;
      return reply.status(status).send({ success: false, error: result.error, retry_after: result.retryAfterSeconds || null });
    }

    try {
      await sendEmailOtp(result.email, result.code);
    } catch (emailErr) {
      await logWebOnboardFailure(emailErr, '/api/onboard/resend', { email: result.email, stage: 'resend_dispatch' });
      return reply.status(502).send({ success: false, error: 'The verification email could not be sent. Please try again.' });
    }
    return { success: true, message: 'A new code is on its way.' };
  } catch (err) {
    await logWebOnboardFailure(err, '/api/onboard/resend', { token: String(onboard_token).slice(0, 8), stage: 'resend' });
    return reply.status(500).send({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// v1.58.26 — public launch-campaign status for the website banner. No PII, no
// secrets; fail-closed (a DB error hides the campaign rather than promising an
// award that cannot be granted). Cached in the service for 60 s.
fastify.get('/api/onboard/launch-status', async (_request, reply) => {
  try {
    const status = await getLaunchAwardStatus({ supabase });
    return {
      success: true,
      launch_active: status.active,
      slots_left: status.slotsLeft,
      slots_total: status.slotsTotal,
      award_days: status.awardDays
    };
  } catch {
    return reply.status(200).send({ success: true, launch_active: false, slots_left: 0, slots_total: 0, award_days: 0 });
  }
});

// v1.40.0 — housekeeping: expired OTP sessions are pruned at boot and every
// 15 minutes (they are dead weight and a stale verification surface).
setInterval(() => {
  pruneExpiredWebOnboardOtps(supabase).catch((err) => console.warn('[WebOnboard] prune sweep failed:', err.message));
}, 15 * 60 * 1000);

// v1.74.0 — Phase 13 dashboard. Routes answer a generic 404 while
// DASHBOARD_ENABLED is off (A1). The sweep removes dead links one day after
// they expire and sessions past their 30-day window.
await registerDashboardRoutes(fastify, { supabase });
setInterval(() => {
  pruneExpiredDashboardSessions(supabase).catch((err) => console.warn('[Dashboard] prune sweep failed:', err.message));
}, 15 * 60 * 1000);

// v1.58.15 - daily document + telemetry retention sweeps.
setInterval(() => {
  pruneOldReceipts(supabase).catch((err) => console.warn('[Receipts] retention sweep failed:', err.message));
  pruneOcrTelemetry(supabase).catch((err) => console.warn('[OCR] telemetry sweep failed:', err.message));
}, 24 * 60 * 60 * 1000);

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
    const todayStr = formatNairobiDate(now);
    const nairobiWeekday = new Date(`${todayStr}T00:00:00Z`).getUTCDay();

    // Group vehicles by owner
    const { data: vehicles, error } = await supabase
      .from('vehicles')
      .select(`
        id,
        plate_number,
        make_model,
        owner_id,
        audit_report_frequency,
        profiles!vehicles_owner_id_fkey (phone_number, full_name, country_code)
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
      else if (freq === 'weekly' && nairobiWeekday === 0) shouldSend = true;

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
      const globalCtx = buildGlobalContext(detectCountryFromPhone(phone), ownerData.profile || null);
      const cur = globalCtx.currency;
      const loc = globalCtx.locale;
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
          .gte('logged_at', `${todayStr}T00:00:00+03:00`);

        const vEarn = earnings ? earnings.reduce((sum, e) => sum + Number(e.revenue_amount), 0) : 0;
        fleetTotalEarnings += vEarn;

        // Expenses
        const { data: expenses } = await supabase
          .from('expense_logs')
          .select('amount, fuel_liters')
          .eq('vehicle_id', v.id)
          .gte('created_at', `${todayStr}T00:00:00+03:00`);

        const vExp = expenses ? expenses.reduce((sum, e) => sum + Number(e.amount), 0) : 0;
        const vFuel = expenses ? expenses.reduce((sum, e) => sum + Number(e.fuel_liters || 0), 0) : 0;
        
        fleetTotalExpenses += vExp;
        fleetTotalFuel += vFuel;

        recentOps.push({ type: `Earnings: ${v.plate_number}`, value: formatMoney(vEarn, cur, loc), created_at: todayStr });
        recentOps.push({ type: `Expenses: ${v.plate_number}`, value: formatMoney(vExp, cur, loc), created_at: todayStr });
      }

      const reportData = {
        plateNumber: 'All Registered Assets',
        reportType: 'Asset Auto-Audit',
        assignedDriver: ownerData.profile?.full_name || 'Asset Owner',
        fuelLiters: fleetTotalFuel.toFixed(2),
        totalCost: fleetTotalExpenses.toFixed(2),
        burnRate: 'N/A',
        status: `Earnings: ${formatMoney(fleetTotalEarnings, cur, loc)} | Net: ${formatMoney(fleetTotalEarnings - fleetTotalExpenses, cur, loc)}`,
        reminders: [],
        recentOperations: recentOps
      };

      try {
        const pdfBuffer = await generateFleetReport(reportData);
        const reportUrl = await uploadReportToSupabase(supabase, pdfBuffer, `Fleet_${Date.now()}`);
        const shortReportUrl = await shortenUrl(supabase, reportUrl);
        const msg = `📊 Your Fleet Auto-Audit Report is ready.\n\nNet Earnings Today: ${formatMoney(fleetTotalEarnings - fleetTotalExpenses, cur, loc)}\nView PDF: ${shortReportUrl}`;
        // v1.63.1 — Phase 1 completion: window-safe proactive kind (fallback text above is byte-identical).
        await sendMetaWhatsAppMessage(phone, msg, 'fleet_auto_audit', { net: formatMoney(fleetTotalEarnings - fleetTotalExpenses, cur, loc) });
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
  const nairobiHour = (now.getUTCHours() + 3) % 24;
  const todayKey = formatNairobiDate(now);
  // Run at 20:00 Africa/Nairobi (canonical TZ), once per Nairobi calendar day
  if (nairobiHour === 20 && lastAuditRunDay !== todayKey) {
    lastAuditRunDay = todayKey;
    processAutoAudits();
  }
}, 30 * 60 * 1000); // check every 30 minutes

fastify.post('/api/cron/auto-audits', async (request, reply) => {
  await processAutoAudits();
  return { success: true, message: 'Auto-audit scan executed manually.' };
});

// v1.58.5 — bi-weekly Sentinel deep audit (Mon & Thu @ 03:00 Africa/Nairobi).
// Deterministic code-integrity scan → PENDING_APPROVAL PROP-* proposals. The
// run marker (admin_audit_logs) makes it idempotent per Nairobi day.
let lastDeepAuditSlot = null;
setInterval(() => {
  if (!isDeepAuditEnabled()) return;
  const { weekdays, nairobiHour } = parseDeepAuditSchedule();
  const now = new Date();
  const nairobiDate = formatNairobiDate(now);
  const hourNow = (now.getUTCHours() + 3) % 24;
  const weekday = new Date(`${nairobiDate}T00:00:00Z`).getUTCDay();
  if (!weekdays.has(weekday) || hourNow !== nairobiHour || now.getUTCMinutes() > 5) return;
  const slot = `${nairobiDate}-${nairobiHour}`;
  if (lastDeepAuditSlot === slot) return;
  lastDeepAuditSlot = slot;
  runDeepAudit(supabase).catch((err) => {
    console.warn('[DeepAudit] run failed:', err.message);
  });
}, 60 * 1000);

fastify.post('/api/cron/deep-audit', async (request, reply) => {
  const result = await runDeepAudit(supabase, { force: true });
  return { success: true, deep_audit: result };
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
}, 5 * 60 * 1000); // Run friction evaluation every 5 minutes

// Sentinel Real-Time Conversation Recovery Loop — rescues users stalled mid-quiz.
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

// Conversation evals (v1.60.0 / v1.61.3): DeepEval-style judge over live chat
// exchanges + friction transcripts + the offline corpus. Kill-switched by
// CONV_EVAL_ENABLED; healing is separately gated and prompt-hint-only.
// v1.61.4 — the first tick runs 60 s after boot (a deploy/restart can never
// leave the loop idle), and the resolved config is logged once so "is it
// delivering?" is answerable from the logs alone.
const convEvalBootConfig = getConvEvalConfig();
console.log(`[ConversationEval] enabled=${String(process.env.CONV_EVAL_ENABLED || 'off')} heal=${String(process.env.CONV_EVAL_HEAL_ENABLED || 'off')} intervalMs=${convEvalBootConfig.intervalMs} maxCases=${convEvalBootConfig.maxCases} judge=${convEvalBootConfig.judgeProvider}`);
let convEvalTickInFlight = false;
const runConvEvalGuarded = () => {
  if (convEvalTickInFlight) return;
  convEvalTickInFlight = true;
  runConvEvalTick(supabase)
    .then((result) => {
      if (result?.skipped) console.log(`[ConversationEval] tick skipped: ${result.skipped}`);
      else console.log(`[ConversationEval] tick done: ${result.total} case(s), ${result.passed} passed, ${result.failed} failed, ${result.errored} errored, ${result.healed?.length || 0} healed, ${result.calibration_skipped || 0} calibration skipped, ${result.rejudged || 0} re-judged`);
    })
    .catch((err) => console.warn('[Conversation Eval Warning]:', err.message))
    .finally(() => {
      convEvalTickInFlight = false;
    });
};
setTimeout(runConvEvalGuarded, 60 * 1000);
setInterval(runConvEvalGuarded, convEvalBootConfig.intervalMs);

// v1.61.12 — the ONLY eval notification: one detailed email every
// CONV_EVAL_DIGEST_HOURS (default 6), announced by ONE WhatsApp ping. Heals and
// failures never ping on their own; judge-error alerts stay immediate.
if (convEvalBootConfig.digestHours > 0) {
  let digestInFlight = false;
  const runEvalDigestGuarded = () => {
    if (digestInFlight) return;
    digestInFlight = true;
    sendEvalDigest({ supabase, hours: convEvalBootConfig.digestHours })
      .then((result) => {
        if (result?.sent) {
          console.log(`[ConversationEval] digest sent: ${result.digest?.total || 0} case(s), ${result.digest?.healedCount || 0} healed, email=${result.emailed} whatsapp=${result.pinged}`);
        } else if (result?.reason === 'email_failed') {
          console.warn(`[ConversationEval] digest email FAILED (${result.digest?.total || 0} case(s) pending) — retrying in ${result.retryMinutes || 15} min`);
        } else {
          console.log(`[ConversationEval] digest skipped: ${result?.reason || 'unknown'}`);
        }
      })
      .catch((err) => console.warn('[ConversationEval] digest failed:', err.message))
      .finally(() => { digestInFlight = false; });
  };
  setTimeout(runEvalDigestGuarded, 3 * 60 * 1000);
  setInterval(runEvalDigestGuarded, convEvalBootConfig.digestHours * 60 * 60 * 1000);
}

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

// v1.65.0 (5A/3) - the GET verification handshake now lives with the rest of the
// webhook in src/routes/whatsapp/webhook.js; these wrappers pass the app instance.
fastify.get('/webhook', (request, reply) => handleWhatsAppWebhookVerification(request, reply, fastify));
fastify.get('/webhook/whatsapp', (request, reply) => handleWhatsAppWebhookVerification(request, reply, fastify));
fastify.get('/api/whatsapp/webhook', (request, reply) => handleWhatsAppWebhookVerification(request, reply, fastify));

async function handleWhatsAppWebhook(request, reply) {
  return handleWhatsAppWebhookRoute(request, reply, fastify);
}

fastify.post('/webhook', handleWhatsAppWebhook);
fastify.post('/webhook/whatsapp', handleWhatsAppWebhook);
fastify.post('/api/whatsapp/webhook', handleWhatsAppWebhook);

// v1.58.10 — inbound support email (Resend inbound) → relay to the user's
// WhatsApp. Optional shared-secret gate via EMAIL_INBOUND_SECRET.
fastify.post('/webhook/email/inbound', async (request, reply) => {
  const signingSecret = process.env.EMAIL_INBOUND_SIGNING_SECRET || null;
  const legacySecret = process.env.EMAIL_INBOUND_SECRET;
  if (!signingSecret && legacySecret && request.headers['x-saka-inbound'] !== legacySecret) {
    return reply.status(403).send({ error: 'forbidden' });
  }
  const rawBody = request.rawBody || (typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {}));
  const payload = request.body && typeof request.body === 'object' ? request.body : {};
  const carePhone = process.env.CUSTOMER_CARE_PHONE || process.env.SUPERADMIN_PHONE || null;
  const result = await handleInboundEmail(supabase, { payload, headers: request.headers, rawBody, secret: signingSecret, notify: sendProactiveWhatsApp, notifyPhone: carePhone })
    .catch((err) => ({ ok: false, reason: err.message }));
  if (result.rejected) return reply.status(401).send({ success: false, result });
  const email = result.email || {};
  // v1.80.0 (Phase 19) — when Amina handled the mail (resolved or escalated) or
  // it was a human's internal reply, the legacy self-relay is skipped: the
  // customer already got the right answer, and nobody receives their own text.
  const handledByCareTeam = Boolean(result.ai && result.ai.handled) || result.internalReply === true;
  const relay = handledByCareTeam
    ? { ok: true, skipped: result.internalReply ? 'internal-reply' : 'ai-handled' }
    : await handleInboundSupportEmail(supabase, { fromEmail: email.fromEmail, subject: email.subject, text: result.textBody || email.subject || null, sendWhatsApp: sendMetaWhatsAppMessage })
      .catch(() => ({ ok: false }));
  return { success: true, result, relay };
});

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
    await ensureTrialSchemaDefaults();
    await ensureAiUsageLogsTable(supabase);
    await ensureTurnLatencyTable(supabase);
    await ensureAiModelRegistryTables(supabase);
    // v1.60.0 — conversation evals: detect the tracking table (rule 50). A
    // missing table never blocks boot; `npm run migrate:conv-eval` applies it.
    const convEvalTable = await ensureConvEvalTable(supabase);
    if (convEvalTable.table !== 'exists') {
      console.warn(`[ConversationEval] tracking table ${convEvalTable.table} — run npm run migrate:conv-eval (evals still run, results are not persisted).`);
    }
    await ensureSubscriptionSchema({ label: 'boot.ensureSubscriptionSchema' });
    installAiUsageSink(supabase);
    installAiBudgetGuard(supabase);
    await installModelRuntime(supabase);
    await ensureVehicleTableColumns(supabase);
    // v1.89.0 (Phase 27C) — country_kb.stt_locale boot mirror (idempotent).
    await ensureCountrySttLocaleColumn().catch((err) => {
      console.warn('[boot] country_kb.stt_locale ensure failed:', err?.message || err);
    });
    await ensureFuelEconomySchema(supabase);
    await ensureEarningTypeSchema(supabase);
    await ensureShortLinksTable(supabase);
    // v1.32.4 — warm the short-link readiness probe (fire-and-forget): the very
    // first report after a deploy must not be the one that discovers a dead base.
    verifyShortLinkRoute().then((probe) => {
      if (probe.ready) console.log(`🔗 Short links verified on ${probe.base}.`);
      else console.log(`🔗 Short links parked (${probe.reason}) — messages keep the full URL.`);
    }).catch(() => {});
    await ensureOcrRequestsTable(supabase);
    await ensureReceiptsTable(supabase);
    // v1.84.0 (Phase 23) — the stored compliance-document table.
    await ensureVehicleDocumentsTable(supabase);
    await ensureComplianceCatalog({ supabase });
    await ensureChatSessionsTable(supabase);
    await ensureFeatureNoticeSchema(supabase);
    await ensureContactNudgeSchema(supabase);
    await ensureWebOnboardOtpTable(supabase);
    await ensureDashboardTable(supabase);
    await ensureLaunchAwardTable(supabase);
    pruneExpiredWebOnboardOtps(supabase).catch(() => {});
    pruneExpiredDashboardSessions(supabase).catch(() => {});

    logWebhookEnvParity();

    const port = process.env.PORT || 3000;
    await fastify.listen({ port: Number(port), host: '0.0.0.0' });
    serverStarted = true;
    console.log(`🚀 Saka Fleet Meta-Native Backend is live and listening on port ${port}`);
    // Cloud Run startup self-announcement → "LIVE" notification (v1.25.7).
    // Fires once per revision, on every deploy path (local, cline.bot, console).
    const isProduction = process.env.NODE_ENV === 'production' || process.env.K_SERVICE;
    const currentRevision = process.env.K_REVISION || process.env.COMMIT_SHA || process.env.RENDER_GIT_COMMIT;
    if (isProduction && currentRevision && process.env.SUPERADMIN_PHONE) {
      await announceRevisionLive({
        supabase,
        revision: currentRevision,
        send: (text, templateVars) => sendMetaWhatsAppMessage(process.env.SUPERADMIN_PHONE, text, 'deploy_live', templateVars)
      });
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
    console.log(`[Shutdown] ${signal} received — draining message queue (${JSON.stringify(getQueueStats())})...`);
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
