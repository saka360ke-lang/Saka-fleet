import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { FUEL_ECONOMY_SQL } from '../src/services/fuelEconomy.js';

/**
 * Saka Fleet — Fuel fill-type migration (v1.17.1).
 *
 * Adds `expense_logs.fill_type` ('full' | 'partial' | null) and backfills it
 * from legacy notes ("full tank", "topped up", …). Exact km/L requires knowing
 * which fills were full tanks; without this column every top-up was silently
 * treated as a full tank.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS + null-guarded backfills.
 * Run: npm run migrate:fuel-fill
 */

export async function applyFuelFillTypeMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }

  console.log(`Executing fuel fill-type migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(FUEL_ECONOMY_SQL, { label: 'fuelFillTypeMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Fuel fill-type migration applied (expense_logs.fill_type + backfill).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyFuelFillTypeMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}