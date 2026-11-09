/**
 * Saka Fleet — Trial Engine Test Suite (v1.15.0)
 * ---------------------------------------------
 * Stateless: in-memory Supabase mock + stubbed WhatsApp sender. Zero network.
 * Covers: 30-day window, 1-point activation (only vehicle registration —
 * expenses, reports and reminders NEVER activate), once-per-owner enforcement,
 * extension cap, lifecycle nudges, expiry -> Free.
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
  startWelcomeTrial,
  recordActivationEvent,
  extendAccountTrial,
  applyAccountTrialExtensionCoupon,
  runTrialLifecycleSweep,
  graceChoiceText,
  fittedPlanKey,
  skipsTrialEndNudge,
  getTrialFunnelStats,
  formatTrialStatsReply,
  FEATURE_TIPS,
  featureTipText,
  resolveFeatureTipState,
  featureNudgeEnabled,
  FEATURE_NUDGE_SWEEP_CAP
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
    // v1.95.0 (Phase 32, Task 3) — the drip-feed stamp columns.
    feature_nudge_sent_at: null,
    feature_nudge_followup_sent_at: null,
    feature_nudge_key: null,
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
  check(ACTIVATION_EVENT_VALUES.length === 1, 'Exactly one activation event (vehicle registration)');
  check(ACTIVATION_EVENT_VALUES[0] === 'vehicle_registered', 'Activation = vehicle registration only');
  check(!ACTIVATION_EVENT_VALUES.includes('expense_logged') && !ACTIVATION_EVENT_VALUES.includes('report_generated'), 'Expenses and reports are NOT activation events');
  check(!ACTIVATION_EVENT_VALUES.some((e) => /reminder/.test(e)), 'Reminders are NOT an activation event');
  const cfg = getTrialConfig();
  check(cfg.trialDays === 30 && cfg.activationEvents.length === 1, 'Config snapshot matches the registry');

  const start = new Date('2026-01-01T00:00:00.000Z');
  const end = computeTrialEnd(start);
  check(Math.round((end.getTime() - start.getTime()) / DAY) === 30, 'computeTrialEnd adds exactly 30 days');

  console.log('\n--- Test 2: trial start (no card, once per lifetime) ---');
  invalidateEntitlements();
  const eligibleMock = createMockSupabase({ profiles: [ownerProfile()], trial_sessions: [], usage_counters: [], vehicles: [] });
  const started = await startAccountTrial({ supabase: eligibleMock.client, ownerId: 'p-1', tierKey: 'growth', interval: 'annual' });
  check(started.started === true && started.days === 30, 'Eligible owner starts a 30-day trial');
  check(started.source === 'upgrade', 'Upgrade trials are tagged "upgrade"');
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

  console.log('\n--- Test 2b: free-tier welcome trial (full features, once per lifetime) ---');
  const welcomeMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'free', subscription_status: 'ACTIVE', trial_used_at: null })],
    trial_sessions: [],
    usage_counters: [],
    vehicles: []
  });
  const welcome = await startWelcomeTrial({ supabase: welcomeMock.client, ownerId: 'p-1' });
  check(welcome.started === true && welcome.source === 'welcome', 'Welcome trial starts and is tagged "welcome"');
  check(welcomeMock.db.trial_sessions[0].tier === (process.env.WELCOME_TRIAL_TIER || 'growth') && welcomeMock.db.trial_sessions[0].source === 'welcome', 'Welcome trial runs on the configured tier (all features)');
  check(welcomeMock.db.profiles[0].subscription_status === 'TRIALING' && Boolean(welcomeMock.db.profiles[0].trial_used_at), 'Profile is TRIALING and the lifetime stamp is set');
  const welcomeAgain = await startWelcomeTrial({ supabase: welcomeMock.client, ownerId: 'p-1' });
  check(welcomeAgain.started === false, 'A second welcome trial is impossible');

  console.log('\n--- Test 2c: the trial anchors to asset creation (v1.58.21) ---');
  const anchor = new Date(Date.now() - 10 * DAY).toISOString();
  const anchorMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'free', subscription_status: 'ACTIVE', trial_used_at: null })],
    trial_sessions: [],
    usage_counters: [],
    vehicles: [],
    coupons: []
  });
  const anchored = await startWelcomeTrial({ supabase: anchorMock.client, ownerId: 'p-1', startedAt: anchor });
  check(anchored.started === true && anchored.startedAt === anchor, 'the trial starts on the asset (passbook) date');
  check(Math.round((new Date(anchored.endsAt).getTime() - new Date(anchor).getTime()) / DAY) === 30, 'the window is exactly 30 days from the asset date');
  check(anchorMock.db.trial_sessions[0].started_at === anchor, 'trial_sessions.started_at carries the anchor');
  const staleMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'free', subscription_status: 'ACTIVE', trial_used_at: null })],
    trial_sessions: [],
    usage_counters: [],
    vehicles: [],
    coupons: []
  });
  const stale = await startWelcomeTrial({ supabase: staleMock.client, ownerId: 'p-1', startedAt: new Date(Date.now() - 40 * DAY).toISOString() });
  check(stale.started === true && new Date(stale.endsAt).getTime() > Date.now(), 'an anchor older than the window falls back to a live trial (never mint a dead one)');

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

  const expenseEvent = await recordActivationEvent({ supabase: actMock.client, ownerId: 'p-1', event: 'expense_logged' });
  check(expenseEvent.recorded === false && /unknown activation event/.test(expenseEvent.reason), 'Logging an expense never activates (1-event rule)');
  const reportEvent = await recordActivationEvent({ supabase: actMock.client, ownerId: 'p-1', event: 'report_generated' });
  check(reportEvent.recorded === false && /unknown activation event/.test(reportEvent.reason), 'Generating a report never activates (1-event rule)');
  check(actMock.db.trial_sessions[0].activation_events.length === 1, 'Only the vehicle event is recorded');
  check(actMock.db.coupons.length === 1, 'No second activation coupon is issued');

  const noTrialMock = createMockSupabase({ profiles: [ownerProfile()], trial_sessions: [], usage_counters: [], vehicles: [] });
  const noTrial = await recordActivationEvent({ supabase: noTrialMock.client, ownerId: 'p-1', event: ACTIVATION_EVENTS.VEHICLE_REGISTERED });
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

  // v1.58.26 — only the explicit, slot-gated launch award may raise the cap.
  const launchExtend = await extendAccountTrial({ supabase: extMock.client, ownerId: 'p-1', days: 183, couponCode: 'LAUNCH183-1', maxTotalDays: 183 });
  check(launchExtend.ok === true && launchExtend.totalDays > TRIAL_MAX_TOTAL_DAYS, 'The launch award can exceed the standard 45-day cap (maxTotalDays)');
  check(launchExtend.totalDays <= 183 && launchExtend.capDays === 183, 'The launch award never exceeds its own 183-day (6-month) cap');
  const normalAfterLaunch = await extendAccountTrial({ supabase: extMock.client, ownerId: 'p-1', days: 30 });
  check(normalAfterLaunch.ok === false && /45 days total/.test(normalAfterLaunch.error || ''), 'A normal coupon is still clamped by TRIAL_MAX_TOTAL_DAYS after an award');

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
  check(couponMock.state.deletes.some((d) => d.table === 'user_context_cache' && d.col === 'owner_id' && d.value === 'p-1'), 'the trial extension coupon invalidates the cached facts (v1.63.1)');
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
    const kinds = [];
    const send = async (_to, message, kind) => { sent.push(message); kinds.push(kind); };
    return { mock, sent, kinds, send };
  };

  const t3 = makeSweep({ started_at: past(27.5), ends_at: future(2.5), nudge_activation_sent_at: past(20) });
  const t3stats = await runTrialLifecycleSweep({ supabase: t3.mock.client, sendWhatsAppFn: t3.send });
  check(t3stats.t3 === 1 && t3.sent.length === 1, 'T-3 digest is sent once');
  check(/trial ends in 3 days/i.test(t3.sent[0]) && /hour\(s\) saved|hours? saved/i.test(t3.sent[0]), 'T-3 digest contains value metrics');
  check(Boolean(t3.mock.db.trial_sessions[0].nudge_t3_sent_at), 'T-3 timestamp is persisted');
  check(t3.kinds[0] === 'trial_ending', 'T-3 digest carries the trial_ending template kind');
  const t3again = await runTrialLifecycleSweep({ supabase: t3.mock.client, sendWhatsAppFn: t3.send });
  check(t3again.t3 === 0 && t3.sent.length === 1, 'T-3 digest never repeats');

  // ---- v1.87.0: the activation nudge speaks the TRIAL's real length ----
  // Live bug: a 183-day launch-award winner was told "Your 30-day trial is running".
  const nudge183 = makeSweep({ started_at: past(8), ends_at: future(175), nudge_activation_sent_at: null });
  await runTrialLifecycleSweep({ supabase: nudge183.mock.client, sendWhatsAppFn: nudge183.send });
  check(nudge183.sent.some((m) => /183-day trial is running/.test(m)), 'the activation nudge names the 183-day award (v1.87.0)');
  const nudge30 = makeSweep({ started_at: past(8), ends_at: future(22), nudge_activation_sent_at: null });
  await runTrialLifecycleSweep({ supabase: nudge30.mock.client, sendWhatsAppFn: nudge30.send });
  check(nudge30.sent.some((m) => /30-day trial is running/.test(m)), 'a standard trial still reads 30-day (v1.87.0)');

  // ---- v1.71.0 (Phase 7): the fitted-plan card rides the T-3 digest ----
  const fitVehicles = (n) => Array.from({ length: n }, (_, i) => ({
    id: `fv-${i + 1}`,
    owner_id: 'p-1',
    plate_number: `KDA 2${i}`,
    status: 'ACTIVE',
    updated_at: past(1),
    deleted_at: null
  }));
  const fitCheckout = async () => ({ ok: true, checkoutUrl: 'https://checkout.test/fit' });
  const fitAddon = async () => ({ ok: true, checkoutUrl: 'https://checkout.test/addon' });

  const t3fit = makeSweep({ started_at: past(27.5), ends_at: future(2.5), nudge_activation_sent_at: past(20) }, {}, { vehicles: fitVehicles(6) });
  const t3fitStats = await runTrialLifecycleSweep({ supabase: t3fit.mock.client, sendWhatsAppFn: t3fit.send, checkoutFn: fitCheckout, addonCheckoutFn: fitAddon });
  check(t3fitStats.t3 === 1 && t3fit.sent.length === 1, 'T-3 + fitted card fire exactly once (one message)');
  const t3fitText = t3fit.sent[0] || '';
  check(/trial ends in 3 days/i.test(t3fitText) && /hour\(s\) saved/i.test(t3fitText), 'the fitted digest keeps the value metrics');
  check(/The plan that fits your 6 assets:\* Fleet Command \+ 1 extra slot/.test(t3fitText), 'the T-3 card names the tier that fits 6 assets (Fleet Command + 1 slot)');
  check(/KES/.test(t3fitText) && !/\$|USD/.test(t3fitText), 'the T-3 card prices in the local currency from the engine');
  check(t3fitText.includes('https://checkout.test/fit') && t3fitText.includes('https://checkout.test/addon'), 'the T-3 card carries the engine checkout links');
  check(t3fit.mock.db.trial_sessions[0].t3_fitted_plan === 'fleet_command+1', 'the fitted-tier snapshot is stamped with the T-3 card');
  const t3fitAgain = await runTrialLifecycleSweep({ supabase: t3fit.mock.client, sendWhatsAppFn: t3fit.send, checkoutFn: fitCheckout, addonCheckoutFn: fitAddon });
  check(t3fitAgain.t3 === 0 && t3fit.sent.length === 1, 'the T-3 card never repeats');

  // T-0: unchanged fitted plan → grace card without any repeated pricing.
  const graceSame = makeSweep({ status: 'ACTIVE', started_at: past(31), ends_at: past(0.5), nudge_activation_sent_at: past(20), nudge_t3_sent_at: past(3), t3_fitted_plan: 'team_fleet' }, {}, { vehicles: fitVehicles(2) });
  const graceSameStats = await runTrialLifecycleSweep({ supabase: graceSame.mock.client, sendWhatsAppFn: graceSame.send, checkoutFn: fitCheckout });
  check(graceSameStats.graceStarted === 1 && graceSameStats.graceNudge === 1, 'T-0 opens the window with the no-repeat grace card');
  const graceSameText = graceSame.sent[0] || '';
  check(/nothing is paused yet/i.test(graceSameText) && /keep <plate>/i.test(graceSameText), 'the grace card keeps the decision + downsize path');
  check(!/Team Fleet/.test(graceSameText) && !/KES/.test(graceSameText) && !/https?:\/\//.test(graceSameText), 'the grace card repeats no tier, price or link');
  check(/payment link I sent you 3 days ago still works/i.test(graceSameText), 'the grace card points back to the T-3 link');

  // T-0: the garage changed (2 → 4 assets) → the full card is re-sent.
  const graceChanged = makeSweep({ status: 'ACTIVE', started_at: past(31), ends_at: past(0.5), nudge_activation_sent_at: past(20), nudge_t3_sent_at: past(3), t3_fitted_plan: 'team_fleet' }, {}, { vehicles: fitVehicles(4) });
  const graceChangedStats = await runTrialLifecycleSweep({ supabase: graceChanged.mock.client, sendWhatsAppFn: graceChanged.send, checkoutFn: fitCheckout });
  const graceChangedText = graceChanged.sent[0] || '';
  check(graceChangedStats.graceStarted === 1 && /Growth/.test(graceChangedText), 'a changed fitted tier re-sends the full card at T-0 (4 assets → Growth)');
  check(graceChangedText.includes('https://checkout.test/fit'), 'the re-sent card carries a fresh engine link');

  // T-0: no snapshot (e.g. trial shorter than 3 days) → the old full card.
  const graceNoSnapshot = makeSweep({ status: 'ACTIVE', started_at: past(31), ends_at: past(0.5), nudge_activation_sent_at: past(20) }, {}, { vehicles: fitVehicles(2) });
  await runTrialLifecycleSweep({ supabase: graceNoSnapshot.mock.client, sendWhatsAppFn: graceNoSnapshot.send, checkoutFn: fitCheckout });
  check(/Team Fleet/.test(graceNoSnapshot.sent[0] || '') && /nothing is paused yet/i.test(graceNoSnapshot.sent[0] || ''), 'a missing snapshot falls back to the full fitted card');

  // PAST_DUE and CANCELED accounts never receive the T-3 card.
  const pastDue = makeSweep({ started_at: past(27.5), ends_at: future(2.5), nudge_activation_sent_at: past(20) }, { subscription_status: 'PAST_DUE', subscription_period_end: past(2) }, { vehicles: fitVehicles(6) });
  const pastDueStats = await runTrialLifecycleSweep({ supabase: pastDue.mock.client, sendWhatsAppFn: pastDue.send, checkoutFn: fitCheckout });
  check(pastDueStats.t3 === 0 && pastDueStats.t3Skipped === 1 && !pastDue.sent.some((m) => /plan that fits|trial ends in 3 days/i.test(m)), 'PAST_DUE accounts skip T-3 entirely (no digest, no card)');
  const canceled = makeSweep({ started_at: past(27.5), ends_at: future(2.5), nudge_activation_sent_at: past(20) }, { subscription_status: 'CANCELED' }, { vehicles: fitVehicles(6) });
  const canceledStats = await runTrialLifecycleSweep({ supabase: canceled.mock.client, sendWhatsAppFn: canceled.send, checkoutFn: fitCheckout });
  check(canceledStats.t3 === 0 && canceledStats.t3Skipped === 1 && !canceled.sent.some((m) => /plan that fits|trial ends in 3 days/i.test(m)), 'CANCELED accounts skip T-3 entirely (no digest, no card)');
  const pastDueT24 = makeSweep({ started_at: past(29.5), ends_at: future(0.5), nudge_activation_sent_at: past(22), nudge_t3_sent_at: past(2) }, { subscription_status: 'PAST_DUE', subscription_period_end: past(2) }, { vehicles: fitVehicles(2) });
  const pastDueT24Stats = await runTrialLifecycleSweep({ supabase: pastDueT24.mock.client, sendWhatsAppFn: pastDueT24.send, checkoutFn: fitCheckout });
  check(pastDueT24Stats.t24 === 0 && pastDueT24Stats.t24Skipped === 1 && !pastDueT24.sent.some((m) => /24 hours left/i.test(m)), 'PAST_DUE accounts skip the T-24 urgency nudge too');

  // Rule 50: a missing t3_fitted_plan column degrades to the old digest + full T-0 card.
  const driftMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'growth', subscription_status: 'TRIALING', trial_used_at: past(5) })],
    trial_sessions: [trialRow({ started_at: past(27.5), ends_at: future(2.5), nudge_activation_sent_at: past(20) })],
    coupons: [], usage_counters: [], vehicles: fitVehicles(6), expense_logs: [], reminders: [], ai_usage_logs: []
  }, {
    beforeUpdate: (table, patch) => (table === 'trial_sessions' && patch && Object.prototype.hasOwnProperty.call(patch, 't3_fitted_plan')
      ? { error: { message: 'column "t3_fitted_plan" of relation "trial_sessions" does not exist' } }
      : null)
  });
  const driftSent = [];
  const driftStats = await runTrialLifecycleSweep({ supabase: driftMock.client, sendWhatsAppFn: async (_to, message) => { driftSent.push(message); }, checkoutFn: fitCheckout });
  check(driftStats.t3 === 1 && driftSent.length === 1, 'schema drift still sends the T-3 digest once');
  check(/Keep everything unlocked/.test(driftSent[0] || '') && !/The plan that fits/.test(driftSent[0] || ''), 'schema drift degrades to the pre-v1.71.0 digest (no fitted card)');
  check(Boolean(driftMock.db.trial_sessions[0].nudge_t3_sent_at) && !driftMock.db.trial_sessions[0].t3_fitted_plan, 'the one-shot marker survives; no snapshot is claimed');
  driftMock.db.trial_sessions[0].ends_at = past(0.5);
  const driftT0Sent = [];
  await runTrialLifecycleSweep({ supabase: driftMock.client, sendWhatsAppFn: async (_to, message) => { driftT0Sent.push(message); }, checkoutFn: fitCheckout });
  check(/You built 6 assets/.test(driftT0Sent[0] || '') && /Fleet Command/.test(driftT0Sent[0] || ''), 'schema drift at T-0 falls back to the full fitted card');

  // Pure helper pins.
  check(fittedPlanKey({ tierKey: 'team_fleet', addonQuantity: 0 }) === 'team_fleet' && fittedPlanKey({ tierKey: 'fleet_command', addonQuantity: 2 }) === 'fleet_command+2' && fittedPlanKey(null) === null, 'fittedPlanKey encodes tier + add-on slots (null-safe)');
  check(skipsTrialEndNudge({ subscription_status: 'past_due' }) === true && skipsTrialEndNudge({ subscription_status: 'ACTIVE' }) === false, 'the skip guard matches PAST_DUE/CANCELED/CANCELLING statuses case-insensitively');
  const graceCopy = graceChoiceText({ ownerName: 'Test Owner', assetCount: 2, graceEndsAt: future(6), graceDays: 7 });
  check(!/Team Fleet|Solo Pro|Growth|Fleet Command/.test(graceCopy) && !/KES|\$/.test(graceCopy) && !/https?:\/\//.test(graceCopy), 'graceChoiceText carries no tier, price or link');

  const t24 = makeSweep({ started_at: past(29.5), ends_at: future(0.5), nudge_activation_sent_at: past(22) });
  const t24stats = await runTrialLifecycleSweep({ supabase: t24.mock.client, sendWhatsAppFn: t24.send });
  check(t24stats.t24 === 1 || t24stats.t3 === 1, 'T-24h / T-3 urgency stage fires');
  check(t24.sent.length === 1, 'Only one nudge per sweep tick');
  check(t24.kinds[0] === 'trial_ending', 'T-24h urgency carries the trial_ending template kind');

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

  console.log('\n--- Test 6b: Phase 32 — drip-feed feature tips (v1.95.0) ---');
  const previousFeatureKnob = process.env.FEATURE_NUDGE_ENABLED;
  const featureTrial = (overrides = {}) => trialRow({
    activated: true,
    activated_at: past(0.55),
    started_at: past(6),
    ends_at: future(24),
    nudge_activation_sent_at: past(6),
    ...overrides
  });
  const featureMock = (extra = {}) => createMockSupabase({
    profiles: [ownerProfile({ subscription_tier: 'free', subscription_status: 'ACTIVE' })],
    trial_sessions: [featureTrial()],
    usage_counters: [],
    vehicles: [{ id: 'v-1', owner_id: 'p-1', plate_number: 'KDA 1A', status: 'ACTIVE', deleted_at: null }],
    dashboard_sessions: [],
    chat_history: [],
    expense_logs: [],
    vehicle_documents: [],
    coupons: [],
    ...extra
  });

  delete process.env.FEATURE_NUDGE_ENABLED;
  const featureOffMock = featureMock();
  const featureOffSent = [];
  const featureOffStats = await runTrialLifecycleSweep({ supabase: featureOffMock.client, sendWhatsAppFn: async (_to, message, kind) => { featureOffSent.push({ message, kind }); } });
  check(featureOffStats.featureTips === 0 && featureOffSent.length === 0, 'knob OFF sends nothing (D8 — byte-identical to pre-v1.95.0)');
  check(!featureOffMock.db.trial_sessions[0].feature_nudge_sent_at, 'knob OFF stamps nothing');

  process.env.FEATURE_NUDGE_ENABLED = 'on';
  const featureOnMock = featureMock();
  const featureOnSent = [];
  const featureOnStats = await runTrialLifecycleSweep({ supabase: featureOnMock.client, sendWhatsAppFn: async (_to, message, kind, vars) => { featureOnSent.push({ message, kind, vars }); } });
  check(featureOnStats.featureTips === 1 && featureOnSent.length === 1, 'T+12h sends exactly ONE feature tip');
  check(featureOnSent[0].kind === 'feature_tip' && featureOnSent[0].vars && featureOnSent[0].vars.feature && featureOnSent[0].vars.link, 'the tip carries the feature_tip kind and both template variables');
  check(/Tip: try your web dashboard/.test(featureOnSent[0].message) && /app\.sakafleet\.com\/d\/login/.test(featureOnSent[0].message), 'the FIRST unexplored feature wins with an engine-owned link');
  check(featureOnMock.db.trial_sessions[0].feature_nudge_key === 'dashboard' && Boolean(featureOnMock.db.trial_sessions[0].feature_nudge_sent_at), 'the pick + stamp land on the trial row');
  const featureOnAgain = await runTrialLifecycleSweep({ supabase: featureOnMock.client, sendWhatsAppFn: async (_to, message) => { featureOnSent.push({ message }); } });
  check(featureOnAgain.featureTips === 0 && featureOnSent.length === 1, 'the first tip never repeats');

  const exploredMock = featureMock({ dashboard_sessions: [{ id: 's-1', owner_id: 'p-1', verified: true }] });
  const exploredSent = [];
  const exploredStats = await runTrialLifecycleSweep({ supabase: exploredMock.client, sendWhatsAppFn: async (_to, message, kind, vars) => { exploredSent.push({ message, kind, vars }); } });
  check(exploredStats.featureTips === 1 && exploredSent[0].vars.feature === 'one-line expense logging', 'an explored dashboard is skipped — the next unexplored feature is picked');

  const engagedMock = featureMock({
    dashboard_sessions: [{ id: 's-1', owner_id: 'p-1', verified: true }],
    trial_sessions: [featureTrial({ activated_at: past(2.1), feature_nudge_sent_at: past(1.5), feature_nudge_key: 'dashboard' })]
  });
  const engagedSent = [];
  const engagedStats = await runTrialLifecycleSweep({ supabase: engagedMock.client, sendWhatsAppFn: async (_to, message) => { engagedSent.push(message); } });
  check(engagedStats.featureTipFollowups === 0 && engagedSent.length === 0, 'engagement stops the ladder — no follow-up for a used feature');
  check(Boolean(engagedMock.db.trial_sessions[0].feature_nudge_followup_sent_at), 'the follow-up is stamped WITHOUT sending');

  const unengagedMock = featureMock({
    trial_sessions: [featureTrial({ activated_at: past(2.1), feature_nudge_sent_at: past(1.5), feature_nudge_key: 'dashboard' })]
  });
  const unengagedSent = [];
  const unengagedStats = await runTrialLifecycleSweep({ supabase: unengagedMock.client, sendWhatsAppFn: async (_to, message) => { unengagedSent.push(message); } });
  check(unengagedStats.featureTipFollowups === 1 && unengagedSent.length === 1 && /Still worth a try/.test(unengagedSent[0]), 'one follow-up at +48h while the feature stays unexplored');
  const unengagedAgain = await runTrialLifecycleSweep({ supabase: unengagedMock.client, sendWhatsAppFn: async (_to, message) => { unengagedSent.push(message); } });
  check(unengagedAgain.featureTipFollowups === 0 && unengagedSent.length === 1, 'max 2 sends per feature — the ladder is closed');

  const notActivatedMock = featureMock({ trial_sessions: [featureTrial({ activated: false, activated_at: null, started_at: past(1) })] });
  const notActivatedSent = [];
  const notActivatedStats = await runTrialLifecycleSweep({ supabase: notActivatedMock.client, sendWhatsAppFn: async (_to, message) => { notActivatedSent.push(message); } });
  check(notActivatedStats.featureTips === 0, 'an un-activated trial never gets a feature tip');

  const paidFeatureMock = featureMock({ profiles: [ownerProfile({ subscription_tier: 'solo_pro', subscription_status: 'ACTIVE', subscription_period_end: future(20) })] });
  const paidFeatureSent = [];
  const paidFeatureStats = await runTrialLifecycleSweep({ supabase: paidFeatureMock.client, sendWhatsAppFn: async (_to, message) => { paidFeatureSent.push(message); } });
  check(paidFeatureStats.featureTips === 0 && paidFeatureSent.length === 0, 'paid-live accounts are never drip-fed (D9)');

  const driftFeatureRow = trialRow({ activated: true, activated_at: past(0.55), started_at: past(6), ends_at: future(24), nudge_activation_sent_at: past(6) });
  delete driftFeatureRow.feature_nudge_sent_at;
  delete driftFeatureRow.feature_nudge_followup_sent_at;
  delete driftFeatureRow.feature_nudge_key;
  const columnDriftMock = featureMock({ trial_sessions: [driftFeatureRow] });
  const driftFeatureSent = [];
  const driftFeatureStats = await runTrialLifecycleSweep({ supabase: columnDriftMock.client, sendWhatsAppFn: async (_to, message) => { driftFeatureSent.push(message); } });
  check(driftFeatureStats.featureTips === 0 && driftFeatureSent.length === 0, 'un-migrated columns send nothing (rule 50 degrade, never a message loop)');

  const capProfiles = [];
  const capTrials = [];
  for (let n = 0; n < 12; n += 1) {
    capProfiles.push(ownerProfile({ id: `p-cap-${n}`, phone_number: `+25470001${String(1000 + n)}` }));
    capTrials.push(featureTrial({ id: `t-cap-${n}`, owner_id: `p-cap-${n}` }));
  }
  const capMock = createMockSupabase({
    profiles: capProfiles, trial_sessions: capTrials,
    usage_counters: [], vehicles: [], dashboard_sessions: [], chat_history: [],
    expense_logs: [], vehicle_documents: [], coupons: []
  });
  const capStats = await runTrialLifecycleSweep({ supabase: capMock.client, sendWhatsAppFn: async () => {} });
  check(capStats.featureTips === FEATURE_NUDGE_SWEEP_CAP, `one sweep is capped at ${FEATURE_NUDGE_SWEEP_CAP} feature tips`);

  check(featureNudgeEnabled({ FEATURE_NUDGE_ENABLED: 'on' }) === true && featureNudgeEnabled({}) === false, 'the gate is read per call and defaults OFF (D8)');
  check(FEATURE_TIPS.map((tip) => tip.key).join(',') === 'dashboard,expense,voice_note,report,compliance', 'the checklist order is pinned (deterministic pick)');
  const tipCopy = featureTipText(FEATURE_TIPS[0], { followup: true });
  check(/^🎯 Still worth a try/.test(tipCopy) && tipCopy.includes('One minute and Saka does the rest.'), 'follow-up copy stays warm and deterministic (rule 31)');
  const stateMock = createMockSupabase({
    dashboard_sessions: [{ id: 's1', owner_id: 'p-1' }],
    chat_history: [{ id: 'c1', user_phone: '+254700000001', message: '[voice note]' }],
    usage_counters: [{ owner_id: 'p-1', period_key: '2026-11', report_count: 2 }],
    vehicles: [{ id: 'v1', owner_id: 'p-1', deleted_at: null }],
    expense_logs: [{ id: 'e1', vehicle_id: 'v1' }],
    vehicle_documents: [{ id: 'd1', vehicle_id: 'v1' }]
  });
  const exploredState = await resolveFeatureTipState(stateMock.client, { owner_id: 'p-1' }, { phone_number: '+254700000001' });
  check(exploredState.dashboard && exploredState.voice_note && exploredState.report && exploredState.expense && exploredState.compliance, 'all five feature sources resolve from their canonical ledgers');
  if (previousFeatureKnob === undefined) delete process.env.FEATURE_NUDGE_ENABLED;
  else process.env.FEATURE_NUDGE_ENABLED = previousFeatureKnob;

  console.log('\n--- Test 7: expiry -> bounded decision window -> Free (data preserved) ---');
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
  const expiryKinds = [];
  const expiryStats = await runTrialLifecycleSweep({
    supabase: expiry.client,
    sendWhatsAppFn: async (_to, message, kind) => { expiryMessages.push(message); expiryKinds.push(kind); }
  });
  // v1.61.16 — the trial ends into a bounded decision window: nothing pauses yet.
  check(expiryStats.graceStarted === 1, 'An expired trial opens the decision window');
  check(expiry.db.trial_sessions[0].status === 'GRACE' && Boolean(expiry.db.trial_sessions[0].grace_ends_at), 'Trial row is marked GRACE with a deadline');
  check(expiry.db.profiles[0].subscription_tier === 'growth', 'The account stays on the trial tier during the window');
  check(expiry.db.vehicles.every((v) => v.status === 'ACTIVE'), 'Every asset stays active while the owner chooses');
  check(expiryMessages.length === 1 && /nothing is paused yet/i.test(expiryMessages[0]), 'Owner receives the fitted-plan card first');
  check(/keep <plate>/i.test(expiryMessages[0]), 'The card names the downsize choice');
  check(expiryKinds[0] === 'trial_grace', 'the fitted-plan card carries the trial_grace template kind');

  // Grace end: the same sweep falls back to Free, pausing (never deleting) excess.
  expiry.db.trial_sessions[0].grace_ends_at = past(1);
  const graceEndMessages = [];
  const graceEndKinds = [];
  const graceEndStats = await runTrialLifecycleSweep({
    supabase: expiry.client,
    sendWhatsAppFn: async (_to, message, kind) => { graceEndMessages.push(message); graceEndKinds.push(kind); }
  });
  check(graceEndStats.graceEnded === 1 && graceEndStats.expired === 1, 'Grace end is processed by the sweep');
  check(expiry.db.profiles[0].subscription_tier === 'free' && expiry.db.profiles[0].subscription_status === 'ACTIVE', 'Account downgrades to Free at grace end');
  check(expiry.db.vehicles.filter((v) => v.status === 'PAUSED').length === 2, 'Excess vehicles are PAUSED, never deleted');
  check(expiry.db.vehicles.every((v) => Boolean(v.plate_number)), 'Paused vehicles keep their identity (passbooks intact)');
  check(graceEndMessages.length === 1 && /trial has ended/i.test(graceEndMessages[0]), 'Owner receives the expiry message at grace end');
  check(/keep vehicle/i.test(graceEndMessages[0]), 'Expiry message prompts the KEEP_VEHICLE choice');
  check(graceEndKinds[0] === 'trial_grace', 'grace-end expiry carries the trial_grace template kind');
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
