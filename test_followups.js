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
import { createMockSupabase } from './scripts/mockSupabase.js';
import { notifyDriverUnassigned, processPendingFollowUps, FOLLOWUP_KINDS } from './src/services/followups.js';
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
  const stats = await processPendingFollowUps({ supabase: mock.client, sendFn: async (phone, text) => { sent.push({ phone, text }); } });
  check(stats.sent === 1 && sent.length === 1, 'Worker sends exactly one message');
  check(/unassigned/i.test(sent[0].text) && sent[0].text.includes('KDA 123A'), 'Copy names the unassignment and the plate');
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

  console.log(`\n🎉 ${passed} follow-up/unassignment assertions passed.`);
}

run().catch((err) => {
  console.error('\n❌ Follow-up/unassignment suite failed:', err.message);
  process.exit(1);
});
