import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { COUNTRY_SOURCE_SQL } from '../src/services/countryLock.js';

/**
 * Saka Fleet - Phone-primary country lock migration (v1.59.0).
 * Adds profiles.country_source (idempotent): 'phone' (default) or 'user'.
 * The phone's E.164 country code decides a profile's country; an explicit
 * `my country` choice is stamped 'user' and reconciliation never overrides it.
 * Run: npm run migrate:country-source
 */

export async function applyCountrySourceMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing country-source migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(COUNTRY_SOURCE_SQL, { label: 'countrySourceMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK country-source migration applied (profiles.country_source).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyCountrySourceMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
