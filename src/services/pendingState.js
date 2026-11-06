/**
 * Saka Fleet — Unified pending state (Phase 4, v1.64.0)
 * -----------------------------------------------------
 * Before this module, a chat session carried 12+ independent "pending"
 * interaction fields (pendingEntryAction, pendingSupportEscalation,
 * pendingComplianceCapture, narrativeBatch, pendingAssignmentOtp,
 * pendingTransferBuyerOtp, pendingCancelSubscription, pendingClearChat,
 * pendingDeleteVehicle, pendingDriverAssignment, pendingEmailUpdate,
 * pendingAccountDeletion, transferFlow). Each owned its own TTL rule, its own
 * fresh-log guard and its own if/else branch — the section 152 / 169 friction
 * class ("a pending support intake swallowed a quiz", "a draft correction
 * became a saved edit").
 *
 * Phase 4 is a PURE STRUCTURAL refactor with ZERO behaviour change:
 *
 *   1. ONE state object:            session.pending = { kind, data, at }
 *   2. ONE registry:                PENDING_KINDS (TTL, priority, fresh-log
 *                                   policy, quiz parking, OTP flag, legacy
 *                                   field name)
 *   3. ONE resolver:                resolvePendingTurn(session, text, ctx)
 *   4. ONE migration-on-read shim:  hydrateSessionPending(session)
 *
 * The route keeps its existing branch code during Phase 4; every legacy field
 * (`session.pendingEntryAction`, …) is a non-enumerable accessor over the ONE
 * `session.pending` slot, so the physical state is already unified while the
 * dispatch order is untouched. `resolvePendingTurn()` is the tested contract
 * that Phase 5's branch collapse will call. The frozen legacy chain in
 * `test_pending_state.js` proves both agree on every fixture.
 *
 * TRUTH TABLE (pinned, not generalised — the uniform fresh-log override is
 * PROP-2026-11-06-01 for a later release):
 *
 *   freshLog:
 *     'drops'         a fresh log line clears the pending and the log is
 *                     processed (entry-edit, edit mode).
 *     'yields'        the log is processed; the pending SURVIVES until TTL or
 *                     its next answer (compliance-capture, narrative-batch).
 *     'yields+clears' the log is processed and the pending is cleared
 *                     (clear-chat).
 *     'swallows'      the pending owns the turn; the log text is treated as
 *                     its answer (support-intake, confirm gates, most OTP
 *                     gates, cancel-subscription, driver-assignment).
 *     'N/A'           not a turn-owning pending (record-challenge memory).
 *
 * `priority` reproduces today's route claim order (higher claims first).
 * `blockedByQuizLock` mirrors `skipWhenLocked` (read-registry lanes only).
 * `otp: true` marks a security-code gate that a fresh log never overrides
 * (assignment-otp is shape-gated in today's code: only a 6-digit/resend/cancel
 * message is consumed, other text falls through — pinned by the harness).
 */

import { resolveLedgerTurn } from './entryAnswers.js';
import { resolveNarrativeBatchTurn } from './narrativeDraft.js';
import { looksLikeFreshLogLine, isComplianceCaptureCancel } from './complianceCapture.js';

const TTL_15M = 15 * 60 * 1000;
const TTL_10M = 10 * 60 * 1000;

/**
 * The ONE registry. `slot: false` rows are documented members of the pending
 * family that do NOT occupy `session.pending` in Phase 4:
 *   - record-challenge lives on `session.lastRecordQuery` (a replay memory, not
 *     a turn-owning pending — migrating it would evict real pendings).
 *   - quiz-otp lives inside `session.quiz` (phase + state.otp/otpDispatch).
 *   - onboarding-otp lives in `onboardingStore` (state.onboarding.pending_otp).
 */
export const PENDING_KINDS = Object.freeze({
  'clear-chat': Object.freeze({
    ttlMs: null, priority: 100, freshLog: 'yields+clears', parksQuiz: false,
    blockedByQuizLock: false, otp: false, slot: true, boolean: true,
    legacyField: 'pendingClearChat'
  }),
  'support-intake': Object.freeze({
    ttlMs: null, priority: 95, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, otp: false, slot: true, boolean: true,
    legacyField: 'pendingSupportEscalation'
  }),
  'entry-edit': Object.freeze({
    ttlMs: TTL_15M, priority: 80, freshLog: 'drops', parksQuiz: true,
    blockedByQuizLock: true, otp: false, slot: true, boolean: false,
    legacyField: 'pendingEntryAction'
  }),
  'record-challenge': Object.freeze({
    ttlMs: TTL_15M, priority: 75, freshLog: 'N/A', parksQuiz: true,
    blockedByQuizLock: true, otp: false, slot: false, boolean: false,
    legacyField: 'lastRecordQuery'
  }),
  'transfer-release-otp': Object.freeze({
    ttlMs: TTL_10M, priority: 70, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, otp: true, slot: true, boolean: false,
    legacyField: 'transferFlow'
  }),
  'assignment-otp': Object.freeze({
    ttlMs: TTL_10M, priority: 65, freshLog: 'yields', parksQuiz: false,
    blockedByQuizLock: false, otp: true, slot: true, boolean: false,
    legacyField: 'pendingAssignmentOtp'
  }),
  'transfer-buyer-otp': Object.freeze({
    ttlMs: TTL_10M, priority: 60, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, otp: true, slot: true, boolean: false,
    legacyField: 'pendingTransferBuyerOtp'
  }),
  'cancel-subscription': Object.freeze({
    ttlMs: null, priority: 55, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, blockedByQuiz: true, otp: false, slot: true, boolean: false,
    legacyField: 'pendingCancelSubscription'
  }),
  'compliance-capture': Object.freeze({
    ttlMs: TTL_15M, priority: 50, freshLog: 'yields', parksQuiz: false,
    blockedByQuizLock: false, blockedByQuiz: true, otp: false, slot: true, boolean: false,
    legacyField: 'pendingComplianceCapture'
  }),
  'narrative-batch': Object.freeze({
    ttlMs: TTL_15M, priority: 45, freshLog: 'yields', parksQuiz: false,
    blockedByQuizLock: false, otp: false, slot: true, boolean: false,
    legacyField: 'narrativeBatch'
  }),
  'delete-vehicle': Object.freeze({
    ttlMs: null, priority: 40, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, blockedByQuiz: true, otp: false, slot: true, boolean: false,
    legacyField: 'pendingDeleteVehicle'
  }),
  'driver-assignment': Object.freeze({
    // TODO(PROP-2026-11-06-02): pendingDriverAssignment does not honour
    // "cancel" — real bug; preserved here for the Phase 4 refactor, tracked
    // for a dedicated release.
    ttlMs: null, priority: 35, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, blockedByQuiz: true, otp: false, slot: true, boolean: false,
    legacyField: 'pendingDriverAssignment'
  }),
  'account-deletion-otp': Object.freeze({
    ttlMs: TTL_10M, priority: 30, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, blockedByQuiz: true, otp: true, slot: true, boolean: false,
    legacyField: 'pendingAccountDeletion'
  }),
  'email-update-otp': Object.freeze({
    ttlMs: TTL_10M, priority: 25, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, blockedByQuiz: true, otp: true, slot: true, boolean: false,
    legacyField: 'pendingEmailUpdate'
  }),
  'onboarding-otp': Object.freeze({
    ttlMs: TTL_10M, priority: 20, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: false, otp: true, slot: false, boolean: false,
    legacyField: null
  }),
  'quiz-otp': Object.freeze({
    ttlMs: TTL_10M, priority: null, freshLog: 'swallows', parksQuiz: false,
    blockedByQuizLock: true, otp: true, slot: false, boolean: false,
    legacyField: null
  })
});

export const PENDING_KIND_KEYS = Object.freeze(Object.keys(PENDING_KINDS));

/** Slot-owning kinds in claim order (highest priority first). */
export const PENDING_PRIORITY = Object.freeze(
  PENDING_KIND_KEYS
    .filter((kind) => PENDING_KINDS[kind].slot !== false)
    .sort((a, b) => PENDING_KINDS[b].priority - PENDING_KINDS[a].priority)
);

const BRIDGE_MARK = Symbol.for('saka.pendingBridge');

function toMs(value) {
  if (value === null || value === undefined) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Start stamp of a pending (never data.expiresAt — that is a deadline). */
export function pendingStartMs(pending) {
  if (!pending) return NaN;
  const candidates = [pending.at, pending.data?.at, pending.data?.requestedAt];
  for (const candidate of candidates) {
    const ms = toMs(candidate);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

export function isPendingExpired(pending, now = Date.now()) {
  const def = pending ? PENDING_KINDS[pending.kind] : null;
  if (!def || !def.ttlMs) return false;
  const at = pendingStartMs(pending);
  if (!Number.isFinite(at)) return false;
  return Number(now) - at > def.ttlMs;
}

function outcome(kind, consumed, nextAction) {
  return { kind, consumed, nextAction };
}

/**
 * Resolve the pending interaction (if any) that owns this turn.
 *
 * @returns {{ kind: string, consumed: boolean, nextAction: string } | null}
 *   null            — no pending owns the turn (normal pipeline).
 *   consumed:true   — the pending claims the message (`nextAction` names its handler).
 *   consumed:false  — the message proceeds normally; the action says what
 *                     happened to the pending (`drop-fresh-log`, `yield`,
 *                     `clear-and-continue`, `ttl-expired`).
 *
 * ctx: { now?: number, quizPhaseLocked?: boolean, hasQuiz?: boolean }
 */
export function resolvePendingTurn(session, text = '', ctx = {}) {
  if (!session || typeof session !== 'object') return null;
  const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  const hasQuiz = ctx.hasQuiz !== undefined ? Boolean(ctx.hasQuiz) : Boolean(session.quiz);
  const quizPhaseLocked = Boolean(ctx.quizPhaseLocked);
  const clean = String(text || '');
  const trimmed = clean.trim();

  let pending = session.pending && PENDING_KINDS[session.pending.kind] ? session.pending : null;
  if (session.pending && !pending) session.pending = null; // unknown shape: never owns a turn

  if (pending && isPendingExpired(pending, now)) {
    session.pending = null;
    return outcome(pending.kind, false, 'ttl-expired');
  }

  if (pending) {
    const def = PENDING_KINDS[pending.kind];
    if (!(def.blockedByQuizLock && quizPhaseLocked) && !(def.blockedByQuiz && hasQuiz)) {
      return resolveActiveKind({ session, pending, def, text: clean, trimmed, now, hasQuiz });
    }
  }

  // A locked PIN/account-OTP phase is the security gate; today the read lanes
  // skip it and the quiz consumes the turn.
  if (quizPhaseLocked) return outcome('quiz-otp', true, 'quiz-otp-turn');
  return null;
}

function resolveActiveKind({ session, pending, def, text, trimmed, now, hasQuiz }) {
  const kind = pending.kind;
  const data = pending.data;
  const lower = trimmed.toLowerCase();
  const clear = () => { session.pending = null; };

  switch (kind) {
    case 'clear-chat': {
      if (/^clear$/i.test(trimmed)) { clear(); return outcome(kind, true, 'confirm'); }
      if (/^(cancel|no|stop)$/i.test(trimmed)) { clear(); return outcome(kind, true, 'cancel'); }
      // Today's `else` clears the confirmation and CONTINUES processing.
      clear();
      return outcome(kind, false, 'clear-and-continue');
    }

    case 'support-intake': {
      if (/^(cancel|exit|stop)$/i.test(trimmed)) { clear(); return outcome(kind, true, 'cancel'); }
      clear();
      return outcome(kind, true, 'capture-issue'); // one-shot: owns the next turn
    }

    case 'entry-edit': {
      const turn = resolveLedgerTurn({ pending: data, text, now: new Date(now) });
      if (turn.dropPending) { clear(); return outcome(kind, false, 'drop-fresh-log'); }
      if (turn.type === 'cancel') { clear(); return outcome(kind, true, 'cancel'); }
      if (turn.type === 'delete-confirm') { clear(); return outcome(kind, true, 'delete-confirm'); }
      if (turn.type === 'edit-apply') { clear(); return outcome(kind, true, 'apply-edit'); }
      if (turn.type === 'select') return outcome(kind, true, 'select');
      if (turn.type === 'command') return outcome(kind, true, 'command');
      return outcome(kind, false, 'yield');
    }

    case 'record-challenge':
      // Registry-only: the replay memory never occupies the slot.
      return outcome(kind, false, 'yield');

    case 'transfer-release-otp': {
      if (/^(cancel|exit|stop|cancel transfer)$/i.test(trimmed)) { clear(); return outcome(kind, true, 'cancel'); }
      if (Number(data?.step) === 2) {
        const hasPhone = /\+?[0-9]{9,15}/.test(trimmed);
        const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(trimmed);
        if (hasPhone && hasEmail) return outcome(kind, true, 'buyer-details');
        return outcome(kind, true, 'reprompt');
      }
      if (/\b\d{6}\b/.test(trimmed)) return outcome(kind, true, 'release-otp');
      return outcome(kind, true, 'reprompt');
    }

    case 'assignment-otp': {
      if (/^(cancel|exit|stop)$/i.test(trimmed)) { clear(); return outcome(kind, true, 'cancel'); }
      if (/^(resend|resend code|new code|send again)$/i.test(trimmed)) return outcome(kind, true, 'resend');
      if (/^\d{6}$/.test(trimmed)) return outcome(kind, true, 'otp-verify');
      // Shape-gated in today's route: any other text falls through untouched.
      return outcome(kind, false, 'yield');
    }

    case 'transfer-buyer-otp': {
      if (/^\d{6}$/.test(trimmed)) return outcome(kind, true, 'otp-verify');
      // Today every message enters the buyer-OTP branch while this is set.
      return outcome(kind, true, 'reprompt');
    }

    case 'cancel-subscription': {
      if (/^(yes|y|confirm|do it|cancel it)$/i.test(lower)) { clear(); return outcome(kind, true, 'confirm'); }
      if (/^(no|n|keep|stop|abort|never mind)$/i.test(lower)) { clear(); return outcome(kind, true, 'cancel'); }
      if (/\b(annual|yearly|year)\b/i.test(lower)) { clear(); return outcome(kind, true, 'annual'); }
      return outcome(kind, true, 'reprompt');
    }

    case 'compliance-capture': {
      // Truth table: 'yields' — a fresh log line is processed and the pending
      // SURVIVES (today's guard skips the capture block without clearing it).
      if (looksLikeFreshLogLine(trimmed)) return outcome(kind, false, 'yield');
      // The capture lane is !session.quiz-gated today; with a quiz open the
      // quiz owns the turn and the capture lingers.
      if (hasQuiz) return outcome(kind, false, 'yield');
      if (isComplianceCaptureCancel(trimmed)) { clear(); return outcome(kind, true, 'cancel'); }
      return outcome(kind, true, 'capture-answer');
    }

    case 'narrative-batch': {
      const turn = resolveNarrativeBatchTurn({ batch: data, text: trimmed, now });
      if (turn.dropBatch) {
        clear();
        if (turn.type === 'cancel') return outcome(kind, true, 'cancel');
        if (turn.type === 'edit') return outcome(kind, true, 'edit-row');
        return outcome(kind, false, 'ttl-expired');
      }
      if (turn.type === 'save-all') { clear(); return outcome(kind, true, 'save-all'); }
      if (turn.type === 'invalid-edit') return outcome(kind, true, 'reprompt');
      return outcome(kind, false, 'yield');
    }

    case 'delete-vehicle': {
      if (/^(yes|y|confirm|delete|proceed)$/i.test(trimmed)) { clear(); return outcome(kind, true, 'confirm'); }
      if (/^(cancel|exit|stop|no|abort)$/i.test(trimmed)) { clear(); return outcome(kind, true, 'cancel'); }
      return outcome(kind, true, 'reprompt');
    }

    case 'driver-assignment': {
      const phone = trimmed.match(/(?:\+?254|0)[17]\d{8}|\+?\d{9,15}/);
      if (phone) { clear(); return outcome(kind, true, 'capture-phone'); }
      // PROP-2026-11-06-02: 'cancel' is NOT honoured here today (re-prompts).
      return outcome(kind, true, 'reprompt');
    }

    case 'account-deletion-otp':
    case 'email-update-otp': {
      if (/^(cancel|exit|stop)$/i.test(trimmed)) { clear(); return outcome(kind, true, 'cancel'); }
      const code = /^\d{6}$/.test(trimmed) ? trimmed : null;
      const expected = data?.code ? String(data.code) : null;
      const deadline = toMs(data?.expiresAt);
      if (code && expected && code === expected && Number.isFinite(deadline) && now <= deadline) {
        clear();
        return outcome(kind, true, 'otp-verify');
      }
      return outcome(kind, true, 'reprompt');
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Migration-on-read shim + legacy accessor bridge
// ---------------------------------------------------------------------------

function legacyStampMs(kind, def, raw, now) {
  const direct = toMs(raw?.at) ?? toMs(raw?.requestedAt);
  if (Number.isFinite(direct)) return direct;
  const deadline = toMs(raw?.expiresAt);
  if (Number.isFinite(deadline) && def.ttlMs) return deadline - def.ttlMs;
  return Number(now);
}

/**
 * Choose the ONE legacy pending that survives migration. Collisions follow the
 * claim order (priority); expired candidates are dropped (today they are dead
 * weight that every resolver ignores). `record-challenge` is deliberately not
 * migrated — it is a replay memory, not a turn-owning pending.
 */
export function pickLegacyPending(session, now = Date.now()) {
  const candidates = [];
  for (const kind of PENDING_PRIORITY) {
    const def = PENDING_KINDS[kind];
    if (!def.legacyField) continue;
    const raw = session[def.legacyField];
    if (def.boolean ? raw !== true : (!raw || typeof raw !== 'object')) continue;
    const at = legacyStampMs(kind, def, raw, now);
    if (def.ttlMs && Number(now) - at > def.ttlMs) continue;
    candidates.push({ kind, data: def.boolean ? true : raw, at: new Date(at).toISOString() });
  }
  candidates.sort((a, b) => PENDING_KINDS[b.kind].priority - PENDING_KINDS[a.kind].priority);
  return candidates[0] || null;
}

function stripLegacyOwnProps(session) {
  for (const kind of PENDING_KIND_KEYS) {
    const def = PENDING_KINDS[kind];
    if (!def.legacyField) continue;
    const descriptor = Object.getOwnPropertyDescriptor(session, def.legacyField);
    if (descriptor && !descriptor.get && descriptor.configurable !== false) {
      delete session[def.legacyField];
    }
  }
}

function readLegacy(session, kind, def) {
  const current = session.pending;
  if (def.boolean) return Boolean(current && current.kind === kind);
  return current && current.kind === kind ? current.data : null;
}

function writeLegacy(session, kind, def, value) {
  const current = session.pending && PENDING_KINDS[session.pending.kind] ? session.pending : null;
  const empty = value === null || value === undefined || value === false;
  if (empty) {
    if (current && current.kind === kind) session.pending = null;
    return;
  }
  if (def.boolean && value !== true) return;
  if (current && current.kind !== kind) {
    const currentDef = PENDING_KINDS[current.kind];
    if (currentDef && currentDef.priority > def.priority) return; // higher-priority pending keeps the slot
  }
  session.pending = {
    kind,
    data: def.boolean ? true : value,
    at: new Date().toISOString()
  };
}

/** Install non-enumerable accessors so legacy field reads/writes hit the slot. */
export function installPendingBridge(session) {
  if (!session || typeof session !== 'object' || session[BRIDGE_MARK]) return session;
  // A frozen/sealed session keeps plain legacy fields (nothing to bridge).
  if (!Object.isExtensible(session)) return session;
  for (const kind of PENDING_KIND_KEYS) {
    const def = PENDING_KINDS[kind];
    if (!def.legacyField) continue;
    const existing = Object.getOwnPropertyDescriptor(session, def.legacyField);
    if (existing && existing.configurable === false) continue; // non-configurable: leave untouched
    Object.defineProperty(session, def.legacyField, {
      configurable: true,
      enumerable: false,
      get() { return readLegacy(this, kind, def); },
      set(value) { writeLegacy(this, kind, def, value); }
    });
  }
  Object.defineProperty(session, BRIDGE_MARK, { value: true, enumerable: false });
  return session;
}

/**
 * Migration-on-read: called for EVERY session before any branch runs.
 *  - an existing `session.pending` is validated and TTL-cleaned;
 *  - otherwise the highest-priority live legacy field becomes the slot value;
 *  - legacy own properties are removed and re-exposed as accessors, so old
 *    branches (and old snapshots) keep working untouched.
 */
export function hydrateSessionPending(session, { now = Date.now() } = {}) {
  if (!session || typeof session !== 'object') return session;

  const existing = session.pending;
  if (existing && typeof existing === 'object' && PENDING_KINDS[existing.kind] && PENDING_KINDS[existing.kind].slot !== false) {
    if (isPendingExpired(existing, now)) session.pending = null;
  } else if (existing !== undefined && existing !== null) {
    session.pending = null; // unknown shape
  }

  if (!session.pending) {
    const migrated = pickLegacyPending(session, now);
    if (migrated) session.pending = migrated;
  }

  stripLegacyOwnProps(session);
  installPendingBridge(session);
  return session;
}

export default {
  PENDING_KINDS,
  PENDING_KIND_KEYS,
  PENDING_PRIORITY,
  pendingStartMs,
  isPendingExpired,
  resolvePendingTurn,
  pickLegacyPending,
  installPendingBridge,
  hydrateSessionPending
};
