import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — Driver report grants migration (v1.18.0).
 *
 * Adds `driver_assignments.report_grants` (jsonb array of report-type ids the
 * owner allows this driver to see beyond the default driver lane). Financials
 * can never be granted (enforced in reportAccess.js).
 *
 * Run: npm run migrate:report-grants
 */

export const REPORT_GRANTS_SQL = `
    ALTER TABLE public.driver_assignments
        ADD COLUMN IF NOT EXISTS report_grants jsonb DEFAULT '[]'::jsonb;
`;

export async function applyReportGrantsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing driver report-grants migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(REPORT_GRANTS_SQL, { label: 'reportGrantsMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Driver report-grants migration applied (driver_assignments.report_grants).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyReportGrantsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}