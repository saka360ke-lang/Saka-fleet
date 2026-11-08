import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { CARE_AI_SQL } from '../src/services/careLearning.js';

/**
 * Saka Fleet — Amina migration (v1.80.0, Phase 19).
 * Adds `support_tickets.ai_draft` and the `care_learnings` lesson ledger.
 * Idempotent: every statement is IF NOT EXISTS. Run: npm run migrate:care-ai
 */

export async function applyCareAiMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying Amina care-AI schema on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(CARE_AI_SQL, { label: 'careAiMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ support_tickets.ai_draft + care_learnings ready.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyCareAiMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err.message);
      process.exit(1);
    });
}
