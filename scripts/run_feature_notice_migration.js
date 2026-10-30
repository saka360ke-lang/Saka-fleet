import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { FEATURE_NOTICE_SQL, FEATURE_NOTICE_VERSION } from '../src/services/featureNotice.js';

/**
 * Saka Fleet — Feature notice migration (v1.19.1).
 * Adds profiles.feature_notice + profiles.feature_notice_at so the once-only
 * "What's new" digest can be version-stamped per user.
 * Run: npm run migrate:feature-notice
 */

export async function applyFeatureNoticeMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing feature-notice migration (v${FEATURE_NOTICE_VERSION}) on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(FEATURE_NOTICE_SQL, { label: 'featureNoticeMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Feature notice migration applied (profiles.feature_notice).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyFeatureNoticeMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
