/**
 * Saka Fleet — Subscription Tier Registry (v1.15.0)
 * ------------------------------------------------
 * SINGLE SOURCE OF TRUTH for plan limits, feature gates, pricing and Paystack
 * plan codes. Every consumer (paystack.js, vehicles.js, subscriptions.js,
 * trialEngine.js, whatsapp.js, quizEngine.js, aiClient.js entitlement clamp)
 * reads from this module — never from a local copy.
 *
 * Tiers (v1.15.0 matrix):
 *   free          1 car  — basic passbook, essential expense logs, 1 report/month, Tier-1 AI
 *   solo_pro      1 car  — 100% features, full Tiers 0-3 AI, unlimited reports
 *   team_fleet    3 cars — 100% features, multi-vehicle
 *   growth        5 cars — 100% features, anchor plan
 *   fleet_command 5+     — Growth base fee + per-vehicle add-on quantity
 *
 * Billing intervals: monthly | annual (all paid tiers).
 * Pricing values are USD list prices; local prices derive from
 * `getEffectiveExchangeRate()` in paystack.js.
 */

/** Canonical paid/free tier order (used for upgrade ladders). */
export const TIER_ORDER = Object.freeze(['free', 'solo_pro', 'team_fleet', 'growth', 'fleet_command']);

/**
 * Legacy/localised keys that may still exist in `profiles.subscription_tier`.
 * They resolve to the canonical matrix keys so old rows keep working.
 */
export const LEGACY_TIER_ALIASES = Object.freeze({
  solo: 'solo_pro',
  pro: 'solo_pro',
  scale: 'fleet_command',
  fleet_starter: 'fleet_command',
  fleet_scale: 'fleet_command',
  enterprise: 'fleet_command',
  unlimited: 'fleet_command'
});

/** Launch currencies for recurring plans (Paystack plans are currency-bound). */
export const PLAN_CURRENCIES = Object.freeze(['USD', 'KES', 'NGN', 'ZAR']);

const FREE_TIER = Object.freeze({
  key: 'free',
  label: 'Free',
  baseLimit: 1,
  addonEligible: false,
  addonMonthlyUSD: 0,
  addonAnnualUSD: 0,
  monthlyUSD: 0,
  annualUSD: 0,
  maxAiTier: 1,
  reportsPerMonth: 1,
  driverAssignment: false,
  complianceTracking: false,
  fleetReports: 'basic',
  hasPremiumFeatures: false
});

const PAID_BASE = Object.freeze({
  addonEligible: false,
  addonMonthlyUSD: 0,
  addonAnnualUSD: 0,
  maxAiTier: 3,
  reportsPerMonth: Infinity,
  driverAssignment: true,
  complianceTracking: true,
  fleetReports: 'full',
  hasPremiumFeatures: true
});

export const TIER_MATRIX = Object.freeze({
  free: FREE_TIER,
  solo_pro: Object.freeze({
    ...PAID_BASE,
    key: 'solo_pro',
    label: 'Solo Pro',
    baseLimit: 1,
    monthlyUSD: 7.99,
    annualUSD: 67.12
  }),
  team_fleet: Object.freeze({
    ...PAID_BASE,
    key: 'team_fleet',
    label: 'Team Fleet',
    baseLimit: 3,
    monthlyUSD: 19.99,
    annualUSD: 167.92
  }),
  growth: Object.freeze({
    ...PAID_BASE,
    key: 'growth',
    label: 'Growth Fleet',
    baseLimit: 5,
    monthlyUSD: 29.99,
    annualUSD: 251.92
  }),
  fleet_command: Object.freeze({
    ...PAID_BASE,
    key: 'fleet_command',
    label: 'Fleet Command',
    baseLimit: 5,
    addonEligible: true,
    addonMonthlyUSD: 4.99,
    addonAnnualUSD: 41.92,
    monthlyUSD: 29.99,
    annualUSD: 251.92
  })
});


/** Resolve a stored tier key (canonical or legacy) to a canonical matrix key. */
export function normalizeTierKey(tierKey) {
  const raw = String(tierKey || '').trim().toLowerCase();
  if (!raw) return 'free';
  if (TIER_MATRIX[raw]) return raw;
  if (LEGACY_TIER_ALIASES[raw]) return LEGACY_TIER_ALIASES[raw];
  return 'free';
}

export function isKnownTierKey(tierKey) {
  const raw = String(tierKey || '').trim().toLowerCase();
  return Boolean(TIER_MATRIX[raw] || LEGACY_TIER_ALIASES[raw]);
}

export function isPaidTierKey(tierKey) {
  return normalizeTierKey(tierKey) !== 'free';
}

/** Full frozen definition for a tier key (normalized; unknown -> free). */
export function getTierDefinition(tierKey) {
  return TIER_MATRIX[normalizeTierKey(tierKey)] || FREE_TIER;
}

export function getTierLabel(tierKey) {
  return getTierDefinition(tierKey).label;
}

/** Base garage capacity for a tier (before Fleet Command add-ons). */
export function getBaseVehicleLimit(tierKey) {
  return getTierDefinition(tierKey).baseLimit;
}

/**
 * Effective garage capacity: base limit plus Fleet Command add-on quantity.
 * Add-ons only apply to tiers flagged `addonEligible`.
 */
export function getEffectiveVehicleLimit(tierKey, addonQuantity = 0) {
  const tier = getTierDefinition(tierKey);
  const addons = Math.max(0, Math.floor(Number(addonQuantity) || 0));
  if (!tier.addonEligible) return tier.baseLimit;
  return tier.baseLimit + addons;
}

/** USD list price for a tier/interval. Free is always 0. */
export function getTierPriceUSD(tierKey, interval = 'monthly') {
  const tier = getTierDefinition(tierKey);
  return interval === 'annual' ? tier.annualUSD : tier.monthlyUSD;
}

/** USD add-on unit price for a tier/interval (0 when add-ons are not offered). */
export function getAddonPriceUSD(tierKey, interval = 'monthly') {
  const tier = getTierDefinition(tierKey);
  if (!tier.addonEligible) return 0;
  return interval === 'annual' ? tier.addonAnnualUSD : tier.addonMonthlyUSD;
}

/** Next tier up the ladder (null at the top). */
export function getNextTierKey(tierKey) {
  const key = normalizeTierKey(tierKey);
  const index = TIER_ORDER.indexOf(key);
  if (index < 0 || index === TIER_ORDER.length - 1) return null;
  return TIER_ORDER[index + 1];
}

/** Paid tiers only (upgrade prompts, admin digests). */
export function listPaidTierKeys() {
  return TIER_ORDER.filter((key) => key !== 'free');
}

export function listTierKeys() {
  return [...TIER_ORDER];
}

/**
 * Paystack plan code for a tier x interval x currency.
 * Resolution: env override (`PAYSTACK_PLAN_<TIER>_<INTERVAL>_<CURRENCY>`),
 * else empty string -> the caller falls back to a one-time checkout.
 */
export function getPlanCode(tierKey, interval = 'monthly', currency = 'USD') {
  const key = normalizeTierKey(tierKey);
  if (key === 'free') return '';
  const safeInterval = interval === 'annual' ? 'ANNUAL' : 'MONTHLY';
  const safeCurrency = String(currency || 'USD').toUpperCase();
  const envKey = `PAYSTACK_PLAN_${key.toUpperCase()}_${safeInterval}_${safeCurrency}`;
  return String(process.env[envKey] || '').trim();
}

/** True when recurring billing is configured for this tier/interval/currency. */
export function hasRecurringPlan(tierKey, interval = 'monthly', currency = 'USD') {
  return Boolean(getPlanCode(tierKey, interval, currency));
}

/** Annual discount percentage vs 12 x monthly (display only). */
export function getAnnualDiscountPercent(tierKey) {
  const tier = getTierDefinition(tierKey);
  const fullYear = tier.monthlyUSD * 12;
  if (!fullYear) return 0;
  return Math.round((1 - tier.annualUSD / fullYear) * 100);
}

export default {
  TIER_ORDER,
  LEGACY_TIER_ALIASES,
  PLAN_CURRENCIES,
  TIER_MATRIX,
  normalizeTierKey,
  isKnownTierKey,
  isPaidTierKey,
  getTierDefinition,
  getTierLabel,
  getBaseVehicleLimit,
  getEffectiveVehicleLimit,
  getTierPriceUSD,
  getAddonPriceUSD,
  getNextTierKey,
  listPaidTierKeys,
  listTierKeys,
  getPlanCode,
  hasRecurringPlan,
  getAnnualDiscountPercent
};
