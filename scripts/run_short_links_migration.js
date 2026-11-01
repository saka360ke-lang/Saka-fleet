import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { SHORT_LINKS_SQL } from '../src/services/linkShortener.js';

/**
 * Saka Fleet — Short links migration (v1.32.0).
 *
 * Creates `public.short_links` (code → url, 90-day TTL) so every long link
 * Saka sends can be presented as https://sakafleet.com/r/<code>.
 * Idempotent: CREATE TABLE/INDEX IF NOT EXISTS.
 *
 * Run: npm run migrate:short-links
 */

export async function applyShortLinksMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing short-links migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(SHORT_LINKS_SQL, { label: 'shortLinksMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Short-links migration applied (public.short_links + index).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyShortLinksMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
