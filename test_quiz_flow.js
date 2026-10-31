import 'dotenv/config';
import {
  detectQuizStart,
  handleQuizTurn,
  getFlowDefinition,
  getCurrentQuizField,
  shouldPauseQuizForChat,
  detectFlowSwitch,
  isPlateLike
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
    intent: 'GENERAL_CHAT',
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
  assert(keys[0] === 'asset_kind', 'Registration starts by asking the asset kind');
  assert(keys[1] === 'plate_number', 'Road assets are then asked for the plate');
  assert(keys.includes('vin') && keys.includes('owner_email') && keys.includes('otp'), 'Registration includes VIN, email and OTP');
  assert(regFlow.fields.filter((f) => f.group === 'optional').length >= 8, 'Optional spec group is present');

  assert(detectQuizStart({ intent: 'REGISTER_VEHICLE', messageText: 'register', hasVehicleRegistered: false }) === 'vehicle_registration', 'Registration intent starts registration quiz');
  assert(detectQuizStart({ intent: 'ASSIGN_DRIVER', messageText: 'assign driver', hasVehicleRegistered: true }) === 'assign_driver', 'Assign-driver intent maps to its quiz');
  assert(detectQuizStart({ intent: 'GENERAL_CHAT', messageText: 'what can I do', hasVehicleRegistered: true }) === null, 'General chat does not start a quiz');
  assert(detectQuizStart({ intent: 'VIEW_PROFILE', messageText: 'my profile details', hasVehicleRegistered: true }) === null, 'Viewing a profile never starts a quiz');
  assert(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'Logged 30L fuel at 50350 km for KES 5500', hasVehicleRegistered: true }) === null,
    'Complete one-line fuel logs skip the quiz (saved directly by the quick path)'
  );
  assert(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'I want to log fuel', hasVehicleRegistered: true }) === 'log_expense',
    'Incomplete fuel logs still start the quiz (fill type is asked)'
  );
  assert(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'give me an analysis of fuel consumption in km/l', hasVehicleRegistered: true }) === null,
    'Fuel-economy queries never start the expense quiz, even if the classifier leans LOG_EXPENSE'
  );
  assert(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'switch to KBC 888B', hasVehicleRegistered: true }) === null,
    'Vehicle switching is never hijacked by a misclassified LOG_EXPENSE intent'
  );

  const profileField = getFlowDefinition('edit_profile', baseCtx()).fields.find((f) => f.key === 'profile_field');
  assert(profileField.parse('lugha') === 'Language', 'Swahili "lugha" selects the Language field');
  assert(profileField.parse('vipimo') === 'Unit system', 'Swahili "vipimo" selects the Unit system field');
  assert(profileField.parse('jina') === 'Full name', 'Swahili "jina" selects the Full name field');

  console.log('\n--- Test 2: one question at a time (regression for mega-prompt) ---');
  const session = {};
  const ctx = baseCtx();

  await handleQuizTurn({
    session,
    messageText: 'Car',
    aiExtracted: { asset_kind: 'vehicle' },
    startFlow: 'vehicle_registration',
    ctx
  });
  assert(session.quiz?.flow === 'vehicle_registration', 'Quiz session created');
  assert(session.quiz.answers.asset_kind === 'vehicle', 'Asset kind captured first');

  await handleQuizTurn({
    session,
    messageText: 'KDA 123A',
    aiExtracted: { plate_number: 'KDA 123A' },
    ctx
  });
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

  console.log('\n--- Test 3b: no phantom plates from paragraphs (v1.28.3) ---');
  assert(isPlateLike('KDA 123A') === true, 'a Kenyan plate is plate-like');
  assert(isPlateLike('AB12 CDE') === true, 'a UK plate is plate-like');
  assert(isPlateLike('7ABC123') === true, 'a US plate is plate-like');
  assert(isPlateLike('MH01AB1234') === true, 'an Indian plate is plate-like');
  assert(isPlateLike('1991 80') === false, 'the live odometer/year fragment is rejected');
  assert(isPlateLike('367359KM') === false, 'an odometer reading is rejected');
  assert(isPlateLike('20TH') === false, 'an ordinal date fragment is rejected');
  assert(isPlateLike('HDJ810007675') === false, 'a VIN is rejected as a plate');
  assert(isPlateLike('1234') === false, 'a bare number is rejected');

  const phantomCtx = baseCtx({ vehicles: [] });
  const phantomSession = {};
  await handleQuizTurn({
    session: phantomSession,
    messageText: "Ok. I'd like to register my car A 1991 80 series land cruiser Current odometer 367359km Insurance expires 20th November 2026, it's a manual transmission. Vin number: HDJ810007675",
    startFlow: 'vehicle_registration',
    ctx: phantomCtx
  });
  assert(phantomSession.quiz?.flow === 'vehicle_registration', 'the live paragraph starts registration');
  assert(phantomSession.quiz?.answers?.plate_number === undefined, 'the live registration paragraph banks no phantom plate');
  const plateTurn = await handleQuizTurn({ session: phantomSession, messageText: 'Car Registration KAS 628T', ctx: phantomCtx });
  assert(plateTurn.handled === true, 'the asset-kind + registration turn is handled');
  assert(phantomSession.quiz?.answers?.asset_kind !== undefined, 'the asset kind is parsed from the same sentence');
  assert(phantomSession.quiz?.answers?.plate_number === 'KAS 628T', 'the real plate is banked when volunteered alongside the asset kind');
  await handleQuizTurn({ session: phantomSession, messageText: 'cancel', ctx: phantomCtx });

  console.log('\n--- Test 6: quiz ↔ conversation arbitration ---');
  const currentField = getCurrentQuizField(session.quiz, ctx);
  assert(currentField && /vin/i.test(currentField.label), 'Current pending field is VIN');

  assert(shouldPauseQuizForChat({ messageText: 'Hello', intent: 'GREETING', quiz: session.quiz }), 'Greeting pauses the quiz');
  assert(shouldPauseQuizForChat({ messageText: 'What is Saka Fleet?', intent: 'GENERAL_CHAT', quiz: session.quiz }), 'Question pauses the quiz');
  assert(shouldPauseQuizForChat({
    messageText: 'I want to know more about saka fleet before I give you my details',
    intent: 'GENERAL_CHAT',
    quiz: session.quiz
  }), 'Informational request pauses the quiz');
  assert(!shouldPauseQuizForChat({ messageText: '1HGCR2F83HA123456', intent: 'GENERAL_CHAT', quiz: session.quiz }), 'A real answer does NOT pause the quiz');
  assert(shouldPauseQuizForChat({ messageText: 'GENERAL_CHAT', intent: 'GENERAL_CHAT', quiz: session.quiz }) === false, 'Short answers are not mistaken for conversation');
  assert(!shouldPauseQuizForChat({ messageText: 'Reset', intent: 'GENERAL_CHAT', quiz: session.quiz }), 'Reset remains engine-owned');
  assert(!shouldPauseQuizForChat({ messageText: '123456', intent: 'GENERAL_CHAT', quiz: { ...session.quiz, phase: 'pin' } }), 'Release PIN phase never pauses');

  const answersBeforePause = JSON.stringify(session.quiz.answers);
  const pausedTurn = await handleQuizTurn({
    session,
    messageText: 'What is Saka Fleet?',
    aiExtracted: {},
    ctx
  });
  assert(pausedTurn.handled === false && pausedTurn.pausedForChat === true, 'Engine hands conversational turns back to the route');
  assert(JSON.stringify(session.quiz.answers) === answersBeforePause && session.quiz.phase === 'question', 'Quiz state is untouched while paused');

  const resumedTurn = await handleQuizTurn({
    session,
    messageText: '1HGCR2F83HA123456',
    aiExtracted: { vin: '1HGCR2F83HA123456' },
    ctx
  });
  assert(resumedTurn.handled && session.quiz.answers.vin === '1HGCR2F83HA123456', 'Quiz resumes and accepts the next answer');
  assert(session.quiz.answers.owner_email === undefined, 'Resume advances exactly one question');

  console.log('\n--- Test 4: expense quiz + confirmation before write ---');
  const expenseSession = {};
  const expenseCtx = baseCtx({ vehicles: [vehicle] });

  await handleQuizTurn({ session: expenseSession, messageText: 'log expense', startFlow: 'log_expense', ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: 'KDA 123A', aiExtracted: { vehicle_id: vehicle.id }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: 'Fuel', aiExtracted: { expense_type: 'Fuel' }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: '5000', aiExtracted: { amount: 5000 }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: '40', aiExtracted: { fuel_liters: 40 }, ctx: expenseCtx });
  await handleQuizTurn({ session: expenseSession, messageText: 'full tank', aiExtracted: { fill_type: 'full' }, ctx: expenseCtx });
  assert(expenseSession.quiz.answers.fill_type === 'Full tank', 'Fill type captured (full tank)');
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

  console.log('\n--- Test 4b: multi-part banking in one message (v1.28.0) ---');
  const bankCtx = baseCtx({ vehicles: [vehicle] });
  const bankSession = {};
  await handleQuizTurn({ session: bankSession, messageText: 'log fuel', startFlow: 'log_expense', ctx: bankCtx });
  await handleQuizTurn({ session: bankSession, messageText: 'KDA 123A', aiExtracted: { vehicle_id: vehicle.id }, ctx: bankCtx });
  await handleQuizTurn({ session: bankSession, messageText: 'Fuel', aiExtracted: { expense_type: 'Fuel' }, ctx: bankCtx });
  const bankTurn = await handleQuizTurn({
    session: bankSession,
    messageText: '5000 for 40 litres at 366900 km, full tank',
    ctx: bankCtx
  });
  assert(bankTurn.handled === true, 'the banking turn is handled');
  assert(bankSession.quiz.answers.amount === 5000, 'amount is captured from the one-line log');
  assert(bankSession.quiz.answers.fuel_liters === 40, 'fuel litres are banked from the same sentence');
  assert(bankSession.quiz.answers.odometer_reading === 366900, 'odometer is banked from the same sentence');
  assert(bankSession.quiz.answers.fill_type === 'Full tank', 'fill type is banked from the same sentence');
  await handleQuizTurn({ session: bankSession, messageText: 'skip', ctx: bankCtx });
  assert(bankSession.quiz.phase === 'confirm', 'banked values flow straight to the confirmation gate');
  await handleQuizTurn({ session: bankSession, messageText: 'cancel', ctx: bankCtx });

  console.log('\n--- Test 4c: typo-tolerant quiz arbitration (v1.28.0) ---');
  assert(
    shouldPauseQuizForChat({ messageText: 'Habbari', intent: 'GENERAL_CHAT', quiz: { phase: 'question' } }) === true,
    'a mistyped greeting still pauses the quiz for conversation'
  );
  assert(
    shouldPauseQuizForChat({ messageText: 'hepl', intent: 'GENERAL_CHAT', quiz: { phase: 'question' } }) === true,
    'a mistyped help still pauses the quiz'
  );

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

  console.log('\n--- Test 7: audit regression — reminder must beat AI intent & switch flows ---');
  assert(
    detectQuizStart({
      intent: 'LOG_EXPENSE',
      messageText: 'Set reminder. Oil change in 2500km',
      hasVehicleRegistered: true
    }) === 'set_reminder',
    'Explicit "Set reminder" wins over a misclassified LOG_EXPENSE intent'
  );
  assert(
    detectQuizStart({ intent: 'LOG_EARNINGS', messageText: 'Income', hasVehicleRegistered: true }) === 'log_earnings',
    'AI intent still maps when no explicit command pattern matches'
  );
  assert(
    detectFlowSwitch({
      quiz: { flow: 'log_expense', phase: 'question', answers: {} },
      messageText: 'Set reminder'
    }) === 'set_reminder',
    'Mid-quiz "Set reminder" switches the stalled expense flow'
  );
  assert(
    detectFlowSwitch({
      quiz: { flow: 'vehicle_registration', phase: 'question', answers: {} },
      messageText: 'Set reminder'
    }) === null,
    'Registration is never abandoned by a mid-quiz command'
  );
  assert(
    shouldPauseQuizForChat({ messageText: 'No', intent: 'GENERAL_CHAT', quiz: { phase: 'question' } }) === true,
    'Bare "No" mid-question pauses to conversation'
  );
  assert(
    shouldPauseQuizForChat({ messageText: 'No', intent: 'GENERAL_CHAT', quiz: { phase: 'confirm' } }) === false,
    'Bare "No" during confirmation remains engine-owned'
  );

  console.log(`\n🎉 ALL QUIZ ENGINE TESTS PASSED (${passed} assertions).`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
