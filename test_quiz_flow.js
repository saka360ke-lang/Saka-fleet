import 'dotenv/config';
import {
  detectQuizStart,
  handleQuizTurn,
  getFlowDefinition
} from './src/services/quizEngine.js';

/**
 * Targeted suite: one-piece-at-a-time quiz engine + confirmation gate.
 * Stateless — creates no database rows (no cleanup required).
 */

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}

const countryInfo = {
  country: 'Kenya', country_code: 'KE', plate_example: 'KDA 123A',
  default_units: 'metric', currency: 'KES', default_language: 'English', locale: 'en-KE'
};

function baseCtx(overrides = {}) {
  return {
    supabase: null,
    profile: { id: '00000000-0000-0000-0000-000000000001', email: '', unit_system: 'metric', subscription_tier: 'free' },
    vehicles: [],
    countryInfo,
    senderPhone: '+254700000001',
    formattedPhone: '+254700000001',
    language: 'English',
    aiExtracted: {},
    sendWhatsApp: async () => {},
    ...overrides
  };
}

const vehicle = {
  id: '11111111-1111-1111-1111-111111111111',
  owner_id: '00000000-0000-0000-0000-000000000001',
  plate_number: 'KDA 123A',
  make_model: 'Toyota Land Cruiser',
  current_mileage: 360000,
  odometer_reading: 360000,
  unit_system: 'metric',
  metadata: {}
};

async function run() {
  console.log('--- Test 1: flow definitions & detection ---');
  const regFlow = getFlowDefinition('vehicle_registration', baseCtx());
  const keys = regFlow.fields.map((f) => f.key);
  assert(keys[0] === 'plate_number', 'Registration starts with plate number');
  assert(keys.includes('vin') && keys.includes('owner_email') && keys.includes('otp'), 'Registration includes VIN, email and OTP');
  assert(regFlow.fields.filter((f) => f.group === 'optional').length >= 8, 'Optional spec group is present');

  assert(detectQuizStart({ intent: 'REGISTER_VEHICLE', messageText: 'register', hasVehicleRegistered: false }) === 'vehicle_registration', 'Registration intent starts registration quiz');
  assert(detectQuizStart({ intent: 'ASSIGN_DRIVER', messageText: 'assign driver', hasVehicleRegistered: true }) === 'assign_driver', 'Assign-driver intent maps to its quiz');
  assert(detectQuizStart({ intent: 'GENERAL_CHAT', messageText: 'what can I do', hasVehicleRegistered: true }) === null, 'General chat does not start a quiz');

  console.log('\n--- Test 2: one question at a time (regression for mega-prompt) ---');
  const session = {};
  const ctx = baseCtx();

  await handleQuizTurn({
    session,
    messageText: 'KDA 123A',
    aiExtracted: { plate_number: 'KDA 123A' },
    startFlow: 'vehicle_registration',
    ctx
  });
  assert(session.quiz?.flow === 'vehicle_registration', 'Quiz session created');
  assert(session.quiz.answers.plate_number === 'KDA 123A', 'Plate captured');
  assert(session.quiz.answers.make_model === undefined, 'Make/model NOT captured yet (one at a time)');

  await handleQuizTurn({
    session,
    messageText: 'Toyota Land Cruiser 80 series',
    aiExtracted: { make_model: 'Toyota Land Cruiser 80 series' },
    ctx
  });
  assert(session.quiz.answers.make_model === 'Toyota Land Cruiser 80 series', 'Make/model captured on the next turn');
  assert(session.quiz.answers.vin === undefined && session.quiz.answers.owner_email === undefined, 'VIN and email are NOT requested in the same turn');

  console.log('\n--- Test 3: multi-field fast-forward ---');
  await handleQuizTurn({
    session,
    messageText: '1991 diesel, 366700 km',
    aiExtracted: { yom: 1991, fuel_type: 'Diesel', current_mileage: 366700 },
    ctx
  });
  assert(session.quiz.answers.yom === 1991, 'YOM captured from a multi-field answer');
  assert(session.quiz.answers.fuel_type === 'Diesel', 'Fuel captured from a multi-field answer');
  assert(session.quiz.answers.current_mileage === 366700, 'Odometer captured from a multi-field answer');
  assert(session.quiz.answers.vin === undefined, 'Fast-forward still asks only the next missing item');

  console.log('\n--- Test 4: expense quiz + confirmation before write ---');
  const expenseSession = {};
  const expenseCtx = baseCtx({ vehicles: [vehicle] });

  await handleQuizTurn({ session: expenseSession, messageText: 'log expense', startFlow: 'log_expense', ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: 'KDA 123A', aiExtracted: { vehicle_id: vehicle.id }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: 'Fuel', aiExtracted: { expense_type: 'Fuel' }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: '5000', aiExtracted: { amount: 5000 }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: '40', aiExtracted: { fuel_liters: 40 }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: '366800', aiExtracted: { odometer: 366800 }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: 'skip', ctx: expenseCtx });

  assert(expenseSession.quiz.phase === 'confirm', 'Quiz reaches confirmation phase (no write yet)');
  assert(expenseSession.quiz.answers.notes === null, 'Optional notes skipped cleanly');
  const amountBefore = expenseSession.quiz.answers.amount;

  const confirmTurn = await handleQuizTurn({
    session: expenseSession,
    messageText: 'change amount to 6000',
    aiExtracted: { amount: 6000 },
    ctx: expenseCtx
  });
  assert(confirmTurn.handled === true, 'Correction turn handled');
  assert(expenseSession.quiz.answers.amount === 6000, 'Correction updates the collected value');
  assert(amountBefore === 5000 && expenseSession.quiz.phase === 'confirm', 'Correction returns to the confirmation summary');

  console.log('\n--- Test 5: navigation freedom ---');
  const cancelTurn = await handleQuizTurn({ session: expenseSession, messageText: 'cancel', ctx: expenseCtx });
  assert(cancelTurn.handled && !expenseSession.quiz, 'Cancel clears the active quiz');

  const restartSession = {};
  await handleQuizTurn({ session: restartSession, messageText: 'log mileage', startFlow: 'log_mileage', ctx: expenseCtx });
  await handleQuizTurn({ session: restartSession, messageText: '1', aiExtracted: { vehicle_id: vehicle.id }, ctx: expenseCtx });
  await handleQuizTurn({ session: restartSession, messageText: '367000', aiExtracted: { odometer: 367000 }, ctx: expenseCtx });
  assert(restartSession.quiz.phase === 'confirm', 'Mileage quiz confirms before save');
  await handleQuizTurn({ session: restartSession, messageText: 'restart', ctx: expenseCtx });
  assert(
    restartSession.quiz &&
    restartSession.quiz.answers.odometer_reading === undefined &&
    restartSession.quiz.answers.vehicle_id === vehicle.id,
    'Restart clears collected answers (auto-keeps the only registered vehicle)'
  );

  console.log(`\n🎉 ALL QUIZ ENGINE TESTS PASSED (${passed} assertions).`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
