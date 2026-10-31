import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { CONTACT_NUDGE_SQL } from '../src/services/contactNudge.js';

/**
 * Saka Fleet — Save-my-number nudge migration (v1.28.0).
 * Adds profiles.contact_save_nudged_at so the one-time contact-save suggestion
 * is stamped per profile and can never nag.
 *
 * Run: npm run migrate:contact-nudge
 */

export async function applyContactNudgeMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing contact-save nudge migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(CONTACT_NUDGE_SQL, { label: 'contactNudgeMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Contact-save nudge migration applied (profiles.contact_save_nudged_at).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyContactNudgeMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
