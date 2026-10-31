import { runSql, hasSqlAccess } from '../db/sqlRunner.js';

/**
 * Saka Fleet — Save-my-number nudge (v1.28.0)
 * -------------------------------------------
 * One warm, milestone-anchored suggestion that the user saves Saka to their
 * contacts. It is NEVER a canned message on the happy path: the route composes
 * the line from these facts, and the deterministic fallback is used only when
 * the composer is unavailable.
 *
 * Timing is the whole point:
 *  - first vehicle registered + passbook issued (Saka has just become useful);
 *  - a lost-chat moment ("I lost our chat", "can't find you") — at most once
 *    every CONTACT_NUDGE_COOLDOWN_DAYS.
 *
 * It always respects pause/stop, frustration, quizzes and confirmations, and is
 * stamped per profile so it can never nag.
 */

export const CONTACT_NUDGE_SQL = `
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS contact_save_nudged_at timestamp with time zone;
`;

export const CONTACT_NUDGE_COOLDOWN_DAYS = Number(process.env.CONTACT_NUDGE_COOLDOWN_DAYS || 30);

/** Ensure the stamp column exists (fail-soft; DDL needs a SQL transport). */
export async function ensureContactNudgeSchema(providedSupabase) {
  if (!providedSupabase) return { ok: false, status: 'no-client' };
  const { error } = await providedSupabase.from('profiles').select('contact_save_nudged_at').limit(1);
  if (!error) return { ok: true, status: 'exists' };
  if (!/contact_save_nudged_at|column/i.test(error.message || '')) return { ok: false, status: 'error', error: error.message };
  if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
  try {
    const result = await runSql(CONTACT_NUDGE_SQL, { label: 'ensureContactNudgeSchema' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

/**
 * Should this turn carry the save-my-number line?
 * Only after a real milestone, never mid-flow, never to a frustrated/paused user.
 */
export function shouldSuggestContactSave({
  profile = null,
  session = null,
  hasVehicle = false,
  hasQuiz = false,
  isFrustrated = false,
  paused = false,
  now = Date.now(),
  cooldownDays = CONTACT_NUDGE_COOLDOWN_DAYS
} = {}) {
  if (!profile?.id) return false;
  if (!hasVehicle) return false;
  if (hasQuiz || isFrustrated || paused) return false;
  if (session?.contactSaveNudged) return false;
  const last = profile?.contact_save_nudged_at ? Date.parse(profile.contact_save_nudged_at) : NaN;
  if (Number.isFinite(last) && now - last < cooldownDays * 24 * 60 * 60 * 1000) return false;
  return true;
}

/** A lost-chat message is a legitimate second chance to suggest saving Saka. */
export function isLostChatMessage(text = '') {
  return /\b(?:lost (?:our|the) chat|cannot find you|can'?t find you|could not find you|couldn'?t find you|where did you go|new phone|changed phones)\b/i
    .test(String(text || ''));
}

/**
 * Facts for the AI composer. No "plate" wording — the registration number is
 * only used as a friendly contact-name suggestion, never as a request.
 */
export function buildContactSaveFacts({ plateNumber = null, name = null } = {}) {
  const plate = String(plateNumber || '').trim().toUpperCase();
  const suggestedName = plate ? `Saka – ${plate}` : 'Saka Fleet';
  const firstName = String(name || '').trim().split(/\s+/)[0] || null;
  return {
    suggestedName,
    firstName,
    fallbackLine: `📞 Save me as *${suggestedName}* — or any name you like — so your vehicle's memory is one tap away.`,
    instruction:
      'Write exactly ONE short line (max 180 characters) inviting the user to save this WhatsApp number in their contacts. ' +
      `Suggest the name *${suggestedName}* but make clear any name they like is fine. ` +
      'Tie it to the value they just unlocked (the vehicle history/passbook), not to a feature list. ' +
      'No guilt, no pressure, no second question, and never ask for a vehicle registration number or any identifying document.'
  };
}

/** Stamp the profile so the nudge never repeats inside the cooldown window. */
export async function markContactSaveSuggested(providedSupabase, profileId) {
  if (!providedSupabase || !profileId) return { ok: false, error: 'Missing profile' };
  try {
    const { error } = await providedSupabase
      .from('profiles')
      .update({ contact_save_nudged_at: new Date().toISOString() })
      .eq('id', profileId);
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default {
  CONTACT_NUDGE_SQL,
  CONTACT_NUDGE_COOLDOWN_DAYS,
  ensureContactNudgeSchema,
  shouldSuggestContactSave,
  isLostChatMessage,
  buildContactSaveFacts,
  markContactSaveSuggested
};
