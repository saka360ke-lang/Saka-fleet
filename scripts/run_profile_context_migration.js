import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet - profile context migration (v1.58.20).
 * The live profiles table is missing `currency` and `locale`, so every SELECT
 * that lists them (notably trialEngine.fetchOwner) fails and the welcome trial
 * silently returns "profile not found". Add both columns (idempotent).
 * Run: npm run migrate:profile-context
 */

export const PROFILE_CONTEXT_SQL = `
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS currency text;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS locale text;
`;

export async function applyProfileContextMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing profile-context migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(PROFILE_CONTEXT_SQL, { label: 'profileContextMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK profiles.currency + profiles.locale are present.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyProfileContextMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
