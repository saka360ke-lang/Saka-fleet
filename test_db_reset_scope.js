import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESET_TABLES, PRESERVED_TABLES, resetBackupFilename } from './scripts/reset-db.js';

/**
 * Targeted suite: database slate reset scope invariants (v1.14.2).
 * Stateless — inspects the reset registry and its TRUNCATE SQL text only.
 * No database rows are created or deleted, so no cleanup is required.
 */

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptSource = fs.readFileSync(path.join(here, 'scripts', 'reset-db.js'), 'utf8');

function truncateBlock() {
  const match = scriptSource.match(/TRUNCATE TABLE([\s\S]*?)RESTART IDENTITY CASCADE;/);
  return match ? match[1] : '';
}

function run() {
  console.log('--- Test 1: registry integrity ---');
  assert(Array.isArray(RESET_TABLES) && RESET_TABLES.length > 0, 'RESET_TABLES is populated');
  assert(Array.isArray(PRESERVED_TABLES) && PRESERVED_TABLES.length > 0, 'PRESERVED_TABLES is populated');
  assert(new Set(RESET_TABLES).size === RESET_TABLES.length, 'RESET_TABLES has no duplicates');
  assert(new Set(PRESERVED_TABLES).size === PRESERVED_TABLES.length, 'PRESERVED_TABLES has no duplicates');
  const overlap = RESET_TABLES.filter((t) => PRESERVED_TABLES.includes(t));
  assert(overlap.length === 0, `wipe and preserve scopes are disjoint (${overlap.join(', ') || 'no overlap'})`);

  console.log('--- Test 2: required operational tables are wiped ---');
  for (const table of [
    'profiles', 'vehicles', 'vin_registry', 'chat_sessions', 'superadmin_sessions',
    'ai_usage_logs', 'support_tickets', 'exchange_rates_cache', 'admin_audit_logs',
    'trial_sessions', 'subscriptions', 'usage_counters', 'paystack_webhook_events',
    'receipts', 'dashboard_sessions'
  ]) {
    assert(RESET_TABLES.includes(table), `${table} is in the wipe scope`);
  }

  console.log('--- Test 3: boot-critical config + governance ledger are preserved ---');
  for (const table of [
    'system_config', 'compliance_catalog', 'sentinel_audit_runs',
    'remediation_proposals', 'weekly_feature_proposals',
    'ai_model_registry', 'model_eval_runs'
  ]) {
    assert(PRESERVED_TABLES.includes(table), `${table} is preserved`);
    assert(!RESET_TABLES.includes(table), `${table} is not in the wipe scope`);
  }

  console.log('--- Test 4: TRUNCATE SQL matches the registry ---');
  const block = truncateBlock();
  assert(Boolean(block), 'global TRUNCATE block found in scripts/reset-db.js');
  for (const table of RESET_TABLES) {
    assert(block.includes(`public.${table}`), `TRUNCATE covers public.${table}`);
  }
  for (const table of PRESERVED_TABLES) {
    assert(!block.includes(`public.${table}`), `TRUNCATE excludes public.${table}`);
  }

  console.log('--- Test 5: backup filename is filesystem-safe ---');
  const name = resetBackupFilename(new Date('2026-10-29T12:34:56.789Z'));
  assert(/^reset-backup-[\w.-]+\.json$/.test(name), `backup filename is safe (${name})`);
  assert(!name.includes(':'), 'backup filename has no colons');

  console.log('--- Test 6: targeted-phone cascade clears owner_id-keyed rows too ---');
  for (const table of ['subscriptions', 'trial_sessions', 'usage_counters']) {
    assert(
      scriptSource.includes(`DELETE FROM public.${table} WHERE owner_id IN (SELECT id FROM public.profiles`),
      `targeted cascade deletes ${table} by owner_id before the profile is removed`
    );
  }
  assert(
    scriptSource.includes("DELETE FROM public.web_onboard_otps WHERE phone IN"),
    'targeted cascade deletes web_onboard_otps by phone'
  );
  assert(
    scriptSource.includes('DELETE FROM public.dashboard_sessions WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN'),
    'targeted cascade deletes dashboard_sessions by owner_id (v1.74.0)'
  );

  console.log('--- Test 7: dashboard session role is part of the provisioned schema (v1.76.0) ---');
  const provisionSource = fs.readFileSync(path.join(here, 'scripts', 'provision_staging_schema.js'), 'utf8');
  const dashboardSource = fs.readFileSync(path.join(here, 'src', 'services', 'dashboard.js'), 'utf8');
  const migrationSource = fs.readFileSync(path.join(here, 'scripts', 'run_dashboard_role_migration.js'), 'utf8');
  for (const [name, source] of [['provisioning', provisionSource], ['boot DDL', dashboardSource], ['migration', migrationSource]]) {
    assert(
      source.includes('session_role text NOT NULL DEFAULT'),
      `${name} carries session_role with an owner default (existing rows never need a backfill)`
    );
  }
  assert(
    dashboardSource.includes('ADD COLUMN IF NOT EXISTS session_role'),
    'the boot DDL adds the role idempotently to a table created before v1.76.0'
  );

  console.log('--- Test 8: the monthly report opt-in is a schema carrier (v1.77.0) ---');
  const monthlyMigrationSource = fs.readFileSync(path.join(here, 'scripts', 'run_monthly_reports_migration.js'), 'utf8');
  assert(
    /monthly_report_opt_in boolean NOT NULL DEFAULT false/.test(provisionSource),
    'the provisioning schema carries profiles.monthly_report_opt_in (default false = opt-in)'
  );
  assert(
    provisionSource.includes('ADD COLUMN IF NOT EXISTS monthly_report_opt_in'),
    'the provisioning schema upgrades a pre-1.77.0 profiles table in place'
  );
  assert(
    /ADD COLUMN IF NOT EXISTS monthly_report_opt_in boolean NOT NULL DEFAULT false/.test(monthlyMigrationSource),
    'npm run migrate:monthly-reports is additive and idempotent'
  );

  console.log(`\n🎉 ${passed} reset-scope assertions passed.`);
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
