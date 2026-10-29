import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

export const SENTINEL_MIGRATION_SQL = `
    CREATE TABLE IF NOT EXISTS public.chat_friction_logs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        user_phone text,
        session_id text,
        friction_type text,
        transcript_snippet text,
        detected_at timestamp with time zone DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.saka_dynamic_rules (
        id serial PRIMARY KEY,
        rule_key text UNIQUE,
        rule_description text,
        patch_instruction text,
        is_active boolean DEFAULT true,
        created_at timestamp with time zone DEFAULT now(),
        updated_at timestamp with time zone DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_friction_logs_phone ON public.chat_friction_logs(user_phone, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dynamic_rules_active ON public.saka_dynamic_rules(is_active);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_unique_active_driver 
    ON public.vehicles(assigned_driver_id) 
    WHERE assigned_driver_id IS NOT NULL AND deleted_at IS NULL;
`;

export async function applySentinelMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }

  console.log(`Executing Sentinel migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(SENTINEL_MIGRATION_SQL, { label: 'sentinelMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Sentinel migration applied.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applySentinelMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
