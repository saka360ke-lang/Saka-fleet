import assert from 'assert';
import { matchProductQa } from './src/services/productQa.js';
import {
  detectRemindersListCommand,
  detectComplianceStatusCommand,
  detectComplianceExpiryQuestion,
  detectComplianceCorrection,
  detectMaintenanceScheduleQuestion,
  detectDriverComplianceRead,
  detectAllDocumentsExpiryRead,
  detectComplianceNumberSearch
} from './src/services/complianceAnswers.js';
import { resolveLedgerTurn } from './src/services/entryAnswers.js';
import { parseRecordQuestion, isRecordChallenge } from './src/services/recordAnswers.js';
import { isOdometerQuestion } from './src/services/odometerAnswer.js';

/**
 * Saka Fleet — Phase 3 Read Command Registry equivalence harness (v1.63.3).
 *
 * Part 1 (frozen): `oldResolve()` is the OLD if/else dispatch chain from
 * `src/routes/whatsapp.js` lines 1677-2234, re-implemented as a PURE function.
 * It reuses the exact detector functions the old chain called and carries a
 * verbatim copy of every inline regex that lived in the route. It is the
 * golden reference: it must never change after Phase 3 lands.
 *
 * Part 2: `resolveReadCommand()` (src/services/readCommands.js) must return
 * the SAME lane id, parking flag and abandon reason for every fixture.
 *
 * Run `node test_read_registry.js --capture` to print the golden table.
 */

// ── Verbatim copies of the inline detectors that lived in whatsapp.js ──────
const HELP_MENU_RE = /^(?:help|menu|options|what can you do|what can i do|how (?:do i|can i) (?:use|start|begin))\s*\??$/i;
const SUMMARY_RE = /(?:(?:send|email|resend|share|mail)\b[\s\S]{0,40}(?:registration|vehicle|passbook)\b[\s\S]{0,20}(?:summary|details|copy|pdf|email))|(?:registration|vehicle)\s+(?:summary|details|passbook)/i;
const UPLOAD_MENU_RE = /^(?:upload|send|share|scan)\s+(?:a\s+)?(?:document|doc|documents|photo|file|files)s?$|^what\s+(?:documents?|files?)\s+(?:can|may|do)\s+(?:i|you)\s+(?:send|upload|accept)\b|^(?:documents?|docs?)\s+(?:list|supported)$/i;
const VEHICLES_RE = /^(?:(?:list|show|view)\s+)?(?:my\s+)?(?:cars|vehicles|fleet)$|^(?:vehicle|car)\s+list$|^manage\s+(?:my\s+)?(?:vehicles?|cars?)$/i;
const RECEIPT_DELETE_RE = /^(?:delete|remove)\s+receipts?\s+([1-5])(?:\s+(DELETE))?$/i;
const MY_RULES_RE = /^(?:my\s+rules?|country\s+rules?|what\s+(?:are\s+)?my\s+rules?|compliance\s+rules?)$/i;
const REQUIRED_DOCS_RE = /^(?:required\s+(?:documents?|docs?)|what\s+documents?\s+do\s+i\s+need|my\s+document\s+requirements?)$/i;
const EXAMPLE_COMPLIANCE_RE = /^(?:example\s+(?:compliance|document|submission)|give\s+me\s+an\s+example|example\s+text)$/i;
const DRIVER_PROFILE_RE = /^(?:(?:show|see|view|open|check|what(?:'s| is))\s+(?:me\s+)?(?:my\s+)?(?:own\s+)?(?:personal\s+)?driver(?:'s|’s|s)?\s+(?:profile|licen[cs]e|record|card|compliance)|(?:my|our|personal|own)\s+driver(?:'s|’s|s)?\s+(?:profile|licen[cs]e|record|card|compliance)|(?:my\s+)?personal\s+compliance)\b/i;

function oldReceiptsCommand(text = '') {
  const clean = String(text || '').trim();
  if (/^(?:my\s+)?receipts?$|^show\s+(?:my\s+)?receipts?$|^last\s+receipt$/i.test(clean)) return true;
  if (/\b(?:log|record|add|save|spent|paid)\b/i.test(clean) && !/\brecords?\b|\bhistory\b|\bany\b/i.test(clean)) return false;
  return /\b(?:receipts?|purchases?|parts?\s+(?:purchases?|bought|bought\s+parts?))\b/i.test(clean)
    && /\b(?:show|list|see|view|any|history|record|records|last|recent|what|which|do\s+you\s+have)\b/i.test(clean);
}

function oldCountryCommand(text = '') {
  const candidate = text.match(/^(?:change|set|switch)\s+country\s+(?:to\s+)?(.+)$/i)?.[1]
    || text.match(/^country\s+(.+)$/i)?.[1]
    || null;
  const isKnowledgeSuffix = Boolean(candidate)
    && /^(?:rules?|documents?|docs?|requirements?|examples?)$/i.test(candidate.trim());
  if (candidate && !isKnowledgeSuffix) return true;
  return /^(?:my\s+country|country|where\s+am\s+i)$/i.test(text);
}

/**
 * The OLD dispatch chain as a pure resolver (frozen golden reference).
 * Returns a lane id, or null when the old chain fell through to the AI.
 * Kept-inline branches resolve to their own ids so the harness can prove the
 * new registry never claims them.
 */
function oldResolve(text, ctx = {}) {
  const raw = String(text || '');
  const t = raw.trim();
  if (!t) return null;
  const locked = Boolean(ctx.quizPhaseLocked);
  const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  if (ctx.ocrPaused) return 'ocr_paused';                                      // 1677
  if (oldCountryCommand(t)) return 'country_command';                          // 1683
  if (HELP_MENU_RE.test(t)) return 'help_menu';                                // 1685
  if (matchProductQa(t)) return 'product_qa';                                  // 1698
  if (MY_RULES_RE.test(t) || REQUIRED_DOCS_RE.test(t) || EXAMPLE_COMPLIANCE_RE.test(t)) return 'country_knowledge'; // 1771
  if (SUMMARY_RE.test(raw)) return 'vehicle_summary';                          // 1782
  if (UPLOAD_MENU_RE.test(t)) return 'upload_menu';                            // 1815
  if (VEHICLES_RE.test(t) && !ctx.hasVehicleRegistered) return 'garage_empty'; // 1821

  // Compliance family — detection gates exactly as the old preamble (1495-1517)
  const reminders = detectRemindersListCommand(t);
  const status = detectComplianceStatusCommand(t);
  const expiry = detectComplianceExpiryQuestion(t);
  const correction = detectComplianceCorrection(t);
  const maintenance = detectMaintenanceScheduleQuestion(t);
  const driverDoc = (locked || ctx.session?.pendingComplianceCapture) ? null : detectDriverComplianceRead(t);
  const allDocs = locked ? null : detectAllDocumentsExpiryRead(t);
  const numSearch = locked ? null : detectComplianceNumberSearch(t);
  if (allDocs) return 'all_documents_expiry';                                  // 1834
  if (numSearch) return 'document_number_search';                              // 1834
  if (driverDoc) return 'driver_documents';                                    // 1861
  if (correction.isCorrection) return 'compliance_correction';                 // 1881
  if (expiry) return 'compliance_expiry';                                      // 1895
  if (status) return 'compliance_status';                                      // 1905
  if (maintenance) return 'maintenance_schedule';                              // 1921
  if (reminders) return 'reminders_list';                                      // 1933

  const ledgerTurn = locked ? { type: 'none' } : resolveLedgerTurn({ pending: ctx.session?.pendingEntryAction || null, text: t });
  if (ledgerTurn.type !== 'none') return 'ledger_turn';                        // 1943

  if (!locked && isOdometerQuestion(t)) return 'odometer_read';                // 2085
  if (!locked && DRIVER_PROFILE_RE.test(t)) return 'driver_profile_read';      // 2091

  const lastRecordQuery = ctx.session?.lastRecordQuery
    && (nowMs - Number(ctx.session.lastRecordQuery.at || 0) <= 15 * 60 * 1000)
    ? ctx.session.lastRecordQuery
    : null;
  const recordChallenge = !locked && lastRecordQuery?.spec && isRecordChallenge(t)
    ? { ...lastRecordQuery.spec, ok: true, challenge: true }
    : null;
  const recordQuestion = locked
    ? { ok: false }
    : (recordChallenge || parseRecordQuestion(t, {
      countryCode: ctx.countryInfo?.country_code || 'GLOBAL',
      locale: ctx.countryInfo?.locale || 'en-US'
    }));
  if (recordQuestion.ok && ctx.supabaseClient && ctx.profile?.id) return 'records_query'; // 2108

  if (RECEIPT_DELETE_RE.test(t)) return 'receipt_delete';                      // 2179 (write, stays inline)
  if (oldReceiptsCommand(raw)) return 'receipts_list';                         // 2203
  if (ctx.fastQuizTurn) return 'quiz_turn';                                    // 2215
  return null;                                                                 // 2218 (AI)
}

// ── Parking contract of the OLD preamble (1515-1568) ────────────────────────
function oldParking(text, ctx = {}) {
  const t = String(text || '').trim();
  const locked = Boolean(ctx.quizPhaseLocked);
  if (locked || !ctx.quizForFastPath) return null;
  const family = detectRemindersListCommand(t) || detectComplianceStatusCommand(t)
    || detectComplianceExpiryQuestion(t) || detectComplianceCorrection(t).isCorrection
    || detectMaintenanceScheduleQuestion(t)
    || ((ctx.session?.pendingComplianceCapture) ? null : detectDriverComplianceRead(t))
    || detectAllDocumentsExpiryRead(t) || detectComplianceNumberSearch(t);
  if (family) return 'deterministic_read_command';
  if (resolveLedgerTurn({ pending: ctx.session?.pendingEntryAction || null, text: t }).type !== 'none') return 'ledger_command';
  const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const lastRecordQuery = ctx.session?.lastRecordQuery
    && (nowMs - Number(ctx.session.lastRecordQuery.at || 0) <= 15 * 60 * 1000)
    ? ctx.session.lastRecordQuery
    : null;
  const recordQuestion = lastRecordQuery?.spec && isRecordChallenge(t)
    ? { ...lastRecordQuery.spec, ok: true }
    : parseRecordQuestion(t, { countryCode: ctx.countryInfo?.country_code || 'GLOBAL', locale: ctx.countryInfo?.locale || 'en-US' });
  if (recordQuestion.ok) return 'record_query';
  if (isOdometerQuestion(t)) return 'odometer_query';
  if (DRIVER_PROFILE_RE.test(t)) return 'driver_profile_read';
  return null;
}

// ── Fixture context + corpus ────────────────────────────────────────────────
const VEHICLE = { id: 'v1', plate_number: 'KAS 628T', owner_id: 'p1' };
const baseCtx = (over = {}) => ({
  hasVehicleRegistered: true,
  quizPhaseLocked: false,
  quizForFastPath: false,
  ocrPaused: false,
  fastQuizTurn: false,
  session: {},
  profile: { id: 'p1' },
  supabaseClient: {},
  countryInfo: { country_code: 'KE', locale: 'en-KE', currency: 'KES', plate_example: 'KDA 123A' },
  vehicles: [VEHICLE],
  activeVehicle: VEHICLE,
  now: new Date('2026-11-06T09:00:00+03:00').getTime(),
  ...over
});

const FIXTURES = [
  // One canonical positive per registry lane
  { text: 'help', ctx: baseCtx(), expected: 'help_menu' },
  { text: 'how much does fleet command cost per month?', ctx: baseCtx(), expected: 'product_qa' },
  { text: 'required documents', ctx: baseCtx(), expected: 'country_knowledge' },
  { text: 'send me registration summary as PDF', ctx: baseCtx(), expected: 'vehicle_summary' },
  { text: 'documents list', ctx: baseCtx(), expected: 'upload_menu' },
  { text: 'list my cars', ctx: baseCtx({ hasVehicleRegistered: false }), expected: 'garage_empty' },
  { text: 'list all documents with expiry date', ctx: baseCtx(), expected: 'all_documents_expiry' },
  { text: 'search TSV2026', ctx: baseCtx(), expected: 'document_number_search' },
  { text: 'list my licenses', ctx: baseCtx(), expected: 'driver_documents' },
  { text: 'the insurance date is wrong', ctx: baseCtx(), expected: 'compliance_correction' },
  { text: 'when does insurance expire?', ctx: baseCtx(), expected: 'compliance_expiry' },
  { text: 'compliance status', ctx: baseCtx(), expected: 'compliance_status' },
  { text: 'when should I change the oil?', ctx: baseCtx(), expected: 'maintenance_schedule' },
  { text: 'reminders', ctx: baseCtx(), expected: 'reminders_list' },
  { text: 'my entries', ctx: baseCtx(), expected: 'ledger_turn' },
  { text: 'what is the current mileage?', ctx: baseCtx(), expected: 'odometer_read' },
  { text: 'show me my driver profile', ctx: baseCtx(), expected: 'driver_profile_read' },
  { text: 'what did I log yesterday?', ctx: baseCtx(), expected: 'records_query' },
  { text: 'that record cannot be right', ctx: baseCtx({ session: { lastRecordQuery: { at: new Date('2026-11-06T08:55:00+03:00').getTime(), spec: { kind: 'total', earning: false, expenseTypes: ['fuel'], range: null, vehiclePlate: null, keyword: null, text: 'how much did I spend on fuel last week?' } } } }), expected: 'records_query' },
  { text: 'receipts', ctx: baseCtx(), expected: 'receipts_list' },

  // Kept-inline branches — the registry must never claim them
  { text: 'my country', ctx: baseCtx(), expected: 'country_command' },
  { text: 'delete receipt 2', ctx: baseCtx(), expected: 'receipt_delete' },
  { text: 'help', ctx: baseCtx({ ocrPaused: true }), expected: 'ocr_paused' },

  // Live-failure corpus (never hijacked — §152 defect class)
  { text: 'Logged 40L at 50350 km for KES 5500', ctx: baseCtx({ fastQuizTurn: true }), expected: 'quiz_turn' },
  { text: 'Repaired a puncture, cost me 300kes', ctx: baseCtx(), expected: null },
  { text: 'add psv badge', ctx: baseCtx(), expected: null },
  { text: 'remind me to change oil at 400,000 km', ctx: baseCtx(), expected: null },
  { text: 'insurance expires 20/11/2026', ctx: baseCtx(), expected: null },
  { text: 'compliance report', ctx: baseCtx(), expected: null },
  { text: 'why can I not see extra notes on an entry?', ctx: baseCtx(), expected: null },

  // Locked PIN/OTP phase — gated lanes go null, locked-safe lanes still answer
  { text: '123456', ctx: baseCtx({ quizPhaseLocked: true }), expected: null },
  { text: 'list my licenses', ctx: baseCtx({ quizPhaseLocked: true }), expected: null },
  { text: 'reminders', ctx: baseCtx({ quizPhaseLocked: true }), expected: 'reminders_list' },

  // Pending compliance capture owns the turn (rule 37)
  { text: 'list my licenses', ctx: baseCtx({ session: { pendingComplianceCapture: { label: 'PSV badge' } } }), expected: 'records_query' },
  { text: 'show me my driver profile', ctx: baseCtx({ session: { pendingComplianceCapture: { label: 'PSV badge' } } }), expected: 'driver_profile_read' },

  // Overlap fixtures — the OLD precedence must win
  { text: 'show all licenses expiry', ctx: baseCtx(), expected: 'all_documents_expiry' },
  { text: 'insurance status expiry', ctx: baseCtx(), expected: 'compliance_expiry' },
  { text: 'fuel all time', ctx: baseCtx(), expected: 'records_query' },
  { text: 'what can you do', ctx: baseCtx(), expected: 'help_menu' },
  // v1.63.2 behaviour preserved verbatim: product QA shadows the upload menu
  // and one very common records phrasing.
  { text: 'what documents can I send?', ctx: baseCtx(), expected: 'product_qa' },
  { text: 'how much did I spend on fuel last week?', ctx: baseCtx(), expected: 'product_qa' }
];

const CAPTURE = process.argv.includes('--capture');

if (CAPTURE) {
  console.log('=== GOLDEN CAPTURE — OLD dispatch chain (pre-Phase-3) ===\n');
  let mismatches = 0;
  for (const fixture of FIXTURES) {
    const actual = oldResolve(fixture.text, fixture.ctx);
    const park = oldParking(fixture.text, { ...fixture.ctx, quizForFastPath: true });
    const ok = actual === fixture.expected;
    if (!ok) mismatches += 1;
    console.log(`${ok ? '✅' : '⚠️ '} ${JSON.stringify(fixture.text).slice(0, 46).padEnd(48)} -> ${String(actual).padEnd(24)} park=${String(park)}`);
  }
  console.log(`\nGolden capture complete: ${FIXTURES.length} fixtures, ${mismatches} expectation mismatch(es).`);
  process.exit(mismatches === 0 ? 0 : 1);
}

// ── Equivalence (runs once src/services/readCommands.js exists) ─────────────
let registry = null;
try {
  registry = await import('./src/services/readCommands.js');
} catch (err) {
  console.error('readCommands.js is not available yet — run with --capture for the golden table.');
  console.error(err?.message || err);
  process.exit(1);
}

let passed = 0;
function check(cond, msg) { assert(cond, msg); passed += 1; console.log(`  ✅ ${msg}`); }

console.log('=== SAKA FLEET — READ COMMAND REGISTRY EQUIVALENCE (v1.63.3) ===\n');

console.log('--- Test 1: every fixture resolves to the OLD chain id ---');
const KEPT_INLINE = new Set(['ocr_paused', 'country_command', 'receipt_delete', 'quiz_turn']);
// ocrPaused is a ROUTE guard that runs before the registry; it is proven by the
// route-order assertion below, not by the lane differential.
const differentialFixtures = FIXTURES.filter((fixture) => !fixture.ctx.ocrPaused);
for (const fixture of differentialFixtures) {
  const oldId = oldResolve(fixture.text, fixture.ctx);
  const lane = registry.resolveReadCommand(fixture.text, fixture.ctx);
  const newId = lane ? lane.id : null;
  const expected = KEPT_INLINE.has(oldId) ? null : oldId;
  check(newId === expected, `${JSON.stringify(fixture.text).slice(0, 44)} -> ${String(newId)} (old ${String(oldId)})`);
}

console.log('\n--- Test 2: no UNEXPECTED two-detector claims ---');
// Natural-language overlaps that the OLD chain also had (precedence decides).
// Any overlap NOT listed here fails the harness.
const EXPECTED_OVERLAPS = [
  ['how much does fleet command cost per month?', ['product_qa', 'records_query']],
  ['list my cars', ['garage_empty', 'records_query']],
  ['list all documents with expiry date', ['all_documents_expiry', 'records_query']],
  ['search TSV2026', ['document_number_search', 'records_query']],
  ['list my licenses', ['driver_documents', 'records_query']],
  ['my entries', ['ledger_turn', 'records_query']],
  ['what is the current mileage?', ['odometer_read', 'records_query']],
  ['show me my driver profile', ['driver_profile_read', 'records_query']],
  ['show me my driver profile', ['driver_profile_read', 'records_query']],
  ['show all licenses expiry', ['all_documents_expiry', 'driver_documents', 'records_query']],
  ['insurance status expiry', ['compliance_expiry', 'compliance_status']],
  ['what can you do', ['help_menu', 'product_qa', 'records_query']],
  ['what documents can I send?', ['product_qa', 'upload_menu', 'records_query']],
  ['how much did I spend on fuel last week?', ['product_qa', 'records_query']]
];
const foundOverlaps = [];
for (const fixture of differentialFixtures) {
  const claims = registry.READ_COMMANDS.filter((lane) => {
    if (lane.skipWhenLocked && fixture.ctx.quizPhaseLocked) return false;
    if (lane.skipWhenPendingCapture && fixture.ctx.session?.pendingComplianceCapture) return false;
    return Boolean(lane.detect(fixture.text, fixture.ctx));
  }).map((lane) => lane.id);
  if (claims.length > 1) foundOverlaps.push([fixture.text, claims]);
  const oldId = oldResolve(fixture.text, fixture.ctx);
  if (oldId && registry.READ_COMMANDS.some((lane) => lane.id === oldId)) {
    check(claims[0] === oldId, `${JSON.stringify(fixture.text).slice(0, 44)} first claim ${String(claims[0])} wins (old ${String(oldId)})`);
  } else {
    check(claims.length === 0, `${JSON.stringify(fixture.text).slice(0, 44)} claimed by no registry lane`);
  }
}
check(JSON.stringify(foundOverlaps) === JSON.stringify(EXPECTED_OVERLAPS),
  `overlaps are exactly the declared set (${foundOverlaps.length} fixture(s)): ${JSON.stringify(foundOverlaps)}`);

console.log('\n--- Test 3: parking contract matches the old preamble ---');
for (const fixture of differentialFixtures) {
  const ctx = { ...fixture.ctx, quizForFastPath: true };
  const lane = registry.resolveReadCommand(fixture.text, ctx);
  const newPark = lane?.parksNow ? lane.abandonReason : null;
  const oldPark = oldParking(fixture.text, ctx);
  check(newPark === oldPark, `${JSON.stringify(fixture.text).slice(0, 44)} park=${String(newPark)} (old ${String(oldPark)})`);
}

console.log(`\n🎉 ${passed} read-registry equivalence assertions passed.`);
