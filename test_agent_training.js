/**
 * Saka Fleet - Agent Training & Flow Knowledge Test Suite (stateless)
 * -------------------------------------------------------------------
 * Guards the permanent governance rule: every intent and quiz flow must be
 * embedded in Saka's core prompt, the registry must resolve through the quiz
 * engine, and the training sections (confirmation gate, reminder engine,
 * extra notes, Saka/Sentinel boundary) must never be dropped.
 *
 * Run: node test_agent_training.js
 * Stateless: no database rows are created (cleanup not required).
 */

import assert from 'assert';
import { DEFAULT_SAKA_CORE_PROMPT, SAKA_FLOW_PLAYBOOK } from './sakaAi.js';
import {
  SAKA_INTENTS,
  SAKA_QUIZ_FLOWS,
  SAKA_INTENT_PLAYBOOK,
  SAKA_BOUNDARY_RULES,
  buildFlowPlaybook,
  getKnownFlowKeys
} from './src/services/flowKnowledge.js';
import { getFlowDefinition, startQuiz } from './src/services/quizEngine.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`\u2705 ${message}`);
}

const ctx = {
  countryInfo: { country: 'Kenya', country_code: 'KE', default_units: 'metric', currency: 'KES', locale: 'en-KE' },
  profile: { id: 'p1', unit_system: 'metric', preferred_language: 'English' },
  language: 'English',
  vehicles: [
    { id: 'v-1', plate_number: 'KDA 777A', make_model: 'Toyota Land Cruiser' },
    { id: 'v-2', plate_number: 'KBC 888B', make_model: 'Mazda Demio' }
  ],
  aiExtracted: {},
  messageText: ''
};

async function run() {
  console.log('=== SAKA AGENT TRAINING & FLOW KNOWLEDGE TESTS ===\n');

  console.log('--- Test 1: single-source flow playbook injection ---');
  check(SAKA_FLOW_PLAYBOOK === buildFlowPlaybook(), 'Core prompt uses the generated flow playbook verbatim');
  check(DEFAULT_SAKA_CORE_PROMPT.includes(SAKA_FLOW_PLAYBOOK), 'Full flow playbook is embedded in the core prompt');

  console.log('\n--- Test 2: every intent is trained ---');
  check(SAKA_INTENTS.length === 32, 'Registry declares all 32 classifier intents');
  const missingIntents = SAKA_INTENTS.filter((intent) => !DEFAULT_SAKA_CORE_PROMPT.includes(intent));
  check(missingIntents.length === 0, `All intents appear in the core prompt (${SAKA_INTENTS.length})`);
  const missingSchema = SAKA_INTENTS.filter((intent) => !DEFAULT_SAKA_CORE_PROMPT.includes(`"${intent}"`));
  check(missingSchema.length === 0, 'Every intent is present in the JSON schema');

  console.log('\n--- Test 3: every quiz flow is trained and resolvable ---');
  check(SAKA_QUIZ_FLOWS.length === 17, 'Registry declares all 17 quiz flows');
  const missingFlows = SAKA_QUIZ_FLOWS.filter((flow) => !DEFAULT_SAKA_CORE_PROMPT.includes(flow.key));
  check(missingFlows.length === 0, `All quiz flow keys appear in the core prompt (${SAKA_QUIZ_FLOWS.length})`);
  const unresolvable = getKnownFlowKeys().filter((key) => !getFlowDefinition(key, ctx));
  check(unresolvable.length === 0, 'Every registry flow resolves through quizEngine.getFlowDefinition');
  check(SAKA_INTENT_PLAYBOOK.length >= 15, 'Non-quiz intent playbook is populated');
  check(SAKA_BOUNDARY_RULES.length >= 5, 'Boundary rules are populated');

  console.log('\n--- Test 4: mandatory training sections ---');
  const sections = [
    'CONFIRMATION BEFORE WRITE',
    'NATURAL MULTI-FIELD PARSING',
    'UNIVERSAL REMINDER ENGINE',
    'CORE FLEET REPORTS',
    'AGENT DIVISION OF LABOUR',
    'extra_notes',
    'reminder_type',
    'reminder_due_date',
    'reminder_threshold',
    'reminder_category',
    'timezone',
    'report_type',
    'compliance',
    'maintenance',
    'financial',
    'Saka is the front-facing agent',
    'Sentinel'
  ];
  for (const token of sections) {
    check(DEFAULT_SAKA_CORE_PROMPT.includes(token), `Core prompt retains training section: ${token}`);
  }

  console.log('\n--- Test 5: active-vehicle prefill (agent precision) ---');
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  try {
    const sessionActive = {};
    startQuiz({ session: sessionActive, flowKey: 'log_expense', ctx: { ...ctx, activeVehicle: { id: 'v-2' } } });
    check(sessionActive.quiz?.answers?.vehicle_id === 'v-2', 'Active vehicle pre-fills the vehicle field (no re-asking)');

    const sessionAmbiguous = {};
    startQuiz({ session: sessionAmbiguous, flowKey: 'log_expense', ctx: { ...ctx, activeVehicle: null } });
    check(sessionAmbiguous.quiz?.answers?.vehicle_id === undefined, 'Multiple vehicles without active context still prompt for a vehicle');

    const sessionSingle = {};
    startQuiz({ session: sessionSingle, flowKey: 'log_expense', ctx: { ...ctx, vehicles: [ctx.vehicles[0]], activeVehicle: null } });
    check(sessionSingle.quiz?.answers?.vehicle_id === 'v-1', 'Single-vehicle fleets keep the auto-select fast path');

    const sessionForeign = {};
    startQuiz({ session: sessionForeign, flowKey: 'log_expense', ctx: { ...ctx, activeVehicle: { id: 'v-missing' } } });
    check(sessionForeign.quiz?.answers?.vehicle_id === undefined, 'An out-of-fleet active vehicle never leaks into the draft');
  } finally {
    if (originalKey !== undefined) process.env.DEEPSEEK_API_KEY = originalKey;
    else delete process.env.DEEPSEEK_API_KEY;
  }

  console.log(`\n\u2705 ALL AGENT TRAINING TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});
