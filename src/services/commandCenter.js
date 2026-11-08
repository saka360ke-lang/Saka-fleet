/**
 * Saka Fleet — Superadmin Command Center (v1.86.0, Phase 25)
 * ---------------------------------------------------------
 * ONE business-intelligence builder behind every superadmin surface:
 *   - the WhatsApp digest (`admin command`) and the 08:00 briefing,
 *   - the `/d/admin/command` dashboard page.
 *
 * Hard rules baked in:
 *   1. ENGINE COUNTS ONLY. No AI call, no invented figure, no projection.
 *   2. NO PII. Owner lists carry masked phones only.
 *   3. NO BILLING MATH. Money is the tier matrix's list price (rule 23/28):
 *      "estimated MRR (list prices)", never an invoice. AI cost is an
 *      approximate list-price estimate (rule 21), never a bill.
 *   4. FAIL-SOFT PER SECTION (rule 50): a missing table or a refused column
 *      marks THAT section unavailable; the rest still renders.
 *   5. READ-ONLY. Nothing in this module writes a row.
 */

import { normalizeTierKey, getTierDefinition, isPaidTierKey } from './subscriptionTiers.js';
import { getAiUsageSummary, getAiUsageByOwner } from './aiUsageLog.js';
import { maskPhone } from './webOnboarding.js';

export const COMMAND_WINDOW_DAYS = 30;
export const TRIAL_WARNING_DAYS = 3;
export const AI_COST_WINDOW_HOURS = 24;
export const AI_COST_LONG_WINDOW_HOURS = 168;

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function daysBetween(fromIso, now = new Date()) {
  if (!fromIso) return null;
  const at = new Date(fromIso).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.floor((at - new Date(now).getTime()) / (24 * 60 * 60 * 1000));
}

function hoursBetween(fromIso, now = new Date()) {
  if (!fromIso) return null;
  const at = new Date(fromIso).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((new Date(now).getTime() - at) / (60 * 60 * 1000)));
}

/** Monthly list price of one profile's plan (annual -> /12, add-ons per vehicle). */
export function monthlyListPriceUsd(profile = {}) {
  const tierKey = normalizeTierKey(profile.subscription_tier);
  if (!isPaidTierKey(tierKey)) return 0;
  const tier = getTierDefinition(tierKey);
  const interval = String(profile.billing_interval || 'monthly').toLowerCase();
  const base = interval === 'annual' ? toNumber(tier.annualUSD) / 12 : toNumber(tier.monthlyUSD);
  const addons = tier.addonEligible ? Math.max(0, Math.floor(toNumber(profile.addon_quantity))) * toNumber(tier.addonMonthlyUSD) : 0;
  return Math.round((base + addons) * 100) / 100;
}

/**
 * R1/R2/R4 — ONE profiles read covers the revenue base, the verification state
 * and the churn marker (`downgraded_at`). The slim retry keeps an un-migrated
 * table usable (rule 50).
 */
async function readProfiles(supabase) {
  const full = 'id, full_name, phone_number, email, email_verified, country_code, subscription_tier, subscription_status, subscription_period_end, subscription_expires_at, billing_interval, addon_quantity, downgraded_at, created_at';
  const slim = 'id, full_name, phone_number, subscription_tier, subscription_status, subscription_period_end, created_at';
  let { data, error } = await supabase.from('profiles').select(full).is('deleted_at', null).limit(5000);
  if (error) {
    ({ data, error } = await supabase.from('profiles').select(slim).is('deleted_at', null).limit(5000));
  }
  if (error) return null;
  return Array.isArray(data) ? data : [];
}


/** R3 — trial windows. Never throws; null marks the section unavailable. */
async function readTrials(supabase, now) {
  try {
    const { data, error } = await supabase
      .from('trial_sessions')
      .select('owner_id,status,ends_at,grace_ends_at,tier,started_at')
      .in('status', ['ACTIVE', 'EXTENDED', 'GRACE', 'EXPIRED'])
      .limit(5000);
    if (error) return null;
    const rows = Array.isArray(data) ? data : [];
    const nowMs = now.getTime();
    const warningMs = TRIAL_WARNING_DAYS * 24 * 60 * 60 * 1000;
    const expiring = rows.filter((row) => ['ACTIVE', 'EXTENDED'].includes(String(row.status || '').toUpperCase())
      && row.ends_at
      && new Date(row.ends_at).getTime() > nowMs
      && new Date(row.ends_at).getTime() <= nowMs + warningMs);
    const grace = rows.filter((row) => String(row.status || '').toUpperCase() === 'GRACE');
    const expiredCutoff = nowMs - COMMAND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const expired = rows.filter((row) => String(row.status || '').toUpperCase() === 'EXPIRED'
      && row.ends_at
      && new Date(row.ends_at).getTime() >= expiredCutoff);
    return { rows, expiring, grace, expired };
  } catch {
    return null;
  }
}

/** R5 — registered (email on file) profiles with ZERO live assets. */
async function readZeroAssetOwners(supabase, profiles) {
  try {
    const { data, error } = await supabase.from('vehicles').select('owner_id').is('deleted_at', null).limit(5000);
    if (error) return null;
    const ownersWithAssets = new Set((data || []).map((row) => row.owner_id).filter(Boolean));
    return (profiles || []).filter((profile) => profile.email && !ownersWithAssets.has(profile.id));
  } catch {
    return null;
  }
}

/** R6 — support desk. */
async function readSupport(supabase, now) {
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('id,status,priority,subject,created_at,updated_at')
      .in('status', ['OPEN', 'IN_PROGRESS', 'ESCALATED'])
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) return null;
    const rows = Array.isArray(data) ? data : [];
    const byStatus = (status) => rows.filter((row) => String(row.status || '').toUpperCase() === status).length;
    const oldest = rows[0] || null;
    return {
      open: byStatus('OPEN'),
      inProgress: byStatus('IN_PROGRESS'),
      escalated: byStatus('ESCALATED'),
      total: rows.length,
      oldestOpenHours: oldest ? hoursBetween(oldest.created_at, now) : null,
      escalatedList: rows
        .filter((row) => String(row.status || '').toUpperCase() === 'ESCALATED')
        .slice(0, 5)
        .map((row) => ({ id: row.id, subject: String(row.subject || 'Support request').slice(0, 50), ageHours: hoursBetween(row.created_at, now) }))
    };
  } catch {
    return null;
  }
}

/**
 * The ONE metrics builder. Every section is independent and fail-soft.
 */
export async function buildCommandCenterMetrics({
  supabase,
  now = new Date(),
  aiSummary = getAiUsageSummary,
  ownerUsage = getAiUsageByOwner
} = {}) {
  const generatedAt = new Date(now).toISOString();
  if (!supabase) {
    return { ok: false, generatedAt, reason: 'db_error', revenue: null, userHealth: null, support: null, ai: null, alerts: [] };
  }

  const profiles = await readProfiles(supabase);
  const trials = await readTrials(supabase, now);
  const zeroAssetOwners = profiles ? await readZeroAssetOwners(supabase, profiles) : null;
  const support = await readSupport(supabase, now);
  const ai24 = aiSummary ? await aiSummary(supabase, AI_COST_WINDOW_HOURS) : null;
  const ai7d = aiSummary ? await aiSummary(supabase, AI_COST_LONG_WINDOW_HOURS) : null;
  const perOwner = ownerUsage ? await ownerUsage(supabase, AI_COST_LONG_WINDOW_HOURS, { limit: 10 }) : null;

  /* ---------------- Revenue & churn ---------------- */
  let revenue = null;
  if (profiles) {
    const nowMs = new Date(now).getTime();
    const paidProfiles = profiles.filter((profile) => {
      const tierKey = normalizeTierKey(profile.subscription_tier);
      if (!isPaidTierKey(tierKey)) return false;
      const status = String(profile.subscription_status || '').toUpperCase();
      if (!['ACTIVE', 'CANCELING', 'PAST_DUE'].includes(status)) return false;
      const endIso = profile.subscription_period_end || profile.subscription_expires_at || null;
      if (!endIso) return true;
      return new Date(endIso).getTime() > nowMs;
    });
    const byTier = {};
    for (const profile of paidProfiles) {
      const key = normalizeTierKey(profile.subscription_tier);
      byTier[key] = (byTier[key] || 0) + 1;
    }
    const payableProfiles = paidProfiles.filter((profile) => String(profile.subscription_status || '').toUpperCase() !== 'PAST_DUE');
    const mrrUsd = payableProfiles.reduce((sum, profile) => sum + monthlyListPriceUsd(profile), 0);
    const pastDueProfiles = profiles.filter((profile) => String(profile.subscription_status || '').toUpperCase() === 'PAST_DUE');
    const churnedCutoff = nowMs - COMMAND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    revenue = {
      activePaid: payableProfiles.length,
      mrrUsd: Math.round(mrrUsd * 100) / 100,
      byTier,
      canceling: profiles.filter((profile) => String(profile.subscription_status || '').toUpperCase() === 'CANCELING').length,
      pastDue: pastDueProfiles.length,
      pastDueList: pastDueProfiles.slice(0, 5).map((profile) => ({
        id: profile.id,
        name: profile.full_name || 'Unnamed owner',
        phoneMasked: profile.phone_number ? maskPhone(profile.phone_number) : null,
        tier: normalizeTierKey(profile.subscription_tier)
      })),
      churned30d: profiles.filter((profile) => profile.downgraded_at && new Date(profile.downgraded_at).getTime() >= churnedCutoff).length,
      trialsExpiring3d: (trials?.expiring || []).length,
      trialsExpiringList: (trials?.expiring || []).slice(0, 5).map((row) => {
        const profile = profiles.find((person) => person.id === row.owner_id);
        return {
          ownerId: row.owner_id,
          name: profile?.full_name || 'Owner',
          phoneMasked: profile?.phone_number ? maskPhone(profile.phone_number) : null,
          tier: normalizeTierKey(row.tier),
          daysLeft: daysBetween(row.ends_at, now)
        };
      }),
      inGrace: (trials?.grace || []).length
    };
  }

  /* ---------------- User health ---------------- */
  let userHealth = null;
  if (profiles) {
    const paidIds = new Set(
      profiles
        .filter((profile) => isPaidTierKey(normalizeTierKey(profile.subscription_tier))
          && ['ACTIVE', 'CANCELING', 'PAST_DUE'].includes(String(profile.subscription_status || '').toUpperCase()))
        .map((profile) => profile.id)
    );
    const expiredNotConverted = (trials?.expired || []).filter((row) => !paidIds.has(row.owner_id)).length;
    userHealth = {
      totalProfiles: profiles.length,
      registered: profiles.filter((profile) => Boolean(profile.email)).length,
      shells: profiles.filter((profile) => !profile.email).length,
      emailUnverified: profiles.filter((profile) => profile.email && profile.email_verified === false).length,
      activeWithZeroAssets: zeroAssetOwners ? zeroAssetOwners.length : null,
      expiredTrialsNotConverted30d: trials ? expiredNotConverted : null
    };
  }

  /* ---------------- AI cost ---------------- */
  let ai = null;
  if (ai24 || ai7d || perOwner) {
    const attributedUsd = perOwner?.ok ? toNumber(perOwner.attributedUsd) : null;
    const attributedOwners = perOwner?.ok ? toNumber(perOwner.attributedOwners) : null;
    ai = {
      cost24hUsd: ai24?.ok ? toNumber(ai24.approxCostUsd) : null,
      cost7dUsd: ai7d?.ok ? toNumber(ai7d.approxCostUsd) : null,
      saved7dUsd: ai7d?.ok ? toNumber(ai7d.approxCostSavedUsd) : null,
      requests7d: ai7d?.ok ? toNumber(ai7d.totalRequests) : null,
      unattributedUsd: perOwner?.ok ? toNumber(perOwner.unattributedUsd) : null,
      attributedUsd,
      attributedOwners,
      costPerActiveUserUsd: attributedOwners && attributedUsd !== null
        ? Math.round((attributedUsd / attributedOwners) * 10000) / 10000
        : null,
      topPurposes: ai24?.ok
        ? Object.entries(ai24.byPurpose || {})
          .map(([purpose, bucket]) => ({ purpose, requests: toNumber(bucket.requests), costUsd: toNumber(bucket.approxCostUsd) }))
          .sort((a, b) => b.costUsd - a.costUsd)
          .slice(0, 3)
        : []
    };
  }

  /* ---------------- Deterministic alerts ---------------- */
  const alerts = [];
  if (revenue?.pastDue) alerts.push({ code: 'PAST_DUE', severity: 'warn', text: `${revenue.pastDue} account${revenue.pastDue === 1 ? '' : 's'} past due` });
  if (revenue?.trialsExpiring3d) alerts.push({ code: 'TRIAL_ENDING', severity: 'warn', text: `${revenue.trialsExpiring3d} trial${revenue.trialsExpiring3d === 1 ? '' : 's'} end within 3 days` });
  if (support?.escalated) alerts.push({ code: 'ESCALATED_TICKETS', severity: 'bad', text: `${support.escalated} escalated support ticket${support.escalated === 1 ? '' : 's'}` });
  if (userHealth?.shells) alerts.push({ code: 'SHELL_PROFILES', severity: 'info', text: `${userHealth.shells} shell profile${userHealth.shells === 1 ? '' : 's'} with no email` });
  if (userHealth?.activeWithZeroAssets) alerts.push({ code: 'EMPTY_GARAGE', severity: 'info', text: `${userHealth.activeWithZeroAssets} registered account${userHealth.activeWithZeroAssets === 1 ? '' : 's'} with no assets` });

  return {
    ok: true,
    generatedAt,
    windowDays: COMMAND_WINDOW_DAYS,
    aiHours: AI_COST_WINDOW_HOURS,
    revenue,
    userHealth,
    support,
    ai,
    alerts
  };
}

/**
 * Deterministic WhatsApp digest (zero tokens, rule 21 style). Never prints a
 * phone number; every money figure is labelled an estimate.
 */
export function formatCommandCenterDigest(metrics = {}, { full = true } = {}) {
  if (!metrics?.ok) return '📊 *Command Center* — the numbers could not be loaded just now. Please try again in a moment.';
  const rev = metrics.revenue || null;
  const health = metrics.userHealth || null;
  const support = metrics.support || null;
  const ai = metrics.ai || null;
  const money = (value) => (value === null || value === undefined ? '—' : `$${Number(value).toFixed(2)}`);
  // The pulse (non-Monday briefing block) omits the title: it already sits under
  // the briefing heading, so repeating "Command Center" would be noise.
  const lines = full
    ? ['📊 *Saka Fleet — Command Center*', `_${metrics.windowDays || COMMAND_WINDOW_DAYS} days · engine counts, no AI · est. prices_`]
    : [];

  if (full) {
    // Compact by design (rule 31): one header line per section, no blank-line
    // padding — the whole digest stays readable on one WhatsApp screen.
    if (rev) {
      lines.push('💰 *Revenue*');
      lines.push(`• Active paid: ${rev.activePaid} · est. MRR ${money(rev.mrrUsd)}/mo (list prices)`);
      lines.push(`• Trials ending ≤3d: ${rev.trialsExpiring3d} · in decision window: ${rev.inGrace}`);
      lines.push(`• Past due: ${rev.pastDue} · canceling: ${rev.canceling} · churned 30d: ${rev.churned30d}`);
    }
    if (health) {
      lines.push('👥 *User health*');
      lines.push(`• Registered ${health.registered} · shells ${health.shells} · email unverified ${health.emailUnverified}`);
      if (health.activeWithZeroAssets !== null) lines.push(`• Registered with 0 assets: ${health.activeWithZeroAssets}`);
      if (health.expiredTrialsNotConverted30d !== null) lines.push(`• Trials expired, not upgraded (30d): ${health.expiredTrialsNotConverted30d}`);
    }
    if (support) {
      lines.push('🎧 *Support*');
      lines.push(`• ${support.open} open · ${support.inProgress} in progress · ${support.escalated} escalated`);
      if (support.oldestOpenHours !== null) lines.push(`• Oldest waiting ${support.oldestOpenHours} h`);
    }
    if (ai) {
      lines.push('🧠 *AI spend*');
      lines.push(`• 24h ${money(ai.cost24hUsd)} · 7d ${money(ai.cost7dUsd)} · off-peak saved ${money(ai.saved7dUsd)}`);
      lines.push(`• ~${money(ai.costPerActiveUserUsd)} per AI-active account (${ai.attributedOwners ?? 0})`);
    }
    if (metrics.alerts?.length) {
      // Two alerts max (rule 31: never a wall of text); the overflow count points
      // at the dashboard, which lists them all.
      const shown = metrics.alerts.slice(0, 2);
      const overflow = metrics.alerts.length - shown.length;
      lines.push(`⚠️ *Needs you*${overflow > 0 ? ` (+${overflow} more on the dashboard)` : ''}`);
      for (const alert of shown) lines.push(`• ${alert.text}`);
    }
    lines.push('_`admin command` · `/d/admin/command`_');
  } else {
    // The short (non-Monday) briefing block: four lines, still honest.
    lines.push('📈 *Pulse*');
    if (rev) lines.push(`• Active paid ${rev.activePaid} · est. MRR ${money(rev.mrrUsd)}/mo · past due ${rev.pastDue}`);
    if (rev) lines.push(`• Trials ending ≤3d: ${rev.trialsExpiring3d}`);
    if (health) lines.push(`• Registered ${health.registered} · shells ${health.shells}${health.expiredTrialsNotConverted30d !== null ? ` · expired trials ${health.expiredTrialsNotConverted30d}` : ''}`);
    if (support) lines.push(`• Support ${support.open} open · ${support.escalated} escalated`);
    if (ai) lines.push(`• AI 24h ${money(ai.cost24hUsd)} · 7d ${money(ai.cost7dUsd)}`);
    lines.push('');
    lines.push('_`admin command` for the full command center_');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export default {
  COMMAND_WINDOW_DAYS,
  TRIAL_WARNING_DAYS,
  AI_COST_WINDOW_HOURS,
  AI_COST_LONG_WINDOW_HOURS,
  monthlyListPriceUsd,
  buildCommandCenterMetrics,
  formatCommandCenterDigest
};

