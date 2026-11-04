/**
 * Saka Fleet — Launch Award (v1.58.26)
 * ------------------------------------
 * The launch campaign: the FIRST N new accounts that start their welcome trial
 * (i.e. register their first asset) receive a long, card-free award (default
 * 365 days) instead of the standard TRIAL_DAYS. Slot N+1 and everyone after
 * keeps the normal welcome flow — the fallback is automatic, not a special case.
 *
 * Invariants:
 *   • The grant is idempotent per owner (`launch_awards.owner_id` UNIQUE).
 *   • The slot PK (`slot_idx`) makes >N awards physically impossible, even with
 *     two concurrent grants (collision -> recount -> refuse/retry once).
 *   • The award extends the trial through `extendAccountTrial({ maxTotalDays })`
 *     — the normal 45-day TRIAL_MAX_TOTAL_DAYS clamp is untouched for every
 *     coupon path; only this explicit, slot-gated path may exceed it.
 *   • Every grant writes a coupon row (`created_by='LAUNCH_AWARD'`) + an audit
 *     row, so the Google-Tag event on the website has a server-side twin.
 *   • Fail-soft everywhere: a launch-award error must NEVER block the welcome
 *     trial, the vehicle save or the reply.
 */

import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { extendAccountTrial } from './trialEngine.js';

export const LAUNCH_AWARD_TABLE = 'launch_awards';
export const LAUNCH_AWARD_ACTOR = 'LAUNCH_AWARD';

export const LAUNCH_AWARD_SQL = `
CREATE TABLE IF NOT EXISTS public.${LAUNCH_AWARD_TABLE} (
    slot_idx integer PRIMARY KEY,
    owner_id uuid NOT NULL UNIQUE,
    trial_session_id uuid,
    coupon_code text,
    days integer NOT NULL DEFAULT 365,
    applied_ends_at timestamp with time zone,
    awarded_at timestamp with time zone NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT launch_awards_slot_positive CHECK (slot_idx >= 1)
);
CREATE INDEX IF NOT EXISTS idx_launch_awards_awarded_at ON public.${LAUNCH_AWARD_TABLE} (awarded_at DESC);
ALTER TABLE public.${LAUNCH_AWARD_TABLE} ENABLE ROW LEVEL SECURITY;
`;

/** The launch campaign also tags profiles with the ad campaign that brought them. */
export const LAUNCH_UTM_SQL = `
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS utm_campaign text;
`;

let tableReady = false;
let statusCache = { value: null, at: 0 };

function clampInt(raw, min, max, fallback) {
  const num = Math.floor(Number(raw));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function isOff(raw) {
  return ['off', 'false', '0', 'no', 'disabled'].includes(String(raw ?? '').trim().toLowerCase());
}

/** Campaign knobs (defaults are safe even when the env is unset). */
export function getLaunchAwardConfig(env = process.env) {
  return {
    enabled: !isOff(env?.LAUNCH_AWARD_ENABLED),
    slots: clampInt(env?.LAUNCH_MAX_FIRST_SIGNUPS, 1, 500, 50),
    days: clampInt(env?.LAUNCH_AWARD_DAYS, 30, 365, 365),
    cacheMs: clampInt(env?.LAUNCH_STATUS_CACHE_MS, 5000, 600000, 60000)
  };
}

export async function ensureLaunchUtmColumns(providedSupabase) {
  if (!providedSupabase || !hasSqlAccess()) return { status: 'skipped' };
  const result = await runSql(LAUNCH_UTM_SQL, { label: 'ensureLaunchUtmColumns' });
  return { status: result.ok ? 'ok' : 'failed' };
}

/** Ensure the launch table + UTM columns exist (fail-soft; DDL needs SQL access). */
export async function ensureLaunchAwardTable(providedSupabase) {
  if (!providedSupabase) return { status: 'no_client' };
  const { error } = await providedSupabase.from(LAUNCH_AWARD_TABLE).select('slot_idx').limit(1);
  if (!error) {
    tableReady = true;
    await ensureLaunchUtmColumns(providedSupabase);
    return { status: 'exists' };
  }
  if (hasSqlAccess()) {
    const result = await runSql(LAUNCH_AWARD_SQL, { label: 'ensureLaunchAwardTable' });
    if (result.ok) {
      tableReady = true;
      await ensureLaunchUtmColumns(providedSupabase);
      return { status: 'created' };
    }
  }
  return { status: 'missing' };
}

export function isLaunchAwardTableReady() {
  return tableReady;
}

/** Read the awarded slots (fail-closed: an error hides the campaign). */
async function readAwardRows(supabase) {
  if (!supabase) return { ok: false, rows: [] };
  try {
    const { data, error } = await supabase
      .from(LAUNCH_AWARD_TABLE)
      .select('slot_idx,owner_id,awarded_at,days,coupon_code')
      .order('slot_idx', { ascending: true })
      .limit(500);
    if (error) return { ok: false, rows: [], error: error.message };
    return { ok: true, rows: data || [] };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}

export function clearLaunchAwardCache() {
  statusCache = { value: null, at: 0 };
}

/**
 * Public campaign status (used by the website's launch banner). Cached for
 * LAUNCH_STATUS_CACHE_MS; any DB problem returns `active:false` so a broken
 * lookup can never promise an award that cannot be granted.
 */
export async function getLaunchAwardStatus({ supabase, now = new Date(), force = false, env = process.env } = {}) {
  const config = getLaunchAwardConfig(env);
  const base = {
    enabled: config.enabled,
    active: false,
    slotsTotal: config.slots,
    slotsTaken: 0,
    slotsLeft: 0,
    awardDays: config.days
  };
  if (!config.enabled) return base;
  if (!force && statusCache.value && (now.getTime() - statusCache.at) < config.cacheMs) {
    return statusCache.value;
  }
  const read = await readAwardRows(supabase);
  if (!read.ok) return base;
  const taken = new Set(read.rows.map((row) => Number(row.slot_idx))).size;
  const value = {
    ...base,
    active: taken < config.slots,
    slotsTaken: taken,
    slotsLeft: Math.max(0, config.slots - taken)
  };
  statusCache = { value, at: now.getTime() };
  return value;
}

/**
 * Take the next free slot for this owner. Returns
 * { granted:true, slot, days, row } or { granted:false, reason, ... }.
 * Never throws.
 */
export async function tryGrantLaunchAward({ supabase, ownerId, trialSessionId = null, now = new Date(), env = process.env } = {}) {
  const config = getLaunchAwardConfig(env);
  if (!config.enabled) return { granted: false, reason: 'disabled' };
  if (!supabase || !ownerId) return { granted: false, reason: 'owner-required' };

  const read = await readAwardRows(supabase);
  if (!read.ok) return { granted: false, reason: 'unavailable', error: read.error };

  const existing = read.rows.find((row) => row.owner_id === ownerId) || null;
  if (existing) {
    return { granted: true, already: true, slot: Number(existing.slot_idx), days: Number(existing.days || config.days), row: existing };
  }
  if (read.rows.length >= config.slots) {
    return { granted: false, reason: 'quota-reached', slotsTotal: config.slots, slotsTaken: read.rows.length };
  }

  const attempted = new Set();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = attempt === 0 ? read.rows : (await readAwardRows(supabase)).rows;
    const takenSlots = new Set(latest.map((row) => Number(row.slot_idx)));
    const ownRow = latest.find((row) => row.owner_id === ownerId);
    if (ownRow) return { granted: true, already: true, slot: Number(ownRow.slot_idx), days: Number(ownRow.days || config.days), row: ownRow };
    if (takenSlots.size >= config.slots) {
      return { granted: false, reason: 'quota-reached', slotsTotal: config.slots, slotsTaken: takenSlots.size };
    }
    let slot = null;
    for (let candidate = 1; candidate <= config.slots; candidate += 1) {
      if (!takenSlots.has(candidate) && !attempted.has(candidate)) { slot = candidate; break; }
    }
    if (!slot) return { granted: false, reason: 'quota-reached', slotsTotal: config.slots, slotsTaken: takenSlots.size };
    attempted.add(slot);

    const row = {
      slot_idx: slot,
      owner_id: ownerId,
      trial_session_id: trialSessionId,
      days: config.days,
      awarded_at: new Date(now).toISOString(),
      metadata: { source: 'welcome_trial' }
    };
    const { data, error } = await supabase.from(LAUNCH_AWARD_TABLE).insert([row]).select().single();
    if (!error) {
      clearLaunchAwardCache();
      return { granted: true, slot, days: config.days, row: data || row };
    }
    // 23505 = unique violation: the slot (race) or this owner (retry/return).
    if (!/23505|duplicate key|unique/i.test(String(error?.code || error?.message || ''))) {
      return { granted: false, reason: 'insert-failed', error: error.message };
    }
  }
  return { granted: false, reason: 'quota-reached', slotsTotal: config.slots };
}

async function writeLaunchAudit(supabase, action, details) {
  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: LAUNCH_AWARD_ACTOR,
      action,
      details,
      created_at: new Date().toISOString()
    }]);
  } catch { /* audit is best-effort */ }
}

/**
 * Grant the award end-to-end: slot -> coupon row -> trial extension -> audit.
 * The caller (welcome-trial completion) uses the returned copy line, never a
 * promise that was not written.
 */
export async function grantLaunchAwardForTrial({ supabase, ownerId, trial = null, phone = null, now = new Date(), env = process.env } = {}) {
  const grant = await tryGrantLaunchAward({
    supabase,
    ownerId,
    trialSessionId: trial?.id || null,
    now,
    env
  });
  if (!grant.granted) return grant;
  if (grant.already) return { ...grant, extended: false };

  const days = Number(grant.days) || getLaunchAwardConfig(env).days;
  const couponCode = `LAUNCH${days}-${grant.slot}`;
  const nowIso = new Date(now).toISOString();

  let couponStored = false;
  try {
    const { error } = await supabase.from('coupons').insert([{
      code: couponCode,
      discount_percent: 0,
      trial_extension_days: days,
      max_uses: 1,
      current_uses: 1,
      created_by: LAUNCH_AWARD_ACTOR,
      vin: null,
      assigned_to_phone: phone,
      applicable_to: 'account_trial_extension',
      redemption_type: 'trial_extension',
      status: 'applied',
      redeemed_at: nowIso,
      scheduled_dispatch_at: nowIso,
      dispatched_at: nowIso,
      expires_at: null
    }]);
    couponStored = !error;
  } catch { couponStored = false; }

  let extension = null;
  try {
    extension = await extendAccountTrial({
      supabase,
      ownerId,
      days,
      couponCode,
      maxTotalDays: days
    });
  } catch (err) {
    extension = { ok: false, error: err.message };
  }

  try {
    await supabase.from(LAUNCH_AWARD_TABLE).update({
      coupon_code: couponStored ? couponCode : null,
      trial_session_id: trial?.id || null,
      applied_ends_at: extension?.ok ? extension.endsAt : null,
      metadata: { source: 'welcome_trial', extended: Boolean(extension?.ok) }
    }).eq('slot_idx', grant.slot);
  } catch { /* metadata is best-effort */ }

  await writeLaunchAudit(supabase, 'LAUNCH_AWARD_GRANTED', {
    ownerId,
    slot: grant.slot,
    days,
    couponCode: couponStored ? couponCode : null,
    extended: Boolean(extension?.ok),
    endsAt: extension?.ok ? extension.endsAt : null
  });
  clearLaunchAwardCache();

  return {
    granted: true,
    slot: grant.slot,
    days,
    couponCode: couponStored ? couponCode : null,
    extended: Boolean(extension?.ok),
    endsAt: extension?.ok ? extension.endsAt : null,
    totalDays: extension?.ok ? extension.totalDays : null
  };
}

/** Deterministic award copy (WhatsApp-ready, zero AI tokens). */
export function formatLaunchAwardLine({ days = 365, slot = null, slotsTotal = 50 } = {}) {
  return [
    `🎉 *You're one of the first ${slotsTotal}!*`,
    '',
    `Your full-featured trial is now *${days} days* — no card, nothing to pay today.`,
    slot ? `You're launch member #${slot}.` : null,
    '',
    'Everything is unlocked: unlimited reports, reminders, drivers and documents.',
    '',
    "Keep chatting — I'll remind you before anything runs out."
  ].filter((line) => line !== null).join('\n');
}

/** Superadmin digest (`admin launch-stats`) — deterministic, zero tokens. */
export async function getLaunchAwardStats({ supabase, env = process.env } = {}) {
  const config = getLaunchAwardConfig(env);
  const read = await readAwardRows(supabase);
  const rows = read.ok ? read.rows : [];
  const taken = rows.length;
  return {
    ok: read.ok,
    enabled: config.enabled,
    slotsTotal: config.slots,
    slotsTaken: taken,
    slotsLeft: Math.max(0, config.slots - taken),
    awardDays: config.days,
    winners: rows.map((row) => ({ slot: Number(row.slot_idx), ownerId: row.owner_id, awardedAt: row.awarded_at, days: Number(row.days || config.days) }))
  };
}

export function formatLaunchStatsReply(stats = {}) {
  if (!stats || stats.ok === false) return '📊 Launch stats unavailable (database read failed).';
  const lines = [
    `🎯 *Launch Award — first ${stats.slotsTotal}*`,
    `• Status: ${stats.enabled ? (stats.slotsLeft > 0 ? 'OPEN' : 'FULL — default flow active') : 'OFF (kill switch)'}`,
    `• Slots taken: ${stats.slotsTaken} / ${stats.slotsTotal}`,
    `• Slots left: ${stats.slotsLeft}`,
    `• Award: ${stats.awardDays} days, card-free`
  ];
  if (stats.winners?.length) {
    lines.push('', '*Winners*');
    for (const winner of stats.winners.slice(0, 50)) {
      lines.push(`• #${winner.slot} — ${String(winner.ownerId).slice(0, 8)} — ${String(winner.awardedAt || '').slice(0, 10)}`);
    }
  }
  return lines.join('\n');
}

export default {
  LAUNCH_AWARD_TABLE,
  LAUNCH_AWARD_ACTOR,
  LAUNCH_AWARD_SQL,
  LAUNCH_UTM_SQL,
  getLaunchAwardConfig,
  ensureLaunchAwardTable,
  ensureLaunchUtmColumns,
  isLaunchAwardTableReady,
  getLaunchAwardStatus,
  tryGrantLaunchAward,
  grantLaunchAwardForTrial,
  formatLaunchAwardLine,
  getLaunchAwardStats,
  formatLaunchStatsReply,
  clearLaunchAwardCache
};


