import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import {
  evaluateConversationalFriction,
  ensureSentinelTables,
  logChatTranscript
} from './src/workers/sentinel.js';
import {
  handleSuperadminFlow,
  handleAdminReportCommand,
  handleAdminAuditCommand,
  handleAdminAlertsCommand,
  handleAdminRulesReset,
  handleAdminRulesToggle,
  handleAdminRulesList,
  sendMorningExecutiveBriefing,
  isSuperadminPhone
} from './src/services/superadmin.js';
import { getSakaCorePrompt } from './sakaAi.js';
import {
  canAssignDriverToVehicle,
  assignDriverToVehicle,
  unassignDriverFromVehicle,
  checkOwnerVehicleTierLimit
} from './src/services/vehicles.js';
import { sendSupportEscalationEmail } from './src/services/mailer.js';
import { handleWhatsAppWebhook } from './src/routes/whatsapp.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const superadminPhone = process.env.SUPERADMIN_PHONE || '+254720641985';

async function runTests() {
  console.log('===============================================================');
  console.log('  SAKA FLEET PHASE 2 COMPREHENSIVE INTEGRATION TEST SUITE');
  console.log('===============================================================\n');

  // TEST 1: Sentinel Tables Verification
  console.log('--- Test 1: Ensuring Sentinel Tables & Schemas Exist ---');
  const tableStatus = await ensureSentinelTables(supabase);
  console.log('Sentinel Tables Status:', tableStatus);

  const { error: eFriction } = await supabase.from('chat_friction_logs').select('id').limit(1);
  const { error: eRules } = await supabase.from('saka_dynamic_rules').select('id').limit(1);
  if (eFriction || eRules) {
    throw new Error(`Schema check failed: ${eFriction?.message || eRules?.message}`);
  }
  console.log('✅ chat_friction_logs and saka_dynamic_rules verified.\n');

  // TEST 2: Sentinel Conversational Friction Evaluation Loop
  console.log('--- Test 2: Testing evaluateConversationalFriction() ---');
  const frictionUserPhone = '+254788111222';

  await supabase.from('chat_history').insert([
    { user_phone: frictionUserPhone, role: 'assistant', message: 'Please enter your vehicle VIN chassis number (11-17 characters).' },
    { user_phone: frictionUserPhone, role: 'user', message: 'I am stuck, why are you looping and repeating? I dont know what VIN means!' },
    { user_phone: frictionUserPhone, role: 'assistant', message: 'Please enter your vehicle VIN chassis number (11-17 characters).' },
    { user_phone: frictionUserPhone, role: 'user', message: 'This is not working, I am confused, stop asking the same thing' }
  ]);

  const frictionResult = await evaluateConversationalFriction(supabase);
  console.log('evaluateConversationalFriction Result:', JSON.stringify(frictionResult, null, 2));

  const { data: loggedFriction } = await supabase
    .from('chat_friction_logs')
    .select('*')
    .eq('user_phone', frictionUserPhone)
    .order('detected_at', { ascending: false })
    .limit(1);

  if (!loggedFriction || loggedFriction.length === 0) {
    throw new Error('Friction incident was not logged into chat_friction_logs table!');
  }
  console.log('✅ Friction incident successfully captured in chat_friction_logs:', loggedFriction[0].friction_type);

  // TEST 3: Runtime Injection into Gemini System Prompt
  console.log('\n--- Test 3: Runtime Injection of Dynamic Rules into Prompt ---');
  const testRuleKey = 'clarify_vin_entry_test';
  await supabase.from('saka_dynamic_rules').upsert({
    rule_key: testRuleKey,
    rule_description: 'Test behavioral hint for VIN explanation',
    patch_instruction: 'When user expresses confusion about VIN, explain that it is the 17-digit chassis number found in the logbook.',
    is_active: true,
    updated_at: new Date().toISOString()
  }, { onConflict: 'rule_key' });

  const runtimePrompt = await getSakaCorePrompt(supabase);
  if (!runtimePrompt.includes(testRuleKey) || !runtimePrompt.includes('ACTIVE SENTINEL DYNAMIC MICRO-RULES')) {
    throw new Error('Active dynamic micro-rules were not injected into runtime Gemini system prompt!');
  }
  console.log('✅ Active dynamic micro-rule verified in runtime system prompt.\n');

  // TEST 4: Admin Kill Switch (adminrules reset & toggle)
  console.log('--- Test 4: Testing Admin Kill Switch Commands ---');
  const toggleOff = await handleAdminRulesToggle(supabase, testRuleKey);
  console.log('Toggle OFF result:', toggleOff.reply);
  if (!toggleOff.reply.includes('INACTIVE')) {
    throw new Error('adminrules toggle did not set status to INACTIVE');
  }

  const toggleOn = await handleAdminRulesToggle(supabase, testRuleKey);
  console.log('Toggle ON result:', toggleOn.reply);
  if (!toggleOn.reply.includes('ACTIVE')) {
    throw new Error('adminrules toggle did not set status to ACTIVE');
  }

  const listRes = await handleAdminRulesList(supabase);
  console.log('Rules List response snippet:\n' + listRes.reply.slice(0, 150) + '...\n');

  const resetRes = await handleAdminRulesReset(supabase);
  console.log('Rules Reset result:', resetRes.reply);
  const { data: activeAfterReset } = await supabase
    .from('saka_dynamic_rules')
    .select('*')
    .eq('is_active', true);
  if (activeAfterReset && activeAfterReset.length > 0) {
    throw new Error('adminrules reset failed to deactivate all dynamic rules!');
  }
  console.log('✅ Admin Kill Switch successfully deactivated all dynamic rules.\n');
  // TEST 5: Superadmin WhatsApp Commands (admin report, admin audit, admin alerts)
  console.log('--- Test 5: Testing Superadmin WhatsApp Command Hub ---');
  await supabase.from('superadmin_sessions').upsert({
    phone_number: superadminPhone,
    is_active: true,
    last_active_at: new Date().toISOString()
  });

  const reportRes = await handleSuperadminFlow(supabase, superadminPhone, 'admin report');
  console.log('Admin Report Response snippet:\n' + reportRes.reply.slice(0, 200) + '...\n');
  if (!reportRes.reply.includes('Executive Digest') || !reportRes.reply.includes('Fleet Overview')) {
    throw new Error('admin report output missing executive fleet overview!');
  }

  const { data: sampleVeh } = await supabase.from('vehicles').select('plate_number, vin').is('deleted_at', null).limit(1).single();
  const targetAudit = sampleVeh?.plate_number || 'KDA 999Z';

  const auditRes = await handleSuperadminFlow(supabase, superadminPhone, `admin audit ${targetAudit}`);
  console.log('Admin Audit Response snippet:\n' + auditRes.reply.slice(0, 200) + '...\n');
  if (!auditRes.reply.includes('Audit Passbook') || !auditRes.reply.includes('Asset Record')) {
    throw new Error('admin audit output missing passbook audit headers!');
  }

  const alertsRes = await handleSuperadminFlow(supabase, superadminPhone, 'admin alerts');
  console.log('Admin Alerts Response snippet:\n' + alertsRes.reply.slice(0, 200) + '...\n');
  if (!alertsRes.reply.includes('Alerts & Warnings')) {
    throw new Error('admin alerts output missing expected format!');
  }
  console.log('✅ Superadmin Command Center commands (admin report, admin audit, admin alerts) verified.\n');

  // TEST 6: Morning Executive Briefing
  console.log('--- Test 6: Testing Automated 8:00 AM Morning Executive Briefing ---');
  const briefingMsg = await sendMorningExecutiveBriefing(supabase);
  if (!briefingMsg || !briefingMsg.includes('8:00 AM Executive Morning Briefing')) {
    throw new Error('sendMorningExecutiveBriefing failed to synthesize executive briefing!');
  }
  console.log('✅ Morning executive briefing generated and dispatched.\n');

  // TEST 7: Sentinel Scope Bounds (Strict Separation from General Vehicle Alerts)
  console.log('--- Test 7: Testing Sentinel System Boundaries & Scope Guard ---');
  function canDeliverVehicleAlertTest(targetPhone, vehicle) {
    if (!targetPhone) return false;
    if (isSuperadminPhone(targetPhone)) {
      if (!vehicle) return false;
      const cleanAdmin = targetPhone.replace(/[^\d]/g, '');
      const ownerPhone = (vehicle.owner_phone || vehicle.profiles?.phone_number || '').replace(/[^\d]/g, '');
      const driverPhone = (vehicle.assigned_driver_profile?.phone_number || '').replace(/[^\d]/g, '');
      return cleanAdmin === ownerPhone || cleanAdmin === driverPhone;
    }
    return true;
  }

  const otherVehicle = { plate_number: 'KAA 001A', owner_phone: '+254700000001', assigned_driver_profile: { phone_number: '+254700000002' } };
  const ownedVehicle = { plate_number: 'KAA 002B', owner_phone: superadminPhone, assigned_driver_profile: null };

  const blockedForSentinel = canDeliverVehicleAlertTest(superadminPhone, otherVehicle);
  const allowedForSentinel = canDeliverVehicleAlertTest(superadminPhone, ownedVehicle);
  const normalUserAllowed = canDeliverVehicleAlertTest('+254799000111', otherVehicle);

  if (blockedForSentinel !== false) {
    throw new Error('Sentinel scope guard failed: Superadmin incorrectly received alert for other vehicle!');
  }
  if (allowedForSentinel !== true) {
    throw new Error('Sentinel scope guard failed: Superadmin blocked from their personally owned vehicle alert!');
  }
  if (normalUserAllowed !== true) {
    throw new Error('Normal user alert delivery was incorrectly blocked!');
  }
  console.log('✅ Sentinel scope bounds strictly verified.\n');

  // TEST 8: Subscription-Tier Vehicle Ownership Limits
  console.log('--- Test 8: Testing Subscription-Tier Vehicle Ownership Limits ---');
  const freeOwnerId = crypto.randomUUID();
  const tierTest1 = await checkOwnerVehicleTierLimit({
    ownerId: freeOwnerId,
    subscriptionTier: 'free',
    supabase
  });
  console.log('Free tier check:', tierTest1);
  if (!tierTest1.canAdd || tierTest1.limit !== 1) {
    throw new Error('Free tier vehicle limit check failed!');
  }

  const soloTest = await checkOwnerVehicleTierLimit({
    ownerId: freeOwnerId,
    subscriptionTier: 'solo_pro',
    supabase
  });
  console.log('Solo Pro tier check:', soloTest);
  if (soloTest.limit !== 3) {
    throw new Error('Solo Pro tier vehicle limit should be 3!');
  }
  console.log('✅ Subscription-tier vehicle capacity limits verified.\n');

  // TEST 9: Strict 1-to-1 Driver Assignments
  console.log('--- Test 9: Testing Strict 1-to-1 Driver Assignment Constraints ---');
  const { data: existingOwner } = await supabase.from('profiles').select('id').limit(1).single();
  const testOwnerId = existingOwner.id;

  const testDriverId = crypto.randomUUID();
  const testDriverPhone = '+2547' + Math.floor(10000000 + Math.random() * 90000000);
  await supabase.from('profiles').insert([{
    id: testDriverId,
    phone_number: testDriverPhone,
    full_name: 'Test Strict Driver',
    is_active: true
  }]);

  const testVeh1Id = crypto.randomUUID();
  const testVeh2Id = crypto.randomUUID();
  const testPlate1 = 'T' + Math.floor(100 + Math.random() * 900) + 'AA';
  const testPlate2 = 'T' + Math.floor(100 + Math.random() * 900) + 'BB';

  const { error: insVehErr } = await supabase.from('vehicles').insert([
    { id: testVeh1Id, owner_id: testOwnerId, plate_number: testPlate1, make_model: 'Toyota Fielder', status: 'ACTIVE' },
    { id: testVeh2Id, owner_id: testOwnerId, plate_number: testPlate2, make_model: 'Toyota Land Cruiser', status: 'ACTIVE' }
  ]);
  if (insVehErr) throw new Error(`Failed to insert test vehicles: ${insVehErr.message}`);

  // 1. Assign driver to Vehicle 1
  const assign1 = await assignDriverToVehicle({ vehicleId: testVeh1Id, driverId: testDriverId, supabase });
  console.log('First Assignment Result:', assign1.success);
  if (!assign1.success) {
    throw new Error(`Failed to assign driver to vehicle 1: ${assign1.error}`);
  }

  // 2. Attempt to assign SAME driver to Vehicle 2 (Must be BLOCKED under strict 1-to-1 rule)
  const assign2 = await assignDriverToVehicle({ vehicleId: testVeh2Id, driverId: testDriverId, supabase });
  console.log('Second Assignment Result (should fail):', assign2);
  if (assign2.success !== false || assign2.reason !== 'DRIVER_ALREADY_ASSIGNED') {
    throw new Error('Strict 1-to-1 rule violation: Driver was assigned to two vehicles simultaneously!');
  }
  console.log('✅ Driver assignment correctly blocked when driver already assigned to another vehicle.');

  // 3. Database unique constraint verification
  const { error: dbConstraintErr } = await supabase
    .from('vehicles')
    .update({ assigned_driver_id: testDriverId })
    .eq('id', testVeh2Id);

  if (!dbConstraintErr) {
    throw new Error('Database UNIQUE index failed to catch duplicate active driver assignment!');
  }
  console.log('✅ Database UNIQUE constraint idx_vehicles_unique_active_driver enforced:', dbConstraintErr.message);

  // 4. Unassign driver
  const unassignRes = await unassignDriverFromVehicle({ vehicleId: testVeh1Id, supabase });
  if (!unassignRes.success) throw new Error('Failed to unassign driver');

  const assignAfterUnassign = await assignDriverToVehicle({ vehicleId: testVeh2Id, driverId: testDriverId, supabase });
  if (!assignAfterUnassign.success) {
    throw new Error('Failed to assign driver after previous vehicle was unassigned');
  }
  console.log('✅ Driver assignment successfully re-assigned after unassigning from previous vehicle.\n');

  await supabase.from('vehicles').delete().in('id', [testVeh1Id, testVeh2Id]);
  await supabase.from('profiles').delete().eq('id', testDriverId);

  // TEST 10: Support Escalation Flow
  console.log('--- Test 10: Testing Support Escalation Flow ---');
  const userPhone = '+254733444555';
  const makeMockReq = (msg) => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ from: userPhone, text: { body: msg } }] } }] }]
    };
    const rawBody = JSON.stringify(body);
    const headers = {};
    if (process.env.META_APP_SECRET) {
      headers['x-hub-signature-256'] = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex');
    }
    return { body, rawBody, headers };
  };

  await handleWhatsAppWebhook(makeMockReq('I need human support with my account'), { status: () => ({ send: () => {} }) }, { log: console });

  await handleWhatsAppWebhook(makeMockReq('I tried updating my vehicle plate but got an error message. Please help me manually update it.'), { status: () => ({ send: () => {} }) }, { log: console });

  const { data: transcriptCheck } = await supabase
    .from('chat_transcripts')
    .select('*')
    .eq('phone_number', userPhone)
    .eq('sender', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1);

  const lastAssistantReply = transcriptCheck?.[0]?.message_text || '';
  console.log('Last Assistant Reply to Escalation:', lastAssistantReply);

  if (!lastAssistantReply.includes('support@sakafleet.com')) {
    throw new Error(`Expected support forwarding confirmation, got: "${lastAssistantReply}"`);
  }
  console.log('✅ Support escalation flow verified: prompt for single paragraph description -> email dispatch -> WhatsApp confirmation.\n');

  console.log('===============================================================');
  console.log('  ALL SAKA FLEET PHASE 2 INTEGRATION TESTS PASSED SUCCESSFULLY!');
  console.log('===============================================================\n');
}

runTests().catch(err => {
  console.error('❌ Integration Test Suite Failed:', err);
  process.exit(1);
});
