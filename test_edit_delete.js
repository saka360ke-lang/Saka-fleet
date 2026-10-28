import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { classifyIntentWithRegex, extractVehicleAttributes } from './sakaAi.js';
import {
  sanitizeVehicleUpdates,
  updateVehicleDetails,
  deleteVehicle,
  isVehicleOwner,
  IMMUTABLE_VEHICLE_FIELDS
} from './src/services/vehicles.js';
import { runWithCleanup } from './scripts/testCleanup.js';

const OWNER_PHONE = '+254799123456';
const DRIVER_PHONE = '+254799123457';
const TEST_VIN = '1HGCM82633A004352';
const TEST_PLATE = 'KZZ 999Z';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runTests() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // 1. Regex intent classification
  console.log('--- Test 1: Edit/delete intent classification ---');
  assert(classifyIntentWithRegex('update vehicle KDA 123A color to White').intent === 'EDIT_VEHICLE', 'EDIT_VEHICLE not detected');
  assert(classifyIntentWithRegex('delete vehicle KDA 123A').intent === 'DELETE_VEHICLE', 'DELETE_VEHICLE not detected');
  assert(classifyIntentWithRegex('update my name to Jane Doe').intent === 'EDIT_PROFILE', 'EDIT_PROFILE not detected');
  assert(classifyIntentWithRegex('delete my account').intent === 'DELETE_ACCOUNT', 'DELETE_ACCOUNT not detected');
  const editAttrs = extractVehicleAttributes('update vehicle KDA 123A color to White');
  assert(editAttrs.plate_number === 'KDA 123A', 'Edit target plate not extracted');
  assert(editAttrs.color === 'White', 'Edit color value not extracted');
  console.log('✅ New edit/delete intents classified correctly and edit attributes extracted.');

  // 2. VIN immutability at the sanitizer level
  console.log('\n--- Test 2: VIN + passbook token sanitization ---');
  const { updates, rejected } = sanitizeVehicleUpdates({
    color: 'White',
    vin: '1HGCM82633A999999',
    qr_passbook_token: 'SK-HACK'
  });
  assert(rejected.includes('vin'), 'VIN was not rejected');
  assert(rejected.includes('qr_passbook_token'), 'Passbook token was not rejected');
  assert(!updates.vin && !updates.qr_passbook_token, 'Immutable fields leaked into update payload');
  assert(updates.color === 'White', 'Editable field was dropped');
  assert(IMMUTABLE_VEHICLE_FIELDS.includes('vin'), 'VIN missing from immutable list');
  console.log('✅ Sanitizer strips VIN + passbook token while keeping editable fields.');

  // 3. Seed data
  console.log('\n--- Test 3: Seed owner, driver and vehicle ---');
  const { data: owner, error: ownerErr } = await supabase.from('profiles').insert([{
    id: crypto.randomUUID(),
    phone_number: OWNER_PHONE,
    full_name: 'Edit Delete Owner',
    email: 'edit.delete.owner@example.com',
    is_active: true
  }]).select().single();
  assert(!ownerErr && owner, `Owner seed failed: ${ownerErr?.message}`);

  const { data: driver, error: driverErr } = await supabase.from('profiles').insert([{
    id: crypto.randomUUID(),
    phone_number: DRIVER_PHONE,
    full_name: 'Edit Delete Driver',
    is_active: true
  }]).select().single();
  assert(!driverErr && driver, `Driver seed failed: ${driverErr?.message}`);

  const { data: vehicle, error: vehErr } = await supabase.from('vehicles').insert([{
    id: crypto.randomUUID(),
    owner_id: owner.id,
    owner_phone: OWNER_PHONE,
    assigned_driver_id: driver.id,
    plate_number: TEST_PLATE,
    make_model: 'Toyota Fielder',
    yom: 2018,
    fuel_type: 'Petrol',
    current_mileage: 50000,
    odometer_reading: 50000,
    vin: TEST_VIN,
    status: 'ACTIVE'
  }]).select().single();
  assert(!vehErr && vehicle, `Vehicle seed failed: ${vehErr?.message}`);
  console.log('✅ Seeded owner, driver and VIN-locked vehicle.');

  // 4. Update editable details (VIN must be ignored)
  console.log('\n--- Test 4: Update editable vehicle details ---');
  const updateRes = await updateVehicleDetails({
    vehicleId: vehicle.id,
    requesterId: owner.id,
    updates: { color: 'White', current_mileage: 52000, vin: '1HGCM82633A999999' },
    supabase
  });
  assert(updateRes.success, `Update failed: ${updateRes.error}`);
  assert(updateRes.vehicle.color === 'White', 'Color was not updated');
  assert(updateRes.vehicle.current_mileage === 52000, 'Mileage was not updated');
  assert(updateRes.vehicle.vin === TEST_VIN, 'VIN changed during a mixed update!');
  assert(updateRes.rejected.includes('vin'), 'VIN rejection was not surfaced');
  console.log('✅ Editable fields updated; VIN untouched and flagged as rejected.');

  const { error: triggerErr } = await supabase
    .from('vehicles')
    .update({ vin: '1HGCM82633A888888' })
    .eq('id', vehicle.id);
  assert(triggerErr, 'Database trigger failed to block a direct VIN mutation');
  console.log('✅ DB trigger blocked direct VIN mutation:', triggerErr.message);

  // 5. Owner-only authorization
  console.log('\n--- Test 5: Owner-only authorization ---');
  assert((await isVehicleOwner({ vehicleId: vehicle.id, requesterId: owner.id, supabase })) === true, 'Owner check failed');
  assert((await isVehicleOwner({ vehicleId: vehicle.id, requesterId: driver.id, supabase })) === false, 'Driver incorrectly treated as owner');
  const unauthorizedEdit = await updateVehicleDetails({ vehicleId: vehicle.id, requesterId: driver.id, updates: { color: 'Red' }, supabase });
  assert(!unauthorizedEdit.success && unauthorizedEdit.reason === 'NOT_OWNER', 'Non-owner edit was not blocked');
  const unauthorizedDelete = await deleteVehicle({ vehicleId: vehicle.id, requesterId: driver.id, supabase });
  assert(!unauthorizedDelete.success && unauthorizedDelete.reason === 'NOT_OWNER', 'Non-owner deletion was not blocked');
  console.log('✅ Non-owner edit and delete are blocked.');

  // 6. Owner deletion + cascading cleanup
  console.log('\n--- Test 6: Owner vehicle deletion + cascade ---');
  const { error: transferInsertErr } = await supabase.from('passbook_transfers').insert([{
    vehicle_id: vehicle.id,
    from_owner_id: owner.id,
    vin: TEST_VIN,
    status: 'PENDING'
  }]);
  assert(!transferInsertErr, `Transfer seed failed: ${transferInsertErr?.message}`);
  await supabase.from('expense_logs').insert([{
    vehicle_id: vehicle.id,
    expense_type: 'Fuel',
    amount: 1000,
    fuel_liters: 10,
    odometer_reading: 52000
  }]);
  await supabase.from('reminders').insert([{
    vehicle_id: vehicle.id,
    reminder_type: 'Insurance Renewal',
    due_date: '2027-01-01',
    status: 'active'
  }]);

  const deleteRes = await deleteVehicle({ vehicleId: vehicle.id, requesterId: owner.id, supabase });
  assert(deleteRes.success, `Deletion failed: ${deleteRes.error}`);
  assert(deleteRes.cleanup.driverUnassigned, 'Driver was not flagged as unassigned');
  assert(deleteRes.cleanup.transfersCancelled >= 1, 'Pending transfer was not cancelled');

  const { data: deletedVehicle } = await supabase.from('vehicles').select('*').eq('id', vehicle.id).maybeSingle();
  assert(deletedVehicle && deletedVehicle.deleted_at, 'Vehicle was not soft-deleted');
  assert(deletedVehicle.assigned_driver_id === null, 'Driver was not unassigned');
  assert(deletedVehicle.vin === TEST_VIN, 'VIN was not preserved on the deleted record');
  assert(deletedVehicle.status === 'DELETED', 'Vehicle status was not set to DELETED');

  const { data: preservedExpenses } = await supabase.from('expense_logs').select('id').eq('vehicle_id', vehicle.id);
  assert(preservedExpenses && preservedExpenses.length === 1, 'Historical expense logs were not preserved');

  const { data: transfer } = await supabase.from('passbook_transfers').select('status').eq('vehicle_id', vehicle.id).maybeSingle();
  assert(transfer && transfer.status === 'CANCELLED', 'Pending transfer was not cancelled');

  const { data: reminder } = await supabase.from('reminders').select('status').eq('vehicle_id', vehicle.id).maybeSingle();
  assert(reminder && reminder.status === 'cancelled', 'Active reminder was not retired');

  console.log('✅ Vehicle soft-deleted, driver unassigned, transfers cancelled, logs preserved.');
  console.log('\n🎉 All edit/delete + VIN immutability tests passed.');
}

runWithCleanup({
  testFn: runTests,
  phones: [OWNER_PHONE, DRIVER_PHONE],
  vins: [TEST_VIN]
}).catch(err => {
  console.error('\n❌ Test suite failed:', err.message);
  process.exit(1);
});
