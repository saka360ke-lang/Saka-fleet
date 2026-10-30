import { runSql, hasSqlAccess } from '../db/sqlRunner.js';

/**
 * Saka Fleet — Existing-user feature notices (v1.19.1)
 * ---------------------------------------------------
 * A once-only, role-aware "What's new" digest appended to the next normal turn
 * of an existing user. Deterministic (zero tokens), version-stamped per profile
 * and never shown during a quiz/confirmation so it can never disturb a flow.
 */

export const FEATURE_NOTICE_VERSION = String(process.env.FEATURE_NOTICE_VERSION || '1.19.1');

export const FEATURE_NOTICE_SQL = `
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS feature_notice text;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS feature_notice_at timestamp with time zone;
`;

/** Ensure the notice columns exist (fail-soft; DDL needs a SQL transport). */
export async function ensureFeatureNoticeSchema(providedSupabase) {
  if (!providedSupabase) return { ok: false, status: 'no-client' };
  const { error } = await providedSupabase.from('profiles').select('feature_notice').limit(1);
  if (!error) return { ok: true, status: 'exists' };
  if (!/feature_notice|column/i.test(error.message || '')) return { ok: false, status: 'error', error: error.message };
  if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
  try {
    const result = await runSql(FEATURE_NOTICE_SQL, { label: 'ensureFeatureNoticeSchema' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

function versionParts(version) {
  return String(version || '0').split('.').map((part) => Number(String(part).replace(/[^0-9]/g, '')) || 0);
}

/** True when `current` is newer than the stored notice version. */
export function isNoticeStale(profileVersion, current = FEATURE_NOTICE_VERSION) {
  const currentParts = versionParts(current);
  const storedParts = versionParts(profileVersion || '0');
  const length = Math.max(currentParts.length, storedParts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] || 0;
    const storedPart = storedParts[index] || 0;
    if (currentPart > storedPart) return true;
    if (currentPart < storedPart) return false;
  }
  return false;
}

/** Role-aware, Emoji-Policy-compliant digest (≤4 anchors). */
export function buildFeatureNotice({ lane = 'owner' } = {}) {
  if (lane === 'driver') {
    return '✨ *What\'s new for you*\n' +
      '• 📓 Driver Daybook — your week at a glance.\n' +
      '• 🩺 Vehicle Health Check-in before a trip.\n' +
      '• 🎫 My Compliance Card — licence and badges always ready.';
  }
  return '✨ *What\'s new in Saka*\n' +
    '• 📸 Photo receipts — send a fuel or service receipt and I\'ll read it.\n' +
    '• 📄 Branded PDF reports — fleet, fuel economy, compliance and bespoke.\n' +
    '• ⛽ Say *"full tank"* or *"top-up"* when logging fuel for exact km/L.';
}

/** Should this turn carry the digest? */
export function shouldShowFeatureNotice({ profile = null, session = null, hasQuiz = false, hasVehicleRegistered = false } = {}) {
  if (!profile?.id) return false;
  if (!hasVehicleRegistered) return false;
  if (hasQuiz) return false;
  if (session?.featureNoticeShown) return false;
  return isNoticeStale(profile.feature_notice);
}

/** Stamp the profile so the digest never repeats. */
export async function markFeatureNoticeSeen(providedSupabase, profileId, version = FEATURE_NOTICE_VERSION) {
  if (!providedSupabase || !profileId) return { ok: false, error: 'Missing profile' };
  try {
    const { error } = await providedSupabase
      .from('profiles')
      .update({ feature_notice: version, feature_notice_at: new Date().toISOString() })
      .eq('id', profileId);
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Read-only rollout status for `admin rollout` (never throws). */
export async function getFeatureRolloutStatus(providedSupabase, { version = FEATURE_NOTICE_VERSION } = {}) {
  const counts = { profiles: null, notified: null, vehicles: null, receipts: null, registry: null, receiptsLabel: null };
  if (!providedSupabase) return { ok: false, version, counts };

  const countRows = async (table, apply) => {
    try {
      let query = providedSupabase.from(table).select('*', { count: 'exact', head: true });
      if (apply) query = apply(query);
      const { count, error } = await query;
      return error ? null : (count || 0);
    } catch { return null; }
  };

  counts.profiles = await countRows('profiles');
  counts.notified = await countRows('profiles', (q) => q.eq('feature_notice', version));
  counts.vehicles = await countRows('vehicles', (q) => q.is('deleted_at', null));
  counts.receipts = await countRows('receipts');
  counts.registry = await countRows('ai_model_registry');

  return {
    ok: counts.profiles !== null,
    version,
    counts,
    pending: counts.profiles !== null && counts.notified !== null
      ? Math.max(0, counts.profiles - counts.notified)
      : null
  };
}

export default {
  FEATURE_NOTICE_VERSION,
  FEATURE_NOTICE_SQL,
  ensureFeatureNoticeSchema,
  isNoticeStale,
  buildFeatureNotice,
  shouldShowFeatureNotice,
  markFeatureNoticeSeen,
  getFeatureRolloutStatus
};

