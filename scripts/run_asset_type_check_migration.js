import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { ASSET_TYPE_CHECK_SQL } from '../src/services/countryBucket.js';

/**
 * Saka Fleet - asset_type CHECK migration (v1.61.17).
 * Replaces the orphaned legacy constraint (ICE/EV/HEAVY_MACHINERY) with the
 * canonical vocabulary so machinery / generators / boats / heavy equipment and
 * hybrids can be saved. Legacy HEAVY_MACHINERY stays valid. Idempotent.
 * Run: npm run migrate:asset-type-check
 */

export async function applyAssetTypeCheckMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing asset_type CHECK migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(ASSET_TYPE_CHECK_SQL, { label: 'assetTypeCheckMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK asset_type CHECK replaced (ICE/EV/HYBRID/MACHINERY/HEAVY_EQUIPMENT/GENERATOR/WATERCRAFT + legacy HEAVY_MACHINERY).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyAssetTypeCheckMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}