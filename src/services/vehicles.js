import dotenv from 'dotenv';
dotenv.config();

export async function ensureVehicleTableColumns(providedSupabase = null) {
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    try {
      const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];
      const sql = `
        ALTER TABLE public.profiles ALTER COLUMN id SET DEFAULT gen_random_uuid();
        ALTER TABLE public.vehicles ALTER COLUMN id SET DEFAULT gen_random_uuid();
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS yom integer;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS owner_email text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS fuel_type text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS current_mileage integer DEFAULT 0;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS owner_phone text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS status text DEFAULT 'ACTIVE';
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS vin text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS engine_number text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS color text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS transmission text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS tire_size text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS insurance_policy text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS insurance_expiry date;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS inspection_expiry date;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS purchase_cost numeric;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS year_of_manufacture integer;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS other_details text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS is_business boolean DEFAULT false;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS opt_in_earnings boolean DEFAULT false;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS audit_report_frequency text DEFAULT 'on_demand';
        CREATE INDEX IF NOT EXISTS idx_vehicles_plate_status ON public.vehicles(plate_number, status);
      `;
      const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: sql })
      });
      if (!res.ok) {
        const errText = await res.text();
        console.warn('ensureVehicleTableColumns warning:', errText);
      } else {
        console.log('✅ Supabase vehicles table columns verified and ensured.');
      }
    } catch (err) {
      console.warn('ensureVehicleTableColumns error:', err.message);
    }
  }
}
