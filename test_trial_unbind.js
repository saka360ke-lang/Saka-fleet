/**
 * Saka Fleet — Trial Unbind regression suite (v1.16.0)
 * ----------------------------------------------------
 * Asserts the permanent contract: commercial state (trial, extension coupons,
 * winback) binds to the OWNER ACCOUNT. VINs/passbooks are asset provenance only.
 *
 * Run: node --env-file=.env test_trial_unbind.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { ensureVinRegistryEntry, getOrCreateVinTrial } from './src/services/vehicles.js';
import { scheduleAccountTrialExtensionCoupon, startAccountTrial } from './src/services/trialEngine.js';
import { processImpendingTrialReminders } from './src/services/coupons.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days) => new Date(Date.now() + days * DAY_MS).toISOString();

async function run() {
  console.log('=== TRIAL UNBIND (v1.16.0) ===\n');

  console.log('--- Test 1: VIN registry records provenance only ---');
  const vinMock = createMockSupabase({ vin_registry: [], vehicles: [] });
  const first = await ensureVinRegistryEntry({
    vin: 'kda123testvin456',
    ownerId: 'owner-1',
    vehicleId: 'veh-1',
    supabase: vinMock.client
  });
  check(first.ok && first.isFirstRegistration === true, 'First registration is recorded');
  const row = vinMock.db.vin_registry[0];
  check(row.vin === 'KDA123TESTVIN456', 'VIN is canonicalized');
  check(row.trial_granted === false, 'No asset trial is granted');
  check(row.trial_status === 'account_bound', 'Row is explicitly account-bound');
  check(!row.trial_start_at && !row.trial_end_at, 'No phantom trial clock is written');
  check(vinMock.db.vehicles.length === 0, 'Vehicle trial columns are never touched');

  const second = await ensureVinRegistryEntry({ vin: 'kda123testvin456', ownerId: 'owner-1', supabase: vinMock.client });
  check(second.isFirstRegistration === false && vinMock.db.vin_registry.length === 1, 'Re-registration preserves provenance');
  const legacy = await getOrCreateVinTrial({ vin: 'kda123testvin456', ownerId: 'owner-1', supabase: vinMock.client });
  check(legacy.trialStatus === 'account_bound' && legacy.trialEndAt === null, 'getOrCreateVinTrial degrades to account-bound (no trial clock)');

  console.log('\n--- Test 2: extension offers bind to the owner account ---');
  const couponMock = createMockSupabase({ coupons: [], profiles: [{ id: 'owner-1', phone_number: '+254700000001', email: 'o@example.com' }] });
  const scheduled = await scheduleAccountTrialExtensionCoupon({
    supabase: couponMock.client,
    ownerId: 'owner-1',
    phone: '+254700000001',
    email: 'o@example.com',
    endsAt: future(30)
  });
  check(scheduled.ok && scheduled.reused === false, 'Account extension coupon is scheduled');
  const coupon = couponMock.db.coupons[0];
  check(coupon.applicable_to === 'account_trial_extension', 'Coupon type is account-bound');
  check(coupon.owner_id === 'owner-1', 'Coupon carries owner_id');
  check(coupon.vin === null, 'Coupon is not bound to a VIN');
  check(coupon.status === 'scheduled', 'Coupon starts scheduled');
  const daysToEnd = Math.round((new Date(coupon.expires_at) - DAY_MS * 7 - new Date(coupon.scheduled_dispatch_at)) / DAY_MS);
  check(daysToEnd === 3, 'Dispatch is exactly 3 days before the real account trial end');

  const again = await scheduleAccountTrialExtensionCoupon({
    supabase: couponMock.client,
    ownerId: 'owner-1',
    phone: '+254700000001',
    endsAt: future(30)
  });
  check(again.reused === true && couponMock.db.coupons.length === 1, 'Scheduling is idempotent');

  console.log('\n--- Test 3: trial start schedules the account offer (not a VIN offer) ---');
  const trialMock = createMockSupabase({
    profiles: [{
      id: 'owner-2',
      phone_number: '+254700000002',
      email: 't@example.com',
      subscription_tier: 'free',
      subscription_status: 'ACTIVE',
      trial_used_at: null
    }],
    trial_sessions: [],
    coupons: []
  });
  const trial = await startAccountTrial({ supabase: trialMock.client, ownerId: 'owner-2', tierKey: 'growth', interval: 'annual' });
  check(trial.started === true, 'Account trial starts');
  check(trialMock.db.profiles[0].trial_used_at, 'profiles.trial_used_at is stamped');
  await new Promise((resolve) => setTimeout(resolve, 25));
  const accountCoupon = trialMock.db.coupons.find((c) => c.applicable_to === 'account_trial_extension');
  check(Boolean(accountCoupon), 'A T-3 account extension offer is scheduled at trial start');
  check(accountCoupon && accountCoupon.owner_id === 'owner-2', 'The offer is owner-bound');

  console.log('\n--- Test 4: legacy VIN coupons are retired, never messaged ---');
  const retireMock = createMockSupabase({
    coupons: [
      { id: 'c1', code: 'EXT30-AAAAAA', applicable_to: 'trial_extension', status: 'scheduled', vin: 'KDA123TESTVIN456' },
      { id: 'c2', code: 'EXT30-BBBBBB', applicable_to: 'trial_extension', status: 'applied', vin: 'KDA123TESTVIN456' }
    ]
  });
  const retire = await processImpendingTrialReminders({ supabase: retireMock.client });
  check(retire.retired === 1, 'Only scheduled legacy VIN coupons are retired');
  check(retireMock.db.coupons.find((c) => c.id === 'c1').status === 'superseded', 'Scheduled legacy coupon becomes superseded');
  check(retireMock.db.coupons.find((c) => c.id === 'c2').status === 'applied', 'Historically applied coupons are preserved');

  console.log('\n--- Test 5: no VIN trial clock is ever minted by the shim ---');
  const shimMock = createMockSupabase({ vin_registry: [], vehicles: [] });
  const shim = await getOrCreateVinTrial({ vin: 'NEWVIN123456789', ownerId: 'owner-3', supabase: shimMock.client });
  check(shim.accountBound === true && shim.trialStartAt === null && shim.trialEndAt === null, 'Shim returns no trial clock');
  check(shimMock.db.vin_registry[0].trial_granted === false, 'Provenance row never grants a trial');

  console.log(`\n🎉 ${passed} trial-unbind assertions passed.`);
}

run().catch((err) => {
  console.error('\n❌ Trial unbind suite failed:', err.message);
  process.exit(1);
});
