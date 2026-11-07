import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { TRIAL_END_GRACE_SQL } from '../src/services/trialSchema.js';

/**
 * Saka Fleet - trial-end decision window migration (v1.61.16, extended v1.71.0).
 * Adds trial_sessions.grace_ends_at / trial_end_choice / grace_t3_sent_at /
 * grace_t24_sent_at so a trial can end into a bounded "choose your plan"
 * window instead of an instant downgrade, plus t3_fitted_plan (v1.71.0 — the
 * fitted-plan snapshot stamped with the T-3 card; T-0 re-sends the full card
 * only when the fitted tier changed). Idempotent.
 * Run: npm run migrate:trial-end-grace
 */

export async function applyTrialEndGraceMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing trial-end grace migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(TRIAL_END_GRACE_SQL, { label: 'trialEndGraceMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK trial-end grace migration applied (grace_ends_at, trial_end_choice, grace_t3/t24 stamps, t3_fitted_plan).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyTrialEndGraceMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}