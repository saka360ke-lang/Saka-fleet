/**
 * Saka Fleet — v1.16.0 Vehicle Compliance separation migration
 * -----------------------------------------------------------
 * VEHICLE compliance gets its own ledger (`vehicle_compliances`) exactly like
 * driver compliance (`driver_compliances`). Insurance, inspection/MOT, road
 * service licence, road tax and any other asset permit live here — separate
 * from driver licences/PSV badges which stay in `driver_compliances`.
 *
 * Legacy `vehicles.insurance_expiry` / `inspection_expiry` stay for reports and
 * are dual-written by the service; the backfill seeds existing rows once.
 *
 * Usage: npm run migrate:vehicle-compliance
 */

import dotenv from 'dotenv';
dotenv.config();
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

export const VEHICLE_COMPLIANCE_SQL = `
  CREATE TABLE IF NOT EXISTS public.vehicle_compliances (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
    type text NOT NULL,
    label text,
    number text,
    expiry date,
    lifetime boolean DEFAULT false,
    country_code text,
    asset_type text,
    verified_at timestamp with time zone,
    reminder_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_compliances_unique
    ON public.vehicle_compliances(vehicle_id, type);
  CREATE INDEX IF NOT EXISTS idx_vehicle_compliances_expiry
    ON public.vehicle_compliances(expiry);

  -- One-time backfill of the legacy insurance/inspection columns.
  INSERT INTO public.vehicle_compliances (vehicle_id, type, label, expiry, verified_at)
  SELECT v.id, 'insurance', 'Insurance', v.insurance_expiry, now()
    FROM public.vehicles v
   WHERE v.insurance_expiry IS NOT NULL
     AND v.deleted_at IS NULL
  ON CONFLICT (vehicle_id, type) DO NOTHING;

  INSERT INTO public.vehicle_compliances (vehicle_id, type, label, expiry, verified_at)
  SELECT v.id, 'inspection', 'Inspection', v.inspection_expiry, now()
    FROM public.vehicles v
   WHERE v.inspection_expiry IS NOT NULL
     AND v.deleted_at IS NULL
  ON CONFLICT (vehicle_id, type) DO NOTHING;
`;

export async function applyVehicleComplianceMigration() {
  if (!hasSqlAccess()) {
    console.error('❌ Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { ok: false, error: 'no SQL transport' };
  }
  console.log('⏳ Applying vehicle compliance separation migration (v1.16.0)...');
  const result = await runSql(VEHICLE_COMPLIANCE_SQL, { label: 'applyVehicleComplianceMigration' });
  if (result.ok) {
    console.log('✅ vehicle_compliances ready; legacy insurance/inspection rows backfilled.');
  } else {
    console.error('❌ Vehicle compliance migration failed:', result.error || result.status);
  }
  return result;
}

const invokedDirectly = process.argv[1] && /run_vehicle_compliance_migration\.js$/i.test(process.argv[1]);
if (invokedDirectly) {
  applyVehicleComplianceMigration()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('❌ Vehicle compliance migration crashed:', err.message);
      process.exit(1);
    });
}

export default { applyVehicleComplianceMigration, VEHICLE_COMPLIANCE_SQL };
