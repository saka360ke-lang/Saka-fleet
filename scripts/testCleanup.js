import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

/**
 * Permanent rule (see .clinerules / SAKA_FLEET_ARCHITECTURE.md §20):
 * every stateful test or check MUST clear its data from the database
 * after it finishes. `runWithCleanup` enforces this in a `finally` block.
 */

// Phones seeded by the repository's test suites.
export const KNOWN_TEST_PHONES = [
  '+254700000000',
  '+254700000001',
  '+254700000002',
  '+254700112233',
  '+254700998877',
  '+254711223344',
  '+254711998877',
  '+254711999888',
  '+254722334455',
  '+254733444555',
  '+254788111222',
  '+254788334455',
  '+254788990011',
  '+254799000111',
  '+254799123456',
  '+254799123457',
  '+254799123458'
];

// VINs seeded by the repository's test suites.
export const KNOWN_TEST_VINS = [
  '1HDJ12345678',
  '1HGCR2F83HA123456',
  'JT111UJ800012345',
  'JTE777A1234567890',
  'JTE888B1234567890',
  '1HGCM82633A004352'
];

export function createTestSupabaseClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function phoneVariants(phone) {
  const clean = String(phone || '').replace(/[^\d+]/g, '');
  if (!clean) return [];
  return clean.startsWith('+') ? [clean, clean.slice(1)] : [clean, `+${clean}`];
}

async function deleteIn(client, table, column, values, verbose) {
  if (!values || values.length === 0) return 0;
  try {
    const { error, count } = await client.from(table).delete({ count: 'exact' }).in(column, values);
    if (error) {
      if (verbose) console.warn(`[testCleanup] ${table}.${column}: ${error.message}`);
      return 0;
    }
    return count || 0;
  } catch (err) {
    if (verbose) console.warn(`[testCleanup] ${table}.${column} threw: ${err.message}`);
    return 0;
  }
}

/**
 * Remove every row created by a test run.
 * @param {{phones?: string[], vins?: string[], vehicleIds?: string[], supabase?: object, verbose?: boolean}} options
 */
export async function cleanupTestData({
  phones = KNOWN_TEST_PHONES,
  vins = KNOWN_TEST_VINS,
  vehicleIds = [],
  supabase = null,
  verbose = true
} = {}) {
  const client = supabase || createTestSupabaseClient();
  if (!client) {
    if (verbose) console.warn('[testCleanup] Supabase credentials missing — cleanup skipped.');
    return { success: false, reason: 'NO_SUPABASE_CLIENT' };
  }

  const allPhones = [...new Set(phones.flatMap(phoneVariants).filter(Boolean))];
  const allVins = [...new Set(vins.map(v => String(v || '').toUpperCase().trim()).filter(Boolean))];
  const ids = new Set(vehicleIds.filter(Boolean));
  const plates = new Set();

  // Resolve vehicles created by the test run (and their plates).
  try {
    const filters = [];
    if (allVins.length) filters.push(`vin.in.(${allVins.join(',')})`);
    if (allPhones.length) filters.push(`owner_phone.in.(${allPhones.join(',')})`);
    if (filters.length) {
      const { data } = await client.from('vehicles').select('id, plate_number').or(filters.join(','));
      for (const v of data || []) {
        ids.add(v.id);
        if (v.plate_number) plates.add(v.plate_number);
      }
    }
  } catch {}

  const vehicleIdList = [...ids];
  const summary = {};

  // Dependent records (historical logs created by tests).
  summary.expenses = await deleteIn(client, 'expenses', 'plate', [...plates], verbose);
  summary.expense_logs = await deleteIn(client, 'expense_logs', 'vehicle_id', vehicleIdList, verbose);
  summary.private_earnings = await deleteIn(client, 'private_earnings', 'vehicle_id', vehicleIdList, verbose);
  summary.driver_assignments = await deleteIn(client, 'driver_assignments', 'vehicle_id', vehicleIdList, verbose);
  try {
    if (allPhones.length) {
      const { data: driverProfiles } = await client.from('profiles').select('id').in('phone_number', allPhones);
      const driverIds = (driverProfiles || []).map((p) => p.id);
      if (driverIds.length) {
        summary.driver_compliances = await deleteIn(client, 'driver_compliances', 'driver_id', driverIds, verbose);
        summary.driver_assignments_by_driver = await deleteIn(client, 'driver_assignments', 'driver_id', driverIds, verbose);
      }
    }
  } catch { /* driver tables may not exist on legacy deployments */ }
  summary.expiry_notification_log = await deleteIn(client, 'expiry_notification_log', 'vehicle_id', vehicleIdList, verbose);
  summary.reminders = await deleteIn(client, 'reminders', 'vehicle_id', vehicleIdList, verbose);
  summary.passbook_transfers = await deleteIn(client, 'passbook_transfers', 'vehicle_id', vehicleIdList, verbose);
  summary.pending_owner_notifications = await deleteIn(client, 'pending_owner_notifications', 'vehicle_id', vehicleIdList, verbose);
  summary.coupons = await deleteIn(client, 'coupons', 'vin', allVins, verbose);

  // Release any driver assignment held by a test phone.
  try {
    if (allPhones.length) {
      const { data: profiles } = await client.from('profiles').select('id').in('phone_number', allPhones);
      const profileIds = (profiles || []).map(p => p.id);
      if (profileIds.length) {
        await client.from('vehicles').update({ assigned_driver_id: null }).in('assigned_driver_id', profileIds);
        summary.receipts_owner = await deleteIn(client, 'receipts', 'owner_id', profileIds, verbose);
        summary.receipts_driver = await deleteIn(client, 'receipts', 'driver_id', profileIds, verbose);
      }
    }
  } catch {}

  summary.vehicles = await deleteIn(client, 'vehicles', 'id', vehicleIdList, verbose);
  summary.vin_registry = await deleteIn(client, 'vin_registry', 'vin', allVins, verbose);
  summary.chat_history = await deleteIn(client, 'chat_history', 'user_phone', allPhones, verbose);
  summary.chat_transcripts = await deleteIn(client, 'chat_transcripts', 'phone_number', allPhones, verbose);
  summary.chat_friction_logs = await deleteIn(client, 'chat_friction_logs', 'user_phone', allPhones, verbose);
  summary.processed_webhooks = await deleteIn(client, 'processed_webhooks', 'phone_number', allPhones, verbose);
  summary.chat_sessions = await deleteIn(client, 'chat_sessions', 'phone_number', allPhones, verbose);
  summary.superadmin_sessions = await deleteIn(client, 'superadmin_sessions', 'phone_number', allPhones, verbose);

  // Autonomous remediation pipeline rows created by test_remediation_pipeline.js.
  const testProposalCodes = ['FIX-TEST-0001', 'FIX-TEST-0002', 'FIX-TEST-0003', 'FIX-TEST-0004'];
  summary.remediation_proposals = await deleteIn(client, 'remediation_proposals', 'proposal_code', testProposalCodes, verbose);
  try {
    const { error, count } = await client
      .from('sentinel_audit_runs')
      .delete({ count: 'exact' })
      .eq('run_date', '2000-01-03');
    if (!error) summary.sentinel_audit_runs = count || 0;
  } catch {}
  summary.profiles = await deleteIn(client, 'profiles', 'phone_number', allPhones, verbose);

  if (verbose) {
    console.log('\n--- Test Data Cleanup Summary ---');
    console.table(Object.entries(summary).map(([table, deleted]) => ({ table, deleted_rows: deleted })));
  }

  return { success: true, deleted: summary };
}

/**
 * Run a test function and ALWAYS clear its data afterwards (even on failure).
 */
export async function runWithCleanup({ testFn, phones = [], vins = [], vehicleIds = [], supabase = null, verbose = true }) {
  try {
    return await testFn();
  } finally {
    try {
      await cleanupTestData({
        phones: phones.length ? phones : KNOWN_TEST_PHONES,
        vins: vins.length ? vins : KNOWN_TEST_VINS,
        vehicleIds,
        supabase,
        verbose
      });
    } catch (cleanupErr) {
      console.error('[testCleanup] Cleanup failed:', cleanupErr.message);
    }
  }
}
