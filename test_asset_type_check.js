/**
 * Saka Fleet — asset_type CHECK + confirm-gate pollution suite (v1.61.17)
 * -----------------------------------------------------------------------
 * The live 2026-11-05/06 lawn-mower failure, pinned end to end:
 *   • the canonical asset_type vocabulary matches every write path,
 *   • the orphaned legacy DB constraint can NEVER kill a save again,
 *   • with the migrated constraint the canonical value saves first try,
 *   • complaint text at the confirm gate is never banked as a field value,
 *   • repeated real save failures climb the Support ladder.
 * In-memory Supabase double only — no provider calls, no real rows.
 */
import assert from 'assert';
import fs from 'node:fs';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  assetTypeForKind,
  legacyAssetType,
  normalizeAssetKind,
  ASSET_TYPE_VALUES,
  ASSET_TYPE_CHECK_SQL
} from './src/services/countryBucket.js';
import { isPollutedFieldValue, handleQuizTurn } from './src/services/quizEngine.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log('  ok ' + message);
}

const LEGACY_SET = new Set(['ICE', 'EV', 'HEAVY_MACHINERY']);
const NEW_SET = new Set(ASSET_TYPE_VALUES);

function constraintHook(allowed, name) {
  return (table, rows) => {
    if (table !== 'vehicles') return null;
    for (const row of rows || []) {
      if (row.asset_type && !allowed.has(String(row.asset_type))) {
        return {
          error: {
            message: `new row for relation "vehicles" violates check constraint "${name}"`,
            code: '23514'
          }
        };
      }
    }
    return null;
  };
}

const ownerProfile = {
  id: 'p-1',
  phone_number: '+254700000001',
  email: 'owner@example.com',
  email_verified: true,
  subscription_tier: 'free',
  subscription_status: 'ACTIVE',
  unit_system: 'metric'
};

function makeMock(beforeInsert = null) {
  const seed = {
    profiles: [{ ...ownerProfile }],
    vehicles: [],
    trial_sessions: [],
    coupons: [],
    usage_counters: [],
    vehicle_compliances: [],
    reminders: [],
    error_logs: [],
    admin_audit_logs: []
  };
  return beforeInsert ? createMockSupabase(seed, { beforeInsert }) : createMockSupabase(seed);
}

function machinerySession(overrides = {}) {
  return {
    flow: 'vehicle_registration',
    phase: 'confirm',
    startedAt: Date.now(),
    answers: {
      asset_kind: 'machinery',
      serial_number: 'JOYCELAWNMOWER',
      make_model: 'BUMBLE BEE LAWN MOWER',
      yom: 2024,
      fuel_type: 'Petrol',
      operating_hours: 12.5,
      engine_number: 'XXXFFFXXX',
      ...overrides
    }
  };
}

function ctxFor(mock) {
  return {
    supabase: mock.client,
    profile: { ...ownerProfile },
    vehicles: [],
    countryInfo: { country_code: 'KE', currency: 'KES', locale: 'en-KE', plate_example: 'KDA 123A' },
    senderPhone: '+254700000001',
    formattedPhone: '+254700000001',
    language: 'English',
    intent: 'GENERAL_CHAT',
    aiExtracted: {},
    sendWhatsApp: async () => {}
  };
}

console.log('=== SAKA FLEET — asset_type + pollution suite (v1.61.17) ===');

console.log('\n--- 1. one canonical vocabulary (the root cause) ---');
check(assetTypeForKind('machinery', 'Petrol') === 'MACHINERY', 'machinery writes MACHINERY (canonical)');
check(assetTypeForKind('generator') === 'GENERATOR', 'generator writes GENERATOR');
check(assetTypeForKind('boat') === 'WATERCRAFT', 'boats write WATERCRAFT');
check(assetTypeForKind('excavator') === 'HEAVY_EQUIPMENT', 'excavators write HEAVY_EQUIPMENT');
check(assetTypeForKind('vehicle', 'Electric') === 'EV', 'electric road assets write EV');
check(assetTypeForKind('vehicle', 'Petrol Hybrid') === 'HYBRID', 'hybrid road assets write HYBRID (was rejected live)');
check(assetTypeForKind('vehicle', 'Diesel') === 'ICE', 'combustion road assets write ICE');
check(ASSET_TYPE_VALUES.includes('HEAVY_MACHINERY'), 'the legacy value stays valid (old rows never break)');
check(normalizeAssetKind('HEAVY_MACHINERY') === 'machinery', 'legacy rows map back to machinery for metrics');
check(normalizeAssetKind('lawn mower') === 'machinery' && normalizeAssetKind('mower') === 'machinery', 'lawn mower resolves deterministically (no AI needed)');
check(legacyAssetType('MACHINERY') === 'HEAVY_MACHINERY' && legacyAssetType('HYBRID') === 'ICE' && legacyAssetType('EV') === 'EV', 'the degrade mapping is legacy-constraint safe');
check(ASSET_TYPE_CHECK_SQL.includes('DROP CONSTRAINT IF EXISTS vehicles_asset_type_check') && ASSET_TYPE_CHECK_SQL.includes("'HYBRID'") && ASSET_TYPE_CHECK_SQL.includes("'HEAVY_MACHINERY'"), 'the migration replaces the constraint idempotently and keeps legacy rows valid');

console.log('\n--- 2. complaint text is never a field value ---');
for (const text of ['Add machine', 'This problem ahs been persistent since yesterday', 'Is my lawn mower saved?', 'it keeps failing', 'nothing was saved', 'still not saved']) {
  check(isPollutedFieldValue(text) === true, `never a field value: "${text}"`);
}
check(isPollutedFieldValue('BUMBLE BEE LAWN MOWER') === false, 'a real make/model is still accepted');

console.log('\n--- 3. legacy DB constraint can NEVER kill the save again ---');
const legacyMock = makeMock(constraintHook(LEGACY_SET, 'vehicles_asset_type_check'));
const legacySession = { quiz: machinerySession() };
const legacyTurn = await handleQuizTurn({ session: legacySession, messageText: '1', ctx: ctxFor(legacyMock) });
check(legacyMock.db.vehicles.length === 1, 'the mower is SAVED even against the orphaned legacy constraint');
check(legacyMock.db.vehicles[0].asset_type === 'HEAVY_MACHINERY', 'the legacy-safe value is written (constraint-compatible)');
check(legacyMock.db.vehicles[0].asset_kind === 'machinery' && legacyMock.db.vehicles[0].serial_number === 'JOYCELAWNMOWER', 'the canonical kind + serial identity are preserved');
check((legacyMock.db.error_logs || []).some((row) => row.route === 'quizEngine.assetTypeLegacyFallback'), 'the fallback is logged (rule 50), never silent');
check(legacyTurn.handled === true && Boolean(legacyTurn.reply), 'the user gets a real confirmation, not a failure card');

console.log('\n--- 4. migrated DB: the canonical value saves first try ---');
const canonicalMock = makeMock(constraintHook(NEW_SET, 'vehicles_asset_type_check'));
const canonicalSession = { quiz: machinerySession() };
await handleQuizTurn({ session: canonicalSession, messageText: '1', ctx: ctxFor(canonicalMock) });
check(canonicalMock.db.vehicles.length === 1 && canonicalMock.db.vehicles[0].asset_type === 'MACHINERY', 'machinery saves as MACHINERY with no fallback');
check(!(canonicalMock.db.error_logs || []).some((row) => row.route === 'quizEngine.assetTypeLegacyFallback'), 'no fallback incident on a migrated DB');

console.log('\n--- 5. the confirm gate never banks a complaint (D2) ---');
const guardMock = makeMock();
const guardSession = { quiz: machinerySession() };
await handleQuizTurn({ session: guardSession, messageText: 'This problem ahs been persistent since yesterday', ctx: ctxFor(guardMock) });
check(guardSession.quiz.answers.make_model === 'BUMBLE BEE LAWN MOWER', 'the complaint never overwrites make/model');
check(guardMock.db.vehicles.length === 0, 'nothing is written by a complaint');
await handleQuizTurn({ session: guardSession, messageText: 'Add machine', ctx: ctxFor(guardMock) });
check(guardSession.quiz.answers.make_model === 'BUMBLE BEE LAWN MOWER', '"Add machine" never overwrites make/model either');
check(guardSession.quiz.phase === 'confirm', 'the card stays at the confirm gate (one save away)');

console.log('\n--- 6. a polluted draft is refused honestly (D2b) ---');
const pollutedMock = makeMock();
const pollutedSession = { quiz: machinerySession({ make_model: 'Add machine' }) };
const pollutedTurn = await handleQuizTurn({ session: pollutedSession, messageText: '1', ctx: ctxFor(pollutedMock) });
check(pollutedMock.db.vehicles.length === 0, 'nothing is saved from a polluted draft');
check(pollutedSession.quiz.answers.make_model === undefined && pollutedSession.quiz.phase === 'question', 'the bad make/model is cleared and re-asked');
check(/make and model/i.test(pollutedTurn.reply || ''), 'the refusal asks for the make/model with an example');
check(!(pollutedMock.db.error_logs || []).some((row) => row.route === 'quizEngine.persistVehicleRegistration'), 'a business refusal is not logged as an incident');

console.log('\n--- 7. repeated real failures climb the Support ladder (D3) ---');
const failingMock = createMockSupabase({
  profiles: [{ ...ownerProfile }],
  vehicles: [],
  trial_sessions: [],
  coupons: [],
  usage_counters: [],
  error_logs: [],
  admin_audit_logs: []
}, {
  beforeInsert: (table) => (table === 'vehicles'
    ? { error: { message: 'simulated database outage', code: 'XX000' } }
    : null)
});
const failingSession = { quiz: machinerySession() };
const firstFail = await handleQuizTurn({ session: failingSession, messageText: '1', ctx: ctxFor(failingMock) });
const secondFail = await handleQuizTurn({ session: failingSession, messageText: '1', ctx: ctxFor(failingMock) });
check(!/Support/.test(firstFail.reply || ''), 'the first real failure states the problem without pushing support');
check(/Support/.test(secondFail.reply || '') && /Cancel/.test(secondFail.reply || ''), 'the second failure offers the human lane and a clean restart');
check((failingMock.db.error_logs || []).some((row) => row.route === 'quizEngine.persistVehicleRegistration'), 'real failures are still logged (rule 50)');

console.log('\n--- 8. siblings use the same helper (rule 51) ---');
const onboardingSource = fs.readFileSync('src/services/onboarding.js', 'utf8');
check(onboardingSource.includes('assetTypeForKind') && onboardingSource.includes('legacyAssetType'), 'onboarding uses the shared vocabulary + legacy degrade');
const routeSource = fs.readFileSync('src/routes/whatsapp/messages.js', 'utf8');
check(/mower/.test(routeSource), 'the register detector recognises mower wording');

console.log(`\n🎉 ALL ASSET-TYPE + POLLUTION TESTS PASSED (${passed} assertions).`);


