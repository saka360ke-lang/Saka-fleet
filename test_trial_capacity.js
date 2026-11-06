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

console.log('\n--- 1. live welcome trial resolves growth capacity (5) ---');
invalidateEntitlements();
const liveMock = seed({ trial: liveTrial() });
const liveEnt = await getEntitlements({ supabase: liveMock.client, ownerId: 'p-1', useCache: false });
check(liveEnt.tierKey === 'growth' && liveEnt.effectiveVehicleCapacity === 5, 'a live welcome trial grants growth capacity 5');
check(liveEnt.isTrial === true && liveEnt.trialDaysLeft > 0, 'the account is reported as on trial with days left');

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

console.log('\n--- 3. the 15-asset walk: trial gate blocks the 6th ---');
for (const count of [0, 1, 4, 5, 14, 15]) {
  invalidateEntitlements();
  const mock = seed({
    trial: liveTrial(),
    vehicles: Array.from({ length: count }, (_, index) => vehicleRow(index + 1, 'ACTIVE', index))
  });
  const gate = await checkOwnerVehicleTierLimit({ ownerId: 'p-1', subscriptionTier: 'growth', supabase: mock.client });
  check(gate.limit === 5 && gate.isTrial === true && gate.canAdd === (count < 5), `trial gate at ${count} asset(s): limit 5, canAdd ${count < 5}`);
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

console.log('\n--- 6. refusal copy: trial vs plan (engine-owned) ---');
const trialCopy = formatCapacityRefusal({ isTrial: true, limit: 5, currentCount: 5 });
check(/welcome trial allows 5 vehicles/.test(trialCopy) && /upgrade/.test(trialCopy), 'the trial refusal names the trial limit and the upgrade path');
check(!/current plan/.test(trialCopy), 'the trial refusal never calls the trial a current plan');
const planCopy = formatCapacityRefusal({ isTrial: false, limit: 1, currentCount: 1 });
check(/current plan allows 1 vehicle/.test(planCopy) && /upgrade/.test(planCopy), 'the plan refusal stays unchanged for non-trial accounts');

console.log(`\n🎉 ALL TRIAL CAPACITY TESTS PASSED (${passed} assertions).`);


