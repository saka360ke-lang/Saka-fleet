/**
 * Saka Fleet — v1.16.4 Welcome Trial migration
 * --------------------------------------------
 * `trial_sessions.source` records WHY a trial exists:
 *   - `welcome`  — automatic full-featured trial at registration (free tier)
 *   - `upgrade`  — legacy trial started from an upgrade intent
 *
 * Usage: npm run migrate:welcome-trial
 */

import dotenv from 'dotenv';
dotenv.config();
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

export const WELCOME_TRIAL_SQL = `
  ALTER TABLE public.trial_sessions ADD COLUMN IF NOT EXISTS source text DEFAULT 'upgrade';
  CREATE INDEX IF NOT EXISTS idx_trial_sessions_source
    ON public.trial_sessions(source, status);
`;

export async function applyWelcomeTrialMigration() {
  if (!hasSqlAccess()) {
    console.error('❌ Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { ok: false, error: 'no SQL transport' };
  }
  console.log('⏳ Applying welcome-trial migration (v1.16.4)...');
  const result = await runSql(WELCOME_TRIAL_SQL, { label: 'applyWelcomeTrialMigration' });
  if (result.ok) console.log('✅ trial_sessions.source is ready (welcome | upgrade).');
  else console.error('❌ Welcome-trial migration failed:', result.error || result.status);
  return result;
}

const invokedDirectly = process.argv[1] && /run_welcome_trial_migration\.js$/i.test(process.argv[1]);
if (invokedDirectly) {
  applyWelcomeTrialMigration()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('❌ Welcome-trial migration crashed:', err.message);
      process.exit(1);
    });
}

export default { applyWelcomeTrialMigration, WELCOME_TRIAL_SQL };
