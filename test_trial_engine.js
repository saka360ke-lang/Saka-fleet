/**
 * Saka Fleet — Trial Engine Test Suite (v1.15.0)
 * ---------------------------------------------
 * Stateless: in-memory Supabase mock + stubbed WhatsApp sender. Zero network.
 * Covers: 30-day window, 3-point activation (reminders NEVER activate),
 * once-per-owner enforcement, extension cap, lifecycle nudges, expiry -> Free.
 *
 * Run: node test_trial_engine.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  TRIAL_DAYS,
  TRIAL_MAX_TOTAL_DAYS,
  TRIAL_ACTIVATION_COUPON_PCT,
  ACTIVATION_EVENTS,
  ACTIVATION_EVENT_VALUES,
  getTrialConfig,
  computeTrialEnd,
  startAccountTrial,
  recordActivationEvent,
  extendAccountTrial,
  applyAccountTrialExtensionCoupon,
  runTrialLifecycleSweep,
  getTrialFunnelStats,
  formatTrialStatsReply
} from './src/services/trialEngine.js';
import { invalidateEntitlements } from './src/services/subscriptions.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`✅ ${message}`);
}

const DAY = 86400000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();
const past = (days) => new Date(Date.now() - days * DAY).toISOString();

function ownerProfile(overrides = {}) {
  return {
    id: 'p-1',
    phone_number: '+254700000001',
    email: 'owner@example.com',
    full_name: 'Test Owner',
    subscription_tier: 'free',
    subscription_status: 'ACTIVE',
    billing_interval: 'monthly',
    trial_used_at: null,
    ...overrides
  };
}

function trialRow(overrides = {}) {
  return {
    id: 't-1',
    owner_id: 'p-1',
    tier: 'growth',
    interval: 'annual',
    status: 'ACTIVE',
    started_at: past(1),
    ends_at: future(29),
    activated: false,
    activation_events: [],
    nudge_activation_sent_at: null,
    nudge_midpoint_sent_at: null,
    nudge_t3_sent_at: null,
    nudge_t24_sent_at: null,
    expiry_processed_at: null,
    ...overrides
  };
}

async function run() {
  console.log('=== TRIAL ENGINE TESTS ===\n');
  const originalPaystackKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = '';

  console.log('--- Test 1: 30-day window & configuration ---');
  check(TRIAL_DAYS === 30, `Trial lasts 30 days (got ${TRIAL_DAYS})`);
  check(TRIAL_MAX_TOTAL_DAYS === 45, `Cumulative trial cap = 45 days (got ${TRIAL_MAX_TOTAL_DAYS})`);
  check(TRIAL_ACTIVATION_COUPON_PCT === 20, 'Activation coupon = 20%');
  check(ACTIVATION_EVENT_VALUES.length === 3, 'Exactly three activation events');
  check(ACTIVATION_EVENT_VALUES.includes('vehicle_registered') && ACTIVATION_EVENT_VALUES.includes('expense_logged') && ACTIVATION_EVENT_VALUES.includes('report_generated'), 'Activation = vehicle / expense / report');
  check(!ACTIVATION_EVENT_VALUES.some((e) => /reminder/.test(e)), 'Reminders are NOT an activation event');
  const cfg = getTrialConfig();
  check(cfg.trialDays === 30 && cfg.activationEvents.length === 3, 'Config snapshot matches the registry');

  const start = new Date('2026-01-01T00:00:00.000Z');
  const end = computeTrialEnd(start);
  check(Math.round((end.getTime() - start.getTime()) / DAY) === 30, 'computeTrialEnd adds exactly 30 days');

  console.log('\n--- Test 2: trial start (no card, once per lifetime) ---');
  invalidateEntitlements();
  const eligibleMock = createMockSupabase({ profiles: [ownerProfile()], trial_sessions: [], usage_counters: [], vehicles: [] });
  const started = await startAccountTrial({ supabase: eligibleMock.client, ownerId: 'p-1', tierKey: 'growth', interval: 'annual' });
  check(started.started === true && started.days === 30, 'Eligible owner starts a 30-day trial');
  check(Math.round((new Date(started.endsAt).getTime() - new Date(started.startedAt).getTime()) / DAY) === 30, 'ends_at = started_at + 30 days');
  check(eligibleMock.db.trial_sessions.length === 1 && eligibleMock.db.trial_sessions[0].status === 'ACTIVE', 'trial_sessions row is ACTIVE');
  check(eligibleMock.db.profiles[0].subscription_tier === 'growth' && eligibleMock.db.profiles[0].subscription_status === 'TRIALING', 'Profile becomes TRIALING on the chosen tier');
  check(Boolean(eligibleMock.db.profiles[0].trial_used_at), 'profiles.trial_used_at is stamped');
  check(eligibleMock.state.inserts.every((i) => i.table !== 'subscriptions'), 'No Paystack subscription row is created at trial start');

  const reusedMock = createMockSupabase({
    profiles: [ownerProfile({ trial_used_at: past(90) })],
    trial_sessions: [],
    usage_counters: [],
    vehicles: []
  });
  const blocked = await startAccountTrial({ supabase: reusedMock.client, ownerId: 'p-1', tierKey: 'growth' });
  check(blocked.started === false && blocked.reason === 'trial_already_used', 'Second lifetime trial is blocked');
  check(reusedMock.db.trial_sessions.length === 0, 'Blocked trial writes no rows');

  const activeMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'growth', subscription_status: 'TRIALING', trial_used_at: past(2) })],
    trial_sessions: [trialRow()],
    usage_counters: [],
    vehicles: []
  });
  const already = await startAccountTrial({ supabase: activeMock.client, ownerId: 'p-1', tierKey: 'team_fleet' });
  check(already.started === false && already.reason === 'trial_active', 'An active trial is returned instead of starting another');
  check(activeMock.db.trial_sessions.length === 1, 'No duplicate trial row is inserted');

  const freeAttempt = await startAccountTrial({ supabase: eligibleMock.client, ownerId: 'p-1', tierKey: 'free' });
  check(freeAttempt.started === false && /paid tier/.test(freeAttempt.reason), 'Free tier cannot start a trial');

  console.log('\n--- Test 3: activation (strictly three events) ---');
  const actMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'growth', subscription_status: 'TRIALING', trial_used_at: past(1) })],
    trial_sessions: [trialRow()],
    coupons: [],
    usage_counters: [],
    vehicles: []
  });

  const reminderEvent = await recordActivationEvent({ supabase: actMock.client, ownerId: 'p-1', event: 'reminder_created' });
  check(reminderEvent.recorded === false && /unknown activation event/.test(reminderEvent.reason), 'Reminder events never activate a trial');
  check(actMock.db.trial_sessions[0].activated === false, 'Trial stays un-activated after a reminder event');

  const firstEvent = await recordActivationEvent({ supabase: actMock.client, ownerId: 'p-1', event: ACTIVATION_EVENTS.VEHICLE_REGISTERED });
  check(firstEvent.recorded === true && firstEvent.activatedNow === true, 'Vehicle registration activates the trial');
  check(actMock.db.trial_sessions[0].activated === true && Boolean(actMock.db.trial_sessions[0].activated_at), 'Activation timestamp is stored');
  check(actMock.db.trial_sessions[0].activation_events.includes('vehicle_registered'), 'Activation event is recorded');
  check(actMock.db.coupons.length === 1, 'Activation coupon is issued exactly once');
  check(/^ACTIVATE20-/.test(actMock.db.coupons[0].code) && actMock.db.coupons[0].discount_percent === 20, 'Activation coupon is 20%');
  check(actMock.db.coupons[0].applicable_to === 'subscription', 'Activation coupon is scoped to subscription checkout');

  const duplicateEvent = await recordActivationEvent({ supabase: actMock.client, ownerId: 'p-1', event: ACTIVATION_EVENTS.VEHICLE_REGISTERED });
  check(duplicateEvent.recorded === false && duplicateEvent.duplicate === true, 'Duplicate activation events are ignored');

  const secondEvent = await recordActivationEvent({ supabase: actMock.client, ownerId: 'p-1', event: ACTIVATION_EVENTS.EXPENSE_LOGGED });
  check(secondEvent.recorded === true && secondEvent.activatedNow === false, 'Later events append without re-activating');
  check(actMock.db.trial_sessions[0].activation_events.length === 2, 'Activation events accumulate');
  check(actMock.db.coupons.length === 1, 'No second activation coupon is issued');

  const noTrialMock = createMockSupabase({ profiles: [ownerProfile()], trial_sessions: [], usage_counters: [], vehicles: [] });
  const noTrial = await recordActivationEvent({ supabase: noTrialMock.client, ownerId: 'p-1', event: ACTIVATION_EVENTS.REPORT_GENERATED });
  check(noTrial.recorded === false && /no active trial/.test(noTrial.reason), 'Activation is a no-op without an active trial');

  console.log('\n--- Test 4: extensions are capped (45 days total) ---');
  const extMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'growth', subscription_status: 'TRIALING', trial_used_at: past(10) })],
    trial_sessions: [trialRow({ started_at: past(10), ends_at: future(20) })],
    coupons: [],
    usage_counters: [],
    vehicles: []
  });
  const firstExtend = await extendAccountTrial({ supabase: extMock.client, ownerId: 'p-1', days: 10 });
  check(firstExtend.ok === true && firstExtend.daysAdded === 10, 'Trial extension adds the requested days');
  check(extMock.db.trial_sessions[0].status === 'EXTENDED', 'Extended trial is flagged EXTENDED');
  check(extMock.db.trial_sessions[0].nudge_t3_sent_at === null, 'Nudges are re-armed after extension');

  const overExtend = await extendAccountTrial({ supabase: extMock.client, ownerId: 'p-1', days: 60 });
  check(overExtend.ok === true && overExtend.capped === true, 'Extension is clamped to the cumulative cap');
  check(overExtend.totalDays <= TRIAL_MAX_TOTAL_DAYS, `Total trial days never exceeds ${TRIAL_MAX_TOTAL_DAYS}`);

  const noTrialExtend = await extendAccountTrial({ supabase: noTrialMock.client, ownerId: 'p-1', days: 5 });
  check(noTrialExtend.ok === false, 'Cannot extend without an active trial');

  console.log('\n--- Test 5: account-trial extension coupons ---');
  const couponMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'growth', subscription_status: 'TRIALING', trial_used_at: past(5) })],
    trial_sessions: [trialRow({ started_at: past(5), ends_at: future(25) })],
    coupons: [{
      id: 'c1',
      code: 'EXTEND15',
      applicable_to: 'account_trial_extension',
      trial_extension_days: 15,
      max_uses: 1,
      current_uses: 0,
      status: 'dispatched',
      expires_at: future(5)
    }],
    usage_counters: [],
    vehicles: []
  });
  const redeemed = await applyAccountTrialExtensionCoupon({ supabase: couponMock.client, ownerId: 'p-1', code: 'extend15' });
  check(redeemed.ok === true && redeemed.daysAdded > 0, 'Trial-extension coupon extends the account trial');
  check(couponMock.db.coupons[0].status === 'applied' && couponMock.db.coupons[0].current_uses === 1, 'Coupon is marked applied');
  const redeemedAgain = await applyAccountTrialExtensionCoupon({ supabase: couponMock.client, ownerId: 'p-1', code: 'EXTEND15' });
  check(redeemedAgain.ok === false && /already/.test(redeemedAgain.error), 'Extension coupon cannot be reused');
  const missingCoupon = await applyAccountTrialExtensionCoupon({ supabase: couponMock.client, ownerId: 'p-1', code: 'NOPE' });
  check(missingCoupon.ok === false && /No account trial extension coupon/.test(missingCoupon.error), 'Unknown extension codes are rejected');

  console.log('\n--- Test 6: lifecycle sweep (nudges fire exactly once) ---');
  const makeSweep = (trialOverrides, profileOverrides = {}, extra = {}) => {
    const mock = createMockSupabase({
      profiles: [ownerProfile({ subscription_tier: 'growth', subscription_status: 'TRIALING', trial_used_at: past(5), ...profileOverrides })],
      trial_sessions: [trialRow(trialOverrides)],
      coupons: [],
      usage_counters: [],
      vehicles: [],
      expense_logs: [],
      reminders: [],
      ai_usage_logs: [],
      ...extra
    });
    const sent = [];
    const send = async (_to, message) => { sent.push(message); };
    return { mock, sent, send };
  };

  const t3 = makeSweep({ started_at: past(27.5), ends_at: future(2.5), nudge_activation_sent_at: past(20) });
  const t3stats = await runTrialLifecycleSweep({ supabase: t3.mock.client, sendWhatsAppFn: t3.send });
  check(t3stats.t3 === 1 && t3.sent.length === 1, 'T-3 digest is sent once');
  check(/trial ends in 3 days/i.test(t3.sent[0]) && /hour\(s\) saved|hours? saved/i.test(t3.sent[0]), 'T-3 digest contains value metrics');
  check(Boolean(t3.mock.db.trial_sessions[0].nudge_t3_sent_at), 'T-3 timestamp is persisted');
  const t3again = await runTrialLifecycleSweep({ supabase: t3.mock.client, sendWhatsAppFn: t3.send });
  check(t3again.t3 === 0 && t3.sent.length === 1, 'T-3 digest never repeats');

  const t24 = makeSweep({ started_at: past(29.5), ends_at: future(0.5), nudge_activation_sent_at: past(22) });
  const t24stats = await runTrialLifecycleSweep({ supabase: t24.mock.client, sendWhatsAppFn: t24.send });
  check(t24stats.t24 === 1 || t24stats.t3 === 1, 'T-24h / T-3 urgency stage fires');
  check(t24.sent.length === 1, 'Only one nudge per sweep tick');

  const activationNudge = makeSweep({ started_at: past(8), ends_at: future(22) });
  const actStats = await runTrialLifecycleSweep({ supabase: activationNudge.mock.client, sendWhatsAppFn: activationNudge.send });
  check(actStats.activationNudges === 1 && /Getting the most/i.test(activationNudge.sent[0]), 'Un-activated trial gets the T+7d nudge');
  const actAgain = await runTrialLifecycleSweep({ supabase: activationNudge.mock.client, sendWhatsAppFn: activationNudge.send });
  check(actAgain.activationNudges === 0, 'Activation nudge never repeats');

  const reward = makeSweep({ activated: true, activated_at: past(1), started_at: past(3), ends_at: future(27) });
  const rewardStats = await runTrialLifecycleSweep({ supabase: reward.mock.client, sendWhatsAppFn: reward.send });
  check(rewardStats.activationRewards === 1 && /unlocked the full Saka experience/i.test(reward.sent[0]), 'Activated trial receives the reward message once');
  const rewardAgain = await runTrialLifecycleSweep({ supabase: reward.mock.client, sendWhatsAppFn: reward.send });
  check(rewardAgain.activationRewards === undefined || rewardAgain.activationRewards === 0, 'Activation reward never repeats');

  console.log('\n--- Test 7: expiry -> Free with PAUSED vehicles (data preserved) ---');
  const expiry = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'growth', subscription_status: 'TRIALING', trial_used_at: past(31) })],
    trial_sessions: [trialRow({ started_at: past(31), ends_at: past(1), activated: true, activated_at: past(20) })],
    coupons: [],
    usage_counters: [],
    subscriptions: [],
    paystack_webhook_events: [],
    expense_logs: [],
    reminders: [],
    ai_usage_logs: [],
    vehicles: [
      { id: 'v1', owner_id: 'p-1', plate_number: 'KDA 111A', status: 'ACTIVE', updated_at: past(1) },
      { id: 'v2', owner_id: 'p-1', plate_number: 'KDA 222B', status: 'ACTIVE', updated_at: past(3) },
      { id: 'v3', owner_id: 'p-1', plate_number: 'KDA 333C', status: 'ACTIVE', updated_at: past(5) }
    ]
  });
  const expiryMessages = [];
  const expiryStats = await runTrialLifecycleSweep({
    supabase: expiry.client,
    sendWhatsAppFn: async (_to, message) => { expiryMessages.push(message); }
  });
  check(expiryStats.expired === 1, 'Expired trial is processed by the sweep');
  check(expiry.db.trial_sessions[0].status === 'EXPIRED' && Boolean(expiry.db.trial_sessions[0].expiry_processed_at), 'Trial row is marked EXPIRED');
  check(expiry.db.profiles[0].subscription_tier === 'free' && expiry.db.profiles[0].subscription_status === 'ACTIVE', 'Account downgrades to Free');
  check(expiry.db.vehicles.filter((v) => v.status === 'PAUSED').length === 2, 'Excess vehicles are PAUSED, never deleted');
  check(expiry.db.vehicles.every((v) => Boolean(v.plate_number)), 'Paused vehicles keep their identity (passbooks intact)');
  check(expiryMessages.length === 1 && /trial has ended/i.test(expiryMessages[0]), 'Owner receives the expiry message');
  check(/keep vehicle/i.test(expiryMessages[0]), 'Expiry message prompts the KEEP_VEHICLE choice');
  const expiryAgain = await runTrialLifecycleSweep({ supabase: expiry.client, sendWhatsAppFn: async () => {} });
  check(expiryAgain.expired === 0, 'Expired trial is not reprocessed');

  console.log('\n--- Test 8: funnel stats ---');
  const funnelMock = createMockSupabase({
    profiles: [ownerProfile()],
    trial_sessions: [
      { id: 'f1', owner_id: 'p-1', tier: 'growth', status: 'CONVERTED', activated: true, started_at: past(20), converted_at: past(10), ends_at: future(10) },
      { id: 'f2', owner_id: 'p-2', tier: 'growth', status: 'EXPIRED', activated: false, started_at: past(20), ends_at: past(5) },
      { id: 'f3', owner_id: 'p-3', tier: 'team_fleet', status: 'ACTIVE', activated: true, started_at: past(5), ends_at: future(25) },
      { id: 'f4', owner_id: 'p-4', tier: 'growth', status: 'EXTENDED', activated: false, started_at: past(12), ends_at: future(18) },
      { id: 'f5', owner_id: 'p-5', tier: 'growth', status: 'ACTIVE', activated: true, started_at: past(60), ends_at: past(30) }
    ],
    usage_counters: [],
    vehicles: []
  });
  const funnel = await getTrialFunnelStats({ supabase: funnelMock.client, windowDays: 30 });
  check(funnel.started === 4, 'Funnel only counts trials inside the window');
  check(funnel.converted === 1 && funnel.expired === 1, 'Funnel counts conversions and expiries');
  check(funnel.active === 2, 'Active + extended trials are counted as live');
  check(funnel.activated === 2, 'Funnel counts activated trials');
  check(funnel.conversionRate === 25, 'Conversion rate = converted / started');
  check(funnel.byTier.growth?.started >= 3, 'Funnel breaks down by tier');
  const funnelReply = formatTrialStatsReply(funnel);
  check(funnelReply.includes('Trial Funnel') && funnelReply.includes('Converted'), 'Superadmin digest renders deterministic trial stats');
  check(funnelReply.includes('Growth Fleet'), 'Digest labels tiers with their display names');

  return passed;
}

run()
  .then((count) => console.log(`\n✅ TRIAL PART 1 OK (${count} assertions).`))
  .catch((err) => {
    console.error(`❌ TEST FAILED:`, err.message);
    process.exit(1);
  });
