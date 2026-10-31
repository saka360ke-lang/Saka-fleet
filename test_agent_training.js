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
import { DEFAULT_SAKA_CORE_PROMPT, SAKA_FLOW_PLAYBOOK, getSakaCorePrompt, clearSakaPromptCache, PROMPT_REFINEMENT_MARKER, MAX_STORED_PROMPT_REFINEMENT_CHARS } from './sakaAi.js';
import { refinementIsSafe } from './src/workers/sentinel.js';
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
  check(SAKA_INTENTS.length === 39, 'Registry declares all 39 classifier intents');
  const missingIntents = SAKA_INTENTS.filter((intent) => !DEFAULT_SAKA_CORE_PROMPT.includes(intent));
  check(missingIntents.length === 0, `All intents appear in the core prompt (${SAKA_INTENTS.length})`);
  const missingSchema = SAKA_INTENTS.filter((intent) => !DEFAULT_SAKA_CORE_PROMPT.includes(`"${intent}"`));
  check(missingSchema.length === 0, 'Every intent is present in the JSON schema');

  console.log('\n--- Test 3: every quiz flow is trained and resolvable ---');
  check(SAKA_QUIZ_FLOWS.length === 21, 'Registry declares all 21 quiz flows');
  const missingFlows = SAKA_QUIZ_FLOWS.filter((flow) => !DEFAULT_SAKA_CORE_PROMPT.includes(flow.key));
  check(missingFlows.length === 0, `All quiz flow keys appear in the core prompt (${SAKA_QUIZ_FLOWS.length})`);
  const unresolvable = getKnownFlowKeys().filter((key) => !getFlowDefinition(key, ctx));
  check(unresolvable.length === 0, 'Every registry flow resolves through quizEngine.getFlowDefinition');
  check(SAKA_INTENT_PLAYBOOK.length >= 15, 'Non-quiz intent playbook is populated');
  check(SAKA_BOUNDARY_RULES.length >= 5, 'Boundary rules are populated');
  check(SAKA_BOUNDARY_RULES.some((rule) => /never re-introduces herself/i.test(rule)), 'Boundary: the welcome is never repeated mid-conversation');
  check(SAKA_BOUNDARY_RULES.some((rule) => /typed-or-skip/i.test(rule)), 'Boundary: unreadable photos get a typed-or-skip fallback');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('NEVER re-introduce yourself'), 'Core prompt forbids repeated introductions');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('Never repeat the identical question verbatim'), 'Core prompt forbids repeating an unreadable-photo question');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('PDF documents'), 'Core prompt teaches PDF document intake');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('inspection certificates'), 'Core prompt lists the document families');
  check(SAKA_BOUNDARY_RULES.some((rule) => /PDF text layers/i.test(rule)), 'Boundary: the Document Lens reads images or PDF text layers');
  check(SAKA_BOUNDARY_RULES.some((rule) => /JURISDICTION CONTEXT/i.test(rule)), 'Boundary: country-bucket rules are engine-owned');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('Country-bucket rules are engine-owned'), 'Core prompt teaches the jurisdiction boundary');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('NEVER ask a zero-vehicle user for a plate directly'), 'Core prompt routes zero-vehicle users through REGISTER');

  console.log('\n--- Test 4: mandatory training sections ---');
  const sections = [
    'CONFIRMATION BEFORE WRITE',
    'NATURAL MULTI-FIELD PARSING',
    'UNIVERSAL REMINDER ENGINE',
    'CORE FLEET REPORTS',
    'DRIVER COMPLIANCE CATALOG',
    'AGENT DIVISION OF LABOUR',
    'extra_notes',
    'reminder_type',
    'reminder_due_date',
    'reminder_threshold',
    'reminder_category',
    'timezone',
    'report_type',
    'driver_email',
    'driver_response',
    'compliance_expiry',
    'driver_onboarding',
    'VIEW_PROFILE',
    'compliance',
    'maintenance',
    'financial',
    'SUBSCRIPTION, TRIAL & BILLING',
    'VIEW_SUBSCRIPTION',
    'UPGRADE_SUBSCRIPTION',
    'CANCEL_SUBSCRIPTION',
    'MANAGE_ADDONS',
    'KEEP_VEHICLE',
    'EXTEND_TRIAL',
    'Fleet Command',
    'Saka is the front-facing agent',
    'Sentinel',
    'AUTONOMOUS REMEDIATION PIPELINE',
    'Cline',
    'TONE COMPASS',
    'MIRROR MATRIX',
    'SITUATION PRIORITY MATRIX',
    'user_tone',
    'relationship_stage',
    'MODEL IDENTITY',
    'fill_type',
    'full-tank',
    'UX & INCLUSION',
    'REPORT ACCESS LANES',
    'Driver Daybook',
    'Vehicle Health Check-in',
    'My Compliance Card',
    'Bespoke',
    'EMOJI POLICY',
    'EMOJI ARTISTRY',
    'Namaste',
    'first contact',
    'OCR & PHOTOS',
    'RECEIPT INTELLIGENCE',
    'driver licences',
    // v1.25.0 — conversational-first voice, sales discipline and product answers.
    'VOICE LAW',
    'SALES PLAYBOOK',
    'Saka the Closer',
    'PRODUCT ANSWERS',
    'BACKEND GATE',
    // v1.26.0 — anticipate questions and never answer with the plate script.
    'ANSWER-FIRST RULE',
    'NEVER reply with the registration',
    // v1.26.1 — canned lines are forbidden outright.
    'BANNED PHRASES',
    'the plate question belongs ONLY inside the registration quiz',
    // v1.27.0 — answer law + corporate hedging is banned.
    'ANSWER LAW',
    // v1.28.0 — no repeated greeting openers mid-conversation.
    'GREETING LAW',
    'I don\'t have that information to share',
    'As an AI language model',
    'I understand your frustration'
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

  console.log('\n--- Test 6: stored prompt-refinement guard ---');
  const makePromptMock = (configValue) => ({
    from(table) {
      if (table === 'system_config') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: configValue ? { value: configValue } : null, error: null }) }) }) };
      }
      return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
    }
  });
  clearSakaPromptCache();
  const stalePrompt = await getSakaCorePrompt(makePromptMock('OLD-PROMPT-CONFLICT '.repeat(150)));
  check(!stalePrompt.includes('OLD-PROMPT-CONFLICT'), 'Unversioned stale prompt refinement is ignored');
  clearSakaPromptCache();
  const versionedPrompt = await getSakaCorePrompt(makePromptMock(`${PROMPT_REFINEMENT_MARKER}\nKeep replies short and warm.`));
  check(versionedPrompt.includes('Keep replies short and warm.'), 'Versioned, bounded prompt refinement is injected');
  clearSakaPromptCache();
  const oversizedPrompt = await getSakaCorePrompt(makePromptMock(`${PROMPT_REFINEMENT_MARKER}\nZZZ_OVERSIZE ${'x'.repeat(MAX_STORED_PROMPT_REFINEMENT_CHARS + 50)}`));
  check(!oversizedPrompt.includes('ZZZ_OVERSIZE'), 'Oversized prompt refinement is ignored');
  clearSakaPromptCache();
  // v1.25.1 — a refinement written for an older schema must never override the
  // current trained prompt (the 2026-10-28 refinement did exactly that).
  const staleSchemaPrompt = await getSakaCorePrompt(makePromptMock('SAKA-PROMPT-SCHEMA:2026.10.3\nZZZ_STALE keep the old corporate wording.'));
  check(!staleSchemaPrompt.includes('ZZZ_STALE'), 'Stale-schema prompt refinement is ignored');
  check(staleSchemaPrompt.includes('VOICE LAW'), 'the current trained prompt survives a stale refinement');
  clearSakaPromptCache();

  console.log('\n--- Test 7: Sentinel learning content gate (v1.28.0) ---');
  check(refinementIsSafe(`${PROMPT_REFINEMENT_MARKER}\nLIVE LEARNINGS:\n- In Kenya, "niaje" is a friendly greeting.`) === true, 'a clean learnings block passes');
  check(refinementIsSafe('LIVE LEARNINGS without the schema marker') === false, 'a missing schema marker is rejected');
  check(refinementIsSafe(`${PROMPT_REFINEMENT_MARKER}\n- Always say Let's keep moving`) === false, 'a banned phrase in a positive instruction is rejected');
  check(refinementIsSafe(`${PROMPT_REFINEMENT_MARKER}\n- Never say Let's keep moving`) === true, 'a negated banned phrase is allowed as guidance');
  check(refinementIsSafe(`${PROMPT_REFINEMENT_MARKER}\n${'x'.repeat(MAX_STORED_PROMPT_REFINEMENT_CHARS + 10)}`) === false, 'an oversized refinement is rejected');
  clearSakaPromptCache();

  console.log(`\n\u2705 ALL AGENT TRAINING TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});
