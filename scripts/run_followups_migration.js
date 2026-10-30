/**
 * Saka Fleet — v1.16.0 Background Follow-up lane
 * ----------------------------------------------
 * Slow operations (fleet reports, deep audits) must never leave the user
 * waiting in silence. Saka replies instantly with a deterministic ACK and the
 * work finishes in the background; the result arrives as a follow-up message
 * while the conversation continues.
 *
 * Usage: npm run migrate:followups
 */

import dotenv from 'dotenv';
dotenv.config();
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

export const FOLLOWUPS_SQL = `
  CREATE TABLE IF NOT EXISTS public.pending_followups (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    phone text NOT NULL,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'pending',
    scheduled_for timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    processed_at timestamp with time zone,
    error text
  );
  CREATE INDEX IF NOT EXISTS idx_followups_pending
    ON public.pending_followups(status, scheduled_for);
  CREATE INDEX IF NOT EXISTS idx_followups_phone
    ON public.pending_followups(phone, created_at DESC);
`;

export async function applyFollowupsMigration() {
  if (!hasSqlAccess()) {
    console.error('❌ Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { ok: false, error: 'no SQL transport' };
  }
  console.log('⏳ Applying background follow-up migration (v1.16.0)...');
  const result = await runSql(FOLLOWUPS_SQL, { label: 'applyFollowupsMigration' });
  if (result.ok) console.log('✅ pending_followups is ready.');
  else console.error('❌ Follow-up migration failed:', result.error || result.status);
  return result;
}

const invokedDirectly = process.argv[1] && /run_followups_migration\.js$/i.test(process.argv[1]);
if (invokedDirectly) {
  applyFollowupsMigration()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('❌ Follow-up migration crashed:', err.message);
      process.exit(1);
    });
}

export default { applyFollowupsMigration, FOLLOWUPS_SQL };
