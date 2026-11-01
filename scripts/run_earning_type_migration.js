import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { EARNING_TYPE_SQL } from '../src/services/earningCatalog.js';

/**
 * Saka Fleet — Earnings type migration (v1.31.0).
 *
 * Adds `private_earnings.earning_type` (Trip fares, Daily takings, Cargo &
 * freight, Vehicle hire, Equipment hire, Contract & charter, Transport service,
 * Other) plus `notes` parity for staging, and an index for per-vehicle type
 * rollups. Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
 *
 * Run: npm run migrate:earning-type
 */

export async function applyEarningTypeMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }

  console.log(`Executing earnings type migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(EARNING_TYPE_SQL, { label: 'earningTypeMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Earnings type migration applied (private_earnings.earning_type + index).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyEarningTypeMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
