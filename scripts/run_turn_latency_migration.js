import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/** Saka Fleet - Turn-latency telemetry migration (v1.24.1, phase_ms v1.24.3). */
export const TURN_LATENCY_SQL = `
  CREATE TABLE IF NOT EXISTS public.turn_latency_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    phone text,
    turn_ms integer,
    ack_sent boolean DEFAULT false,
    phase_ms jsonb,
    created_at timestamp with time zone DEFAULT now()
  );
  ALTER TABLE public.turn_latency_logs ADD COLUMN IF NOT EXISTS phase_ms jsonb;
  CREATE INDEX IF NOT EXISTS idx_turn_latency_logs_created ON public.turn_latency_logs (created_at DESC);
  NOTIFY pgrst, 'reload schema';
`;

export async function applyTurnLatencyMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying turn-latency migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(TURN_LATENCY_SQL, { label: 'turnLatencyMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body || result.status);
    return { success: false, ...result };
  }
  console.log('✅ turn_latency_logs is ready.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyTurnLatencyMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => { console.error('Migration error:', err); process.exit(1); });
}
