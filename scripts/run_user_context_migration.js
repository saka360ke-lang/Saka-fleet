import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { USER_CONTEXT_SQL } from '../src/services/userContextCache.js';

/**
 * Saka Fleet — per-user context cache migration (v1.61.14).
 * Creates `user_context_cache` (idempotent). The chat turn caches the user's
 * engine facts for 15 minutes and rebuilds on every chat initiation.
 * Run: npm run migrate:user-context
 */

export async function applyUserContextMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing user-context cache migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(USER_CONTEXT_SQL, { label: 'userContextCacheMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK user-context cache migration applied (user_context_cache).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyUserContextMigration()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
