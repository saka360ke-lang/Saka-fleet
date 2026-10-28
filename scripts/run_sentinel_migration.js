import 'dotenv/config';

async function runMigration() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];

  if (!token || !projectRef) {
    console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_URL');
    process.exit(1);
  }

  const sql = `
    CREATE TABLE IF NOT EXISTS public.chat_friction_logs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        user_phone text,
        session_id text,
        friction_type text,
        transcript_snippet text,
        detected_at timestamp with time zone DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.saka_dynamic_rules (
        id serial PRIMARY KEY,
        rule_key text UNIQUE,
        rule_description text,
        patch_instruction text,
        is_active boolean DEFAULT true,
        created_at timestamp with time zone DEFAULT now(),
        updated_at timestamp with time zone DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_friction_logs_phone ON public.chat_friction_logs(user_phone, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dynamic_rules_active ON public.saka_dynamic_rules(is_active);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_unique_active_driver 
    ON public.vehicles(assigned_driver_id) 
    WHERE assigned_driver_id IS NOT NULL AND deleted_at IS NULL;
  `;

  console.log(`Executing migration on Supabase project: ${projectRef}...`);
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  const responseText = await res.text();
  console.log('Migration response status:', res.status, responseText);
}

runMigration().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
