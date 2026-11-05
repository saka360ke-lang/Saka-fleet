import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { LABELS_EVERYWHERE_SQL } from '../src/services/labelsEverywhere.js';

/**
 * Saka Fleet - labels-everywhere migration (v1.59.7).
 * Adds the optional `label` column to receipts and reminders (idempotent) and
 * creates the standalone odometer_readings ledger so every entry kind can be
 * tagged and searched by keyword.
 * Run: npm run migrate:labels-everywhere
 */

export async function applyLabelsEverywhereMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing labels-everywhere migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(LABELS_EVERYWHERE_SQL, { label: 'labelsEverywhereMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK labels-everywhere migration applied (receipts.label, reminders.label, odometer_readings).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyLabelsEverywhereMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
