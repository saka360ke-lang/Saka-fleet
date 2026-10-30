import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — Country Bucket migration (v1.21.0)
 * -----------------------------------------------
 *   1. `country_kb` — the jurisdiction knowledgebase (bundled defaults ship in
 *      code; superadmin-approved overrides live here, effective-dated).
 *   2. `profiles.jurisdiction_confirmed` — the country bucket was confirmed.
 *   3. `vehicles.asset_kind` + `serial_number` — generators, machinery and
 *      heavy equipment are first-class assets without a plate or VIN.
 *   4. `vehicles.plate_number` becomes nullable (non-road assets).
 *
 * Idempotent: IF NOT EXISTS + null-safe ALTERs. Run: npm run migrate:country-kb
 */

export const COUNTRY_KB_SQL = `
  CREATE TABLE IF NOT EXISTS public.country_kb (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    country_code text NOT NULL,
    region_code text,
    asset_kind text,
    category text NOT NULL DEFAULT 'vehicle_compliance',
    rule_key text NOT NULL,
    title text NOT NULL,
    summary text,
    full_text text,
    example_text text,
    required boolean DEFAULT true,
    renewal_hint text,
    law_reference text,
    authority text,
    source_urls jsonb DEFAULT '[]'::jsonb,
    verified_at date,
    version text,
    curated_by text DEFAULT 'bundled',
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_country_kb_identity
    ON public.country_kb (country_code, COALESCE(asset_kind, 'ALL'), rule_key);
  CREATE INDEX IF NOT EXISTS idx_country_kb_lookup
    ON public.country_kb (country_code, is_active);
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS jurisdiction_confirmed boolean DEFAULT false;
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS jurisdiction_updated_at timestamp with time zone;
  ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS asset_kind text;
  ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS serial_number text;
  ALTER TABLE public.vehicles ALTER COLUMN plate_number DROP NOT NULL;
`;

export async function applyCountryKbMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying country-bucket migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(COUNTRY_KB_SQL, { label: 'countryKbMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body || result.status);
    return { success: false, ...result };
  }
  console.log('✅ country_kb + asset_kind + serial_number + nullable plate are ready.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyCountryKbMigration()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
