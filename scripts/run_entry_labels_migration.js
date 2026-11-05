import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { ENTRY_LABEL_SQL } from '../src/services/entryLedger.js';

/**
 * Saka Fleet - entry-label migration (v1.59.0).
 * Adds the optional `label` column to expense_logs and private_earnings
 * (idempotent) so any expense or earning can be tagged and searched by keyword.
 * Run: npm run migrate:entry-labels
 */

export async function applyEntryLabelMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing entry-label migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(ENTRY_LABEL_SQL, { label: 'entryLabelMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK entry-label migration applied (expense_logs.label, private_earnings.label).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyEntryLabelMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
