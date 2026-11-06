/**
 * Saka Fleet — trial schema defaults (v1.58.13).
 *
 * The live `profiles` table carried a legacy default `trial_ends_at = now() + 90
 * days` (plus `subscription_status DEFAULT 'TRIALING'`). Any insert that did not
 * set those columns was born with a phantom 90-day trial that leaked into the
 * user-facing copy (live 2026-11-04: a Free/ACTIVE account reported "trial
 * running until … (90 days left)"). New accounts must be Free/ACTIVE with NO
 * trial until the welcome trial starts at first vehicle registration (rule 26).
 *
 * `TRIAL_DEFAULTS_SQL` is idempotent: dropping a non-existent default is a no-op.
 */
export const TRIAL_DEFAULTS_SQL = `
  ALTER TABLE public.profiles ALTER COLUMN trial_ends_at DROP DEFAULT;
  ALTER TABLE public.profiles ALTER COLUMN subscription_status SET DEFAULT 'ACTIVE';
`;

/**
 * v1.61.16 — trial-end decision window columns. All additive + idempotent; every
 * read/write degrades when they are absent (rule 50): the sweep then behaves
 * exactly like the pre-grace hard downgrade.
 */
export const TRIAL_END_GRACE_SQL = `
  ALTER TABLE public.trial_sessions ADD COLUMN IF NOT EXISTS grace_ends_at timestamp with time zone;
  ALTER TABLE public.trial_sessions ADD COLUMN IF NOT EXISTS trial_end_choice text;
  ALTER TABLE public.trial_sessions ADD COLUMN IF NOT EXISTS grace_t3_sent_at timestamp with time zone;
  ALTER TABLE public.trial_sessions ADD COLUMN IF NOT EXISTS grace_t24_sent_at timestamp with time zone;
`;

/**
 * Fail-soft boot ensure. Cloud Run has no SQL transport by default (only the
 * service key), so this returns { ok:false } there and the migration is applied
 * out-of-band via `npm run migrate:trial-end-grace`. Never throws.
 */
export async function ensureTrialEndGraceSchema() {
  try {
    const { runSql } = await import('../db/sqlRunner.js');
    const result = await runSql(TRIAL_END_GRACE_SQL, { label: 'ensureTrialEndGraceSchema' });
    return { ok: Boolean(result.ok), ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fail-soft boot ensure. Cloud Run has no SQL transport by default (only the
 * service key), so this returns { ok:false } there and the migration is applied
 * out-of-band via `npm run migrate:trial-defaults`. Never throws.
 */
export async function ensureTrialSchemaDefaults() {
  try {
    const { runSql } = await import('../db/sqlRunner.js');
    const result = await runSql(TRIAL_DEFAULTS_SQL, { label: 'ensureTrialSchemaDefaults' });
    return { ok: Boolean(result.ok), ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { TRIAL_DEFAULTS_SQL, TRIAL_END_GRACE_SQL, ensureTrialSchemaDefaults, ensureTrialEndGraceSchema };
