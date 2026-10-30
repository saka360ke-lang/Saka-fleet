/**
 * Saka Fleet — Trial Engine (v1.15.0)
 * -----------------------------------
 * Owner-bound free trial for paid tiers:
 *   - 30 days (TRIAL_DAYS, clamped 7-90)
 *   - NO card required at trial start (nothing is charged until conversion)
 *   - one trial per owner lifetime (`profiles.trial_used_at`)
 *   - full paid-tier entitlements while TRIALING (all Tiers 0-3 AI)
 *
 * Activation ("Aha!") — strictly three events:
 *   1. vehicle_registered (vehicles row + passbook issued)
 *   2. expense_logged    (expense_logs insert)
 *   3. report_generated  (usage_counters write)
 * Reminders NEVER activate a trial (engagement metric only).
 *
 * Lifecycle nudges: T+7d activation nudge, optional T-14d midpoint,
 * T-3d value digest, T-24h urgent, T-0 expiry -> Free (PAUSED vehicles).
 */

import { getTierLocalPrice, initializePaystackCheckout } from './paystack.js';
import { generateWinback40Coupon } from './coupons.js';
import {
  getTierLabel,
  normalizeTierKey,
  isPaidTierKey
} from './subscriptionTiers.js';
import {
  downgradeToFree,
  getActiveTrialRow,
  checkoutForTier,
  invalidateEntitlements
} from './subscriptions.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export const TRIAL_DAYS = clampNumber(process.env.TRIAL_DAYS, 7, 90, 30);
export const TRIAL_MAX_TOTAL_DAYS = clampNumber(process.env.TRIAL_MAX_TOTAL_DAYS, TRIAL_DAYS, 180, 45);
export const TRIAL_ACTIVATION_COUPON_PCT = clampNumber(process.env.TRIAL_ACTIVATION_COUPON_PCT, 0, 100, 20);
export const TRIAL_ACTIVATION_COUPON_TTL_DAYS = clampNumber(process.env.TRIAL_ACTIVATION_COUPON_TTL_DAYS, 1, 30, 7);
export const TRIAL_ACTIVATION_NUDGE_HOURS = clampNumber(process.env.TRIAL_ACTIVATION_NUDGE_HOURS, 24, 24 * 14, 24 * 7);
export const TRIAL_CONVERSION_LADDER = /^(on|true|1)$/i.test(String(process.env.TRIAL_CONVERSION_LADDER || 'off'));
export const TRIAL_MIDPOINT_COUPON_PCT = clampNumber(process.env.TRIAL_MIDPOINT_COUPON_PCT, 0, 100, 15);

export const ACTIVATION_EVENTS = Object.freeze({
  VEHICLE_REGISTERED: 'vehicle_registered',
  EXPENSE_LOGGED: 'expense_logged',
  REPORT_GENERATED: 'report_generated'
});

export const ACTIVATION_EVENT_VALUES = Object.freeze(Object.values(ACTIVATION_EVENTS));

/** Runtime configuration snapshot (tests + admin digests). */
export function getTrialConfig() {
  return {
    trialDays: TRIAL_DAYS,
    maxTotalDays: TRIAL_MAX_TOTAL_DAYS,
    activationCouponPct: TRIAL_ACTIVATION_COUPON_PCT,
    activationCouponTtlDays: TRIAL_ACTIVATION_COUPON_TTL_DAYS,
    activationNudgeHours: TRIAL_ACTIVATION_NUDGE_HOURS,
    conversionLadder: TRIAL_CONVERSION_LADDER,
    midpointCouponPct: TRIAL_MIDPOINT_COUPON_PCT,
    activationEvents: [...ACTIVATION_EVENT_VALUES]
  };
}

/** `started_at + TRIAL_DAYS` as a Date. */
export function computeTrialEnd(startedAt = new Date(), days = TRIAL_DAYS) {
  return new Date(new Date(startedAt).getTime() + days * DAY_MS);
}

function daysLeft(endsAt, now = new Date()) {
  const ms = new Date(endsAt).getTime() - new Date(now).getTime();
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

async function fetchOwner(supabase, ownerId) {
  if (!supabase || !ownerId) return null;
  const { data } = await supabase
    .from('profiles')
    .select('id, phone_number, email, full_name, subscription_tier, subscription_status, billing_interval, trial_used_at')
    .eq('id', ownerId)
    .maybeSingle();
  return data || null;
}

/**
 * Find an existing open (scheduled/dispatched) account-trial extension coupon.
 * Owner-first, phone-fallback for legacy rows without `owner_id`.
 */
async function findOpenAccountExtensionCoupon(supabase, ownerId, phone = null) {
  try {
    const { data } = await supabase.from('coupons')
      .select('id, code, status, applicable_to')
      .eq('applicable_to', 'account_trial_extension')
      .eq('owner_id', ownerId)
      .neq('status', 'applied')
      .limit(1);
    if (Array.isArray(data) && data.length) return data[0];
  } catch { /* owner_id column may not exist yet on old schemas */ }
  if (phone) {
    try {
      const { data } = await supabase.from('coupons')
        .select('id, code, status, applicable_to')
        .eq('applicable_to', 'account_trial_extension')
        .eq('assigned_to_phone', phone)
        .neq('status', 'applied')
        .limit(1);
      if (Array.isArray(data) && data.length) return data[0];
    } catch { /* fail-soft */ }
  }
  return null;
}

/**
 * v1.16.0 — schedule the T-3 account-trial extension offer. Bound to the
 * OWNER ACCOUNT (coupons.owner_id + assigned_to_phone), never to a VIN.
 * Idempotent: an open offer is reused instead of duplicated.
 */
export async function scheduleAccountTrialExtensionCoupon({
  supabase,
  ownerId,
  phone = null,
  email = null,
  endsAt,
  days = 30
} = {}) {
  if (!supabase || !ownerId || !endsAt) return { ok: false, error: 'ownerId + endsAt required' };
  const existing = await findOpenAccountExtensionCoupon(supabase, ownerId, phone);
  if (existing) return { ok: true, coupon: existing, reused: true };

  const endsMs = new Date(endsAt).getTime();
  if (!Number.isFinite(endsMs)) return { ok: false, error: 'invalid trial end' };
  const now = new Date();
  const scheduledAt = new Date(endsMs - 3 * DAY_MS);
  if (scheduledAt.getTime() <= now.getTime()) {
    return { ok: false, error: 'trial ends too soon to schedule an extension offer' };
  }

  const code = `ACCT30-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const record = {
    code,
    discount_percent: 100,
    trial_extension_days: Math.max(1, Math.floor(Number(days) || 30)),
    max_uses: 1,
    current_uses: 0,
    created_by: 'ACCOUNT_TRIAL_START',
    vin: null,
    assigned_to_phone: phone || null,
    applicable_to: 'account_trial_extension',
    scheduled_dispatch_at: scheduledAt.toISOString(),
    status: 'scheduled',
    expires_at: new Date(endsMs + 7 * DAY_MS).toISOString(),
    owner_id: ownerId
  };

  try {
    let { data, error } = await supabase.from('coupons').insert([record]).select().single();
    if (error) {
      // Pre-migration fallback: retry without the owner_id column.
      const { owner_id, ...fallback } = record;
      const retry = await supabase.from('coupons').insert([fallback]).select().single();
      data = retry.data;
      error = retry.error;
    }
    if (error) return { ok: false, error: error.message };
    if (email) console.log(`[TrialEngine] Account extension offer ${code} scheduled for ${email}.`);
    return { ok: true, coupon: data, reused: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Start the one-time account trial. Idempotent: an existing active trial is
 * returned as-is; a consumed `trial_used_at` blocks a second trial.
 * NO Paystack call happens here — that is the no-card guarantee.
 */
export async function startAccountTrial({ supabase, ownerId, tierKey, interval = 'monthly', source = 'upgrade' } = {}) {
  if (!supabase || !ownerId) return { started: false, reason: 'owner required' };
  const canonicalTier = normalizeTierKey(tierKey);
  if (!isPaidTierKey(canonicalTier)) return { started: false, reason: 'paid tier required' };

  const owner = await fetchOwner(supabase, ownerId);
  if (!owner) return { started: false, reason: 'profile not found' };

  const existing = await getActiveTrialRow(supabase, ownerId);
  if (existing) {
    return {
      started: false,
      reason: 'trial_active',
      trial: existing,
      endsAt: existing.ends_at,
      daysLeft: daysLeft(existing.ends_at)
    };
  }

  if (owner.trial_used_at) return { started: false, reason: 'trial_already_used' };

  const now = new Date();
  const endsAt = computeTrialEnd(now);
  const trialSource = source === 'welcome' ? 'welcome' : 'upgrade';
  const record = {
    owner_id: ownerId,
    tier: canonicalTier,
    interval: interval === 'annual' ? 'annual' : 'monthly',
    status: 'ACTIVE',
    started_at: now.toISOString(),
    ends_at: endsAt.toISOString(),
    activated: false,
    activation_events: [],
    source: trialSource
  };

  const { data: inserted, error } = await supabase
    .from('trial_sessions')
    .insert([record])
    .select()
    .single();
  if (error) return { started: false, reason: `db:${error.message}` };

  await supabase.from('profiles').update({
    subscription_tier: canonicalTier,
    subscription_status: 'TRIALING',
    billing_interval: record.interval,
    trial_used_at: now.toISOString(),
    cancel_at_period_end: false,
    updated_at: now.toISOString()
  }).eq('id', ownerId);

  invalidateEntitlements(ownerId);

  // v1.16.0 — schedule the account-bound T-3 extension offer against the REAL
  // account trial end (never a VIN). Fire-and-forget: scheduling can never
  // block or fail the trial start.
  scheduleAccountTrialExtensionCoupon({
    supabase,
    ownerId,
    phone: owner.phone_number,
    email: owner.email,
    endsAt: record.ends_at
  }).catch(() => {});

  return {
    started: true,
    trial: inserted || record,
    tierKey: canonicalTier,
    interval: record.interval,
    source: trialSource,
    startedAt: record.started_at,
    endsAt: record.ends_at,
    days: TRIAL_DAYS
  };
}

/**
 * v1.16.4 — Free-tier Welcome Trial.
 * Every NEW owner account starts a full-featured trial at registration:
 * `solo_pro` entitlements (Tiers 0-3 AI, unlimited reports, driver assignment +
 * compliance tracking) for TRIAL_DAYS, no card, one per account lifetime.
 * Lapse is handled by the existing sweep: EXPIRED -> downgradeToFree (excess
 * vehicles PAUSED). An upgrade converts the trial via `subscription.create`.
 */
export async function startWelcomeTrial({ supabase, ownerId } = {}) {
  if (!supabase || !ownerId) return { started: false, reason: 'owner required' };
  return startAccountTrial({
    supabase,
    ownerId,
    tierKey: 'solo_pro',
    interval: 'monthly',
    source: 'welcome'
  });
}

/** Active trial row + derived status for a profile. */
export async function getTrialStatus({ supabase, ownerId, now = new Date() } = {}) {
  const trial = await getActiveTrialRow(supabase, ownerId);
  if (!trial) return { active: false, trial: null, daysLeft: 0 };
  return {
    active: true,
    trial,
    tierKey: normalizeTierKey(trial.tier),
    daysLeft: daysLeft(trial.ends_at, now),
    endsAt: trial.ends_at,
    activated: Boolean(trial.activated)
  };
}

/** Create the one-per-trial activation discount coupon (7-day TTL by default). */
export async function issueActivationCoupon({ supabase, trial, owner = null, percent = TRIAL_ACTIVATION_COUPON_PCT, ttlDays = TRIAL_ACTIVATION_COUPON_TTL_DAYS } = {}) {
  if (!supabase || !trial?.owner_id || !percent) return null;
  const code = `ACTIVATE${Math.round(percent)}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * DAY_MS).toISOString();
  const phone = owner?.phone_number || null;
  try {
    const { data: inserted } = await supabase.from('coupons').insert([{
      code,
      discount_percent: percent,
      trial_extension_days: 0,
      max_uses: 1,
      current_uses: 0,
      created_by: 'TRIAL_ACTIVATION',
      vin: null,
      assigned_to_phone: phone,
      applicable_to: 'subscription',
      applies_to_tier: normalizeTierKey(trial.tier),
      applies_to_interval: 'both',
      redemption_type: 'percent',
      scheduled_dispatch_at: now.toISOString(),
      dispatched_at: now.toISOString(),
      status: 'dispatched',
      expires_at: expiresAt
    }]).select().single();
    return inserted || null;
  } catch {
    return null;
  }
}

/**
 * Record an activation event. The FIRST of the three events activates the
 * trial and issues the activation coupon. Idempotent per event key.
 */
export async function recordActivationEvent({ supabase, ownerId, event } = {}) {
  if (!supabase || !ownerId || !event) return { recorded: false, reason: 'owner/event required' };
  const eventKey = String(event).toLowerCase();
  if (!ACTIVATION_EVENT_VALUES.includes(eventKey)) {
    return { recorded: false, reason: `unknown activation event: ${eventKey}` };
  }

  const trial = await getActiveTrialRow(supabase, ownerId);
  if (!trial) return { recorded: false, reason: 'no active trial' };

  const events = Array.isArray(trial.activation_events) ? trial.activation_events : [];
  if (!events.includes(eventKey)) {
    const nowIso = new Date().toISOString();
    const nextEvents = [...events, eventKey];
    const alreadyActivated = Boolean(trial.activated);
    await supabase.from('trial_sessions').update({
      activation_events: nextEvents,
      activated: true,
      activated_at: trial.activated_at || nowIso,
      updated_at: nowIso
    }).eq('id', trial.id);

    let coupon = null;
    if (!alreadyActivated) {
      const owner = await fetchOwner(supabase, ownerId);
      coupon = await issueActivationCoupon({ supabase, trial, owner });
    }
    return { recorded: true, activatedNow: !alreadyActivated, events: nextEvents, coupon };
  }

  return { recorded: false, duplicate: true, activated: Boolean(trial.activated) };
}

/**
 * Extend the active trial (coupon redemption). Cumulative trial lifetime is
 * capped by TRIAL_MAX_TOTAL_DAYS so extensions can never run forever.
 */
export async function extendAccountTrial({ supabase, ownerId, days = 15, couponCode = null } = {}) {
  if (!supabase || !ownerId) return { ok: false, error: 'owner required' };
  const trial = await getActiveTrialRow(supabase, ownerId);
  if (!trial) return { ok: false, error: 'No active trial to extend.' };

  const requested = Math.max(1, Math.floor(Number(days) || 15));
  const startedMs = new Date(trial.started_at).getTime();
  const currentEndMs = new Date(trial.ends_at).getTime();
  const baseMs = Math.max(Date.now(), currentEndMs);
  const hardCapMs = startedMs + TRIAL_MAX_TOTAL_DAYS * DAY_MS;
  const newEndMs = Math.min(baseMs + requested * DAY_MS, hardCapMs);

  if (newEndMs <= baseMs) {
    return { ok: false, error: `Trial extension limit reached (${TRIAL_MAX_TOTAL_DAYS} days total).` };
  }

  const nowIso = new Date().toISOString();
  const newEndIso = new Date(newEndMs).toISOString();
  const { error } = await supabase.from('trial_sessions').update({
    ends_at: newEndIso,
    status: 'EXTENDED',
    coupon_code: couponCode || trial.coupon_code || null,
    nudge_midpoint_sent_at: null,
    nudge_t3_sent_at: null,
    nudge_t24_sent_at: null,
    expiry_processed_at: null,
    updated_at: nowIso
  }).eq('id', trial.id);
  if (error) return { ok: false, error: error.message };

  // Re-arm the T-3 extension offer against the NEW account trial end.
  const owner = await fetchOwner(supabase, ownerId);
  scheduleAccountTrialExtensionCoupon({
    supabase,
    ownerId,
    phone: owner?.phone_number || null,
    email: owner?.email || null,
    endsAt: newEndIso
  }).catch(() => {});

  return {
    ok: true,
    endsAt: newEndIso,
    daysAdded: Math.round((newEndMs - baseMs) / DAY_MS),
    totalDays: Math.round((newEndMs - startedMs) / DAY_MS),
    capped: newEndMs >= hardCapMs
  };
}

/** Value metrics for the T-3 digest (all deterministic, zero AI tokens). */
export async function buildTrialMetrics({ supabase, ownerId, trial } = {}) {
  const startedIso = trial?.started_at ? new Date(trial.started_at).toISOString() : new Date().toISOString();
  const metrics = { vehicles: 0, expenses: 0, reports: 0, reminders: 0, aiAnswers: 0, hoursSaved: 0 };
  if (!supabase || !ownerId) return metrics;

  try {
    const { data: vehicles } = await supabase
      .from('vehicles')
      .select('id')
      .eq('owner_id', ownerId)
      .is('deleted_at', null);
    const ids = (vehicles || []).map((v) => v.id);
    metrics.vehicles = ids.length;

    if (ids.length > 0) {
      const { count: expenseCount } = await supabase
        .from('expense_logs')
        .select('id', { count: 'exact', head: true })
        .in('vehicle_id', ids)
        .gte('created_at', startedIso);
      metrics.expenses = expenseCount || 0;

      const { count: reminderCount } = await supabase
        .from('reminders')
        .select('id', { count: 'exact', head: true })
        .in('vehicle_id', ids)
        .gte('created_at', startedIso);
      metrics.reminders = reminderCount || 0;
    }

    const { data: counters } = await supabase
      .from('usage_counters')
      .select('report_count, last_report_at')
      .eq('owner_id', ownerId);
    metrics.reports = (counters || [])
      .filter((row) => row.last_report_at && new Date(row.last_report_at).getTime() >= new Date(startedIso).getTime())
      .reduce((sum, row) => sum + Number(row.report_count || 0), 0);

    const { count: aiCount } = await supabase
      .from('ai_usage_logs')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .gte('created_at', startedIso);
    metrics.aiAnswers = aiCount || 0;
  } catch {
    /* degrade to whatever was collected */
  }

  const minutes = metrics.expenses * 2 + metrics.reports * 20 + metrics.reminders * 5;
  metrics.hoursSaved = Math.round((minutes / 60) * 10) / 10;
  return metrics;
}

function activationNudgeText(ownerName, tierLabel) {
  return `👋 *Getting the most from your Saka ${tierLabel} trial*\n\nYour 30-day trial is running, ${ownerName || 'there'}. The fastest way to see Saka's value:\n\n1️⃣ Reply *"log expense"* — track your first fuel/service cost\n2️⃣ Reply *"register car"* — add a vehicle + passbook\n3️⃣ Reply *"report"* — get a fleet report\n\nEverything is unlocked: full AI, unlimited reports, compliance tracking.`;
}

function activationRewardText({ ownerName, tierLabel, coupon, checkoutUrl, priceLabel }) {
  const lines = [
    `🎉 *You just unlocked the full Saka experience!*`,
    '',
    `${ownerName || 'Your'} ${tierLabel} trial is live and your first value moment is done.`,
    ''
  ];
  if (coupon?.code) {
    lines.push(`🎁 *Your reward:* \`${coupon.code}\` — ${coupon.discount_percent}% off your first paid cycle (expires ${new Date(coupon.expires_at).toLocaleDateString()}).`);
  }
  if (priceLabel) lines.push(`Plan price: ${priceLabel}`);
  if (checkoutUrl) lines.push(`\n👉 *Lock in your plan:* ${checkoutUrl}`);
  lines.push('\nNo card is needed until you decide to convert — keep exploring.');
  return lines.join('\n');
}

function t3DigestText({ ownerName, tierLabel, trial, metrics, priceLabel, annualLabel, checkoutUrl }) {
  return `📊 *Your Saka Fleet ${tierLabel} trial ends in 3 days!*\n\nHere's what you built, ${ownerName || 'there'}:\n` +
    `• 🚗 ${metrics.vehicles} vehicle(s) managed\n` +
    `• 💰 ${metrics.expenses} expense(s) logged\n` +
    `• 🔔 ${metrics.reminders} reminder(s) set\n` +
    `• 📄 ${metrics.reports} report(s) generated\n` +
    `• 🧠 ${metrics.aiAnswers} question(s) answered by Saka\n` +
    `• ⏱️ ≈${metrics.hoursSaved} hour(s) saved vs manual tracking\n\n` +
    `Keep everything unlocked: *${priceLabel || `${tierLabel} plan`}*${annualLabel ? ` (or ${annualLabel} annually)` : ''}.\n` +
    `👉 ${checkoutUrl || 'https://sakafleet.com/pricing'}\n\n` +
    `Trial ends ${new Date(trial.ends_at).toLocaleDateString()}.`;
}

function t24Text({ tierLabel, trial, checkoutUrl }) {
  return `⏳ *24 hours left on your ${tierLabel} trial*\n\nYour trial ends ${new Date(trial.ends_at).toLocaleDateString()}. After that your account moves to Free (1 vehicle, 1 report/month, Tier-1 AI) and extra vehicles are paused — nothing is deleted.\n\n👉 Activate your plan: ${checkoutUrl || 'https://sakafleet.com/pricing'}`;
}

function expiryText({ tierLabel, pausedPlates, checkoutUrl }) {
  const lines = [
    `📦 *Your ${tierLabel} trial has ended*`,
    '',
    'Your account is now on the Free plan: 1 active vehicle, 1 report/month, Tier-1 AI. Your data is safe.'
  ];
  if (pausedPlates?.length) {
    lines.push(`\n⏸️ Paused vehicles: ${pausedPlates.join(', ')}`);
    lines.push(`Reply *"keep vehicle ${pausedPlates[0]}"* (or another plate) to choose which one stays active.`);
  }
  lines.push(`\n🚀 Ready to unlock everything again? ${checkoutUrl || 'https://sakafleet.com/pricing'}`);
  return lines.join('\n');
}

async function buildNudgeCheckout({ supabase, owner, trial, currency }) {
  try {
    const res = await checkoutForTier({
      supabase,
      owner: owner || { id: trial.owner_id },
      targetTierKey: trial.tier,
      interval: trial.interval || 'monthly',
      currency,
      couponCode: trial.coupon_code || null
    });
    return res.ok ? res.checkoutUrl : (process.env.PUBLIC_PRICING_URL || 'https://sakafleet.com/pricing');
  } catch {
    return process.env.PUBLIC_PRICING_URL || 'https://sakafleet.com/pricing';
  }
}

async function stampTrial(supabase, trialId, patch) {
  try {
    await supabase.from('trial_sessions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', trialId);
  } catch { /* fail-soft */ }
}

/** Deterministic T-3 extension-offer copy (zero AI tokens). */
function accountExtensionOfferText({ ownerName, coupon, trial }) {
  const ends = trial?.ends_at ? new Date(trial.ends_at).toLocaleDateString() : 'soon';
  return `🎁 *Your Saka trial ends in 3 days* — ${ownerName || 'there'}\n\n` +
    `Your account trial ends ${ends}. Coupon *${coupon.code}* adds 30 free days and applies to the whole account — not one vehicle.\n\n` +
    `Reply *"extend trial ${coupon.code}"* (or just *"extend trial"*).`;
}

/** Deterministic 15-day overdue winback copy. */
function winbackText({ coupon, checkoutUrl }) {
  return `🎁 *Special offer from Saka Fleet*\n\nYour Saka trial ended 15 days ago. For the next 15 days only, take *40% OFF* your first year:\n\n` +
    `• Coupon: *${coupon.code}*\n• Expires: ${new Date(coupon.expires_at).toLocaleDateString()}\n\n` +
    `👉 Claim your offer: ${checkoutUrl || 'https://sakafleet.com/pricing'}`;
}

async function findActiveTrialByPhone(supabase, phone) {
  try {
    const { data: profile } = await supabase.from('profiles').select('id').eq('phone_number', phone).maybeSingle();
    if (!profile?.id) return null;
    return await getActiveTrialRow(supabase, profile.id);
  } catch {
    return null;
  }
}

/**
 * Dispatch due account-bound extension offers (scheduled T-3). Only a LIVE
 * account trial may receive the offer; otherwise the coupon is superseded so
 * it can never send a phantom message.
 */
async function dispatchDueAccountTrialCoupons({ supabase, sendWhatsAppFn, now = new Date(), stats }) {
  if (!supabase) return;
  try {
    const { data: due } = await supabase
      .from('coupons')
      .select('*')
      .eq('applicable_to', 'account_trial_extension')
      .eq('status', 'scheduled')
      .lte('scheduled_dispatch_at', now.toISOString())
      .limit(50);
    for (const coupon of due || []) {
      const trial = (coupon.owner_id ? await getActiveTrialRow(supabase, coupon.owner_id) : null)
        || (coupon.assigned_to_phone ? await findActiveTrialByPhone(supabase, coupon.assigned_to_phone) : null);
      if (!trial) {
        await supabase.from('coupons').update({ status: 'superseded', updated_at: now.toISOString() }).eq('id', coupon.id);
        continue;
      }
      const owner = await fetchOwner(supabase, trial.owner_id);
      const phone = coupon.assigned_to_phone || owner?.phone_number;
      if (phone && sendWhatsAppFn) {
        await sendWhatsAppFn(phone, accountExtensionOfferText({ ownerName: owner?.full_name, coupon, trial })).catch(() => {});
        stats.sent = (stats.sent || 0) + 1;
        stats.extensionOffers = (stats.extensionOffers || 0) + 1;
      }
      await supabase.from('coupons').update({
        status: 'dispatched',
        dispatched_at: now.toISOString(),
        whatsapp_notified: Boolean(phone),
        updated_at: now.toISOString()
      }).eq('id', coupon.id);
    }
  } catch (err) {
    console.warn('[TrialEngine] Account coupon dispatch skipped:', err.message);
  }
}

/**
 * 15-day overdue winback, rebased on ACCOUNT state (trial_sessions.EXPIRED).
 * Never reads vehicles.trial_end_at — the phantom VIN clock is retired.
 */
async function processAccountWinbacks({ supabase, sendWhatsAppFn, now = new Date(), stats }) {
  if (!supabase || !sendWhatsAppFn) return;
  try {
    const from = new Date(now.getTime() - 16 * DAY_MS).toISOString();
    const to = new Date(now.getTime() - 15 * DAY_MS).toISOString();
    const { data: expiredTrials } = await supabase
      .from('trial_sessions')
      .select('*')
      .eq('status', 'EXPIRED')
      .gte('ends_at', from)
      .lte('ends_at', to)
      .limit(20);

    for (const trial of expiredTrials || []) {
      const owner = await fetchOwner(supabase, trial.owner_id);
      if (!owner?.phone_number) continue;
      const status = String(owner.subscription_status || '').toUpperCase();
      if (isPaidTierKey(normalizeTierKey(owner.subscription_tier)) && ['ACTIVE', 'TRIALING'].includes(status)) {
        continue; // converted since expiry — never send a winback
      }
      const { data: existing } = await supabase
        .from('coupons')
        .select('id')
        .eq('assigned_to_phone', owner.phone_number)
        .eq('applicable_to', 'annual_subscription')
        .limit(1);
      if (Array.isArray(existing) && existing.length) continue;

      const coupon = await generateWinback40Coupon({
        ownerPhone: owner.phone_number,
        ownerId: trial.owner_id,
        vin: null,
        supabase
      });
      if (!coupon) continue;

      const checkout = await initializePaystackCheckout({
        supabase,
        userPhone: owner.phone_number,
        targetTierKey: normalizeTierKey(trial.tier) || 'solo_pro',
        billingInterval: 'annual',
        userEmail: owner.email,
        userId: trial.owner_id,
        currency: 'USD'
      }).catch(() => null);

      await sendWhatsAppFn(owner.phone_number, winbackText({ coupon, checkoutUrl: checkout?.checkoutUrl })).catch(() => {});
      stats.sent = (stats.sent || 0) + 1;
      stats.winbacks = (stats.winbacks || 0) + 1;
    }
  } catch (err) {
    console.warn('[TrialEngine] Winback sweep skipped:', err.message);
  }
}

/* ---------------- v1.16.3 — PAST_DUE dunning & silent re-engagement ---------------- */

const PAST_DUE_GRACE_DAYS = clampNumber(process.env.SUBSCRIPTION_GRACE_DAYS, 1, 30, 3);

/** Deterministic dunning copy (engine-owned link, never an invented amount). */
function dunningText({ ownerName, tierLabel, daysPast, daysLeft, checkoutUrl }) {
  const left = Math.max(0, daysLeft);
  return `💳 *Your ${tierLabel} renewal did not go through* — ${ownerName || 'there'}\n\n` +
    `It is ${daysPast} day(s) past due. You still have about ${left} day(s) in the grace window before the account moves to Free (extra vehicles are paused, never deleted).\n\n` +
    `👉 *Renew now:* ${checkoutUrl || 'https://sakafleet.com/pricing'}\n\n` +
    `No price change and no data loss — the same plan simply continues.`;
}

/**
 * T+1 / T+3 dunning ladder for PAST_DUE accounts. Two notices max, deduped via
 * past_due_notice_count; counters heal automatically once the account is no
 * longer PAST_DUE. Always includes the engine's own renewal checkout link.
 */
export async function processPastDueDunning({ supabase, sendWhatsAppFn, now = new Date(), stats, checkoutFn = initializePaystackCheckout }) {
  if (!supabase || !sendWhatsAppFn) return;
  try {
    const oneDayAgo = new Date(now.getTime() - DAY_MS).toISOString();
    const { data: pastDue } = await supabase
      .from('profiles')
      .select('*')
      .eq('subscription_status', 'PAST_DUE')
      .lte('subscription_period_end', oneDayAgo)
      .limit(20);

    for (const owner of pastDue || []) {
      if (!owner.phone_number) continue;
      const count = Number(owner.past_due_notice_count || 0);
      if (count >= 2) continue;
      const periodEnd = new Date(owner.subscription_period_end).getTime();
      if (!Number.isFinite(periodEnd)) continue;
      const daysPast = Math.floor((now.getTime() - periodEnd) / DAY_MS);
      const due = count === 0 ? daysPast >= 1 : daysPast >= 3;
      if (!due) continue;

      const tierKey = normalizeTierKey(owner.subscription_tier);
      const checkout = await checkoutFn({
        supabase,
        userPhone: owner.phone_number,
        targetTierKey: tierKey,
        billingInterval: owner.billing_interval === 'annual' ? 'annual' : 'monthly',
        userEmail: owner.email,
        userId: owner.id,
        currency: 'USD'
      }).catch(() => null);

      await sendWhatsAppFn(owner.phone_number, dunningText({
        ownerName: owner.full_name,
        tierLabel: getTierLabel(tierKey),
        daysPast,
        daysLeft: PAST_DUE_GRACE_DAYS - daysPast,
        checkoutUrl: checkout?.checkoutUrl
      })).catch(() => {});

      await supabase.from('profiles').update({
        past_due_notice_count: count + 1,
        past_due_notified_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
      }).eq('id', owner.id);

      stats.sent += 1;
      stats.dunning = (stats.dunning || 0) + 1;
    }

    // Heal counters when the account is no longer PAST_DUE (renewed/resumed).
    const { data: stale } = await supabase
      .from('profiles')
      .select('id, subscription_status, past_due_notice_count')
      .gte('past_due_notice_count', 1)
      .limit(50);
    for (const row of stale || []) {
      if (String(row.subscription_status || '').toUpperCase() === 'PAST_DUE') continue;
      await supabase.from('profiles').update({
        past_due_notice_count: 0,
        past_due_notified_at: null,
        updated_at: new Date(now).toISOString()
      }).eq('id', row.id);
    }
  } catch (err) {
    console.warn('[TrialEngine] Dunning sweep skipped:', err.message);
  }
}

/** Deterministic 14-day re-engagement copy. */
function reengagementText({ ownerName }) {
  return `👋 *Quick win for your fleet* — ${ownerName || 'there'}\n\n` +
    `It has been a couple of weeks. Log one expense today (e.g. _"fuel 3000"_) and Saka keeps your cost-per-km, reminders and compliance dates accurate.\n\n` +
    `Reply *"passbook details"* for an instant snapshot, or *"help"* to see everything.`;
}

/**
 * 14-day silence nudge: owners with an active vehicle and no chat for 13-15
 * days get ONE deterministic tip. Deduped by profiles.reengage_nudged_at and
 * capped at 10 sends per sweep.
 */
export async function processSilentReengagement({ supabase, sendWhatsAppFn, now = new Date(), stats }) {
  if (!supabase || !sendWhatsAppFn) return;
  try {
    const { data: transcripts } = await supabase
      .from('chat_transcripts')
      .select('phone_number,created_at')
      .order('created_at', { ascending: false })
      .limit(400);

    const lastSeen = new Map();
    for (const row of transcripts || []) {
      const digits = String(row.phone_number || '').replace(/[^0-9]/g, '');
      if (!digits || lastSeen.has(digits)) continue;
      lastSeen.set(digits, new Date(row.created_at).getTime());
    }

    const quietSince = now.getTime() - 15 * DAY_MS;
    const quietUntil = now.getTime() - 13 * DAY_MS;
    let sent = 0;
    for (const [digits, timestamp] of lastSeen) {
      if (!Number.isFinite(timestamp) || timestamp > quietUntil || timestamp < quietSince) continue;
      const phone = `+${digits}`;
      if (process.env.SUPERADMIN_PHONE && phone === process.env.SUPERADMIN_PHONE) continue;

      const { data: owner } = await supabase.from('profiles').select('*').eq('phone_number', phone).maybeSingle();
      if (!owner?.id || owner.reengage_nudged_at || owner.deleted_at) continue;

      const { data: vehicles } = await supabase
        .from('vehicles')
        .select('id')
        .eq('owner_id', owner.id)
        .is('deleted_at', null)
        .limit(1);
      if (!Array.isArray(vehicles) || vehicles.length === 0) continue;

      await sendWhatsAppFn(phone, reengagementText({ ownerName: owner.full_name })).catch(() => {});
      await supabase.from('profiles').update({
        reengage_nudged_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
      }).eq('id', owner.id);

      sent += 1;
      stats.sent += 1;
      stats.reengaged = (stats.reengaged || 0) + 1;
      if (sent >= 10) break;
    }
  } catch (err) {
    console.warn('[TrialEngine] Re-engagement sweep skipped:', err.message);
  }
}

/**
 * Trial lifecycle sweep (15-minute tick in index.js).
 * Each stage fires exactly once per trial, guarded by one-shot timestamps.
 */
export async function runTrialLifecycleSweep({ supabase, sendWhatsAppFn = null, now = new Date(), limit = 100 } = {}) {
  const stats = { scanned: 0, sent: 0, activationNudges: 0, midpoint: 0, t3: 0, t24: 0, expired: 0, extensionOffers: 0, winbacks: 0, dunning: 0, reengaged: 0 };
  if (!supabase) return stats;

  const { data: trials, error } = await supabase
    .from('trial_sessions')
    .select('*')
    .in('status', ['ACTIVE', 'EXTENDED'])
    .limit(limit);
  if (error || !trials?.length) return stats;

  for (const trial of trials) {
    stats.scanned += 1;
    const owner = await fetchOwner(supabase, trial.owner_id);
    const phone = owner?.phone_number || null;
    const tierLabel = getTierLabel(trial.tier);
    const endsMs = new Date(trial.ends_at).getTime();
    const startedMs = new Date(trial.started_at).getTime();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    // ---- T-0: expire -> Free (PAUSED vehicles, data preserved) ----
    if (nowMs >= endsMs) {
      await stampTrial(supabase, trial.id, { status: 'EXPIRED', expiry_processed_at: nowIso });
      const downgraded = await downgradeToFree({ supabase, ownerId: trial.owner_id, reason: 'trial.expired' });
      stats.expired += 1;
      if (phone && sendWhatsAppFn) {
        const pausedPlates = (downgraded.paused || []).map((v) => v.plate_number).filter(Boolean);
        const checkoutUrl = await buildNudgeCheckout({ supabase, owner, trial, currency: owner?.currency || 'USD' });
        await sendWhatsAppFn(phone, expiryText({ tierLabel, pausedPlates, checkoutUrl })).catch(() => {});
        stats.sent += 1;
      }
      continue;
    }

    // ---- activation reward (one sweep after the first "aha" event) ----
    if (trial.activated && !trial.nudge_activation_sent_at) {
      await stampTrial(supabase, trial.id, { nudge_activation_sent_at: nowIso });
      if (phone && sendWhatsAppFn) {
        let coupon = null;
        try {
          const { data: couponRow } = await supabase
            .from('coupons')
            .select('*')
            .eq('assigned_to_phone', phone)
            .eq('created_by', 'TRIAL_ACTIVATION')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          coupon = couponRow || null;
        } catch { /* coupon is optional */ }
        const currency = owner?.currency || 'USD';
        const price = await getTierLocalPrice(supabase, trial.tier, currency, trial.interval || 'monthly').catch(() => null);
        const checkoutUrl = await buildNudgeCheckout({ supabase, owner, trial, currency });
        await sendWhatsAppFn(phone, activationRewardText({
          ownerName: owner?.full_name,
          tierLabel,
          coupon: coupon ? {
            code: coupon.code,
            discount_percent: coupon.discount_percent,
            expires_at: coupon.expires_at
          } : null,
          checkoutUrl,
          priceLabel: price?.formattedPrice
            ? `${price.formattedPrice}/${trial.interval === 'annual' ? 'year' : 'month'}`
            : null
        })).catch(() => {});
        stats.sent += 1;
        stats.activationRewards = (stats.activationRewards || 0) + 1;
      }
      continue;
    }

    // ---- T+7d activation nudge (not activated only) ----
    if (!trial.activated && !trial.nudge_activation_sent_at
      && nowMs >= startedMs + TRIAL_ACTIVATION_NUDGE_HOURS * 60 * 60 * 1000) {
      await stampTrial(supabase, trial.id, { nudge_activation_sent_at: nowIso });
      if (phone && sendWhatsAppFn) {
        await sendWhatsAppFn(phone, activationNudgeText(owner?.full_name, tierLabel)).catch(() => {});
        stats.sent += 1;
        stats.activationNudges += 1;
      }
      continue;
    }

    // ---- optional T-14d midpoint recap ----
    if (TRIAL_CONVERSION_LADDER && !trial.nudge_midpoint_sent_at
      && nowMs >= endsMs - 14 * DAY_MS && nowMs < endsMs - 3 * DAY_MS) {
      await stampTrial(supabase, trial.id, { nudge_midpoint_sent_at: nowIso });
      if (phone && sendWhatsAppFn) {
        const metrics = await buildTrialMetrics({ supabase, ownerId: trial.owner_id, trial });
        const checkoutUrl = await buildNudgeCheckout({ supabase, owner, trial, currency: owner?.currency || 'USD' });
        await sendWhatsAppFn(phone, t3DigestText({
          ownerName: owner?.full_name, tierLabel, trial, metrics,
          priceLabel: null, annualLabel: null, checkoutUrl
        })).catch(() => {});
        stats.sent += 1;
        stats.midpoint += 1;
      }
      continue;
    }

    // ---- T-3d value digest ----
    if (!trial.nudge_t3_sent_at && nowMs >= endsMs - 3 * DAY_MS) {
      await stampTrial(supabase, trial.id, { nudge_t3_sent_at: nowIso });
      if (phone && sendWhatsAppFn) {
        const currency = owner?.currency || 'USD';
        const metrics = await buildTrialMetrics({ supabase, ownerId: trial.owner_id, trial });
        const monthly = await getTierLocalPrice(supabase, trial.tier, currency, 'monthly').catch(() => null);
        const annual = await getTierLocalPrice(supabase, trial.tier, currency, 'annual').catch(() => null);
        const checkoutUrl = await buildNudgeCheckout({ supabase, owner, trial, currency });
        await sendWhatsAppFn(phone, t3DigestText({
          ownerName: owner?.full_name, tierLabel, trial, metrics,
          priceLabel: monthly?.formattedPrice ? `${monthly.formattedPrice}/month` : null,
          annualLabel: annual?.formattedPrice ? `${annual.formattedPrice}/year` : null,
          checkoutUrl
        })).catch(() => {});
        stats.sent += 1;
        stats.t3 += 1;
      }
      continue;
    }

    // ---- T-24h urgent reminder ----
    if (!trial.nudge_t24_sent_at && nowMs >= endsMs - DAY_MS) {
      await stampTrial(supabase, trial.id, { nudge_t24_sent_at: nowIso });
      if (phone && sendWhatsAppFn) {
        const checkoutUrl = await buildNudgeCheckout({ supabase, owner, trial, currency: owner?.currency || 'USD' });
        await sendWhatsAppFn(phone, t24Text({ tierLabel, trial, checkoutUrl })).catch(() => {});
        stats.sent += 1;
        stats.t24 += 1;
      }
      continue;
    }
  }

  // v1.16.0 — account-bound coupon dispatch + winback run in the SAME worker
  // so trials can never produce two competing message streams.
  await dispatchDueAccountTrialCoupons({ supabase, sendWhatsAppFn, now, stats });
  await processAccountWinbacks({ supabase, sendWhatsAppFn, now, stats });
  // v1.16.3 — revenue recovery + re-engagement ride the SAME worker.
  await processPastDueDunning({ supabase, sendWhatsAppFn, now, stats });
  await processSilentReengagement({ supabase, sendWhatsAppFn, now, stats });

  return stats;
}

/** Redeem an `account_trial_extension` coupon and extend the active trial. */
export async function applyAccountTrialExtensionCoupon({ supabase, ownerId, code } = {}) {
  if (!supabase || !ownerId || !code) return { ok: false, error: 'owner + code required' };
  const cleanCode = String(code).toUpperCase().trim();
  try {
    const { data: coupon } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', cleanCode)
      .eq('applicable_to', 'account_trial_extension')
      .maybeSingle();
    if (!coupon) return { ok: false, error: 'No account trial extension coupon found.' };
    if (coupon.status === 'applied' || Number(coupon.current_uses || 0) >= Number(coupon.max_uses || 1)) {
      return { ok: false, error: 'That extension coupon has already been redeemed.' };
    }
    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) {
      return { ok: false, error: 'That extension coupon has expired.' };
    }

    const extension = await extendAccountTrial({
      supabase,
      ownerId,
      days: Number(coupon.trial_extension_days || 15),
      couponCode: coupon.code
    });
    if (!extension.ok) return extension;

    await supabase.from('coupons').update({
      status: 'applied',
      current_uses: Number(coupon.current_uses || 0) + 1,
      redeemed_at: new Date().toISOString(),
      redemption_type: 'trial_extension',
      dispatched_at: coupon.dispatched_at || new Date().toISOString()
    }).eq('id', coupon.id);

    return { ok: true, couponCode: coupon.code, daysAdded: extension.daysAdded, endsAt: extension.endsAt, totalDays: extension.totalDays };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Deterministic activation reward copy (WhatsApp-ready). */
export function formatActivationReward({ ownerName, tierKey, coupon = null, checkoutUrl = null, priceLabel = null } = {}) {
  return activationRewardText({
    ownerName,
    tierLabel: getTierLabel(tierKey),
    coupon,
    checkoutUrl,
    priceLabel
  });
}

/** Funnel stats for the Superadmin (`admin trial-stats`). */
export async function getTrialFunnelStats({ supabase, windowDays = 30 } = {}) {
  const empty = {
    windowDays,
    started: 0, activated: 0, converted: 0, expired: 0, extended: 0, active: 0,
    conversionRate: 0, activationRate: 0, byTier: {}, bySource: { welcome: 0, upgrade: 0 }
  };
  if (!supabase) return empty;
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString();
  try {
    const { data } = await supabase
      .from('trial_sessions')
      .select('tier, status, activated, started_at, converted_at, ends_at, source')
      .gte('started_at', since);
    const rows = data || [];
    const stats = { ...empty, started: rows.length, bySource: { welcome: 0, upgrade: 0 } };
    for (const row of rows) {
      const tier = normalizeTierKey(row.tier);
      const source = row.source === 'welcome' ? 'welcome' : 'upgrade';
      stats.bySource[source] += 1;
      if (!stats.byTier[tier]) stats.byTier[tier] = { started: 0, converted: 0, expired: 0 };
      stats.byTier[tier].started += 1;
      if (row.activated) stats.activated += 1;
      if (row.status === 'CONVERTED' || row.converted_at) {
        stats.converted += 1;
        stats.byTier[tier].converted += 1;
      }
      if (row.status === 'EXPIRED') {
        stats.expired += 1;
        stats.byTier[tier].expired += 1;
      }
      if (row.status === 'EXTENDED') stats.extended += 1;
      if (['ACTIVE', 'EXTENDED'].includes(row.status)) stats.active += 1;
    }
    stats.conversionRate = stats.started ? Math.round((stats.converted / stats.started) * 1000) / 10 : 0;
    stats.activationRate = stats.started ? Math.round((stats.activated / stats.started) * 1000) / 10 : 0;
    return stats;
  } catch {
    return empty;
  }
}

/** Deterministic Superadmin digest (zero AI tokens). */
export function formatTrialStatsReply(stats) {
  if (!stats) return '📊 Trial stats unavailable.';
  const tierLines = Object.entries(stats.byTier || {})
    .map(([tier, row]) => `• ${getTierLabel(tier)}: ${row.started} started / ${row.converted} converted / ${row.expired} expired`);
  return [
    `🎁 *Trial Funnel — last ${stats.windowDays} day(s)*`,
    `• Started: ${stats.started}`,
    `• Activated: ${stats.activated} (${stats.activationRate}%)`,
    `• Converted: ${stats.converted} (${stats.conversionRate}%)`,
    `• Extensions: ${stats.extended}`,
    `• Expired to Free: ${stats.expired}`,
    `• Active now: ${stats.active}`,
    `• Welcome vs upgrade: ${stats.bySource?.welcome ?? 0} / ${stats.bySource?.upgrade ?? 0}`,
    tierLines.length ? '\nBy tier:' : '',
    ...tierLines
  ].filter(Boolean).join('\n');
}

export default {
  TRIAL_DAYS,
  TRIAL_MAX_TOTAL_DAYS,
  TRIAL_ACTIVATION_COUPON_PCT,
  ACTIVATION_EVENTS,
  ACTIVATION_EVENT_VALUES,
  getTrialConfig,
  computeTrialEnd,
  startAccountTrial,
  startWelcomeTrial,
  getTrialStatus,
  recordActivationEvent,
  issueActivationCoupon,
  scheduleAccountTrialExtensionCoupon,
  processPastDueDunning,
  processSilentReengagement,
  extendAccountTrial,
  applyAccountTrialExtensionCoupon,
  formatActivationReward,
  buildTrialMetrics,
  runTrialLifecycleSweep,
  getTrialFunnelStats,
  formatTrialStatsReply
};

