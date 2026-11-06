/**
 * Saka Fleet — Owner driver profile suite (v1.16.0)
 * ------------------------------------------------
 * Asserts that every owner gets a driver profile path and that Saka NEVER
 * re-asks for compliance already on file (the "Already told you earlier" bug).
 *
 * Run: node --env-file=.env test_driver_profile_onboarding.js
 */

import assert from 'assert';
import { getFlowDefinition, detectQuizStart, startQuiz, handleQuizTurn } from './src/services/quizEngine.js';
import { submitDriverCompliance, recordInvalidMinimalSubmission, handleDriverResponse } from './src/services/driverAssignments.js';

// Keep the suite deterministic/offline: no AI question prefetch.
delete process.env.DEEPSEEK_API_KEY;

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const countryInfo = { country_code: 'KE', locale: 'en-KE', currency: 'KES', country: 'Kenya' };

function baseCtx(overrides = {}) {
  return {
    countryInfo,
    profile: { id: 'drv1', full_name: 'Fleet Driver', email: 'driver@example.com', email_verified: true },
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A', assigned_driver_id: 'drv1', asset_type: 'BUS' }],
    activeVehicle: null,
    language: 'English',
    ...overrides
  };
}

async function run() {
  console.log('=== OWNER DRIVER PROFILE (v1.16.0) ===\n');

  console.log('--- Test 1: compliance already on file is never re-asked ---');
  const satisfiedCtx = baseCtx({
    driverGate: {
      status: {
        emailVerified: true,
        minimal: { type: 'driver_license', valid: true },
        additional: [{ type: 'psv_badge', valid: true }]
      }
    }
  });
  const satisfied = getFlowDefinition('driver_onboarding', satisfiedCtx);
  const satisfiedKeys = satisfied.fields.map((f) => f.key);
  check(!satisfiedKeys.includes('driver_email'), 'Verified email is not re-asked');
  check(!satisfiedKeys.includes('otp'), 'OTP is not re-asked');
  check(!satisfiedKeys.includes('minimal_compliance'), 'Valid licence is not re-asked');
  check(!satisfiedKeys.includes('compliance_psv_badge'), 'Valid PSV badge is not re-asked');

  console.log('\n--- Test 2: an owner self-profile collects the minimum but stays skippable ---');
  const ownerCtx = baseCtx({
    profile: { id: 'own1', full_name: 'Asset Owner', email: 'owner@example.com', email_verified: true },
    vehicles: [{ id: 'v9', plate_number: 'KBJ 819C', owner_id: 'own1', asset_type: 'ICE' }],
    driverSelfProfile: true
  });
  const ownerFlow = getFlowDefinition('driver_onboarding', ownerCtx);
  const minimalField = ownerFlow.fields.find((f) => f.key === 'minimal_compliance');
  check(Boolean(minimalField), 'Owner profile includes the minimal compliance step');
  check(minimalField?.optional === true, 'Owner minimum is skippable (never blocks the owner)');

  console.log('\n--- Test 3: a gated driver may never skip the minimum ---');
  const gatedCtx = baseCtx({ vehicles: [{ id: 'v2', plate_number: 'KDA 999Z', assigned_driver_id: 'drv1', asset_type: 'BUS' }] });
  const gatedFlow = getFlowDefinition('driver_onboarding', gatedCtx);
  const gatedMinimal = gatedFlow.fields.find((f) => f.key === 'minimal_compliance');
  check(Boolean(gatedMinimal) && gatedMinimal.optional === false, 'Gated driver minimum is mandatory');

  console.log('\n--- Test 4: the driver profile command routes deterministically ---');
  check(
    detectQuizStart({ intent: 'GENERAL_CHAT', messageText: 'driver profile', hasVehicleRegistered: true }) === 'driver_onboarding',
    '"driver profile" routes into driver onboarding'
  );
  check(
    detectQuizStart({ intent: 'GENERAL_CHAT', messageText: 'my driver profile', hasVehicleRegistered: true }) === 'driver_onboarding',
    '"my driver profile" routes into driver onboarding'
  );

  console.log('\n--- Test 5: registration prefill seeds the verified email ---');
  const session = {};
  const started = startQuiz({
    session,
    flowKey: 'driver_onboarding',
    ctx: ownerCtx,
    prefill: { driver_email: 'owner@example.com' }
  });
  check(started === true && Boolean(session.quiz), 'Driver onboarding quiz starts with prefill');
  check(session.quiz.answers.driver_email === 'owner@example.com', 'Verified email is prefilled into the quiz');
  check(!session.quiz.answers.minimal_compliance, 'No compliance is invented before the user supplies it');

  console.log('\n--- Test 6: code + licence in one message are both captured ---');
  const bankingCtx = baseCtx({
    profile: { id: 'drv2', full_name: 'Fleet Driver', email: 'driver2@example.com', email_verified: false },
    vehicles: [{ id: 'v3', plate_number: 'KDB 456B', assigned_driver_id: 'drv2', asset_type: 'BUS' }]
  });
  const bankSession = {};
  startQuiz({ session: bankSession, flowKey: 'driver_onboarding', ctx: bankingCtx });
  bankSession.quiz.answers = { full_name: 'Fleet Driver', driver_email: 'driver2@example.com' };
  bankSession.quiz.otp = { code: '123456', expiresAt: Date.now() + 10 * 60 * 1000 };
  const bankTurn = await handleQuizTurn({
    session: bankSession,
    messageText: '123456 DL-1234567 expires 15 Dec 2028',
    ctx: bankingCtx
  });
  check(bankTurn.handled === true, 'OTP turn is handled');
  const banked = bankSession.quiz?.answers?.minimal_compliance;
  check(banked?.ok === true && banked?.expiry === '2028-12-15', 'Licence sent beside the code is banked in the same turn');

  console.log('\n--- Test 7: "already told you" answers from the stored record, never loops ---');
  const expiredCtx = baseCtx({
    driverGate: {
      status: {
        emailVerified: true,
        minimal: { type: 'driver_license', status: 'expired', valid: false, expiry: '2025-01-10', lifetime: false, number: 'PGZ160' },
        additional: []
      }
    }
  });
  const expiredSession = {};
  startQuiz({ session: expiredSession, flowKey: 'driver_onboarding', ctx: expiredCtx });
  expiredSession.quiz.answers = { full_name: 'Fleet Driver', driver_email: 'driver@example.com', otp: true };
  const expiredTurn = await handleQuizTurn({ session: expiredSession, messageText: 'Already told you earlier', ctx: expiredCtx });
  check(expiredTurn.handled === true && !expiredTurn.pausedForChat, 'Frustration turn is handled in-flow (never paused)');
  check(/on file/i.test(String(expiredSession.quiz?.lastAcceptedAnswer || '')), 'Expired licence on file is acknowledged specifically');

  const psvExpiredCtx = baseCtx({
    driverGate: {
      status: {
        emailVerified: true,
        minimal: { type: 'driver_license', status: 'valid', valid: true, expiry: '2028-11-28', lifetime: false, number: 'PGZ160' },
        additional: [{ type: 'psv_badge', status: 'expired', valid: false, expiry: '2026-01-31', lifetime: false, number: 'PSV-99' }]
      }
    }
  });
  const psvExpiredSession = {};
  startQuiz({ session: psvExpiredSession, flowKey: 'driver_onboarding', ctx: psvExpiredCtx });
  psvExpiredSession.quiz.answers = { full_name: 'Fleet Driver', driver_email: 'driver@example.com', otp: true };
  const psvExpiredTurn = await handleQuizTurn({ session: psvExpiredSession, messageText: 'I already sent it', ctx: psvExpiredCtx });
  check(psvExpiredTurn.handled === true, 'Second frustration turn is handled');
  check(/expired/i.test(String(psvExpiredSession.quiz?.lastAcceptedAnswer || '')), 'An expired stored PSV badge is acknowledged with its expiry');

  console.log('\n--- Test 8: an owner self-profile may skip the OTP step ---');
  const skipCtx = baseCtx({
    profile: { id: 'own2', full_name: 'Asset Owner', email: 'owner2@example.com', email_verified: false },
    vehicles: [{ id: 'v4', plate_number: 'KBJ 819C', owner_id: 'own2', asset_type: 'ICE' }],
    driverSelfProfile: true
  });
  const skipSession = {};
  startQuiz({ session: skipSession, flowKey: 'driver_onboarding', ctx: skipCtx });
  skipSession.quiz.answers = { full_name: 'Asset Owner', driver_email: 'owner2@example.com' };
  const skipTurn = await handleQuizTurn({ session: skipSession, messageText: 'skip', ctx: skipCtx });
  check(skipTurn.handled === true, 'Skip turn is handled');
  check(skipSession.quiz?.answers?.otp === null && skipSession.quiz?.emailSkipped === true, 'Owner OTP step is skipped deterministically');

  console.log(`\n🎉 ${passed} owner-driver-profile assertions passed.`);
}

// v1.63.1 (2C) — driver assignment/compliance invalidation spies (stateless).
console.log('\n--- v1.63.1: driver-compliance invalidation spies ---');
{
  const makeDriverMock = (assignmentOverrides = {}) => {
    const deletes = [];
    const assignmentRow = {
      id: 'a-1', vehicle_id: 'v-1', driver_id: 'drv-1', owner_id: 'own-1',
      driver_phone: '+254700000002', status: 'PENDING_DRIVER_ACCEPTANCE',
      accepted_at: new Date().toISOString(), created_at: new Date().toISOString(),
      invalid_compliance_attempts: 0,
      ...assignmentOverrides
    };
    const vehicleRow = { id: 'v-1', owner_id: 'own-1', plate_number: 'KDA 123A', asset_type: 'ICE', current_mileage: 1000, metadata: {} };
    const builder = (table) => {
      const api = {
        select: () => api,
        eq: () => api,
        neq: () => api,
        in: () => api,
        is: () => api,
        order: () => api,
        limit: () => api,
        insert: (rows) => {
          const data = Array.isArray(rows) ? rows : [rows];
          const chain = {
            select: () => chain,
            maybeSingle: async () => ({ data: data[0] || null, error: null }),
            single: async () => ({ data: data[0] || null, error: null }),
            then: (a, b) => Promise.resolve({ data, error: null }).then(a, b)
          };
          return chain;
        },
        update: () => {
          const row = table === 'vehicles' ? vehicleRow : assignmentRow;
          const chain = {
            eq: () => chain,
            in: () => chain,
            is: () => chain,
            select: () => chain,
            maybeSingle: async () => ({ data: row, error: null }),
            single: async () => ({ data: row, error: null }),
            then: (a, b) => Promise.resolve({ data: row, error: null }).then(a, b)
          };
          return chain;
        },
        delete: () => ({
          eq: (col, value) => { deletes.push({ table, col, value }); return Promise.resolve({ error: null }); },
          in: () => Promise.resolve({ error: null })
        }),
        maybeSingle: async () => ({
          data: table === 'vehicles' ? vehicleRow : (table === 'profiles' ? { id: 'drv-1', email_verified: true, phone_number: '+254700000002' } : null),
          error: null
        }),
        single: async () => ({ data: table === 'vehicles' ? vehicleRow : null, error: null }),
        then: (a, b) => {
          let data = [];
          if (table === 'driver_assignments') data = [assignmentRow];
          if (table === 'profiles') data = [{ id: 'drv-1', email_verified: true, phone_number: '+254700000002' }];
          return Promise.resolve({ data, error: null }).then(a, b);
        }
      };
      return api;
    };
    return { client: { from: builder }, deletes };
  };

  const submitMock = makeDriverMock();
  const submitted = await submitDriverCompliance({
    supabase: submitMock.client,
    driverId: 'drv-1',
    item: { type: 'driver_license', label: 'Driver licence' },
    parsed: { ok: true, number: 'DL-1', expiry: '2027-12-15', lifetime: false, expired: false },
    isMinimal: true,
    countryCode: 'KE',
    assetType: 'ICE'
  });
  check(submitted.ok === true && submitMock.deletes.some((d) => d.table === 'user_context_cache' && d.col === 'owner_id' && d.value === 'drv-1'), 'submitDriverCompliance invalidates the driver cache (v1.63.1)');

  const cancelMock = makeDriverMock({ invalid_compliance_attempts: 2, status: 'ACTIVE' });
  const cancelled = await recordInvalidMinimalSubmission({ supabase: cancelMock.client, driverId: 'drv-1', itemLabel: 'Driver licence', expiry: '2026-01-01' });
  check(cancelled.cancelled === true && cancelMock.deletes.some((d) => d.table === 'user_context_cache' && d.col === 'owner_id' && d.value === 'own-1'), 'a compliance cancellation invalidates the owner cache (v1.63.1)');

  const acceptMock = makeDriverMock();
  const accepted = await handleDriverResponse({ driverPhone: '+254700000002', response: 'ACCEPT', supabase: acceptMock.client });
  check(accepted && accepted.status === 'ACCEPTED' && acceptMock.deletes.some((d) => d.table === 'user_context_cache' && d.col === 'owner_id' && d.value === 'own-1'), 'driver ACCEPT invalidates the owner cache (v1.63.1)');
}

run().catch((err) => {
  console.error('\n❌ Owner driver profile suite failed:', err.message);
  process.exit(1);
});
