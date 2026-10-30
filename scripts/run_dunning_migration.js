/**
 * Saka Fleet — v1.16.3 Dunning & Re-engagement migration
 * ------------------------------------------------------
 * Adds the dedupe bookkeeping used by the two lifecycle workers:
 *   - profiles.past_due_notified_at / past_due_notice_count  (T+1 / T+3 dunning)
 *   - profiles.reengage_nudged_at                             (14-day silence nudge)
 *
 * Usage: npm run migrate:dunning
 */

import dotenv from 'dotenv';
dotenv.config();
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

export const DUNNING_SQL = `
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS past_due_notified_at timestamp with time zone;
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS past_due_notice_count integer DEFAULT 0;
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS reengage_nudged_at timestamp with time zone;
  CREATE INDEX IF NOT EXISTS idx_profiles_past_due
    ON public.profiles(subscription_status) WHERE subscription_status = 'PAST_DUE';
`;

export async function applyDunningMigration() {
  if (!hasSqlAccess()) {
    console.error('❌ Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { ok: false, error: 'no SQL transport' };
  }
  console.log('⏳ Applying dunning & re-engagement migration (v1.16.3)...');
  const result = await runSql(DUNNING_SQL, { label: 'applyDunningMigration' });
  if (result.ok) console.log('✅ Dunning + re-engagement columns are ready.');
  else console.error('❌ Dunning migration failed:', result.error || result.status);
  return result;
}

const invokedDirectly = process.argv[1] && /run_dunning_migration\.js$/i.test(process.argv[1]);
if (invokedDirectly) {
  applyDunningMigration()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('❌ Dunning migration crashed:', err.message);
      process.exit(1);
    });
}

export default { applyDunningMigration, DUNNING_SQL };
