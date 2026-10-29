import 'dotenv/config';
import { runSql, hasSqlAccess } from '../src/db/sqlRunner.js';

/**
 * Applies the VIN immutability trigger to Supabase.
 * The VIN / chassis number is permanently bound to the digital passbook,
 * so any UPDATE that changes it must fail (even via direct SQL).
 */
export const VIN_IMMUTABILITY_SQL = `
  CREATE OR REPLACE FUNCTION public.prevent_vin_mutation()
  RETURNS trigger AS $$
  BEGIN
    IF NEW.vin IS DISTINCT FROM OLD.vin THEN
      RAISE EXCEPTION 'VIN is immutable and cannot be changed once registered (vehicle id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_prevent_vin_mutation ON public.vehicles;
  CREATE TRIGGER trg_prevent_vin_mutation
  BEFORE UPDATE ON public.vehicles
  FOR EACH ROW
  WHEN (OLD.vin IS NOT NULL)
  EXECUTE FUNCTION public.prevent_vin_mutation();
`;

export async function applyVinImmutabilityMigration() {
  if (!hasSqlAccess()) {
    throw new Error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
  }

  const result = await runSql(VIN_IMMUTABILITY_SQL, { label: 'vinImmutabilityMigration' });
  if (!result.ok) {
    throw new Error(`VIN immutability migration failed: ${result.error || result.body}`);
  }

  console.log('✅ VIN immutability trigger applied:', result.body || '(ok)');
  return { success: true, response: result.body, via: result.via };
}

if (process.argv[1] && process.argv[1].endsWith('run_vin_immutability_migration.js')) {
  applyVinImmutabilityMigration()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Migration error:', err.message);
      process.exit(1);
    });
}
