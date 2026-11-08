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
import { DEFAULT_SAKA_CORE_PROMPT, SAKA_FLOW_PLAYBOOK, SAKA_OPERATIONS_PROMPT_BLOCK, SAKA_METRIC_GLOSSARY, getSakaCorePrompt, clearSakaPromptCache, PROMPT_REFINEMENT_MARKER, MAX_STORED_PROMPT_REFINEMENT_CHARS } from './sakaAi.js';
import { refinementIsSafe } from './src/workers/sentinel.js';
import {
  SAKA_INTENTS,
  SAKA_QUIZ_FLOWS,
  SAKA_INTENT_PLAYBOOK,
  SAKA_BOUNDARY_RULES,
  SAKA_TONE_COMPASS,
  buildFlowPlaybook,
  getKnownFlowKeys
} from './src/services/flowKnowledge.js';
import { getFlowDefinition, startQuiz } from './src/services/quizEngine.js';
import { isContentlessReply } from './src/services/conversationEngine.js';

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
  check(DEFAULT_SAKA_CORE_PROMPT.includes(SAKA_OPERATIONS_PROMPT_BLOCK), 'Capability registry is embedded in the core prompt (v1.28.7)');
  check(/VIN passbook/.test(DEFAULT_SAKA_CORE_PROMPT) && /Drivers & compliance/.test(DEFAULT_SAKA_CORE_PROMPT), 'Core prompt lists the full owner operations');
  check(/on-demand help menu/i.test(DEFAULT_SAKA_CORE_PROMPT), 'Core prompt knows the operations list is available on demand');
  check(DEFAULT_SAKA_CORE_PROMPT.includes(SAKA_METRIC_GLOSSARY), 'Asset metric glossary is embedded in the core prompt (v1.28.9)');
  check(/primary meter = hours/.test(DEFAULT_SAKA_CORE_PROMPT) && /km\/kWh/.test(DEFAULT_SAKA_CORE_PROMPT), 'Core prompt teaches hours-led and electric metrics');

  console.log('\n--- Test 2: every intent is trained ---');
  check(SAKA_INTENTS.length === 42, 'Registry declares all 42 classifier intents');
  const missingIntents = SAKA_INTENTS.filter((intent) => !DEFAULT_SAKA_CORE_PROMPT.includes(intent));
  check(missingIntents.length === 0, `All intents appear in the core prompt (${SAKA_INTENTS.length})`);
  const missingSchema = SAKA_INTENTS.filter((intent) => !DEFAULT_SAKA_CORE_PROMPT.includes(`"${intent}"`));
  check(missingSchema.length === 0, 'Every intent is present in the JSON schema');
  check(SAKA_INTENTS.includes('EDIT_ENTRY') && SAKA_INTENTS.includes('DELETE_ENTRY'), 'v1.33.0 editable-ledger intents are registered');
check(SAKA_INTENTS.includes('QUERY_RECORDS'), 'v1.36.0 record-answers intent is registered');
check(DEFAULT_SAKA_CORE_PROMPT.includes('QUERY RECORDS (v1.36.0'), 'Core prompt teaches the record-answers lane');
check(SAKA_INTENT_PLAYBOOK.some((row) => row.intent === 'QUERY_RECORDS' && /recordAnswers/.test(row.behavior)), 'Record-answers playbook names the deterministic engine');
  check(SAKA_INTENT_PLAYBOOK.some((row) => row.intent === 'EDIT_ENTRY' && /whitelisted fields/i.test(row.behavior)), 'Edit intent playbook names the editable whitelist');
  check(SAKA_INTENT_PLAYBOOK.some((row) => row.intent === 'DELETE_ENTRY' && /30-minute "restore"/.test(row.behavior)), 'Delete intent playbook names the restore window');
check(/LAUNCH AWARD \(v1\.58\.26\)/.test(DEFAULT_SAKA_CORE_PROMPT), 'Core prompt teaches the launch award (engine-confirmed only)');
check(/LAUNCH AWARD \(v1\.58\.26\)/.test(SAKA_FLOW_PLAYBOOK), 'Flow playbook teaches the launch award (engine-confirmed only)');
check(/DRIVER DOCUMENT READS \(v1\.61\.2\)/.test(SAKA_FLOW_PLAYBOOK), 'Flow playbook teaches the driver-document read lane (never the expense ledger)');
check(/DRIVER DOCUMENT READS \(v1\.61\.2\)/.test(DEFAULT_SAKA_CORE_PROMPT), 'Core prompt teaches the driver-document read lane');
check(DEFAULT_SAKA_CORE_PROMPT.includes('driver_compliances'), 'Core prompt names the driver compliance ledger');
  check(SAKA_BOUNDARY_RULES.some((rule) => /LEDGER_ENTRY_DELETED/.test(rule)), 'Boundary: every ledger edit/delete is audited');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('EDITABLE LEDGER (v1.33.0'), 'Core prompt teaches the editable ledger');
// v1.73.0 (Phase 10) — pagination, my-ticket status and the weekly-report toggle.
check(DEFAULT_SAKA_CORE_PROMPT.includes('DETERMINISTIC COMMANDS (v1.73.0'), 'Core prompt teaches the v1.73.0 deterministic commands');
check(DEFAULT_SAKA_CORE_PROMPT.includes('"my ticket"') && DEFAULT_SAKA_CORE_PROMPT.includes('Read-only'), 'Core prompt teaches the own-ticket status read (read-only)');
check(DEFAULT_SAKA_CORE_PROMPT.includes('"weekly report on"') && DEFAULT_SAKA_CORE_PROMPT.includes('never uses the report quota'), 'Core prompt teaches the weekly-report toggle (no quota)');
check(DEFAULT_SAKA_CORE_PROMPT.includes('Pagination (v1.73.0)') && DEFAULT_SAKA_CORE_PROMPT.includes('VIEW-ONLY'), 'Core prompt teaches view-only pagination');
const editEntryBehavior = SAKA_INTENT_PLAYBOOK.find((row) => row.intent === 'EDIT_ENTRY');
check(Boolean(editEntryBehavior) && editEntryBehavior.behavior.includes('v1.73.0 pagination'), 'EDIT_ENTRY playbook documents pagination');
const reportBehavior = SAKA_INTENT_PLAYBOOK.find((row) => row.intent === 'REQUEST_REPORT');
check(Boolean(reportBehavior) && reportBehavior.behavior.includes('weekly report on|off'), 'REQUEST_REPORT playbook documents the weekly toggle');
const supportFlow = SAKA_QUIZ_FLOWS.find((flow) => flow.key === 'contact_support');
check(Boolean(supportFlow) && supportFlow.rules.includes('my ticket'), 'contact_support flow documents the own-ticket read');
check(DEFAULT_SAKA_CORE_PROMPT.includes('NARRATIVE INTAKE (v1.34.0'), 'Core prompt teaches narrative intake');
check(DEFAULT_SAKA_CORE_PROMPT.includes('1 Save / 2 Change / 3 Cancel'), 'Core prompt teaches the draft-card quick actions');
// v1.58.25 — any owner or driver can add a document at any time (rule 51 sibling lane).
check(DEFAULT_SAKA_CORE_PROMPT.includes('COMPLIANCE CAPTURE (v1.58.25'), 'Core prompt teaches the compliance capture lane');
const captureFlow = SAKA_QUIZ_FLOWS.find((flow) => flow.key === 'driver_onboarding');
check(Boolean(captureFlow && /add\/refresh ANY compliance document/.test(captureFlow.rules)), 'driver_onboarding knowledge carries the any-time capture rules');
const permitFlow = SAKA_QUIZ_FLOWS.find((flow) => flow.key === 'vehicle_registration');
check(Boolean(permitFlow && /vehicle permits .*captured at any time/.test(permitFlow.rules)), 'vehicle_registration carries the sibling vehicle-permit capture rule');
const narrativeFlow = SAKA_QUIZ_FLOWS.find((flow) => flow.key === 'log_expense');
check(Boolean(narrativeFlow && /narrative intake/.test(narrativeFlow.rules)), 'log_expense flow knowledge carries the narrative intake rules');
check(/Narrative pre-fills are engine-determined facts/.test(await import('./src/services/conversationEngine.js').then((m) => m.QUIZ_INSTRUCTION_NATURAL)), 'Quiz composer honours narrative pre-fills');

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
    // v1.59.0 — PERSONA V4: brand compass, ack variety and pacing are trained.
    'PERSONA V4',
    'ACK VARIETY LAW',
    'PACING LAW',
    'LIVE LEARNINGS',
    // v1.28.0 — no repeated greeting openers mid-conversation.
    'GREETING LAW',
    // v1.28.2 — the retired corporate identity is banned and truncation is guarded.
    'IDENTITY LAW',
    'an intelligent WhatsApp vehicle & asset management assistant',
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
        // v1.72.1 (P2-6) — the dual-window service reads with ONE atomic
        // `.in('key', [namespaced, legacy])` query; answer for every asked key.
        return {
          select: () => ({
            in: (column, keys) => ({
              limit: async () => ({
                data: configValue ? keys.map((key) => ({ key, value: configValue })) : [],
                error: null
              })
            })
          })
        };
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

  console.log('\n--- Test 8: live-chat friction rules (v1.32.4) ---');
  // These are the 2026-11-01 failures; the prompt must forbid them explicitly.
  check(DEFAULT_SAKA_CORE_PROMPT.includes('NO EMPTY REPLIES'), 'the core prompt bans empty acknowledgement replies');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('OWN-DATA LAW'), 'the core prompt carries the OWN-DATA LAW (v1.52.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes("I don't have access to"), 'access-refusal phrasing is banned (v1.52.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('OWN-DATA LAW (v1.54.0'), 'the core prompt carries the OWN-DATA LAW v2 (v1.54.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes("I can't see"), 'the widened access-refusal family is banned in the prompt (v1.54.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('not stored on my side'), '"not stored on my side" is banned (v1.54.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('Missing (each has one fill step)'), 'the prompt names the snapshot populate-step line (v1.54.0)');
  check(SAKA_TONE_COMPASS.bannedPhrases.includes("I can't see"), 'the tone compass mirrors the widened banned phrases (v1.54.0)');
  check(SAKA_TONE_COMPASS.bannedPhrases.includes('not stored on my side'), 'the tone compass bans "not stored on my side" (v1.54.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('PERSONALITY LAW'), 'the core prompt carries the PERSONALITY LAW (v1.53.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('EVERY-DEMOGRAPHIC LAW'), 'the core prompt carries the EVERY-DEMOGRAPHIC LAW (v1.53.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('zero-shot AI top-up'), 'the prompt describes the flag-gated zero-shot OCR top-up (v1.54.1)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('the deterministic lens is ALWAYS the authority'), 'the prompt locks the deterministic lens as the OCR authority (v1.54.1)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('The ENGINE tracks repeats per step'), 'the prompt documents the engine-owned patience ladder (v1.54.4)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('Send me as a detailed pdf'), 'deliverable-shaped requests are named as report requests');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('never silently merge'), 'draft-conflict merging is forbidden');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('CORRECTIONS to the entry under discussion'), 'follow-up totals are corrections, not new entries');

  // v1.59.0 — PERSONA V4: brand compass, ack variety and pacing ride the prompt
  // AND the tone compass (single source; the prompt renders the compass block).
  check(DEFAULT_SAKA_CORE_PROMPT.includes('BRAND COMPASS'), 'the tone compass block renders the v4 BRAND COMPASS');
  check(SAKA_TONE_COMPASS.voice.some((line) => /active human verbs/i.test(line)), 'v4 voice: active human verbs over robotic formulas');
  check(SAKA_TONE_COMPASS.voice.some((line) => /contractions/i.test(line)), 'v4 voice: natural contractions and varied rhythm');
  check(SAKA_TONE_COMPASS.voice.some((line) => /The medium is WhatsApp/i.test(line)), 'v4 voice: the medium is WhatsApp (punchy, scannable)');
  check(Array.isArray(SAKA_TONE_COMPASS.pacing) && SAKA_TONE_COMPASS.pacing.length >= 3, 'v4 pacing laws are declared as data');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('PACING LAWS'), 'the prompt carries the PACING LAWS block');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('ACK VARIETY'), 'the prompt carries the ACK VARIETY block');
  check(SAKA_TONE_COMPASS.ackVariety.casual.includes('Logged ✓') && SAKA_TONE_COMPASS.ackVariety.formal.includes('Recorded.'), 'ack variety pools exist for casual and formal registers');
  check(/never use the same confirmation opener twice in a row/i.test(DEFAULT_SAKA_CORE_PROMPT), 'the ACK VARIETY LAW forbids a repeated confirmation opener');
  check(/no menu, no option list/i.test(DEFAULT_SAKA_CORE_PROMPT), 'the PACING LAW forbids menus after a completed write');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('change approach and PERFORM the action'), 'the folded Sentinel live learnings ride the core prompt');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('carry free-text expense detail into the draft note/label'), 'the label-echo learning is trained');
  check(PROMPT_REFINEMENT_MARKER === 'SAKA-PROMPT-SCHEMA:2026.13.0', 'the prompt schema version is bumped for v5 (retires stale refinements)');

  // The composer enforces the same rule at runtime (not just in the prompt).
  check(isContentlessReply('Got your vehicle details!') === true, 'an empty acknowledgement is rejected by the composer');
  check(isContentlessReply('Noted.') === true, 'a one-word acknowledgement is rejected');
  check(isContentlessReply('Okay 🚗') === true, 'an acknowledgement with an emoji is still empty');
  check(isContentlessReply('', {}) === true, 'an empty render is rejected');
  check(isContentlessReply('You spent *KES 21,000* on repairs on 21 Oct 2026 — that is 31% of October spend.') === false, 'a fact-bearing reply passes');
  check(isContentlessReply('Repairs totals: KES 21,000 (21 Oct). Fuel: KES 21,000 (21 Oct). Want the full ledger?') === false, 'a data list with a next step passes');
  check(isContentlessReply('Got it — KES 21,000 logged against KAS 628T at 367,900 km. Anything else for that trip?') === false, 'a short but factual confirmation passes');

  console.log('\n--- Test: v1.39.0 prompt sync (odometer policy + web signups) ---');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('ODOMETER POLICY (v1.39.0'), 'the core prompt carries the engine-enforced odometer policy');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('WEB SIGNUPS (v1.49.2'), 'the core prompt carries the website-only web-signup verification guidance');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('never invite a user to reply with a code in WhatsApp'), 'the core prompt forbids in-chat code verification (v1.49.2)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('CONFIRM the switch'), 'the core prompt confirms a language change before replying in it (v1.49.4)');
  check(SAKA_FLOW_PLAYBOOK.includes('THE ODOMETER POLICY (v1.39.0, catalog-driven)'), 'the flow playbook carries the catalog-driven odometer policy');
  check(SAKA_FLOW_PLAYBOOK.includes('operating_hours'), 'the playbook names the engine-hours substitute for machines');
  check(SAKA_FLOW_PLAYBOOK.includes('WEB ONBOARDING (sakafleet.com'), 'the playbook documents the website onboarding flow (v1.40.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('https://sakafleet.com'), 'the core prompt points new users to the website signup (v1.49.0)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('vehicle_registration quiz only proceeds once the profile is email-verified'), 'the core prompt gates WhatsApp registration on email verification (v1.49.0)');
  check(SAKA_FLOW_PLAYBOOK.includes('Point of entry'), 'the playbook documents the website point of entry');
  // v1.74.0 (Phase 13) — every known flow key stays embedded in the prompt, and
  // the dashboard's two-channel split is stated where the model reads it.
  check(SAKA_FLOW_PLAYBOOK.includes('WEB DASHBOARD (v1.74.0'), 'the playbook documents the web dashboard flow (v1.74.0)');
  check(/code arrives by EMAIL ONLY/.test(SAKA_FLOW_PLAYBOOK), 'the playbook states the dashboard code arrives by email only');
  check(SAKA_FLOW_PLAYBOOK.includes('dashboard: Reply *dashboard*'), 'the dashboard guidance line renders into the prompt (rule 60)');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('WEB DASHBOARD (v1.74.0)'), 'the core prompt carries the dashboard feature line (v1.74.0)');
  // v1.75.0 (Phase 14A) — prompt and behaviour stay in lock-step: the model must
  // know the dashboard grew a vehicle list + one page per vehicle.
  check(SAKA_FLOW_PLAYBOOK.includes('opens one page per vehicle'), 'the playbook states the v1.75.0 vehicle pages');
  check(SAKA_FLOW_PLAYBOOK.includes('have NOT shipped'), 'the playbook keeps the unshipped dashboard pages off-limits');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('the vehicle list and one vehicle'), 'the core prompt states the shipped dashboard scope (v1.75.0)');
  // v1.75.1 (Phase 14B) — the records surface must be stated where the model reads it.
  check(SAKA_FLOW_PLAYBOOK.includes('searchable records table'), 'the playbook documents the v1.75.1 records surface');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('CSV/PDF export'), 'the core prompt states the records exports (v1.75.1)');
  // v1.75.2 (Phase 14C) — the compliance surface must be stated too.
  check(SAKA_FLOW_PLAYBOOK.includes('compliance board'), 'the playbook documents the v1.75.2 compliance surface');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('compliance board'), 'the core prompt states the compliance surface (v1.75.2)');
  // v1.75.3 (Phase 14D) — the reports builder + settings surface.
  check(SAKA_FLOW_PLAYBOOK.includes('reports builder'), 'the playbook documents the v1.75.3 reports builder');
  check(DEFAULT_SAKA_CORE_PROMPT.includes('reports builder'), 'the core prompt states the reports builder (v1.75.3)');

  console.log(`\n\u2705 ALL AGENT TRAINING TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});
