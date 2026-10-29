#!/usr/bin/env node
/**
 * Saka Fleet — staging/target schema provisioning.
 *
 * Runs every migration this repo owns, in dependency order, then verifies the
 * result. Idempotent: safe to re-run (CREATE ... IF NOT EXISTS / ADD COLUMN IF
 * NOT EXISTS throughout).
 *
 * Two classes of schema are applied:
 *   1. BOOTSTRAP_SQL — base tables that NO code path creates (`profiles`,
 *      `vehicles`, `passbook_transfers`, reminders/expenses/earnings, caches).
 *      Columns are derived from SAKA_FLEET_ARCHITECTURE.md §2 + §28.3 and the
 *      repository's real insert/select payloads.
 *   2. The existing migrations, executed in place (single source of truth):
 *      ensureSuperadminTables → ensureVehicleTableColumns → ensureSentinelTables
 *      → ensureChatSessionsTable → applySentinelMigration →
 *      applyChatSessionsMigration → applyVinImmutabilityMigration.
 *
 * Transport: Supabase Management API when SUPABASE_ACCESS_TOKEN is set,
 * otherwise direct Postgres over DATABASE_URL (see src/db/sqlRunner.js).
 *
 * THIS SCRIPT WRITES. Run it only against an intended target.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { resolveServiceKey } from '../src/services/supabaseClient.js';
import { ensureVehicleTableColumns } from '../src/services/vehicles.js';
import { ensureSuperadminTables } from '../src/services/superadmin.js';
import { ensureSentinelTables } from '../src/workers/sentinel.js';
import { ensureChatSessionsTable } from '../src/services/sessionStore.js';
import { applySentinelMigration } from './run_sentinel_migration.js';
import { applyChatSessionsMigration } from './run_chat_sessions_migration.js';
import { applyVinImmutabilityMigration } from './run_vin_immutability_migration.js';

const EXPECTED_REF = process.env.SUPABASE_EXPECTED_PROJECT_REF || 'knlxpwiqiqcliprjqjfp';

export const BOOTSTRAP_SQL = `
-- 2.1 profiles ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number varchar UNIQUE NOT NULL,
  email varchar,
  email_verified boolean DEFAULT false,
  full_name varchar,
  preferred_language varchar DEFAULT 'English',
  subscription_tier varchar DEFAULT 'free',
  subscription_status varchar DEFAULT 'TRIALING',
  billing_interval varchar DEFAULT 'monthly',
  subscription_expires_at timestamp with time zone,
  paystack_customer_code text,
  paystack_subscription_code text,
  unit_system varchar DEFAULT 'metric',
  country varchar,
  country_code varchar,
  driver_license_expiry date,
  timezone text,
  timezone_confirmed_at timestamp with time zone,
  is_active boolean DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 2.2 vehicles ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  plate_number varchar NOT NULL,
  make_model varchar,
  vin text,
  qr_passbook_token varchar,
  owner_phone text,
  owner_email text,
  status text DEFAULT 'ACTIVE',
  odometer_reading integer DEFAULT 0,
  current_mileage integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  custom_attributes jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 2.5 passbook_transfers -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.passbook_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
  vin text,
  from_owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  to_owner_phone varchar,
  transfer_fee_paid boolean DEFAULT false,
  payment_reference varchar,
  status text DEFAULT 'PENDING_TARGET_DETAILS',
  initiated_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
`;


// 28.3 reminders + operational tables --------------------------------------
export const BOOTSTRAP_OPERATIONAL_SQL = `
CREATE TABLE IF NOT EXISTS public.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
  driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  plate_number text,
  reminder_type text,
  due_date date,
  status text DEFAULT 'active',
  notified_75p boolean DEFAULT false,
  notified_25p boolean DEFAULT false,
  notified_5p boolean DEFAULT false,
  notified_0p boolean DEFAULT false,
  notified_overdue boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate text,
  expense_type text,
  amount numeric DEFAULT 0,
  liters numeric DEFAULT 0,
  odometer_reading integer,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.expense_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
  driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  expense_type text,
  category text,
  amount numeric DEFAULT 0,
  cost numeric DEFAULT 0,
  currency text DEFAULT 'KES',
  fuel_liters numeric DEFAULT 0,
  odometer_reading integer,
  notes text,
  logged_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.private_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
  driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revenue_amount numeric DEFAULT 0,
  amount numeric DEFAULT 0,
  currency text DEFAULT 'KES',
  logged_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pending_owner_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
  driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action_type text,
  details_summary text,
  scheduled_for timestamp with time zone,
  processed boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

-- 2.9 processed_webhooks (idempotency cache)
CREATE TABLE IF NOT EXISTS public.processed_webhooks (
  wamid text PRIMARY KEY,
  phone_number text,
  processed_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_processed_webhooks_time ON public.processed_webhooks(processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_processed_webhooks_phone ON public.processed_webhooks(phone_number);

CREATE TABLE IF NOT EXISTS public.exchange_rates_cache (
  currency text PRIMARY KEY,
  baseline_rate numeric,
  current_rate numeric,
  last_monthly_reset timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number text,
  issue_category text,
  message_body text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.weekly_feature_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_code text,
  title text,
  target_persona text,
  driver_value_proposition text,
  evidence_quotes text,
  technical_spec text,
  impact_score numeric,
  status text DEFAULT 'proposed',
  created_at timestamp with time zone DEFAULT now()
);
`;

// PostgREST connects as service_role/anon/authenticated; without these grants
// freshly created tables return 401/403 even though the rows are readable.
export const GRANTS_SQL = `
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
`;

const EXPECTED_TABLES = [
  'profiles', 'vehicles', 'vin_registry', 'passbook_transfers', 'reminders',
  'expenses', 'expense_logs', 'private_earnings', 'pending_owner_notifications',
  'processed_webhooks', 'exchange_rates_cache', 'support_tickets',
  'weekly_feature_proposals', 'chat_history', 'chat_sessions', 'chat_transcripts',
  'chat_friction_logs', 'conversation_analytics', 'error_logs', 'system_config',
  'saka_dynamic_rules', 'superadmin_sessions', 'coupons', 'admin_audit_logs',
  'expiry_notification_log'
];

async function step(label, fn) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = await fn();
  return result;
}

async function main() {
  if (!hasSqlAccess()) {
    console.error('❌ No SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    process.exit(2);
  }
  const ref = getProjectRef();
  if (ref !== EXPECTED_REF) {
    console.error(`❌ Refusing to write: SUPABASE_URL ref "${ref}" does not match expected "${EXPECTED_REF}"`);
    process.exit(2);
  }
  const url = process.env.SUPABASE_URL;
  const key = resolveServiceKey();
  if (!url || !key) {
    console.error('❌ SUPABASE_URL and a service key are required');
    process.exit(2);
  }

  console.log(`=== PROVISIONING ${ref} ===`);
  console.log(`   transport: ${process.env.SUPABASE_ACCESS_TOKEN ? 'management-api' : 'direct postgres (DATABASE_URL)'}`);

  // 1. Base tables that no code path creates.
  await step('bootstrap: profiles, vehicles, passbook_transfers', async () => {
    const r = await runSql(BOOTSTRAP_SQL, { label: 'bootstrap:core' });
    if (!r.ok) throw new Error(r.error || r.body);
    console.log(`   ✅ via ${r.via}`);
  });

  await step('bootstrap: reminders, expenses, earnings, caches', async () => {
    const r = await runSql(BOOTSTRAP_OPERATIONAL_SQL, { label: 'bootstrap:operational' });
    if (!r.ok) throw new Error(r.error || r.body);
    console.log(`   ✅ via ${r.via}`);
  });

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // 2. Existing migrations, in dependency order (coupons before vehicles ALTERs).
  await step('ensureSuperadminTables()', async () => console.log('   ->', JSON.stringify(await ensureSuperadminTables(supabase))));
  await step('ensureVehicleTableColumns()', async () => {
    await ensureVehicleTableColumns(supabase);
    console.log('   -> executed');
  });
  await step('ensureSentinelTables()', async () => console.log('   ->', JSON.stringify(await ensureSentinelTables(supabase))));
  await step('ensureChatSessionsTable()', async () => console.log('   ->', JSON.stringify(await ensureChatSessionsTable(supabase))));
  await step('applySentinelMigration()', async () => {
    const r = await applySentinelMigration();
    if (!r.success) throw new Error(r.error || r.body || 'sentinel migration failed');
    console.log('   ✅');
  });
  await step('applyChatSessionsMigration()', async () => {
    const r = await applyChatSessionsMigration();
    if (!r.success) throw new Error(r.error || r.body || 'chat_sessions migration failed');
    console.log('   ✅');
  });
  await step('applyVinImmutabilityMigration()', async () => {
    const r = await applyVinImmutabilityMigration();
    console.log(`   ✅ via ${r.via}`);
  });

  // 3. Grants so PostgREST (service_role/anon) can read the new tables.
  await step('grants', async () => {
    const r = await runSql(GRANTS_SQL, { label: 'grants' });
    if (!r.ok) throw new Error(r.error || r.body);
    console.log(`   ✅ via ${r.via}`);
  });

  // 4. Verification through PostgREST (the path the application uses).
  console.log('\n=== VERIFICATION (PostgREST) ===');
  const missing = [];
  for (const table of EXPECTED_TABLES) {
    const { error } = await supabase.from(table).select('*').limit(0);
    if (error) {
      missing.push(table);
      console.log(`❌ ${table} — ${error.code || ''} ${error.message}`.trim());
    } else {
      console.log(`✅ ${table}`);
    }
  }

  if (missing.length) {
    console.error(`\n❌ ${missing.length} table(s) missing after provisioning: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`\n🎉 SCHEMA PROVISIONED: ${EXPECTED_TABLES.length}/${EXPECTED_TABLES.length} tables present.`);
}

main().catch((err) => {
  console.error('\n❌ Provisioning failed:', err.message);
  process.exit(1);
});
