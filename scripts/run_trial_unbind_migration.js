/**
 * Saka Fleet — v1.16.0 Trial Unbind migration
 * -------------------------------------------
 * Commercial state (trial, tier, billing, coupons) binds to the OWNER ACCOUNT.
 * VINs and passbook tokens keep asset provenance + immutability only.
 *
 * Applies:
 *   1. `coupons.owner_id` (+ indexes) for account-first coupon binding.
 *   2. Owner backfill from the legacy `assigned_to_phone`.
 *   3. Scheduled VIN-bound `trial_extension` coupons -> `superseded`
 *      (they can never fire phantom trial messages again; history preserved).
 *
 * Legacy `vehicles.trial_*` / `vin_registry.trial_*` columns are FROZEN, never
 * deleted (VIN immutability: no history is rewritten).
 *
 * Usage: npm run migrate:trial-unbind
 */

import dotenv from 'dotenv';
dotenv.config();
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

export const TRIAL_UNBIND_SQL = `
  -- 1. Account-first coupon binding
  ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS owner_id uuid;
  CREATE INDEX IF NOT EXISTS idx_coupons_owner ON public.coupons(owner_id);
  CREATE INDEX IF NOT EXISTS idx_coupons_applicable ON public.coupons(applicable_to, status);

  -- 2. Backfill the owner binding from the legacy phone key
  UPDATE public.coupons c
     SET owner_id = p.id
    FROM public.profiles p
   WHERE c.owner_id IS NULL
     AND c.assigned_to_phone IS NOT NULL
     AND regexp_replace(c.assigned_to_phone, '[^0-9]', '', 'g')
       = regexp_replace(p.phone_number, '[^0-9]', '', 'g');

  -- 3. Retire phantom VIN-bound scheduled extension coupons (history preserved)
  UPDATE public.coupons
     SET status = 'superseded'
   WHERE applicable_to = 'trial_extension'
     AND status = 'scheduled';
`;

export async function applyTrialUnbindMigration() {
  if (!hasSqlAccess()) {
    console.error('❌ Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { ok: false, error: 'no SQL transport' };
  }
  console.log('⏳ Applying trial unbind migration (v1.16.0)...');
  const result = await runSql(TRIAL_UNBIND_SQL, { label: 'applyTrialUnbindMigration' });
  if (result.ok) {
    console.log('✅ coupons.owner_id added/backfilled; legacy VIN-bound scheduled coupons superseded.');
  } else {
    console.error('❌ Trial unbind migration failed:', result.error || result.status);
  }
  return result;
}

const invokedDirectly = process.argv[1] && /run_trial_unbind_migration\.js$/i.test(process.argv[1]);
if (invokedDirectly) {
  applyTrialUnbindMigration()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('❌ Trial unbind migration crashed:', err.message);
      process.exit(1);
    });
}

export default { applyTrialUnbindMigration, TRIAL_UNBIND_SQL };
