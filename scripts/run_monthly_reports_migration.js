import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet - Monthly report opt-in migration (v1.77.0, Phase 16).
 * Adds `profiles.monthly_report_opt_in` (boolean, NOT NULL, DEFAULT false).
 * Opt-in by design: existing accounts are unaffected until they ask for the
 * monthly PDF summary. Idempotent (ADD COLUMN IF NOT EXISTS).
 * Run: npm run migrate:monthly-reports
 */

export const MONTHLY_REPORT_OPTIN_SQL = `
    ALTER TABLE public.profiles
        ADD COLUMN IF NOT EXISTS monthly_report_opt_in boolean NOT NULL DEFAULT false;
`;

export async function applyMonthlyReportOptinMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing monthly-report opt-in migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(MONTHLY_REPORT_OPTIN_SQL, { label: 'monthlyReportOptinMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK monthly-report opt-in migration applied (profiles.monthly_report_opt_in).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyMonthlyReportOptinMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err.message);
      process.exit(1);
    });
}
