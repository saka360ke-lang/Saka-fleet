import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { EARNINGS_ARCHIVE_SQL } from '../src/services/transfers.js';

/**
 * Saka Fleet — earnings archive migration (v1.92.0, Phase 29).
 * Adds `private_earnings.archived_at` + `archived_by_transfer_id` (the seller's
 * earnings stay THEIRS after a passbook transfer) and creates
 * `earnings_report_queue` (the 10-minute Final Earnings Report email).
 * Idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).
 *
 * Run: npm run migrate:earnings-archive
 */

export async function applyEarningsArchiveMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing earnings-archive migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(EARNINGS_ARCHIVE_SQL, { label: 'earningsArchiveMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Earnings archive migration applied (private_earnings archive columns + earnings_report_queue).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyEarningsArchiveMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err.message);
      process.exit(1);
    });
}
