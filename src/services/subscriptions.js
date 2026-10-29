/**
 * Saka Fleet — Subscription Service (v1.15.0)
 * ------------------------------------------
 * Owner-centric billing engine. Responsibilities:
 *  - Entitlement resolution (single choke point for every gate)
 *  - Paystack recurring checkout + coupon application
 *  - Webhook state machine (subscription.create / invoice.* / subscription.disable)
 *  - Simple Rules: add-ons, cancellations, downgrades, keepers, report quotas
 *
 * Design contracts:
 *  - Never throws on the request path: callers get `{ ok:false }` + a reason.
 *  - Owner identity is `profiles.id`; Paystack metadata always carries it.
 *  - `trial_sessions` is read here (never imports trialEngine — cycle-free).
 *  - Tier math ALWAYS comes from subscriptionTiers.js.
 */

import {
  initializePaystackCheckout,
  disablePaystackSubscription,
  enablePaystackSubscription,
  updatePaystackSubscription,
  getTierLocalPrice
} from './paystack.js';
import { validateCouponForCheckout } from './coupons.js';
import {
  normalizeTierKey,
  getTierDefinition,
  getTierLabel,
  getEffectiveVehicleLimit,
  getAddonPriceUSD,
  getTierPriceUSD,
  getNextTierKey,
  getPlanCode,
  listPaidTierKeys,
  isPaidTierKey
} from './subscriptionTiers.js';

const ENTITLEMENT_CACHE_MS = Number(process.env.SUBSCRIPTION_CACHE_MS || 60000);
const PAST_DUE_GRACE_DAYS = Math.max(0, Number(process.env.SUBSCRIPTION_GRACE_DAYS || 3));
const REPORT_PERIOD_TZ = 'Africa/Nairobi';

const entitlementCache = new Map();

export function invalidateEntitlements(ownerId = null) {
  if (!ownerId) entitlementCache.clear();
  else entitlementCache.delete(String(ownerId));
}

/** Nairobi calendar-month key (YYYY-MM) for report quotas. */
export function nairobiMonthKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_PERIOD_TZ,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now instanceof Date ? now : new Date(now));
  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  return `${year}-${month}`;
}

export async function countActiveVehicles(supabase, ownerId) {
  if (!supabase || !ownerId) return 0;
  try {
    const { count } = await supabase
      .from('vehicles')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .is('deleted_at', null);
    return count || 0;
  } catch {
    return 0;
  }
}

async function fetchProfile(supabase, ownerId) {
  if (!supabase || !ownerId) return null;
  try {
    const { data } = await supabase
      .from('profiles')
      .select('id, phone_number, email, full_name, subscription_tier, subscription_status, billing_interval, subscription_expires_at, subscription_period_start, subscription_period_end, paystack_customer_code, paystack_subscription_code, paystack_email_token, trial_used_at, addon_quantity, cancel_at_period_end, downgraded_at')
      .eq('id', ownerId)
      .maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

export async function getActiveTrialRow(supabase, ownerId) {
  if (!supabase || !ownerId) return null;
  try {
    const { data } = await supabase
      .from('trial_sessions')
      .select('*')
      .eq('owner_id', ownerId)
      .in('status', ['ACTIVE', 'EXTENDED'])
      .maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

function daysBetween(target, now = new Date()) {
  const ms = new Date(target).getTime() - new Date(now).getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function periodEndMs(profile) {
  const raw = profile?.subscription_period_end || profile?.subscription_expires_at;
  return raw ? new Date(raw).getTime() : 0;
}

function freeEntitlements(ownerId, profile = null, extra = {}) {
  const tier = getTierDefinition('free');
  return {
    ok: true,
    ownerId,
    tierKey: 'free',
    tierName: tier.label,
    status: extra.status || 'ACTIVE',
    billingInterval: profile?.billing_interval || 'monthly',
    isPaid: false,
    isTrial: false,
    trialEndsAt: null,
    trialDaysLeft: 0,
    addonQuantity: 0,
    addonEligible: false,
    baseLimit: tier.baseLimit,
    effectiveVehicleCapacity: tier.baseLimit,
    maxAiTier: tier.maxAiTier,
    reportsPerMonth: tier.reportsPerMonth,
    reportsUsedThisMonth: extra.reportsUsedThisMonth || 0,
    driverAssignment: tier.driverAssignment,
    complianceTracking: tier.complianceTracking,
    fleetReports: tier.fleetReports,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    nextTierKey: getNextTierKey('free'),
    ...extra
  };
}


function cacheEntitlements(ownerId, value) {
  if (ENTITLEMENT_CACHE_MS <= 0) return value;
  entitlementCache.set(String(ownerId), { value, expiresAt: Date.now() + ENTITLEMENT_CACHE_MS });
  if (entitlementCache.size > 5000) {
    const firstKey = entitlementCache.keys().next().value;
    entitlementCache.delete(firstKey);
  }
  return value;
}

export async function getMonthlyReportCount(supabase, ownerId, now = new Date()) {
  if (!supabase || !ownerId) return 0;
  try {
    const { data } = await supabase
      .from('usage_counters')
      .select('report_count')
      .eq('owner_id', ownerId)
      .eq('period_key', nairobiMonthKey(now))
      .maybeSingle();
    return Number(data?.report_count || 0);
  } catch {
    return 0;
  }
}

/**
 * THE entitlement choke point. Every gate (registration, AI tier clamp,
 * report quota, transfer acceptance, upgrade copy) resolves through this.
 */
export async function getEntitlements({ supabase, ownerId, profile = null, now = new Date(), useCache = true } = {}) {
  const id = ownerId || profile?.id || null;
  if (!id) return freeEntitlements(null, profile);

  if (useCache && ENTITLEMENT_CACHE_MS > 0) {
    const hit = entitlementCache.get(String(id));
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const prof = profile?.subscription_tier ? profile : await fetchProfile(supabase, id);
  if (!prof) return cacheEntitlements(id, freeEntitlements(id, profile));

  const tierKey = normalizeTierKey(prof.subscription_tier);
  const status = String(prof.subscription_status || 'ACTIVE').toUpperCase();
  const addons = Math.max(0, Math.floor(Number(prof.addon_quantity) || 0));
  const endMs = periodEndMs(prof);
  const nowMs = now.getTime();
  const graceMs = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;

  let hasPaidAccess = false;
  if (isPaidTierKey(tierKey)) {
    if (status === 'ACTIVE' || status === 'TRIAL' || status === 'TRIALING') {
      hasPaidAccess = true;
    } else if (status === 'CANCELING') {
      // Cancellations keep access exactly until the paid period ends (no grace).
      hasPaidAccess = endMs === 0 || endMs > nowMs;
    } else if (status === 'PAST_DUE') {
      // Failed payments get a short grace window before degrading.
      hasPaidAccess = endMs === 0 || endMs + graceMs > nowMs;
    } else {
      hasPaidAccess = endMs > nowMs;
    }
  }

  // Lazy expiry downgrade: a paid tier without access falls back to Free.
  if (isPaidTierKey(tierKey) && !hasPaidAccess) {
    const downgraded = await downgradeToFree({ supabase, ownerId: id, reason: `expired:${status}` });
    const ent = freeEntitlements(id, prof, {
      status: 'ACTIVE',
      downgraded: Boolean(downgraded?.downgraded),
      pausedVehicles: downgraded?.paused || []
    });
    return cacheEntitlements(id, ent);
  }

  const trial = status === 'TRIALING' ? await getActiveTrialRow(supabase, id) : null;
  // Revenue guard: TRIALING without a live trial row must never grant paid
  // access indefinitely (e.g. a deleted/corrupted trial_sessions row).
  if (status === 'TRIALING' && isPaidTierKey(tierKey) && !trial) {
    const downgraded = await downgradeToFree({ supabase, ownerId: id, reason: 'trial.missing' });
    return cacheEntitlements(id, freeEntitlements(id, prof, {
      status: 'ACTIVE',
      downgraded: Boolean(downgraded?.downgraded),
      pausedVehicles: downgraded?.paused || []
    }));
  }
  const isTrial = Boolean(trial && ['ACTIVE', 'EXTENDED'].includes(String(trial.status)));
  const effective = hasPaidAccess ? getTierDefinition(tierKey) : getTierDefinition('free');
  const effectiveTierKey = hasPaidAccess ? tierKey : 'free';
  const capacity = getEffectiveVehicleLimit(effectiveTierKey, effective.addonEligible ? addons : 0);
  const reportsUsed = Number.isFinite(effective.reportsPerMonth)
    ? await getMonthlyReportCount(supabase, id, now)
    : 0;

  const ent = {
    ok: true,
    ownerId: id,
    tierKey: effectiveTierKey,
    tierName: effective.label,
    status,
    billingInterval: prof.billing_interval || 'monthly',
    isPaid: hasPaidAccess,
    isTrial,
    trialEndsAt: isTrial ? trial.ends_at : null,
    trialDaysLeft: isTrial ? daysBetween(trial.ends_at, now) : 0,
    trialStartedAt: isTrial ? trial.started_at : null,
    addonQuantity: effective.addonEligible ? addons : 0,
    addonEligible: Boolean(effective.addonEligible),
    baseLimit: effective.baseLimit,
    effectiveVehicleCapacity: capacity,
    maxAiTier: effective.maxAiTier,
    reportsPerMonth: effective.reportsPerMonth,
    reportsUsedThisMonth: reportsUsed,
    reportsRemaining: Number.isFinite(effective.reportsPerMonth)
      ? Math.max(0, effective.reportsPerMonth - reportsUsed)
      : Infinity,
    driverAssignment: effective.driverAssignment,
    complianceTracking: effective.complianceTracking,
    fleetReports: effective.fleetReports,
    cancelAtPeriodEnd: Boolean(prof.cancel_at_period_end),
    currentPeriodEnd: prof.subscription_period_end || prof.subscription_expires_at || null,
    nextTierKey: getNextTierKey(effectiveTierKey),
    profile: {
      id,
      phone_number: prof.phone_number || null,
      email: prof.email || null,
      full_name: prof.full_name || null,
      trial_used_at: prof.trial_used_at || null,
      paystack_subscription_code: prof.paystack_subscription_code || null,
      paystack_email_token: prof.paystack_email_token || null,
      paystack_customer_code: prof.paystack_customer_code || null
    }
  };
  return cacheEntitlements(id, ent);
}


/** Garage capacity decision (Simple Rule R1). */
export async function evaluateVehicleCapacity({
  supabase,
  ownerId,
  profile = null,
  additionalVehicles = 1
} = {}) {
  const entitlements = await getEntitlements({ supabase, ownerId, profile });
  const currentCount = await countActiveVehicles(supabase, ownerId);
  const projected = currentCount + Math.max(0, Number(additionalVehicles) || 0);
  const capacity = entitlements.effectiveVehicleCapacity;
  return {
    allowed: projected <= capacity,
    currentCount,
    projected,
    capacity,
    overBy: Math.max(0, projected - capacity),
    addonEligible: entitlements.addonEligible,
    addonQuantity: entitlements.addonQuantity,
    addonPriceUSD: entitlements.addonEligible
      ? getAddonPriceUSD(entitlements.tierKey, entitlements.billingInterval)
      : 0,
    tierKey: entitlements.tierKey,
    tierName: entitlements.tierName,
    nextTierKey: entitlements.nextTierKey,
    isTrial: entitlements.isTrial,
    entitlements
  };
}

/** Report quota decision (Free = 1 report per Nairobi month). Never throws. */
export async function getReportQuota({ supabase, ownerId, profile = null, now = new Date() } = {}) {
  const entitlements = await getEntitlements({ supabase, ownerId, profile, now });
  if (!Number.isFinite(entitlements.reportsPerMonth)) {
    return { unlimited: true, used: 0, limit: Infinity, remaining: Infinity, canGenerate: true, entitlements };
  }
  const used = await getMonthlyReportCount(supabase, ownerId, now);
  const remaining = Math.max(0, entitlements.reportsPerMonth - used);
  return {
    unlimited: false,
    used,
    limit: entitlements.reportsPerMonth,
    remaining,
    canGenerate: remaining > 0,
    periodKey: nairobiMonthKey(now),
    entitlements
  };
}

/** Increment the monthly report counter. Fail-soft. */
export async function recordReportUsage({ supabase, ownerId, now = new Date() } = {}) {
  if (!supabase || !ownerId) return { ok: false };
  const periodKey = nairobiMonthKey(now);
  const nowIso = now.toISOString();
  try {
    const { data: existing } = await supabase
      .from('usage_counters')
      .select('report_count')
      .eq('owner_id', ownerId)
      .eq('period_key', periodKey)
      .maybeSingle();
    if (existing) {
      await supabase
        .from('usage_counters')
        .update({ report_count: Number(existing.report_count || 0) + 1, last_report_at: nowIso, updated_at: nowIso })
        .eq('owner_id', ownerId)
        .eq('period_key', periodKey);
    } else {
      await supabase.from('usage_counters').insert([{
        owner_id: ownerId,
        period_key: periodKey,
        report_count: 1,
        last_report_at: nowIso,
        updated_at: nowIso
      }]);
    }
    invalidateEntitlements(ownerId);
    return { ok: true, periodKey };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Reverse-map a Paystack plan code to `{ tierKey, interval }`. */
export function findTierForPlanCode(planCode, currency = 'USD') {
  if (!planCode) return null;
  for (const tierKey of listPaidTierKeys()) {
    for (const interval of ['monthly', 'annual']) {
      if (getPlanCode(tierKey, interval, currency) === planCode) return { tierKey, interval };
    }
  }
  return null;
}

/**
 * Start a Paystack checkout for a tier (with optional coupon discount).
 * Returns `{ ok, checkoutUrl, reference, priceInfo, coupon, recurring }`.
 */
export async function checkoutForTier({
  supabase,
  owner = {},
  targetTierKey,
  interval = 'monthly',
  currency = 'USD',
  couponCode = null,
  addonQuantity = null,
  metadata = {}
} = {}) {
  const tierKey = normalizeTierKey(targetTierKey);
  if (tierKey === 'free') return { ok: false, error: 'Free tier needs no checkout.' };
  const billingInterval = interval === 'annual' ? 'annual' : 'monthly';

  let coupon = null;
  if (couponCode) {
    coupon = await validateCouponForCheckout({
      supabase,
      code: couponCode,
      tierKey,
      interval: billingInterval,
      ownerId: owner.id || null,
      currency
    });
    if (!coupon?.valid) return { ok: false, error: coupon?.error || 'Coupon is not valid for this checkout.' };
  }

  const priceUSD = getTierPriceUSD(tierKey, billingInterval);
  const discountUSD = coupon?.discountUSD || 0;
  const payableUSD = Math.max(0, Number((priceUSD - discountUSD).toFixed(2)));
  const planCode = getPlanCode(tierKey, billingInterval, currency);

  try {
    const checkout = await initializePaystackCheckout({
      supabase,
      userPhone: owner.phone_number,
      targetTierKey: tierKey,
      billingInterval,
      userEmail: owner.email,
      userId: owner.id,
      currency,
      planCode,
      amountUSDOverride: coupon ? payableUSD : null,
      couponCode: coupon?.valid ? coupon.code : null,
      addonQuantity,
      metadata: {
        ...metadata,
        coupon_code: coupon?.valid ? coupon.code : null,
        discount_usd: discountUSD || null,
        recurring: Boolean(planCode)
      }
    });

    if (owner.id && supabase) {
      try {
        await supabase.from('trial_sessions').update({
          checkout_started_at: new Date().toISOString(),
          coupon_code: coupon?.valid ? coupon.code : null
        }).eq('owner_id', owner.id).in('status', ['ACTIVE', 'EXTENDED']);
      } catch { /* fail-soft */ }
    }

    return {
      ok: true,
      checkoutUrl: checkout.checkoutUrl,
      accessCode: checkout.accessCode,
      reference: checkout.reference,
      priceInfo: checkout.priceInfo,
      recurring: Boolean(planCode),
      coupon: coupon?.valid ? { code: coupon.code, discountUSD, type: coupon.discountType } : null,
      payableUSD
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** One-time Fleet Command add-on purchase (extra garage slots). */
export async function checkoutForAddon({
  supabase,
  owner = {},
  addonQuantity,
  interval = 'monthly',
  currency = 'USD'
} = {}) {
  const quantity = Math.max(1, Math.floor(Number(addonQuantity) || 1));
  const unitUSD = getAddonPriceUSD('fleet_command', interval);
  const amountUSD = Number((unitUSD * quantity).toFixed(2));
  try {
    const checkout = await initializePaystackCheckout({
      supabase,
      userPhone: owner.phone_number,
      targetTierKey: 'fleet_command',
      billingInterval: interval,
      userEmail: owner.email,
      userId: owner.id,
      currency,
      amountUSDOverride: amountUSD,
      metadata: {
        type: 'fleet_addon',
        addon_quantity: quantity,
        target_tier: 'fleet_command',
        billing_interval: interval
      }
    });
    return { ok: true, checkoutUrl: checkout.checkoutUrl, reference: checkout.reference, amountUSD, quantity };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Persist a subscription state transition to `profiles` (fast cache) and the
 * `subscriptions` ledger (event-sourced). Invalidates the entitlement cache.
 */
export async function applySubscriptionState({
  supabase,
  owner,
  tierKey,
  interval = 'monthly',
  status = 'ACTIVE',
  periodStart = null,
  periodEnd = null,
  subscriptionCode = null,
  customerCode = null,
  emailToken = null,
  addonQuantity = null,
  planCode = null,
  trialEndAt = null,
  clearCancelFlag = true
} = {}) {
  if (!supabase || !owner?.id) return { ok: false, error: 'owner required' };
  const canonicalTier = normalizeTierKey(tierKey);
  const nowIso = new Date().toISOString();
  const updates = {
    subscription_tier: canonicalTier,
    subscription_status: String(status || 'ACTIVE').toUpperCase(),
    billing_interval: interval === 'annual' ? 'annual' : 'monthly',
    subscription_period_start: periodStart || null,
    subscription_period_end: periodEnd || null,
    subscription_expires_at: periodEnd || null,
    updated_at: nowIso
  };
  if (subscriptionCode) updates.paystack_subscription_code = subscriptionCode;
  if (customerCode) updates.paystack_customer_code = customerCode;
  if (emailToken) updates.paystack_email_token = emailToken;
  if (addonQuantity !== null && addonQuantity !== undefined) {
    updates.addon_quantity = Math.max(0, Math.floor(Number(addonQuantity) || 0));
  }
  if (clearCancelFlag) updates.cancel_at_period_end = false;

  try {
    await supabase.from('profiles').update(updates).eq('id', owner.id);
    await upsertSubscriptionRow({
      supabase,
      ownerId: owner.id,
      tierKey: canonicalTier,
      interval: updates.billing_interval,
      status: updates.subscription_status,
      planCode,
      subscriptionCode: subscriptionCode || owner.paystack_subscription_code || null,
      customerCode: customerCode || owner.paystack_customer_code || null,
      emailToken: emailToken || owner.paystack_email_token || null,
      periodStart,
      periodEnd,
      trialEndAt,
      addonQuantity: updates.addon_quantity ?? null
    });
    invalidateEntitlements(owner.id);
    return { ok: true, tierKey: canonicalTier, status: updates.subscription_status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function upsertSubscriptionRow({
  supabase, ownerId, tierKey, interval, status, planCode,
  subscriptionCode, customerCode, emailToken, periodStart, periodEnd,
  trialEndAt, addonQuantity
}) {
  if (!supabase || !ownerId) return;
  const nowIso = new Date().toISOString();
  const base = {
    owner_id: ownerId,
    plan_code: planCode || null,
    tier: tierKey,
    interval,
    status,
    paystack_subscription_code: subscriptionCode || null,
    paystack_customer_code: customerCode || null,
    paystack_email_token: emailToken || null,
    current_period_start: periodStart || null,
    current_period_end: periodEnd || null,
    trial_end_at: trialEndAt || null,
    updated_at: nowIso
  };
  if (addonQuantity !== null && addonQuantity !== undefined) base.addon_quantity = addonQuantity;

  try {
    if (subscriptionCode) {
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('paystack_subscription_code', subscriptionCode)
        .maybeSingle();
      if (existing) {
        await supabase.from('subscriptions').update(base).eq('id', existing.id);
        return;
      }
    }
    await supabase.from('subscriptions').insert([{ ...base, created_at: nowIso }]);
  } catch { /* ledger is best-effort; profiles is authoritative for gates */ }
}

async function resolveOwnerForEvent({ supabase, metadata = {}, subscriptionCode = null, email = null }) {
  if (!supabase) return null;
  if (metadata.user_id) {
    const prof = await fetchProfile(supabase, metadata.user_id);
    if (prof) return prof;
  }
  if (metadata.phone_number) {
    const clean = String(metadata.phone_number).startsWith('+')
      ? String(metadata.phone_number)
      : `+${String(metadata.phone_number).replace(/[^\d]/g, '')}`;
    const { data } = await supabase.from('profiles').select('*').eq('phone_number', clean).maybeSingle();
    if (data) return data;
  }
  if (subscriptionCode) {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('owner_id')
      .eq('paystack_subscription_code', subscriptionCode)
      .maybeSingle();
    if (sub?.owner_id) {
      const prof = await fetchProfile(supabase, sub.owner_id);
      if (prof) return prof;
    }
  }
  if (email) {
    const { data } = await supabase.from('profiles').select('*').eq('email', String(email).toLowerCase()).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function markTrialConverted(supabase, ownerId, subscriptionCode = null) {
  if (!supabase || !ownerId) return;
  try {
    await supabase.from('trial_sessions').update({
      status: 'CONVERTED',
      converted_at: new Date().toISOString(),
      paystack_subscription_code: subscriptionCode || null,
      updated_at: new Date().toISOString()
    }).eq('owner_id', ownerId).in('status', ['ACTIVE', 'EXTENDED']);
  } catch { /* fail-soft */ }
}

async function handleAddonCharge({ supabase, data, metadata, sendWhatsAppFn }) {
  const owner = await resolveOwnerForEvent({ supabase, metadata, email: data.customer?.email });
  if (!owner) return { handled: false, reason: 'owner not found' };
  const quantity = Math.max(1, Math.floor(Number(metadata.addon_quantity) || 1));
  const current = Math.max(0, Math.floor(Number(owner.addon_quantity) || 0));
  const total = current + quantity;
  await supabase.from('profiles').update({
    subscription_tier: 'fleet_command',
    addon_quantity: total,
    updated_at: new Date().toISOString()
  }).eq('id', owner.id);
  if (owner.paystack_subscription_code) {
    await updatePaystackSubscription({ code: owner.paystack_subscription_code, quantity: total }).catch(() => null);
  }
  invalidateEntitlements(owner.id);
  if (owner.phone_number && sendWhatsAppFn) {
    await sendWhatsAppFn(owner.phone_number,
      `✅ *Fleet Command add-on activated!*\n\n+${quantity} garage slot(s) added — your fleet can now hold ${5 + total} active vehicles.\n\nReply *"subscription"* to review your plan.`).catch(() => {});
  }
  return { handled: true, type: 'fleet_addon', ownerId: owner.id, addonQuantity: total };
}

async function handleSubscriptionCreate({ supabase, data, metadata, sendWhatsAppFn }) {
  const owner = await resolveOwnerForEvent({
    supabase, metadata, subscriptionCode: data.subscription_code, email: data.customer?.email
  });
  if (!owner) return { handled: false, reason: 'owner not found' };

  const fromPlan = findTierForPlanCode(data.plan?.plan_code);
  const tierKey = normalizeTierKey(metadata.target_tier || fromPlan?.tierKey || owner.subscription_tier);
  const interval = metadata.billing_interval === 'annual'
    ? 'annual'
    : (fromPlan?.interval || owner.billing_interval || 'monthly');
  const now = new Date();
  const periodStart = now.toISOString();
  const periodEnd = data.next_payment_date || computePeriodEnd(interval, now).toISOString();
  const status = String(data.status || 'active').toLowerCase() === 'active' ? 'ACTIVE' : 'PAST_DUE';

  await applySubscriptionState({
    supabase, owner, tierKey, interval, status, periodStart, periodEnd,
    subscriptionCode: data.subscription_code,
    customerCode: data.customer?.customer_code,
    emailToken: data.email_token,
    planCode: data.plan?.plan_code || null
  });
  await markTrialConverted(supabase, owner.id, data.subscription_code);

  if (owner.phone_number && sendWhatsAppFn) {
    await sendWhatsAppFn(owner.phone_number,
      `🎉 *Subscription active — ${getTierLabel(tierKey)}!*\n\n• Billing: ${interval}\n• Next payment: ${new Date(periodEnd).toLocaleDateString()}\n• Vehicles allowed: ${getEffectiveVehicleLimit(tierKey, Number(owner.addon_quantity) || 0)}\n\nYour full Saka toolkit (Tiers 0-3 AI, unlimited reports, compliance tracking) is unlocked.`).catch(() => {});
  }
  return { handled: true, type: 'subscription.create', ownerId: owner.id, tierKey, interval };
}

async function handleInvoiceEvent({ supabase, data, metadata, sendWhatsAppFn }) {
  const subscriptionCode = data.subscription?.subscription_code || data.subscription_code || null;
  const owner = await resolveOwnerForEvent({
    supabase, metadata, subscriptionCode, email: data.customer?.email
  });
  if (!owner) return { handled: false, reason: 'owner not found' };

  const now = new Date();
  const paid = String(data.status || '').toLowerCase() === 'success' || data.paid === true;
  const periodStart = data.period_start || now.toISOString();
  const periodEnd = data.period_end || computePeriodEnd(owner.billing_interval || 'monthly', now).toISOString();

  if (paid) {
    await applySubscriptionState({
      supabase, owner,
      tierKey: normalizeTierKey(owner.subscription_tier),
      interval: owner.billing_interval || 'monthly',
      status: 'ACTIVE',
      periodStart,
      periodEnd,
      subscriptionCode
    });
    await markTrialConverted(supabase, owner.id, subscriptionCode);
    return { handled: true, type: 'invoice.paid', ownerId: owner.id };
  }

  if (String(data.status || '').toLowerCase() === 'failed') {
    await supabase.from('profiles').update({
      subscription_status: 'PAST_DUE',
      updated_at: now.toISOString()
    }).eq('id', owner.id);
    invalidateEntitlements(owner.id);
    if (owner.phone_number && sendWhatsAppFn) {
      await sendWhatsAppFn(owner.phone_number,
        `⚠️ *Payment failed*\n\nWe could not renew your ${getTierLabel(owner.subscription_tier)} plan. Please update your card to keep premium features.\n\n👉 ${process.env.PUBLIC_PRICING_URL || 'https://sakafleet.com/pricing'}`).catch(() => {});
    }
    return { handled: true, type: 'invoice.failed', ownerId: owner.id };
  }
  return { handled: true, type: 'invoice.pending', ownerId: owner.id };
}

async function handleDisableEvent({ supabase, data, metadata }) {
  const owner = await resolveOwnerForEvent({
    supabase, metadata, subscriptionCode: data.subscription_code, email: data.customer?.email
  });
  if (!owner) return { handled: false, reason: 'owner not found' };
  const now = new Date();
  if (periodEndMs(owner) > now.getTime()) {
    await supabase.from('profiles').update({
      subscription_status: 'CANCELING',
      cancel_at_period_end: true,
      updated_at: now.toISOString()
    }).eq('id', owner.id);
    invalidateEntitlements(owner.id);
    return { handled: true, type: 'subscription.disable.scheduled', ownerId: owner.id };
  }
  const downgraded = await downgradeToFree({ supabase, ownerId: owner.id, reason: 'paystack.disable' });
  return { handled: true, type: 'subscription.disable', ownerId: owner.id, downgraded };
}

async function handleLegacyCharge({ supabase, data, metadata }) {
  const owner = await resolveOwnerForEvent({ supabase, metadata, email: data.customer?.email });
  if (!owner) return { handled: false, reason: 'owner not found' };
  const now = new Date();
  const tierKey = normalizeTierKey(metadata.target_tier);
  const interval = metadata.billing_interval === 'annual' ? 'annual' : 'monthly';
  const periodEnd = computePeriodEnd(interval, now).toISOString();
  await applySubscriptionState({
    supabase, owner, tierKey, interval, status: 'ACTIVE',
    periodStart: now.toISOString(),
    periodEnd,
    subscriptionCode: data.subscription_code || data.reference || null,
    customerCode: data.customer?.customer_code,
    emailToken: data.email_token || null
  });
  await markTrialConverted(supabase, owner.id, data.subscription_code || data.reference || null);
  return { handled: true, type: 'charge.success.legacy', ownerId: owner.id, tierKey, interval };
}

/** Monthly = +30 days, annual = +1 year. */
export function computePeriodEnd(interval, from = new Date()) {
  const end = new Date(from);
  if (interval === 'annual') end.setFullYear(end.getFullYear() + 1);
  else end.setDate(end.getDate() + 30);
  return end;
}

/**
 * Paystack webhook state machine. Idempotent on `event.data.id`.
 * Returns `{ duplicate }`, `{ handled, type }` or `{ handled:false }`.
 */
export async function handlePaystackEvent({ supabase, event, sendWhatsAppFn = null, log = null } = {}) {
  if (!supabase || !event || !event.event) return { handled: false, reason: 'invalid event' };
  const data = event.data || {};
  const metadata = data.metadata || {};
  const eventId = data?.id
    ? String(data.id)
    : `${event.event}:${data.reference || data.subscription_code || data.subscription?.subscription_code || ''}:${Date.now()}`;

  try {
    const { error: dupErr } = await supabase.from('paystack_webhook_events').insert([{
      event_id: eventId,
      event_type: event.event,
      reference: data.reference || null,
      payload: event,
      processed_at: new Date().toISOString()
    }]);
    if (dupErr && /duplicate|unique/i.test(dupErr.message || '')) {
      return { duplicate: true, eventId };
    }
  } catch (err) {
    log?.warn?.(`[Subscriptions] webhook ledger write failed: ${err.message}`);
  }

  try {
    if (event.event === 'charge.success') {
      if (metadata.type === 'fleet_addon') {
        return await handleAddonCharge({ supabase, data, metadata, sendWhatsAppFn });
      }
      if (metadata.type === 'passbook_transfer_fee' || metadata.transfer_id) {
        return { handled: false, type: 'passbook_transfer_fee' };
      }
      if (metadata.target_tier) {
        return await handleLegacyCharge({ supabase, data, metadata });
      }
      return { handled: false };
    }

    if (event.event === 'subscription.create') {
      return await handleSubscriptionCreate({ supabase, data, metadata, sendWhatsAppFn });
    }

    if (event.event === 'invoice.create' || event.event === 'invoice.update' || event.event === 'invoice.payment_failed') {
      return await handleInvoiceEvent({ supabase, data, metadata, sendWhatsAppFn });
    }

    if (event.event === 'subscription.disable') {
      return await handleDisableEvent({ supabase, data, metadata });
    }

    if (event.event === 'subscription.not_renew') {
      const owner = await resolveOwnerForEvent({
        supabase, metadata, subscriptionCode: data.subscription_code, email: data.customer?.email
      });
      if (!owner) return { handled: false, reason: 'owner not found' };
      await supabase.from('profiles').update({
        subscription_status: 'CANCELING',
        cancel_at_period_end: true,
        updated_at: new Date().toISOString()
      }).eq('id', owner.id);
      invalidateEntitlements(owner.id);
      return { handled: true, type: 'subscription.not_renew', ownerId: owner.id };
    }

    return { handled: false };
  } catch (err) {
    log?.error?.(`[Subscriptions] webhook handling failed: ${err.message}`);
    return { handled: false, error: err.message };
  }
}

/**
 * Simple Rule R3 — cancel at period end (full access retained).
 * An active trial cancels immediately: nothing was billed.
 */
export async function cancelSubscription({ supabase, ownerId, profile = null } = {}) {
  const prof = profile?.subscription_tier ? profile : await fetchProfile(supabase, ownerId);
  if (!prof) return { ok: false, error: 'Profile not found' };
  const nowIso = new Date().toISOString();

  const trial = await getActiveTrialRow(supabase, ownerId);
  if (trial) {
    await supabase.from('trial_sessions').update({
      status: 'CANCELLED',
      ends_at: nowIso,
      updated_at: nowIso
    }).eq('id', trial.id);
    const downgraded = await downgradeToFree({ supabase, ownerId, reason: 'trial.cancelled' });
    return { ok: true, trial: true, immediate: true, effectiveAt: nowIso, downgraded };
  }

  const code = prof.paystack_subscription_code;
  const token = prof.paystack_email_token;
  let paystackDisabled = false;
  if (code && token) {
    const res = await disablePaystackSubscription({ code, token });
    paystackDisabled = Boolean(res.ok);
  }

  const effectiveAt = prof.subscription_period_end || prof.subscription_expires_at || nowIso;
  await supabase.from('profiles').update({
    subscription_status: 'CANCELING',
    cancel_at_period_end: true,
    updated_at: nowIso
  }).eq('id', ownerId);
  invalidateEntitlements(ownerId);

  return { ok: true, trial: false, immediate: false, effectiveAt, paystackDisabled };
}

/** Undo a pending cancellation (before period end). */
export async function resumeSubscription({ supabase, ownerId, profile = null } = {}) {
  const prof = profile?.subscription_tier ? profile : await fetchProfile(supabase, ownerId);
  if (!prof) return { ok: false, error: 'Profile not found' };
  const code = prof.paystack_subscription_code;
  const token = prof.paystack_email_token;
  let paystackEnabled = false;
  if (code && token) {
    const res = await enablePaystackSubscription({ code, token });
    paystackEnabled = Boolean(res.ok);
  }
  await supabase.from('profiles').update({
    subscription_status: 'ACTIVE',
    cancel_at_period_end: false,
    updated_at: new Date().toISOString()
  }).eq('id', ownerId);
  invalidateEntitlements(ownerId);
  return { ok: true, paystackEnabled };
}

/**
 * Simple Rule R4 — downgrade to Free. Preserves every row: excess vehicles are
 * PAUSED (never deleted) and the owner picks which vehicle(s) stay active.
 */
export async function downgradeToFree({ supabase, ownerId, reason = 'expired' } = {}) {
  if (!supabase || !ownerId) return { downgraded: false };
  const nowIso = new Date().toISOString();
  let kept = [];
  let paused = [];

  try {
    const { data: vehicles } = await supabase
      .from('vehicles')
      .select('id, plate_number, status, updated_at')
      .eq('owner_id', ownerId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    const list = vehicles || [];
    const capacity = 1;
    kept = list.slice(0, capacity);
    const toPause = list.slice(capacity).filter((v) => String(v.status || '').toUpperCase() !== 'PAUSED');
    for (const vehicle of toPause) {
      await supabase.from('vehicles').update({ status: 'PAUSED', updated_at: nowIso }).eq('id', vehicle.id);
    }
    paused = toPause;

    await supabase.from('profiles').update({
      subscription_tier: 'free',
      subscription_status: 'ACTIVE',
      cancel_at_period_end: false,
      addon_quantity: 0,
      subscription_period_start: null,
      subscription_period_end: null,
      subscription_expires_at: null,
      paystack_subscription_code: null,
      paystack_email_token: null,
      downgraded_at: nowIso,
      updated_at: nowIso
    }).eq('id', ownerId);

    await supabase.from('subscriptions').update({
      status: 'CANCELED',
      canceled_at: nowIso,
      updated_at: nowIso
    }).eq('owner_id', ownerId).in('status', ['ACTIVE', 'TRIALING', 'CANCELING', 'PAST_DUE']);

    invalidateEntitlements(ownerId);
    return { downgraded: true, kept, paused, reason };
  } catch (err) {
    return { downgraded: false, error: err.message, reason };
  }
}

/** KEEP_VEHICLE executor — resume the chosen vehicles, pause the rest. */
export async function selectVehiclesToKeep({ supabase, ownerId, keepVehicleIds = [] } = {}) {
  if (!supabase || !ownerId) return { ok: false, error: 'owner required' };
  const entitlements = await getEntitlements({ supabase, ownerId });
  const capacity = entitlements.effectiveVehicleCapacity;
  const ids = [...new Set((keepVehicleIds || []).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: 'Choose at least one vehicle to keep active.' };
  if (ids.length > capacity) {
    return { ok: false, error: `Your current plan allows ${capacity} active vehicle(s); you selected ${ids.length}.` };
  }

  const { data: vehicles } = await supabase
    .from('vehicles')
    .select('id, plate_number')
    .eq('owner_id', ownerId)
    .is('deleted_at', null);
  const list = vehicles || [];
  const nowIso = new Date().toISOString();
  const resumed = [];
  for (const vehicle of list) {
    const keep = ids.includes(vehicle.id);
    await supabase.from('vehicles').update({
      status: keep ? 'ACTIVE' : 'PAUSED',
      updated_at: nowIso
    }).eq('id', vehicle.id);
    if (keep) resumed.push(vehicle.plate_number || vehicle.id);
  }
  return { ok: true, resumed, capacity };
}

/** WhatsApp-ready subscription summary (deterministic, zero AI tokens). */
export async function formatSubscriptionSummary({ supabase, entitlements, currency = 'USD' } = {}) {
  if (!entitlements) return 'Subscription details are unavailable right now.';
  const ent = entitlements;
  const lines = [`📋 *Your Saka Plan — ${ent.tierName}*`];

  if (ent.isTrial) {
    const endDate = ent.trialEndsAt ? new Date(ent.trialEndsAt).toLocaleDateString() : 'soon';
    lines.push(`• Status: 🎁 Free trial — ${ent.trialDaysLeft} day(s) left (ends ${endDate})`);
  } else if (ent.cancelAtPeriodEnd || ent.status === 'CANCELING') {
    const endDate = ent.currentPeriodEnd ? new Date(ent.currentPeriodEnd).toLocaleDateString() : 'period end';
    lines.push(`• Status: Cancelling — full access until ${endDate}`);
  } else if (ent.status === 'PAST_DUE') {
    lines.push('• Status: ⚠️ Payment failed — update your card to keep premium features');
  } else {
    lines.push(`• Status: ${ent.isPaid ? 'Active' : 'Free tier'}`);
  }

  lines.push(`• Billing: ${ent.billingInterval === 'annual' ? 'Annual' : 'Monthly'}`);
  lines.push(`• Active vehicle slots: ${ent.effectiveVehicleCapacity}${ent.addonEligible ? ` (base ${ent.baseLimit} + ${ent.addonQuantity} add-on)` : ''}`);
  if (Number.isFinite(ent.reportsPerMonth)) {
    lines.push(`• Reports: ${ent.reportsUsedThisMonth}/${ent.reportsPerMonth} used this month`);
  } else {
    lines.push('• Reports: Unlimited');
  }
  lines.push(`• AI engine: ${ent.maxAiTier >= 3 ? 'Full Tiers 0–3' : 'Tier 1 (fast path)'}`);

  if (ent.isPaid && ent.tierKey !== 'free') {
    const price = await getTierLocalPrice(supabase, ent.tierKey, currency, ent.billingInterval).catch(() => null);
    if (price?.formattedPrice) lines.push(`• Price: ${price.formattedPrice} / ${ent.billingInterval === 'annual' ? 'year' : 'month'}`);
  }
  if (ent.tierKey === 'free') {
    lines.push('\n💡 Reply *"upgrade"* to unlock full AI, unlimited reports and multi-vehicle management.');
  } else if (ent.nextTierKey) {
    lines.push('\n💡 Reply *"upgrade"* to move to the next tier, or *"cancel subscription"* to stop renewal.');
  }
  return lines.join('\n');
}

/** WhatsApp-ready tier menu with localized prices. */
export async function formatTierChoices({ supabase, currency = 'USD', includeFree = false } = {}) {
  const rows = [];
  const tiers = includeFree ? ['free', ...listPaidTierKeys()] : listPaidTierKeys();
  for (const tierKey of tiers) {
    const tier = getTierDefinition(tierKey);
    if (tierKey === 'free') {
      rows.push(`• *Free* — 1 vehicle, 1 report/month, Tier-1 AI`);
      continue;
    }
    const monthly = await getTierLocalPrice(supabase, tierKey, currency, 'monthly').catch(() => null);
    const annual = await getTierLocalPrice(supabase, tierKey, currency, 'annual').catch(() => null);
    const addon = tier.addonEligible
      ? ` (+${tier.addonMonthlyUSD} USD/extra car)`
      : '';
    rows.push(`• *${tier.label}* — ${tier.baseLimit} vehicle${tier.baseLimit > 1 ? 's' : ''}${addon}\n   ${monthly?.formattedPrice || `${tier.monthlyUSD} USD`}/mo · ${annual?.formattedPrice || `${tier.annualUSD} USD`}/yr`);
  }
  return `🚀 *Saka Plans*\n\n${rows.join('\n')}\n\nReply *"upgrade to <plan>"* (e.g. \"upgrade to Growth monthly\"). First upgrade includes a 30-day free trial — no card needed.`;
}

export default {
  invalidateEntitlements,
  nairobiMonthKey,
  countActiveVehicles,
  getActiveTrialRow,
  getEntitlements,
  getMonthlyReportCount,
  evaluateVehicleCapacity,
  getReportQuota,
  recordReportUsage,
  findTierForPlanCode,
  checkoutForTier,
  checkoutForAddon,
  applySubscriptionState,
  handlePaystackEvent,
  computePeriodEnd,
  cancelSubscription,
  resumeSubscription,
  downgradeToFree,
  selectVehiclesToKeep,
  formatSubscriptionSummary,
  formatTierChoices
};

