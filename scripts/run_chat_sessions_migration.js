import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

/**
 * Chat Sessions migration — durable multi-instance conversation state.
 * Usage: node scripts/run_chat_sessions_migration.js
 */
export async function applyChatSessionsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }

  const sql = `
    CREATE TABLE IF NOT EXISTS public.chat_sessions (
        phone_number text PRIMARY KEY,
        state jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamp with time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON public.chat_sessions(updated_at DESC);
    ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
  `;

  const result = await runSql(sql, { label: 'chatSessionsMigration' });
  if (!result.ok) {
    console.error('❌ chat_sessions migration failed:', result.status, result.error || result.body);
    return { success: false, status: result.status, body: result.error || result.body };
  }

  console.log('✅ chat_sessions table is ready.');
  return { success: true, status: result.status, body: result.body, via: result.via };
}

// Only execute when run directly (safe to import from the provisioning script).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyChatSessionsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('❌ Migration error:', err.message);
      process.exit(1);
    });
}
