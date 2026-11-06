/**
 * Saka Fleet — after-write hook (v1.63.1)
 * ---------------------------------------
 * ONE place that every write which changes a user-visible fact calls when it is
 * done. Today it drops the per-user context cache (`user_context_cache`) so the
 * next conversation rebuilds from live data; any future after-write work
 * (audits, projections, telemetry) plugs in HERE instead of at every site.
 *
 * Contract (rule 50):
 *   - fire-and-forget: callers never await it, it returns synchronously
 *   - never throws: a missing table, a dead DB or a missing client is a no-op
 *   - a failed invalidation must NEVER fail or delay the user's write
 *
 * Deliberately NOT called by (none of these is a snapshot fact; each is pinned
 * by an assertion in test_user_context_cache.js):
 *   chat_history / chat_transcripts / chat_sessions / processed_webhooks
 *   chat_friction_logs / error_logs   (telemetry)
 *   admin_audit_logs                  (audit trail)
 *   usage_counters                    (report quota — read live by getEntitlements)
 *   vin_registry                      (provenance ledger, rule 29)
 */
import { invalidateUserContext } from './userContextCache.js';

/**
 * Mark the user's cached facts stale after a facts-changing write.
 * `reason` is carried for future after-write telemetry and never branches.
 */
export function markUserDataChanged(options = {}) {
  const { supabase = null, phone = null, ownerId = null, reason = null } = options || {};
  void reason; // reserved for future after-write telemetry; never branches
  if (!supabase) return;
  try {
    invalidateUserContext(supabase, { phone, ownerId });
  } catch { /* invalidation is best-effort by design (rule 50) */ }
}

export default { markUserDataChanged };
