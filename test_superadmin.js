import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import {
  isSuperadminPhone,
  ensureSuperadminTables,
  handleSuperadminFlow
} from './src/services/superadmin.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const superadminPhone = process.env.SUPERADMIN_PHONE || '+254712345678';
const normalUserPhone = '+254799000111';

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
  ['SESSION_START', 'HEALTH_CHECK', 'GENERATE_COUPON', 'PROFILES_REPORT'].forEach(act => {
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

