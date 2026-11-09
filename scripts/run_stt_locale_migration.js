import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — country_kb.stt_locale migration (v1.89.0, Phase 27C)
 * ---------------------------------------------------------------
 * Adds `country_kb.stt_locale` (the country's Speech-to-Text primary language,
 * superadmin-editable without a deploy). Idempotent. The same ALTER lives in
 * `ensureCountrySttLocaleColumn` (boot mirror).
 *
 * Run: npm run migrate:stt-locale
 */

export const STT_LOCALE_SQL = `
  ALTER TABLE public.country_kb ADD COLUMN IF NOT EXISTS stt_locale text;
`;

export async function applySttLocaleMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying country_kb.stt_locale migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(STT_LOCALE_SQL, { label: 'sttLocaleMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body || result.status);
    return { success: false, ...result };
  }
  console.log('✅ country_kb.stt_locale is ready.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applySttLocaleMigration()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
