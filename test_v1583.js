// v1.58.3 - cross-vehicle ledger scoping + one-line plate routing regressions.
import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { matchNarrativeVehicle } from './src/services/narrativeDraft.js';
import { resolveLedgerVehicleScope } from './src/services/entryAnswers.js';
import { listLedgerEntries } from './src/services/entryLedger.js';
import { runWithCleanup } from './scripts/testCleanup.js';

const OWNER_PHONE = '+254799123459';
const VIN_A = 'JTEBV1583A0000001';
const VIN_B = 'JTEBV1583A0000002';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + (detail ? ' | ' + JSON.stringify(detail) : '')); }
}

const VEHICLES = [
  { id: 'v1', plate_number: 'KDA 123A', make_model: 'Toyota Fielder' },
  { id: 'v2', plate_number: 'KCB 456B', make_model: 'Toyota Probox' }
];

async function runTests() {
  console.log('=== v1.58.3: plate routing + ledger scoping ===');

  // 1. one-line log with a plate routes to the correct vehicle
  const platePick = matchNarrativeVehicle('Logged 40L at 50350 km kcb 456b', VEHICLES, VEHICLES[0]);
  check('one-line log with a plate routes to the correct vehicle', platePick.reason === 'plate' && platePick.vehicle?.id === 'v2', platePick);

  // 2. one-line log without a plate is ambiguous (safe gate)
  const noPlate = matchNarrativeVehicle('Logged 40L at 50350 km', VEHICLES, VEHICLES[0]);
  check('one-line log without a plate is ambiguous, not silently defaulted', noPlate.reason === 'ambiguous' && noPlate.vehicle === null, noPlate);

  const scopedActive = resolveLedgerVehicleScope({ text: 'edit entry', vehicles: VEHICLES, activeVehicle: VEHICLES[0] });
  check('ledger scopes to the active vehicle when no plate is named', scopedActive.reason === 'active' && scopedActive.vehicleIds.length === 1 && scopedActive.vehicleIds[0] === 'v1', scopedActive);
  const scopedPlate = resolveLedgerVehicleScope({ text: 'edit entry for kcb 456b', vehicles: VEHICLES, activeVehicle: VEHICLES[0] });
  check('a plate in the command scopes the ledger to that vehicle', scopedPlate.reason === 'plate' && scopedPlate.vehicleIds[0] === 'v2', scopedPlate);
  const scopedPinned = resolveLedgerVehicleScope({ text: 'amount 4800', vehicles: VEHICLES, activeVehicle: VEHICLES[0], pendingVehicleId: 'v2' });
  check('a pending edit stays pinned to its vehicle', scopedPinned.reason === 'pending' && scopedPinned.vehicleIds[0] === 'v2', scopedPinned);
  const scopedAmbig = resolveLedgerVehicleScope({ text: 'my entries', vehicles: VEHICLES, activeVehicle: null });
  check('no vehicle and no active and several vehicles is ambiguous', scopedAmbig.ambiguous === true, scopedAmbig);
  const scopedSingle = resolveLedgerVehicleScope({ text: 'my entries', vehicles: [VEHICLES[0]], activeVehicle: null });
  check('a single vehicle still resolves automatically', scopedSingle.reason === 'single' && scopedSingle.vehicleIds[0] === 'v1', scopedSingle);

  // 3. live: scoping to vehicle A can never surface vehicle B history
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('\nWARN Supabase credentials missing - live scoping test skipped.');
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: owner, error: ownerErr } = await supabase.from('profiles').insert([{
    id: crypto.randomUUID(), phone_number: OWNER_PHONE, full_name: 'Scoping Owner', is_active: true
  }]).select().single();
  if (ownerErr || !owner) throw new Error('profile seed failed: ' + (ownerErr?.message || 'no row'));

  async function mkVehicle(plate, vin) {
    const { data, error } = await supabase.from('vehicles').insert([{
      id: crypto.randomUUID(), owner_id: owner.id, owner_phone: OWNER_PHONE,
      plate_number: plate, make_model: 'Isuzu NQR', yom: 2020, fuel_type: 'Diesel',
      current_mileage: 50000, odometer_reading: 50000, vin, status: 'ACTIVE'
    }]).select().single();
    if (error || !data) throw new Error('vehicle seed failed: ' + (error?.message || 'no row'));
    return data;
  }

  const vehA = await mkVehicle('KDA 158A', VIN_A);
  const vehB = await mkVehicle('KCB 158B', VIN_B);

  const { data: expA } = await supabase.from('expense_logs').insert([{
    vehicle_id: vehA.id, driver_id: owner.id, expense_type: 'Fuel', amount: 4500
  }]).select().single();
  const { data: expB } = await supabase.from('expense_logs').insert([{
    vehicle_id: vehB.id, driver_id: owner.id, expense_type: 'Parts', amount: 8000
  }]).select().single();

  const listA = await listLedgerEntries(supabase, { ownerId: owner.id, vehicleIds: [vehA.id], limit: 6 });
  check('scoping to vehicle A lists only A rows', listA.length === 1 && listA[0].id === expA.id, listA.map(function (e) { return e.id; }));
  const listB = await listLedgerEntries(supabase, { ownerId: owner.id, vehicleIds: [vehB.id], limit: 6 });
  check('scoping to vehicle B lists only B rows (no cross-vehicle leak)', listB.length === 1 && listB[0].id === expB.id, listB.map(function (e) { return e.id; }));
}

runWithCleanup({
  testFn: async function () {
    try {
      await runTests();
    } finally {
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        try {
          const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
          await client.from('admin_audit_logs').delete().eq('admin_phone', OWNER_PHONE);
        } catch { /* best-effort */ }
      }
      console.log('\n' + pass + ' passed, ' + fail + ' failed');
      if (fail !== 0) process.exitCode = 1;
      else console.log('ALL v1.58.3 TESTS PASSED (' + pass + ' assertions).');
    }
  },
  phones: [OWNER_PHONE],
  vins: [VIN_A, VIN_B]
}).catch(function (err) {
  console.error('\nTest suite failed:', err.message);
  process.exit(1);
});