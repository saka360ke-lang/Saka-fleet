/**
 * Saka Fleet - WhatsApp per-turn hooks (Phase 5B-2 of the whatsapp.js split, v1.67.0).
 * -----------------------------------------------------------------------------------
 * The wrap-around machinery every answered turn uses: durable session snapshot
 * load/persist, pending-state hydration, transcript + chat-history persistence, the
 * user-context cache read, re-engagement context, the follow-up queue enqueue and the
 * turn-latency telemetry write (turn_latency_logs).
 *
 * BOUNDARY CONTRACT (section 189): media.js and hooks.js are leaf route modules that may
 * import from src/services/* and src/workers/sentinel.js (a logging dependency that
 * imports no route modules), but NEVER from messages.js. They take state as arguments and
 * return data. Any future addition to either module must obey this rule - if a new
 * function needs to call back into the processor, it does not belong in these modules.
 * The session maps themselves stay in the processor; hooks receive their values.
 */

import { logChatTranscript } from '../../workers/sentinel.js';
import { saveChatMessage, getReengagementContext } from '../../services/chatHistory.js';
import { getUserContextCache, formatUserFactsBlock } from '../../services/userContextCache.js';
import { loadSessionSnapshot, persistSessionSnapshot } from '../../services/sessionStore.js';
import { hydrateSessionPending } from '../../services/pendingState.js';
import { logTurnLatency } from '../../services/turnLatency.js';
import { enqueueFollowUp, FOLLOWUP_KINDS } from '../../services/followups.js';

/**
 * H1 - durable session snapshot persist (fail-soft, never throws). The processor reads
 * the chatSessions/onboardingStore values at call time and passes them in.
 */
export async function persistTurnSnapshot({ supabaseClient, sessionPhone, formattedPhoneForSession, session, onboarding }) {
  if (!supabaseClient || !sessionPhone) return;
  try {
    await persistSessionSnapshot(supabaseClient, formattedPhoneForSession, {
      session: session || null,
      onboarding: onboarding || null
    });
  } catch {}
}

/**
 * H4 - durable session hydration. Restores quiz/onboarding/OTP state from Supabase so
 * any Cloud Run instance can continue the conversation. Returns null on any failure.
 */
export function loadTurnSnapshot(supabaseClient, formattedPhoneForSession) {
  return supabaseClient
    ? loadSessionSnapshot(supabaseClient, formattedPhoneForSession).catch(() => null)
    : Promise.resolve(null);
}

/**
 * H6 - the user side of the turn log: transcript + chat history written together. The
 * processor stores the returned promise and awaits it before the assistant log so
 * transcript ordering stays correct.
 */
export function logUserTurn(supabaseClient, senderPhone, messageText) {
  if (!supabaseClient) return Promise.resolve();
  return Promise.all([
    logChatTranscript(supabaseClient, senderPhone, 'user', messageText),
    saveChatMessage(supabaseClient, senderPhone, 'user', messageText)
  ]).catch(() => {});
}

/**
 * H13 - the assistant side of the turn log (transcript + chat history together).
 */
export async function finalizeAssistantTurn(supabaseClient, senderPhone, text) {
  await Promise.all([
    logChatTranscript(supabaseClient, senderPhone, 'assistant', text),
    saveChatMessage(supabaseClient, senderPhone, 'assistant', text)
  ]);
}

/**
 * H14 - one transcript + chat-history pair, written sequentially (the lane shape used by
 * the gates, the care console and the superadmin intercept).
 */
export async function logTurnPairSequential(supabaseClient, senderPhone, role, text) {
  await logChatTranscript(supabaseClient, senderPhone, role, text);
  await saveChatMessage(supabaseClient, senderPhone, role, text);
}

/**
 * H14 - transcript-only write for the progress acks (no chat-history row, exactly as
 * v1.66.0 wrote them).
 */
export async function logAssistantTranscript(supabaseClient, senderPhone, text) {
  await logChatTranscript(supabaseClient, senderPhone, 'assistant', text);
}

/**
 * H7 - fold the restored snapshot (and its legacy pending* fields) into the one
 * `session.pending` state object (v1.64.0 migration-on-read shim).
 */
export function hydrateTurnSession(rawSession) {
  return hydrateSessionPending(rawSession);
}

/**
 * H8 - the per-user context cache (v1.61.14). A conversation START (no fresh history)
 * rebuilds the user's engine facts once; every later turn reuses the cache until any
 * write invalidates it. Returns the formatted facts block (or null); never throws.
 */
export async function loadUserFactsContext({ supabaseClient, senderPhone, forceRefresh, profileData, existingVehicles, entitlements, countryInfo }) {
  let userFactsContext = null;
  try {
    const userContext = await getUserContextCache(supabaseClient, senderPhone, {
      forceRefresh,
      profile: profileData,
      vehicles: existingVehicles,
      entitlements,
      countryInfo
    });
    userFactsContext = formatUserFactsBlock(userContext.payload);
  } catch (factsErr) {
    console.warn('[WhatsApp] user-context cache skipped:', factsErr.message);
  }
  return userFactsContext;
}

/**
 * H9 - re-engagement context (v1.59.4): when the fresh window is empty (a returning
 * user), the processor injects the last few messages as LABELLED context only.
 */
export function loadReengagementContext({ supabaseClient, senderPhone, hasFreshHistory }) {
  return hasFreshHistory ? Promise.resolve(null) : getReengagementContext(supabaseClient, senderPhone);
}

/**
 * H10 - report follow-up queue (v1.16.0 slow-report lane): ACK instantly, build the
 * report in the background and deliver it as a follow-up while the user keeps chatting.
 * The payload is assembled by the processor and passed in whole.
 */
export async function queueReportFollowUp({ supabase, phone, payload }) {
  return await enqueueFollowUp({
    supabase,
    phone,
    kind: FOLLOWUP_KINDS.FLEET_REPORT,
    payload
  });
}

/**
 * H11+H12 - user-perceived reply latency (v1.24.1): one row per answered turn with the
 * optional phase breakdown (v1.24.3). The success path passes phaseMarks; the catch
 * path omits them, exactly as v1.66.0 wrote the two rows.
 */
export function recordTurnLatency({ supabaseClient, phone, turnStartedAt, ackSent, phaseMarks = null }) {
  const payload = {
    phone,
    turnMs: Date.now() - turnStartedAt,
    ackSent
  };
  if (phaseMarks) {
    payload.phaseMs = {
      setup: phaseMarks.profileReadyAt ? phaseMarks.profileReadyAt - turnStartedAt : null,
      preAi: phaseMarks.profileReadyAt && phaseMarks.aiStartedAt ? phaseMarks.aiStartedAt - phaseMarks.profileReadyAt : null,
      ai: phaseMarks.aiStartedAt && phaseMarks.aiDoneAt ? phaseMarks.aiDoneAt - phaseMarks.aiStartedAt : null,
      postAi: phaseMarks.aiDoneAt ? Math.max(0, Date.now() - phaseMarks.aiDoneAt) : null
    };
  }
  return logTurnLatency(supabaseClient, payload);
}

