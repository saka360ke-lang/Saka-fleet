/**
 * Saka Fleet — system_config key registry (v1.72.1, Phase 8C / P2-6)
 * ------------------------------------------------------------------
 * ONE source of truth for every `system_config` key: its namespaced name,
 * the legacy name it was written under until v1.72.1, the owning module, its
 * default and whether it is read on the boot path.
 *
 * Release policy (approved): v1.72.1 introduces the namespaced keys and a
 * one-release DUAL window — reads prefer the new key and fall back to the
 * legacy key, writes upsert BOTH. v1.73.0 flips `SYSTEM_CONFIG_KEY_MODE` to
 * `new` and drops the legacy rows (`migrate:system-config-keys --drop-legacy`).
 *
 * The migration is COPY-then-DELETE, never an in-place rename: a rename opens
 * a moment where neither key holds the value, which is exactly the window a
 * booting instance must never see (the deploy LIVE alert dedupe reads
 * `deploy.last_deployed_revision`). `planSystemConfigCopies()` is pure and
 * idempotent so a re-run copies nothing twice.
 */

export const SYSTEM_CONFIG_KEY_MODES = Object.freeze(['dual', 'new']);

/** Fixed keys: namespaced name -> descriptor. */
export const SYSTEM_CONFIG_KEYS = Object.freeze({
  'prompt.saka_core_prompt': Object.freeze({
    legacyKey: 'saka_core_prompt', owner: 'sentinel', default: null, bootCritical: true, kind: 'fixed'
  }),
  'deploy.last_deployed_revision': Object.freeze({
    legacyKey: 'last_deployed_revision', owner: 'deployLiveAlert', default: null, bootCritical: true, kind: 'fixed'
  }),
  'remediation.digest_frequency': Object.freeze({
    legacyKey: 'remediation_digest_frequency', owner: 'remediation', default: 'twice_daily', bootCritical: false, kind: 'fixed'
  }),
  'remediation.digest_last_sent': Object.freeze({
    legacyKey: 'remediation_digest_last_sent', owner: 'remediation', default: null, bootCritical: false, kind: 'fixed'
  }),
  'remediation.urgent_last_sent': Object.freeze({
    legacyKey: 'remediation_urgent_last_sent', owner: 'remediation', default: null, bootCritical: false, kind: 'fixed'
  }),
  'eval.digest_last_at': Object.freeze({
    legacyKey: 'last_eval_digest_at', owner: 'evalDigest', default: null, bootCritical: false, kind: 'fixed'
  }),
  'eval.digest_attempt_at': Object.freeze({
    legacyKey: 'last_eval_digest_attempt_at', owner: 'evalDigest', default: null, bootCritical: false, kind: 'fixed'
  }),
  'eval.call_alert_date': Object.freeze({
    legacyKey: 'last_eval_call_alert_date', owner: 'convEval', default: null, bootCritical: false, kind: 'fixed'
  }),
  'admin.wipe_pending': Object.freeze({
    legacyKey: 'admin_wipe_pending', owner: 'superadmin', default: null, bootCritical: false, kind: 'fixed'
  }),
  'weeklyreports.last_sent_date': Object.freeze({
    // v1.73.0 (Phase 10, P3-4) — Nairobi calendar-day marker for the weekly
    // report sweep. Brand-new key: no legacy name existed before it. (The
    // registry law allows letters only in the domain segment.)
    legacyKey: null, owner: 'weeklyReports', default: null, bootCritical: false, kind: 'fixed'
  }),
  'monthlyreports.last_sent_date': Object.freeze({
    // v1.77.0 (Phase 16) — Nairobi calendar-day marker for the monthly PDF
    // summary sweep (1st of the month, 08:00 EAT). Brand-new key.
    legacyKey: null, owner: 'monthlyReports', default: null, bootCritical: false, kind: 'fixed'
  }),
  'mailer.resend_quota_warned_at': Object.freeze({
    // v1.87.2 (Phase 26C) — UTC calendar day of the last Resend quota (429)
    // detection. Dual-written to the legacy `resend_quota_warned_at` row so the
    // operator can find it under the documented name.
    legacyKey: 'resend_quota_warned_at', owner: 'mailer', default: null, bootCritical: false, kind: 'fixed'
  })
});

/** Convenience names (modules import these instead of literals). */
export const CONFIG_KEY_SAKA_CORE_PROMPT = 'prompt.saka_core_prompt';
export const CONFIG_KEY_DEPLOY_LAST_REVISION = 'deploy.last_deployed_revision';
export const CONFIG_KEY_REMEDIATION_DIGEST_FREQUENCY = 'remediation.digest_frequency';
export const CONFIG_KEY_REMEDIATION_DIGEST_LAST_SENT = 'remediation.digest_last_sent';
export const CONFIG_KEY_REMEDIATION_URGENT_LAST_SENT = 'remediation.urgent_last_sent';
export const CONFIG_KEY_EVAL_DIGEST_LAST_AT = 'eval.digest_last_at';
export const CONFIG_KEY_EVAL_DIGEST_ATTEMPT_AT = 'eval.digest_attempt_at';
export const CONFIG_KEY_EVAL_CALL_ALERT_DATE = 'eval.call_alert_date';
export const CONFIG_KEY_ADMIN_WIPE_PENDING = 'admin.wipe_pending';
export const CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT = 'weeklyreports.last_sent_date';
export const CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT = 'monthlyreports.last_sent_date';
export const CONFIG_KEY_RESEND_QUOTA_WARNED = 'mailer.resend_quota_warned_at';

/** Dynamic per-day family: `budget.alert.<pct>_<YYYY-MM-DD>`. */
export const BUDGET_ALERT_FAMILY = Object.freeze({
  prefix: 'budget.alert.',
  legacyPrefix: 'ai_budget_alert_',
  owner: 'superadmin',
  kind: 'dynamic'
});

/** The active key mode: `new` (default since v1.88.2) or `dual` (explicit rolling-window opt-in). */
export function systemConfigKeyMode() {
  const raw = String(process.env.SYSTEM_CONFIG_KEY_MODE ?? 'new').trim().toLowerCase();
  return SYSTEM_CONFIG_KEY_MODES.includes(raw) ? raw : 'new';
}

export function isDualKeyMode() {
  return systemConfigKeyMode() === 'dual';
}

/** Namespaced dynamic key for the AI budget alert family. */
export function dynamicConfigKey(threshold, dateKey) {
  return `${BUDGET_ALERT_FAMILY.prefix}${threshold}_${dateKey}`;
}

/** The legacy dynamic key for the same alert (dual-read fallback). */
export function legacyDynamicConfigKey(threshold, dateKey) {
  return `${BUDGET_ALERT_FAMILY.legacyPrefix}${threshold}_${dateKey}`;
}

/**
 * Resolve any key (namespaced, legacy fixed or either dynamic form) into a
 * descriptor `{ namespacedKey, legacyKey, owner, default, bootCritical, kind }`.
 * Unknown keys pass through untouched (single-key behaviour, never throws).
 */
export function describeConfigKey(configKey) {
  const key = String(configKey || '');
  if (SYSTEM_CONFIG_KEYS[key]) return { namespacedKey: key, ...SYSTEM_CONFIG_KEYS[key] };
  const fixed = Object.entries(SYSTEM_CONFIG_KEYS).find(([, descriptor]) => descriptor.legacyKey === key);
  if (fixed) return { namespacedKey: fixed[0], ...fixed[1] };
  if (key.startsWith(BUDGET_ALERT_FAMILY.prefix)) {
    return {
      namespacedKey: key,
      legacyKey: `${BUDGET_ALERT_FAMILY.legacyPrefix}${key.slice(BUDGET_ALERT_FAMILY.prefix.length)}`,
      owner: BUDGET_ALERT_FAMILY.owner,
      default: null,
      bootCritical: false,
      kind: 'dynamic'
    };
  }
  if (key.startsWith(BUDGET_ALERT_FAMILY.legacyPrefix)) {
    return {
      namespacedKey: `${BUDGET_ALERT_FAMILY.prefix}${key.slice(BUDGET_ALERT_FAMILY.legacyPrefix.length)}`,
      legacyKey: key,
      owner: BUDGET_ALERT_FAMILY.owner,
      default: null,
      bootCritical: false,
      kind: 'dynamic'
    };
  }
  return { namespacedKey: key, legacyKey: null, owner: 'unknown', default: null, bootCritical: false, kind: 'unknown' };
}

/** Legacy name for a fixed key (or null). */
export function legacyConfigKeyFor(configKey) {
  return describeConfigKey(configKey).legacyKey;
}

/**
 * Pure, idempotent copy plan for the migration script.
 * Copies every legacy/generated row to its namespaced name unless an equal
 * namespaced row already exists. NEVER plans a delete (release A keeps both).
 */
export function planSystemConfigCopies(rows = []) {
  const byKey = new Map((rows || []).map((row) => [row?.key, row]));
  const copies = [];
  const plan = (namespacedKey, legacyRow, kind) => {
    if (!legacyRow) return;
    const current = byKey.get(namespacedKey);
    const same = current && String(current.value ?? '') === String(legacyRow.value ?? '');
    if (same) return;
    copies.push({
      namespacedKey,
      legacyKey: legacyRow.key,
      value: legacyRow.value ?? null,
      updated_by: legacyRow.updated_by || 'SYSTEM_CONFIG_KEY_MIGRATION',
      updated_at: legacyRow.updated_at || new Date().toISOString(),
      kind
    });
  };
  for (const [namespacedKey, descriptor] of Object.entries(SYSTEM_CONFIG_KEYS)) {
    plan(namespacedKey, byKey.get(descriptor.legacyKey), descriptor.kind);
  }
  for (const row of rows || []) {
    const key = String(row?.key || '');
    if (!key.startsWith(BUDGET_ALERT_FAMILY.legacyPrefix)) continue;
    plan(`${BUDGET_ALERT_FAMILY.prefix}${key.slice(BUDGET_ALERT_FAMILY.legacyPrefix.length)}`, row, 'dynamic');
  }
  return copies;
}

/** Every registered name (migration reports unknown rows, never touches them). */
export function knownSystemConfigKeys() {
  const names = new Set(Object.keys(SYSTEM_CONFIG_KEYS));
  for (const descriptor of Object.values(SYSTEM_CONFIG_KEYS)) names.add(descriptor.legacyKey);
  return names;
}

export default {
  SYSTEM_CONFIG_KEYS,
  SYSTEM_CONFIG_KEY_MODES,
  BUDGET_ALERT_FAMILY,
  systemConfigKeyMode,
  isDualKeyMode,
  dynamicConfigKey,
  legacyDynamicConfigKey,
  describeConfigKey,
  legacyConfigKeyFor,
  planSystemConfigCopies,
  knownSystemConfigKeys
};
