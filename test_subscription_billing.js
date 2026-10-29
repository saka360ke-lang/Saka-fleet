/**
 * Saka Fleet — Subscription Billing & Entitlements Test Suite (v1.15.0)
 * --------------------------------------------------------------------
 * Stateless: in-memory Supabase mock, zero network calls, zero DB rows.
 * Run: node test_subscription_billing.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  TIER_MATRIX,
  normalizeTierKey,
  getEffectiveVehicleLimit,
  getTierPriceUSD,
  getAddonPriceUSD,
  getNextTierKey,
  getAnnualDiscountPercent,
  listPaidTierKeys,
  getPlanCode
} from './src/services/subscriptionTiers.js';
import { SUBSCRIPTION_TIERS } from './src/services/paystack.js';
import {
  getEntitlements,
  evaluateVehicleCapacity,
  getReportQuota,
  recordReportUsage,
  nairobiMonthKey,
  computePeriodEnd,
  handlePaystackEvent,
  invalidateEntitlements,
  formatSubscriptionSummary,
  findTierForPlanCode
} from './src/services/subscriptions.js';
import { validateCouponForCheckout } from './src/services/coupons.js';
import { resolveTier, AI_TIERS } from './src/services/aiClient.js';
import { checkOwnerVehicleTierLimit } from './src/services/vehicles.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`✅ ${message}`);
}

const future = (days) => new Date(Date.now() + days * 86400000).toISOString();
const past = (days) => new Date(Date.now() - days * 86400000).toISOString();

function profile(overrides = {}) {
  return {
    id: 'p-1',
    phone_number: '+254700000001',
    email: 'owner@example.com',
    full_name: 'Test Owner',
    subscription_tier: 'free',
    subscription_status: 'ACTIVE',
    billing_interval: 'monthly',
    addon_quantity: 0,
    trial_used_at: null,
    ...overrides
  };
}

async function run() {
  console.log('=== SUBSCRIPTION BILLING & ENTITLEMENTS TESTS ===\n');
  invalidateEntitlements();

  console.log('--- Test 1: frozen tier matrix ---');
  check(TIER_MATRIX.free.baseLimit === 1, 'Free = 1 vehicle');
  check(TIER_MATRIX.solo_pro.baseLimit === 1, 'Solo Pro = 1 vehicle (all features)');
  check(TIER_MATRIX.team_fleet.baseLimit === 3, 'Team Fleet = 3 vehicles');
  check(TIER_MATRIX.growth.baseLimit === 5, 'Growth Fleet = 5 vehicles');
  check(TIER_MATRIX.fleet_command.baseLimit === 5 && TIER_MATRIX.fleet_command.addonEligible, 'Fleet Command = 5 + add-ons');
  check(TIER_MATRIX.free.maxAiTier === 1 && TIER_MATRIX.growth.maxAiTier === 3, 'Free clamps AI to Tier 1; paid tiers unlock 0-3');
  check(TIER_MATRIX.free.reportsPerMonth === 1 && TIER_MATRIX.solo_pro.reportsPerMonth === Infinity, 'Free = 1 report/month; paid = unlimited');
  check(normalizeTierKey('unlimited') === 'fleet_command', 'Legacy "unlimited" maps to Fleet Command');
  check(normalizeTierKey('solo') === 'solo_pro' && normalizeTierKey('enterprise') === 'fleet_command', 'Legacy aliases resolve');
  check(normalizeTierKey('banana') === 'free', 'Unknown tiers fail closed to Free');

  console.log('\n--- Test 2: pricing, add-ons & ladder ---');
  check(getTierPriceUSD('solo_pro', 'monthly') === 7.99 && getTierPriceUSD('solo_pro', 'annual') === 67.12, 'Solo Pro pricing');
  check(getTierPriceUSD('team_fleet', 'monthly') === 19.99, 'Team Fleet pricing');
  check(getTierPriceUSD('growth', 'annual') === 251.92, 'Growth annual pricing');
  check(getAddonPriceUSD('fleet_command', 'monthly') === 4.99, 'Fleet Command add-on unit price');
  check(getAddonPriceUSD('growth', 'monthly') === 0, 'Non-Fleet-Command tiers cannot buy add-ons');
  check(getEffectiveVehicleLimit('fleet_command', 2) === 7, 'Fleet Command capacity = 5 + add-on quantity');
  check(getEffectiveVehicleLimit('growth', 9) === 5, 'Add-ons are ignored outside Fleet Command');
  check(getNextTierKey('free') === 'solo_pro' && getNextTierKey('growth') === 'fleet_command' && getNextTierKey('fleet_command') === null, 'Upgrade ladder');
  check(getAnnualDiscountPercent('growth') > 25, 'Annual billing advertises a >25% discount');
  check(listPaidTierKeys().length === 4, 'Four paid tiers');

  console.log('\n--- Test 3: backward-compatible SUBSCRIPTION_TIERS view ---');
  check(SUBSCRIPTION_TIERS.solo_pro.vehicleLimit === 1, 'Legacy view derives Solo Pro from the registry');
  check(SUBSCRIPTION_TIERS.growth.pricing.monthlyUSD === 29.99, 'Legacy pricing view is registry-backed');
  check(SUBSCRIPTION_TIERS.fleet_command.addonEligible === true, 'Legacy view exposes add-on eligibility');

  console.log('\n--- Test 4: Paystack plan codes ---');
  const envKey = 'PAYSTACK_PLAN_GROWTH_ANNUAL_USD';
  const originalPlan = process.env[envKey];
  process.env[envKey] = 'PLN_GROWTH_ANNUAL_USD';
  check(getPlanCode('growth', 'annual', 'USD') === 'PLN_GROWTH_ANNUAL_USD', 'Env plan code resolves');
  check(findTierForPlanCode('PLN_GROWTH_ANNUAL_USD')?.tierKey === 'growth', 'Plan code reverse-maps to a tier');
  if (originalPlan === undefined) delete process.env[envKey];
  else process.env[envKey] = originalPlan;
  check(getPlanCode('free', 'monthly', 'USD') === '', 'Free has no plan code');

  console.log('\n--- Test 5: AI entitlement clamp (premium routing) ---');
  const originalPremium = process.env.PREMIUM_MODEL_ENABLED;
  process.env.PREMIUM_MODEL_ENABLED = 'on';
  check(resolveTier('intent_classify', { maxTier: 1 }).tier === AI_TIERS.ROUTER, 'Free clamp forces Tier 1');
  check(resolveTier('intent_classify', { maxTier: 3 }).tier === AI_TIERS.CONVERSATIONAL, 'Paid clamp allows Tier 2');
  check(resolveTier('health_synthesis', {}).tier === AI_TIERS.REASONING, 'Background purposes keep Tier 3 (no clamp)');
  if (originalPremium === undefined) delete process.env.PREMIUM_MODEL_ENABLED;
  else process.env.PREMIUM_MODEL_ENABLED = originalPremium;

  console.log('\n--- Test 6: entitlement resolution (free / trial / paid) ---');
  invalidateEntitlements();

  const freeProfile = profile();
  const freeMock = createMockSupabase({ profiles: [freeProfile], trial_sessions: [], usage_counters: [], vehicles: [] });
  const freeEnt = await getEntitlements({ supabase: freeMock.client, ownerId: 'p-1', profile: freeProfile, useCache: false });
  check(freeEnt.tierKey === 'free' && freeEnt.maxAiTier === 1, 'Free entitlements clamp AI to Tier 1');
  check(freeEnt.reportsPerMonth === 1 && freeEnt.driverAssignment === false, 'Free gates reports + driver assignment');
  check(freeEnt.effectiveVehicleCapacity === 1, 'Free capacity = 1 vehicle');

  const trialingProfile = profile({
    subscription_tier: 'growth',
    subscription_status: 'TRIALING',
    trial_used_at: past(1),
    billing_interval: 'annual'
  });
  const trialingMock = createMockSupabase({
    profiles: [trialingProfile],
    trial_sessions: [{
      id: 't-1',
      owner_id: 'p-1',
      tier: 'growth',
      interval: 'annual',
      status: 'ACTIVE',
      started_at: past(2),
      ends_at: future(28),
      activated: false
    }],
    usage_counters: [],
    vehicles: []
  });
  const trialEnt = await getEntitlements({ supabase: trialingMock.client, ownerId: 'p-1', profile: trialingProfile, useCache: false });
  check(trialEnt.isTrial === true && trialEnt.tierKey === 'growth', 'Active trial gets paid-tier entitlements');
  check(trialEnt.maxAiTier === 3 && trialEnt.reportsPerMonth === Infinity, 'Trial unlocks full AI + unlimited reports');
  check(trialEnt.effectiveVehicleCapacity === 5, 'Trial capacity follows the trialed tier');
  check(trialEnt.trialDaysLeft >= 27, 'Trial days-left is reported');

  const paidProfile = profile({
    subscription_tier: 'fleet_command',
    subscription_status: 'ACTIVE',
    addon_quantity: 2,
    subscription_period_end: future(20)
  });
  const paidMock = createMockSupabase({
    profiles: [paidProfile],
    trial_sessions: [],
    usage_counters: [],
    vehicles: [{ id: 'v1', owner_id: 'p-1', status: 'ACTIVE', updated_at: past(2) }]
  });
  const paidEnt = await getEntitlements({ supabase: paidMock.client, ownerId: 'p-1', profile: paidProfile, useCache: false });
  check(paidEnt.tierKey === 'fleet_command' && paidEnt.addonQuantity === 2, 'Fleet Command add-on quantity is applied');
  check(paidEnt.effectiveVehicleCapacity === 7, 'Effective capacity = 5 base + 2 add-ons');

  console.log('\n--- Test 7: cancellation & lazy downgrade (Simple Rule R4) ---');
  const cancelingProfile = profile({
    subscription_tier: 'team_fleet',
    subscription_status: 'CANCELING',
    cancel_at_period_end: true,
    subscription_period_end: future(10)
  });
  const cancelingMock = createMockSupabase({ profiles: [cancelingProfile], trial_sessions: [], usage_counters: [], vehicles: [] });
  const cancelingEnt = await getEntitlements({ supabase: cancelingMock.client, ownerId: 'p-1', profile: cancelingProfile, useCache: false });
  check(cancelingEnt.isPaid === true && cancelingEnt.cancelAtPeriodEnd === true, 'CANCELING retains full access until period end');

  const expiredProfile = profile({
    subscription_tier: 'growth',
    subscription_status: 'CANCELING',
    cancel_at_period_end: true,
    subscription_period_end: past(2)
  });
  const expiredMock = createMockSupabase({
    profiles: [expiredProfile],
    trial_sessions: [],
    usage_counters: [],
    subscriptions: [{ id: 's1', owner_id: 'p-1', status: 'ACTIVE' }],
    vehicles: [
      { id: 'v1', owner_id: 'p-1', plate_number: 'KDA 111A', status: 'ACTIVE', updated_at: past(1) },
      { id: 'v2', owner_id: 'p-1', plate_number: 'KDA 222B', status: 'ACTIVE', updated_at: past(3) },
      { id: 'v3', owner_id: 'p-1', plate_number: 'KDA 333C', status: 'ACTIVE', updated_at: past(5) }
    ]
  });
  const expiredEnt = await getEntitlements({ supabase: expiredMock.client, ownerId: 'p-1', profile: expiredProfile, useCache: false });
  check(expiredEnt.tierKey === 'free' && expiredEnt.downgraded === true, 'Expired paid tier lazily downgrades to Free');
  check((expiredEnt.pausedVehicles || []).length === 2, 'Downgrade pauses every vehicle beyond the Free slot');
  const pausedRows = expiredMock.db.vehicles.filter((v) => v.status === 'PAUSED');
  check(pausedRows.length === 2 && expiredMock.db.vehicles.some((v) => v.status === 'ACTIVE'), 'Exactly one vehicle stays active (data preserved)');
  check(expiredMock.db.profiles[0].subscription_tier === 'free' && Number(expiredMock.db.profiles[0].addon_quantity) === 0, 'Profile resets to Free without deleting history');

  console.log('\n--- Test 8: report quota (Free = 1/month, Nairobi month) ---');
  check(/^\d{4}-\d{2}$/.test(nairobiMonthKey()), 'Nairobi month key is YYYY-MM');

  const quotaFreeMock = createMockSupabase({
    profiles: [freeProfile],
    trial_sessions: [],
    usage_counters: [{ owner_id: 'p-1', period_key: nairobiMonthKey(), report_count: 0 }],
    vehicles: []
  });
  const quotaFresh = await getReportQuota({ supabase: quotaFreeMock.client, ownerId: 'p-1', profile: freeProfile });
  check(quotaFresh.canGenerate === true && quotaFresh.remaining === 1, 'First Free report is allowed');

  await recordReportUsage({ supabase: quotaFreeMock.client, ownerId: 'p-1' });
  invalidateEntitlements();
  const quotaUsed = await getReportQuota({ supabase: quotaFreeMock.client, ownerId: 'p-1', profile: freeProfile });
  check(quotaUsed.canGenerate === false && quotaUsed.used === 1, 'Second Free report in the month is blocked');

  const quotaPaidMock = createMockSupabase({ profiles: [paidProfile], trial_sessions: [], usage_counters: [], vehicles: [] });
  invalidateEntitlements();
  const quotaPaid = await getReportQuota({ supabase: quotaPaidMock.client, ownerId: 'p-1', profile: paidProfile });
  check(quotaPaid.unlimited === true && quotaPaid.canGenerate === true, 'Paid tiers have unlimited reports');

  console.log('\n--- Test 9: checkout coupon validation (percent / flat / scope / trial-extension) ---');
  const couponMock = createMockSupabase({
    profiles: [profile()],
    coupons: [
      { id: 'c1', code: 'SAVE20', discount_percent: 20, max_uses: 5, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', applies_to_interval: 'both', expires_at: future(5) },
      { id: 'c2', code: 'FLAT5', discount_percent: 0, discount_amount: 5, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', applies_to_interval: 'both', expires_at: future(5) },
      { id: 'c3', code: 'WINBACK40', discount_percent: 40, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'annual_subscription', expires_at: future(5) },
      { id: 'c4', code: 'EXTEND15', discount_percent: 100, trial_extension_days: 15, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'account_trial_extension', expires_at: future(5) },
      { id: 'c5', code: 'OLD10', discount_percent: 10, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', expires_at: past(2) },
      { id: 'c6', code: 'USED10', discount_percent: 10, max_uses: 1, current_uses: 1, status: 'applied', applicable_to: 'subscription', expires_at: future(2) }
    ]
  });

  const pct = await validateCouponForCheckout({ supabase: couponMock.client, code: 'save20', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 29.99 });
  check(pct.valid && pct.discountType === 'percent' && pct.discountUSD === 6, 'Percent coupon computes a 20% discount');
  check(pct.payableUSD === 23.99, 'Percent coupon reduces the payable amount');

  const flat = await validateCouponForCheckout({ supabase: couponMock.client, code: 'FLAT5', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 29.99 });
  check(flat.valid && flat.discountType === 'flat' && flat.discountUSD === 5, 'Flat coupon subtracts a fixed amount');

  const annualOnlyMonthly = await validateCouponForCheckout({ supabase: couponMock.client, code: 'WINBACK40', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 29.99 });
  check(annualOnlyMonthly.valid === false && /annual/i.test(annualOnlyMonthly.error), 'Annual-only coupon is rejected on monthly billing');

  const annualOnlyAnnual = await validateCouponForCheckout({ supabase: couponMock.client, code: 'WINBACK40', tierKey: 'growth', interval: 'annual', ownerId: 'p-1', amountUSD: 251.92 });
  check(annualOnlyAnnual.valid === true && annualOnlyAnnual.discountUSD === 100.77, 'Winback coupon applies 40% to the annual plan');

  const extensionCoupon = await validateCouponForCheckout({ supabase: couponMock.client, code: 'EXTEND15', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 29.99 });
  check(extensionCoupon.valid === false && /trial/i.test(extensionCoupon.error), 'Trial-extension coupons are not checkout discounts');

  const expiredCoupon = await validateCouponForCheckout({ supabase: couponMock.client, code: 'OLD10', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 29.99 });
  check(expiredCoupon.valid === false && /expired/i.test(expiredCoupon.error), 'Expired coupons are rejected');

  const usedCoupon = await validateCouponForCheckout({ supabase: couponMock.client, code: 'USED10', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 29.99 });
  check(usedCoupon.valid === false, 'Redeemed coupons are rejected');

  console.log('\n--- Test 10: Paystack webhook state machine ---');
  const hookMock = createMockSupabase({
    profiles: [profile()],
    trial_sessions: [{ id: 't-1', owner_id: 'p-1', tier: 'growth', status: 'ACTIVE', started_at: past(3), ends_at: future(27), activation_events: [] }],
    subscriptions: [],
    paystack_webhook_events: [],
    usage_counters: [],
    vehicles: []
  });
  const createEvent = {
    event: 'subscription.create',
    data: {
      id: 9001,
      subscription_code: 'SUB_1',
      status: 'active',
      next_payment_date: future(30),
      plan: { plan_code: 'PLN_GROWTH_ANNUAL_USD' },
      customer: { email: 'owner@example.com', customer_code: 'CUS_1' },
      email_token: 'tok_1',
      metadata: { user_id: 'p-1', target_tier: 'growth', billing_interval: 'annual' }
    }
  };
  const created = await handlePaystackEvent({ supabase: hookMock.client, event: createEvent });
  check(created.handled === true && created.type === 'subscription.create', 'subscription.create is handled');
  check(hookMock.db.profiles[0].subscription_tier === 'growth' && hookMock.db.profiles[0].subscription_status === 'ACTIVE', 'Profile activates the paid tier');
  check(hookMock.db.profiles[0].paystack_subscription_code === 'SUB_1' && hookMock.db.profiles[0].paystack_email_token === 'tok_1', 'Subscription code + email token are stored');
  check(hookMock.db.subscriptions.length === 1 && hookMock.db.subscriptions[0].paystack_subscription_code === 'SUB_1', 'Ledger row is written');
  check(hookMock.db.trial_sessions[0].status === 'CONVERTED', 'Active trial converts on subscription.create');

  const duplicate = await handlePaystackEvent({ supabase: hookMock.client, event: createEvent });
  check(duplicate.duplicate === true, 'Duplicate webhook events are ignored (idempotency)');

  const failedEvent = {
    event: 'invoice.payment_failed',
    data: { id: 9002, subscription: { subscription_code: 'SUB_1' }, status: 'failed', customer: { email: 'owner@example.com' } }
  };
  const failed = await handlePaystackEvent({ supabase: hookMock.client, event: failedEvent });
  check(failed.handled === true && hookMock.db.profiles[0].subscription_status === 'PAST_DUE', 'Failed renewal marks PAST_DUE');

  const addonEvent = {
    event: 'charge.success',
    data: { id: 9003, customer: { email: 'owner@example.com' }, metadata: { type: 'fleet_addon', addon_quantity: 2, user_id: 'p-1' } }
  };
  const addonRes = await handlePaystackEvent({ supabase: hookMock.client, event: addonEvent });
  check(addonRes.handled === true && addonRes.type === 'fleet_addon', 'Add-on charge is handled');
  check(Number(hookMock.db.profiles[0].addon_quantity) === 2 && hookMock.db.profiles[0].subscription_tier === 'fleet_command', 'Add-on quantity activates Fleet Command slots');

  const disableMock = createMockSupabase({
    profiles: [profile({ subscription_tier: 'growth', subscription_status: 'ACTIVE', subscription_period_end: past(1) })],
    trial_sessions: [],
    subscriptions: [{ id: 's1', owner_id: 'p-1', paystack_subscription_code: 'SUB_2', status: 'ACTIVE' }],
    paystack_webhook_events: [],
    usage_counters: [],
    vehicles: [
      { id: 'v1', owner_id: 'p-1', plate_number: 'KDA 111A', status: 'ACTIVE', updated_at: past(1) },
      { id: 'v2', owner_id: 'p-1', plate_number: 'KDA 222B', status: 'ACTIVE', updated_at: past(2) }
    ]
  });
  const disabled = await handlePaystackEvent({
    supabase: disableMock.client,
    event: { event: 'subscription.disable', data: { id: 9004, subscription_code: 'SUB_2', customer: { email: 'owner@example.com' } } }
  });
  check(disabled.handled === true && disableMock.db.profiles[0].subscription_tier === 'free', 'subscription.disable past period downgrades to Free');
  check(disableMock.db.vehicles.filter((v) => v.status === 'PAUSED').length === 1, 'Downgrade pauses excess vehicles');

  console.log('\n--- Test 11: legacy tier gate, summary & period math ---');
  const gateMock = createMockSupabase({
    profiles: [profile({ subscription_tier: 'fleet_command', addon_quantity: 2 })],
    vehicles: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `v${n}`, owner_id: 'p-1', deleted_at: null }))
  });
  const gate = await checkOwnerVehicleTierLimit({ ownerId: 'p-1', subscriptionTier: 'fleet_command', supabase: gateMock.client });
  check(gate.limit === 7 && gate.currentCount === 6 && gate.canAdd === true, 'checkOwnerVehicleTierLimit honours add-ons');
  check(gate.addonEligible === true && gate.addonPriceUSD === 4.99, 'Tier gate exposes add-on pricing');
  check(gate.tier === 'fleet_command' && gate.nextTierKey === null, 'Tier gate normalizes the tier key');

  const summary = await formatSubscriptionSummary({ supabase: paidMock.client, entitlements: paidEnt, currency: 'USD' });
  check(summary.includes('Fleet Command') && summary.includes('Unlimited'), 'Subscription summary renders plan + quotas');
  check(summary.includes('base 5 + 2 add-on'), 'Subscription summary explains add-on slots');

  const monthEnd = computePeriodEnd('monthly', new Date('2026-01-01T00:00:00.000Z'));
  const yearEnd = computePeriodEnd('annual', new Date('2026-01-01T00:00:00.000Z'));
  check(monthEnd.toISOString().startsWith('2026-01-31'), 'Monthly period = +30 days');
  check(yearEnd.toISOString().startsWith('2027-01-01'), 'Annual period = +1 year');

  return passed;
}

run()
  .then((count) => console.log(`\n✅ PART 1 OK (${count} assertions).`))
  .catch((err) => {
    console.error('❌ TEST FAILED:', err.message);
    process.exit(1);
  });
