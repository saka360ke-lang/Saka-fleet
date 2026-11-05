import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { CONV_EVAL_SQL } from '../src/services/convEval.js';

/**
 * Saka Fleet — conversation eval migration (v1.60.0).
 * Creates `conversation_eval_runs` (idempotent) so every judged case, heal and
 * proposal is tracked with before/after scores. The table is telemetry: it is
 * wiped with the operational slate and never holds message bodies (only a
 * transcript hash). Run: npm run migrate:conv-eval
 */

export async function applyConvEvalMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing conversation-eval migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(CONV_EVAL_SQL, { label: 'conversationEvalMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK conversation-eval migration applied (conversation_eval_runs).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyConvEvalMigration()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
