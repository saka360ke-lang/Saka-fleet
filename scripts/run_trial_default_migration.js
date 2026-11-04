import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { TRIAL_DEFAULTS_SQL } from '../src/services/trialSchema.js';

/**
 * Saka Fleet - trial-defaults migration (v1.58.13).
 * Drops the legacy `profiles.trial_ends_at` default (now() + 90 days) and sets
 * `subscription_status` to default 'ACTIVE', so no new account is born with a
 * phantom 90-day trial. Idempotent. Run: npm run migrate:trial-defaults
 */

export async function applyTrialDefaultsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing trial-defaults migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(TRIAL_DEFAULTS_SQL, { label: 'trialDefaultsMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK trial-defaults migration applied (profiles.trial_ends_at default dropped; subscription_status default = ACTIVE).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyTrialDefaultsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
