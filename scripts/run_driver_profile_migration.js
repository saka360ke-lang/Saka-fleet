/**
 * Saka Fleet — v1.16.0 Owner Driver Profile migration
 * ---------------------------------------------------
 * Every OWNER gets a driver profile at onboarding completion:
 *   - `profiles.driver_profile_pending` — Saka has started collecting the
 *     owner's minimal driver compliance and nudges until it is done.
 *   - `profiles.driver_profile_completed_at` — minimal compliance captured
 *     (email verified + regional minimal item valid).
 *
 * Usage: npm run migrate:driver-profile
 */

import dotenv from 'dotenv';
dotenv.config();
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

export const DRIVER_PROFILE_SQL = `
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS driver_profile_pending boolean DEFAULT false;
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS driver_profile_completed_at timestamp with time zone;
  CREATE INDEX IF NOT EXISTS idx_profiles_driver_profile_pending
    ON public.profiles(driver_profile_pending) WHERE driver_profile_pending = true;
`;

export async function applyDriverProfileMigration() {
  if (!hasSqlAccess()) {
    console.error('❌ Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { ok: false, error: 'no SQL transport' };
  }
  console.log('⏳ Applying owner driver-profile migration (v1.16.0)...');
  const result = await runSql(DRIVER_PROFILE_SQL, { label: 'applyDriverProfileMigration' });
  if (result.ok) {
    console.log('✅ profiles.driver_profile_pending + driver_profile_completed_at are ready.');
  } else {
    console.error('❌ Driver profile migration failed:', result.error || result.status);
  }
  return result;
}

const invokedDirectly = process.argv[1] && /run_driver_profile_migration\.js$/i.test(process.argv[1]);
if (invokedDirectly) {
  applyDriverProfileMigration()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('❌ Driver profile migration crashed:', err.message);
      process.exit(1);
    });
}

export default { applyDriverProfileMigration, DRIVER_PROFILE_SQL };
