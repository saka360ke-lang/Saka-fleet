import { runHealthCheck, evaluateConversationalFriction, sendProactiveWhatsApp } from '../workers/sentinel.js';
import {
  REMEDIATION_STATUS,
  REMEDIATION_MAX_ATTEMPTS,
  buildApprovalWindow,
  dispatchExecutionForProposal,
  getConfigValue,
  setConfigValue
} from '../workers/remediation.js';
import { dispatchRepositoryEvent, isRemediationAutonomyEnabled } from './githubDispatch.js';
import { sendAdminNotificationEmail, sendEmailOtp } from './mailer.js';
import { generateText, parseJsonSafely } from './aiClient.js';
import {
  getAiUsageSummary,
  AI_USAGE_LOG_MAX_ROWS,
  AI_USAGE_MAX_WINDOW_HOURS,
  computeAiBudgetStatus,
  checkAiDailyBudget,
  getAiBudgetAlertPct
} from './aiUsageLog.js';
import { formatNairobiDate } from './dateParser.js';
// v1.72.1 (P2-6) — system_config access rides the dual-window service.
import { readConfig, writeConfig } from './systemConfigService.js';
import { CONFIG_KEY_ADMIN_WIPE_PENDING, dynamicConfigKey } from './systemConfigKeys.js';
import { formatQuickEditPreview, BUTTON_TITLE_PHRASES } from './interactiveReply.js';
// v1.96.0 — superadmin Meta template test-fire + reply-button audit (zero tokens).
import {
  runTemplateTestFire,
  formatTemplateTestReply,
  runTemplateButtonAudit,
  formatTemplateButtonDigest
} from './templateTestFire.js';
import {
  listIncidents,
  resolveIncident,
  suppressIncident,
  formatIncidentsReply,
  formatIncidentResolvedReply
} from './incidents.js';
import { getTrialFunnelStats, formatTrialStatsReply } from './trialEngine.js';
import { getLaunchAwardStats, formatLaunchStatsReply } from './launchAwards.js';
import { getTurnLatencySummary } from './turnLatency.js';
import { getOcrUsageSummary, getOcrCountryProfileStats } from './ocrTelemetry.js';
import { auditEnv, formatEnvDigest, parseEnvKeys, envTemplateKeys } from './envAudit.js';
import { listFrictionLog, formatFrictionReply, markFrictionDeployed, FRICTION_CLEARED_AFTER_HOURS } from './frictionTracker.js';
import { listInboundEmails, getInboundEmail, formatInboxReply, formatInboundEmailReply } from './inboundEmail.js';
import { getFeatureRolloutStatus, FEATURE_NOTICE_VERSION } from './featureNotice.js';
// v1.86.0 (Phase 25) — the business command center (engine counts, zero tokens).
import { buildCommandCenterMetrics, formatCommandCenterDigest } from './commandCenter.js';
import { handleConvEvalCommand } from './convEvalConsole.js';
import {
  listKbDrafts,
  approveKbRule,
  rejectKbRule,
  getKbStaleRules,
  formatKbQueueReply,
  formatKbStaleReply
} from './kbIngest.js';
import {
  applyModelRollout,
  rollbackModel,
  runModelScoutCycle,
  getModelWatchdogSummary,
  formatModelRegistryReply,
  verifyModelUpdateAgainstRegistry,
  AI_MODEL_MAX_CANARY_PCT,
  AI_MODEL_TIER_SLOTS
} from './aiModelRegistry.js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { wipeProfileForSignup } from './profileWipe.js';
import { isSuperadminPhone, isSuperadminEmail } from './superadminIdentity.js';
import crypto from 'crypto';

// v1.76.0 — the env identity check lives in superadminIdentity.js (a neutral
// module) so the dashboard can reuse it without pulling this worker's graph.
export { isSuperadminPhone, isSuperadminEmail };


export async function logAdminAudit(supabase, adminPhone, action, details = {}) {
  try {
    const { error } = await supabase.from('admin_audit_logs').insert([{
      admin_phone: adminPhone,
      action: action,
      details: details,
      created_at: new Date().toISOString()
    }]);
    if (error) console.error('[Superadmin Audit Log Error]:', error.message);
  } catch (err) {
    console.error('[Superadmin Audit Log Exception]:', err.message);
  }
}

export async function ensureSuperadminTables(supabase) {
  const tables = ['superadmin_sessions', 'coupons', 'admin_audit_logs'];
  const statusMap = {};

  for (const t of tables) {
    const { error } = await supabase.from(t).select('*').limit(1);
    if (error && error.message && error.message.includes('Could not find the table')) {
      statusMap[t] = 'missing';
    } else {
      statusMap[t] = 'exists';
    }
  }

  const missing = Object.keys(statusMap).filter(t => statusMap[t] === 'missing');
  if (hasSqlAccess()) {
    try {
      const sql = `
        CREATE TABLE IF NOT EXISTS public.superadmin_sessions (
            phone_number text PRIMARY KEY,
            is_active boolean DEFAULT false,
            last_active_at timestamp with time zone DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS public.coupons (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            code text UNIQUE,
            discount_value text,
            assigned_to_phone text,
            is_redeemed boolean DEFAULT false,
            created_by text DEFAULT 'SUPERADMIN_WHATSAPP',
            created_at timestamp with time zone DEFAULT now()
        );
        ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS discount_value text;
        ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS assigned_to_phone text;
        ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS is_redeemed boolean DEFAULT false;

        CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            admin_phone text,
            action text,
            details jsonb,
            created_at timestamp with time zone DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_coupons_code ON public.coupons(code);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON public.admin_audit_logs(admin_phone, created_at);
      `;

      await runSql(sql, { label: 'ensureSuperadminTables' });

      missing.forEach(t => { statusMap[t] = 'created'; });
    } catch (createErr) {
      console.warn('[Superadmin Table Creation Warning]:', createErr.message);
    }
  }

  return statusMap;
}

const ADMIN_INTENTS = new Set([
  'ADMIN_HELP',
  'ADMIN_REPORT', 'ADMIN_AUDIT', 'ADMIN_ALERTS',
  'ADMIN_RULES_RESET', 'ADMIN_RULES_TOGGLE', 'ADMIN_RULES_LIST',
  'ADMIN_HORIZON', 'ADMIN_PROPOSALS', 'ADMIN_BACKLOG',
  'ADMIN_REMEDIATIONS', 'ADMIN_REMEDIATION_ACCEPT', 'ADMIN_REMEDIATION_DECLINE', 'ADMIN_REMEDIATION_MODIFY', 'ADMIN_REMEDIATION_STATUS',
  'ADMIN_FRICTION', 'ADMIN_FRICTION_DONE',
  'ADMIN_UPDATE_SUGGEST', 'ADMIN_FEATURE_ADOPT',
  'ADMIN_QUICK_EDIT_PREVIEW',
  'ADMIN_TEMPLATE_TEST', 'ADMIN_TEMPLATE_BUTTONS',
  'ADMIN_AI_STATS',
  'ADMIN_CONV_EVAL',
  'ADMIN_ENV_AUDIT',
  'ADMIN_OCR_STATS',
  'ADMIN_TURN_LATENCY',
  'ADMIN_TRIAL_STATS',
  'ADMIN_ROLLOUT',
  'ADMIN_KB', 'ADMIN_KB_REVIEW', 'ADMIN_KB_APPROVE', 'ADMIN_KB_REJECT', 'ADMIN_KB_STALE',
  'ADMIN_INCIDENTS', 'ADMIN_INCIDENT_RESOLVE', 'ADMIN_INCIDENT_SUPPRESS',
  'ADMIN_MODELS', 'ADMIN_MODEL_SCOUT', 'ADMIN_MODEL_ADOPT', 'ADMIN_MODEL_ROLLBACK',
  'HEALTH_CHECK', 'GENERATE_COUPON', 'PROFILES_REPORT', 'SENTINEL_DIAGNOSE'
]);

/**
 * Only explicit admin directives may be claimed by the superadmin hub.
 * Everything else from the superadmin phone falls through to the normal
 * Saka AI conversation (multi-role coexistence).
 */
const ADMIN_DIRECTIVE_RE = /^\s*(admin\b|adminrules?\b|check\s+health\b|health\s+check\b|system\s+(status|health|diagnostics?)\b|sentinel\b|superadmin\s+(to\s+)?sentinel\b|profiles?\s+report\b|user\s+stats\b|generate\b[^\n]*\bcoupon\b|coupon\b|horizon\b|proposals?\b|health\s*$|status\s*$|update-suggest\b)/i;

export async function parseSuperadminCommand(messageText) {
  const text = messageText ? messageText.trim() : '';
  const lower = text.toLowerCase();

  // v1.86.0 (Phase 25) — the business command center (deterministic, zero
  // tokens). Checked BEFORE the help alias: "admin command" (singular) is the
  // digest, "admin commands" (plural) stays the command list.
  if (/^\s*admin\s+(?:command|bi|business|kpi)\s*$/i.test(text)) {
    return { intent: 'ADMIN_COMMAND_CENTER' };
  }

  // v1.24.2 — help aliases are deterministic. A "superadmin commands" message
  // used to fall through to the conversational AI chain and could wait minutes
  // behind provider timeouts; the command list must never cost a token.
  // v1.25.3 — accept the natural phrasings too ("list commands",
  // "list superadmin commands", "show admin commands").
  if (/^\s*(?:(?:superadmin|admin)\s+(?:commands?|help)|(?:list|show|see)\s+(?:me\s+)?(?:all\s+)?(?:superadmin\s+|admin\s+)?commands?|commands?\s+list)\s*$/i.test(text)) {
    return { intent: 'ADMIN_HELP' };
  }

  // v1.49.1 — a natural-language "Status of FIX-<code>" (or a bare FIX-/SUG- code)
  // is a deterministic single-proposal status lookup, never a registration input.
  const fixStatusMatch = text.match(/^\s*(?:admin\s+)?(?:status\s+(?:of\s+)?)?(FIX-\d{4}-\d{2}-\d{2}-\d{2}|SUG-\d{4}-\d{2}-\d{2}-\d{2})(?:\s+status)?\s*$/i);
  if (fixStatusMatch) {
    return { intent: 'ADMIN_REMEDIATION_STATUS', proposal_code: fixStatusMatch[1].toUpperCase() };
  }

  // v1.56.2 (PROP-2026-11-03-07) — plain-English governance shortcuts from the
  // superadmin resolve deterministically (zero tokens) to the remediation
  // backlog, never the Horizon feature proposals. Bare "admin proposals" stays
  // Horizon (ADMIN_PROPOSALS) further down.
  if (/^\s*(?:please\s+)?(?:what'?s|what\s+is)\s+pending\s*$/i.test(text)
      || /^\s*(?:please\s+)?(?:show\s+me|list|display|view)?\s*(?:all\s+)?(?:the\s+)?pending\s+(?:remediations?|fixes?|proposals?|fix\s+proposals?)\s*$/i.test(text)) {
    return { intent: 'ADMIN_REMEDIATIONS', filter: 'pending' };
  }
  if (/^\s*(?:please\s+)?(?:show\s+me|list|display|view)\s+(?:all\s+)?(?:the\s+)?(?:remediations?|fixes?|proposals?|fix\s+proposals?)\s*$/i.test(text)) {
    return { intent: 'ADMIN_REMEDIATIONS', filter: 'all' };
  }

  // Gate: general conversation from the superadmin phone is NOT an admin command.
  if (!ADMIN_DIRECTIVE_RE.test(text)) {
    return { intent: 'UNKNOWN' };
  }

  // v1.58.8 — OTP-gated profile wipe for a clean sign-up.
  const wipeConfirmMatch = text.match(/^\s*admin\s+wipe\s+confirm\s+([0-9]{6})\s*$/i);
  if (wipeConfirmMatch) {
    return { intent: 'ADMIN_PROFILE_WIPE_CONFIRM', code: wipeConfirmMatch[1] };
  }
  const wipeMatch = text.match(/^\s*admin\s+wipe\s+(\+?[0-9][0-9\s-]{8,})\s*$/i);
  if (wipeMatch) {
    return { intent: 'ADMIN_PROFILE_WIPE', target_phone: wipeMatch[1].trim() };
  }

  // 0. Sentinel diagnosis from chat
  if (/^\s*(?:admin\s+|superadmin\s+(?:to\s+)?)?sentinel[\s.:,_-]+(?:diagnose|diagnosis|report|scan)\b/i.test(text) ||
      /^\s*admin\s+diagnose\b/i.test(text)) {
    return { intent: 'SENTINEL_DIAGNOSE', query: text };
  }

  // 1. Direct Regex Pre-Matching for high-performance zero-latency commands
  const auditMatch = text.match(/^\s*admin\s+audit\s+(.+)$/i);
  if (auditMatch) {
    return { intent: 'ADMIN_AUDIT', query: auditMatch[1].trim() };
  }
  if (/^\s*admin\s+report\b/i.test(lower)) {
    return { intent: 'ADMIN_REPORT' };
  }
  if (/^\s*admin\s+alerts\b/i.test(lower)) {
    return { intent: 'ADMIN_ALERTS' };
  }
  if (/^\s*adminrules?\s+reset\b/i.test(lower)) {
    return { intent: 'ADMIN_RULES_RESET' };
  }
  const toggleMatch = text.match(/^\s*adminrules?\s+toggle\s+([a-zA-Z0-9_-]+)/i);
  if (toggleMatch) {
    return { intent: 'ADMIN_RULES_TOGGLE', rule_key: toggleMatch[1].trim() };
  }
  if (/^\s*adminrules?(\s+list)?\b/i.test(lower)) {
    return { intent: 'ADMIN_RULES_LIST' };
  }
  if (/^\s*admin\s+horizon\b/i.test(lower)) {
    return { intent: 'ADMIN_HORIZON' };
  }
  if (/^\s*admin\s+proposals\b/i.test(lower)) {
    return { intent: 'ADMIN_PROPOSALS' };
  }
  if (/^\s*admin\s+rollout(?:\s+status)?\s*$/i.test(lower)) {
    return { intent: 'ADMIN_ROLLOUT' };
  }

  // v1.21.1 — Country KB review queue (drafts are never live until approved).
  const kbApproveMatch = text.match(/^\s*admin\s+kb\s+approve\s+([0-9a-f][0-9a-f-]{7,})\s*$/i);
  if (kbApproveMatch) {
    return { intent: 'ADMIN_KB_APPROVE', rule_id: kbApproveMatch[1].toLowerCase() };
  }
  const kbRejectMatch = text.match(/^\s*admin\s+kb\s+reject\s+([0-9a-f][0-9a-f-]{7,})\s*$/i);
  if (kbRejectMatch) {
    return { intent: 'ADMIN_KB_REJECT', rule_id: kbRejectMatch[1].toLowerCase() };
  }
  if (/^\s*admin\s+kb\s+(?:review|queue|drafts?)\s*$/i.test(lower)) {
    return { intent: 'ADMIN_KB_REVIEW' };
  }
  if (/^\s*admin\s+kb\s+(?:stale|due|freshness|fresh)\s*$/i.test(lower)) {
    return { intent: 'ADMIN_KB_STALE' };
  }
  if (/^\s*admin\s+kb\b/i.test(lower)) {
    return { intent: 'ADMIN_KB' };
  }

  // v1.23.3 - backend incident registry commands.
  const incidentResolveMatch = text.match(/^\s*admin\s+incident\s+resolve\s+([0-9a-f][0-9a-f-]{7,})(?:\s+(.+))?$/i);
  if (incidentResolveMatch) {
    return { intent: 'ADMIN_INCIDENT_RESOLVE', incident_id: incidentResolveMatch[1].toLowerCase(), note: incidentResolveMatch[2] ? incidentResolveMatch[2].trim() : null };
  }
  const incidentSuppressMatch = text.match(/^\s*admin\s+incident\s+suppress\s+([0-9a-f][0-9a-f-]{7,})(?:\s+(.+))?$/i);
  if (incidentSuppressMatch) {
    return { intent: 'ADMIN_INCIDENT_SUPPRESS', incident_id: incidentSuppressMatch[1].toLowerCase(), note: incidentSuppressMatch[2] ? incidentSuppressMatch[2].trim() : null };
  }
  if (/^\s*admin\s+incidents?\s*$/i.test(lower)) {
    return { intent: 'ADMIN_INCIDENTS' };
  }

  // v1.24.1 - reply-speed digest (deterministic, zero LLM calls).
  const latencyMatch = text.match(/^\s*admin\s+(?:reply[\s_-]*|turn[\s_-]*)?latency(?:\s+(\d{1,3})\s*h(?:ours?|rs?)?)?\s*$/i);
  if (latencyMatch) {
    const requestedHours = latencyMatch[1] ? Number(latencyMatch[1]) : 24;
    return { intent: 'ADMIN_TURN_LATENCY', hours: Math.min(168, Math.max(1, requestedHours)) };
  }

  if (/^\s*admin\s+(?:ai[\s_-]*(?:stats?|usage|telemetry)|usage)(?:\s+(\d{1,3})\s*h(?:ours?|rs?)?)?\s*$/i.test(text)) {
    const requestedHours = Number(text.match(/(\d{1,3})\s*h(?:ours?|rs?)?/i)?.[1] || 24);
    return { intent: 'ADMIN_AI_STATS', hours: Math.min(168, Math.max(1, requestedHours)) };
  }

  // v1.60.0 — conversation eval console. `stats`/`last` are zero-token digests;
  // `run` and `heal` are explicit superadmin actions that spend judge calls.
  const convEvalMatch = text.match(/^\s*admin\s+(?:conv[\s_-]*)?evals?(?:\s+(run|last|stats|heal))?(?:\s+(\S+))?\s*$/i);
  if (convEvalMatch) {
    const mode = String(convEvalMatch[1] || 'stats').toLowerCase();
    const arg = convEvalMatch[2] || null;
    const hoursMatch = arg && arg.match(/^(\d{1,3})\s*h(?:ours?|rs?)?$/i);
    return {
      intent: 'ADMIN_CONV_EVAL',
      mode,
      case_id: mode === 'heal' ? arg : null,
      hours: hoursMatch ? Math.min(168, Math.max(1, Number(hoursMatch[1]))) : 24
    };
  }

  // v1.32.4 — env & secret parity digest (names/booleans only, zero values).
  if (/^\s*admin\s+(?:env|environment|secrets?)(?:\s+(?:audit|parity|status|check|report))?\s*$/i.test(lower)) {
    return { intent: 'ADMIN_ENV_AUDIT' };
  }

  // v1.54.2 — per-country OCR profile digest (deterministic, zero tokens).
  const ocrProfileMatch = text.match(/^\s*admin\s+ocr[-\s_]*profile(?:\s+([A-Za-z]{2}))?\s*$/i);
  if (ocrProfileMatch) {
    return { intent: 'ADMIN_OCR_PROFILE', countryCode: ocrProfileMatch[1] ? ocrProfileMatch[1].toUpperCase() : null };
  }

  // v1.32.1 — OCR request digest (deterministic, zero LLM calls).
  const ocrStatsMatch = text.match(/^\s*admin\s+ocr[\s_-]*(?:stats?|usage|requests?)(?:\s+(\d{1,3})\s*h(?:ours?|rs?)?)?\s*$/i);
  if (ocrStatsMatch) {
    const requestedHours = ocrStatsMatch[1] ? Number(ocrStatsMatch[1]) : 24;
    return { intent: 'ADMIN_OCR_STATS', hours: Math.min(168, Math.max(1, requestedHours)) };
  }

  // v1.15.0: trial funnel digest (deterministic, zero LLM calls).
  const trialStatsMatch = text.match(/^\s*admin\s+trial[\s_-]*stats?(?:\s+(\d{1,3})\s*d(?:ays?)?)?\s*$/i);
  if (trialStatsMatch) {
    const requestedDays = trialStatsMatch[1] ? Number(trialStatsMatch[1]) : 30;
    return { intent: 'ADMIN_TRIAL_STATS', days: Math.min(365, Math.max(1, requestedDays)) };
  }

  // v1.58.26: launch-award digest (deterministic, zero LLM calls).
  if (/^\s*admin\s+launch[\s_-]*stats?\s*$/i.test(text)) {
    return { intent: 'ADMIN_LAUNCH_STATS' };
  }

  // v1.17.0: Model Watchdog commands (deterministic, zero LLM calls).
  if (/^\s*admin\s+models?\s*$/i.test(lower) || /^\s*admin\s+model\s+(?:registry|status|list)\b/i.test(lower)) {
    return { intent: 'ADMIN_MODELS' };
  }
  if (/^\s*admin\s+model\s+scout\b/i.test(lower)) {
    return { intent: 'ADMIN_MODEL_SCOUT' };
  }
  const modelAdoptMatch = text.match(/^\s*admin\s+model\s+adopt\s+([a-z0-9][a-z0-9._:-]{1,79})(?:\s+(\d{1,3}))?\s*$/i);
  if (modelAdoptMatch) {
    return {
      intent: 'ADMIN_MODEL_ADOPT',
      model_id: modelAdoptMatch[1],
      traffic_split: modelAdoptMatch[2] ? Number(modelAdoptMatch[2]) : AI_MODEL_MAX_CANARY_PCT
    };
  }
  const modelRollbackMatch = text.match(/^\s*admin\s+model\s+rollback(?:\s+(tier_[123]))?\s*$/i);
  if (modelRollbackMatch) {
    return { intent: 'ADMIN_MODEL_ROLLBACK', tier_slot: modelRollbackMatch[1] || 'tier_1' };
  }

  // v1.51.0 — unified governance backlog (fixes + feature proposals).
  const backlogMatch = text.match(/^\s*admin\s+backlog\s*(pending|deployed|all)?\s*$/i);
  if (backlogMatch) {
    return { intent: 'ADMIN_BACKLOG', filter: (backlogMatch[1] || 'all').toLowerCase() };
  }

  // Autonomous remediation approval gateway (v1.10.0)
  const remediationsFilterMatch = text.match(/^\s*admin\s+remediations?\s*(pending|deployed|all)?\s*$/i);
  if (remediationsFilterMatch) {
    return { intent: 'ADMIN_REMEDIATIONS', filter: (remediationsFilterMatch[1] || 'all').toLowerCase() };
  }
  if (/^\s*admin\s+(pending|deployed)\s+(?:remediations?|fixes?|proposals?)\s*$/i.test(text)) {
    return { intent: 'ADMIN_REMEDIATIONS', filter: /pending/i.test(text) ? 'pending' : 'deployed' };
  }
  const frictionDoneMatch = text.match(/^\s*admin\s+friction\s+done\s+([0-9a-fA-F-]{6,36})\s*$/i);
  if (frictionDoneMatch) {
    return { intent: "ADMIN_FRICTION_DONE", friction_id: frictionDoneMatch[1] };
  }
  const frictionMatch = text.match(/^\s*admin\s+friction\s*(pending|deployed|log|active)?\s*$/i);
  if (frictionMatch) {
    return { intent: "ADMIN_FRICTION", filter: (frictionMatch[1] || "active").toLowerCase() };
  }
  const inboxReadMatch = text.match(/^\s*admin\s+inbox\s+read\s+([0-9a-fA-F-]{6,36})\s*$/i);
  if (inboxReadMatch) {
    return { intent: 'ADMIN_INBOX_READ', inbound_id: inboxReadMatch[1] };
  }
  if (/^\s*admin\s+inbox\s*$/i.test(text)) {
    return { intent: 'ADMIN_INBOX' };
  }

  const adoptFeatureMatch = text.match(/^\s*admin\s+adopt\s+([a-zA-Z0-9-]+)\s*$/i);
  if (adoptFeatureMatch) {
    return { intent: 'ADMIN_FEATURE_ADOPT', proposal_code: adoptFeatureMatch[1].toUpperCase() };
  }
  const acceptFixMatch = text.match(/^\s*admin\s+accept\s+fix\s+([a-zA-Z0-9-]+)(?:\s+(override))?/i);
  if (acceptFixMatch) {
    return {
      intent: 'ADMIN_REMEDIATION_ACCEPT',
      proposal_code: acceptFixMatch[1].toUpperCase(),
      override: Boolean(acceptFixMatch[2])
    };
  }
  const declineFixMatch = text.match(/^\s*admin\s+decline\s+fix\s+([a-zA-Z0-9-]+)/i);
  if (declineFixMatch) {
    return { intent: 'ADMIN_REMEDIATION_DECLINE', proposal_code: declineFixMatch[1].toUpperCase() };
  }
  const modifyFixMatch = text.match(/^\s*admin\s+modify\s+fix\s+([a-zA-Z0-9-]+)\s+([\s\S]+)$/i);
  if (modifyFixMatch) {
    return {
      intent: 'ADMIN_REMEDIATION_MODIFY',
      proposal_code: modifyFixMatch[1].toUpperCase(),
      feedback: modifyFixMatch[2].trim()
    };
  }

  // v1.48.0 — superadmin update suggestions (UPDATE-SUGGEST>) flow into the
  // remediation pipeline as PENDING_APPROVAL proposals (Model A). Superadmin-gated:
  // handleSuperadminFlow returns { isSuperadmin: false } for any other phone.
  const updateSuggestMatch = text.match(/^\s*UPDATE-SUGGEST>\s*([\s\S]*)$/i);
  if (updateSuggestMatch) {
    return { intent: 'ADMIN_UPDATE_SUGGEST', suggestion: updateSuggestMatch[1].trim() };
  }

  // v1.51.10 — SUG-2026-11-03-01 clause 7: preview the interactive quick-edit
  // card (buttons + text fallback) before the Superadmin registers it on the WABA.
  // Deterministic, zero tokens; superadmin-gated like every branch above.
  if (/^\s*admin\s+quick[- ]?edit(?:\s+preview)?\s*$/i.test(text)) {
    return { intent: 'ADMIN_QUICK_EDIT_PREVIEW' };
  }

  // v1.96.0 — Meta template operator surfaces (deterministic, zero tokens).
  // `admin tpl buttons [phone]` audits every reply button (declared ↔ mapped ↔
  // captured) for that device, defaulting to the admin's own phone; `admin tpl
  // test [kind|all] [target_phone]` fires a REAL approved template. Bare
  // `admin tpl test` prints usage (never auto-fires).
  // v1.96.3 — `admin tpl buttons` accepts an optional target phone so the audit
  // can follow a test fired at a regular device. A junk token is still parsed
  // deterministically (fail-closed, never the AI path) and refused by the runner.
  const tplButtonsMatch = text.match(/^\s*admin\s+tpl\s+buttons(?:\s+(\S+))?\s*$/i);
  if (tplButtonsMatch) {
    return { intent: 'ADMIN_TEMPLATE_BUTTONS', targetPhone: tplButtonsMatch[1] || null };
  }
  // v1.96.1 — deterministic two-token parse so a malformed test command NEVER
  // falls to the AI classifier (zero tokens, fail-closed). A phone without a
  // kind is usage (nothing is sent); an invalid target is refused by the runner.
  const tplTestMatch = text.match(/^\s*admin\s+tpl\s+test(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
  if (tplTestMatch) {
    const arg1 = String(tplTestMatch[1] || '').toLowerCase();
    const arg2 = String(tplTestMatch[2] || '');
    const arg1IsKind = arg1 === 'all' || /^[a-z_]+$/.test(arg1);
    return {
      intent: 'ADMIN_TEMPLATE_TEST',
      kind: arg1IsKind ? (arg1 || null) : null,
      targetPhone: arg1IsKind ? (arg2 || null) : (arg1 || null)
    };
  }

  const prompt = `Classify user's admin request into JSON:
Intent: "HEALTH_CHECK" | "GENERATE_COUPON" | "PROFILES_REPORT" | "ADMIN_AI_STATS" | "ADMIN_CONV_EVAL" | "ADMIN_OCR_STATS" | "ADMIN_OCR_PROFILE" | "ADMIN_TURN_LATENCY" | "ADMIN_TRIAL_STATS" | "ADMIN_ROLLOUT" | "ADMIN_REPORT" | "ADMIN_AUDIT" | "ADMIN_ALERTS" | "ADMIN_RULES_RESET" | "ADMIN_RULES_TOGGLE" | "ADMIN_RULES_LIST" | "ADMIN_HORIZON" | "ADMIN_PROPOSALS" | "ADMIN_BACKLOG" | "ADMIN_REMEDIATIONS" | "ADMIN_REMEDIATION_ACCEPT" | "ADMIN_REMEDIATION_DECLINE" | "ADMIN_REMEDIATION_MODIFY" | "ADMIN_FEATURE_ADOPT" | "UNKNOWN"
Extract: discount_value (e.g. "20%"), target_phone (e.g. "+254712345678"), query (e.g. "KDA 123A" or VIN), rule_key (e.g. "clarify_vin"), proposal_code (e.g. "FIX-2026-10-30-01"), feedback (guidance text), hours (AI/OCR telemetry window 1-168, default 24), days (trial funnel window 1-365, default 30), country_code (e.g. "KE")
Plain-English backlog: "show me [all] pending proposals" / "list pending proposals" / "pending proposals" / "what's pending" => ADMIN_REMEDIATIONS with filter "pending"; "show me [all] proposals" => ADMIN_REMEDIATIONS with filter "all" (bare "admin proposals" stays ADMIN_PROPOSALS/Horizon).
Command: "${text}"`;

  try {
    const rawText = await generateText({ prompt, jsonMode: true, maxTokens: 512, temperature: 0.2, purpose: 'admin_parse' });
    if (rawText) {
      const parsed = parseJsonSafely(rawText);
      if (parsed && parsed.intent) return parsed;
    }
  } catch (err) {
    console.warn('[Superadmin Command Parser] DeepSeek failed:', err.message);
  }

  if (/(health|sentinel|status|system|diagnostic|error logs)/i.test(lower)) return { intent: 'HEALTH_CHECK' };
  if (/(coupon|discount|generate)/i.test(lower)) {
    const discountMatch = text.match(/([0-9]+\s*%|[0-9]+\s*percent|KES\s*[0-9]+|\$[0-9]+)/i);
    const phoneMatch = text.match(/(\+?[0-9]{9,15})/);
    return {
      intent: 'GENERATE_COUPON',
      discount_value: discountMatch ? discountMatch[0].trim() : '20%',
      target_phone: phoneMatch ? phoneMatch[0].trim() : null
    };
  }
  if (/\b(reply|turn)\s+latency\b/i.test(lower)) {
    return { intent: 'ADMIN_TURN_LATENCY', hours: 24 };
  }
  if (/\bocr\s+(?:stats?|usage|requests?)\b/i.test(lower)) {
    return { intent: 'ADMIN_OCR_STATS', hours: 24 };
  }
  if (/\b(?:env|environment|secrets?)\s+(?:audit|parity)\b/i.test(lower)) {
    return { intent: 'ADMIN_ENV_AUDIT' };
  }
  if (/\b(ai[\s_-]*(?:stats?|usage|telemetry)|usage\s+stats?)\b/i.test(lower)) {
    return { intent: 'ADMIN_AI_STATS', hours: 24 };
  }
  if (/\btrial[\s_-]*stats?\b/i.test(lower)) {
    return { intent: 'ADMIN_TRIAL_STATS', days: 30 };
  }
  if (/\b(profiles?|users?|drivers?|owners?)\s+(report|stats|summary|list|count)\b/i.test(lower) || /\b(user|driver|owner|profile)\s+(stats|summary|report)\b/i.test(lower)) {
    return { intent: 'PROFILES_REPORT' };
  }
  // v1.56.2 — deterministic safety net for plain-English backlog requests.
  if (/\bpending\b/i.test(lower) && /\b(?:proposals?|fix(?:es)?|remediations?)\b/i.test(lower)) {
    return { intent: 'ADMIN_REMEDIATIONS', filter: 'pending' };
  }

  return { intent: 'UNKNOWN' };
}


/**
 * v1.78.0 (Phase 17, section 206) — raw live health telemetry, shared by the
 * `check health` command and the Admin AI Agent's `get_system_health` tool so
 * the two can never drift. One injected Sentinel scan + two count reads; the
 * scan is best-effort (a dead scan degrades to 'Executed', never throws).
 */
export async function collectHealthFacts(supabase, { healthCheck = runHealthCheck } = {}) {
  let sentinelResult = null;
  let dbStatus = 'Disconnected';
  let unresolvedCount = 0;
  let memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  let uptimeSec = Math.floor(process.uptime());

  try {
    sentinelResult = await healthCheck(supabase);
  } catch (err) {
    console.error('[Superadmin HealthCheck] Sentinel error:', err.message);
  }

  try {
    const { count, error } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
    dbStatus = !error ? 'Connected & Operational' : `Error: ${error.message}`;
  } catch (err) {
    dbStatus = `Exception: ${err.message}`;
  }

  try {
    const { count, error } = await supabase
      .from('error_logs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'unresolved');
    if (!error && count !== null) unresolvedCount = count;
  } catch (err) {
    console.error('[Superadmin HealthCheck] Error count query failed:', err.message);
  }

  const rawInfo = `
Container Status: Running (Uptime: ${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s, Memory: ${memoryMB}MB)
Database Connection: ${dbStatus}
Sentinel Health Check Status: ${sentinelResult?.status || 'Executed'}
Recent Unresolved Error Logs: ${unresolvedCount}
AI Diagnosed Errors in Last Run: ${sentinelResult?.diagnosed_count || 0}
`;

  return {
    rawInfo,
    telemetry: {
      dbStatus,
      unresolvedCount,
      memoryMB,
      uptimeSec,
      diagnosedCount: sentinelResult?.diagnosed_count || 0
    }
  };
}

export async function handleHealthCheckCommand(supabase) {
  const { rawInfo, telemetry } = await collectHealthFacts(supabase);
  const { dbStatus, unresolvedCount, memoryMB, uptimeSec, diagnosedCount } = telemetry;

  const synthesisPrompt = `You are the Saka Fleet Superadmin Sentinel Assistant.
Synthesize the following system health diagnostic telemetry into a short, well-formatted, professional WhatsApp summary for the superadmin. Include emojis and key status items (Container Status, Database Connection, Error Stats).

Diagnostic Telemetry:
${rawInfo}`;

  let summaryText = null;

  try {
    summaryText = await generateText({ prompt: synthesisPrompt, maxTokens: 900, temperature: 0.5, purpose: 'health_synthesis' });
  } catch (err) {
    console.warn('[Superadmin Synthesis] DeepSeek failed:', err.message);
  }

  if (!summaryText) {
    summaryText = `🖥️ *Saka Fleet System Sentinel Health Report*\n\n` +
      `• *Container Status*: Operational (Uptime: ${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s | Heap: ${memoryMB}MB)\n` +
      `• *Database Connection*: ${dbStatus}\n` +
      `• *Unresolved Error Logs*: ${unresolvedCount}\n` +
      `• *Sentinel AI Diagnoses*: ${diagnosedCount} errors reviewed`;
  }

  return {
    summary: summaryText,
    telemetry
  };
}

export async function handleCouponGenerationCommand(supabase, adminPhone, messageText, parsed) {
  let discountValue = parsed?.discount_value || '20%';
  let rawPhone = parsed?.target_phone;

  if (!discountValue || discountValue === 'null') {
    const match = messageText.match(/([0-9]+\s*%|[0-9]+\s*percent|KES\s*[0-9]+|\$[0-9]+)/i);
    discountValue = match ? match[0].trim() : '20%';
  }

  let formattedTargetPhone = 'ALL';
  let profileName = null;

  if (rawPhone) {
    const cleanDigits = rawPhone.replace(/[^\d]/g, '');
    if (cleanDigits.length >= 9) {
      formattedTargetPhone = rawPhone.startsWith('+') ? rawPhone : `+${cleanDigits}`;

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, phone_number')
        .eq('phone_number', formattedTargetPhone)
        .maybeSingle();

      if (profile) profileName = profile.full_name;
    }
  }

  const numPart = discountValue.replace(/[^\d]/g, '') || '20';
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  const couponCode = `SAKA-${numPart}-${randomSuffix}`;

  const couponId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  // v1.61.16 — canonical fields (live defect): the checkout validator reads
  // discount_percent / discount_amount / max_uses / status / applicable_to. The
  // old insert stored ONLY display text, so every admin coupon validated as a
  // silent 0% off, and the literal 'ALL' phone failed the ownership check for
  // every real owner. Refuse shapes the engine cannot price honestly.
  const percentMatch = String(discountValue).match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
  const usdMatch = String(discountValue).match(/^\$?\s*(\d+(?:\.\d+)?)\s*$/);
  const discountPercent = percentMatch ? Math.min(100, Math.max(0, Number(percentMatch[1]))) : 0;
  const discountAmount = !discountPercent && usdMatch ? Number(usdMatch[1]) : 0;
  if (!discountPercent && !discountAmount) {
    return {
      reply: '⚠️ *No coupon created.*\n\nGive a percentage (*generate coupon 20%*) or a USD amount (*generate coupon $5*). A local-currency flat amount would need FX pricing the engine cannot guarantee, so it is not issued.',
      details: { refused: true, discount_value: discountValue }
    };
  }
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from('coupons').insert([{
    id: couponId,
    code: couponCode,
    discount_value: discountValue,
    discount_percent: discountPercent,
    discount_amount: discountAmount,
    max_uses: 1,
    current_uses: 0,
    status: 'dispatched',
    applicable_to: 'subscription',
    applies_to_interval: 'both',
    assigned_to_phone: formattedTargetPhone === 'ALL' ? null : formattedTargetPhone,
    is_redeemed: false,
    created_by: adminPhone || 'SUPERADMIN_WHATSAPP',
    created_at: nowIso,
    expires_at: expiresAt
  }]);

  if (error) {
    throw new Error(`Failed to insert coupon into database: ${error.message}`);
  }

  const assignedDisplay = profileName
    ? `${profileName} (${formattedTargetPhone})`
    : (formattedTargetPhone !== 'ALL' ? formattedTargetPhone : 'Any User (Universal)');

  const reply = `🎟️ *Coupon Generated Successfully!*\n\n` +
    `• *Coupon Code*: \`${couponCode}\`\n` +
    `• *Discount Value*: ${discountValue}\n` +
    `• *Assigned Profile*: ${assignedDisplay}\n` +
    `• *Status*: Active & Unredeemed\n` +
    `• *Valid*: one checkout, until ${expiresAt.slice(0, 10)}`;

  return {
    reply,
    details: {
      coupon_id: couponId,
      code: couponCode,
      discount_value: discountValue,
      discount_percent: discountPercent,
      discount_amount: discountAmount,
      assigned_to_phone: formattedTargetPhone,
      expires_at: expiresAt,
      profile_name: profileName
    }
  };
}

/**
 * v1.82.0 (Phase 21) — the profiles report counts REAL accounts, never
 * auto-provisioned shells. A WhatsApp first contact creates a profile row with
 * no email and no name; such a row can never sign in, own a vehicle or verify
 * anything, yet it used to headline `admin profiles` as just another signup
 * (the +254734852529 ghost). Definitions (operator-locked):
 *   - Registered  = `email IS NOT NULL` OR the superadmin's own row.
 *   - Shell       = `email IS NULL AND full_name IS NULL` and not the superadmin.
 *   - Named rows without an email (e.g. owner-created driver profiles) are
 *     counted separately in `details.named_no_email` and stay out of the
 *     registered total and the Recent sign-ups list.
 */
export async function handleProfilesReportCommand(supabase) {
  const { data: profileRows, error: profilesError } = await supabase
    .from('profiles')
    .select('id, full_name, phone_number, country, created_at, email')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (profilesError) {
    return {
      reply: `📊 *Saka Fleet Profiles Report*\n\nI could not read profiles just now — try again in a minute.`,
      details: { error: profilesError.message }
    };
  }

  const allProfiles = Array.isArray(profileRows) ? profileRows : [];
  const isRegistered = (p) => Boolean(p.email) || isSuperadminPhone(p.phone_number);
  const registered = allProfiles.filter(isRegistered);
  const shells = allProfiles.filter((p) => !isRegistered(p) && !p.full_name);
  const namedNoEmail = allProfiles.length - registered.length - shells.length;
  const totalProfiles = registered.length;

  const { data: ownersData } = await supabase
    .from('vehicles')
    .select('owner_id')
    .is('deleted_at', null);
  const uniqueOwners = new Set((ownersData || []).map(v => v.owner_id).filter(Boolean));

  // v1.96.4 — name the gap instead of leaving it to subtraction: registered
  // profiles split into "owns >=1 live vehicle" and "no vehicle yet". This is
  // the SAME split the 08:00 briefing and the command center print, so the
  // three surfaces can never drift.
  const ownersWithVehicles = registered.filter((p) => uniqueOwners.has(p.id)).length;
  const withoutVehicles = registered.length - ownersWithVehicles;

  const { data: driversData } = await supabase
    .from('vehicles')
    .select('assigned_driver_id')
    .is('deleted_at', null);
  const uniqueDrivers = new Set((driversData || []).map(v => v.assigned_driver_id).filter(Boolean));

  const now = new Date();
  const iso24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const iso7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // v1.82.0 — signups are REGISTERED profiles only; shells never inflate them.
  const signups24h = registered.filter((p) => p.created_at && p.created_at >= iso24h).length;
  const signups7d = registered.filter((p) => p.created_at && p.created_at >= iso7d).length;
  const recentList = registered.slice(0, 5);

  let recentFormatted = 'No recent signups found.';
  if (recentList && recentList.length > 0) {
    recentFormatted = recentList.map((p, i) => {
      const dateStr = p.created_at ? p.created_at.split('T')[0] : 'N/A';
      // v1.96.4 — everyone stays listed; a profile with no live vehicle is
      // labelled instead of being silently left to subtraction.
      const assetTag = uniqueOwners.has(p.id) ? '' : ' [no vehicle yet]';
      return `${i + 1}. *${p.full_name || 'WhatsApp User'}* (${p.phone_number}) - ${p.country || 'Global'} [${dateStr}]${assetTag}`;
    }).join('\n');
  }

  const reply = `📊 *Saka Fleet Profiles Report*\n\n` +
    `• *Total Registered Profiles*: ${totalProfiles}\n` +
    `• *Owners with Vehicles*: ${ownersWithVehicles}\n` +
    `• *Registered Without Vehicles*: ${withoutVehicles}\n` +
    `• *Assigned Active Drivers*: ${uniqueDrivers.size}\n` +
    `• *Unverified Shell Profiles*: ${shells.length}\n` +
    `• *New Sign-ups (Last 24h)*: ${signups24h || 0}\n` +
    `• *New Sign-ups (Last 7d)*: ${signups7d || 0}\n\n` +
    `*Recent Sign-ups*:\n${recentFormatted}`;

  return {
    reply,
    details: {
      total_profiles: totalProfiles,
      owners_with_vehicles: ownersWithVehicles,
      without_vehicles: withoutVehicles,
      unverified_shells: shells.length,
      named_no_email: namedNoEmail,
      active_vehicle_owners: uniqueOwners.size,
      active_assigned_drivers: uniqueDrivers.size,
      signups_24h: signups24h,
      signups_7d: signups7d
    }
  };
}

function formatCount(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

function formatPercent(rate) {
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : 'n/a';
}

function formatDuration(latencyMs) {
  return Number.isFinite(latencyMs) ? `${formatCount(latencyMs)} ms` : 'n/a';
}

function formatApproxCost(value, unpricedTokens = 0) {
  if (value === null) return 'n/a';
  const amount = value === 0 ? '$0.00' : `$${value.toFixed(value >= 1 ? 2 : 4)}`;
  return unpricedTokens > 0 ? `${amount}+` : amount;
}

function formatTierLabel(tierKey) {
  if (tierKey === '0') return 'Tier 0 (deterministic)';
  if (tierKey === '1') return 'Tier 1 (router)';
  if (tierKey === '2') return 'Tier 2 (conversational)';
  if (tierKey === '3') return 'Tier 3 (reasoning)';
  return 'Untagged';
}

/**
 * Render the deterministic WhatsApp digest for admin ai-stats (v1.13.0).
 * Pure string formatting — intentionally no LLM call, so the digest costs
 * zero tokens and can never fabricate telemetry.
 */
export function formatAiStatsReply(summary, budget = null, latency = null) {
  if (!summary || summary.ok !== true) {
    return `📉 *Saka AI Telemetry*\n\nTelemetry unavailable: ${summary?.error || 'unknown error'}\n\n_Verify Supabase connectivity and the ai_usage_logs table._`;
  }

  if (summary.totalRequests === 0) {
    const loggingState = String(process.env.AI_USAGE_LOGGING_ENABLED || 'on').toLowerCase();
    const disabled = ['off', 'false', '0'].includes(loggingState);
    return `📊 *Saka AI Telemetry — Last ${summary.hours}h*\n\nNo AI calls were recorded in this window.\n\n_Telemetry is ${disabled ? 'disabled (AI_USAGE_LOGGING_ENABLED=off)' : 'enabled'}._`;
  }

  const tierLines = Object.entries(summary.byTier)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([key, bucket]) => `• ${formatTierLabel(key)}: ${formatCount(bucket.requests)} · ${formatPercent(bucket.successRate)} ok · ${formatDuration(bucket.avgLatencyMs)} · ${formatApproxCost(bucket.approxCostUsd, bucket.unpricedTokens)}`)
    .join('\n');

  const providerLines = Object.entries(summary.byProvider)
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(([key, bucket]) => `• ${key}: ${formatCount(bucket.requests)} · ${formatPercent(bucket.successRate)} ok · ${formatDuration(bucket.avgLatencyMs)} · ${formatApproxCost(bucket.approxCostUsd, bucket.unpricedTokens)}`)
    .join('\n');

  const purposeLines = Object.entries(summary.byPurpose)
    .sort((a, b) => b[1].requests - a[1].requests)
    .slice(0, 4)
    .map(([key, bucket]) => `• ${key}: ${formatCount(bucket.requests)} · ${formatPercent(bucket.successRate)} ok`)
    .join('\n');

  const capNote = summary.truncated ? ` · capped at ${formatCount(AI_USAGE_LOG_MAX_ROWS)} rows` : '';
  const budgetLine = budget && budget.enabled
    ? `• Budget: ${formatApproxCost(budget.spentUsd)} / $${budget.budgetUsd.toFixed(2)} (${(budget.pct * 100).toFixed(1)}%${budget.overBudget ? ' — cap reached' : ''})\n`
    : '';

  return `🤖 *Saka AI Telemetry — Last ${summary.hours}h*\n\n` +
    `*Totals*\n` +
    `• Requests: ${formatCount(summary.totalRequests)} (✅ ${formatCount(summary.okRequests)} · ❌ ${formatCount(summary.errorRequests)})\n` +
    `• Success: ${formatPercent(summary.successRate)} · Errors: ${formatPercent(summary.errorRate)}\n` +
    `• Fallbacks: ${formatCount(summary.fallbacks || 0)}\n` +
    (latency && latency.ok === true && latency.turns > 0
      ? `• Conversation replies: p50 ${formatReplyDuration(latency.p50Ms)} · p95 ${formatReplyDuration(latency.p95Ms)} over ${formatCount(latency.turns)} turns\n`
      : '') +
    `• Latency: avg ${formatDuration(summary.avgLatencyMs)} · p50 ${formatDuration(summary.p50LatencyMs)}\n` +
    `• Tokens: ${formatCount(summary.promptTokens)} in / ${formatCount(summary.completionTokens)} out\n` +
    `• Est. cost: ${formatApproxCost(summary.approxCostUsd, summary.unpricedTokens)} (approx list price)\n` +
    (Number.isFinite(summary.approxCostSavedUsd) && summary.approxCostSavedUsd > 0
      ? `• Off-peak savings: ${formatApproxCost(summary.approxCostSavedUsd)} (DeepSeek half-price window)\n`
      : '') +
    budgetLine +
    `\n` +
    `*By Tier*\n${tierLines || '• none'}\n\n` +
    `*By Provider*\n${providerLines || '• none'}\n\n` +
    `*Top Purposes*\n${purposeLines || '• none'}\n\n` +
    `_Window: ${summary.hours}h${capNote} · retention cap ${formatCount(AI_USAGE_LOG_MAX_ROWS)} rows_`;
}

/**
 * v1.32.1 — deterministic OCR digest (zero tokens). Global audience: the
 * per-country breakdown comes from the WhatsApp number, never a default.
 */
export function formatOcrStatsReply(summary) {
  if (!summary || summary.ok !== true) {
    return `📉 *Saka OCR Stats*\n\nTelemetry unavailable: ${summary?.error || 'unknown error'}\n\n_Verify Supabase connectivity and the ocr_requests table._`;
  }
  if (summary.total === 0) {
    return `📊 *Saka OCR Stats — Last ${summary.hours}h*\n\nNo document reads were recorded in this window.\n\n_Photos, PDFs and their outcomes are logged automatically._`;
  }
  const statusLines = Object.entries(summary.byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `• ${key}: ${formatCount(count)}`)
    .join('\n');
  const kindLines = Object.entries(summary.byKind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `• ${key}: ${formatCount(count)}`)
    .join('\n');
  const countryLines = Object.entries(summary.byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `• ${key}: ${formatCount(count)}`)
    .join('\n');
  const confidence = summary.avgConfidence === null ? 'n/a' : `${(summary.avgConfidence * 100).toFixed(1)}%`;
  const latency = summary.avgLatencyMs === null ? 'n/a' : formatReplyDuration(summary.avgLatencyMs);
  const failures = (summary.byStatus.failed || 0) + (summary.byStatus.pdf_scanned || 0) + (summary.byStatus.unsupported || 0);
  return `📸 *Saka OCR Stats — Last ${summary.hours}h*\n\n` +
    `• Reads: ${formatCount(summary.total)} · ❌ unusable: ${formatCount(failures)}\n` +
    `• Avg confidence: ${confidence} · Avg latency: ${latency}\n\n` +
    `*Outcomes*\n${statusLines}\n\n` +
    `*Documents*\n${kindLines || '• none'}\n\n` +
    `*Countries*\n${countryLines || '• none'}\n\n` +
    `_Deterministic digest · zero tokens · Vision calls only via ocrService._`;
}

/**
 * v1.54.2 — deterministic per-country OCR profile digest (zero tokens).
 * The watch line is the data-driven signal for writing the NEXT country
 * parsing profile — never pushing one country's rules globally (rule 36).
 */
export function formatOcrProfileReply(stats) {
  if (!stats || stats.ok !== true) {
    return `🌍 *Saka OCR Profile*\n\nTelemetry unavailable: ${stats?.error || 'unknown error'}\n\n_Try \`admin ocr-profile KE\` — the country code comes from the WhatsApp number._`;
  }
  const code = String(stats.countryCode || '').toUpperCase() || 'GLOBAL';
  if (stats.total === 0) {
    return `🌍 *OCR Profile — ${code}*\n\nNo document reads recorded for this country in the last ${stats.hours}h.\n\n_Reads are logged automatically from photos and PDFs._`;
  }
  const kindLines = Object.entries(stats.byKind || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, count]) => `• ${key}: ${count}`)
    .join('\n');
  const confidence = stats.avgConfidence === null ? 'n/a' : `${(stats.avgConfidence * 100).toFixed(1)}%`;
  const watchLine = stats.watch
    ? `⚠️ *Watch:* ${stats.reason} (${stats.failed} unusable / ${stats.lowConfidence} low-confidence of ${stats.total}) — this country is a candidate for a parsing profile.`
    : '✅ *Healthy:* reads are parsing well for this country.';
  return `🌍 *OCR Profile — ${code} (${stats.hours}h)*\n\n` +
    `• Reads: ${stats.total} · ❌ unusable: ${stats.failed} · 🟡 low-confidence: ${stats.lowConfidence}\n` +
    `• Avg confidence: ${confidence}\n\n` +
    `*Documents*\n${kindLines || '• none'}\n\n` +
    `${watchLine}\n\n` +
    `_Deterministic · zero tokens · country resolved from the WhatsApp number (rule 36)._`;
}

/** Superadmin OCR country-profile command handler (v1.54.2). */
export async function handleOcrProfileCommand(supabase, countryCode = null) {
  const stats = await getOcrCountryProfileStats(supabase, { countryCode: countryCode || 'GLOBAL', hours: 168 });
  return {
    reply: formatOcrProfileReply(stats),
    details: {
      hours: stats.hours,
      ok: stats.ok,
      country_code: stats.countryCode || countryCode || 'GLOBAL',
      total: stats.total,
      failed: stats.failed,
      low_confidence: stats.lowConfidence,
      avg_confidence: stats.avgConfidence,
      watch: stats.watch,
      reason: stats.reason,
      error: stats.error
    }
  };
}

/** Superadmin OCR stats command handler (v1.32.1). */
export async function handleOcrStatsCommand(supabase, hours = 24) {
  const summary = await getOcrUsageSummary(supabase, hours);
  return {
    reply: formatOcrStatsReply(summary),
    details: {
      hours: summary.hours,
      ok: summary.ok,
      total: summary.total,
      by_status: summary.byStatus,
      by_kind: summary.byKind,
      by_country: summary.byCountry,
      avg_confidence: summary.avgConfidence,
      avg_latency_ms: summary.avgLatencyMs,
      error: summary.error
    }
  };
}

/**
 * Human-friendly reply duration (v1.24.1): milliseconds below a second,
 * seconds with one decimal above it.
 */
export function formatReplyDuration(latencyMs) {
  if (!Number.isFinite(latencyMs)) return 'n/a';
  if (latencyMs < 1000) return `${Math.round(latencyMs)} ms`;
  return `${(latencyMs / 1000).toFixed(1)} s`;
}

/**
 * Render the deterministic reply-speed digest (v1.24.1). Zero tokens.
 * The 4s p95 line is the documented trigger for the two-lane worker (§62.3).
 */
export function formatTurnLatencyReply(summary) {
  if (!summary || summary.ok !== true) {
    return `📉 *Saka Reply Speed*\n\nMetrics unavailable: ${summary?.error || 'unknown error'}\n\n_Verify Supabase connectivity and the turn_latency_logs table._`;
  }
  if (summary.turns === 0) {
    return `⏱️ *Saka Reply Speed — Last ${summary.hours}h*\n\nNo replies measured yet.\n\n_Every answered turn records its latency automatically._`;
  }
  const p95 = Number.isFinite(summary.p95Ms) ? summary.p95Ms : null;
  const verdict = p95 !== null && p95 >= 4000
    ? 'Tail is slow (p95 ≥ 4s) — the two-lane background worker is worth building.'
    : 'Healthy: the slow tail stays under 4 seconds.';
  const ackLine = summary.ackRate === null ? 'n/a' : `${(summary.ackRate * 100).toFixed(0)}%`;
  // v1.24.3 — name the slow phase instead of guessing.
  const phaseLabels = { setup: 'setup', preAi: 'pre-AI', ai: 'AI', postAi: 'post-AI' };
  const phaseParts = summary.avgPhaseMs
    ? Object.keys(phaseLabels).filter((key) => Number.isFinite(summary.avgPhaseMs[key]))
    : [];
  const phaseLine = phaseParts.length
    ? `• Phases (avg): ${phaseParts.map((key) => `${phaseLabels[key]} ${formatReplyDuration(summary.avgPhaseMs[key])}`).join(' · ')}\n`
    : '';
  return `⏱️ *Saka Reply Speed — Last ${summary.hours}h*\n\n` +
    `• Turns measured: ${formatCount(summary.turns)}\n` +
    `• Typical (p50): ${formatReplyDuration(summary.p50Ms)}\n` +
    `• Slow tail (p95): ${formatReplyDuration(summary.p95Ms)} · worst (p99): ${formatReplyDuration(summary.p99Ms)}\n` +
    `• Average: ${formatReplyDuration(summary.avgMs)}\n` +
    phaseLine +
    `• Instant ack: ${ackLine} of turns\n\n` +
    `_${verdict}_`;
}

/**
 * Superadmin trial funnel command handler (v1.15.0). Deterministic; zero tokens.
 */
export async function handleTrialStatsCommand(supabase, days = 30) {
  const stats = await getTrialFunnelStats({ supabase, windowDays: days });
  return {
    reply: formatTrialStatsReply(stats),
    details: {
      window_days: stats.windowDays,
      started: stats.started,
      activated: stats.activated,
      activated_pct: stats.activationRate,
      converted: stats.converted,
      conversion_rate: stats.conversionRate,
      expired: stats.expired,
      extended: stats.extended,
      active: stats.active,
      by_tier: stats.byTier
    }
  };
}

/**
 * Superadmin launch-award digest (v1.58.26). Deterministic; zero tokens.
 * Never invents numbers: a failed read renders the honest "unavailable" line.
 */
export async function handleLaunchStatsCommand(supabase) {
  const stats = await getLaunchAwardStats({ supabase });
  return {
    reply: formatLaunchStatsReply(stats),
    details: {
      ok: stats.ok,
      enabled: stats.enabled,
      slots_total: stats.slotsTotal,
      slots_taken: stats.slotsTaken,
      slots_left: stats.slotsLeft,
      award_days: stats.awardDays
    }
  };
}

/**
 * Superadmin AI telemetry command handler (v1.13.0).
 * Returns `{ reply, details }` like every other admin command handler.
 */
export async function handleAiStatsCommand(supabase, hours = 24) {
  const [summary, latency] = await Promise.all([
    getAiUsageSummary(supabase, hours),
    getTurnLatencySummary(supabase, hours)
  ]);
  const budget = computeAiBudgetStatus(summary);
  return {
    reply: formatAiStatsReply(summary, budget, latency),
    details: {
      hours: summary.hours,
      ok: summary.ok,
      total_requests: summary.totalRequests,
      ok_requests: summary.okRequests,
      error_requests: summary.errorRequests,
      error_rate: summary.errorRate,
      fallbacks: summary.fallbacks,
      reply_p50_ms: latency.p50Ms,
      reply_p95_ms: latency.p95Ms,
      reply_turns: latency.turns,
      avg_latency_ms: summary.avgLatencyMs,
      prompt_tokens: summary.promptTokens,
      completion_tokens: summary.completionTokens,
      approx_cost_usd: summary.approxCostUsd,
      budget_usd: budget.enabled ? budget.budgetUsd : null,
      budget_pct: budget.enabled ? Number((budget.pct * 100).toFixed(2)) : null,
      over_budget: budget.overBudget === true,
      truncated: summary.truncated,
      error: summary.error || null
    }
  };
}

/**
 * Superadmin env & secret parity digest (v1.32.4). Deterministic, zero tokens.
 * Publishes names, sections and booleans ONLY — never a single value.
 */
export async function handleEnvAuditCommand(env = process.env, { templateKeys = [], label = 'Environment' } = {}) {
  const audit = auditEnv(env, { templateKeys });
  return {
    reply: formatEnvDigest(audit, { label }),
    details: {
      ok: audit.ok,
      missing_required: audit.missingRequired,
      missing_recommended: audit.missingRecommended,
      undocumented: audit.undocumented,
      placeholders: audit.placeholders,
      template_drift: audit.templateDrift,
      present_keys: audit.presentCount,
      total_keys: audit.totalKeys,
      fingerprint: audit.fingerprint
    }
  };
}

/** Read `.env.example` key names from disk (best effort; never throws). */
export function readTemplateEnvKeys(filePath = '.env.example') {
  return envTemplateKeys(filePath);
}

/**
 * Superadmin reply-speed command handler (v1.24.1). Deterministic; zero tokens.
 */
export async function handleTurnLatencyCommand(supabase, hours = 24) {
  const summary = await getTurnLatencySummary(supabase, hours);
  return {
    reply: formatTurnLatencyReply(summary),
    details: {
      hours: summary.hours,
      ok: summary.ok,
      turns: summary.turns,
      ack_turns: summary.ackTurns,
      ack_rate: summary.ackRate,
      avg_ms: summary.avgMs,
      p50_ms: summary.p50Ms,
      p95_ms: summary.p95Ms,
      p99_ms: summary.p99Ms,
      avg_phase_ms: summary.avgPhaseMs || null,
      truncated: summary.truncated,
      error: summary.error || null
    }
  };
}

/**
 * Daily AI budget alert (Phase 3, v1.14.0).
 *
 * Notification-only: enforcement happens inside the aiClient chain builder
 * (premium legs are skipped once the cap is reached). Fires once per threshold
 * per Nairobi day at AI_BUDGET_ALERT_PCT and 100%, dual-channel, audit-logged.
 * `senders` is injectable for offline tests.
 */
export async function maybeSendAiBudgetAlert(providedSupabase, { now = new Date(), dryRun = false, senders = {} } = {}) {
  const budget = await checkAiDailyBudget(providedSupabase, now);
  if (!budget.enabled) return { status: 'skipped', reason: 'AI daily budget guard is disabled.' };
  if (budget.error) return { status: 'skipped', reason: `Budget check failed: ${budget.error}` };
  if (!Number.isFinite(budget.pct)) return { status: 'skipped', reason: 'No budget percentage available.' };

  const pct = budget.pct * 100;
  const thresholds = Array.from(new Set([getAiBudgetAlertPct(), 100])).sort((a, b) => a - b);
  const crossed = thresholds.filter((threshold) => pct >= threshold);
  if (crossed.length === 0) return { status: 'skipped', reason: 'Within budget.' };

  const threshold = crossed[crossed.length - 1];
  // v1.72.1 (P2-6) — namespaced dynamic key (budget.alert.<pct>_<date>); the
  // service resolves and dual-reads the legacy ai_budget_alert_* form.
  const configKey = dynamicConfigKey(threshold, formatNairobiDate(now));
  const existing = await getConfigValue(providedSupabase, configKey);
  if (existing) return { status: 'skipped', reason: `Threshold ${threshold}% already alerted today.` };

  const lines = `💸 *Saka AI Budget ${threshold >= 100 ? 'Cap Reached' : 'Warning'}*\n\n` +
    `• Spend (24h): *$${budget.spentUsd.toFixed(2)}* of $${budget.budgetUsd.toFixed(2)} (${pct.toFixed(1)}%)\n` +
    `• Alert threshold: ${threshold}%\n` +
    (budget.unpricedTokens > 0
      ? `• Unpriced tokens: ${budget.unpricedTokens.toLocaleString('en-US')} (cost may be understated)\n`
      : '') +
    (threshold >= 100
      ? `\nPremium (Tier-2) calls now soft-fallback to DeepSeek until the rolling window clears.`
      : `\nPremium (Tier-2) routing continues; Tier-2 legs are skipped at 100%.`) +
    `\nReply \`admin ai-stats\` for the full telemetry digest.`;

  let waSent = false;
  let emailSent = false;

  if (!dryRun) {
    const sendWhatsApp = senders.whatsapp || sendProactiveWhatsApp;
    const sendEmail = senders.email || sendAdminNotificationEmail;
    waSent = await sendWhatsApp(process.env.SUPERADMIN_PHONE, lines);
    emailSent = await sendEmail(
      `💸 Saka AI budget ${threshold >= 100 ? 'cap reached' : 'warning'} (${pct.toFixed(1)}%)`,
      `<p>${lines.replace(/\n/g, '<br>')}</p>`
    );
    if (waSent || emailSent) {
      await setConfigValue(providedSupabase, configKey, now.toISOString());
    }
  }

  await logAdminAudit(providedSupabase, process.env.SUPERADMIN_PHONE || 'SUPERADMIN', 'AI_BUDGET_ALERT', {
    threshold_pct: threshold,
    spend_usd: budget.spentUsd,
    budget_usd: budget.budgetUsd,
    pct: Number(pct.toFixed(2)),
    unpriced_tokens: budget.unpricedTokens,
    wa_sent: waSent,
    email_sent: emailSent,
    dry_run: dryRun
  });

  return {
    status: 'success',
    threshold,
    pct: Number(pct.toFixed(2)),
    spentUsd: budget.spentUsd,
    budgetUsd: budget.budgetUsd,
    waSent,
    emailSent
  };
}

/**
 * v1.86.0 (Phase 25) — the business command center digest (deterministic, zero
 * tokens). ONE builder feeds this, the 08:00 briefing and /d/admin/command.
 */
export async function handleAdminCommandCenter(supabase) {
  const metrics = await buildCommandCenterMetrics({ supabase });
  const reply = formatCommandCenterDigest(metrics);
  return {
    reply,
    metrics,
    details: {
      ok: metrics.ok === true,
      active_paid: metrics.revenue?.activePaid ?? null,
      mrr_usd: metrics.revenue?.mrrUsd ?? null,
      trials_expiring_3d: metrics.revenue?.trialsExpiring3d ?? null,
      past_due: metrics.revenue?.pastDue ?? null,
      churned_30d: metrics.revenue?.churned30d ?? null,
      registered: metrics.userHealth?.registered ?? null,
      shells: metrics.userHealth?.shells ?? null,
      ai_cost_24h_usd: metrics.ai?.cost24hUsd ?? null,
      ai_cost_per_active_user_usd: metrics.ai?.costPerActiveUserUsd ?? null,
      escalated_tickets: metrics.support?.escalated ?? null,
      alerts: (metrics.alerts || []).map((alert) => alert.code)
    }
  };
}

/**
 * The morning briefing's command-center block. Mondays carry the FULL digest;
 * every other day carries the 4-line pulse (D3: no second scheduler).
 */
export async function buildBriefingPulse(supabase, { now = new Date() } = {}) {
  const metrics = await buildCommandCenterMetrics({ supabase, now });
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'short' }).format(now);
  const isMonday = weekday === 'Mon';
  return {
    metrics,
    isMonday,
    block: formatCommandCenterDigest(metrics, { full: isMonday })
  };
}

export async function handleAdminReportCommand(supabase) {
  // 1. Vehicle counts and mileage
  const { data: vehList } = await supabase
    .from('vehicles')
    .select('id, plate_number, current_mileage, odometer_reading, status')
    .is('deleted_at', null);

  const totalVehicles = vehList ? vehList.length : 0;
  const activeVehicles = vehList ? vehList.filter(v => v.status === 'ACTIVE').length : 0;
  const totalMileage = vehList
    ? vehList.reduce((sum, v) => sum + (Number(v.current_mileage || v.odometer_reading || 0)), 0)
    : 0;

  // 2. Profiles + ownership counts.
  // v1.96.4 — "Registered Profiles: 6 (2 owners, 0 drivers)" left 4 profiles
  // unexplained: the total counted every live profile row (auto-provisioned
  // shells included) while the parenthetical named only vehicle owners and
  // assigned drivers. Registered now uses the v1.82.0 definition (email on
  // file, or the superadmin's own row) and the gap is named explicitly.
  let { data: profileRows, error: profileError } = await supabase
    .from('profiles')
    .select('id, full_name, phone_number, email')
    .is('deleted_at', null)
    // TODO(pagination): 5000-row cap — page through profiles (or use a
    // server-side count) once the base outgrows it; a truncated read would
    // understate the registered total.
    .limit(5000);
  if (profileError) {
    // Rule 50 — an un-migrated profiles table still yields the counts it can.
    ({ data: profileRows } = await supabase
      .from('profiles')
      .select('id, phone_number')
      .is('deleted_at', null)
      // TODO(pagination): 5000-row cap — see above.
      .limit(5000));
  }
  const allProfiles = Array.isArray(profileRows) ? profileRows : [];
  const isRegistered = (p) => Boolean(p.email) || isSuperadminPhone(p.phone_number);
  const registeredProfiles = allProfiles.filter(isRegistered);
  const shells = allProfiles.filter((p) => !isRegistered(p) && !p.full_name).length;

  const { data: fleetRows } = await supabase
    .from('vehicles')
    .select('owner_id, assigned_driver_id')
    .is('deleted_at', null)
    // TODO(pagination): 5000-row cap — page through vehicles once the fleet
    // outgrows it; a truncated read would understate owners with vehicles.
    .limit(5000);
  const liveOwnerIds = new Set((fleetRows || []).map((v) => v.owner_id).filter(Boolean));
  const ownersWithVehicles = registeredProfiles.filter((p) => liveOwnerIds.has(p.id)).length;
  const withoutVehicles = registeredProfiles.length - ownersWithVehicles;
  const uniqueDrivers = new Set((fleetRows || []).map((v) => v.assigned_driver_id).filter(Boolean)).size;

  // 3. Financial aggregates
  // v1.72.0 (PRI-1, live bug) — the total previously summed BOTH `expenses`
  // (the legacy mirror) AND `expense_logs`, so every dual-written expense was
  // counted twice. `expense_logs` is the canonical ledger; read it only.
  //
  // v1.86.0 (Phase 25, money bug) — the digest hardcoded KES while summing
  // ledgers written in many currencies. Every figure is now grouped BY CURRENCY
  // (a currency column that does not exist degrades to the owner's own currency
  // label, never a guessed exchange rate).
  const { data: expLogs } = await supabase
    .from('expense_logs')
    .select('amount, currency');
  const { data: earnings } = await supabase
    .from('private_earnings')
    .select('revenue_amount, currency');

  const sumsByCurrency = (rows, key) => {
    const totals = {};
    for (const row of rows || []) {
      const currency = String(row?.currency || 'USD').toUpperCase();
      totals[currency] = (totals[currency] || 0) + (Number(row?.[key]) || 0);
    }
    return totals;
  };
  const expensesByCurrency = sumsByCurrency(expLogs, 'amount');
  const earningsByCurrency = sumsByCurrency(earnings, 'revenue_amount');
  const currencies = [...new Set([...Object.keys(expensesByCurrency), ...Object.keys(earningsByCurrency)])].sort();
  const totalExpenses = Object.values(expensesByCurrency).reduce((sum, value) => sum + value, 0);
  const totalEarnings = Object.values(earningsByCurrency).reduce((sum, value) => sum + value, 0);
  const currencyLines = currencies.length
    ? currencies.slice(0, 4).map((currency) => {
      const spent = expensesByCurrency[currency] || 0;
      const earned = earningsByCurrency[currency] || 0;
      return `• ${currency}: earned ${earned.toFixed(2)} · spent ${spent.toFixed(2)} · net ${(earned - spent).toFixed(2)}`;
    }).join('\n')
    : '• No ledger activity yet';

  // 4. Sentinel telemetry & system health
  const { count: unresolvedErrors } = await supabase
    .from('error_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'unresolved');

  const { count: activeRulesCount } = await supabase
    .from('saka_dynamic_rules')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  const iso24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: friction24h } = await supabase
    .from('chat_friction_logs')
    .select('*', { count: 'exact', head: true })
    .gte('detected_at', iso24h);

  // v1.96.4 — the profile line answers its own arithmetic: registered =
  // profiles with vehicles + profiles with no vehicle yet. Shells are named on
  // their own line only when they exist, exactly like the profiles report.
  const profileLines =
    `• Registered Profiles: ${registeredProfiles.length} (${ownersWithVehicles} with vehicles · ${withoutVehicles} no vehicles yet)\n` +
    (shells > 0 ? `• Unverified Shell Profiles: ${shells}\n` : '') +
    `• Assigned Drivers: ${uniqueDrivers}\n`;

  const reply = `📊 *Saka Fleet Executive Digest & System Report*\n\n` +
    `🚗 *Fleet Overview:*\n` +
    `• Total Vehicles: ${totalVehicles} (${activeVehicles} active)\n` +
    profileLines +
    `• Total Fleet Mileage: ${totalMileage.toLocaleString()} km\n\n` +
    `💰 *Financial Telemetry (by currency):*\n` +
    `${currencyLines}\n\n` +
    `🛡️ *Autonomous Sentinel & System Health:*\n` +
    `• Active Sentinel Micro-Rules: ${activeRulesCount || 0}\n` +
    `• Friction Events (Last 24h): ${friction24h || 0}\n` +
    `• Unresolved System Errors: ${unresolvedErrors || 0}\n` +
    `• Overall System Status: Operational & Healthy ✅`;

  return {
    reply,
    details: {
      total_vehicles: totalVehicles,
      active_vehicles: activeVehicles,
      total_mileage: totalMileage,
      total_profiles: registeredProfiles.length,
      profile_rows: allProfiles.length,
      registered_profiles: registeredProfiles.length,
      owners_with_vehicles: ownersWithVehicles,
      without_vehicles: withoutVehicles,
      unverified_shells: shells,
      assigned_drivers: uniqueDrivers,
      total_earnings: totalEarnings,
      total_expenses: totalExpenses,
      currencies,
      active_rules: activeRulesCount,
      unresolved_errors: unresolvedErrors
    }
  };
}


export async function handleAdminAuditCommand(supabase, queryParam) {
  if (!queryParam || !queryParam.trim()) {
    return {
      reply: '⚠️ *Admin Audit Usage:* Please specify a plate number or VIN chassis (e.g. `admin audit KDA 123A` or `admin audit 1HGCR2F83HA123456`).'
    };
  }

  const rawQuery = queryParam.trim();
  const stripped = rawQuery.replace(/\s+/g, '');

  const { data: matchedVehicles, error } = await supabase
    .from('vehicles')
    .select(`
      *,
      owner:profiles!vehicles_owner_id_fkey(full_name, phone_number, email, email_verified),
      driver:profiles!vehicles_assigned_driver_id_fkey(full_name, phone_number, driver_license_number)
    `)
    .or(`plate_number.ilike.%${rawQuery}%,vin.ilike.%${rawQuery}%,plate_number.ilike.%${stripped}%,vin.ilike.%${stripped}%`)
    .is('deleted_at', null)
    .limit(1);

  let vehicle = matchedVehicles && matchedVehicles.length > 0 ? matchedVehicles[0] : null;

  if (!vehicle) {
    const { data: allActive } = await supabase
      .from('vehicles')
      .select(`
        *,
        owner:profiles!vehicles_owner_id_fkey(full_name, phone_number, email, email_verified),
        driver:profiles!vehicles_assigned_driver_id_fkey(full_name, phone_number, driver_license_number)
      `)
      .is('deleted_at', null);

    if (allActive) {
      vehicle = allActive.find(v =>
        (v.plate_number && v.plate_number.replace(/\s+/g, '').toUpperCase() === stripped.toUpperCase()) ||
        (v.vin && v.vin.replace(/\s+/g, '').toUpperCase() === stripped.toUpperCase())
      );
    }
  }

  if (!vehicle) {
    return {
      reply: `⚠️ *Vehicle Audit Not Found*\n\nNo active vehicle matched Plate or VIN "${queryParam}". Please verify the identifier.`
    };
  }

  // v1.72.0 (P2-3) — the passbook reads the canonical ledger; the legacy
  // `expenses` mirror misses every expense_logs row.
  const { data: vExpenses } = await supabase
    .from('expense_logs')
    .select('amount, expense_type, created_at')
    .eq('vehicle_id', vehicle.id)
    .order('created_at', { ascending: false })
    .limit(5);

  const { data: vEarnings } = await supabase
    .from('private_earnings')
    .select('revenue_amount, logged_at')
    .eq('vehicle_id', vehicle.id)
    .order('logged_at', { ascending: false })
    .limit(5);

  const expSum = (vExpenses || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const earnSum = (vEarnings || []).reduce((s, e) => s + (Number(e.revenue_amount) || 0), 0);

  const customAttrsText = vehicle.custom_attributes && Object.keys(vehicle.custom_attributes).length > 0
    ? Object.entries(vehicle.custom_attributes).map(([k, v]) => `  • ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
    : '  • None specified';

  const reply = `🔍 *Saka Fleet Vehicle Audit Passbook: ${vehicle.plate_number}*\n\n` +
    `🚘 *Asset Record:*\n` +
    `• Plate Number: *${vehicle.plate_number}*\n` +
    `• VIN (Chassis): \`${vehicle.vin || 'N/A'}\` 🔒 *(Permanently Locked)*\n` +
    `• Digital Passbook Token: \`${vehicle.qr_passbook_token || 'N/A'}\`\n` +
    `• Make & Model: ${vehicle.make_model || 'N/A'} (${vehicle.yom || vehicle.year_of_manufacture || 'N/A'})\n` +
    `• Powertrain: ${vehicle.fuel_type || 'Petrol'} | Status: ${vehicle.status || 'ACTIVE'}\n` +
    `• Current Odometer: ${(vehicle.current_mileage || vehicle.odometer_reading || 0).toLocaleString()} km\n` +
    `• Transmission: ${vehicle.transmission || 'N/A'} | Color: ${vehicle.color || 'N/A'}\n` +
    `• Engine No: ${vehicle.engine_number || 'N/A'} | Tire Size: ${vehicle.tire_size || 'N/A'}\n\n` +
    `👤 *Ownership & Assignment:*\n` +
    `• Owner: ${vehicle.owner?.full_name || 'Owner'} (${vehicle.owner?.phone_number || vehicle.owner_phone || 'N/A'})\n` +
    `• Verified Email: ${vehicle.owner_email || vehicle.owner?.email || 'N/A'} (${vehicle.owner?.email_verified ? 'Verified ✅' : 'Unverified ⏳'})\n` +
    `• Assigned Driver: ${vehicle.driver ? `${vehicle.driver.full_name || 'Driver'} (${vehicle.driver.phone_number})` : 'Unassigned (Strict 1-to-1 Available)'}\n\n` +
    `🛡️ *Compliance Deadlines:*\n` +
    `• Insurance Policy: ${vehicle.insurance_policy || 'N/A'}\n` +
    `• Insurance Expiry: ${vehicle.insurance_expiry || 'Not set'}\n` +
    `• Inspection Expiry: ${vehicle.inspection_expiry || 'Not set'}\n\n` +
    `🔧 *Custom Attributes & Equipment:*\n${customAttrsText}\n\n` +
    `📊 *Recent Financials:*\n` +
    `• Recent Expenses: KES ${expSum.toFixed(2)} (${(vExpenses || []).length} logs)\n` +
    `• Recent Earnings: KES ${earnSum.toFixed(2)} (${(vEarnings || []).length} logs)`;

  return {
    reply,
    details: {
      vehicle_id: vehicle.id,
      plate_number: vehicle.plate_number,
      vin: vehicle.vin,
      token: vehicle.qr_passbook_token,
      owner_phone: vehicle.owner?.phone_number || vehicle.owner_phone,
      mileage: vehicle.current_mileage || vehicle.odometer_reading
    }
  };
}


export async function handleAdminAlertsCommand(supabase) {
  // 1. Unresolved Error Logs
  const { data: errors } = await supabase
    .from('error_logs')
    .select('id, route, error_message, created_at')
    .eq('status', 'unresolved')
    .order('created_at', { ascending: false })
    .limit(5);

  // 2. Recent Conversational Friction Events
  const { data: frictionLogs } = await supabase
    .from('chat_friction_logs')
    .select('id, user_phone, friction_type, transcript_snippet, detected_at')
    .order('detected_at', { ascending: false })
    .limit(5);

  // 3. Imminent or Overdue Compliance Reminders (next 48h or past due)
  const thresholdIso = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const { data: reminders } = await supabase
    .from('reminders')
    .select('id, reminder_type, due_date, vehicle:vehicles(plate_number)')
    .eq('status', 'active')
    .lte('due_date', thresholdIso)
    .order('due_date', { ascending: true })
    .limit(5);

  let errText = '• No unresolved system errors. All clean! ✅';
  if (errors && errors.length > 0) {
    errText = errors.map(e => `• [${e.route || 'system'}] ${(e.error_message || '').slice(0, 75)}`).join('\n');
  }

  let frictionText = '• No recent conversational friction detected. Assistant running smoothly! ✅';
  if (frictionLogs && frictionLogs.length > 0) {
    frictionText = frictionLogs.map(f => `• [${f.friction_type}] ${f.user_phone}: ${(f.transcript_snippet || '').slice(0, 65).replace(/\n/g, ' ')}`).join('\n');
  }

  let reminderText = '• All fleet compliance up to date. No imminent expirations! ✅';
  if (reminders && reminders.length > 0) {
    reminderText = reminders.map(r => `• ${r.vehicle?.plate_number || 'Fleet'}: ${r.reminder_type} due ${r.due_date}`).join('\n');
  }

  const reply = `🚨 *Saka Fleet System Alerts & Warnings*\n\n` +
    `⚠️ *Unresolved System Errors (${errors ? errors.length : 0}):*\n${errText}\n\n` +
    `🔄 *Conversational Friction Detections (${frictionLogs ? frictionLogs.length : 0}):*\n${frictionText}\n\n` +
    `⏰ *Imminent / Overdue Compliance Reminders (${reminders ? reminders.length : 0}):*\n${reminderText}`;

  return {
    reply,
    details: {
      unresolved_errors_count: errors ? errors.length : 0,
      friction_count: frictionLogs ? frictionLogs.length : 0,
      urgent_reminders_count: reminders ? reminders.length : 0
    }
  };
}

const WIPE_PENDING_KEY = CONFIG_KEY_ADMIN_WIPE_PENDING;
const WIPE_TTL_MINUTES = 10;
const WIPE_MAX_ATTEMPTS = 5;

async function readWipePending(supabase) {
  try {
    // v1.72.1 (P2-6) — dual read via the service.
    const stored = await readConfig(supabase, WIPE_PENDING_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    return parsed && parsed.code && parsed.targetPhone ? parsed : null;
  } catch { return null; }
}

async function clearWipePending(supabase) {
  try { await writeConfig(supabase, WIPE_PENDING_KEY, null); } catch { /* best effort */ }
}

/** Step 1 of the OTP-gated profile wipe: email a code to SUPERADMIN_EMAIL. */
export async function handleAdminProfileWipeInitiate(supabase, targetPhone) {
  if (!supabase) return { reply: '⚠️ Database unavailable.' };
  const email = process.env.SUPERADMIN_EMAIL;
  if (!email) return { reply: '⚠️ SUPERADMIN_EMAIL is not configured — cannot email the confirmation code.' };
  const digits = String(targetPhone || '').replace(/[^0-9]/g, '');
  if (digits.length < 9) return { reply: '⚠️ Usage: `admin wipe <phone>` — e.g. `admin wipe 0734852529`.\n\nThis erases the profile and ALL its data for a clean sign-up. It is gated by a code emailed to you.' };
  const e164 = digits.startsWith('0') ? `+254${digits.slice(1)}` : `+${digits}`;
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + WIPE_TTL_MINUTES * 60 * 1000).toISOString();
  try {
    // v1.72.1 (P2-6) — dual write via the service (a refused write is reported).
    const started = await writeConfig(supabase, WIPE_PENDING_KEY, JSON.stringify({ targetPhone: e164, code, expiresAt, attempts: 0 }));
    if (!started.ok) return { reply: `⚠️ Could not start the wipe: ${started.error}` };
  } catch (err) { return { reply: `⚠️ Could not start the wipe: ${err.message}` }; }
  try {
    await sendEmailOtp(email, code);
  } catch (err) {
    await clearWipePending(supabase);
    return { reply: `⚠️ Could not email the confirmation code: ${err.message}` };
  }
  const masked = email.replace(/^(.{2})[^@]*/, '$1…');
  return {
    reply: `🧹 *Profile wipe requested* for *${e164}*.\n\nA 6-digit confirmation code was emailed to *${masked}*. Reply \`admin wipe confirm <code>\` within ${WIPE_TTL_MINUTES} minutes to permanently erase this profile and all its data so they can sign up fresh.\n\n_If you did not request this, ignore it — nothing is wiped without the code._`
  };
}

/** Step 2: verify the emailed code, then wipe. */
export async function handleAdminProfileWipeConfirm(supabase, code) {
  if (!supabase) return { wiped: false, reply: '⚠️ Database unavailable.' };
  const pending = await readWipePending(supabase);
  if (!pending) return { wiped: false, reply: 'ℹ️ There is no pending wipe. Start one with `admin wipe <phone>`.' };
  if (new Date(pending.expiresAt).getTime() < Date.now()) {
    await clearWipePending(supabase);
    return { wiped: false, reply: '⏰ That wipe code expired. Start again with `admin wipe <phone>`.' };
  }
  if (isSuperadminPhone(pending.targetPhone)) {
    await clearWipePending(supabase);
    return { wiped: false, reply: '🛑 Refused — the target is the superadmin account.' };
  }
  const attempts = Number(pending.attempts || 0) + 1;
  if (String(code) !== String(pending.code)) {
    if (attempts >= WIPE_MAX_ATTEMPTS) {
      await clearWipePending(supabase);
      return { wiped: false, reply: '🛑 Too many wrong codes — the wipe request was cancelled. Start again if needed.' };
    }
    try {
      await writeConfig(supabase, WIPE_PENDING_KEY, JSON.stringify({ ...pending, attempts }));
    } catch { /* best effort */ }
    return { wiped: false, reply: `⚠️ That code is not correct (${attempts}/${WIPE_MAX_ATTEMPTS}). Reply \`admin wipe confirm <code>\`.` };
  }
  const result = await wipeProfileForSignup(supabase, pending.targetPhone);
  await clearWipePending(supabase);
  if (!result.ok) return { wiped: false, reply: `⚠️ Wipe failed: ${result.reason}` };
  const total = Object.values(result.counts || {}).reduce((a, b) => a + b, 0);
  return {
    wiped: true,
    phone: result.phone,
    counts: result.counts,
    reply: `✅ *Profile wiped* for *${result.phone}*.\n\n• Removed ${total} row(s) across ${Object.keys(result.counts || {}).length} table(s)\n• Vehicles removed: ${result.vehicles}\n\nThey can now sign up fresh on sakafleet.com.`
  };
}

export async function handleAdminRulesReset(supabase) {
  const { error } = await supabase
    .from('saka_dynamic_rules')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .neq('id', 0);

  if (error) {
    return { reply: `❌ Failed to reset dynamic rules: ${error.message}` };
  }

  return {
    reply: `🛑 *Sentinel Dynamic Micro-Rules Reset (Admin Kill Switch)*\n\nAll active micro-rule prompt patches have been deactivated across the platform.`
  };
}

export async function handleAdminRulesToggle(supabase, ruleKey) {
  if (!ruleKey) {
    return { reply: '⚠️ Please specify a rule key to toggle (e.g. `adminrules toggle clarify_vin_entry`).' };
  }

  const cleanKey = ruleKey.trim().toLowerCase();
  const { data: rule, error } = await supabase
    .from('saka_dynamic_rules')
    .select('*')
    .eq('rule_key', cleanKey)
    .maybeSingle();

  if (error || !rule) {
    return { reply: `⚠️ Rule key \`${cleanKey}\` was not found in saka_dynamic_rules.` };
  }

  const newStatus = !rule.is_active;
  await supabase
    .from('saka_dynamic_rules')
    .update({ is_active: newStatus, updated_at: new Date().toISOString() })
    .eq('id', rule.id);

  return {
    reply: `🔄 *Sentinel Dynamic Rule Toggled*\n\n• *Rule Key*: \`${cleanKey}\`\n• *New Status*: ${newStatus ? 'ACTIVE ✅' : 'INACTIVE ⏸️'}\n• *Instruction*: ${rule.patch_instruction}`
  };
}

export async function handleAdminRulesList(supabase) {
  const { data: rules, error } = await supabase
    .from('saka_dynamic_rules')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !rules || rules.length === 0) {
    return {
      reply: '📋 *Sentinel Dynamic Rules:* No dynamic micro-rules currently recorded in database.'
    };
  }

  const formatted = rules.map((r, i) =>
    `${i + 1}. \`${r.rule_key}\` [${r.is_active ? 'ACTIVE ✅' : 'INACTIVE ⏸️'}]\n   👉 ${r.patch_instruction}`
  ).join('\n\n');

  return {
    reply: `📋 *Saka Sentinel Dynamic Rules (${rules.length}):*\n\n${formatted}\n\n_Use \`adminrules toggle [key]\` to enable/disable or \`adminrules reset\` to deactivate all._`
  };
}

/**
 * v1.48.0 — UPDATE-SUGGEST> capture (Model A).
 * A superadmin-authored free-text update suggestion becomes a PENDING_APPROVAL
 * remediation proposal with a SUG- code. Nothing executes until the superadmin
 * approves it via `admin accept fix <CODE>`; Cline interprets the free text at
 * execution time (the CI gate applies a light keyword guard to the text).
 */
/** v1.51.3 — adopt a Sentinel Horizon feature proposal into the remediation pipeline (two-step: capture, then `admin accept fix`). */
export async function captureFeatureAdoption(supabase, adminPhone, featCode) {
  const raw = String(featCode || '').trim().toUpperCase();
  if (!/^(?:PROP|FEAT)-/.test(raw)) {
    return { ok: false, reply: '⚠️ Usage: `admin adopt PROP-<code>` — e.g. `admin adopt PROP-2026-11-03-01`.' };
  }

  const { data: feature, error: featErr } = await supabase
    .from('weekly_feature_proposals')
    .select('proposal_code,title,technical_spec,impact_score,status')
    .eq('proposal_code', raw)
    .maybeSingle();

  if (featErr) return { ok: false, reply: `⚠️ Could not load \`${raw}\`: ${featErr.message}` };
  if (!feature) return { ok: false, reply: `⚠️ Unknown feature proposal \`${raw}\`. Run \`admin backlog\` to see the list.` };
  if (String(feature.status || 'pending').toLowerCase() !== 'pending') {
    return { ok: false, reply: `ℹ️ \`${raw}\` was already adopted (status: ${feature.status || 'adopted'}).` };
  }

  const today = formatNairobiDate();
  const prefix = `PROP-${today}-`;
  const { data: existing } = await supabase
    .from('remediation_proposals')
    .select('proposal_code')
    .like('proposal_code', `${prefix}%`);
  const numbers = (existing || [])
    .map((row) => Number(String(row.proposal_code || '').replace(prefix, '')))
    .filter((value) => Number.isFinite(value));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  const proposalCode = `${prefix}${String(next).padStart(2, '0')}`;

  const overview = `${feature.title || 'Feature'}\n\n${String(feature.technical_spec || '').trim()}`.trim();
  const { data, error } = await supabase
    .from('remediation_proposals')
    .insert([{
      proposal_code: proposalCode,
      title: String(feature.title || 'Feature').slice(0, 80),
      category: 'update_suggest',
      root_cause: overview,
      proposed_changes: {
        overview,
        source: `FEAT adoption (${raw})`,
        author_phone: adminPhone,
        changes: [],
        tests: ['test_agent_training.js'],
        rollback: 'Revert the commit via git revert; no data migrations are involved.'
      },
      risk_level: Number(feature.impact_score) >= 8 ? 'medium' : 'low',
      status: REMEDIATION_STATUS.PENDING_APPROVAL,
      feedback: 'Adopted from a Sentinel Horizon feature proposal — Cline drafts the concrete scope at execution time.'
    }])
    .select('proposal_code')
    .maybeSingle();

  if (error) return { ok: false, reply: `⚠️ Could not capture the feature: ${error.message}` };

  await supabase
    .from('weekly_feature_proposals')
    .update({ status: 'adopted' })
    .eq('proposal_code', raw);

  const code = data?.proposal_code || proposalCode;
  return {
    ok: true,
    code,
    reply: `✅ *Feature adopted* — captured as \`${code}\`.\n\n` +
      `Review it with \`admin remediations\`, then approve with \`admin accept fix ${code}\`.\n\n` +
      `_Nothing runs until you approve._`
  };
}

export async function captureUpdateSuggestion(supabase, adminPhone, suggestionText) {
  const text = String(suggestionText || '').trim();
  if (!text) {
    return { ok: false, reply: '⚠️ Usage: `UPDATE-SUGGEST> <your update description>` — describe the change you want made.' };
  }

  const today = formatNairobiDate();
  const prefix = `PROP-${today}-`;
  const { data: existing } = await supabase
    .from('remediation_proposals')
    .select('proposal_code')
    .like('proposal_code', `${prefix}%`);
  const numbers = (existing || [])
    .map((row) => Number(String(row.proposal_code || '').replace(prefix, '')))
    .filter((value) => Number.isFinite(value));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  const proposalCode = `${prefix}${String(next).padStart(2, '0')}`;

  const { data, error } = await supabase
    .from('remediation_proposals')
    .insert([{
      proposal_code: proposalCode,
      title: text.length > 80 ? `${text.slice(0, 77)}…` : text,
      category: 'update_suggest',
      root_cause: text,
      proposed_changes: {
        overview: text,
        source: 'UPDATE-SUGGEST command',
        author_phone: adminPhone,
        changes: [],
        tests: ['test_agent_training.js'],
        rollback: 'Revert the commit via git revert; no data migrations are involved.'
      },
      risk_level: 'low',
      status: REMEDIATION_STATUS.PENDING_APPROVAL,
      feedback: 'Free-text superadmin suggestion — Cline drafts the concrete scope at execution time.'
    }])
    .select('proposal_code')
    .maybeSingle();

  if (error) {
    return { ok: false, reply: `⚠️ Could not capture the suggestion: ${error.message}` };
  }

  const code = data?.proposal_code || proposalCode;
  return {
    ok: true,
    code,
    reply: `✅ *Update suggestion captured* as \`${code}\`.\n\n` +
      `Review it with \`admin remediations\`, then approve with \`admin accept fix ${code}\`.\n\n` +
      `_Nothing runs until you approve._`
  };
}

/** v1.56.4 - friction-point tracker (pending/deployed + 4h auto-clear + persistent log). */
export async function handleAdminInbox(supabase) {
  const rows = await listInboundEmails(supabase, 10);
  return { reply: formatInboxReply(rows) };
}

export async function handleAdminInboxRead(supabase, id) {
  const row = await getInboundEmail(supabase, id);
  return { reply: formatInboundEmailReply(row) };
}

export async function handleAdminFriction(supabase, filter = "active") {
  const rows = await listFrictionLog(supabase, 60);
  const reply = formatFrictionReply(rows, filter === "log" ? "log" : "active");
  return { reply };
}

export async function handleAdminFrictionDone(supabase, id) {
  const result = await markFrictionDeployed(supabase, id, "Marked deployed by superadmin");
  const shortId = String(id || "none").slice(0, 8);
  return {
    reply: result.ok
      ? "Done - friction point `" + shortId + "` marked deployed. It clears from the active list after " + FRICTION_CLEARED_AFTER_HOURS + " h but stays in the log."
      : "Could not mark `" + shortId + "` deployed: " + (result.reason || "unknown") + "."
  };
}

export async function handleAdminRemediationsList(supabase, filter = 'all') {
  const { data: proposals, error } = await supabase
    .from('remediation_proposals')
    .select('proposal_code,title,status,risk_level,created_at')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    return { reply: `⚠️ Could not load remediation proposals: ${error.message}` };
  }
  if (!proposals || proposals.length === 0) {
    return {
      reply: '🛠️ *Autonomous Remediation*\n\nNo remediation proposals exist yet. Sentinel scans the rolling audit window continuously and Cline drafts plans when thresholds trigger (requires `REMEDIATION_AUTONOMY=on`).'
    };
  }

  const icons = {
    PENDING_APPROVAL: '⏳',
    APPROVED: '✅',
    EXECUTING: '⚙️',
    VALIDATED: '🧪',
    DEPLOYED: '🚀',
    DECLINED: '⛔',
    NEEDS_MODIFICATION: '✏️'
  };
  const PENDING_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'VALIDATED', 'NEEDS_MODIFICATION'];
  const bucketOf = (p) => (PENDING_STATUSES.includes(p.status) ? 'pending' : (p.status === 'DEPLOYED' ? 'deployed' : 'other'));
  const render = (list) => list.map((p) => {
    const icon = icons[p.status] || '•';
    return `${icon} \`${p.proposal_code}\` — ${p.title || 'Untitled'}\n   Status: *${p.status}* | Risk: ${String(p.risk_level || 'low').toUpperCase()}`;
  }).join('\n\n');

  const sections = [];
  if (filter === 'all' || filter === 'pending') {
    const pending = proposals.filter((p) => bucketOf(p) === 'pending');
    sections.push(`⏳ *Pending*\n${pending.length ? render(pending) : '• none'}`);
  }
  if (filter === 'all' || filter === 'deployed') {
    const deployed = proposals.filter((p) => bucketOf(p) === 'deployed');
    sections.push(`🚀 *Deployed*\n${deployed.length ? render(deployed) : '• none'}`);
  }
  if (filter === 'all') {
    const other = proposals.filter((p) => bucketOf(p) === 'other');
    if (other.length) sections.push(`⛔ *Declined/Other*\n${render(other)}`);
  }

  return {
    reply: `🛠️ *Autonomous Remediation*\n\n${sections.join('\n\n')}\n\n` +
      `_Approve:_ \`admin accept fix <CODE>\`\n` +
      `_Decline:_ \`admin decline fix <CODE>\`\n` +
      `_Modify:_ \`admin modify fix <CODE> <guidance>\`\n` +
      `_Filter:_ \`admin remediations pending\` · \`admin remediations deployed\``
  };
}

/** v1.51.0 — unified governance backlog: autonomous remediations + Horizon feature proposals. */
export async function handleAdminBacklog(supabase, filter = 'all') {
  const [remediations, features] = await Promise.all([
    supabase
      .from('remediation_proposals')
      .select('proposal_code,title,status,risk_level,created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('weekly_feature_proposals')
      .select('proposal_code,title,status,impact_score,created_at')
      .order('created_at', { ascending: false })
      .limit(5)
  ]);

  const loadError = remediations.error || features.error;
  if (loadError) {
    return { reply: `⚠️ Could not load the backlog: ${loadError.message}` };
  }

  const fixes = remediations.data || [];
  const ideas = features.data || [];

  const icons = {
    PENDING_APPROVAL: '⏳',
    APPROVED: '✅',
    EXECUTING: '⚙️',
    VALIDATED: '🧪',
    DEPLOYED: '🚀',
    DECLINED: '⛔',
    NEEDS_MODIFICATION: '✏️'
  };
  const PENDING_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'VALIDATED', 'NEEDS_MODIFICATION'];
  const bucketOf = (p) => (PENDING_STATUSES.includes(p.status) ? 'pending' : (p.status === 'DEPLOYED' ? 'deployed' : 'other'));
  const renderFix = (list) => list.map((p) => {
    const icon = icons[p.status] || '•';
    return `${icon} \`${p.proposal_code}\` — ${p.title || 'Untitled'}\n   Status: *${p.status}* | Risk: ${String(p.risk_level || 'low').toUpperCase()}`;
  }).join('\n\n');

  const sections = [];
  if (filter === 'all' || filter === 'pending') {
    const pending = fixes.filter((p) => bucketOf(p) === 'pending');
    sections.push(`⏳ *Pending fixes*\n${pending.length ? renderFix(pending) : '• none'}`);
  }
  if (filter === 'all' || filter === 'deployed') {
    const deployed = fixes.filter((p) => bucketOf(p) === 'deployed');
    sections.push(`🚀 *Deployed fixes*\n${deployed.length ? renderFix(deployed) : '• none'}`);
  }
  if (filter === 'all') {
    const other = fixes.filter((p) => bucketOf(p) === 'other');
    if (other.length) sections.push(`⛔ *Declined / other*\n${renderFix(other)}`);
  }

  if (ideas.length) {
    const renderIdea = ideas.map((p) => `💡 \`${p.proposal_code}\` — ${p.title || 'Untitled'}\n   Impact: ${p.impact_score ?? '—'}/10 · Status: ${p.status || 'pending'}`).join('\n\n');
    sections.push(`💡 *Feature proposals*\n${renderIdea}`);
  } else {
    sections.push('💡 *Feature proposals*\n• none');
  }

  return {
    reply: `🗂️ *Saka Backlog*\n\n${sections.join('\n\n')}\n\n` +
      `_Approve a fix:_ \`admin accept fix <CODE>\`\n` +
      `_Decline:_ \`admin decline fix <CODE>\`\n` +
      `_Modify:_ \`admin modify fix <CODE> <guidance>\`\n` +
      `_Feature proposals are review-only blueprints._\n` +
      `_Filter:_ \`admin backlog pending\` · \`admin backlog deployed\``
  };
}

/** v1.51.2 — FEAT-* codes are Sentinel Horizon feature proposals (review-only), not fixes. */
async function featureProposalReviewOnlyReply(supabase, code) {
  if (!/^FEAT-/i.test(String(code || ''))) return null;
  const upper = String(code || '').toUpperCase();
  const { data: feature, error } = await supabase
    .from('weekly_feature_proposals')
    .select('title,status,impact_score')
    .eq('proposal_code', upper)
    .maybeSingle();
  if (error || !feature) return null;
  return {
    reply: `💡 \`${upper}\` — ${feature.title || 'Feature proposal'} is a Sentinel Horizon *feature blueprint* (impact ${feature.impact_score ?? '—'}/10), not a fix.\n\nTo turn it into a work order, run \`admin adopt ${upper}\` — that captures it for review as a \`PROP-*\` code, and nothing runs until we plan and ship it together in a chat session.`
  };
}

/** v1.49.1 — a superadmin can ask for one proposal's status ("Status of FIX-…"). */
export async function handleAdminRemediationStatus(supabase, proposalCode) {
  const code = String(proposalCode || '').toUpperCase();
  const { data: proposal, error } = await supabase
    .from('remediation_proposals')
    .select('proposal_code,title,status,risk_level,created_at')
    .eq('proposal_code', code)
    .maybeSingle();

  if (error) {
    return { reply: `⚠️ Could not load ${code}: ${error.message}` };
  }
  if (!proposal) {
    const featureReply = await featureProposalReviewOnlyReply(supabase, code);
    if (featureReply) return featureReply;
    return { reply: `🛠️ No remediation proposal matches \`${code}\`. Type \`admin remediations\` to see the list.` };
  }

  const icons = {
    PENDING_APPROVAL: '⏳',
    APPROVED: '✅',
    EXECUTING: '⚙️',
    VALIDATED: '🧪',
    DEPLOYED: '🚀',
    DECLINED: '⛔',
    NEEDS_MODIFICATION: '✏️'
  };
  const icon = icons[proposal.status] || '•';
  return {
    reply: `🛠️ *Remediation status*\n\n${icon} \`${proposal.proposal_code}\` — ${proposal.title || 'Untitled'}\n   Status: *${proposal.status}* | Risk: ${String(proposal.risk_level || 'low').toUpperCase()}\n\n_Approve:_ \`admin accept fix ${proposal.proposal_code}\`\n_Decline:_ \`admin decline fix ${proposal.proposal_code}\``
  };
}

/**
 * Superadmin approval state machine (v1.10.0).
 * PENDING_APPROVAL / NEEDS_MODIFICATION → APPROVED (nonce minted, CI dispatched)
 *                                       | DECLINED
 *                                       | NEEDS_MODIFICATION (feedback stored, re-plan dispatched)
 */
/**
 * v1.17.0 — model proposals are DATA rollouts, not code edits: approval applies
 * the registry change immediately (audited) with no CI dispatch and no deploy.
 * This path is intentionally independent of REMEDIATION_AUTONOMY (which governs
 * autonomous CODE execution) but still requires an active superadmin session.
 */
async function handleModelUpdateProposalDecision(supabase, proposal, decision, feedback, { override = false } = {}) {
  const code = proposal.proposal_code;
  const stored = proposal.proposed_changes || {};
  const nowIso = new Date().toISOString();

  if (decision === 'decline') {
    const { error } = await supabase
      .from('remediation_proposals')
      .update({ status: REMEDIATION_STATUS.DECLINED, reviewed_at: nowIso, feedback: feedback ? String(feedback).trim() : proposal.feedback })
      .eq('id', proposal.id);
    if (error) return { reply: `⚠️ Decline failed: ${error.message}` };
    return { reply: `✅ *Declined* \`${code}\`. The current model stays active.` };
  }

  if (decision === 'modify') {
    const { error } = await supabase
      .from('remediation_proposals')
      .update({ status: REMEDIATION_STATUS.NEEDS_MODIFICATION, reviewed_at: nowIso, feedback: feedback ? String(feedback).trim() : proposal.feedback })
      .eq('id', proposal.id);
    if (error) return { reply: `⚠️ Update failed: ${error.message}` };
    return { reply: `✏️ \`${code}\` marked NEEDS_MODIFICATION. Model proposals are regenerated by the scout — adjust thresholds and run \`admin model scout\` when ready.` };
  }

  if (proposal.status !== REMEDIATION_STATUS.PENDING_APPROVAL && proposal.status !== REMEDIATION_STATUS.NEEDS_MODIFICATION) {
    return { reply: `⚠️ \`${code}\` is ${proposal.status}; only PENDING_APPROVAL or NEEDS_MODIFICATION can be approved.` };
  }
  if (proposal.status === REMEDIATION_STATUS.NEEDS_MODIFICATION && !override) {
    return { reply: `🔒 \`${code}\` was blocked by the model guardrails. Re-scout or approve with \`admin accept fix ${code} override\`.` };
  }

  const gate = await verifyModelUpdateAgainstRegistry(supabase, stored);
  if (!gate.ok && !override) {
    return { reply: `⚠️ Registry gate failed:\n${gate.violations.map((violation) => `• ${violation}`).join('\n')}` };
  }

  const rollout = await applyModelRollout(supabase, {
    modelId: stored.model_id,
    tierSlot: stored.tier_slot,
    trafficSplit: Number(stored.traffic_split || AI_MODEL_MAX_CANARY_PCT),
    activatedBy: 'superadmin_proposal',
    reason: code
  });
  if (!rollout.ok) return { reply: `⚠️ Model rollout failed: ${rollout.error}` };

  const { error } = await supabase
    .from('remediation_proposals')
    .update({
      status: REMEDIATION_STATUS.DEPLOYED,
      approval_kind: override ? 'superadmin_override' : 'standard',
      reviewed_at: nowIso,
      executed_at: nowIso,
      feedback: feedback ? String(feedback).trim() : proposal.feedback,
      execution: {
        mode: 'registry_rollout',
        model_id: stored.model_id,
        tier_slot: rollout.tierSlot,
        traffic_split: rollout.trafficSplit,
        applied_at: nowIso
      }
    })
    .eq('id', proposal.id);
  if (error) return { reply: `⚠️ Rollout applied but the proposal could not be marked DEPLOYED: ${error.message}` };

  return { reply: `✅ *Model adopted* \`${stored.model_id}\` on ${rollout.tierSlot} at ${rollout.trafficSplit}%.\nPrevious model kept on standby — \`admin model rollback ${rollout.tierSlot}\` reverts instantly.` };
}

export async function handleAdminRemediationDecision(supabase, proposalCode, decision, feedback = '', { override = false } = {}) {
  const code = String(proposalCode || '').trim().toUpperCase();
  if (!code) {
    return { reply: '⚠️ Please specify a proposal code, e.g. `admin accept fix FIX-2026-10-30-01`.' };
  }
  const { data: proposal, error } = await supabase
    .from('remediation_proposals')
    .select('*')
    .eq('proposal_code', code)
    .maybeSingle();

  if (error) return { reply: `⚠️ Could not load \`${code}\`: ${error.message}` };
  if (!proposal) {
    const featureReply = await featureProposalReviewOnlyReply(supabase, code);
    if (featureReply) return featureReply;
    return { reply: `⚠️ Unknown proposal \`${code}\`.` };
  }

  const nowIso = new Date().toISOString();
  const actionable = [REMEDIATION_STATUS.PENDING_APPROVAL, REMEDIATION_STATUS.NEEDS_MODIFICATION]
    .includes(proposal.status);

  // v1.17.0 — Model Watchdog proposals are registry rollouts (data, not code):
  // they are decided here, before the code-execution autonomy switch applies.
  if (proposal.category === 'ai_model_update') {
    return handleModelUpdateProposalDecision(supabase, proposal, decision, feedback, { override });
  }

  if (decision === 'accept') {
    if (!actionable) {
      return { reply: `⚠️ \`${code}\` is ${proposal.status}; only PENDING_APPROVAL or NEEDS_MODIFICATION can be approved.` };
    }

    // v1.53.1 — autonomous execution is decommissioned. Approval marks the
    // proposal for a superadmin chat session (plan → design → act); nothing
    // runs automatically and no nonce is minted.
    const { error: updateErr } = await supabase
      .from('remediation_proposals')
      .update({
        status: REMEDIATION_STATUS.APPROVED,
        reviewed_at: nowIso,
        approval_kind: 'chat_session',
        feedback: feedback ? String(feedback).trim() : proposal.feedback
      })
      .eq('id', proposal.id);

    if (updateErr) return { reply: `⚠️ Approval failed: ${updateErr.message}` };

    return { reply: `✅ *Approved for review* \`${code}\`. We will plan and ship it together in a chat session — nothing runs automatically.` };
  }

  if (decision === 'decline') {
    const { error: updateErr } = await supabase
      .from('remediation_proposals')
      .update({
        status: REMEDIATION_STATUS.DECLINED,
        reviewed_at: nowIso,
        feedback: feedback ? String(feedback).trim() : proposal.feedback
      })
      .eq('id', proposal.id);

    if (updateErr) return { reply: `⚠️ Decline failed: ${updateErr.message}` };
    return { reply: `⛔ *Declined* \`${code}\`. No code changes will be made.` };
  }

  if (decision === 'modify') {
    if (!feedback || !String(feedback).trim()) {
      return { reply: '⚠️ Add guidance, e.g. `admin modify fix FIX-2026-10-30-01 keep the change inside src/workers/sentinel.js`.' };
    }

    const guidance = String(feedback).trim();
    const { error: updateErr } = await supabase
      .from('remediation_proposals')
      .update({
        status: REMEDIATION_STATUS.NEEDS_MODIFICATION,
        feedback: guidance,
        reviewed_at: nowIso
      })
      .eq('id', proposal.id);

    if (updateErr) return { reply: `⚠️ Modify failed: ${updateErr.message}` };

    let dispatchNote = 'Guidance saved. It will be applied when the plan is regenerated.';
    if (proposal.audit_run_id) {
      const dispatch = await dispatchRepositoryEvent('remediation_plan', {
        audit_run_id: proposal.audit_run_id,
        proposal_code: code,
        feedback: guidance
      });
      dispatchNote = dispatch.ok
        ? 'Cline is re-drafting the plan with your guidance. A new approval request will arrive shortly.'
        : `Guidance saved, but the re-plan dispatch failed (${dispatch.error || 'unknown'}). It will retry on the next cycle.`;
    }

    return { reply: `✏️ *Modification requested* for \`${code}\`.\n\n${dispatchNote}` };
  }

  return { reply: `⚠️ Unknown remediation decision: ${decision}` };
}

export async function sendMorningExecutiveBriefing(supabase) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  if (!superadminPhone) return null;

  try {
    const reportRes = await handleAdminReportCommand(supabase);
    const alertsRes = await handleAdminAlertsCommand(supabase);
    // v1.86.0 (Phase 25, D3) — the command center rides the SAME briefing:
    // Mondays carry the FULL digest, every other day the 4-line pulse.
    const pulse = await buildBriefingPulse(supabase).catch(() => null);

    const briefingMsg = `🌅 *Saka Fleet 8:00 AM Executive Morning Briefing*\n\n` +
      reportRes.reply.replace('📊 *Saka Fleet Executive Digest & System Report*\n\n', '') +
      `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
      (pulse?.block ? `${pulse.block}\n\n━━━━━━━━━━━━━━━━━━━━\n` : '') +
      alertsRes.reply;

    const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_WHATSAPP_TOKEN;
    if (phoneNumberId && token) {
      const cleanPhone = superadminPhone.replace(/[^\d]/g, '');
      await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanPhone,
          type: 'text',
          text: { body: briefingMsg }
        })
      });
    }

    await logAdminAudit(supabase, superadminPhone, 'SCHEDULED_MORNING_BRIEFING', {
      timestamp: new Date().toISOString(),
      weekly: pulse?.isMonday === true
    });

    return briefingMsg;
  } catch (err) {
    console.error('[sendMorningExecutiveBriefing Error]:', err.message);
    return null;
  }
}

/**
 * v1.17.0 — Model Watchdog superadmin handlers (deterministic, zero tokens).
 */
export async function handleModelsCommand(supabase) {
  const summary = await getModelWatchdogSummary(supabase);
  return {
    reply: formatModelRegistryReply(summary),
    details: {
      active: summary.active.length,
      candidates: summary.candidates.length,
      pending_model_proposals: summary.pendingProposals
    }
  };
}

export async function handleModelScoutCommand(supabase) {
  const result = await runModelScoutCycle(supabase, { force: true });
  if (result.status !== 'ok') {
    return { reply: `⚠️ Model scout did not run: ${result.reason || result.status}`, details: result };
  }
  const lines = [
    '🧠 *Model Scout complete*',
    `• Provider listing: ${result.discovery.ok ? `${result.discovery.listed} model(s), ${result.discovery.inserted} new` : `failed (${result.discovery.error})`}`,
    `• Benchmarks this run: ${result.benchmarks.length}`,
    ...result.benchmarks.map((row) => `   – \`${row.modelId}\` · score ${row.score} · ${row.latencyMs} ms`),
    result.recommendation?.recommended
      ? `• Recommendation: \`${result.recommendation.modelId}\` on ${result.recommendation.tierSlot}`
      : `• Recommendation: none (${result.recommendation?.reason || 'no candidate'})`,
    result.proposal?.proposal_code
      ? `• Proposal: \`${result.proposal.proposal_code}\` ${result.proposal.duplicate ? '(already pending)' : '(awaiting approval)'}`
      : '',
    result.rollout?.ok
      ? `• Auto-canary applied: \`${result.rollout.modelId}\` at ${result.rollout.trafficSplit}%`
      : '',
    `_Research: ${result.research.ran ? 'web search used' : `skipped (${result.research.reason || 'off'})`}_`
  ].filter(Boolean);
  return {
    reply: lines.join('\n'),
    details: {
      discovery: result.discovery,
      benchmarks: result.benchmarks.length,
      recommendation: result.recommendation?.modelId || null,
      proposal: result.proposal?.proposal_code || null
    }
  };
}

export async function handleModelAdoptCommand(supabase, modelId, trafficSplit = AI_MODEL_MAX_CANARY_PCT) {
  if (!modelId) {
    return { reply: '⚠️ Usage: `admin model adopt <model_id> [split]`', details: {} };
  }
  const split = Math.min(AI_MODEL_MAX_CANARY_PCT, Math.max(1, Number(trafficSplit) || AI_MODEL_MAX_CANARY_PCT));
  const gate = await verifyModelUpdateAgainstRegistry(supabase, {
    model_id: modelId,
    traffic_split: split,
    rollback: 'admin model rollback',
    tests: ['test_model_scout.js', 'test_model_router.js', 'test_agent_training.js'],
    changes: [{ file: 'src/services/aiModelRegistry.js' }]
  });
  if (!gate.ok) {
    return {
      reply: `⚠️ Cannot adopt \`${modelId}\`:\n${gate.violations.map((violation) => `• ${violation}`).join('\n')}\n\nRun \`admin model scout\` to benchmark it first.`,
      details: { violations: gate.violations }
    };
  }
  const rollout = await applyModelRollout(supabase, {
    modelId,
    trafficSplit: split,
    activatedBy: 'superadmin_command',
    reason: 'admin model adopt'
  });
  if (!rollout.ok) return { reply: `⚠️ Rollout failed: ${rollout.error}`, details: rollout };
  return {
    reply: `✅ *${modelId} adopted* on ${rollout.tierSlot} at ${rollout.trafficSplit}%.\n_Previous: ${rollout.previous.join(', ') || 'none'} — rollback with \`admin model rollback ${rollout.tierSlot}\`._`,
    details: rollout
  };
}

export async function handleModelRollbackCommand(supabase, tierSlot = 'tier_1') {
  const slot = AI_MODEL_TIER_SLOTS.includes(tierSlot) ? tierSlot : 'tier_1';
  const result = await rollbackModel(supabase, { tierSlot: slot, reason: 'admin command' });
  if (!result.ok) return { reply: `⚠️ Rollback failed: ${result.error}`, details: result };
  return {
    reply: `✅ Rolled back ${slot}: \`${result.from}\` → \`${result.to}\` (100%).`,
    details: result
  };
}

/**
 * Main Intercept Flow for Superadmin WhatsApp Messages
 */
/** Deterministic digest for `admin rollout` (zero tokens). */
export function formatFeatureRolloutReply(status) {
  const counts = status?.counts || {};
  const value = (input) => (input === null || input === undefined ? 'n/a' : String(input));
  return `🚀 *Saka v${status?.version || FEATURE_NOTICE_VERSION} Rollout*\n\n` +
    `• 👥 Profiles: ${value(counts.profiles)}\n` +
    `• ✅ Noticed: ${value(counts.notified)} · pending ${value(status?.pending)}\n` +
    `• Receipts: ${value(counts.receipts)} · registry ${value(counts.registry)}\n` +
    `• 🚗 Active vehicles: ${value(counts.vehicles)}\n\n` +
    '_The digest appends once to each user\'s next normal turn. Run npm run rollout:features -- --apply to backfill the schema._';
}

/**
 * Deterministic superadmin command registry (v1.58.10) — the SINGLE source of
 * truth for the command list. `admin help` is generated from THIS, so adding a
 * command here (once) automatically documents it. Zero tokens.
 */
export const ADMIN_COMMAND_REGISTRY = Object.freeze([
  { group: 'Session', items: [
    { cmd: 'adminstart', desc: 'open a 30-min admin session', ex: ['adminstart'] },
    { cmd: 'adminstop', desc: 'close the admin session', ex: ['adminstop'] },
    { cmd: 'admin help', desc: 'list every command (this list)', ex: ['admin help', 'list admin commands'] }
  ] },
  { group: 'Snapshots', items: [
    { cmd: 'admin report', desc: 'full system snapshot (users, vehicles, health)', ex: ['admin report'] },
    { cmd: 'admin command', desc: 'business command center (revenue, churn, support, AI cost)', ex: ['admin command', 'admin bi'] },
    { cmd: 'admin alerts', desc: 'recent alerts + unresolved errors', ex: ['admin alerts'] },
    { cmd: 'admin audit <query>', desc: 'search the admin audit log', ex: ['admin audit wipe'] },
    { cmd: 'check health', desc: 'live health check', ex: ['check health'] },
    // v1.78.0 (Phase 17) — plain-English admin questions ride the Admin AI Agent.
    { cmd: 'just ask', desc: 'plain-English admin questions (health, AI usage, proposals)', ex: ['how many tokens did we use today?'] }
  ] },
  { group: 'Fleet', items: [
    { cmd: 'profiles report', desc: 'user / profile statistics', ex: ['profiles report'] },
    { cmd: 'admin trial-stats', desc: 'trial funnel + conversion', ex: ['admin trial-stats'] },
    { cmd: 'admin launch-stats', desc: 'launch award slots + winners', ex: ['admin launch-stats'] },
    { cmd: 'admin ai-stats [Nh]', desc: 'AI usage + cost (default 24h)', ex: ['admin ai-stats', 'admin ai-stats 48h'] },
    { cmd: 'admin ocr-stats [Nh]', desc: 'OCR usage summary', ex: ['admin ocr-stats'] },
    { cmd: 'admin ocr-profile [KE]', desc: 'per-country OCR profile', ex: ['admin ocr-profile KE'] },
    { cmd: 'admin latency [Nh]', desc: 'reply-speed digest', ex: ['admin latency 24h'] },
    { cmd: 'admin env', desc: 'env / secret parity (names only)', ex: ['admin env'] }
  ] },
  { group: 'Fixes & governance', items: [
    { cmd: 'admin backlog', desc: 'all open fixes / proposals', ex: ['admin backlog', 'show me pending proposals'] },
    { cmd: 'admin remediations [pending|deployed]', desc: 'remediation backlog', ex: ['admin remediations pending'] },
    { cmd: 'admin accept|decline|modify fix <CODE>', desc: 'decide a proposal', ex: ['admin accept fix PROP-2026-11-04-01'] },
    { cmd: 'status of <CODE>', desc: 'one proposal status', ex: ['status of PROP-2026-11-04-01'] },
    { cmd: 'admin friction [pending|deployed|log]', desc: 'friction points', ex: ['admin friction pending'] },
    { cmd: 'admin friction done <id>', desc: 'mark a friction point fixed', ex: ['admin friction done 1a2b3c4d'] },
    { cmd: 'admin inbox', desc: 'inbound support emails', ex: ['admin inbox'] },
    { cmd: 'admin inbox read <id>', desc: 'open one inbound email', ex: ['admin inbox read 1a2b3c4d'] },
    { cmd: 'admin adopt <FEAT/PROP-code>', desc: 'adopt a feature/proposal for review', ex: ['admin adopt FEAT-2026-W44-01'] },
    { cmd: 'UPDATE-SUGGEST> <text>', desc: 'file a free-text update suggestion', ex: ['UPDATE-SUGGEST> redirect chat signups to the site'] },
    { cmd: 'admin quick-edit', desc: 'interactive quick-edit preview', ex: ['admin quick-edit'] }
  ] },
  { group: 'Templates', items: [
    { cmd: 'admin tpl test [kind|all]', desc: 'fire a real Meta template to the superadmin phone (5 per 10 min)', ex: ['admin tpl test re_engagement', 'admin tpl test all'] },
    { cmd: 'admin tpl buttons [phone]', desc: 'audit every template reply button (declared/mapped/captured)', ex: ['admin tpl buttons', 'admin tpl buttons 0734852529'] }
  ] },
  { group: 'Growth', items: [
    { cmd: 'generate coupon <pct>', desc: 'create a discount coupon', ex: ['generate coupon 20%'] },
    { cmd: 'admin horizon', desc: 'synthesize the weekly feature blueprint', ex: ['admin horizon'] },
    { cmd: 'admin proposals', desc: 'Horizon feature proposals', ex: ['admin proposals'] }
  ] },
  { group: 'Guardrails & data', items: [
    { cmd: 'admin rules list|toggle <key>|reset', desc: 'Sentinel micro-rules', ex: ['admin rules list', 'admin rules reset'] },
    { cmd: 'admin wipe <phone>', desc: 'OTP-gated clean sign-up wipe (code to SUPERADMIN_EMAIL)', ex: ['admin wipe 0734852529'] },
    { cmd: 'admin wipe confirm <code>', desc: 'confirm the wipe with the emailed code', ex: ['admin wipe confirm 123456'] },
    { cmd: 'sentinel diagnose', desc: 'live health + friction diagnosis', ex: ['sentinel diagnose'] }
  ] },
  { group: 'Knowledge', items: [
    { cmd: 'admin kb', desc: 'country knowledgebase overview', ex: ['admin kb'] },
    { cmd: 'admin kb review', desc: 'draft KB rules awaiting approval', ex: ['admin kb review'] },
    { cmd: 'admin kb stale', desc: 'stale KB rules', ex: ['admin kb stale'] },
    { cmd: 'admin kb approve|reject <id>', desc: 'decide a draft KB rule', ex: ['admin kb approve ab12cd34'] }
  ] },
  { group: 'Models', items: [
    { cmd: 'admin models', desc: 'model registry + serving state', ex: ['admin models'] },
    { cmd: 'admin scout', desc: 'run the model scout cycle', ex: ['admin scout'] },
    { cmd: 'admin adopt <model-id> [pct]', desc: 'canary a new model', ex: ['admin adopt gpt-4o-mini 10'] },
    { cmd: 'admin model rollback', desc: 'roll back a regressed model', ex: ['admin model rollback'] }
  ] },
  { group: 'Release & incidents', items: [
    { cmd: 'admin rollout', desc: 'feature rollout status', ex: ['admin rollout'] },
    { cmd: 'admin incidents', desc: 'open incidents', ex: ['admin incidents'] },
    { cmd: 'admin incident resolve|suppress <id>', desc: 'decide an incident', ex: ['admin incident resolve 1a2b3c4d'] }
  ] }
]);

/** Rank registry commands against a free-text admin request (for clarification). */
export function matchAdminCommands(text = '', limit = 3) {
  const q = String(text || '').toLowerCase().replace(/^admin\s+/, '').trim();
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const scored = [];
  for (const g of ADMIN_COMMAND_REGISTRY) {
    for (const it of g.items) {
      const hay = `${it.cmd} ${it.desc} ${(it.ex || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      if (score > 0) scored.push({ score, item: it });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Friendly "did you mean…" for an admin-looking message we could not parse. */
export function buildAdminClarifyReply(text = '') {
  const matches = matchAdminCommands(text, 3);
  const header = "🤔 I'm not sure which admin action that is. Here's what I can do - reply with one, or just tell me in plain words:";
  if (!matches.length) return `${header}\n\n${formatAdminHelpReply()}`;
  const lines = matches.map((it) => `• *${it.cmd}* - ${it.desc}\n   e.g. _${(it.ex && it.ex[0]) || it.cmd}_`);
  return `${header}\n\n${lines.join('\n')}\n\nReply *admin help* for the full list.`;
}

/**
 * Deterministic superadmin command list, generated from ADMIN_COMMAND_REGISTRY
 * so it can never go stale. Zero tokens, zero provider calls.
 */
export function formatAdminHelpReply() {
  const lines = ['🛠️ *Saka admin commands*', ''];
  for (const group of ADMIN_COMMAND_REGISTRY) {
    if (!group.items.length) continue;
    lines.push(`*${group.group}*`);
    for (const it of group.items) lines.push(`• ${it.cmd} - ${it.desc}`);
    lines.push('');
  }
  lines.push('_adminstart opens a session · adminstop closes it · admin help shows this list._');
  return lines.join('\n');
}

/**
 * v1.78.0 (Phase 17, section 206) — Conversational superadmin (Admin AI Agent).
 * --------------------------------------------------------------------------
 * A superadmin-phone message that matches no static command is answered from
 * live ENGINE data with the two-call pattern:
 *   1. `admin_tool_call` — the model PICKS one tool (JSON only, no prose);
 *   2. the engine executes the tool through the existing deterministic
 *      handlers (health facts, AI telemetry digest, proposal backlog);
 *   3. `admin_synthesis` — the model WORDs the reply from those facts only.
 * Every number/status is copied from engine output (rule 28), both calls flow
 * through `aiClient` with a purpose (rule 20), and any AI failure degrades to
 * the deterministic tool reply or `buildAdminClarifyReply` — never worse than
 * the static clarify that preceded this feature.
 */
export const ADMIN_AGENT_TOOLS = Object.freeze([
  {
    name: 'get_system_health',
    args: [],
    description: 'Live system health: container uptime/memory, database connection, unresolved error logs and Sentinel diagnoses.',
    examples: ['is everything okay', 'any errors', 'system status', 'health']
  },
  {
    name: 'get_ai_usage',
    args: ['hours'],
    description: 'AI router telemetry: requests, tokens, approximate cost, reply latency and per-purpose usage. hours 1-168 (default 24; "today" = 24, "this week" = 168).',
    examples: ['how many tokens did we use today', 'what did AI cost', 'reply latency']
  },
  {
    name: 'get_open_proposals',
    args: [],
    description: 'The remediation proposal backlog: pending / needs-modification fixes with codes, status and risk.',
    examples: ['what is pending', 'open fixes', 'proposals', 'backlog']
  }
]);

const ADMIN_AGENT_HOURS_DEFAULT = 24;
const ADMIN_AGENT_MAX_REPLY_CHARS = 1200;

/** Clamp a model-proposed telemetry window to the real 1-168h registry bounds. */
export function clampAdminAgentHours(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return ADMIN_AGENT_HOURS_DEFAULT;
  return Math.min(AI_USAGE_MAX_WINDOW_HOURS, Math.max(1, Math.round(num)));
}

/** Tool-router prompt, generated from the registry so the two can never drift. */
export function buildAdminToolPrompt(messageText = '') {
  const toolLines = ADMIN_AGENT_TOOLS.map((tool) => {
    const args = tool.args.length ? `(${tool.args.join(', ')})` : '()';
    return `- ${tool.name}${args}: ${tool.description}`;
  }).join('\n');
  return [
    'You are the Saka Fleet superadmin tool router.',
    'Choose exactly ONE tool whose DATA answers the superadmin question, or "none". Never answer the question yourself.',
    '',
    'TOOLS:',
    toolLines,
    '- none: anything else (small talk, unclear or out-of-scope requests).',
    '',
    'Return ONLY JSON: {"tool":"get_system_health|get_ai_usage|get_open_proposals|none","hours":<integer or null>}',
    '',
    `Question: "${String(messageText || '').slice(0, 500)}"`
  ].join('\n');
}

/** One classifier call. Never throws; anything unexpected degrades to `none`. */
export async function classifyAdminToolRequest(messageText, { generate = generateText } = {}) {
  const allowed = new Set(ADMIN_AGENT_TOOLS.map((tool) => tool.name));
  try {
    const raw = await generate({
      prompt: buildAdminToolPrompt(messageText),
      jsonMode: true,
      maxTokens: 256,
      temperature: 0.2,
      purpose: 'admin_tool_call'
    });
    if (!raw) return { tool: 'none', hours: null };
    const parsed = parseJsonSafely(String(raw));
    if (!parsed || typeof parsed !== 'object') return { tool: 'none', hours: null };
    const tool = String(parsed.tool || '').trim();
    if (tool === 'none' || !allowed.has(tool)) return { tool: 'none', hours: null };
    return { tool, hours: tool === 'get_ai_usage' ? clampAdminAgentHours(parsed.hours) : null };
  } catch {
    return { tool: 'none', hours: null };
  }
}

/** Synthesis prompt: the model may ONLY word the engine facts it is given. */
export function buildAdminSynthesisPrompt(messageText, tool, facts) {
  return [
    'You are Saka, answering your SUPERADMIN on WhatsApp.',
    'Use ONLY the FACTS below. Copy every number, cost, count and status verbatim - never invent, round, estimate or extrapolate.',
    'Lead with the direct answer, keep it under 120 words, WhatsApp formatting, at most one emoji per line, plain language.',
    'If the FACTS say something failed or is unavailable, say so plainly. Never claim an action was taken.',
    '',
    `SUPERADMIN QUESTION: "${String(messageText || '').slice(0, 500)}"`,
    `FACTS (tool: ${tool}):`,
    String(facts || '').slice(0, 6000)
  ].join('\n');
}

/**
 * Execute one agent tool through the existing deterministic handlers.
 * Returns `{ ok, tool, facts, fallbackReply, details }`; never throws.
 */
export async function executeAdminAgentTool(supabase, tool, { hours = null, healthCheck = runHealthCheck } = {}) {
  if (tool === 'get_system_health') {
    const facts = await collectHealthFacts(supabase, { healthCheck });
    const uptimeMin = Math.floor(facts.telemetry.uptimeSec / 60);
    const fallbackReply = [
      '🖥️ *Saka health*',
      '',
      `• Container: up ${uptimeMin}m · heap ${facts.telemetry.memoryMB}MB`,
      `• Database: ${facts.telemetry.dbStatus}`,
      `• Unresolved errors: ${facts.telemetry.unresolvedCount}`,
      `• Sentinel diagnoses: ${facts.telemetry.diagnosedCount}`
    ].join('\n');
    return { ok: true, tool, facts: facts.rawInfo, fallbackReply, details: facts.telemetry };
  }
  if (tool === 'get_ai_usage') {
    const usage = await handleAiStatsCommand(supabase, clampAdminAgentHours(hours));
    return {
      ok: usage?.details?.ok !== false,
      tool,
      facts: usage?.reply || '',
      fallbackReply: usage?.reply || null,
      details: usage?.details || null
    };
  }
  if (tool === 'get_open_proposals') {
    const list = await handleAdminRemediationsList(supabase, 'pending');
    return { ok: true, tool, facts: list?.reply || '', fallbackReply: list?.reply || null };
  }
  return { ok: false, tool, facts: null, fallbackReply: null, error: 'unknown tool' };
}

/**
 * The Admin AI Agent turn. Returns `{ reply, tool, ok, synthesized }`;
 * audits ADMIN_AI_TOOL (execution) + ADMIN_AI_AGENT (the turn) and never throws.
 */
export async function processAdminMessage(supabase, formattedPhone, messageText, { generate = generateText, healthCheck = runHealthCheck } = {}) {
  const text = String(messageText || '').slice(0, 500);
  const decision = await classifyAdminToolRequest(messageText, { generate });

  if (decision.tool === 'none') {
    const clarify = buildAdminClarifyReply(messageText);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_AI_AGENT', {
      text: text.slice(0, 160),
      tool: 'none',
      reply_chars: clarify.length,
      fallback: 'clarify'
    });
    return { reply: clarify, tool: 'none', ok: false, synthesized: false };
  }

  let execution = null;
  try {
    execution = await executeAdminAgentTool(supabase, decision.tool, { hours: decision.hours, healthCheck });
  } catch (err) {
    execution = { ok: false, tool: decision.tool, facts: null, fallbackReply: null, error: err?.message || 'tool failed' };
  }
  await logAdminAudit(supabase, formattedPhone, 'ADMIN_AI_TOOL', {
    tool: decision.tool,
    ok: Boolean(execution?.ok),
    hours: decision.hours || null,
    error: execution?.ok ? null : String(execution?.error || 'unknown').slice(0, 160)
  });

  let synthesized = null;
  if (execution?.ok && execution.facts) {
    try {
      const raw = await generate({
        prompt: buildAdminSynthesisPrompt(messageText, decision.tool, execution.facts),
        maxTokens: 700,
        temperature: 0.4,
        purpose: 'admin_synthesis'
      });
      synthesized = String(raw || '').trim().slice(0, ADMIN_AGENT_MAX_REPLY_CHARS) || null;
    } catch {
      synthesized = null;
    }
  }

  const finalReply = synthesized || execution?.fallbackReply || buildAdminClarifyReply(messageText);
  await logAdminAudit(supabase, formattedPhone, 'ADMIN_AI_AGENT', {
    text: text.slice(0, 160),
    tool: decision.tool,
    reply_chars: finalReply.length,
    fallback: synthesized ? null : (execution?.fallbackReply ? 'deterministic_tool_reply' : 'clarify')
  });
  return { reply: finalReply, tool: decision.tool, ok: Boolean(execution?.ok), synthesized: Boolean(synthesized) };
}

export async function handleSuperadminFlow(supabase, senderPhone, messageText, options = {}) {
  if (!isSuperadminPhone(senderPhone)) {
    return { isSuperadmin: false };
  }

  const formattedPhone = senderPhone.startsWith('+') ? senderPhone : `+${senderPhone.replace(/[^\d]/g, '')}`;
  const cleanText = messageText ? messageText.trim().toLowerCase() : '';

  // 1. Session Control: "adminstart"
  if (cleanText === 'adminstart') {
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('superadmin_sessions')
      .upsert({
        phone_number: formattedPhone,
        is_active: true,
        last_active_at: nowIso
      });

    if (error) console.error('[Superadmin Session Start Error]:', error.message);

    await logAdminAudit(supabase, formattedPhone, 'SESSION_START', { command: 'adminstart' });

    return {
      isSuperadmin: true,
      reply: '🔒 Superadmin session started. You have full control.'
    };
  }

  // 2. Session Control: "adminstop"
  if (cleanText === 'adminstop') {
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('superadmin_sessions')
      .upsert({
        phone_number: formattedPhone,
        is_active: false,
        last_active_at: nowIso
      });

    if (error) console.error('[Superadmin Session Stop Error]:', error.message);

    await logAdminAudit(supabase, formattedPhone, 'SESSION_STOP', { command: 'adminstop' });

    return {
      isSuperadmin: true,
      reply: '🔓 Superadmin session closed.'
    };
  }

  // 3. Parse the admin intent first so non-admin messages can fall through to
  // the normal Owner/Driver conversational flow (multi-role coexistence).
  const parsedCommand = await parseSuperadminCommand(messageText);

  // v1.78.0 (Phase 17, section 206) — everything that matches no static command
  // is a natural-language admin question and now rides the Admin AI Agent
  // (session-gated below). Static commands still win every matching turn with
  // ZERO tokens; non-superadmin phones never reach this function (phone gate).
  if (!ADMIN_INTENTS.has(parsedCommand.intent) && parsedCommand.intent !== 'UNKNOWN') {
    return { isSuperadmin: false };
  }

  // 4. Verify Active Session & Enforce 30-Minute Inactivity TTL
  const { data: sessionData } = await supabase
    .from('superadmin_sessions')
    .select('*')
    .eq('phone_number', formattedPhone)
    .maybeSingle();

  if (!sessionData || sessionData.is_active !== true) {
    return {
      isSuperadmin: true,
      reply: "Please type 'adminstart' to begin your admin session."
    };
  }

  // Enforce automatic 30-minute inactivity timeout (30 minutes = 1,800,000 ms)
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const lastActiveTime = sessionData.last_active_at ? new Date(sessionData.last_active_at).getTime() : 0;
  const nowTime = Date.now();

  if (nowTime - lastActiveTime > SESSION_TTL_MS) {
    // Session timed out due to 30+ minutes of inactivity! Deactivate session in DB
    await supabase
      .from('superadmin_sessions')
      .update({ is_active: false })
      .eq('phone_number', formattedPhone);

    await logAdminAudit(supabase, formattedPhone, 'SESSION_TIMEOUT', {
      reason: 'Inactivity timeout exceeded 30 minutes',
      last_active_at: sessionData.last_active_at,
      timestamp: new Date().toISOString()
    });

    return {
      isSuperadmin: true,
      reply: "🔒 Your superadmin session has expired due to 30 minutes of inactivity. Please type 'adminstart' to re-authenticate."
    };
  }

  // Active session confirmed! Update last_active_at timestamp
  await supabase
    .from('superadmin_sessions')
    .update({ last_active_at: new Date().toISOString() })
    .eq('phone_number', formattedPhone);

  // 5. Command Routing
  if (parsedCommand.intent === 'UNKNOWN') {
    // v1.78.0 (Phase 17) — natural-language admin question → Admin AI Agent.
    // Audits ADMIN_AI_TOOL + ADMIN_AI_AGENT; degrades to buildAdminClarifyReply.
    const agentRes = await processAdminMessage(supabase, formattedPhone, messageText, options);
    return { isSuperadmin: true, reply: agentRes.reply };
  }
  if (parsedCommand.intent === 'ADMIN_HELP') {
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_HELP', {});
    return { isSuperadmin: true, reply: formatAdminHelpReply() };
  }
  if (parsedCommand.intent === 'ADMIN_REPORT') {
    const reportRes = await handleAdminReportCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_REPORT', reportRes.details);
    return {
      isSuperadmin: true,
      reply: reportRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_AUDIT') {
    const auditRes = await handleAdminAuditCommand(supabase, parsedCommand.query);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_AUDIT', auditRes.details || { query: parsedCommand.query });
    return {
      isSuperadmin: true,
      reply: auditRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_ALERTS') {
    const alertsRes = await handleAdminAlertsCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_ALERTS', alertsRes.details);
    return {
      isSuperadmin: true,
      reply: alertsRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_BACKLOG') {
    const backlogRes = await handleAdminBacklog(supabase, parsedCommand.filter || 'all');
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_BACKLOG', { filter: parsedCommand.filter || 'all' });
    return {
      isSuperadmin: true,
      reply: backlogRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_REMEDIATIONS') {
    const listRes = await handleAdminRemediationsList(supabase, parsedCommand.filter || 'all');
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_REMEDIATIONS', { filter: parsedCommand.filter || 'all' });
    return {
      isSuperadmin: true,
      reply: listRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_INBOX') {
    const inboxRes = await handleAdminInbox(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_INBOX', {});
    return { isSuperadmin: true, reply: inboxRes.reply };
  }

  if (parsedCommand.intent === 'ADMIN_INBOX_READ') {
    const inboxReadRes = await handleAdminInboxRead(supabase, parsedCommand.inbound_id);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_INBOX_READ', { inbound_id: parsedCommand.inbound_id });
    return { isSuperadmin: true, reply: inboxReadRes.reply };
  }

  if (parsedCommand.intent === "ADMIN_FRICTION") {
    const frictionRes = await handleAdminFriction(supabase, parsedCommand.filter || "active");
    await logAdminAudit(supabase, formattedPhone, "ADMIN_FRICTION", { filter: parsedCommand.filter || "active" });
    return {
      isSuperadmin: true,
      reply: frictionRes.reply
    };
  }

  if (parsedCommand.intent === "ADMIN_FRICTION_DONE") {
    const frictionDoneRes = await handleAdminFrictionDone(supabase, parsedCommand.friction_id);
    await logAdminAudit(supabase, formattedPhone, "ADMIN_FRICTION_DONE", { friction_id: parsedCommand.friction_id });
    return {
      isSuperadmin: true,
      reply: frictionDoneRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_REMEDIATION_STATUS') {
    const statusRes = await handleAdminRemediationStatus(supabase, parsedCommand.proposal_code);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_REMEDIATION_STATUS', { proposal_code: parsedCommand.proposal_code });
    return {
      isSuperadmin: true,
      reply: statusRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_FEATURE_ADOPT') {
    const adoptRes = await captureFeatureAdoption(supabase, formattedPhone, parsedCommand.proposal_code);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_FEATURE_ADOPT', {
      proposal_code: adoptRes.code || null,
      adopted: Boolean(adoptRes.ok)
    });
    return {
      isSuperadmin: true,
      reply: adoptRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_UPDATE_SUGGEST') {
    const captureRes = await captureUpdateSuggestion(supabase, formattedPhone, parsedCommand.suggestion);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_UPDATE_SUGGEST', {
      proposal_code: captureRes.code || null,
      captured: Boolean(captureRes.ok)
    });
    return {
      isSuperadmin: true,
      reply: captureRes.reply
    };
  }

  // v1.51.10 — SUG-2026-11-03-01 clause 7: deterministic interactive quick-edit
  // preview (buttons + text fallback). Read-only, zero AI tokens, audited.
  if (parsedCommand.intent === 'ADMIN_QUICK_EDIT_PREVIEW') {
    const preview = formatQuickEditPreview();
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_QUICK_EDIT_PREVIEW', {
      payload_type: preview?.payload?.interactive?.type || 'text'
    });
    return {
      isSuperadmin: true,
      reply: preview.reply
    };
  }

  // v1.96.0 — Meta template operator surfaces. Both are deterministic, zero
  // tokens, superadmin-only (this hub) and session-gated above. The test-fire
  // sends to the operator-typed target (E.164-normalised) or SUPERADMIN_PHONE;
  // every attempt writes one audit row with the target masked.
  if (parsedCommand.intent === 'ADMIN_TEMPLATE_TEST') {
    const outcome = await runTemplateTestFire({
      adminPhone: formattedPhone,
      kind: parsedCommand.kind ?? null,
      targetPhone: parsedCommand.targetPhone ?? null,
      audit: (details) => logAdminAudit(supabase, formattedPhone, 'ADMIN_TEMPLATE_TEST', details)
    });
    return {
      isSuperadmin: true,
      reply: formatTemplateTestReply(outcome)
    };
  }

  if (parsedCommand.intent === 'ADMIN_TEMPLATE_BUTTONS') {
    // v1.96.3 — optional target phone: audit the device the test was fired at
    // (default = the admin's own phone). Invalid targets refuse with zero reads.
    const auditData = await runTemplateButtonAudit({
      supabase,
      adminPhone: formattedPhone,
      targetPhone: parsedCommand.targetPhone ?? null,
      titlePhrases: BUTTON_TITLE_PHRASES
    });
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_TEMPLATE_BUTTONS', {
      audited_phone: auditData.auditPhone || null,
      status: auditData.status || 'done',
      declared_kinds: (auditData.declared || []).map((entry) => entry.kind),
      mapped_titles: (auditData.mapped || []).length,
      captured: (auditData.captured || []).length,
      unclaimed: (auditData.unclaimed || []).length
    });
    return {
      isSuperadmin: true,
      reply: formatTemplateButtonDigest(auditData)
    };
  }

  if (['ADMIN_REMEDIATION_ACCEPT', 'ADMIN_REMEDIATION_DECLINE', 'ADMIN_REMEDIATION_MODIFY'].includes(parsedCommand.intent)) {
    const decision = parsedCommand.intent === 'ADMIN_REMEDIATION_ACCEPT'
      ? 'accept'
      : (parsedCommand.intent === 'ADMIN_REMEDIATION_DECLINE' ? 'decline' : 'modify');
    const decisionRes = await handleAdminRemediationDecision(
      supabase,
      parsedCommand.proposal_code,
      decision,
      parsedCommand.feedback || '',
      { override: Boolean(parsedCommand.override) }
    );
    await logAdminAudit(supabase, formattedPhone, `ADMIN_REMEDIATION_${decision.toUpperCase()}`, {
      proposal_code: parsedCommand.proposal_code || null,
      feedback: parsedCommand.feedback || null,
      override: Boolean(parsedCommand.override)
    });
    return {
      isSuperadmin: true,
      reply: decisionRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_RULES_RESET') {
    const resetRes = await handleAdminRulesReset(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_RULES_RESET', {});
    return {
      isSuperadmin: true,
      reply: resetRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_PROFILE_WIPE') {
    const wipeRes = await handleAdminProfileWipeInitiate(supabase, parsedCommand.target_phone);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_PROFILE_WIPE_REQUESTED', { target: parsedCommand.target_phone });
    return { isSuperadmin: true, reply: wipeRes.reply };
  }

  if (parsedCommand.intent === 'ADMIN_PROFILE_WIPE_CONFIRM') {
    const wipeRes = await handleAdminProfileWipeConfirm(supabase, parsedCommand.code);
    if (wipeRes.wiped) {
      await logAdminAudit(supabase, formattedPhone, 'ADMIN_PROFILE_WIPED', { phone: wipeRes.phone, counts: wipeRes.counts });
    }
    return { isSuperadmin: true, reply: wipeRes.reply };
  }

  if (parsedCommand.intent === 'ADMIN_RULES_TOGGLE') {
    const toggleRes = await handleAdminRulesToggle(supabase, parsedCommand.rule_key);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_RULES_TOGGLE', { rule_key: parsedCommand.rule_key });
    return {
      isSuperadmin: true,
      reply: toggleRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_RULES_LIST') {
    const listRes = await handleAdminRulesList(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_RULES_LIST', {});
    return {
      isSuperadmin: true,
      reply: listRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_HORIZON') {
    const { generateWeeklyFeaturePlan } = await import('../workers/sentinel.js');
    const horizonRes = await generateWeeklyFeaturePlan(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_HORIZON', { manually_triggered: true });
    return {
      isSuperadmin: true,
      reply: horizonRes.message
    };
  }

  if (parsedCommand.intent === 'ADMIN_PROPOSALS') {
    const { data: proposals, error } = await supabase.from('weekly_feature_proposals').select('*').order('created_at', { ascending: false }).limit(5);
    let replyText = '🚀 *Saka Sentinel Horizon Proposals* 🌟\n\n';
    if (error || !proposals || proposals.length === 0) {
      replyText += 'No pending feature proposals found.';
    } else {
      proposals.forEach((p, idx) => {
        replyText += `${idx + 1}. *${p.title}* (\`${p.proposal_code}\`)\n   • Target: ${p.target_persona}\n   • Impact: ${p.impact_score}/10\n   • Value: ${p.driver_value_proposition}\n\n`;
      });
      replyText += `_Review-only blueprints — see the full backlog with \`admin backlog\`._`;
    }
    return { isSuperadmin: true, reply: replyText };
  }

  if (parsedCommand.intent === 'HEALTH_CHECK') {
    const healthRes = await handleHealthCheckCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'HEALTH_CHECK', healthRes.telemetry);
    return {
      isSuperadmin: true,
      reply: healthRes.summary
    };
  }

  if (parsedCommand.intent === 'ADMIN_AI_STATS') {
    const statsRes = await handleAiStatsCommand(supabase, parsedCommand.hours || 24);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_AI_STATS', statsRes.details);
    return {
      isSuperadmin: true,
      reply: statsRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_CONV_EVAL') {
    const convRes = await handleConvEvalCommand(supabase, {
      mode: parsedCommand.mode || 'stats',
      hours: parsedCommand.hours || 24,
      caseId: parsedCommand.case_id || null
    });
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_CONV_EVAL', convRes.details);
    return {
      isSuperadmin: true,
      reply: convRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_ENV_AUDIT') {
    const envRes = await handleEnvAuditCommand(process.env, { templateKeys: readTemplateEnvKeys() });
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_ENV_AUDIT', envRes.details);
    return {
      isSuperadmin: true,
      reply: envRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_OCR_STATS') {
    const ocrRes = await handleOcrStatsCommand(supabase, parsedCommand.hours || 24);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_OCR_STATS', ocrRes.details);
    return {
      isSuperadmin: true,
      reply: ocrRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_OCR_PROFILE') {
    const profileRes = await handleOcrProfileCommand(supabase, parsedCommand.countryCode);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_OCR_PROFILE', profileRes.details);
    return {
      isSuperadmin: true,
      reply: profileRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_TURN_LATENCY') {
    const latencyRes = await handleTurnLatencyCommand(supabase, parsedCommand.hours || 24);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_TURN_LATENCY', latencyRes.details);
    return {
      isSuperadmin: true,
      reply: latencyRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_TRIAL_STATS') {
    const trialRes = await handleTrialStatsCommand(supabase, parsedCommand.days || 30);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_TRIAL_STATS', trialRes.details);
    return {
      isSuperadmin: true,
      reply: trialRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_COMMAND_CENTER') {
    const centerRes = await handleAdminCommandCenter(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_COMMAND_CENTER', centerRes.details);
    return {
      isSuperadmin: true,
      reply: centerRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_LAUNCH_STATS') {
    const launchRes = await handleLaunchStatsCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_LAUNCH_STATS', launchRes.details);
    return {
      isSuperadmin: true,
      reply: launchRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_ROLLOUT') {
    const status = await getFeatureRolloutStatus(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_ROLLOUT', {
      version: status.version,
      counts: status.counts,
      pending: status.pending
    });
    return {
      isSuperadmin: true,
      reply: formatFeatureRolloutReply(status)
    };
  }

  if (parsedCommand.intent === 'ADMIN_KB' || parsedCommand.intent === 'ADMIN_KB_REVIEW') {
    const [queue, stale] = await Promise.all([
      listKbDrafts(supabase, { limit: 20 }),
      getKbStaleRules(supabase)
    ]);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_KB_REVIEW', {
      drafts: queue.rows?.length || 0,
      stale: stale.rows?.length || 0,
      error: queue.error || null
    });
    const header = `📚 *Country KB* — ${queue.rows?.length || 0} draft(s) · ${stale.rows?.length || 0} due for re-verification.\n\n`;
    return {
      isSuperadmin: true,
      reply: `${header}${queue.ok ? formatKbQueueReply(queue.rows) : `⚠️ ${queue.error}`}\n\n${stale.ok && stale.rows.length ? formatKbStaleReply(stale.rows) : ''}`.trim()
    };
  }

  if (parsedCommand.intent === 'ADMIN_KB_STALE') {
    const stale = await getKbStaleRules(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_KB_STALE', { stale: stale.rows?.length || 0 });
    return {
      isSuperadmin: true,
      reply: stale.ok ? formatKbStaleReply(stale.rows) : `⚠️ ${stale.error}`
    };
  }

  if (parsedCommand.intent === 'ADMIN_KB_APPROVE') {
    const result = await approveKbRule(supabase, parsedCommand.rule_id, {
      adminPhone: formattedPhone,
      audit: (phone, action, details) => logAdminAudit(supabase, phone, action, details)
    });
    return {
      isSuperadmin: true,
      reply: result.ok
        ? `✅ *KB rule published*\n\n${result.rule.country_code} · ${result.rule.rule_key}\nVerified ${result.rule.verified_at}.\n\nUsers in that country now see it in *required documents*.`
        : `⚠️ Could not approve that rule: ${result.error}`
    };
  }

  if (parsedCommand.intent === 'ADMIN_KB_REJECT') {
    const result = await rejectKbRule(supabase, parsedCommand.rule_id, {
      adminPhone: formattedPhone,
      audit: (phone, action, details) => logAdminAudit(supabase, phone, action, details)
    });
    return {
      isSuperadmin: true,
      reply: result.ok
        ? `🗑️ Draft rejected: ${result.rule.country_code} · ${result.rule.rule_key}`
        : `⚠️ Could not reject that rule: ${result.error}`
    };
  }

  if (parsedCommand.intent === 'ADMIN_INCIDENTS') {
    const list = await listIncidents(supabase, { limit: 10 });
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_INCIDENTS', { open: list.rows?.length || 0 });
    return { isSuperadmin: true, reply: list.ok ? formatIncidentsReply(list.rows) : `⚠️ ${list.error}` };
  }

  if (parsedCommand.intent === 'ADMIN_INCIDENT_RESOLVE' || parsedCommand.intent === 'ADMIN_INCIDENT_SUPPRESS') {
    const isResolve = parsedCommand.intent === 'ADMIN_INCIDENT_RESOLVE';
    const options = { adminPhone: formattedPhone, note: parsedCommand.note, audit: (phone, action, details) => logAdminAudit(supabase, phone, action, details) };
    if (isResolve) options.version = FEATURE_NOTICE_VERSION;
    const result = isResolve
      ? await resolveIncident(supabase, parsedCommand.incident_id, options)
      : await suppressIncident(supabase, parsedCommand.incident_id, options);
    return {
      isSuperadmin: true,
      reply: result.ok
        ? formatIncidentResolvedReply({ status: isResolve ? 'resolved' : 'suppressed', signature: result.incident.signature })
        : `⚠️ Could not update that incident: ${result.error}`
    };
  }

  if (parsedCommand.intent === 'ADMIN_MODELS') {
    const modelsRes = await handleModelsCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_MODELS', modelsRes.details);
    return {
      isSuperadmin: true,
      reply: modelsRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_MODEL_SCOUT') {
    const scoutRes = await handleModelScoutCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_MODEL_SCOUT', scoutRes.details);
    return {
      isSuperadmin: true,
      reply: scoutRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_MODEL_ADOPT') {
    const adoptRes = await handleModelAdoptCommand(supabase, parsedCommand.model_id, parsedCommand.traffic_split);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_MODEL_ADOPT', adoptRes.details || {});
    return {
      isSuperadmin: true,
      reply: adoptRes.reply
    };
  }

  if (parsedCommand.intent === 'ADMIN_MODEL_ROLLBACK') {
    const rollbackRes = await handleModelRollbackCommand(supabase, parsedCommand.tier_slot);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_MODEL_ROLLBACK', rollbackRes.details || {});
    return {
      isSuperadmin: true,
      reply: rollbackRes.reply
    };
  }

  if (parsedCommand.intent === 'SENTINEL_DIAGNOSE') {
    let health = null;
    let friction = null;
    let recentErrors = [];
    let recentFriction = [];

    try { health = await runHealthCheck(supabase); } catch (err) { health = { error: err.message }; }
    try { friction = await evaluateConversationalFriction(supabase); } catch (err) { friction = { error: err.message }; }

    try {
      const { data } = await supabase
        .from('error_logs')
        .select('error_message, route, status, ai_diagnosis, created_at')
        .order('created_at', { ascending: false })
        .limit(5);
      recentErrors = data || [];
    } catch {}

    try {
      const { data } = await supabase
        .from('chat_friction_logs')
        .select('friction_type, transcript_snippet, detected_at')
        .order('detected_at', { ascending: false })
        .limit(5);
      recentFriction = data || [];
    } catch {}

    const telemetry = { health, friction, recentErrors, recentFriction };
    const prompt = `You are Saka Sentinel, the autonomous reliability agent for Saka Fleet.
Diagnose the following live telemetry and produce a short WhatsApp report for the superadmin:
1. Overall status (healthy / degraded / failing)
2. Root causes with evidence
3. Concrete fix proposals (ranked)
4. Any onboarding friction patterns and how to remove them
Keep it under 220 words, use WhatsApp formatting, and never invent data.

Telemetry:
${JSON.stringify(telemetry).slice(0, 6000)}`;

    const summary = await generateText({ prompt, maxTokens: 900, temperature: 0.3, purpose: 'sentinel_diagnosis' });
    await logAdminAudit(supabase, formattedPhone, 'SENTINEL_DIAGNOSE', {
      friction_detected: friction?.friction_detected || 0,
      health_status: health?.status || 'unknown'
    });

    return {
      isSuperadmin: true,
      reply: summary || '🛠️ Sentinel diagnosis completed. No AI summary was available; type "admin alerts" for raw telemetry.'
    };
  }

  if (parsedCommand.intent === 'GENERATE_COUPON') {
    const couponRes = await handleCouponGenerationCommand(supabase, formattedPhone, messageText, parsedCommand);
    await logAdminAudit(supabase, formattedPhone, 'GENERATE_COUPON', couponRes.details);
    return {
      isSuperadmin: true,
      reply: couponRes.reply
    };
  }

  if (parsedCommand.intent === 'PROFILES_REPORT') {
    const reportRes = await handleProfilesReportCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'PROFILES_REPORT', reportRes.details);
    return {
      isSuperadmin: true,
      reply: reportRes.reply
    };
  }

  await logAdminAudit(supabase, formattedPhone, 'COMMAND_HELP_REQUESTED', {
    raw_message: messageText,
    intent: parsedCommand.intent || 'UNKNOWN',
    timestamp: new Date().toISOString()
  });

  const defaultReply = `🔒 *Saka Superadmin Command Center*\n\n` +
    `Your admin session is active. You can issue the following commands:\n\n` +
    `• *Executive Report*: "admin report" (fleet digest & financials)\n` +
    `• *Vehicle Audit*: "admin audit [Plate or VIN]" (passbook history & specs)\n` +
    `• *System Alerts*: "admin alerts" (unresolved errors, friction logs & reminders)\n` +
    `• *Sentinel Dynamic Rules*: "adminrules", "adminrules reset", "adminrules toggle [key]"\n` +
    `• *System Health*: "check health", "system status"\n` +
    `• *AI Telemetry*: "admin ai-stats" or "admin usage 48h" (router cost, latency & token digest)\n` +
    `• *Reply Speed*: "admin latency" or "admin latency 48h" (p50/p95 reply time & two-lane trigger)\n` +
    `• *Conversation Evals*: "admin eval" (24h digest), "admin eval run", "admin eval last 48h", "admin eval heal <case-id>"\n` +
    `• *Model Watchdog*: "admin models", "admin model scout", "admin model adopt [model] [split]", "admin model rollback [tier_1]"\n` +
    `• *Trial Funnel*: "admin trial-stats" or "admin trial-stats 90d" (trial → paid conversion)\n` +
    `• *Launch Award*: "admin launch-stats" (first-50 slots, winners & days)\n` +
    `• *Coupon Generation*: "generate 20% coupon for +254712345678"\n` +
    `• *Profiles Report*: "profiles report", "user stats"\n` +
    `• *Autonomous Remediation*: "admin remediations", "admin accept fix FIX-YYYY-MM-DD-NN"\n` +
    `• *Update Suggestion*: "UPDATE-SUGGEST> your update description"\n` +
    `• *Close Session*: "adminstop"`;

  return {
    isSuperadmin: true,
    reply: defaultReply
  };
}

