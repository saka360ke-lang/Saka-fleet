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
// v1.84.0 (Phase 23) — the stored-document vault lanes (list + delete).
const DOCUMENT_DELETE_RE = /^(?:delete|remove)\s+documents?\s+([1-5])(?:\s+(DELETE))?$/i;
const DOCUMENTS_LIST_RE = /^(?:(?:my|our|vehicle|stored|compliance)\s+)?documents?$|^document\s+vault$/i;
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
  if (DOCUMENT_DELETE_RE.test(t)) return 'document_delete';                    // v1.84.0 (write, stays inline)
  if (oldReceiptsCommand(raw)) return 'receipts_list';                         // 2203
  if (DOCUMENTS_LIST_RE.test(t)) return 'documents_list';                      // v1.84.0 (stored files)
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
  // v1.84.0 (Phase 23) — the stored document vault (list lane + inline delete).
  { text: 'documents', ctx: baseCtx(), expected: 'documents_list' },

  // v1.73.0 (Phase 10, P3-1 / A1) — a CURSORLESS "more"/"next" must never be
  // claimed by the registry; it falls through to the AI exactly as before.
  { text: 'more', ctx: baseCtx(), expected: null },
  { text: 'next', ctx: baseCtx(), expected: null },

  // Kept-inline branches — the registry must never claim them
  { text: 'my country', ctx: baseCtx(), expected: 'country_command' },
  { text: 'delete receipt 2', ctx: baseCtx(), expected: 'receipt_delete' },
  { text: 'delete document 2', ctx: baseCtx(), expected: 'document_delete' },
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
const KEPT_INLINE = new Set(['ocr_paused', 'country_command', 'receipt_delete', 'document_delete', 'quiz_turn']);
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

console.log('\n--- Test 4: v1.72.2 subscription_status lane (Phase 9, P3-6) ---');
// The aliases route to the engine-owned billing turn with zero AI tokens. They
// are exact-phrase matches; product_qa also matches them, and the registry
// order (subscription_status before product_qa) is the fix.
const SUB_ALIASES = ['trial', 'trial status', 'my trial', 'my trial status'];
for (const text of SUB_ALIASES) {
  const lane = registry.resolveReadCommand(text, baseCtx());
  check(lane?.id === 'subscription_status', `"${text}" -> subscription_status`);
  const rendered = await lane.render(baseCtx());
  check(rendered.intent === 'VIEW_SUBSCRIPTION' && rendered.reply_message === null,
    `"${text}" hands the turn to the engine-owned VIEW_SUBSCRIPTION summary`);
}
// Declared overlap: the QA 'trial' topic matches these strings too; the lane
// order is what keeps the owner summary ahead of the marketing card.
const aliasOverlaps = SUB_ALIASES.map((text) => [
  text,
  registry.READ_COMMANDS.filter((lane) => Boolean(lane.detect(text, baseCtx()))).map((lane) => lane.id)
]);
check(JSON.stringify(aliasOverlaps) === JSON.stringify(SUB_ALIASES.map((text) => [text, ['subscription_status', 'product_qa']])),
  `alias overlaps are exactly the declared set: ${JSON.stringify(aliasOverlaps)}`);
// Negatives: the trial-end window, EXTEND_TRIAL and every longer phrasing keep
// their own turns — the `$` anchor must never hijack them.
for (const text of ['my trial ended, I have 6 trucks, what now?', 'extend my trial', 'trial extension', 'my trial is ending soon', 'trial ended yesterday', 'keep all']) {
  const lane = registry.resolveReadCommand(text, baseCtx());
  check(!lane || lane.id !== 'subscription_status', `"${text}" is never claimed by subscription_status`);
}
// A locked PIN/OTP phase keeps the lane out (skipWhenLocked).
const lockedLane = registry.resolveReadCommand('trial status', baseCtx({ quizPhaseLocked: true }));
check(!lockedLane || lockedLane.id !== 'subscription_status', 'a locked PIN/OTP phase keeps subscription_status out');
// Ownerless sessions keep today's marketing trial card — never a null reply.
const ownerlessLane = registry.resolveReadCommand('trial status', baseCtx({ profile: null }));
const ownerlessRender = await ownerlessLane.render(baseCtx({ profile: null }));
check(ownerlessRender.intent !== 'VIEW_SUBSCRIPTION' && typeof ownerlessRender.reply_message === 'string' && /trial/i.test(ownerlessRender.reply_message),
  'ownerless sessions keep the marketing trial card (no null reply, no owner summary)');

console.log('\n--- Test 5: v1.73.0 pagination_more lane (Phase 10, P3-1, A1) ---');
// The `more` turn exists ONLY while a fresh session.paginationCursor is alive
// (D1: 15-minute TTL). Cursorless/expired turns fall through to the AI; the
// fixture corpus above pins the cursorless case in the frozen chain.
const MORE_ALIASES = ['more', 'next', 'next page', 'older', 'show me more'];
for (const text of MORE_ALIASES) {
  check(registry.resolveReadCommand(text, baseCtx()) === null,
    `"${text}" with NO cursor falls through to the AI`);
}
const CURSOR_AT = new Date('2026-11-06T08:58:00+03:00').getTime();
const freshCursor = {
  at: CURSOR_AT,
  listType: 'entries',
  offset: 6,
  maxOffset: 24,
  scope: { ownerId: 'p1', driverId: null, vehicleIds: ['v1'] }
};
for (const text of MORE_ALIASES) {
  const lane = registry.resolveReadCommand(text, baseCtx({ session: { paginationCursor: freshCursor } }));
  check(lane?.id === 'pagination_more', `"${text}" with a FRESH cursor -> pagination_more`);
}
const expiredCursor = { ...freshCursor, at: CURSOR_AT - 16 * 60 * 1000 };
check(registry.resolveReadCommand('more', baseCtx({ session: { paginationCursor: expiredCursor } })) === null,
  'an EXPIRED cursor never claims "more" (15-minute TTL)');
const receiptsCursor = { ...freshCursor, listType: 'receipts', offset: 5, maxOffset: 20 };
check(registry.resolveReadCommand('more', baseCtx({ session: { paginationCursor: receiptsCursor } }))?.id === 'pagination_more',
  'a receipts cursor pages receipts through the same lane');
// Render: 7 expense rows with the cursor at offset 6 → one older row, end-of-list
// copy, and the cursor clears (D2: never invites edit/delete on page 2+).
function ledgerMock(expenseRows) {
  return {
    from(table) {
      const rows = table === 'expense_logs' ? expenseRows : [];
      const chain = {
        select() { return chain; },
        in() { return chain; },
        order() { return chain; },
        eq() { return chain; },
        limit() { return Promise.resolve({ data: rows, error: null }); }
      };
      return chain;
    }
  };
}
const FIXED_NOW = new Date('2026-11-06T09:00:00+03:00').getTime();
const sevenRows = Array.from({ length: 7 }, (_, i) => ({
  id: `e${7 - i}`,
  vehicle_id: 'v1',
  expense_type: 'Fuel',
  amount: 100 + i,
  created_at: new Date(Date.UTC(2026, 10, 1, 8, 7 - i)).toISOString()
}));
const pageSession = { paginationCursor: { ...freshCursor, at: FIXED_NOW - 60 * 1000 } };
const pageCtx = baseCtx({ session: pageSession, supabaseClient: ledgerMock(sevenRows), now: FIXED_NOW });
const pageRendered = await registry.resolveReadCommand('more', pageCtx).render(pageCtx);
check(pageRendered.reply_message.includes('Older entries'), 'page 2+ is titled "Older entries"');
check(!/edit \d|delete \d/.test(pageRendered.reply_message), 'page 2+ never invites edit/delete (D2)');
check(pageRendered.reply_message.includes('*my entries*'), 'page 2+ points back to the newest list');
check(pageSession.paginationCursor === null, 'the cursor clears at the end of the list');
// The 5-page cap: at offset 24 a further page shows the search/report redirect
// and offers NO `more` line (D3).
const fortyRows = Array.from({ length: 40 }, (_, i) => ({
  id: `e${40 - i}`,
  vehicle_id: 'v1',
  expense_type: 'Fuel',
  amount: 100 + i,
  created_at: new Date(Date.UTC(2026, 9, 1, 8, 40 - i)).toISOString()
}));
const capSession = { paginationCursor: { ...freshCursor, at: FIXED_NOW - 60 * 1000, offset: 24 } };
const capCtx = baseCtx({ session: capSession, supabaseClient: ledgerMock(fortyRows), now: FIXED_NOW });
const capRendered = await registry.resolveReadCommand('more', capCtx).render(capCtx);
check(capRendered.reply_message.includes('*search <keyword>*') && !/Reply \*more\*/.test(capRendered.reply_message),
  'the 5-page cap redirects to search/report and never offers more');
check(capSession.paginationCursor === null, 'the cursor clears at the 5-page cap');

console.log('\n--- Test 6: v1.73.0 my_ticket lane (Phase 10, P3-3, A2) ---');
// OWN-DATA only: the lane queries support_tickets by the CALLER's phone number
// (the exact value the intake stored). Read-only: reply/edit/close stay staff.
function ticketsMock({ rows = [], columnsError = null, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const api = {
        __columns: null,
        __eq: null,
        select(columns) { api.__columns = columns; return api; },
        eq(col, val) { api.__eq = [col, val]; return api; },
        order() { return api; },
        limit() {
          calls.push({ table, columns: api.__columns, eq: api.__eq });
          if (fail) return Promise.resolve({ data: null, error: fail });
          if (columnsError && String(api.__columns || '').includes('status')) {
            return Promise.resolve({ data: null, error: columnsError });
          }
          const filtered = (rows || []).filter((row) => !api.__eq || row[api.__eq[0]] === api.__eq[1]);
          return Promise.resolve({ data: filtered, error: null });
        }
      };
      return api;
    }
  };
}
const TICKET_PHONE = '+254700000000';
const ticketCtx = (over = {}) => baseCtx({ senderPhone: TICKET_PHONE, ...over });
async function renderTicket(text, over = {}) {
  const ctx = ticketCtx(over);
  const lane = registry.resolveReadCommand(text, ctx);
  return { lane, rendered: lane ? await lane.render(ctx) : null };
}
for (const text of ['my ticket', 'my tickets', 'ticket status']) {
  check(registry.resolveReadCommand(text, ticketCtx())?.id === 'my_ticket', `"${text}" -> my_ticket`);
}
for (const text of ['my ticket has not arrived yet', 'raise a ticket', 'ticket 3 is wrong', 'my support']) {
  const lane = registry.resolveReadCommand(text, ticketCtx());
  check(!lane || lane.id !== 'my_ticket', `"${text}" is never claimed by my_ticket (exact $ anchor)`);
}
check(registry.resolveReadCommand('my ticket', ticketCtx({ quizPhaseLocked: true }))?.id !== 'my_ticket',
  'a locked PIN/OTP phase keeps my_ticket out (skipWhenLocked)');
check(registry.resolveReadCommand('my ticket', ticketCtx({ profile: null }))?.id !== 'my_ticket',
  'an unregistered session never reaches my_ticket');
const ticketClaims = registry.READ_COMMANDS
  .filter((lane) => Boolean(lane.detect('my ticket', ticketCtx())))
  .map((lane) => lane.id);
check(JSON.stringify(ticketClaims) === JSON.stringify(['my_ticket']),
  `my_ticket owns the phrase with no silent overlap: ${JSON.stringify(ticketClaims)}`);
// OWN-DATA scoping: another phone's ticket is filtered out by the query.
const scopedTickets = ticketsMock({
  rows: [
    { id: 'abc123de-0000-1111', subject: 'Fuel entry missing', status: 'OPEN', priority: 'high', updated_at: '2026-11-05T08:00:00Z', whatsapp_number: TICKET_PHONE },
    { id: 'def456gh-0000-2222', subject: 'Refund question', status: 'RESOLVED', priority: 'medium', updated_at: '2026-11-01T08:00:00Z', whatsapp_number: '+254711111111' }
  ]
});
const scopedRender = await renderTicket('my ticket', { supabaseClient: scopedTickets });
check(scopedTickets.calls[0]?.eq?.[0] === 'whatsapp_number' && scopedTickets.calls[0]?.eq?.[1] === TICKET_PHONE,
  'the query filters by the caller\'s OWN phone number');
check(scopedRender.rendered.reply_message.includes('#abc123') && scopedRender.rendered.reply_message.includes('Fuel entry missing'),
  'the caller\'s own ticket is rendered with its short reference and subject');
check(!scopedRender.rendered.reply_message.includes('Refund question'),
  'another phone\'s ticket NEVER appears (OWN DATA only)');
check(scopedRender.rendered.reply_message.includes('🔵') && scopedRender.rendered.reply_message.includes('❗ high'),
  'status and priority chips render deterministically');
// A2 — empty-state idempotency: two consecutive calls both produce the honest
// empty state, never the support-intake prompt.
const emptyTickets = ticketsMock({ rows: [] });
const firstEmpty = await renderTicket('my ticket', { supabaseClient: emptyTickets });
const secondEmpty = await renderTicket('my ticket', { supabaseClient: emptyTickets });
check(firstEmpty.rendered.reply_message === secondEmpty.rendered.reply_message,
  'A2: two consecutive `my ticket` calls with zero tickets produce the SAME empty state');
check(firstEmpty.rendered.reply_message.includes("don't have any tickets"),
  'A2: the empty state is honest about having zero tickets');
check(!firstEmpty.rendered.reply_message.includes('forward it to'),
  'A2: the empty state is never the support-intake prompt');
// Rule 50 — a pre-care-console table degrades to the slim shape (OPEN chip).
const degradeMock = ticketsMock({
  rows: [{ id: 'legacy1', issue_category: 'bug', message_body: 'The app is stuck', created_at: '2026-11-04T08:00:00Z', whatsapp_number: TICKET_PHONE }],
  columnsError: { message: 'column "status" of relation "support_tickets" does not exist' }
});
const degradedRender = await renderTicket('my ticket', { supabaseClient: degradeMock });
check(degradedRender.rendered.reply_message.includes('The app is stuck') && degradedRender.rendered.reply_message.includes('🔵'),
  'a pre-migration support_tickets table degrades to the slim shape (OPEN chip)');
check(degradeMock.calls.length === 2, 'the degrade retries exactly once with the slim columns');

// ── v1.82.0 (Phase 21) — the dashboard lane ships the STATIC sign-in link ───
const DASH_PROFILE = { id: 'p-dash', phone_number: '+254700000000', email: 'amina@example.com', email_verified: true, full_name: 'Amina W' };
const dashCtx = (over = {}) => baseCtx({ profile: DASH_PROFILE, ...over });
const previousDashFlag = process.env.DASHBOARD_ENABLED;
async function renderDashboard(text, over = {}) {
  const ctx = dashCtx(over);
  const lane = registry.resolveReadCommand(text, ctx);
  return { lane, rendered: lane ? await lane.render(ctx) : null };
}

for (const text of ['dashboard', 'my dashboard', 'open my dashboard', 'web dashboard']) {
  check(registry.resolveReadCommand(text, dashCtx())?.id === 'dashboard', `"${text}" -> dashboard`);
}
for (const text of ['records', 'my records']) {
  check(registry.resolveReadCommand(text, dashCtx())?.id === 'dashboard', `"${text}" -> dashboard (records alias)`);
}
for (const text of ['dashboard ideas', "i can't see the dashboard", 'dashboard not loading for my fleet']) {
  const lane = registry.resolveReadCommand(text, dashCtx());
  check(!lane || lane.id !== 'dashboard', `"${text}" is never claimed by dashboard (exact $ anchor)`);
}
check(registry.resolveReadCommand('dashboard', dashCtx({ quizPhaseLocked: true }))?.id !== 'dashboard',
  'a locked PIN/OTP phase keeps the dashboard lane out (skipWhenLocked)');
const dashClaims = registry.READ_COMMANDS.filter((lane) => Boolean(lane.detect('dashboard', dashCtx()))).map((lane) => lane.id);
check(JSON.stringify(dashClaims) === JSON.stringify(['dashboard']), `dashboard owns the phrase with no silent overlap: ${JSON.stringify(dashClaims)}`);
const recordsClaims = registry.READ_COMMANDS.filter((lane) => Boolean(lane.detect('records', dashCtx()))).map((lane) => lane.id);
check(recordsClaims[0] === 'dashboard' && recordsClaims.includes('ledger_turn') && recordsClaims.includes('records_query'),
  `dashboard wins the records alias ahead of the ledger/records lanes: ${JSON.stringify(recordsClaims)}`);
// Rule 52 — the neighbouring lanes still own THEIR turns (no hijack).
check(registry.resolveReadCommand('my entries', dashCtx())?.id === 'ledger_turn', 'the ledger lane still owns "my entries" (no hijack)');
check(registry.resolveReadCommand('search TSV2026', dashCtx())?.id !== 'dashboard', 'a keyword search is never hijacked by the dashboard door');

process.env.DASHBOARD_ENABLED = 'off';
const offRender = await renderDashboard('dashboard');
check(offRender.rendered.reply_message === "That's not something I can do yet — reply *help* to see what I can do.",
  'A2: flag OFF answers the verbatim not-available line');
check(!/dashboard/i.test(offRender.rendered.reply_message), 'A2: the not-available line never mentions the dashboard');
process.env.DASHBOARD_ENABLED = 'on';

const okRender = await renderDashboard('dashboard');
const okText = okRender.rendered.reply_message;
check(okText.includes('https://app.sakafleet.com/d/login'), 'the lane replies with the STATIC sign-in link');
check(/1\.[\s\S]*WhatsApp number/.test(okText) && /2\.[\s\S]*6-digit code/.test(okText) && /3\.[\s\S]*15 minutes/.test(okText),
  'the 3-line tutorial teaches number -> code -> 15 minutes');
check(!/\b\d{6}\b/.test(okText), 'no 6-digit code ever appears in the WhatsApp reply');
check(!/email/i.test(okText), 'the reply never promises an email');
const recordsRender = await renderDashboard('records');
check(recordsRender.rendered.reply_message.includes('https://app.sakafleet.com/d/login'), 'the records alias ships the same door');

// ── v1.88.0 (Phase 27) — the Free-plan warm upsell (never a cold refusal) ───
const freeRender = await renderDashboard('dashboard', { entitlements: { isTrial: false, isPaid: false } });
const freeText = freeRender.rendered.reply_message;
check(freeText.includes('🔒') && /paid feature/.test(freeText), 'a Free account gets the warm upsell, not a cold refusal');
check(freeText.includes('*report*'), 'the upsell offers the same data as a PDF (*report*)');
check(freeText.includes('*subscription*') && freeText.includes('$9.99/mo'), 'the upsell points to *subscription* with the engine price');
check(!freeText.includes('https://app.sakafleet.com/d/login'), 'a Free account is never handed a link the sign-in gate would refuse');
const trialRender = await renderDashboard('dashboard', { entitlements: { isTrial: true, isPaid: false } });
check(trialRender.rendered.reply_message.includes('https://app.sakafleet.com/d/login'), 'a live trial gets the sign-in link');
const paidRender = await renderDashboard('dashboard', { entitlements: { isTrial: false, isPaid: true } });
check(paidRender.rendered.reply_message.includes('https://app.sakafleet.com/d/login'), 'a paid account gets the sign-in link');
const noPlanRender = await renderDashboard('records', { entitlements: { isTrial: false, isPaid: false } });
check(noPlanRender.rendered.reply_message.includes('*report*'), 'the records alias answers the same warm upsell on Free');

// ── v1.82.0 (Phase 21, D4) — the admin door is exact-phrase + env identity ──
const previousSuperadmin = process.env.SUPERADMIN_PHONE;
process.env.SUPERADMIN_PHONE = DASH_PROFILE.phone_number;
const adminLane = registry.resolveReadCommand('dashboard admin', dashCtx());
check(adminLane?.id === 'dashboard', '"dashboard admin" is claimed by the dashboard lane');
const dashboardLaneDef = registry.READ_COMMANDS.find((lane) => lane.id === 'dashboard');
check(dashboardLaneDef.detect('dashboard admin') === 'admin', 'the admin phrase carries its marker');
const adminRender = await adminLane.render(dashCtx());
check(adminRender.reply_message.includes('https://app.sakafleet.com/d/admin/login'), 'the superadmin gets the admin door');
process.env.SUPERADMIN_PHONE = '+254799999999';
const spoofRender = await registry.resolveReadCommand('dashboard admin', dashCtx()).render(dashCtx());
check(spoofRender.reply_message === "That's not something I can do yet — reply *help* to see what I can do.", 'a non-superadmin asking for the admin phrase gets the generic line');
if (previousSuperadmin === undefined) delete process.env.SUPERADMIN_PHONE;
else process.env.SUPERADMIN_PHONE = previousSuperadmin;
if (previousDashFlag === undefined) delete process.env.DASHBOARD_ENABLED;
else process.env.DASHBOARD_ENABLED = previousDashFlag;

// ── v1.84.0 (Phase 23) — the stored document vault lanes ────────────────────
console.log('\n--- Test 8: v1.84.0 documents_list lane (Phase 23) ---');
for (const text of ['documents', 'my documents', 'vehicle documents', 'stored documents', 'document vault']) {
  check(registry.resolveReadCommand(text, baseCtx())?.id === 'documents_list', `"${text}" -> documents_list`);
}
for (const text of ['documents list', 'required documents', 'list all documents with expiry date', 'what documents can I send?']) {
  const lane = registry.resolveReadCommand(text, baseCtx());
  check(lane?.id !== 'documents_list', `"${text}" keeps its own lane (${lane?.id || 'AI'})`);
}
check(registry.resolveReadCommand('documents', baseCtx({ quizPhaseLocked: true })) === null, 'a locked PIN/OTP phase keeps documents_list out');
check(registry.resolveReadCommand('documents', baseCtx({ session: { pendingComplianceCapture: { label: 'Insurance' } } })) === null, 'a pending compliance capture owns the turn (no documents_list hijack)');
const documentsLaneDef = registry.READ_COMMANDS.find((lane) => lane.id === 'documents_list');
check(Boolean(documentsLaneDef) && documentsLaneDef.detect('documents') !== null, 'the documents_list lane is registered in the ordered registry');

// ── v1.96.2 — cancel-transfer + non-ledger delete guards ─────────────────────
console.log('\n--- Test 9: v1.96.2 cancel-transfer + non-ledger delete guards ---');
for (const text of ['Cancel passbook transfer', 'cancel transfer', 'stop the handover']) {
  check(registry.resolveReadCommand(text, baseCtx())?.id === 'transfer_cancel_hint',
    `"${text}" -> transfer_cancel_hint (never starts a handover)`);
}
const liveTransferCtx = baseCtx({ session: { quiz: { flow: 'transfer_seller', phase: 'question' } } });
check(registry.resolveReadCommand('cancel transfer', liveTransferCtx)?.id !== 'transfer_cancel_hint',
  'a live transfer flow keeps its own cancel turn (no hijack)');
const cancelCtx = baseCtx();
const cancelLane = registry.resolveReadCommand('cancel transfer', cancelCtx);
const cancelRender = await cancelLane.render(cancelCtx);
check(/nothing to cancel|transfer in progress/i.test(cancelRender.reply_message),
  'the guard answers honestly (nothing to cancel / dashboard cancel)');
const deleteCtx = baseCtx({
  session: { pendingEntryAction: { mode: 'delete', key: 'expense:1', vehicleId: 'v1', at: new Date().toISOString() } }
});
const guardLane = registry.resolveReadCommand('No. Delete last compliance', deleteCtx);
check(guardLane?.id === 'ledger_turn', 'a compliance delete request is owned by the ledger guard (never the model)');
const guardRender = await guardLane.render(deleteCtx);
check(/Compliance dates are facts on file/.test(guardRender.reply_message) && deleteCtx.session.pendingEntryAction === null,
  'the stale delete prompt is cleared and the compliance rule is spoken (v1.96.2)');

console.log(`\n🎉 ${passed} read-registry equivalence assertions passed.`);
