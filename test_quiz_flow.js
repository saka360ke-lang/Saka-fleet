import 'dotenv/config';
import fs from 'node:fs';
import { REMINDER_DUE_DATE_SQL } from './scripts/run_reminder_due_date_migration.js';
import {
  detectQuizStart,
  handleQuizTurn,
  getFlowDefinition,
  getCurrentQuizField,
  shouldPauseQuizForChat,
  detectFlowSwitch,
  isPlateLike,
  looksLikeReportRequest,
  getActiveQuiz,
  markQuizTurn,
  abandonQuiz,
  startQuiz,
  QUIZ_MAX_AGE_MINUTES
} from './src/services/quizEngine.js';
import { getRecentChatHistory, CHAT_HISTORY_MAX_AGE_MINUTES, CHAT_HISTORY_MAX_MESSAGES } from './src/services/chatHistory.js';

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
  assert(keys.includes('vin') && !keys.includes('owner_email') && !keys.includes('otp'), 'Registration includes VIN but never email/OTP (website-only)');
  assert(regFlow.fields.filter((f) => f.group === 'optional').length >= 8, 'Optional spec group is present');

  assert(detectQuizStart({ intent: 'REGISTER_VEHICLE', messageText: 'register', hasVehicleRegistered: false }) === 'vehicle_registration', 'Registration intent starts registration quiz');
  assert(detectQuizStart({ intent: 'GENERAL_CHAT', messageText: 'I have another car', hasVehicleRegistered: true, isRegisterCommand: true }) === 'vehicle_registration', 'an existing owner adding another car starts registration (v1.56.0)');
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

  // v1.53.2 — correction lane: "you captured the plate wrong" clears + re-asks,
  // and "edit: plate KAS628T" sets exactly that field without clobbering others.
  await handleQuizTurn({ session, messageText: 'you captured the plate wrong', ctx });
  assert(session.quiz.answers.plate_number === undefined, 'correction: the wrong plate is cleared, never kept');
  await handleQuizTurn({ session, messageText: 'edit: plate KAS628T', ctx });
  assert(session.quiz.answers.plate_number === 'KAS628T', 'correction: the edited plate is saved');
  assert(session.quiz.answers.asset_kind === 'vehicle', 'correction: the asset kind is never clobbered by an edit');

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

  console.log('\n--- Test 3c: confirmation refuses a phantom plate (v1.28.4) ---');
  const guardSession = {
    quiz: {
      flow: 'vehicle_registration',
      phase: 'confirm',
      startedAt: Date.now(),
      answers: {
        asset_kind: 'vehicle',
        plate_number: '1991 80',
        make_model: 'Toyota Land Cruiser 80 series',
        yom: 1991,
        vin: 'HDJ810007675',
        owner_email: 'tester@example.com',
        otp: true
      },
      extraNotes: []
    }
  };
  const guardTurn = await handleQuizTurn({ session: guardSession, messageText: 'yes', ctx: baseCtx({ vehicles: [] }) });
  assert(guardTurn.handled === true, 'the confirmation turn is handled');
  assert(guardSession.quiz && guardSession.quiz.phase === 'question', 'the quiz returns to the question phase instead of writing');
  assert(guardSession.quiz.answers.plate_number === undefined, 'the phantom plate is removed before any write');
  await handleQuizTurn({ session: guardSession, messageText: 'cancel', ctx: baseCtx({ vehicles: [] }) });

  console.log('\n--- Test 3d: mileage reminder banks from the trigger + saves without a date (v1.28.5) ---');
  const reminderCtx = baseCtx({ vehicles: [vehicle] });
  const reminderSession = {};
  await handleQuizTurn({
    session: reminderSession,
    messageText: 'Log an oil change reminder. To happen @370,000km',
    startFlow: 'set_reminder',
    ctx: reminderCtx
  });
  assert(reminderSession.quiz?.answers?.reminder_type === 'Oil change', 'the reminder type is banked from the trigger sentence');
  assert(reminderSession.quiz?.answers?.due?.kind === 'distance', 'the mileage threshold is banked from the trigger sentence');
  assert(reminderSession.quiz?.answers?.due?.canonicalValue === 370000, 'the threshold target is 370,000 km');
  assert(reminderSession.quiz?.phase === 'confirm', 'the flow reaches confirmation without re-asking');

  const inserted = [];
  const mockSupabase = {
    from(table) {
      return {
        insert: async (rows) => { inserted.push({ table, rows }); return { error: null, data: rows }; },
        update: () => ({ eq: async () => ({ error: null }) }),
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
      };
    }
  };
  const confirmCtx = baseCtx({ vehicles: [vehicle], supabase: mockSupabase });
  const reminderConfirmTurn = await handleQuizTurn({ session: reminderSession, messageText: 'yes', ctx: confirmCtx });
  assert(reminderConfirmTurn.handled === true, 'the confirmation is handled');
  const reminderRow = inserted.find((entry) => entry.table === 'reminders')?.rows?.[0] || null;
  assert(Boolean(reminderRow), 'a reminders row is inserted');
  assert(reminderRow.threshold_unit === 'distance', 'the row is a distance threshold reminder');
  assert(reminderRow.target_value === 370000, 'the row targets 370,000 km');
  assert(!('due_date' in reminderRow), 'a mileage reminder carries no due_date (schema must allow NULL)');
  assert(/ALTER COLUMN due_date DROP NOT NULL/.test(REMINDER_DUE_DATE_SQL), 'the migration relaxes reminders.due_date');
  assert(/ALTER COLUMN due_date DROP NOT NULL/.test(fs.readFileSync('./src/services/vehicles.js', 'utf8')), 'the boot DDL also heals due_date nullability');

  console.log('\n--- Test 3e: report requests never start a logging quiz (v1.28.6) ---');
  assert(looksLikeReportRequest('Give me a fuel report for kas') === true, 'a fuel report request is recognised');
  assert(looksLikeReportRequest('Give me fuel report') === true, 'a bare fuel report request is recognised');
  assert(looksLikeReportRequest('log fuel') === false, 'a logging command is not a report request');
  assert(looksLikeReportRequest('Logged 40L at 50350 km for KES 5500') === false, 'a log line is not a report request');
  // v1.32.4 — live failure 2026-11-01 10:18: a deliverable-shaped request with no
  // word "report" fell through to a generic menu.
  assert(looksLikeReportRequest('Send me as a detailed pdf') === true, '"send me as a detailed pdf" is a report request');
  assert(looksLikeReportRequest('email me the full pdf') === true, '"email me the full pdf" is a report request');
  assert(looksLikeReportRequest('prepare a document for the bank') === true, '"prepare a document" is a report request');
  assert(looksLikeReportRequest('I bought a PDF manual for 2000') === false, 'a purchase mention is not a report request');
  assert(looksLikeReportRequest('log 2000 for the document renewal') === false, 'a logging command with "document" stays a log');
  assert(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'Give me a fuel report for kas', hasVehicleRegistered: true }) === null,
    'the live "fuel report" message never starts the expense quiz'
  );
  assert(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'Give me fuel report', hasVehicleRegistered: true }) === null,
    'a bare "fuel report" message never starts the expense quiz'
  );
  assert(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'log fuel', hasVehicleRegistered: true }) === 'log_expense',
    'a real logging command still starts the expense quiz'
  );

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

  console.log('\n--- Test 4d: a voice-note transcript answers an active quiz (v1.79.0) ---');
  const voiceCtx = baseCtx({ vehicles: [vehicle] });
  const voiceSession = {};
  await handleQuizTurn({ session: voiceSession, messageText: 'log fuel', startFlow: 'log_expense', ctx: voiceCtx });
  // Phase 18 injects the Speech-to-Text transcript at the typed-text seam, so an
  // active quiz must parse it exactly like a typed answer (no special lane).
  const voiceTurn = await handleQuizTurn({
    session: voiceSession,
    messageText: '5500 for 40 litres at 366900 km, full tank',
    ctx: voiceCtx
  });
  assert(voiceTurn.handled === true, 'a transcribed voice note is handled by the active quiz');
  assert(
    voiceSession.quiz.answers.amount === 5500
      && voiceSession.quiz.answers.fuel_liters === 40
      && voiceSession.quiz.answers.odometer_reading === 366900
      && voiceSession.quiz.answers.fill_type === 'Full tank',
    'spoken values land through the same parsers as typed answers'
  );
  await handleQuizTurn({ session: voiceSession, messageText: 'skip', ctx: voiceCtx });
  assert(voiceSession.quiz.phase === 'confirm', 'the voice answer reaches the confirmation gate without a second ask');
  await handleQuizTurn({ session: voiceSession, messageText: 'cancel', ctx: voiceCtx });

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

  console.log('\n--- Quiz staleness, parking & history freshness (v1.32.3) ---');
  const freshSession = {
    quiz: { flow: 'log_expense', phase: 'question', answers: {}, startedAt: Date.now() }
  };
  assert(getActiveQuiz(freshSession)?.flow === 'log_expense', 'A live quiz is returned by getActiveQuiz');
  markQuizTurn(freshSession);
  assert(Boolean(freshSession.quiz.lastTurnAt), 'markQuizTurn stamps the inactivity clock');

  const idleSession = {
    quiz: { flow: 'log_expense', phase: 'question', answers: {}, startedAt: Date.now() - 90 * 60 * 1000 }
  };
  assert(getActiveQuiz(idleSession) === null, 'A 90-minute idle quiz is expired');
  assert(idleSession.quiz === null, 'An expired quiz is cleared from the session');

  const touchedSession = {
    quiz: { flow: 'log_expense', phase: 'question', answers: {}, startedAt: Date.now() - 90 * 60 * 1000, lastTurnAt: new Date().toISOString() }
  };
  assert(getActiveQuiz(touchedSession)?.flow === 'log_expense', 'A recently answered quiz survives its old startedAt');
  assert(QUIZ_MAX_AGE_MINUTES >= 5 && QUIZ_MAX_AGE_MINUTES <= 240, 'QUIZ_MAX_AGE_MINUTES is clamped to a sane window');

  const parkedSession = {
    quiz: { flow: 'vehicle_registration', phase: 'question', answers: { plate_number: 'KAS 628T' }, startedAt: Date.now() }
  };
  const parked = abandonQuiz(parkedSession, { reason: 'deterministic_read_command' });
  assert(parked?.flow === 'vehicle_registration', 'abandonQuiz returns the parked draft');
  assert(parkedSession.quiz === null, 'A parked draft no longer owns the conversation');
  assert(parkedSession.lastAbandonedQuiz?.reason === 'deterministic_read_command', 'The parking reason is remembered for telemetry');

  // Chat history freshness: stale rows must never reach the model prompt.
  const now = Date.now();
  const historyRows = [
    { role: 'user', message: 'old question', created_at: new Date(now - 103 * 60 * 1000).toISOString() },
    { role: 'model', message: 'old answer', created_at: new Date(now - 100 * 60 * 1000).toISOString() },
    { role: 'user', message: 'fresh question', created_at: new Date(now - 2 * 60 * 1000).toISOString() }
  ];
  const historyMock = {
    cutoff: null,
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    gte(column, value) { this.cutoff = Date.parse(value); return this; },
    order() { return this; },
    limit() {
      const rows = historyRows.filter((row) => !this.cutoff || Date.parse(row.created_at) >= this.cutoff);
      return Promise.resolve({ data: [...rows].reverse(), error: null });
    }
  };
  const history = await getRecentChatHistory(historyMock, '+254700000001', 10);
  assert(
    history.length === 1 && history[0].parts?.[0]?.text === 'fresh question',
    'Stale history (>45 min) is dropped from the prompt window'
  );
  historyMock.cutoff = null;
  const wideHistory = await getRecentChatHistory(historyMock, '+254700000001', 10, { maxAgeMinutes: 0 });
  assert(wideHistory.length === 3, 'maxAgeMinutes: 0 disables the window (full history is returned)');
  assert(CHAT_HISTORY_MAX_AGE_MINUTES === 45, 'CHAT_HISTORY_MAX_AGE_MINUTES defaults to 45 minutes');
  assert(CHAT_HISTORY_MAX_MESSAGES === 40, 'CHAT_HISTORY_MAX_MESSAGES defaults to 40 messages');

  console.log('\n--- Test 10: narrative draft cards (v1.35.0) ---');
  const narrativeFields = {
    expense_type: 'Fuel',
    amount: 5500,
    fuel_liters: 40,
    fill_type: 'Full tank',
    odometer_reading: 50350
  };
  const narrativeExtras = {
    occurred_at: '2026-10-31',
    occurred_at_iso: '2026-10-31T12:00:00+03:00',
    occurred_at_label: '31 Oct 2026 (yesterday)',
    vendor: 'Shell',
    kind: 'expense'
  };
  const cardCtx = baseCtx({ vehicles: [vehicle] });
  const cardSession = {};
  const cardStart = await handleQuizTurn({
    session: cardSession,
    messageText: 'spent 5500 on diesel yesterday at Shell, 40L at 50350km, full tank',
    startFlow: 'log_expense',
    aiExtracted: { ...narrativeFields, _narrative: narrativeExtras },
    ctx: cardCtx
  });
  assert(cardStart.handled === true, 'the narrative turn is handled');
  assert(cardSession.quiz?.phase === 'confirm', 'a complete narrative draft reaches confirmation immediately');
  assert(Boolean(cardSession.quiz?.narrativeCard), 'the quiz stores the draft card');
  assert(/Got it — check this before I save it/.test(String(cardStart.reply)), 'the card headline renders');
  assert(/Ksh/.test(String(cardStart.reply)), 'the card shows the localized amount');
  assert(/31 Oct 2026/.test(String(cardStart.reply)), 'the card shows the stated past date');
  assert(/Shell/.test(String(cardStart.reply)), 'the card shows the vendor');
  assert(/1 ✅ Save it/.test(String(cardStart.reply)) && /3 ❌ Cancel/.test(String(cardStart.reply)), 'the quick actions render');

  // Quick action 2: ask which field, then a correction updates the card.
  const changeTurn = await handleQuizTurn({ session: cardSession, messageText: '2', ctx: cardCtx });
  assert(changeTurn.handled === true && /Which field should I change/.test(String(changeTurn.reply)), 'action 2 asks which field to change');
  const correctionTurn = await handleQuizTurn({
    session: cardSession,
    messageText: 'amount 4800',
    aiExtracted: { amount: 4800 },
    ctx: cardCtx
  });
  assert(cardSession.quiz.answers.amount === 4800, 'the correction updates the answer');
  assert(/Updated: Amount spent/.test(String(correctionTurn.reply)) && /4,800|Ksh/.test(String(correctionTurn.reply)), 'the card re-renders with the corrected amount');
  assert(cardSession.quiz.phase === 'confirm', 'the card path stays at confirmation');

  // v1.58.23 - explicit "field: value" lines update the card in place (live
  // 2026-11-04: "Type: Part (AC idler…)" / "Extra notes: …" looped).
  const notesTurn = await handleQuizTurn({ session: cardSession, messageText: 'Extra notes: AC idler pulley mounting bracket', ctx: cardCtx });
  assert(String(cardSession.quiz.answers.notes || '').includes('AC idler pulley mounting bracket'), 'an "Extra notes: …" line lands on the draft');
  assert(/Updated: Note or part name/.test(String(notesTurn.reply)), 'the card acknowledges the note update');
  const typeTurn = await handleQuizTurn({ session: cardSession, messageText: 'Type: Part (AC idler pulley mounting bracket)', ctx: cardCtx });
  assert(cardSession.quiz.answers.expense_type === 'Parts', 'a "Type:" line canonicalises through the expense catalog');
  assert(/Updated: Expense type/.test(String(typeTurn.reply)), 'the card acknowledges the type update');

  // Quick action 3: cancel, nothing written.
  const cancelSession = {};
  await handleQuizTurn({
    session: cancelSession,
    messageText: 'fuel 3000',
    startFlow: 'log_expense',
    aiExtracted: { expense_type: 'Fuel', amount: 3000, odometer_reading: 360100, _narrative: { kind: 'expense' } },
    ctx: cardCtx
  });
  const cardCancelTurn = await handleQuizTurn({ session: cancelSession, messageText: '3', ctx: cardCtx });
  assert(cardCancelTurn.cancelled === true, 'action 3 cancels the draft card');

  // Quick action 1: save writes the row (with the retro date in created_at).
  const cardInserted = [];
  const cardMockSupabase = {
    from(table) {
      const builder = {
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        gt: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        select: () => builder,
        update: () => builder,
        delete: () => builder,
        insert: async (rows) => { cardInserted.push({ table, rows }); return { error: null, data: rows }; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null })
      };
      return builder;
    }
  };
  const saveSession = {};
  await handleQuizTurn({
    session: saveSession,
    messageText: 'spent 5500 on diesel yesterday',
    startFlow: 'log_expense',
    aiExtracted: { expense_type: 'Fuel', amount: 5500, odometer_reading: 360100, _narrative: { occurred_at: '2026-10-31', occurred_at_iso: '2026-10-31T12:00:00+03:00', kind: 'expense' } },
    ctx: { ...cardCtx, supabase: cardMockSupabase }
  });
  const saveTurn = await handleQuizTurn({ session: saveSession, messageText: '1', ctx: { ...cardCtx, supabase: cardMockSupabase } });
  assert(saveTurn.completed === true, 'action 1 saves the draft');
  const expenseRow = cardInserted.find((entry) => entry.table === 'expense_logs')?.rows?.[0] || null;
  assert(Boolean(expenseRow), 'a narrative-saved expense row is written');
  assert(String(expenseRow.created_at || '').startsWith('2026-10-31'), 'the retro date lands in created_at (1-save path)');
  // v1.81.0 — no receipt context means an explicit null link, never a guess.
  assert(expenseRow.receipt_id === null, 'an expense without a receipt writes receipt_id = null');
  // v1.72.0 (P2-3) — the legacy mirror still writes by default.
  assert(cardInserted.some((entry) => entry.table === 'expenses'), 'the legacy expenses mirror is written while the flag is on (default)');

  // v1.81.0 (Phase 20, PROP-2026-11-08-01) — the durable receipt link rides the
  // engine-only prefill seam. It is verified against the receipts table before
  // it is written; a missing/foreign id never links and never blocks the save.
  const RECEIPT_ID = '22222222-2222-2222-2222-222222222222';
  const receiptQuizCtx = (receiptRow) => {
    const inserted = [];
    const supabase = {
      from(table) {
        const builder = {
          eq: () => builder, gte: () => builder, lte: () => builder, gt: () => builder,
          in: () => builder, order: () => builder, limit: () => builder,
          select: () => builder, update: () => builder, delete: () => builder,
          insert: async (rows) => { inserted.push({ table, rows }); return { error: null, data: rows }; },
          maybeSingle: async () => (table === 'receipts' ? { data: receiptRow, error: null } : { data: null, error: null }),
          single: async () => ({ data: null, error: null })
        };
        return builder;
      }
    };
    return { ctx: { ...cardCtx, supabase }, inserted };
  };
  const receiptExtracted = { expense_type: 'Fuel', amount: 5500, fuel_liters: 40, fill_type: 'full', odometer_reading: 360100, notes: 'Shell Karen' };
  const linked = receiptQuizCtx({ id: RECEIPT_ID, owner_id: vehicle.owner_id, driver_id: null, vehicle_id: 'another-vehicle' });
  const linkedSession = {};
  await handleQuizTurn({ session: linkedSession, messageText: 'Receipt photo', aiExtracted: receiptExtracted, startFlow: 'log_expense', prefill: { receipt_id: RECEIPT_ID }, ctx: linked.ctx });
  const linkedSave = await handleQuizTurn({ session: linkedSession, messageText: 'yes', ctx: linked.ctx });
  assert(linkedSave.completed === true, 'a receipt-prefilled draft confirms');
  const linkedRow = linked.inserted.find((entry) => entry.table === 'expense_logs')?.rows?.[0] || null;
  assert(linkedRow?.receipt_id === RECEIPT_ID, 'the vaulted receipt id lands in expense_logs.receipt_id (owner-verified)');

  const foreign = receiptQuizCtx({ id: RECEIPT_ID, owner_id: 'someone-else', driver_id: null, vehicle_id: 'v-foreign' });
  const foreignSession = {};
  await handleQuizTurn({ session: foreignSession, messageText: 'Receipt photo', aiExtracted: receiptExtracted, startFlow: 'log_expense', prefill: { receipt_id: RECEIPT_ID }, ctx: foreign.ctx });
  await handleQuizTurn({ session: foreignSession, messageText: 'yes', ctx: foreign.ctx });
  const foreignRow = foreign.inserted.find((entry) => entry.table === 'expense_logs')?.rows?.[0] || null;
  assert(foreignRow && foreignRow.receipt_id === null, "another profile's receipt never links (sibling sweep class i)");

  const receiptRestartSession = {};
  await handleQuizTurn({ session: receiptRestartSession, messageText: 'Receipt photo', aiExtracted: receiptExtracted, startFlow: 'log_expense', prefill: { receipt_id: RECEIPT_ID }, ctx: linked.ctx });
  await handleQuizTurn({ session: receiptRestartSession, messageText: 'restart', ctx: linked.ctx });
  assert(receiptRestartSession.quiz && receiptRestartSession.quiz.answers.receipt_id === undefined, 'a restart drops the stale link (a fresh draft never reuses it)');

  // v1.72.0 (P2-3) — LEGACY_EXPENSES_WRITE_ENABLED=false stops the mirror and
  // never blocks the canonical expense_logs write.
  const flagOffInserted = [];
  const flagOffMockSupabase = {
    from(table) {
      const builder = {
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        gt: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        select: () => builder,
        update: () => builder,
        delete: () => builder,
        insert: async (rows) => { flagOffInserted.push({ table, rows }); return { error: null, data: rows }; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null })
      };
      return builder;
    }
  };
  const previousLegacyFlag = process.env.LEGACY_EXPENSES_WRITE_ENABLED;
  process.env.LEGACY_EXPENSES_WRITE_ENABLED = 'false';
  try {
    const offSession = {};
    await handleQuizTurn({
      session: offSession,
      messageText: 'spent 3000 on fuel today',
      startFlow: 'log_expense',
      aiExtracted: { expense_type: 'Fuel', amount: 3000, odometer_reading: 360200, _narrative: { kind: 'expense' } },
      ctx: { ...cardCtx, supabase: flagOffMockSupabase }
    });
    const offTurn = await handleQuizTurn({ session: offSession, messageText: '1', ctx: { ...cardCtx, supabase: flagOffMockSupabase } });
    assert(offTurn.completed === true, 'the flag-off save still completes');
    assert(flagOffInserted.some((entry) => entry.table === 'expense_logs'), 'the canonical expense_logs row is still written with the flag off');
    assert(!flagOffInserted.some((entry) => entry.table === 'expenses'), 'P2-3: no INSERT into expenses when LEGACY_EXPENSES_WRITE_ENABLED=false');
  } finally {
    if (previousLegacyFlag !== undefined) process.env.LEGACY_EXPENSES_WRITE_ENABLED = previousLegacyFlag;
    else delete process.env.LEGACY_EXPENSES_WRITE_ENABLED;
  }

  console.log('--- Test 11: engine-owned patience ladder (v1.54.4) ---');
  const originalKeys = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  process.env.DEEPSEEK_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  try {
    const ladderSession = {};
    const ladderCtx = baseCtx({ vehicles: [vehicle], activeVehicle: vehicle });
    assert(startQuiz({ session: ladderSession, flowKey: 'log_expense', ctx: ladderCtx }), 'ladder quiz starts with the single vehicle pre-selected');
    const ladderFuel = await handleQuizTurn({ session: ladderSession, messageText: 'fuel', ctx: ladderCtx });
    assert(ladderFuel.handled && !/not understood/i.test(ladderFuel.reply || ''), 'the first valid answer advances the quiz');
    const ladderFirst = await handleQuizTurn({ session: ladderSession, messageText: 'zzzz', ctx: ladderCtx });
    assert(/That answer was not understood/.test(ladderFirst.reply || ''), 'an invalid amount re-asks with the not-understood note');
    assert(ladderSession.quiz.patience?.field === 'amount' && ladderSession.quiz.patience.retries === 1, 'the first failure is recorded against the pending field');
    const ladderSecond = await handleQuizTurn({ session: ladderSession, messageText: 'zzzz', ctx: ladderCtx });
    assert(/Easiest way/.test(ladderSecond.reply || '') && /just type the number/.test(ladderSecond.reply || ''), 'the second failure offers the simplest typed path');
    assert(ladderSession.quiz.patience?.retries === 2, 'the second failure climbs the ladder');
    const ladderThird = await handleQuizTurn({ session: ladderSession, messageText: 'zzzz', ctx: ladderCtx });
    assert(/Support/.test(ladderThird.reply || ''), 'the third failure offers the human lane');
    assert(ladderSession.quiz.patience?.retries === 3, 'the third failure keeps climbing without blame');
    const ladderAdvance = await handleQuizTurn({ session: ladderSession, messageText: '5000', ctx: ladderCtx });
    assert(ladderAdvance.handled === true, 'a valid answer advances the quiz');
    assert(!ladderSession.quiz.patience || ladderSession.quiz.patience.field !== 'amount', 'progress resets the patience ladder');
  } finally {
    if (originalKeys.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = originalKeys.DEEPSEEK_API_KEY;
    else delete process.env.DEEPSEEK_API_KEY;
    if (originalKeys.ANTHROPIC_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = originalKeys.ANTHROPIC_API_KEY;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalKeys.OPENAI_API_KEY !== undefined) process.env.OPENAI_API_KEY = originalKeys.OPENAI_API_KEY;
    else delete process.env.OPENAI_API_KEY;
  }

  console.log(`\n🎉 ALL QUIZ ENGINE TESTS PASSED (${passed} assertions).`);
}

// v1.63.1 (2C) — six completion-path invalidation spies (stateless).
console.log('\n--- v1.63.1: quiz completion invalidation spies ---');
{
  const makeQuizMock = () => {
    const deletes = [];
    const builder = (table) => {
      const api = {
        select: () => api,
        eq: () => api,
        neq: () => api,
        in: () => api,
        is: () => api,
        gte: () => api,
        lte: () => api,
        lt: () => api,
        gt: () => api,
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
          const chain = {
            eq: () => chain,
            in: () => chain,
            is: () => chain,
            select: () => chain,
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({ data: null, error: null }),
            then: (a, b) => Promise.resolve({ data: null, error: null }).then(a, b)
          };
          return chain;
        },
        delete: () => ({
          eq: (col, value) => { deletes.push({ table, col, value }); return Promise.resolve({ error: null }); },
          in: () => Promise.resolve({ error: null })
        }),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (a, b) => Promise.resolve({ data: [], error: null }).then(a, b)
      };
      return api;
    };
    return { client: { from: builder }, deletes };
  };
  const runCompletion = async (flow, answers) => {
    const mock = makeQuizMock();
    const session = { quiz: { flow, phase: 'confirm', startedAt: Date.now(), answers: { vehicle_id: vehicle.id, ...answers }, extraNotes: [] } };
    await handleQuizTurn({ session, messageText: 'yes', ctx: baseCtx({ vehicles: [vehicle], supabase: mock.client }) });
    return mock.deletes.some((d) => d.table === 'user_context_cache' && d.col === 'phone_number' && d.value === '+254700000001');
  };
  assert(await runCompletion('log_earnings', { amount: 5000, odometer_reading: 360000, earning_type: 'Fare' }), 'log_earnings invalidates the cached facts (v1.63.1)');
  assert(await runCompletion('log_mileage', { odometer_reading: 360500 }), 'log_mileage invalidates the cached facts (v1.63.1)');
  assert(await runCompletion('log_operating_hours', { hours: 1250 }), 'log_operating_hours invalidates the cached facts (v1.63.1)');
  assert(await runCompletion('edit_profile', { profile_field: 'Full name', new_value: 'Test Owner' }), 'edit_profile invalidates the cached facts (v1.63.1)');
  const quizEngineSource = fs.readFileSync('./src/services/quizEngine.js', 'utf8');
  assert(quizEngineSource.includes("reason: 'quizEngine.deleteAccount'") && quizEngineSource.includes("markUserDataChanged({ supabase: ctx.supabase, phone: ctx.senderPhone"), 'delete_account invalidates the cached facts (source-pinned: the MFA gate blocks stateless completion, v1.63.1)');
  assert(await runCompletion('email_update', { new_email: 'new@example.com' }), 'email_update invalidates the cached facts (v1.63.1)');
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
