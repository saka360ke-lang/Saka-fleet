/**
 * Saka Fleet — Owner driver profile suite (v1.16.0)
 * ------------------------------------------------
 * Asserts that every owner gets a driver profile path and that Saka NEVER
 * re-asks for compliance already on file (the "Already told you earlier" bug).
 *
 * Run: node --env-file=.env test_driver_profile_onboarding.js
 */

import assert from 'assert';
import { getFlowDefinition, detectQuizStart, startQuiz } from './src/services/quizEngine.js';

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

function run() {
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

  console.log(`\n🎉 ${passed} owner-driver-profile assertions passed.`);
}

try {
  run();
} catch (err) {
  console.error('\n❌ Owner driver profile suite failed:', err.message);
  process.exit(1);
}
