/**
 * Saka Fleet — Follow-up lane & driver-unassignment suite (v1.16.4)
 * -----------------------------------------------------------------
 * Offline (mock Supabase). Asserts the notification is queued from the single
 * vehicles.js choke point (owner unassign + vehicle deletion), that the worker
 * sends the deterministic copy, and that the compliance reason is explicit.
 *
 * Run: node --env-file=.env test_followups.js
 */

import assert from 'assert';
import fs from 'node:fs';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { notifyDriverUnassigned, processPendingFollowUps, FOLLOWUP_KINDS } from './src/services/followups.js';
import * as followupsModule from './src/services/followups.js';
import { unassignDriverFromVehicle, deleteVehicle } from './src/services/vehicles.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

async function run() {
  console.log('=== FOLLOW-UP LANE & DRIVER UNASSIGNMENT (v1.16.4) ===\n');

  console.log('--- Test 1: unassignment is queued for the driver (metadata phone) ---');
  const mock = createMockSupabase({
    pending_followups: [],
    vehicles: [{ id: 'v1', owner_id: 'owner-1', plate_number: 'KDA 123A', assigned_driver_id: 'drv-1', metadata: { assigned_driver_phone: '+254700000009' }, deleted_at: null }]
  });
  const released = await unassignDriverFromVehicle({ vehicleId: 'v1', supabase: mock.client });
  check(released.success === true && released.vehicle.assigned_driver_id === null, 'Driver is released');
  check(mock.db.pending_followups.length === 1, 'One follow-up job is queued');
  check(mock.db.pending_followups[0].phone === '+254700000009' && mock.db.pending_followups[0].kind === FOLLOWUP_KINDS.DRIVER_UNASSIGNED, 'Job targets the driver with the right kind');
  check(mock.db.pending_followups[0].payload?.plate === 'KDA 123A', 'Payload carries the plate');

  console.log('\n--- Test 2: the worker sends the deterministic notice once ---');
  const sent = [];
  const stats = await processPendingFollowUps({ supabase: mock.client, sendFn: async (phone, text, kind, templateVars) => { sent.push({ phone, text, kind, templateVars }); } });
  check(stats.sent === 1 && sent.length === 1, 'Worker sends exactly one message');
  check(/unassigned/i.test(sent[0].text) && sent[0].text.includes('KDA 123A'), 'Copy names the unassignment and the plate');
  check(sent[0].kind === 'driver_unassigned' && sent[0].templateVars?.plate === 'KDA 123A', 'the release notice carries the driver_unassigned kind and the plate variable');
  check(mock.db.pending_followups[0].status === 'sent', 'Job is marked sent');
  const again = await processPendingFollowUps({ supabase: mock.client, sendFn: async () => { throw new Error('should not resend'); } });
  check(again.sent === 0, 'Sent jobs never resend');

  console.log('\n--- Test 3: profile fallback when metadata has no phone ---');
  const fallbackMock = createMockSupabase({
    pending_followups: [],
    vehicles: [{ id: 'v2', owner_id: 'owner-1', plate_number: 'KDB 456B', assigned_driver_id: 'drv-2', metadata: {}, deleted_at: null }],
    profiles: [{ id: 'drv-2', phone_number: '+254700000010' }]
  });
  await unassignDriverFromVehicle({ vehicleId: 'v2', supabase: fallbackMock.client });
  check(fallbackMock.db.pending_followups[0]?.phone === '+254700000010', 'Driver phone falls back to the profile');

  console.log('\n--- Test 4: deleting a vehicle notifies the released driver ---');
  const deleteMock = createMockSupabase({
    pending_followups: [],
    passbook_transfers: [],
    reminders: [],
    vehicles: [{ id: 'v3', owner_id: 'owner-1', plate_number: 'KBJ 819C', assigned_driver_id: 'drv-3', metadata: { assigned_driver_phone: '+254700000011' }, deleted_at: null }]
  });
  const deleted = await deleteVehicle({ vehicleId: 'v3', requesterId: 'owner-1', supabase: deleteMock.client });
  check(deleted.success === true, 'Owner soft-deletes the vehicle');
  check(deleteMock.db.pending_followups[0]?.payload?.reason === 'vehicle_deleted', 'Deletion uses the vehicle_deleted reason');

  console.log('\n--- Test 5: compliance cancellation uses the explicit reason ---');
  const complianceMock = createMockSupabase({ pending_followups: [] });
  await notifyDriverUnassigned({ supabase: complianceMock.client, driverPhone: '+254700000012', plate: 'KDA 999Z', reason: 'compliance' });
  const complianceText = [];
  await processPendingFollowUps({ supabase: complianceMock.client, sendFn: async (_phone, text) => { complianceText.push(text); } });
  check(/three times/i.test(complianceText[0] || ''), 'Compliance notice explains the three-strike rule');

  console.log('\n--- Test 6: the retired fleet-report job (v1.77.0, Phase 16) ---');
  check(Object.keys(FOLLOWUP_KINDS).join(',') === 'DRIVER_UNASSIGNED', 'the lane carries ONLY the driver-unassigned kind (FLEET_REPORT retired)');
  check(followupsModule.runFleetReport === undefined && followupsModule.followUpAckText === undefined
    && followupsModule.resolveReportPdfLinkDelayMs === undefined,
    'the async report helpers are gone from the module surface');
  const staleMock = createMockSupabase({
    pending_followups: [{ id: 'stale-1', phone: '+254700000013', kind: 'fleet_report', payload: {}, status: 'pending', scheduled_for: new Date(Date.now() - 60000).toISOString(), created_at: new Date().toISOString() }]
  });
  const staleSends = [];
  const stale = await processPendingFollowUps({ supabase: staleMock.client, sendFn: async (phone, text) => { staleSends.push(text); } });
  check(stale.sent === 0 && stale.failed === 1 && staleSends.length === 0, 'a stale pre-deploy report row is failed honestly, never sent');
  check(/unknown or empty follow-up/.test(staleMock.db.pending_followups[0]?.error || ''), 'the failure reason names the retired kind');
  const source = fs.readFileSync('./src/services/followups.js', 'utf8');
  const commandsSource = fs.readFileSync('./src/routes/whatsapp/commands.js', 'utf8');
  check(!/Building your/.test(source) && !/followUpAckText/.test(commandsSource), 'the "building your report" copy is gone from both the lane and the service');
  check(!/queueReportFollowUp|fleet_report/.test(commandsSource), 'the WhatsApp lane never queues a report job again');
  check(commandsSource.includes('dashboardBaseUrl()}/reports'), 'the report lane points at the dashboard Reports page first');

  console.log(`\n🎉 ${passed} follow-up/unassignment assertions passed.`);
}

run().catch((err) => {
  console.error('\n❌ Follow-up/unassignment suite failed:', err.message);
  process.exit(1);
});
