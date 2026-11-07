import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet - Weekly report opt-in migration (v1.73.0, Phase 10, P3-4).
 * Adds `profiles.weekly_report_opt_in` (boolean, NOT NULL, DEFAULT false).
 * Opt-in by design: existing accounts are unaffected until they ask for the
 * Monday summary. Idempotent (ADD COLUMN IF NOT EXISTS).
 * Run: npm run migrate:weekly-report-optin
 */

export const WEEKLY_REPORT_OPTIN_SQL = `
    ALTER TABLE public.profiles
        ADD COLUMN IF NOT EXISTS weekly_report_opt_in boolean NOT NULL DEFAULT false;
`;

export async function applyWeeklyReportOptinMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing weekly-report opt-in migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(WEEKLY_REPORT_OPTIN_SQL, { label: 'weeklyReportOptinMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK weekly-report opt-in migration applied (profiles.weekly_report_opt_in).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyWeeklyReportOptinMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}