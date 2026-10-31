/**
 * Saka Fleet — slow-turn ack (v1.25.1).
 *
 * When a turn runs long the user deserves one gentle "still with you" line. It
 * must never become a metronome: the threshold is 8s, the copy rotates per
 * session, and at most one ack is sent per 60s so an outage cannot spam.
 * Pure helpers so the behaviour stays stateless-testable.
 */

export const SLOW_ACK_DEFAULT_MS = 8000;
export const SLOW_ACK_MIN_GAP_MS = 60000;

export const SLOW_ACK_LINES = Object.freeze([
  '⏳ Still with you…',
  '🙂 One sec — checking your garage…',
  '📒 Flipping through your passbook…',
  '🚗 Almost there…'
]);

/** Resolve the ack threshold; 0 disables it. */
export function resolveSlowAckMs(env = process.env) {
  const raw = Number(env?.SLOW_ACK_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return SLOW_ACK_DEFAULT_MS;
}

/** Deterministic rotation — the same session never sees the same line twice in a row. */
export function pickSlowAckLine(seed = 0) {
  const length = SLOW_ACK_LINES.length;
  const raw = Math.trunc(Number(seed) || 0);
  const index = ((raw % length) + length) % length;
  return SLOW_ACK_LINES[index];
}

/** Gate the ack: only unfinished turns, and never twice within the floor. */
export function shouldSendSlowAck({ turnFinalized = false, now = Date.now(), lastAckAt = 0, minGapMs = SLOW_ACK_MIN_GAP_MS } = {}) {
  if (turnFinalized) return false;
  if (!Number.isFinite(now)) return false;
  if (!lastAckAt) return true;
  return now - Number(lastAckAt) >= minGapMs;
}

export default {
  SLOW_ACK_LINES,
  SLOW_ACK_DEFAULT_MS,
  SLOW_ACK_MIN_GAP_MS,
  resolveSlowAckMs,
  pickSlowAckLine,
  shouldSendSlowAck
};
