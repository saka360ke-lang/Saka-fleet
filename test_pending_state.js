/**
 * Saka Fleet — Unified pending state harness (Phase 4, v1.64.0)
 * -------------------------------------------------------------
 * Proves the PENDING_KINDS registry + resolvePendingTurn() reproduce TODAY'S
 * per-kind behaviour EXACTLY (zero behaviour change; the uniform fresh-log
 * override is PROP-2026-11-06-01 for a later release):
 *
 *   Test A  fresh-log truth table per kind (drops / yields / yields+clears /
 *           swallows), including the assignment-otp shape nuance and the
 *           preserved driver-assignment missing-cancel bug
 *           (PROP-2026-11-06-02).
 *   Test B  OTP / locked-phase precedence (codes always consumed; locked PIN
 *           outranks read-registry kinds; the no-quiz-guard quirks pinned).
 *   Test C  corrupt double-pending → priority order matches the old claim order.
 *   Test D  TTL expiry per kind + the deliberate no-TTL gates.
 *   Test E  differential replay: new resolver vs a FROZEN re-implementation of
 *           today's branch order (13 kinds × 12 texts + quiz-active gates).
 *   Test F  migration-on-read shim (legacy fields → one slot; otpDispatch stays
 *           in the quiz; accessor bridge write-through + priority).
 *
 * Pure unit suite: zero DB, zero network, no rows to clean.
 */

import {
  PENDING_KINDS,
  PENDING_KIND_KEYS,
  PENDING_PRIORITY,
  resolvePendingTurn,
  hydrateSessionPending,
  pickLegacyPending,
  isPendingExpired,
  pendingStartMs
} from './src/services/pendingState.js';
import { FLOW_GUIDANCE } from './src/services/flowKnowledge.js';
import { resolveLedgerTurn } from './src/services/entryAnswers.js';
import { resolveNarrativeBatchTurn } from './src/services/narrativeDraft.js';
import { looksLikeFreshLogLine } from './src/services/complianceCapture.js';
import fs from 'node:fs';

let pass = 0;
const failures = [];
function check(condition, message) {
  if (condition) {
    pass += 1;
  } else {
    failures.push(message);
    console.log(`  ❌ ${message}`);
  }
}

const NOW = Date.parse('2026-11-06T09:00:00+03:00');
const MIN = 60 * 1000;
const at = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
const freshLog = 'Logged 40L at 50350 km for 4,500';

function sessionWith(kind, data, overrides = {}) {
  return { history: [], lastActive: NOW, pending: { kind, data, at: at(0) }, ...overrides };
}

const FIXTURES = {
  'clear-chat': { data: true },
  'support-intake': { data: true },
  'entry-edit': { data: { mode: 'edit', key: 'expense:12', vehicleId: 'veh-1', at: at(0) } },
  'transfer-release-otp': { data: { step: 3, transferId: 'tr-1', vehicle: { plate_number: 'KDA 123A' } } },
  'assignment-otp': { data: { assignmentId: 'as-1', vehicleId: 'veh-1', driverPhone: '+254712345678', expiresAt: at(9 * MIN) } },
  'transfer-buyer-otp': { data: { transferId: 'tr-1' } },
  'cancel-subscription': { data: { requestedAt: NOW, trial: false } },
  'compliance-capture': { data: { scope: 'driver', type: 'psv_badge', number: null, expiry: null, at: at(0) } },
  'narrative-batch': { data: { drafts: [{ ok: true, kind: 'expense' }, { ok: true, kind: 'expense' }], at: at(0) } },
  'registration-draft': { data: { flowKey: 'vehicle_registration', answers: { asset_kind: 'vehicle' } } },
  'delete-vehicle': { data: { vehicleId: 'veh-1', plateNumber: 'KDA 123A' } },
  'driver-assignment': { data: { vehicleId: 'veh-1', plateNumber: 'KDA 123A' } },
  'account-deletion-otp': { data: { code: '123456', expiresAt: NOW + 9 * MIN } },
  'email-update-otp': { data: { newEmail: 'new@example.com', code: '123456', expiresAt: NOW + 9 * MIN } }
};

const SLOT_KINDS = PENDING_KIND_KEYS.filter((kind) => PENDING_KINDS[kind].slot !== false);

console.log('=== SAKA FLEET — UNIFIED PENDING STATE (v1.64.0) ===\n');
console.log('--- Registry invariants ---');
check(SLOT_KINDS.length === 14, `14 slot-owning kinds are registered (${SLOT_KINDS.length})`);
check(PENDING_PRIORITY.every((kind, i) => i === 0 || PENDING_KINDS[PENDING_PRIORITY[i - 1]].priority > PENDING_KINDS[kind].priority),
  'PENDING_PRIORITY is strictly descending (a corrupt double-set resolves deterministically)');
check(PENDING_KIND_KEYS.every((kind) => ['drops', 'yields', 'yields+clears', 'swallows', 'N/A'].includes(PENDING_KINDS[kind].freshLog)),
  'every kind declares a freshLog policy from the allowed vocabulary');
check(PENDING_KINDS['record-challenge'].slot === false && PENDING_KINDS['quiz-otp'].slot === false && PENDING_KINDS['onboarding-otp'].slot === false,
  'record-challenge / quiz-otp / onboarding-otp are documented but never occupy the slot');
check(PENDING_KINDS['record-challenge'].legacyField === 'lastRecordQuery',
  'the record-challenge memory maps to session.lastRecordQuery (not migrated — replay memory)');

// ---------------------------------------------------------------------------
// Test A — fresh-log truth table per kind (pinned, never generalised)
// ---------------------------------------------------------------------------
console.log('\n--- Test A: fresh-log policy per kind (today\'s truth table) ---');
for (const kind of SLOT_KINDS) {
  const def = PENDING_KINDS[kind];
  const session = sessionWith(kind, FIXTURES[kind].data);
  const result = resolvePendingTurn(session, freshLog, { now: NOW });
  check(Boolean(result) && result.kind === kind, `${kind}: the pending is resolved (not skipped)`);
  const observed = result.consumed
    ? 'swallows'
    : (session.pending ? 'yields' : (result.nextAction === 'drop-fresh-log' ? 'drops' : 'yields+clears'));
  check(observed === def.freshLog,
    `${kind}: declared freshLog='${def.freshLog}' matches today's observed '${observed}'`);
  if (def.freshLog === 'drops' || def.freshLog === 'yields+clears') {
    check(session.pending === null, `${kind}: the slot is cleared on the fresh-log turn`);
  } else if (def.freshLog === 'yields') {
    check(session.pending !== null, `${kind}: the slot survives the fresh-log turn (today's behaviour)`);
  } else {
    check(result.consumed === true, `${kind}: the pending owns the turn (swallows) — clearing is per-kind`);
  }
}

const deleteMode = sessionWith('entry-edit', { mode: 'delete', key: 'expense:12', at: at(0) });
const deleteRes = resolvePendingTurn(deleteMode, freshLog, { now: NOW });
check(deleteRes.consumed === false && deleteMode.pending !== null,
  'entry-edit delete-mode yields on a fresh log (the drop rule is edit-mode only — pinned nuance)');

const driverAssign = sessionWith('driver-assignment', FIXTURES['driver-assignment'].data);
const driverCancel = resolvePendingTurn(driverAssign, 'cancel', { now: NOW });
check(driverCancel.consumed === true && driverCancel.nextAction === 'reprompt' && driverAssign.pending !== null,
  "pendingDriverAssignment + 'cancel' → re-prompts (today's bug, PROP-2026-11-06-02)");

const assignFresh = sessionWith('assignment-otp', FIXTURES['assignment-otp'].data);
const assignFreshRes = resolvePendingTurn(assignFresh, freshLog, { now: NOW });
check(assignFreshRes.consumed === false && assignFreshRes.nextAction === 'yield',
  'assignment-otp is shape-gated: a fresh log line falls through to the normal pipeline');

// ---------------------------------------------------------------------------
// Test B — OTP / locked-phase precedence
// ---------------------------------------------------------------------------
console.log('\n--- Test B: OTP / locked-phase override ---');
check(looksLikeFreshLogLine('123456') === false, 'a bare 6-digit security code is never mistaken for a log line');

const otpCases = [
  ['transfer-release-otp', { step: 3, transferId: 'tr-1' }, 'release-otp'],
  ['assignment-otp', FIXTURES['assignment-otp'].data, 'otp-verify'],
  ['transfer-buyer-otp', FIXTURES['transfer-buyer-otp'].data, 'otp-verify'],
  ['account-deletion-otp', FIXTURES['account-deletion-otp'].data, 'otp-verify'],
  ['email-update-otp', FIXTURES['email-update-otp'].data, 'otp-verify']
];
for (const [kind, data, expected] of otpCases) {
  const session = sessionWith(kind, data);
  const result = resolvePendingTurn(session, '123456', { now: NOW });
  check(result.consumed === true && result.nextAction === expected,
    `${kind}: the 6-digit code is always consumed (${expected}), never treated as chat`);
}
check(PENDING_KINDS['onboarding-otp'].otp === true && PENDING_KINDS['onboarding-otp'].slot === false,
  'onboarding-otp is a documented OTP kind owned by onboardingStore (out of the slot, not migrated)');
check(PENDING_KINDS['quiz-otp'].otp === true && PENDING_KINDS['quiz-otp'].slot === false,
  'quiz-otp is a documented OTP kind owned by session.quiz (out of the slot, not migrated)');

const lockedEntry = sessionWith('entry-edit', FIXTURES['entry-edit'].data);
const lockedRes = resolvePendingTurn(lockedEntry, 'amount 4800', { now: NOW, quizPhaseLocked: true });
check(lockedRes.kind === 'quiz-otp' && lockedRes.consumed === true && lockedEntry.pending?.kind === 'entry-edit',
  'a locked PIN/account-OTP phase outranks entry-edit (skipWhenLocked) without destroying the pending');

const quirkAssignment = sessionWith('assignment-otp', FIXTURES['assignment-otp'].data);
const quirkRes = resolvePendingTurn(quirkAssignment, '123456', { now: NOW, quizPhaseLocked: true });
check(quirkRes.kind === 'assignment-otp' && quirkRes.consumed === true,
  "corrupt-state quirk pinned: assignment-otp has no !session.quiz guard today and still claims the code");

const quirkBuyer = sessionWith('transfer-buyer-otp', FIXTURES['transfer-buyer-otp'].data);
const quirkBuyerRes = resolvePendingTurn(quirkBuyer, 'anything', { now: NOW, quizPhaseLocked: true });
check(quirkBuyerRes.kind === 'transfer-buyer-otp' && quirkBuyerRes.consumed === true,
  'corrupt-state quirk pinned: transfer-buyer-otp has no !session.quiz guard today and still claims');

const quizGate = sessionWith('cancel-subscription', FIXTURES['cancel-subscription'].data, {
  quiz: { flow: 'log_expense', phase: 'question' }
});
const quizGateRes = resolvePendingTurn(quizGate, 'yes', { now: NOW });
check(quizGateRes === null && quizGate.pending !== null,
  'an open quiz gates cancel-subscription (today the ACTIVE chain never runs while a draft is active)');

// ---------------------------------------------------------------------------
// Test C — corrupt double-pending: priority order = today's claim order
// ---------------------------------------------------------------------------
console.log('\n--- Test C: corrupt double-pending priority ---');
function hydrateLegacy(legacy, now = NOW) {
  const session = { history: [], lastActive: now, ...legacy };
  hydrateSessionPending(session, { now });
  return session;
}

const doubleEntryCompliance = hydrateLegacy({
  pendingEntryAction: { mode: 'edit', key: 'expense:12', at: at(0) },
  pendingComplianceCapture: { scope: 'driver', type: 'psv_badge', at: at(0) }
});
check(doubleEntryCompliance.pending?.kind === 'entry-edit',
  'entry-edit (80) outranks compliance-capture (50) — the read registry claims before the capture lane');
check(doubleEntryCompliance.pendingComplianceCapture === null,
  'the losing compliance-capture is no longer reachable through its legacy name');

const doubleOtpCancel = hydrateLegacy({
  pendingAssignmentOtp: FIXTURES['assignment-otp'].data,
  pendingCancelSubscription: { requestedAt: NOW, trial: false }
});
check(doubleOtpCancel.pending?.kind === 'assignment-otp',
  'assignment-otp (65) outranks cancel-subscription (55) — OTP flow sits earlier in the chain');

const doubleDeleteAssign = hydrateLegacy({
  pendingDeleteVehicle: FIXTURES['delete-vehicle'].data,
  pendingDriverAssignment: FIXTURES['driver-assignment'].data
});
check(doubleDeleteAssign.pending?.kind === 'delete-vehicle',
  'delete-vehicle (40) outranks driver-assignment (35) — deletion gate runs first');

const doubleTransfer = hydrateLegacy({
  transferFlow: FIXTURES['transfer-release-otp'].data,
  pendingAssignmentOtp: FIXTURES['assignment-otp'].data
});
check(doubleTransfer.pending?.kind === 'transfer-release-otp',
  'transfer-release-otp (70) outranks assignment-otp (65) — transferFlow branch runs first');
const doubleTransferClaim = resolvePendingTurn(doubleTransfer, '123456', { now: NOW, quizPhaseLocked: true });
check(doubleTransferClaim.kind === 'transfer-release-otp' && doubleTransferClaim.consumed === true,
  "corrupt-state quirk pinned: transferFlow has no !session.quiz guard today and still claims");

const doubleClearSupport = hydrateLegacy({ pendingClearChat: true, pendingSupportEscalation: true });
check(doubleClearSupport.pending?.kind === 'clear-chat',
  'clear-chat (100) outranks support-intake (95) — the clear confirmation is the first branch');

const staleHighLiveLow = hydrateLegacy({
  pendingEntryAction: { mode: 'edit', key: 'expense:12', at: at(-20 * MIN) },
  pendingComplianceCapture: { scope: 'driver', type: 'psv_badge', at: at(0) }
});
check(staleHighLiveLow.pending?.kind === 'compliance-capture',
  'an expired higher-priority pending is dropped; the live lower-priority one survives');

// ---------------------------------------------------------------------------
// Test D — TTL expiry per kind (and the deliberate no-TTL gates)
// ---------------------------------------------------------------------------
console.log('\n--- Test D: TTL expiry ---');
check(PENDING_KINDS['entry-edit'].ttlMs === 15 * MIN && PENDING_KINDS['compliance-capture'].ttlMs === 15 * MIN
  && PENDING_KINDS['narrative-batch'].ttlMs === 15 * MIN, 'the 15-minute family is declared (entry/compliance/narrative)');
check(PENDING_KINDS['assignment-otp'].ttlMs === 10 * MIN && PENDING_KINDS['email-update-otp'].ttlMs === 10 * MIN
  && PENDING_KINDS['transfer-release-otp'].ttlMs === 10 * MIN, 'the 10-minute OTP family is declared');

for (const kind of SLOT_KINDS) {
  const def = PENDING_KINDS[kind];
  if (!def.ttlMs) continue;
  const session = sessionWith(kind, FIXTURES[kind].data);
  session.pending.at = new Date(NOW - def.ttlMs - MIN).toISOString();
  const result = resolvePendingTurn(session, 'yes', { now: NOW });
  check(result?.kind === kind && result.consumed === false && result.nextAction === 'ttl-expired',
    `${kind}: an expired pending is dropped (ttl-expired)`);
  check(session.pending === null, `${kind}: expiry clears the slot`);
}

for (const kind of SLOT_KINDS) {
  if (PENDING_KINDS[kind].ttlMs) continue;
  const session = sessionWith(kind, FIXTURES[kind].data);
  session.pending.at = at(-30 * 24 * 60 * MIN);
  const before = session.pending;
  const result = resolvePendingTurn(session, 'hello', { now: NOW });
  check(Boolean(result) && result.nextAction !== 'ttl-expired',
    `${kind}: no TTL by design (a 30-day-old pending still resolves — pinned)`);
  check(isPendingExpired(before, NOW) === false, `${kind}: isPendingExpired() is false without a ttlMs`);
}

// ---------------------------------------------------------------------------
// Test E — differential replay vs the FROZEN legacy chain (today's order)
// ---------------------------------------------------------------------------
console.log('\n--- Test E: differential replay (new resolver vs frozen legacy chain) ---');

const clone = (value) => JSON.parse(JSON.stringify(value));

const LEGACY_FIELDS = {
  'clear-chat': { pendingClearChat: true },
  'support-intake': { pendingSupportEscalation: true },
  'entry-edit': { pendingEntryAction: { mode: 'edit', key: 'expense:12', at: at(0) } },
  'transfer-release-otp': { transferFlow: { step: 3, transferId: 'tr-1', vehicle: { plate_number: 'KDA 123A' } } },
  'assignment-otp': { pendingAssignmentOtp: FIXTURES['assignment-otp'].data },
  'transfer-buyer-otp': { pendingTransferBuyerOtp: { transferId: 'tr-1' } },
  'cancel-subscription': { pendingCancelSubscription: { requestedAt: NOW, trial: false } },
  'compliance-capture': { pendingComplianceCapture: { scope: 'driver', type: 'psv_badge', at: at(0) } },
  'narrative-batch': { narrativeBatch: { drafts: [{}, {}], at: at(0) } },
  'delete-vehicle': { pendingDeleteVehicle: FIXTURES['delete-vehicle'].data },
  'driver-assignment': { pendingDriverAssignment: FIXTURES['driver-assignment'].data },
  'account-deletion-otp': { pendingAccountDeletion: { code: '123456', expiresAt: NOW + 9 * MIN } },
  'email-update-otp': { pendingEmailUpdate: { newEmail: 'new@example.com', code: '123456', expiresAt: NOW + 9 * MIN } }
};

/**
 * FROZEN re-implementation of the v1.63.3 claim order and gates. Returns the
 * kind that OWNS the turn (or null when the message proceeds normally).
 */
function legacyClaim(legacy, text, { now = NOW, quizPhaseLocked = false } = {}) {
  const t = String(text || '').trim();
  const hasQuiz = Boolean(legacy.quiz);

  // L991 clear-chat confirmation: only CLEAR/cancel answers claim; anything else clears and continues.
  if (legacy.pendingClearChat) {
    return (/^clear$/i.test(t) || /^(cancel|no|stop)$/i.test(t)) ? 'clear-chat' : null;
  }
  // L1035 support intake (before the read registry, before the quiz).
  if (legacy.pendingSupportEscalation) return 'support-intake';
  // L1558 read registry: ledger_turn (skipWhenLocked).
  if (!quizPhaseLocked && legacy.pendingEntryAction
      && resolveLedgerTurn({ pending: legacy.pendingEntryAction, text: t, now: new Date(now) }).type !== 'none') {
    return 'entry-edit';
  }
  // L1732 transferFlow (no !session.quiz guard).
  if (legacy.transferFlow) return 'transfer-release-otp';
  // L1835 owner assignment OTP (shape-gated, no !session.quiz guard).
  if (legacy.pendingAssignmentOtp
      && (/^\d{6}$/.test(t) || /^(resend|resend code|new code|send again)$/i.test(t) || /^(cancel|exit|stop)$/i.test(t))) {
    return 'assignment-otp';
  }
  // L1908 buyer email OTP. Only the PENDING part is a pending claim; the
  // stateless 6-digit sink (`messageText.match(/^\d{6}$/) && no quiz/...`) is a
  // kept-inline route lane for Phase 5, NOT a pending — pinned separately below.
  if (legacy.pendingTransferBuyerOtp) return 'transfer-buyer-otp';
  // L1972 subscription lane (guarded by !session.quiz / !delete / !account).
  if (!hasQuiz && !legacy.pendingDeleteVehicle && !legacy.pendingAccountDeletion && legacy.pendingCancelSubscription) {
    return 'cancel-subscription';
  }
  // L2094 compliance capture (guarded by !session.quiz; fresh-log guard).
  if (!hasQuiz && legacy.pendingComplianceCapture && !looksLikeFreshLogLine(t)) {
    return 'compliance-capture';
  }
  // L2429 narrative batch (runs before the quiz turn).
  if (legacy.narrativeBatch && resolveNarrativeBatchTurn({ batch: legacy.narrativeBatch, text: t, now }).type !== 'none') {
    return 'narrative-batch';
  }
  // L2508 quiz turn — a locked phase consumes the security code.
  if (quizPhaseLocked) return 'quiz-otp';
  // L3061 ACTIVE chain — never reached while a quiz draft owns the turn.
  if (hasQuiz) return null;
  if (legacy.pendingDeleteVehicle) return 'delete-vehicle';
  if (legacy.pendingDriverAssignment) return 'driver-assignment';
  if (legacy.pendingAccountDeletion) return 'account-deletion-otp';
  if (legacy.pendingEmailUpdate) return 'email-update-otp';
  return null;
}

const TEXTS = [
  freshLog, 'yes', 'no', 'cancel', 'clear', 'my entries', '1', 'save all',
  'edit 1', '123456', 'PSV badge 445566 expires 8 Aug 2027', '+254712345678 user@example.com'
];

let differential = 0;
// v1.96.7 — registration-draft did not exist in the frozen v1.63.3 legacy chain,
// so it has no differential counterpart; its behaviour is pinned directly in E2.
const LEGACY_EXEMPT = new Set(['registration-draft']);
for (const kind of SLOT_KINDS.filter((k) => !LEGACY_EXEMPT.has(k))) {
  for (const text of TEXTS) {
    const newSession = sessionWith(kind, clone(FIXTURES[kind].data));
    const newResult = resolvePendingTurn(newSession, text, { now: NOW });
    const newOwns = newResult?.consumed ? newResult.kind : null;

    const legacySession = { state: 'ACTIVE', history: [], lastActive: NOW, ...clone(LEGACY_FIELDS[kind]) };
    const legacyOwns = legacyClaim(legacySession, text, { now: NOW });

    check(newOwns === legacyOwns,
      `differential [${kind}] "${text.slice(0, 34)}": new=${newOwns} legacy=${legacyOwns}`);
    differential += 1;
  }
}

// Quiz-active pass: the ACTIVE-chain kinds are gated by the open draft; the
// earlier lanes (support / registry / OTP / batch) stay transparent.
const QUIZ_GATED = ['cancel-subscription', 'compliance-capture', 'delete-vehicle', 'driver-assignment', 'account-deletion-otp', 'email-update-otp'];
const QUIZ_TRANSPARENT = ['support-intake', 'entry-edit', 'transfer-release-otp', 'assignment-otp', 'transfer-buyer-otp', 'narrative-batch'];
for (const kind of [...QUIZ_GATED, ...QUIZ_TRANSPARENT]) {
  for (const text of TEXTS) {
    const newSession = sessionWith(kind, clone(FIXTURES[kind].data), { quiz: { flow: 'log_expense', phase: 'question' } });
    const newResult = resolvePendingTurn(newSession, text, { now: NOW });
    const newOwns = newResult?.consumed ? newResult.kind : null;

    const legacySession = { state: 'ACTIVE', history: [], lastActive: NOW, quiz: { flow: 'log_expense', phase: 'question' }, ...clone(LEGACY_FIELDS[kind]) };
    const legacyOwns = legacyClaim(legacySession, text, { now: NOW });

    check(newOwns === legacyOwns,
      `differential+quiz [${kind}] "${text.slice(0, 30)}": new=${newOwns} legacy=${legacyOwns}`);
    differential += 1;
  }
}
check(differential >= 220, `the differential matrix replays ${differential} turns (>= 220)`);

// E2 — v1.96.7 registration-draft (the plate escape hatch's parked draft).
const draftYield = resolvePendingTurn(sessionWith('registration-draft', FIXTURES['registration-draft'].data), freshLog, { now: NOW });
check(draftYield?.kind === 'registration-draft' && draftYield.consumed === false,
  'registration-draft yields to a fresh log line (the log is never swallowed)');
const draftSurvive = sessionWith('registration-draft', FIXTURES['registration-draft'].data);
resolvePendingTurn(draftSurvive, freshLog, { now: NOW });
check(draftSurvive.pending !== null, 'the parked registration draft survives a fresh log turn');
const draftCancel = resolvePendingTurn(sessionWith('registration-draft', FIXTURES['registration-draft'].data), 'cancel', { now: NOW });
check(draftCancel?.consumed === true && draftCancel.nextAction === 'cancel', 'registration-draft is cleared by cancel/discard');
const draftQuizGate = sessionWith('registration-draft', FIXTURES['registration-draft'].data, { quiz: { flow: 'log_expense', phase: 'question' } });
check(resolvePendingTurn(draftQuizGate, 'KDA 123A', { now: NOW }) === null && draftQuizGate.pending !== null,
  'an open quiz outranks the parked registration draft without destroying it');

// Deliberate kept-inline lane pin (rule 51): a bare 6-digit message still falls
// into the stateless buyer-OTP sink today, even while another pending is set.
// Phase 4 does not move it; Phase 5 must keep its position before any rewiring.
const routeSource = fs.readFileSync('src/routes/whatsapp/messages.js', 'utf8');
check(routeSource.includes('session.pendingTransferBuyerOtp || (messageText.trim().match(/^\\d{6}$/)'),
  'kept-inline pin: the stateless 6-digit buyer-OTP sink is still in the route (not a pending, not migrated)');

// ---------------------------------------------------------------------------
// Test F — migration-on-read shim (must-test: old snapshots keep their pending)
// ---------------------------------------------------------------------------
console.log('\n--- Test F: migration-on-read shim ---');

// F1 — legacy pendingEntryAction → entry-edit
const legacyEntry = {
  history: [],
  lastActive: NOW,
  pendingEntryAction: { mode: 'edit', key: 'expense:12', vehicleId: 'veh-1', at: at(0) }
};
hydrateSessionPending(legacyEntry, { now: NOW });
check(legacyEntry.pending?.kind === 'entry-edit' && legacyEntry.pending.data.key === 'expense:12',
  'F1: legacy pendingEntryAction becomes { kind: entry-edit } in the slot');
check(legacyEntry.pendingEntryAction?.key === 'expense:12',
  'F1: the legacy name still reads the migrated value (branch code untouched)');
check(!Object.keys(legacyEntry).includes('pendingEntryAction'),
  'F1: the legacy own property is removed (the snapshot stores ONE pending)');
const entrySnapshot = JSON.parse(JSON.stringify(legacyEntry));
check(entrySnapshot.pending?.kind === 'entry-edit' && entrySnapshot.pendingEntryAction === undefined,
  'F1: the persisted JSON carries session.pending only (no legacy key)');
const entryReload = hydrateSessionPending(entrySnapshot, { now: NOW });
check(entryReload.pending?.kind === 'entry-edit' && entryReload.pendingEntryAction?.vehicleId === 'veh-1',
  'F1: a reloaded snapshot restores the slot AND the legacy accessor');

// F2 — legacy pendingSupportEscalation → support-intake
const legacySupport = { history: [], lastActive: NOW, pendingSupportEscalation: true };
hydrateSessionPending(legacySupport, { now: NOW });
check(legacySupport.pending?.kind === 'support-intake' && legacySupport.pending.data === true,
  'F2: legacy pendingSupportEscalation becomes { kind: support-intake }');
check(legacySupport.pendingSupportEscalation === true, 'F2: the boolean accessor reads true from the slot');
legacySupport.pendingSupportEscalation = false;
check(legacySupport.pending === null, 'F2: the legacy clear writes through and releases the slot');

// F3 — otpDispatch stays inside session.quiz (documented, NOT migrated)
const legacyOtp = {
  history: [],
  lastActive: NOW,
  quiz: {
    flow: 'driver_onboarding',
    phase: 'account_otp',
    otp: { code: '123456', expiresAt: NOW + 9 * MIN },
    otpDispatch: { status: 'sent', target: 'driver@example.com', purpose: 'driver_onboarding', attemptedAt: NOW },
    otpDispatchAttempts: 1
  }
};
hydrateSessionPending(legacyOtp, { now: NOW });
check(legacyOtp.quiz?.otpDispatch?.status === 'sent' && legacyOtp.quiz?.otp?.code === '123456',
  'F3: otpDispatch stays intact inside session.quiz (security state is out of the pending slot)');
check(PENDING_KINDS['quiz-otp'].slot === false && PENDING_KINDS['quiz-otp'].legacyField === null,
  'F3: the registry documents quiz-otp as not migrated (owner: session.quiz)');
check(!legacyOtp.pending, 'F3: no phantom slot value is created from quiz OTP state');

// Bridge write-through + priority (today's claim order on collisions)
const bridge = hydrateSessionPending({ history: [] }, { now: NOW });
check(bridge.pending === undefined, 'bridge: a new session starts with an empty slot');
bridge.pendingEntryAction = { mode: 'edit', key: 'expense:1', at: at(0) };
check(bridge.pending?.kind === 'entry-edit', 'bridge: a legacy write creates the unified slot value');
bridge.pendingComplianceCapture = { scope: 'driver', type: 'psv_badge', at: at(0) };
check(bridge.pending?.kind === 'entry-edit' && bridge.pendingComplianceCapture === null,
  'bridge: a lower-priority write cannot evict entry-edit (priority = claim order)');
bridge.pendingSupportEscalation = true;
check(bridge.pending?.kind === 'support-intake', 'bridge: support-intake (95) evicts entry-edit (80)');
bridge.pendingSupportEscalation = false;
check(bridge.pending === null, 'bridge: clearing the boolean releases the slot');
bridge.pendingCancelSubscription = { requestedAt: NOW, trial: false };
check(bridge.pendingCancelSubscription?.requestedAt === NOW, 'bridge: object data round-trips through the accessor');
bridge.pendingCancelSubscription = null;
check(bridge.pending === null && bridge.pendingCancelSubscription === null, 'bridge: null clears only its own kind');

const picked = pickLegacyPending({
  pendingEntryAction: { mode: 'edit', at: at(0) },
  pendingComplianceCapture: { scope: 'driver', type: 'psv_badge', at: at(0) }
}, NOW);
check(picked?.kind === 'entry-edit', 'pickLegacyPending chooses the higher-priority legacy field');
check(pendingStartMs({ at: at(0) }) === NOW, 'pendingStartMs reads the slot stamp');

// ---------------------------------------------------------------------------
// Test G — rule 60 guidance per pending kind
// ---------------------------------------------------------------------------
console.log('\n--- Test G: stuck guidance per kind (rule 60) ---');
for (const kind of PENDING_KIND_KEYS) {
  check(Boolean(FLOW_GUIDANCE[kind]), `FLOW_GUIDANCE has an entry for '${kind}'`);
}
check(Object.keys(FLOW_GUIDANCE).length > 21, 'the guidance registry grew with the pending kinds');

console.log(`\n${pass} assertions passed, ${failures.length} failed`);
if (failures.length) {
  for (const message of failures.slice(0, 10)) console.log(`FAILED: ${message}`);
  process.exit(1);
}
console.log('✅ ALL UNIFIED PENDING STATE TESTS PASSED (v1.64.0).');





