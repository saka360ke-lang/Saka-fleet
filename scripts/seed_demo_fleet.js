import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { EXPENSE_TYPES } from '../src/services/expenseCatalog.js';
import { EARNING_TYPES } from '../src/services/earningCatalog.js';
import { createThresholdReminder, createExpiryReminder } from '../src/services/maintenanceReminders.js';
import { ensureEarningTypeSchema } from '../src/services/earningCatalog.js';

/**
 * Saka Fleet — Demo Fleet Seeder (v1.31.0)
 * ----------------------------------------
 * Explicit, guarded demo data: one owner, eight asset kinds (+ one EV), every
 * expense type, every earning type, date/distance/hours reminders and
 * compliance rows. NEVER runs automatically and NEVER touches real users: the
 * demo owner uses a dedicated phone (+254700999999) and demo VINs, and every
 * row it creates is removed first on the next run.
 *
 * Run: npm run demo:seed -- --confirm
 * Wipe: npm run reset:slate  (or npm run reset:db -- --all --confirm --backup)
 */

export const DEMO_PHONE = '+254700999999';
export const DEMO_DRIVER_PHONE = '+254700999998';
const KES = 'KES';
const DAY_MS = 24 * 60 * 60 * 1000;

function day(now, offsetDays) {
  return new Date(now.getTime() + offsetDays * DAY_MS);
}

function dateOnly(now, offsetDays) {
  return day(now, offsetDays).toISOString().slice(0, 10);
}

function demoVin(index) {
  return `DEMO${String(index).padStart(13, '0')}`;
}

/**
 * Deterministic demo payload. Pure: no network, no database, no clock reads
 * beyond the supplied `now` (tests assert coverage from this object alone).
 */
export function buildDemoSeedPayload(now = new Date()) {
  const owner = {
    phone_number: DEMO_PHONE,
    full_name: 'Saka Demo Owner',
    country: 'Kenya',
    country_code: 'KE',
    preferred_language: 'English',
    unit_system: 'metric',
    timezone: 'Africa/Nairobi',
    is_active: true
  };
  const driver = {
    phone_number: DEMO_DRIVER_PHONE,
    full_name: 'Saka Demo Driver',
    country: 'Kenya',
    country_code: 'KE',
    preferred_language: 'English',
    unit_system: 'metric',
    timezone: 'Africa/Nairobi',
    is_active: true
  };

  const vehicles = [
    { plate_number: 'KDA 111A', make_model: 'Toyota Hilux', asset_type: 'vehicle', fuel_type: 'Diesel', status: 'ACTIVE', current_mileage: 50350, odometer_reading: 50350, operating_hours: 0 },
    { plate_number: 'KMD 222B', make_model: 'Honda CB125', asset_type: 'motorcycle', fuel_type: 'Petrol', status: 'ACTIVE', current_mileage: 18200, odometer_reading: 18200, operating_hours: 0 },
    { plate_number: 'KCE 333C', make_model: 'Isuzu FVR', asset_type: 'truck', fuel_type: 'Diesel', status: 'ACTIVE', current_mileage: 120400, odometer_reading: 120400, operating_hours: 0 },
    { plate_number: 'KDJ 444D', make_model: 'Toyota Coaster', asset_type: 'bus', fuel_type: 'Diesel', status: 'ACTIVE', current_mileage: 210000, odometer_reading: 210000, operating_hours: 0 },
    { plate_number: 'EXC-1001', make_model: 'CAT 320D Excavator', asset_type: 'heavy_equipment', fuel_type: 'Diesel', status: 'ACTIVE', current_mileage: 0, odometer_reading: 0, operating_hours: 4820 },
    { plate_number: 'MCH-2002', make_model: 'JCB 3CX Backhoe', asset_type: 'machinery', fuel_type: 'Diesel', status: 'ACTIVE', current_mileage: 0, odometer_reading: 0, operating_hours: 3110 },
    { plate_number: 'GEN-3003', make_model: 'Perkins 100 kVA Generator', asset_type: 'generator', fuel_type: 'Diesel', status: 'ACTIVE', current_mileage: 0, odometer_reading: 0, operating_hours: 840 },
    { plate_number: 'BOAT-4004', make_model: 'Yamaha FX Cruiser', asset_type: 'watercraft', fuel_type: 'Petrol', status: 'ACTIVE', current_mileage: 0, odometer_reading: 0, operating_hours: 320 },
    { plate_number: 'KDB 555E', make_model: 'Toyota bZ4X', asset_type: 'vehicle', fuel_type: 'Electric', status: 'ACTIVE', current_mileage: 12000, odometer_reading: 12000, operating_hours: 0 }
  ].map((vehicle, index) => {
    const kind = vehicle.asset_type;
    const heavy = ['heavy_equipment', 'machinery', 'generator', 'watercraft'].includes(kind);
    return {
      ...vehicle,
      asset_kind: kind,
      // Legacy check constraint: ICE | EV | HEAVY_MACHINERY.
      asset_type: vehicle.fuel_type === 'Electric' ? 'EV' : (heavy ? 'HEAVY_MACHINERY' : 'ICE'),
      serial_number: heavy ? vehicle.plate_number : null,
      vin: demoVin(index + 1),
      qr_passbook_token: `demo-qr-${index + 1}`,
      metadata: { demo: true, seeded_at: now.toISOString() }
    };
  });

  const expenses = [];
  const addExpense = (vehicleIndex, expenseType, amount, extra = {}) => {
    expenses.push({
      vehicle_index: vehicleIndex,
      expense_type: expenseType,
      amount,
      fuel_liters: extra.litres || 0,
      fill_type: extra.fill || null,
      odometer_reading: extra.odo ?? null,
      operating_hours: extra.hours ?? null,
      notes: extra.notes || null,
      created_at: day(now, -(extra.daysAgo || 5)).toISOString()
    });
  };

  // Every canonical expense type is exercised at least once.
  addExpense(0, 'Fuel', 6000, { litres: 45, fill: 'full', odo: 50350, notes: 'Shell Westlands - full tank', daysAgo: 2 });
  addExpense(2, 'Fuel', 12000, { litres: 80, fill: 'full', odo: 120400, notes: 'Total Thome - full tank', daysAgo: 4 });
  addExpense(1, 'Fuel', 1200, { litres: 8, fill: 'full', odo: 18200, notes: 'Motorcycle fuel', daysAgo: 3 });
  addExpense(6, 'Fuel', 3200, { litres: 20, fill: 'partial', hours: 840, notes: 'Generator diesel top-up', daysAgo: 6 });
  addExpense(8, 'Charging', 1050, { odo: 12000, notes: 'KPLC fast charger - 35 kWh', daysAgo: 5 });
  addExpense(0, 'Maintenance', 8500, { odo: 50200, notes: '10,000 km service - oil and filters', daysAgo: 12 });
  addExpense(1, 'Maintenance', 900, { odo: 18000, notes: 'Chain and plug service', daysAgo: 15 });
  addExpense(4, 'Maintenance', 15000, { hours: 4800, notes: 'CAT hydraulic service', daysAgo: 16 });
  addExpense(6, 'Maintenance', 6000, { hours: 835, notes: 'Generator service', daysAgo: 24 });
  addExpense(7, 'Maintenance', 4500, { hours: 315, notes: 'Hull cleaning and engine service', daysAgo: 30 });
  addExpense(0, 'Parts', 4500, { odo: 50100, notes: 'Fuel filter and air filter', daysAgo: 18 });
  addExpense(0, 'Parts', 7000, { odo: 49900, notes: 'Front brake pads', daysAgo: 25 });
  addExpense(3, 'Parts', 9500, { odo: 208000, notes: 'Heavy-duty battery', daysAgo: 30 });
  addExpense(0, 'Tyres', 300, { odo: 36737, notes: 'Puncture repair - Nanyuki, front left tyre', daysAgo: 1 });
  addExpense(2, 'Tyres', 12000, { odo: 118000, notes: 'Two drive tyres', daysAgo: 28 });
  addExpense(2, 'Repairs', 45000, { odo: 115000, notes: 'Gearbox overhaul', daysAgo: 40 });
  addExpense(0, 'Bodywork & Paint', 18000, { odo: 48000, notes: 'Windscreen replacement', daysAgo: 45 });
  addExpense(0, 'Washing', 500, { odo: 50000, notes: 'Car wash', daysAgo: 7 });
  addExpense(0, 'Parking', 200, { odo: 50300, notes: 'CBD parking', daysAgo: 3 });
  addExpense(3, 'Tolls', 300, { odo: 209500, notes: 'Expressway toll', daysAgo: 2 });
  addExpense(0, 'Fines', 1500, { odo: 50200, notes: 'Speeding fine', daysAgo: 22 });
  addExpense(0, 'Insurance', 42000, { notes: 'Comprehensive insurance renewal', daysAgo: 35 });
  addExpense(0, 'Accessories', 3500, { notes: 'Seat covers', daysAgo: 50 });
  addExpense(1, 'Subscriptions', 1200, { notes: 'GPS tracking subscription', daysAgo: 60 });
  addExpense(2, 'Towing & Recovery', 5000, { odo: 116000, notes: 'Breakdown recovery', daysAgo: 33 });
  addExpense(5, 'Crew Wages', 25000, { hours: 3110, notes: 'Operator wages - JCB', daysAgo: 10 });
  addExpense(5, 'Consumables', 8000, { hours: 3105, notes: 'Hydraulic oil and filter', daysAgo: 14 });
  addExpense(6, 'Consumables', 1500, { hours: 830, notes: 'Coolant top-up', daysAgo: 20 });
  addExpense(7, 'Mooring & Berthing', 2500, { hours: 310, notes: 'Marina berthing fee', daysAgo: 9 });
  addExpense(0, 'Other', 700, { daysAgo: 8, notes: 'Sundry' });

  const earnings = [
    { vehicle_index: 0, earning_type: 'Trip fares', amount: 3500, daysAgo: 1 },
    { vehicle_index: 1, earning_type: 'Daily takings', amount: 2200, daysAgo: 1 },
    { vehicle_index: 2, earning_type: 'Cargo & freight', amount: 18000, daysAgo: 2 },
    { vehicle_index: 3, earning_type: 'Vehicle hire', amount: 25000, daysAgo: 3 },
    { vehicle_index: 6, earning_type: 'Equipment hire', amount: 15000, daysAgo: 4 },
    { vehicle_index: 2, earning_type: 'Contract & charter', amount: 60000, daysAgo: 6 },
    { vehicle_index: 3, earning_type: 'Transport service', amount: 9000, daysAgo: 5 },
    { vehicle_index: 8, earning_type: 'Other', amount: 1500, daysAgo: 2 }
  ].map((row) => ({
    ...row,
    notes: `${row.earning_type} - demo record`,
    logged_at: day(now, -row.daysAgo).toISOString(),
    created_at: day(now, -row.daysAgo).toISOString()
  }));

  const reminders = [
    { kind: 'date', vehicle_index: 0, reminder_type: 'Insurance Renewal', category: 'insurance', localDate: dateOnly(now, 20), linkedColumn: 'insurance_expiry' },
    { kind: 'date', vehicle_index: 0, reminder_type: 'Inspection', category: 'inspection', localDate: dateOnly(now, 45), linkedColumn: 'inspection_expiry' },
    { kind: 'date', vehicle_index: 0, reminder_type: 'Road Service Licence', category: 'licensing', localDate: dateOnly(now, 90) },
    { kind: 'date', vehicle_index: 2, reminder_type: 'Permit', category: 'permit', localDate: dateOnly(now, 60), notes: 'Speed limiter certificate' },
    { kind: 'distance', vehicle_index: 0, reminder_type: 'Oil change', target: 55350, inputUnit: 'km' },
    { kind: 'hours', vehicle_index: 5, reminder_type: 'Hydraulic service', target: 3210, inputUnit: 'hours' },
    { kind: 'hours', vehicle_index: 6, reminder_type: 'Generator service', target: 890, inputUnit: 'hours' }
  ];

  const vehicleCompliances = [
    { vehicle_index: 0, type: 'insurance', label: 'Insurance', number: 'DEMO-INS-001', expiry: dateOnly(now, 20) },
    { vehicle_index: 0, type: 'inspection', label: 'Inspection (NTSA)', number: 'DEMO-INS-002', expiry: dateOnly(now, 45) },
    { vehicle_index: 0, type: 'road_service_licence', label: 'Road Service Licence (PSL)', number: 'DEMO-PSL-003', expiry: dateOnly(now, 90) },
    { vehicle_index: 0, type: 'speed_limiter', label: 'Speed limiter certificate', number: 'DEMO-SL-004', expiry: dateOnly(now, 60) }
  ];

  const driverCompliances = [
    { type: 'driving_licence', label: 'Driving Licence', number: 'DEMO-DL-001', expiry: dateOnly(now, 300) },
    { type: 'psv_badge', label: 'PSV Badge', number: 'DEMO-PSV-001', expiry: dateOnly(now, 200) }
  ];

  const coveredExpenseTypes = [...new Set(expenses.map((row) => row.expense_type))];
  const coveredEarningTypes = [...new Set(earnings.map((row) => row.earning_type))];

  return {
    owner,
    driver,
    vehicles,
    expenses,
    earnings,
    reminders,
    vehicleCompliances,
    driverCompliances,
    currency: KES,
    summary: {
      vehicles: vehicles.length,
      assetKinds: [...new Set(vehicles.map((row) => row.asset_kind))],
      expenses: expenses.length,
      expenseTypesCovered: coveredExpenseTypes,
      expenseTypesMissing: EXPENSE_TYPES.map((type) => type.value).filter((value) => !coveredExpenseTypes.includes(value)),
      earnings: earnings.length,
      earningTypesCovered: coveredEarningTypes,
      earningTypesMissing: EARNING_TYPES.map((type) => type.value).filter((value) => !coveredEarningTypes.includes(value)),
      reminders: reminders.length,
      vehicleCompliances: vehicleCompliances.length,
      driverCompliances: driverCompliances.length
    }
  };
}

function parseArgs(argv = []) {
  const confirm = argv.includes('--confirm');
  const phoneArg = argv.find((arg) => arg.startsWith('--phone='));
  return { confirm, phone: phoneArg ? phoneArg.split('=')[1] : DEMO_PHONE };
}

async function upsertProfile(supabase, profile) {
  const { data: existing } = await supabase.from('profiles').select('id').eq('phone_number', profile.phone_number).maybeSingle();
  if (existing?.id) {
    const { error } = await supabase.from('profiles').update(profile).eq('id', existing.id);
    if (error) throw new Error(`profile update failed: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await supabase.from('profiles').insert([profile]).select().single();
  if (error) throw new Error(`profile insert failed: ${error.message}`);
  return data.id;
}

/** Remove a previous demo run (explicit demo phones only). */
async function deleteDemoData(supabase, ownerPhone, driverPhone) {
  const { data: profiles } = await supabase.from('profiles').select('id, phone_number').in('phone_number', [ownerPhone, driverPhone]);
  const rows = profiles || [];
  const owner = rows.find((row) => row.phone_number === ownerPhone);
  const driver = rows.find((row) => row.phone_number === driverPhone);

  let vehicleIds = [];
  let plates = [];
  if (owner?.id) {
    const { data: vehicles } = await supabase.from('vehicles').select('id, plate_number').eq('owner_id', owner.id);
    vehicleIds = (vehicles || []).map((row) => row.id);
    plates = (vehicles || []).map((row) => row.plate_number).filter(Boolean);
  }

  if (vehicleIds.length) {
    for (const table of ['expense_logs', 'private_earnings', 'reminders', 'vehicle_compliances', 'expiry_notification_log', 'passbook_transfers', 'driver_assignments', 'receipts']) {
      try { await supabase.from(table).delete().in('vehicle_id', vehicleIds); } catch { /* table may not use vehicle_id */ }
    }
    if (plates.length) {
      try { await supabase.from('expenses').delete().in('plate', plates); } catch { /* legacy table optional */ }
    }
    try { await supabase.from('vehicles').delete().in('id', vehicleIds); } catch (err) {
      console.warn('[demo:seed] Vehicle delete warning:', err.message);
    }
  }
  if (driver?.id) {
    try { await supabase.from('driver_compliances').delete().eq('driver_id', driver.id); } catch { /* optional */ }
  }
  if (rows.length) {
    try { await supabase.from('profiles').delete().in('id', rows.map((row) => row.id)); } catch (err) {
      console.warn('[demo:seed] Profile delete warning:', err.message);
    }
  }
  return { profiles: rows.length, vehicles: vehicleIds.length };
}

export async function seedDemoFleet({ supabase, now = new Date(), phone = DEMO_PHONE, log = console.log } = {}) {
  if (!supabase) throw new Error('Supabase client required');
  const payload = buildDemoSeedPayload(now);
  payload.owner.phone_number = phone;

  const schema = await ensureEarningTypeSchema(supabase);
  if (schema.status === 'missing-transport') {
    log('ℹ️  earning_type column may be missing — run: npm run migrate:earning-type');
  }

  const removed = await deleteDemoData(supabase, phone, DEMO_DRIVER_PHONE);
  log(`🧹 Previous demo rows removed: ${removed.profiles} profile(s), ${removed.vehicles} vehicle(s)`);

  const ownerId = await upsertProfile(supabase, payload.owner);
  const driverId = await upsertProfile(supabase, payload.driver);

  const vehicleRows = payload.vehicles.map((vehicle, index) => ({
    ...vehicle,
    owner_id: ownerId,
    owner_phone: phone,
    assigned_driver_id: index === 0 ? driverId : null
  }));
  const { data: insertedVehicles, error: vehicleError } = await supabase.from('vehicles').insert(vehicleRows).select('id, plate_number');
  if (vehicleError) throw new Error(`vehicle insert failed: ${vehicleError.message}`);
  const vehicleIds = payload.vehicles.map((vehicle) => insertedVehicles.find((row) => row.plate_number === vehicle.plate_number)?.id);

  const expenseRows = payload.expenses.map((row) => ({
    vehicle_id: vehicleIds[row.vehicle_index],
    driver_id: row.vehicle_index === 0 ? driverId : null,
    expense_type: row.expense_type,
    amount: row.amount,
    fuel_liters: row.fuel_liters,
    fill_type: row.fill_type,
    odometer_reading: row.odometer_reading,
    operating_hours: row.operating_hours,
    notes: row.notes,
    created_at: row.created_at
  }));
  const { error: expenseError } = await supabase.from('expense_logs').insert(expenseRows);
  if (expenseError) throw new Error(`expense insert failed: ${expenseError.message}`);

  const earningRows = payload.earnings.map((row) => ({
    vehicle_id: vehicleIds[row.vehicle_index],
    revenue_amount: row.amount,
    currency: payload.currency,
    earning_type: row.earning_type,
    notes: row.notes,
    logged_at: row.logged_at,
    created_at: row.created_at
  }));
  const { error: earningError } = await supabase.from('private_earnings').insert(earningRows);
  if (earningError) throw new Error(`earnings insert failed: ${earningError.message}`);

  for (const reminder of payload.reminders) {
    const vehicle = { ...payload.vehicles[reminder.vehicle_index], id: vehicleIds[reminder.vehicle_index] };
    const result = reminder.kind === 'date'
      ? await createExpiryReminder({
        supabase,
        vehicle,
        profileId: ownerId,
        reminderType: reminder.reminder_type,
        category: reminder.category,
        spec: { localDate: reminder.localDate },
        notes: reminder.notes || null,
        timeZone: 'Africa/Nairobi',
        linkedColumn: reminder.linkedColumn || null
      })
      : await createThresholdReminder({
        supabase,
        vehicle,
        profileId: ownerId,
        reminderType: reminder.reminder_type,
        spec: { ok: true, kind: reminder.kind, relative: false, canonicalValue: reminder.target, inputUnit: reminder.inputUnit }
      });
    if (!result.ok) throw new Error(`reminder insert failed: ${result.error}`);
  }

  const nowIso = now.toISOString();
  const complianceRows = payload.vehicleCompliances.map((row) => ({
    vehicle_id: vehicleIds[row.vehicle_index],
    type: row.type,
    label: row.label,
    number: row.number,
    expiry: row.expiry,
    lifetime: false,
    country_code: 'KE',
    asset_type: payload.vehicles[row.vehicle_index].asset_type,
    verified_at: nowIso,
    updated_at: nowIso
  }));
  const { error: complianceError } = await supabase.from('vehicle_compliances').insert(complianceRows);
  if (complianceError) throw new Error(`vehicle compliance insert failed: ${complianceError.message}`);

  const driverRows = payload.driverCompliances.map((row) => ({
    driver_id: driverId,
    type: row.type,
    label: row.label,
    number: row.number,
    expiry: row.expiry,
    lifetime: false,
    country_code: 'KE',
    verified_at: nowIso,
    updated_at: nowIso
  }));
  const { error: driverComplianceError } = await supabase.from('driver_compliances').insert(driverRows);
  if (driverComplianceError) throw new Error(`driver compliance insert failed: ${driverComplianceError.message}`);

  log(`✅ Demo owner ${phone} · ${payload.summary.vehicles} vehicle(s) across ${payload.summary.assetKinds.join(', ')}`);
  log(`✅ ${payload.summary.expenses} expense(s) · ${payload.summary.expenseTypesCovered.length}/${EXPENSE_TYPES.length} types`);
  log(`✅ ${payload.summary.earnings} earning(s) · ${payload.summary.earningTypesCovered.length}/${EARNING_TYPES.length} types`);
  log(`✅ ${payload.summary.reminders} reminder(s) · ${payload.summary.vehicleCompliances} vehicle compliance(s) · ${payload.summary.driverCompliances} driver compliance(s)`);
  if (payload.summary.expenseTypesMissing.length) log(`⚠️  Expense types missing: ${payload.summary.expenseTypesMissing.join(', ')}`);
  if (payload.summary.earningTypesMissing.length) log(`⚠️  Earning types missing: ${payload.summary.earningTypesMissing.join(', ')}`);

  return { ok: true, ownerId, driverId, vehicleIds, summary: payload.summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { confirm, phone } = parseArgs(process.argv.slice(2));
  if (!confirm) {
    console.error('Refusing to seed without --confirm. Run: npm run demo:seed -- --confirm');
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
  }
  const supabase = createClient(url, key);
  seedDemoFleet({ supabase, phone })
    .then((result) => {
      console.log('🚀 Demo fleet ready. Wipe anytime with: npm run reset:slate');
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('❌ Demo seed failed:', err.message);
      process.exit(1);
    });
}

export default { DEMO_PHONE, DEMO_DRIVER_PHONE, buildDemoSeedPayload, seedDemoFleet };
