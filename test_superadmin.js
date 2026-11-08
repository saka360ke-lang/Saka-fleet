import dotenv from 'dotenv';
dotenv.config();
import assert from 'assert';
import { createClient } from '@supabase/supabase-js';
import {
  isSuperadminPhone,
  ensureSuperadminTables,
  handleSuperadminFlow,
  handleAdminReportCommand,
  handleProfilesReportCommand
} from './src/services/superadmin.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const superadminPhone = process.env.SUPERADMIN_PHONE || '+254712345678';
const normalUserPhone = '+254799000111';

// v1.72.0 (PRI-1) — the admin report must read `expense_logs` only. This mock
// proof pins the live-bug fix: summing BOTH tables double-counted every
// dual-written expense (the legacy `expenses` mirror + the canonical ledger).
{
  const tables = {
    vehicles: { rows: [{ id: 'v1', plate_number: 'KDA 100A', current_mileage: 1000, odometer_reading: 1000, status: 'ACTIVE', owner_id: 'o1', assigned_driver_id: 'd1' }], count: 1 },
    profiles: { rows: [{ id: 'o1' }], count: 1 },
    expenses: { rows: [{ amount: 999999 }], count: 1 },
    expense_logs: { rows: [{ amount: 100 }, { amount: 50 }], count: 2 },
    private_earnings: { rows: [{ revenue_amount: 2000 }], count: 1 },
    error_logs: { rows: [], count: 0 },
    saka_dynamic_rules: { rows: [], count: 0 },
    chat_friction_logs: { rows: [], count: 0 }
  };
  const queried = [];
  const mockClient = {
    from(table) {
      queried.push(table);
      const api = {
        select() { return api; },
        is() { return api; },
        eq() { return api; },
        gte() { return api; },
        then(resolve) {
          const entry = tables[table] || { rows: [] };
          resolve({ data: entry.rows || [], count: entry.count ?? (entry.rows || []).length, error: null });
        }
      };
      return api;
    }
  };
  const report = await handleAdminReportCommand(mockClient);
  assert.strictEqual(report.details.total_expenses, 150, 'PRI-1: the report total sums expense_logs only (150, never 999,999 + 150)');
  assert.ok(!queried.includes('expenses'), 'PRI-1: handleAdminReportCommand does not read the legacy expenses table — no double-count');
  console.log('✅ PRI-1: superadmin report double-count fix verified (expense_logs only)');
}

// v1.82.0 (Phase 21) — the profiles report must count REGISTERED accounts and
// name auto-provisioned shells separately. The +254734852529 ghost (no email,
// no name) headlined `admin profiles` after the wipe never completed; this mock
// proof pins the new definitions without touching the live database.
{
  const adminPhone = process.env.SUPERADMIN_PHONE || '+254712345678';
  const today = new Date().toISOString();
  const rows = [
    { id: 'sa', full_name: 'Superadmin', phone_number: adminPhone, email: null, country: 'Kenya', created_at: today },
    { id: 'ghost', full_name: null, phone_number: '+254734852529', email: null, country: 'Kenya', created_at: today },
    { id: 'real', full_name: 'Brenda Wanjiku', phone_number: '+254710268605', email: 'brenjonjo@gmail.com', country: 'Kenya', created_at: today },
    { id: 'driver', full_name: 'Driver Dan', phone_number: '+254700000001', email: null, country: 'Kenya', created_at: today }
  ];
  const mockClient = {
    from(table) {
      const api = {
        select() { return api; },
        is() { return api; },
        order() { return api; },
        limit() { return api; },
        then(resolve) {
          if (table === 'profiles') resolve({ data: rows, error: null });
          else resolve({ data: [], count: 0, error: null });
        }
      };
      return api;
    }
  };
  const report = await handleProfilesReportCommand(mockClient);
  assert.strictEqual(report.details.total_profiles, 2, 'profiles report: registered = email rows + the superadmin row (2)');
  assert.strictEqual(report.details.unverified_shells, 1, 'profiles report: the email-less, name-less ghost is a shell (1)');
  assert.strictEqual(report.details.named_no_email, 1, 'profiles report: a named driver without email is counted separately (1)');
  assert.ok(report.reply.includes('Unverified Shell Profiles'), 'profiles report: the shell counter is rendered');
  assert.ok(report.reply.includes('Brenda Wanjiku'), 'profiles report: a registered profile headlines Recent sign-ups');
  assert.ok(!report.reply.includes('+254734852529'), 'profiles report: the ghost never appears in Recent sign-ups');
  assert.strictEqual(report.details.signups_24h, 2, 'profiles report: 24h signups count registered profiles only');
  console.log('✅ v1.82.0: profiles report excludes auto-provisioned shells (ghost fix)');
}

async function runSuperadminTests() {
  console.log('====================================================');
  console.log('  STARTING SAKA FLEET SUPERADMIN FEATURE INTEGRATION TESTS');
  console.log('====================================================\n');

  // Test 1: Schema Verification & Table Creation
  console.log('--- Test 1: Schema Verification & Table Creation ---');
  const tableStatus = await ensureSuperadminTables(supabase);
  console.log('Table Verification Status:', JSON.stringify(tableStatus, null, 2));

  // Verify DB tables exist by querying schema
  const { error: sessionTableErr } = await supabase.from('superadmin_sessions').select('*').limit(1);
  const { error: couponsTableErr } = await supabase.from('coupons').select('*').limit(1);
  const { error: auditTableErr } = await supabase.from('admin_audit_logs').select('*').limit(1);

  if (sessionTableErr || couponsTableErr || auditTableErr) {
    throw new Error(`Table verification failed: ${sessionTableErr?.message || couponsTableErr?.message || auditTableErr?.message}`);
  }
  console.log('✅ All 3 superadmin tables exist in Supabase.\n');

  // Test 2: Non-Superadmin Message Intercept
  console.log('--- Test 2: Non-Superadmin Intercept Check ---');
  const normalRes = await handleSuperadminFlow(supabase, normalUserPhone, 'adminstart');
  console.log('Normal User Intercept Result:', normalRes);
  if (normalRes.isSuperadmin !== false) {
    throw new Error('Normal user message was incorrectly identified as superadmin!');
  }
  console.log('✅ Non-superadmin correctly bypassed.\n');

  // Test 3: Inactive Session Command Guard
  console.log('--- Test 3: Inactive Superadmin Session Guard ---');
  await supabase.from('superadmin_sessions').upsert({ phone_number: superadminPhone, is_active: false });

  const inactiveRes = await handleSuperadminFlow(supabase, superadminPhone, 'check health');
  console.log('Inactive Command Result:', inactiveRes);
  if (!inactiveRes.reply.includes("Please type 'adminstart'")) {
    throw new Error(`Expected inactive prompt, got: ${inactiveRes.reply}`);
  }
  console.log('✅ Inactive session guard working properly.\n');

  // Test 4: Session Start ("adminstart")
  console.log('--- Test 4: Session Start ("adminstart") ---');
  const startRes = await handleSuperadminFlow(supabase, superadminPhone, 'adminstart');
  console.log('Admin Start Result:', startRes);
  if (!startRes.reply.includes("Superadmin session started")) {
    throw new Error(`Expected start confirmation, got: ${startRes.reply}`);
  }

  const { data: activeSession } = await supabase
    .from('superadmin_sessions')
    .select('*')
    .eq('phone_number', superadminPhone)
    .single();

  if (!activeSession || activeSession.is_active !== true) {
    throw new Error('superadmin_sessions is_active was not set to true in database!');
  }


  // Test 5: Command Handler - Health / Sentinel Check
  console.log('--- Test 5: Command Handler - Health / Sentinel Check ---');
  const healthRes = await handleSuperadminFlow(supabase, superadminPhone, 'health check');
  console.log('Health Check Response:\n' + healthRes.reply + '\n');
  if (!healthRes.reply || (!healthRes.reply.includes('Container') && !healthRes.reply.includes('Database') && !healthRes.reply.includes('Status') && !healthRes.reply.includes('Sentinel'))) {
    throw new Error('Health check reply is missing essential telemetry information!');
  }
  console.log('✅ Health Check completed and DeepSeek-synthesized summary generated.\n');

  // Test 5b: Command Handler - AI Telemetry Digest (v1.13.0)
  console.log('--- Test 5b: Command Handler - AI Telemetry Digest ---');
  const aiStatsRes = await handleSuperadminFlow(supabase, superadminPhone, 'admin ai-stats');
  console.log('AI Telemetry Response:\n' + aiStatsRes.reply + '\n');
  if (!aiStatsRes.reply.includes('Saka AI Telemetry')) {
    throw new Error(`Expected the AI telemetry digest, got: ${aiStatsRes.reply}`);
  }
  console.log('✅ AI telemetry digest rendered from ai_usage_logs.\n');

  // Test 6: Command Handler - Coupon Generation
  console.log('--- Test 6: Command Handler - Coupon Generation ---');
  const targetPhone = '+254712345678';
  const couponRes = await handleSuperadminFlow(supabase, superadminPhone, `generate 25% coupon for ${targetPhone}`);
  console.log('Coupon Generation Response:\n' + couponRes.reply + '\n');
  if (!couponRes.reply.includes('SAKA-25-')) {
    throw new Error('Coupon code format is invalid!');
  }

  const codeMatch = couponRes.reply.match(/SAKA-25-[A-Z0-9]{4}/);
  if (!codeMatch) throw new Error('Failed to match SAKA-25-XXXX code in response');

  const generatedCode = codeMatch[0];
  const { data: couponRow } = await supabase
    .from('coupons')
    .select('*')
    .eq('code', generatedCode)
    .single();

  if (!couponRow) {
    throw new Error(`Coupon row with code ${generatedCode} was not found in coupons table!`);
  }
  console.log('DB Coupon Row Verified:', JSON.stringify(couponRow, null, 2));
  console.log('✅ Coupon generation and DB insertion verified.\n');

  // Test 7: Command Handler - Profiles Report
  console.log('--- Test 7: Command Handler - Profiles Report ---');
  const profilesRes = await handleSuperadminFlow(supabase, superadminPhone, 'profiles report');
  console.log('Profiles Report Response:\n' + profilesRes.reply + '\n');
  if (!profilesRes.reply.includes('Total Registered Profiles') && !profilesRes.reply.includes('Profiles Report')) {
    throw new Error('Profiles report response format is missing expected headers!');
  }
  console.log('✅ Profiles report generated successfully.\n');

  // Test 8: Audit Logging Verification
  console.log('--- Test 8: Audit Logging Verification ---');
  const { data: auditLogs, error: auditErr } = await supabase
    .from('admin_audit_logs')
    .select('*')
    .eq('admin_phone', superadminPhone)
    .order('created_at', { ascending: false })
    .limit(10);

  if (auditErr || !auditLogs || auditLogs.length < 4) {
    throw new Error(`Audit logs verification failed! Found ${auditLogs?.length || 0} logs.`);
  }

  console.log('Recent Admin Audit Logs:');
  auditLogs.forEach((log, idx) => {
    console.log(` ${idx + 1}. Action: ${log.action} | Time: ${log.created_at}`);
  });

  const actions = auditLogs.map(l => l.action);
  ['SESSION_START', 'HEALTH_CHECK', 'ADMIN_AI_STATS', 'GENERATE_COUPON', 'PROFILES_REPORT'].forEach(act => {
    if (!actions.includes(act)) {
      throw new Error(`Missing expected audit log action: ${act}`);
    }
  });
  console.log('✅ All superadmin actions logged in admin_audit_logs table.\n');

  // Test 9: Session Stop ("adminstop")
  console.log('--- Test 9: Session Stop ("adminstop") ---');
  const stopRes = await handleSuperadminFlow(supabase, superadminPhone, 'adminstop');
  console.log('Admin Stop Result:', stopRes);
  if (!stopRes.reply.includes("Superadmin session closed")) {
    throw new Error(`Expected stop confirmation, got: ${stopRes.reply}`);
  }

  const { data: inactiveSession } = await supabase
    .from('superadmin_sessions')
    .select('*')
    .eq('phone_number', superadminPhone)
    .single();

  if (!inactiveSession || inactiveSession.is_active !== false) {
    throw new Error('superadmin_sessions is_active was not set to false in database!');
  }
  console.log('✅ Session deactivated in DB.\n');

  console.log('====================================================');
  console.log('🎉 ALL SUPERADMIN INTEGRATION TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runSuperadminTests().catch(err => {
  console.error('❌ Superadmin Integration Test Failed:', err);
  process.exit(1);
});

