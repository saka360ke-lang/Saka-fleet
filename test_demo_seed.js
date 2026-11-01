/**
 * Saka Fleet — Demo fleet seed payload test (v1.31.0, stateless)
 * -------------------------------------------------------------
 * Proves the guarded demo seeder's payload is deterministic, complete (all 8
 * asset kinds, all expense types, all earning types, reminders and compliance)
 * and safe (demo phone/VINs, no test-fixture collisions). It NEVER touches the
 * database — the CLI path requires --confirm and a live Supabase client.
 *
 * Run: node test_demo_seed.js
 */

import assert from 'assert';
import { buildDemoSeedPayload, DEMO_PHONE, DEMO_DRIVER_PHONE } from './scripts/seed_demo_fleet.js';
import { KNOWN_TEST_PHONES, KNOWN_TEST_VINS } from './scripts/testCleanup.js';
import { EXPENSE_TYPES } from './src/services/expenseCatalog.js';
import { EARNING_TYPES } from './src/services/earningCatalog.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const NOW = new Date('2026-11-10T09:00:00+03:00');

console.log('=== SAKA FLEET — DEMO SEED PAYLOAD (v1.31.0) ===\n');

console.log('--- Test 1: safe identifiers ---');
check(DEMO_PHONE.startsWith('+') && DEMO_PHONE.length >= 12, 'Demo owner uses an E.164 phone');
check(!KNOWN_TEST_PHONES.includes(DEMO_PHONE), 'Demo owner phone never collides with test fixtures');
check(!KNOWN_TEST_PHONES.includes(DEMO_DRIVER_PHONE), 'Demo driver phone never collides with test fixtures');

const payload = buildDemoSeedPayload(NOW);

console.log('\n--- Test 2: fleet coverage (all asset kinds) ---');
check(payload.vehicles.length === 9, 'Nine demo vehicles (8 kinds + one EV)');
check(payload.summary.assetKinds.length === 8, 'All eight asset kinds are represented');
check(payload.vehicles.every((vehicle) => vehicle.metadata?.demo === true), 'Every vehicle is tagged as demo data');
check(payload.vehicles.every((vehicle) => vehicle.vin.startsWith('DEMO') && vehicle.vin.length === 17), 'Every demo VIN is 17 chars and DEMO-prefixed');
check(payload.vehicles.every((vehicle) => !KNOWN_TEST_VINS.includes(vehicle.vin)), 'Demo VINs never collide with test fixtures');
check(payload.vehicles.some((vehicle) => vehicle.fuel_type === 'Electric'), 'An EV is included (Charging coverage)');
check(payload.vehicles.every((vehicle) => vehicle.qr_passbook_token), 'Every vehicle carries a passbook token');

console.log('\n--- Test 3: expense coverage ---');
check(payload.summary.expenseTypesMissing.length === 0, `All ${EXPENSE_TYPES.length} expense types are exercised`);
check(payload.expenses.length >= EXPENSE_TYPES.length, `${payload.expenses.length} itemized demo expenses`);
check(payload.expenses.every((row) => row.vehicle_index >= 0 && row.vehicle_index < payload.vehicles.length), 'Every expense points at a demo vehicle');
check(payload.expenses.filter((row) => row.expense_type === 'Fuel').every((row) => row.fuel_liters > 0), 'Every fuel expense carries litres');
check(payload.expenses.filter((row) => row.expense_type !== 'Fuel').every((row) => !row.fill_type), 'Fill type is only set for fuel');
const charging = payload.expenses.find((row) => row.expense_type === 'Charging');
check(Boolean(charging) && payload.vehicles[charging.vehicle_index].fuel_type === 'Electric', 'Charging is logged on the EV');
const puncture = payload.expenses.find((row) => /puncture/i.test(row.notes || ''));
check(Boolean(puncture) && /tyre/i.test(puncture.notes), 'The live puncture story is represented');

console.log('\n--- Test 4: earning coverage ---');
check(payload.summary.earningTypesMissing.length === 0, `All ${EARNING_TYPES.length} earning types are exercised`);
check(payload.earnings.every((row) => row.amount > 0), 'Every earning has a positive amount');
check(payload.earnings.every((row) => row.logged_at && row.created_at), 'Every earning carries logged/created timestamps');

console.log('\n--- Test 5: reminders + compliance ---');
const reminderKinds = new Set(payload.reminders.map((row) => row.kind));
check(reminderKinds.has('date') && reminderKinds.has('distance') && reminderKinds.has('hours'), 'Date, distance and hours reminders are represented');
check(payload.reminders.some((row) => row.reminder_type === 'Road Service Licence'), 'PSL reminder is included');
check(payload.reminders.some((row) => row.reminder_type === 'Hydraulic service'), 'Machine hydraulic reminder is included');
const complianceTypes = payload.vehicleCompliances.map((row) => row.type);
check(['insurance', 'inspection', 'road_service_licence', 'speed_limiter'].every((type) => complianceTypes.includes(type)), 'Kenya vehicle compliance set is complete');
check(payload.driverCompliances.some((row) => row.type === 'psv_badge'), 'Driver PSV badge is included');

console.log('\n--- Test 6: determinism + summary integrity ---');
const again = buildDemoSeedPayload(NOW);
check(JSON.stringify(payload) === JSON.stringify(again), 'The payload is deterministic for a fixed clock');
check(payload.summary.vehicles === payload.vehicles.length, 'Summary vehicle count matches');
check(payload.summary.expenses === payload.expenses.length, 'Summary expense count matches');
check(payload.summary.earnings === payload.earnings.length, 'Summary earning count matches');
check(payload.summary.reminders === payload.reminders.length, 'Summary reminder count matches');

console.log(`\n🎉 ${passed} demo-seed assertions passed.`);
console.log('Stateless suite: the seeder payload was built in memory; no database rows were written.');
