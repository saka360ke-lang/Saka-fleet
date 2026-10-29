/**
 * Saka Fleet - Maintenance Reminder Engine Test Suite (stateless)
 * ----------------------------------------------------------------
 * Covers metric/imperial/operating-hours thresholds, explicit remaining
 * distance/time tracking, exactly-once tier dispatch, overdue alerts, the
 * background sweep, and odometer/hours monitoring. Uses an in-memory Supabase
 * mock - NOTHING is written to the real database, so there is no cleanup debt.
 *
 * Run: node test_maintenance_reminders.js
 */

import assert from 'assert';
import {
  parseThresholdSpec,
  parseOperatingHours,
  describeThresholdSpec,
  createThresholdReminder,
  evaluateVehicleReminders,
  applyOdometerReading,
  applyOperatingHours,
  runReminderSweep
} from './src/services/maintenanceReminders.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`\u2705 ${message}`);
}

function createMockSupabase(initial = {}) {
  const tables = {
    reminders: (initial.reminders || []).map((r) => ({ ...r })),
    vehicles: (initial.vehicles || []).map((v) => ({ ...v })),
    profiles: (initial.profiles || []).map((p) => ({ ...p }))
  };
  const inserts = [];
  const updates = [];

  function makeBuilder(table) {
    const filters = [];
    let patch = null;
    let insertRows = null;
    let limitN = null;
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      in(col, vals) { filters.push({ op: 'in', col, val: vals }); return builder; },
      limit(n) { limitN = n; return builder; },
      insert(rows) { insertRows = rows; return builder; },
      update(p) { patch = p; return builder; },
      then(resolve, reject) {
        try {
          if (insertRows) {
            const stored = insertRows.map((r, i) => ({ id: r.id || `${table}-new-${i}`, ...r }));
            tables[table] = tables[table] || [];
            tables[table].push(...stored);
            inserts.push({ table, rows: stored });
            return resolve({ data: stored, error: null });
          }
          if (patch) {
            const matched = (tables[table] || []).filter((row) => filters.every((f) =>
              f.op === 'in' ? f.val.includes(row[f.col]) : row[f.col] === f.val));
            matched.forEach((row) => Object.assign(row, patch));
            updates.push({ table, patch, matched });
            return resolve({ data: null, error: null });
          }
          let rows = (tables[table] || []).slice();
          for (const f of filters) {
            rows = rows.filter((row) => (f.op === 'in' ? f.val.includes(row[f.col]) : row[f.col] === f.val));
          }
          if (limitN) rows = rows.slice(0, limitN);
          return resolve({ data: rows.map((r) => ({ ...r })), error: null });
        } catch (err) {
          return reject(err);
        }
      }
    };
    return builder;
  }

  return {
    client: { from: (table) => makeBuilder(table) },
    tables,
    inserts,
    updates
  };
}

function makeVehicle(overrides = {}) {
  return {
    id: 'veh-1',
    plate_number: 'KDA 123A',
    make_model: 'Toyota Hilux',
    current_mileage: 100000,
    odometer_reading: 100000,
    operating_hours: 0,
    unit_system: 'metric',
    owner_phone: '+254700000001',
    ...overrides
  };
}

async function run() {
  console.log('--- Test 1: metric / imperial / operating-hours threshold parsing ---');
  const kmSpec = parseThresholdSpec('oil change in 5000 km');
  check(kmSpec.ok && kmSpec.kind === 'distance' && kmSpec.canonicalValue === 5000 && kmSpec.relative === true,
    'Metric threshold "in 5000 km" parses canonically as km');

  const miSpec = parseThresholdSpec('brake pads in 3000 miles');
  check(miSpec.ok && miSpec.kind === 'distance' && miSpec.inputUnit === 'mi' && miSpec.canonicalValue === 4828,
    'Imperial threshold "3000 miles" converts to canonical km');

  const hoursSpec = parseThresholdSpec('spare part in 36 operating hours');
  check(hoursSpec.ok && hoursSpec.kind === 'hours' && hoursSpec.canonicalValue === 36 && hoursSpec.relative === true,
    'Operating-hours threshold "36 operating hours" parses as hours');

  const absoluteSpec = parseThresholdSpec('at 45000 km');
  check(absoluteSpec.ok && absoluteSpec.relative === false && absoluteSpec.canonicalValue === 45000,
    'Absolute target "at 45000 km" is not treated as relative');

  const bareImperial = parseThresholdSpec('45000', { unitSystem: 'imperial' });
  check(bareImperial.ok && bareImperial.inputUnit === 'mi' && bareImperial.canonicalValue === 72420,
    'Bare number honours the imperial unit system (45000 mi -> km)');

  const nonsense = parseThresholdSpec('whenever you feel like it');
  check(nonsense.ok === false, 'Unparseable threshold text is rejected');

  check(parseOperatingHours('log 1250 engine hours') === 1250, 'Operating hours parse before the unit ("1250 engine hours")');
  check(parseOperatingHours('hours now 36.5') === 36.5, 'Operating hours parse after the unit ("hours now 36.5")');
  check(parseOperatingHours('skip') === null, 'Non-numeric hours input is rejected');
  check(describeThresholdSpec(hoursSpec) === '36 operating hours', 'Threshold description uses operating hours');
  check(describeThresholdSpec(miSpec) === '3,000 mi', 'Threshold description uses the user unit (miles)');

  console.log('\n--- Test 2: structured reminder creation with explicit remaining tracking ---');
  const mock1 = createMockSupabase();
  const created = await createThresholdReminder({
    supabase: mock1.client,
    vehicle: makeVehicle(),
    profileId: 'prof-1',
    reminderType: 'Oil change',
    spec: kmSpec
  });
  check(created.ok === true, 'Threshold reminder is created');
  check(created.reminder.threshold_unit === 'distance', 'Reminder stores threshold_unit = distance');
  check(created.reminder.target_value === 105000, 'Relative target is current reading + 5000 km');
  check(created.reminder.remaining_value === 5000, 'Remaining distance is recorded at creation');
  check(created.reminder.display_unit === 'km', 'Metric vehicle displays km');
  check(created.reminder.last_service_value === 100000, 'Baseline (last_service_value) is captured');
  check(mock1.inserts.length === 1 && mock1.inserts[0].table === 'reminders', 'Reminder row is inserted once');

  const imperialCreated = await createThresholdReminder({
    supabase: createMockSupabase().client,
    vehicle: makeVehicle({ unit_system: 'imperial' }),
    profileId: 'prof-1',
    reminderType: 'Brake pads',
    spec: miSpec
  });
  check(imperialCreated.reminder.display_unit === 'mi', 'Imperial vehicle displays miles');
  check(imperialCreated.reminder.target_value === 104828, 'Miles target is stored in canonical km');

  console.log('\n--- Test 3: tiered dispatch (75/25/5/due/overdue) fires exactly once ---');
  const baseReminder = {
    id: 'rem-1',
    vehicle_id: 'veh-1',
    reminder_type: 'Oil change',
    status: 'active',
    threshold_unit: 'distance',
    target_value: 5000,
    last_service_value: 0,
    remaining_value: null,
    notified_75p: false,
    notified_25p: false,
    notified_5p: false,
    notified_0p: false,
    notified_overdue: false
  };
  const mock3 = createMockSupabase({ reminders: [{ ...baseReminder }] });
  const sent = [];
  const sendFn = async (phone, text, vehicle) => sent.push({ phone, text, vehicle: vehicle?.id });

  const early = await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 1000 }), sendFn });
  check(early.alerts.length === 0 && sent.length === 0, 'No alert while 80% of the interval remains');

  const approach = await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 2000 }), sendFn });
  check(approach.alerts.length === 1 && approach.alerts[0].tier === 'approach', '75% tier fires as the threshold approaches');
  check(mock3.tables.reminders[0].remaining_value === 3000, 'Remaining value is persisted on evaluation');
  check(mock3.tables.reminders[0].notified_75p === true, 'Approach tier is marked notified');
  check(sent.length === 1 && /60% remaining/.test(sent[0].text) && /5,000/.test(sent[0].text), 'Alert shows the target and remaining percentage');

  const approachAgain = await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 2000 }), sendFn });
  check(approachAgain.alerts.length === 0 && sent.length === 1, 'The same tier never re-notifies');

  await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 4000 }), sendFn });
  check(mock3.tables.reminders[0].notified_25p === true, '25% warning tier fires');

  await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 4900 }), sendFn });
  check(mock3.tables.reminders[0].notified_5p === true, '5% urgent tier fires');

  await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 5000 }), sendFn });
  check(mock3.tables.reminders[0].notified_0p === true, 'Due-now tier fires at the target');

  const overdue = await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 6000 }), sendFn });
  check(mock3.tables.reminders[0].notified_overdue === true, 'Overdue tier sets notified_overdue');
  check(overdue.alerts.length === 1 && overdue.alerts[0].tier === 'overdue', 'Overdue alert is urgent and explicit');

  const overdueAgain = await evaluateVehicleReminders({ supabase: mock3.client, vehicle: makeVehicle({ current_mileage: 6000 }), sendFn });
  check(overdueAgain.alerts.length === 0, 'Overdue alerts do not repeat on every sweep');


  console.log('\n--- Test 4: odometer monitoring canonicalizes input ---');
  const mock4 = createMockSupabase({ vehicles: [makeVehicle()], reminders: [] });
  const metricUpdate = await applyOdometerReading({ supabase: mock4.client, vehicle: makeVehicle(), reading: 52000 });
  check(metricUpdate.ok && metricUpdate.canonicalKm === 52000 && mock4.tables.vehicles[0].current_mileage === 52000,
    'Metric odometer reading is persisted as km');

  const imperialVehicle = makeVehicle({ unit_system: 'imperial' });
  const mock4b = createMockSupabase({ vehicles: [imperialVehicle], reminders: [] });
  const imperialUpdate = await applyOdometerReading({ supabase: mock4b.client, vehicle: imperialVehicle, reading: 30000, inputUnit: 'mi' });
  check(imperialUpdate.ok && imperialUpdate.canonicalKm === 48280, 'Imperial odometer input is converted to canonical km');

  console.log('\n--- Test 5: operating-hours submissions drive hours reminders ---');
  const hoursReminder = {
    id: 'rem-h', vehicle_id: 'veh-h', reminder_type: 'Spare part', status: 'active',
    threshold_unit: 'hours', target_value: 36, last_service_value: 0,
    notified_75p: false, notified_25p: false, notified_5p: false, notified_0p: false, notified_overdue: false
  };
  const hoursVehicle = makeVehicle({ id: 'veh-h', operating_hours: 0 });
  const mock5 = createMockSupabase({ reminders: [hoursReminder], vehicles: [hoursVehicle] });
  const hoursSent = [];
  const hoursResult = await applyOperatingHours({
    supabase: mock5.client,
    vehicle: hoursVehicle,
    hours: 30,
    sendFn: async (phone, text) => hoursSent.push(text)
  });
  check(hoursResult.ok && mock5.tables.vehicles[0].operating_hours === 30, 'Operating-hours submission is persisted');
  check(hoursResult.alerts.length === 1 && hoursResult.alerts[0].tier === 'warning', 'Hours reminder fires at the 25% warning tier');
  check(hoursSent.length === 1 && /operating hours/i.test(hoursSent[0]), 'Hours alert is labelled in operating hours');

  console.log('\n--- Test 6: background sweep aggregates vehicles and respects delivery guards ---');
  const sweepReminders = [
    {
      id: 'r1', vehicle_id: 'v1', reminder_type: 'Oil change', status: 'active',
      threshold_unit: 'distance', target_value: 5000, last_service_value: 0,
      notified_75p: false, notified_25p: false, notified_5p: false, notified_0p: false, notified_overdue: false
    },
    {
      id: 'r2', vehicle_id: 'v2', reminder_type: 'Hydraulic service', status: 'active',
      threshold_unit: 'hours', target_value: 100, last_service_value: 0,
      notified_75p: false, notified_25p: false, notified_5p: false, notified_0p: false, notified_overdue: false
    }
  ];
  const sweepVehicles = [
    makeVehicle({ id: 'v1', current_mileage: 2000, owner_id: 'p1', owner_phone: '+254700000001', assigned_driver_id: 'p2' }),
    makeVehicle({ id: 'v2', plate_number: 'KDB 456B', operating_hours: 80, owner_id: 'p1', owner_phone: '+254700000001', assigned_driver_id: null })
  ];
  const sweepProfiles = [
    { id: 'p1', phone_number: '+254700000001' },
    { id: 'p2', phone_number: '+254700000002' }
  ];
  const mock6 = createMockSupabase({ reminders: sweepReminders, vehicles: sweepVehicles, profiles: sweepProfiles });
  const sweepSent = [];
  const sweepRes = await runReminderSweep({
    supabase: mock6.client,
    sendFn: async (phone) => sweepSent.push(phone),
    canDeliver: (phone) => phone !== '+254700000002'
  });
  check(sweepRes.ok && sweepRes.vehiclesChecked === 2, 'Sweep evaluates every vehicle with threshold reminders');
  check(sweepRes.alerts === 2, 'Sweep produces one approaching/urgent alert per vehicle');
  check(sweepSent.length === 2 && sweepSent.every((p) => p === '+254700000001'),
    'Owner/driver phones are deduped and canDeliver guards delivery');
  check(mock6.tables.reminders[0].remaining_value === 3000, 'Sweep persists remaining distance');
  check(mock6.tables.reminders[1].remaining_value === 20, 'Sweep persists remaining operating hours');

  console.log('\n--- Test 7: imperial reminders display miles ---');
  const imperialReminder = {
    id: 'rem-i', vehicle_id: 'veh-i', reminder_type: 'Oil change', status: 'active',
    threshold_unit: 'distance', target_value: 4828, last_service_value: 0,
    notified_75p: false, notified_25p: false, notified_5p: false, notified_0p: false, notified_overdue: false
  };
  const imperialDisplayVehicle = makeVehicle({ id: 'veh-i', unit_system: 'imperial', current_mileage: 2000 });
  const mock7 = createMockSupabase({ reminders: [imperialReminder] });
  const imperialSent = [];
  const imperialEval = await evaluateVehicleReminders({
    supabase: mock7.client,
    vehicle: imperialDisplayVehicle,
    sendFn: async (phone, text) => imperialSent.push(text)
  });
  check(imperialEval.alerts.length === 1 && /mi\b/.test(imperialSent[0]), 'Imperial reminders display miles');
  check(/3,000 mi/.test(imperialSent[0]), 'Remaining distance is converted to miles for display');

  console.log(`\n\u2705 ALL MAINTENANCE REMINDER TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});

