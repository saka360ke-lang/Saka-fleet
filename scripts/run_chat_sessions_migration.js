import 'dotenv/config';

/**
 * Chat Sessions migration — durable multi-instance conversation state.
 * Usage: node scripts/run_chat_sessions_migration.js
 */
export async function applyChatSessionsMigration() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];

  if (!token || !projectRef) {
    console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_URL');
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

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  const text = await res.text();
  if (!res.ok) {
    console.error('❌ chat_sessions migration failed:', res.status, text);
    return { success: false, status: res.status, body: text };
  }

  console.log('✅ chat_sessions table is ready.');
  return { success: true, status: res.status, body: text };
}

applyChatSessionsMigration()
  .then((r) => process.exit(r.success ? 0 : 1))
  .catch((err) => {
    console.error('❌ Migration error:', err.message);
    process.exit(1);
  });
