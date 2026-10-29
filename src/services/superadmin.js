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
import { sendAdminNotificationEmail } from './mailer.js';
import { generateText, parseJsonSafely } from './aiClient.js';
import {
  getAiUsageSummary,
  AI_USAGE_LOG_MAX_ROWS,
  computeAiBudgetStatus,
  checkAiDailyBudget,
  getAiBudgetAlertPct
} from './aiUsageLog.js';
import { formatNairobiDate } from './dateParser.js';
import { getTrialFunnelStats, formatTrialStatsReply } from './trialEngine.js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import crypto from 'crypto';

export function isSuperadminPhone(senderPhone) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  if (!superadminPhone || !senderPhone) return false;
  const clean = (p) => p.toString().replace(/[^\d]/g, '');
  return clean(senderPhone) === clean(superadminPhone);
}
export function isSuperadminEmail(email) {
  const superadminEmail = process.env.SUPERADMIN_EMAIL;
  if (!superadminEmail || !email) return false;
  return email.trim().toLowerCase() === superadminEmail.trim().toLowerCase();
}


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
  'ADMIN_REPORT', 'ADMIN_AUDIT', 'ADMIN_ALERTS',
  'ADMIN_RULES_RESET', 'ADMIN_RULES_TOGGLE', 'ADMIN_RULES_LIST',
  'ADMIN_HORIZON', 'ADMIN_PROPOSALS',
  'ADMIN_REMEDIATIONS', 'ADMIN_REMEDIATION_ACCEPT', 'ADMIN_REMEDIATION_DECLINE', 'ADMIN_REMEDIATION_MODIFY',
  'ADMIN_AI_STATS',
  'ADMIN_TRIAL_STATS',
  'HEALTH_CHECK', 'GENERATE_COUPON', 'PROFILES_REPORT', 'SENTINEL_DIAGNOSE'
]);

/**
 * Only explicit admin directives may be claimed by the superadmin hub.
 * Everything else from the superadmin phone falls through to the normal
 * Saka AI conversation (multi-role coexistence).
 */
const ADMIN_DIRECTIVE_RE = /^\s*(admin\b|adminrules?\b|check\s+health\b|health\s+check\b|system\s+(status|health|diagnostics?)\b|sentinel\b|superadmin\s+(to\s+)?sentinel\b|profiles?\s+report\b|user\s+stats\b|generate\b[^\n]*\bcoupon\b|coupon\b|horizon\b|proposals?\b)/i;

export async function parseSuperadminCommand(messageText) {
  const text = messageText ? messageText.trim() : '';
  const lower = text.toLowerCase();

  // Gate: general conversation from the superadmin phone is NOT an admin command.
  if (!ADMIN_DIRECTIVE_RE.test(text)) {
    return { intent: 'UNKNOWN' };
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

  // Phase 2 (v1.13.0): AI telemetry digest — regex first, zero LLM calls.
  const aiStatsMatch = text.match(/^\s*admin\s+(?:ai[\s_-]*(?:stats?|usage|telemetry)|usage)(?:\s+(\d{1,3})\s*h(?:ours?|rs?)?)?\s*$/i);
  if (aiStatsMatch) {
    const requestedHours = aiStatsMatch[1] ? Number(aiStatsMatch[1]) : 24;
    return { intent: 'ADMIN_AI_STATS', hours: Math.min(168, Math.max(1, requestedHours)) };
  }

  // v1.15.0: trial funnel digest (deterministic, zero LLM calls).
  const trialStatsMatch = text.match(/^\s*admin\s+trial[\s_-]*stats?(?:\s+(\d{1,3})\s*d(?:ays?)?)?\s*$/i);
  if (trialStatsMatch) {
    const requestedDays = trialStatsMatch[1] ? Number(trialStatsMatch[1]) : 30;
    return { intent: 'ADMIN_TRIAL_STATS', days: Math.min(365, Math.max(1, requestedDays)) };
  }

  // Autonomous remediation approval gateway (v1.10.0)
  if (/^\s*admin\s+remediations?\b/i.test(lower)) {
    return { intent: 'ADMIN_REMEDIATIONS' };
  }
  const acceptFixMatch = text.match(/^\s*admin\s+accept\s+fix\s+([a-zA-Z0-9-]+)/i);
  if (acceptFixMatch) {
    return { intent: 'ADMIN_REMEDIATION_ACCEPT', proposal_code: acceptFixMatch[1].toUpperCase() };
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

  const prompt = `Classify user's admin request into JSON:
Intent: "HEALTH_CHECK" | "GENERATE_COUPON" | "PROFILES_REPORT" | "ADMIN_AI_STATS" | "ADMIN_TRIAL_STATS" | "ADMIN_REPORT" | "ADMIN_AUDIT" | "ADMIN_ALERTS" | "ADMIN_RULES_RESET" | "ADMIN_RULES_TOGGLE" | "ADMIN_RULES_LIST" | "ADMIN_HORIZON" | "ADMIN_PROPOSALS" | "ADMIN_REMEDIATIONS" | "ADMIN_REMEDIATION_ACCEPT" | "ADMIN_REMEDIATION_DECLINE" | "ADMIN_REMEDIATION_MODIFY" | "UNKNOWN"
Extract: discount_value (e.g. "20%"), target_phone (e.g. "+254712345678"), query (e.g. "KDA 123A" or VIN), rule_key (e.g. "clarify_vin"), proposal_code (e.g. "FIX-2026-10-30-01"), feedback (guidance text), hours (AI telemetry window 1-168, default 24), days (trial funnel window 1-365, default 30)
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
  if (/\b(ai[\s_-]*(?:stats?|usage|telemetry)|usage\s+stats?)\b/i.test(lower)) {
    return { intent: 'ADMIN_AI_STATS', hours: 24 };
  }
  if (/\btrial[\s_-]*stats?\b/i.test(lower)) {
    return { intent: 'ADMIN_TRIAL_STATS', days: 30 };
  }
  if (/\b(profiles?|users?|drivers?|owners?)\s+(report|stats|summary|list|count)\b/i.test(lower) || /\b(user|driver|owner|profile)\s+(stats|summary|report)\b/i.test(lower)) {
    return { intent: 'PROFILES_REPORT' };
  }

  return { intent: 'UNKNOWN' };
}


export async function handleHealthCheckCommand(supabase) {
  let sentinelResult = null;
  let dbStatus = 'Disconnected';
  let unresolvedCount = 0;
  let memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  let uptimeSec = Math.floor(process.uptime());

  try {
    sentinelResult = await runHealthCheck(supabase);
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
      `• *Sentinel AI Diagnoses*: ${sentinelResult?.diagnosed_count || 0} errors reviewed`;
  }

  return {
    summary: summaryText,
    telemetry: {
      dbStatus,
      unresolvedCount,
      memoryMB,
      uptimeSec,
      diagnosedCount: sentinelResult?.diagnosed_count || 0
    }
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

  const { error } = await supabase.from('coupons').insert([{
    id: couponId,
    code: couponCode,
    discount_value: discountValue,
    assigned_to_phone: formattedTargetPhone,
    is_redeemed: false,
    created_by: adminPhone || 'SUPERADMIN_WHATSAPP',
    created_at: nowIso
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
    `• *Status*: Active & Unredeemed`;

  return {
    reply,
    details: {
      coupon_id: couponId,
      code: couponCode,
      discount_value: discountValue,
      assigned_to_phone: formattedTargetPhone,
      profile_name: profileName
    }
  };
}

export async function handleProfilesReportCommand(supabase) {
  const { count: totalProfiles } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null);

  const { data: ownersData } = await supabase
    .from('vehicles')
    .select('owner_id')
    .is('deleted_at', null);
  const uniqueOwners = new Set((ownersData || []).map(v => v.owner_id).filter(Boolean));

  const { data: driversData } = await supabase
    .from('vehicles')
    .select('assigned_driver_id')
    .is('deleted_at', null);
  const uniqueDrivers = new Set((driversData || []).map(v => v.assigned_driver_id).filter(Boolean));

  const now = new Date();
  const iso24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const iso7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { count: signups24h } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', iso24h)
    .is('deleted_at', null);

  const { count: signups7d } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', iso7d)
    .is('deleted_at', null);

  const { data: recentList } = await supabase
    .from('profiles')
    .select('full_name, phone_number, country, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(5);

  let recentFormatted = 'No recent signups found.';
  if (recentList && recentList.length > 0) {
    recentFormatted = recentList.map((p, i) => {
      const dateStr = p.created_at ? p.created_at.split('T')[0] : 'N/A';
      return `${i + 1}. *${p.full_name || 'WhatsApp User'}* (${p.phone_number}) - ${p.country || 'Global'} [${dateStr}]`;
    }).join('\n');
  }

  const reply = `📊 *Saka Fleet Profiles Report*\n\n` +
    `• *Total Registered Profiles*: ${totalProfiles || 0}\n` +
    `• *Active Vehicle Owners*: ${uniqueOwners.size}\n` +
    `• *Assigned Active Drivers*: ${uniqueDrivers.size}\n` +
    `• *New Sign-ups (Last 24h)*: ${signups24h || 0}\n` +
    `• *New Sign-ups (Last 7d)*: ${signups7d || 0}\n\n` +
    `*Recent Sign-ups*:\n${recentFormatted}`;

  return {
    reply,
    details: {
      total_profiles: totalProfiles || 0,
      active_vehicle_owners: uniqueOwners.size,
      active_assigned_drivers: uniqueDrivers.size,
      signups_24h: signups24h || 0,
      signups_7d: signups7d || 0
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
export function formatAiStatsReply(summary, budget = null) {
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
    `• Latency: avg ${formatDuration(summary.avgLatencyMs)} · p50 ${formatDuration(summary.p50LatencyMs)}\n` +
    `• Tokens: ${formatCount(summary.promptTokens)} in / ${formatCount(summary.completionTokens)} out\n` +
    `• Est. cost: ${formatApproxCost(summary.approxCostUsd, summary.unpricedTokens)} (approx list price)\n` +
    budgetLine +
    `\n` +
    `*By Tier*\n${tierLines || '• none'}\n\n` +
    `*By Provider*\n${providerLines || '• none'}\n\n` +
    `*Top Purposes*\n${purposeLines || '• none'}\n\n` +
    `_Window: ${summary.hours}h${capNote} · retention cap ${formatCount(AI_USAGE_LOG_MAX_ROWS)} rows_`;
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
 * Superadmin AI telemetry command handler (v1.13.0).
 * Returns `{ reply, details }` like every other admin command handler.
 */
export async function handleAiStatsCommand(supabase, hours = 24) {
  const summary = await getAiUsageSummary(supabase, hours);
  const budget = computeAiBudgetStatus(summary);
  return {
    reply: formatAiStatsReply(summary, budget),
    details: {
      hours: summary.hours,
      ok: summary.ok,
      total_requests: summary.totalRequests,
      ok_requests: summary.okRequests,
      error_requests: summary.errorRequests,
      error_rate: summary.errorRate,
      fallbacks: summary.fallbacks,
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
  const configKey = `ai_budget_alert_${threshold}_${formatNairobiDate(now)}`;
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

  // 2. Profiles counts
  const { count: totalProfiles } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null);

  const { data: ownersData } = await supabase
    .from('vehicles')
    .select('owner_id')
    .is('deleted_at', null);
  const uniqueOwners = new Set((ownersData || []).map(v => v.owner_id).filter(Boolean)).size;

  const { data: driversData } = await supabase
    .from('vehicles')
    .select('assigned_driver_id')
    .is('deleted_at', null);
  const uniqueDrivers = new Set((driversData || []).map(v => v.assigned_driver_id).filter(Boolean)).size;

  // 3. Financial aggregates
  const { data: expenses } = await supabase
    .from('expenses')
    .select('amount');
  const expTotal1 = expenses ? expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0) : 0;

  const { data: expLogs } = await supabase
    .from('expense_logs')
    .select('amount');
  const expTotal2 = expLogs ? expLogs.reduce((s, e) => s + (Number(e.amount) || 0), 0) : 0;
  const totalExpenses = expTotal1 + expTotal2;

  const { data: earnings } = await supabase
    .from('private_earnings')
    .select('revenue_amount');
  const totalEarnings = earnings ? earnings.reduce((s, e) => s + (Number(e.revenue_amount) || 0), 0) : 0;

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

  const netEarnings = totalEarnings - totalExpenses;

  const reply = `📊 *Saka Fleet Executive Digest & System Report*\n\n` +
    `🚗 *Fleet Overview:*\n` +
    `• Total Vehicles: ${totalVehicles} (${activeVehicles} active)\n` +
    `• Registered Profiles: ${totalProfiles || 0} (${uniqueOwners} owners, ${uniqueDrivers} drivers)\n` +
    `• Total Fleet Mileage: ${totalMileage.toLocaleString()} km\n\n` +
    `💰 *Financial Telemetry:*\n` +
    `• Total Earnings: KES ${totalEarnings.toFixed(2)}\n` +
    `• Total Expenses: KES ${totalExpenses.toFixed(2)}\n` +
    `• Net Fleet Profit: KES ${netEarnings.toFixed(2)}\n\n` +
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
      total_profiles: totalProfiles,
      total_earnings: totalEarnings,
      total_expenses: totalExpenses,
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

  const { data: vExpenses } = await supabase
    .from('expenses')
    .select('amount, expense_type, created_at')
    .eq('plate', vehicle.plate_number)
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

export async function handleAdminRemediationsList(supabase) {
  const { data: proposals, error } = await supabase
    .from('remediation_proposals')
    .select('proposal_code,title,status,risk_level,created_at')
    .order('created_at', { ascending: false })
    .limit(8);

  if (error) {
    return { reply: `⚠️ Could not load remediation proposals: ${error.message}` };
  }
  if (!proposals || proposals.length === 0) {
    return {
      reply: '🛠️ *Autonomous Remediation*\n\nNo remediation proposals exist yet. Sentinel scans the rolling audit window continuously and Cline drafts plans when thresholds trigger (requires `REMEDIATION_AUTONOMY=on`).'
    };
  }

  const formatted = proposals.map((proposal) => {
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
    return `${icon} \`${proposal.proposal_code}\` — ${proposal.title || 'Untitled'}\n   Status: *${proposal.status}* | Risk: ${String(proposal.risk_level || 'low').toUpperCase()}`;
  }).join('\n\n');

  return {
    reply: `🛠️ *Autonomous Remediation Proposals*\n\n${formatted}\n\n` +
      `_Approve:_ \`admin accept fix <CODE>\`\n` +
      `_Decline:_ \`admin decline fix <CODE>\`\n` +
      `_Modify:_ \`admin modify fix <CODE> <guidance>\``
  };
}

/**
 * Superadmin approval state machine (v1.10.0).
 * PENDING_APPROVAL / NEEDS_MODIFICATION → APPROVED (nonce minted, CI dispatched)
 *                                       | DECLINED
 *                                       | NEEDS_MODIFICATION (feedback stored, re-plan dispatched)
 */
export async function handleAdminRemediationDecision(supabase, proposalCode, decision, feedback = '') {
  const code = String(proposalCode || '').trim().toUpperCase();
  if (!code) {
    return { reply: '⚠️ Please specify a proposal code, e.g. `admin accept fix FIX-2026-10-30-01`.' };
  }
  if (!isRemediationAutonomyEnabled()) {
    return {
      reply: '🔒 *Remediation autonomy is disabled.* Set `REMEDIATION_AUTONOMY=on` to enable execution dispatch. No changes were made.'
    };
  }

  const { data: proposal, error } = await supabase
    .from('remediation_proposals')
    .select('*')
    .eq('proposal_code', code)
    .maybeSingle();

  if (error) return { reply: `⚠️ Could not load \`${code}\`: ${error.message}` };
  if (!proposal) return { reply: `⚠️ Unknown proposal \`${code}\`.` };

  const nowIso = new Date().toISOString();
  const actionable = [REMEDIATION_STATUS.PENDING_APPROVAL, REMEDIATION_STATUS.NEEDS_MODIFICATION]
    .includes(proposal.status);

  if (decision === 'accept') {
    if (!actionable) {
      return { reply: `⚠️ \`${code}\` is ${proposal.status}; only PENDING_APPROVAL or NEEDS_MODIFICATION can be approved.` };
    }

    const window = buildApprovalWindow();
    const { data: updated, error: updateErr } = await supabase
      .from('remediation_proposals')
      .update({
        status: REMEDIATION_STATUS.APPROVED,
        approval_nonce: window.approval_nonce,
        nonce_expires_at: window.nonce_expires_at,
        attempts: 0,
        reviewed_at: nowIso,
        feedback: feedback ? String(feedback).trim() : proposal.feedback
      })
      .eq('id', proposal.id)
      .select('*')
      .maybeSingle();

    if (updateErr) return { reply: `⚠️ Approval failed: ${updateErr.message}` };

    const dispatch = await dispatchExecutionForProposal(supabase, updated || proposal);
    const note = dispatch.ok
      ? 'Execution workflow dispatched. Cline will implement, run targeted tests and push; a deployment alert will follow.'
      : `Execution dispatch failed (${dispatch.error || 'unknown'}). The retry poller re-dispatches every 30 minutes (max ${REMEDIATION_MAX_ATTEMPTS} attempts).`;

    return { reply: `✅ *Approved* \`${code}\`.\n\n${note}` };
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

    const briefingMsg = `🌅 *Saka Fleet 8:00 AM Executive Morning Briefing*\n\n` +
      reportRes.reply.replace('📊 *Saka Fleet Executive Digest & System Report*\n\n', '') +
      `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
      alertsRes.reply;

    const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_WHATSAPP_TOKEN;
    if (phoneNumberId && token) {
      const cleanPhone = superadminPhone.replace(/[^\d]/g, '');
      await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
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
      timestamp: new Date().toISOString()
    });

    return briefingMsg;
  } catch (err) {
    console.error('[sendMorningExecutiveBriefing Error]:', err.message);
    return null;
  }
}

/**
 * Main Intercept Flow for Superadmin WhatsApp Messages
 */
export async function handleSuperadminFlow(supabase, senderPhone, messageText) {
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
    if (process.env.SUPERADMIN_EMAIL) {
      sendAdminNotificationEmail('🔒 Superadmin Session Started', `<p>Superadmin session was started via WhatsApp from <strong>${formattedPhone}</strong> at ${nowIso}.</p>`).catch(() => {});
    }

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
    if (process.env.SUPERADMIN_EMAIL) {
      sendAdminNotificationEmail('🔓 Superadmin Session Closed', `<p>Superadmin session was closed via WhatsApp from <strong>${formattedPhone}</strong> at ${nowIso}.</p>`).catch(() => {});
    }

    return {
      isSuperadmin: true,
      reply: '🔓 Superadmin session closed.'
    };
  }

  // 3. Parse the admin intent first so non-admin messages can fall through to
  // the normal Owner/Driver conversational flow (multi-role coexistence).
  const parsedCommand = await parseSuperadminCommand(messageText);

  if (!ADMIN_INTENTS.has(parsedCommand.intent)) {
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

  if (parsedCommand.intent === 'ADMIN_REMEDIATIONS') {
    const listRes = await handleAdminRemediationsList(supabase);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_REMEDIATIONS', {});
    return {
      isSuperadmin: true,
      reply: listRes.reply
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
      parsedCommand.feedback || ''
    );
    await logAdminAudit(supabase, formattedPhone, `ADMIN_REMEDIATION_${decision.toUpperCase()}`, {
      proposal_code: parsedCommand.proposal_code || null,
      feedback: parsedCommand.feedback || null
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
      replyText += `_Text 'admin approve [code]' to review spec._`;
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

  if (parsedCommand.intent === 'ADMIN_TRIAL_STATS') {
    const trialRes = await handleTrialStatsCommand(supabase, parsedCommand.days || 30);
    await logAdminAudit(supabase, formattedPhone, 'ADMIN_TRIAL_STATS', trialRes.details);
    return {
      isSuperadmin: true,
      reply: trialRes.reply
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
    `• *Trial Funnel*: "admin trial-stats" or "admin trial-stats 90d" (trial → paid conversion)\n` +
    `• *Coupon Generation*: "generate 20% coupon for +254712345678"\n` +
    `• *Profiles Report*: "profiles report", "user stats"\n` +
    `• *Autonomous Remediation*: "admin remediations", "admin accept fix FIX-YYYY-MM-DD-NN"\n` +
    `• *Close Session*: "adminstop"`;

  return {
    isSuperadmin: true,
    reply: defaultReply
  };
}

