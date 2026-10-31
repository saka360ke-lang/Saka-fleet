import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — Recovery ladders + country comm styles schema (v1.28.8).
 *
 * Adds the one-shot counters used by the abandoned-checkout recovery ladder
 * (`trial_sessions.checkout_reminder_count`) and the post-expiry benefit nudges
 * (`profiles.renewal_nudge_count`), plus the deterministic per-country
 * communication style table derived by Sentinel.
 *
 * Run: npm run migrate:recovery
 */

export const RECOVERY_SCHEMA_SQL = `
  DO $mig$
  BEGIN
    IF to_regclass('public.trial_sessions') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.trial_sessions ADD COLUMN IF NOT EXISTS checkout_reminder_count integer DEFAULT 0';
      EXECUTE 'ALTER TABLE public.trial_sessions ADD COLUMN IF NOT EXISTS last_checkout_reminder_at timestamp with time zone';
    END IF;
    IF to_regclass('public.profiles') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS renewal_nudge_count integer DEFAULT 0';
      EXECUTE 'ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_renewal_nudge_at timestamp with time zone';
    END IF;
  END
  $mig$;

  CREATE TABLE IF NOT EXISTS public.country_comm_styles (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    country_code text NOT NULL UNIQUE,
    message_count integer DEFAULT 0,
    top_greeting text,
    emoji_rate numeric DEFAULT 0,
    short_reply_rate numeric DEFAULT 0,
    formal_rate numeric DEFAULT 0,
    notes text,
    updated_at timestamp with time zone DEFAULT now()
  );
`;

export const RECOVERY_SCHEMA_VERIFY_SQL = `
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'trial_sessions' AND column_name IN ('checkout_reminder_count','last_checkout_reminder_at'))
      OR (table_name = 'profiles' AND column_name IN ('renewal_nudge_count','last_renewal_nudge_at')))
  ORDER BY table_name, column_name;
`;

export async function applyRecoveryMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying recovery schema on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(RECOVERY_SCHEMA_SQL, { label: 'recoverySchemaMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  const verify = await runSql(RECOVERY_SCHEMA_VERIFY_SQL, { label: 'recoverySchemaVerify' });
  console.log('Recovery columns:', verify.body || '(no body)');
  console.log('✅ Recovery ladders + country_comm_styles ready.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyRecoveryMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
