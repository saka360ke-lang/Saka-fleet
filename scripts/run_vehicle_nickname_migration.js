import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — vehicle nickname migration (v1.89.0, Phase 27C)
 * ----------------------------------------------------------
 * Adds `vehicles.nickname` (optional human label, ≤40 chars). Idempotent.
 * The same ALTER lives in `ensureVehicleTableColumns` (boot mirror), so a new
 * environment heals itself even if this script is never run.
 *
 * Run: npm run migrate:vehicle-nickname
 */

export const VEHICLE_NICKNAME_SQL = `
  ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS nickname text;
`;

export async function applyVehicleNicknameMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying vehicle-nickname migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(VEHICLE_NICKNAME_SQL, { label: 'vehicleNicknameMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body || result.status);
    return { success: false, ...result };
  }
  console.log('✅ vehicles.nickname is ready (optional, ≤40 chars).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyVehicleNicknameMigration()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
