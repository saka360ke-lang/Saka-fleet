/**
 * Saka Fleet — trial capacity suite (v1.61.15)
 * --------------------------------------------
 * The 15-asset question, proven end to end at the engine boundaries:
 *   live trial = 5 slots → 6th add refused → trial lapses on read → Free keeps
 *   1 ACTIVE and PAUSES the rest (never deletes) → PAUSED rows still consume the
 *   free slot → the persist gate's refusal copy is trial-aware.
 * All database work runs against the in-memory Supabase double — no real rows.
 */
import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { getEntitlements, invalidateEntitlements } from './src/services/subscriptions.js';
import { checkOwnerVehicleTierLimit } from './src/services/vehicles.js';
import { formatCapacityRefusal } from './src/services/quizEngine.js';
import { fittedTierForAssets } from './src/services/subscriptionTiers.js';
import {
  runTrialEndStage,
  trialEndChoiceText,
  TRIAL_MAX_ASSETS,
  TRIAL_END_GRACE_DAYS
} from './src/services/trialEngine.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log('  ok ' + message);
}
const DAY = 86400000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();
const past = (days) => new Date(Date.now() - days * DAY).toISOString();

function profileRow(overrides = {}) {
  return {
    id: 'p-1',
    phone_number: '+254700000001',
    email: 'owner@example.com',
    full_name: 'Owner',
    subscription_tier: 'growth',
    subscription_status: 'TRIALING',
    trial_used_at: past(1),
    billing_interval: 'monthly',
    addon_quantity: 0,
    subscription_period_start: null,
    subscription_period_end: null,
    subscription_expires_at: null,
    cancel_at_period_end: false,
    downgraded_at: null,
    ...overrides
  };
}

function vehicleRow(id, status = 'ACTIVE', ageMinutes = 0) {
  return {
    id: `v-${id}`,
    owner_id: 'p-1',
    plate_number: `KDA 12${id}`,
    status,
    updated_at: new Date(Date.now() - ageMinutes * 60000).toISOString(),
    deleted_at: null
  };
}

function liveTrial(endsAt = future(20)) {
  return {
    id: 'ts-live',
    owner_id: 'p-1',
    tier: 'growth',
    status: 'ACTIVE',
    source: 'welcome',
    started_at: past(2),
    ends_at: endsAt,
    activated: false
  };
}

function seed({ profile = profileRow(), trial = null, vehicles = [] } = {}) {
  return createMockSupabase({
    profiles: [profile],
    trial_sessions: trial ? [trial] : [],
    vehicles,
    usage_counters: [],
    subscriptions: []
  });
}

console.log('=== SAKA FLEET — trial capacity suite (v1.61.15) ===');

console.log('\n--- 1. live welcome trial = unlimited garage (anti-abuse ceiling only) ---');
invalidateEntitlements();
const liveMock = seed({ trial: liveTrial() });
const liveEnt = await getEntitlements({ supabase: liveMock.client, ownerId: 'p-1', useCache: false });
check(liveEnt.tierKey === 'growth' && liveEnt.effectiveVehicleCapacity === TRIAL_MAX_ASSETS, 'a live trial grants the safety ceiling, not a plan limit');
check(liveEnt.isTrial === true && liveEnt.trialPhase === 'TRIAL' && liveEnt.trialDaysLeft > 0, 'the account is reported as on trial with days left');

console.log('\n--- 2. expired trial window lapses ON READ (T1 fix) ---');
invalidateEntitlements();
const expiredMock = seed({
  trial: liveTrial(past(1)),
  vehicles: [vehicleRow(1, 'ACTIVE', 10), vehicleRow(2, 'ACTIVE', 20), vehicleRow(3, 'ACTIVE', 30)]
});
const expiredEnt = await getEntitlements({ supabase: expiredMock.client, ownerId: 'p-1', useCache: false });
check(expiredEnt.tierKey === 'free' && expiredEnt.effectiveVehicleCapacity === 1, 'an expired trial resolves Free on read (never rides the stale TRIALING stamp)');
check(expiredEnt.isTrial === false, 'the expired account is no longer reported as on trial');
check(expiredMock.db.profiles[0].subscription_tier === 'free' && expiredMock.db.profiles[0].subscription_status === 'ACTIVE', 'the lazy downgrade stamps the profile back to Free/ACTIVE');
check(expiredMock.db.vehicles.filter((v) => v.status === 'PAUSED').length === 2, 'excess assets are PAUSED, never deleted');
check(expiredMock.db.vehicles.every((v) => Boolean(v.plate_number)), 'paused assets keep their identity and passbooks');

console.log('\n--- 3. the 15-asset walk: every asset is free to add on trial ---');
for (const count of [0, 1, 4, 5, 14, 15, TRIAL_MAX_ASSETS - 1, TRIAL_MAX_ASSETS]) {
  invalidateEntitlements();
  const mock = seed({
    trial: liveTrial(),
    vehicles: Array.from({ length: count }, (_, index) => vehicleRow(index + 1, 'ACTIVE', index))
  });
  const gate = await checkOwnerVehicleTierLimit({ ownerId: 'p-1', subscriptionTier: 'growth', supabase: mock.client });
  check(gate.limit === TRIAL_MAX_ASSETS && gate.isTrial === true && gate.canAdd === (count < TRIAL_MAX_ASSETS), `trial gate at ${count} asset(s): ceiling ${TRIAL_MAX_ASSETS}, canAdd ${count < TRIAL_MAX_ASSETS}`);
}

console.log('\n--- 4. post-downgrade: PAUSED assets still consume the free slot ---');
invalidateEntitlements();
const freeMock = seed({
  profile: profileRow({ subscription_tier: 'free', subscription_status: 'ACTIVE', trial_used_at: past(40) }),
  vehicles: [vehicleRow(1, 'ACTIVE', 5), vehicleRow(2, 'PAUSED', 6), vehicleRow(3, 'PAUSED', 7)]
});
const freeGate = await checkOwnerVehicleTierLimit({ ownerId: 'p-1', subscriptionTier: 'free', supabase: freeMock.client });
check(freeGate.limit === 1 && freeGate.currentCount === 3 && freeGate.canAdd === false, 'a Free account cannot add while PAUSED assets fill the garage');
check(freeGate.isTrial === false, 'a Free account is not reported as on trial');

console.log('\n--- 5. expired trial on the persist gate (the sweep window) ---');
invalidateEntitlements();
const lapseMock = seed({
  trial: liveTrial(past(1)),
  vehicles: [1, 2, 3, 4, 5].map((id) => vehicleRow(id, 'ACTIVE', id))
});
const lapseGate = await checkOwnerVehicleTierLimit({ ownerId: 'p-1', subscriptionTier: 'growth', supabase: lapseMock.client });
check(lapseGate.limit === 1 && lapseGate.canAdd === false && lapseGate.isTrial === false, 'an expired trial cannot register asset #6 during the sweep window');
check(lapseMock.db.profiles[0].subscription_tier === 'free', 'the gate itself lapses the account — no 15-minute blind spot');
check(lapseMock.db.vehicles.filter((v) => v.status === 'PAUSED').length === 4, 'the lapse pauses the excess immediately');

console.log('\n--- 6. refusal copy: safety ceiling vs plan (engine-owned) ---');
const trialCopy = formatCapacityRefusal({ isTrial: true, limit: TRIAL_MAX_ASSETS, currentCount: TRIAL_MAX_ASSETS });
check(/safety ceiling/.test(trialCopy) && /support/.test(trialCopy), 'the trial ceiling refusal says safety ceiling + support lane');
check(!/welcome trial allows/.test(trialCopy), 'the trial refusal never claims a plan limit');
const planCopy = formatCapacityRefusal({ isTrial: false, limit: 1, currentCount: 1 });
check(/current plan allows 1 vehicle/.test(planCopy) && /upgrade/.test(planCopy), 'the plan refusal stays unchanged for non-trial accounts');

console.log('\n--- 7. fitted tier math (trial-end journey) ---');
const fit1 = fittedTierForAssets(1);
const fit2 = fittedTierForAssets(2);
const fit5 = fittedTierForAssets(5);
const fit6 = fittedTierForAssets(6);
const fit15 = fittedTierForAssets(15);
check(fit1.tierKey === 'solo_pro' && fit1.totalUSD === 9.99, '1 asset fits Solo Pro at its list price');
check(fit2.tierKey === 'team_fleet' && fit2.capacity === 3, '2 assets fit Team Fleet (capacity 3)');
check(fit5.tierKey === 'growth' && fit5.addonQuantity === 0, '5 assets fit Growth with no add-ons');
check(fit6.tierKey === 'fleet_command' && fit6.addonQuantity === 1 && fit6.totalUSD === 31.98, '6 assets fit Fleet Command + 1 add-on ($27.99 + $3.99)');
check(fit15.tierKey === 'fleet_command' && fit15.addonQuantity === 10 && fit15.capacity === 15, '15 assets fit Fleet Command + 10 add-ons (capacity 15)');
check(fittedTierForAssets(2, { interval: 'annual' }).totalUSD === 151.12, 'annual pricing comes from the same registry');

console.log('\n--- 8. GRACE floor: assets stay active while the owner chooses ---');
invalidateEntitlements();
const graceMock = seed({
  trial: { ...liveTrial(past(1)), status: 'GRACE', grace_ends_at: future(5) },
  vehicles: [1, 2, 3, 4, 5, 6, 7].map((id) => vehicleRow(id, 'ACTIVE', id))
});
const graceEnt = await getEntitlements({ supabase: graceMock.client, ownerId: 'p-1', useCache: false });
check(graceEnt.isTrial === true && graceEnt.trialPhase === 'GRACE', 'the decision window is reported as GRACE');
check(graceEnt.effectiveVehicleCapacity === TRIAL_MAX_ASSETS && graceEnt.trialDaysLeft > 0, 'the garage stays open during the bounded window');
check(Boolean(graceEnt.graceEndsAt), 'the grace deadline is exposed to copy');

console.log('\n--- 9. trial end opens the window; grace end falls back safely ---');
const stageMessages = [];
const stageKinds = [];
const stageMock = seed({
  trial: liveTrial(past(1)),
  vehicles: Array.from({ length: 6 }, (_, index) => vehicleRow(index + 1, 'ACTIVE', index))
});
const stageStats = {};
const consumed = await runTrialEndStage({
  supabase: stageMock.client,
  trial: stageMock.db.trial_sessions[0],
  owner: stageMock.db.profiles[0],
  phone: '+254700000001',
  ownerCtx: { currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' },
  now: new Date(),
  sendWhatsAppFn: async (to, text, kind) => { stageMessages.push(text); stageKinds.push(kind); return true; },
  stats: stageStats,
  checkoutFn: async () => ({ ok: true, checkoutUrl: 'https://checkout.test/fit' }),
  addonCheckoutFn: async () => ({ ok: true, checkoutUrl: 'https://checkout.test/addon' })
});
check(consumed === true && stageStats.graceStarted === 1, 'T-0 opens the decision window instead of downgrading');
check(stageMock.db.trial_sessions[0].status === 'GRACE' && Boolean(stageMock.db.trial_sessions[0].grace_ends_at), 'the trial row is stamped GRACE with a deadline');
const choiceText = stageMessages[0] || '';
check(/nothing is paused yet/.test(choiceText) && /6 assets/.test(choiceText), 'the card names the asset count and promises no pause');
check(choiceText.includes('https://checkout.test/fit') && choiceText.includes('https://checkout.test/addon'), 'the fit link and the add-on link are engine-supplied');
check(/keep <plate>/.test(choiceText), 'the downsize path is named with the real command');
check(stageKinds[0] === 'trial_grace', 'the fitted-plan card carries the trial_grace template kind');

const graceEndMock = seed({
  trial: { ...liveTrial(past(9)), status: 'GRACE', grace_ends_at: past(1) },
  vehicles: [1, 2, 3].map((id) => vehicleRow(id, 'ACTIVE', id))
});
const endMessages = [];
const endKinds = [];
await runTrialEndStage({
  supabase: graceEndMock.client,
  trial: graceEndMock.db.trial_sessions[0],
  owner: graceEndMock.db.profiles[0],
  phone: '+254700000001',
  ownerCtx: { currency: 'KES' },
  now: new Date(),
  sendWhatsAppFn: async (to, text, kind) => { endMessages.push(text); endKinds.push(kind); return true; },
  stats: {}
});
check(graceEndMock.db.profiles[0].subscription_tier === 'free', 'grace end falls back to Free');
check(graceEndMock.db.vehicles.filter((v) => v.status === 'PAUSED').length === 2, 'excess assets are PAUSED, never deleted');
check(endMessages.some((text) => /trial has ended/i.test(text)), 'the fallback message explains the Free plan honestly');
check(endKinds[0] === 'trial_grace', 'grace-end expiry carries the trial_grace template kind');

console.log('\n--- 10. paid-live owners are never touched at trial end ---');
const paidMock = seed({
  profile: profileRow({ subscription_tier: 'growth', subscription_status: 'ACTIVE', subscription_period_end: future(20) }),
  trial: liveTrial(past(1)),
  vehicles: [1, 2].map((id) => vehicleRow(id, 'ACTIVE', id))
});
const paidStats = {};
await runTrialEndStage({
  supabase: paidMock.client,
  trial: paidMock.db.trial_sessions[0],
  owner: paidMock.db.profiles[0],
  phone: '+254700000001',
  ownerCtx: { currency: 'KES' },
  now: new Date(),
  sendWhatsAppFn: async () => true,
  stats: paidStats
});
check(paidMock.db.trial_sessions[0].status === 'EXPIRED' && paidMock.db.vehicles.every((v) => v.status === 'ACTIVE'), 'a live paid plan keeps every asset active');

console.log('\n--- 11. T-0 dedupe: full card only when the fitted tier changed (v1.71.0) ---');
const unchangedMock = seed({
  trial: { ...liveTrial(past(1)), t3_fitted_plan: 'team_fleet' },
  vehicles: [1, 2].map((id) => vehicleRow(id, 'ACTIVE', id))
});
const unchangedMessages = [];
const unchangedStats = {};
await runTrialEndStage({
  supabase: unchangedMock.client,
  trial: unchangedMock.db.trial_sessions[0],
  owner: unchangedMock.db.profiles[0],
  phone: '+254700000001',
  ownerCtx: { currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' },
  now: new Date(),
  sendWhatsAppFn: async (to, text) => { unchangedMessages.push(text); return true; },
  stats: unchangedStats,
  checkoutFn: async () => ({ ok: true, checkoutUrl: 'https://checkout.test/fit' })
});
const unchangedText = unchangedMessages[0] || '';
check(unchangedStats.graceStarted === 1 && unchangedStats.graceNudge === 1, 'an unchanged fitted plan opens the window with the grace card');
check(/nothing is paused yet/.test(unchangedText) && /keep <plate>/.test(unchangedText), 'the grace card keeps the decision paths');
check(!/Team Fleet|KES|https?:\/\//.test(unchangedText), 'the grace card repeats no tier, price or link');
check(/payment link I sent you 3 days ago still works/.test(unchangedText), 'the grace card points back to the T-3 link');

const changedMock = seed({
  trial: { ...liveTrial(past(1)), t3_fitted_plan: 'solo_pro' },
  vehicles: [1, 2, 3, 4].map((id) => vehicleRow(id, 'ACTIVE', id))
});
const changedMessages = [];
await runTrialEndStage({
  supabase: changedMock.client,
  trial: changedMock.db.trial_sessions[0],
  owner: changedMock.db.profiles[0],
  phone: '+254700000001',
  ownerCtx: { currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' },
  now: new Date(),
  sendWhatsAppFn: async (to, text) => { changedMessages.push(text); return true; },
  stats: {},
  checkoutFn: async () => ({ ok: true, checkoutUrl: 'https://checkout.test/fit' })
});
check(/Growth/.test(changedMessages[0] || '') && /https:\/\/checkout.test\/fit/.test(changedMessages[0] || ''), 'a changed fitted tier re-sends the full card with a fresh link');

console.log(`\n🎉 ALL TRIAL CAPACITY TESTS PASSED (${passed} assertions).`);


