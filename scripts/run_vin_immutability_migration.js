import 'dotenv/config';

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
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];

  if (!token || !projectRef) {
    throw new Error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_URL');
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: VIN_IMMUTABILITY_SQL })
  });

  const responseText = await res.text();
  if (!res.ok) {
    throw new Error(`VIN immutability migration failed: ${responseText}`);
  }

  console.log('✅ VIN immutability trigger applied:', responseText || '(ok)');
  return { success: true, response: responseText };
}

if (process.argv[1] && process.argv[1].endsWith('run_vin_immutability_migration.js')) {
  applyVinImmutabilityMigration()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Migration error:', err.message);
      process.exit(1);
    });
}
