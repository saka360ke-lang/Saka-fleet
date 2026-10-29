/**
 * Saka Fleet — Universal Expiry Reminder Engine Test Suite (stateless)
 * --------------------------------------------------------------------
 * Covers natural expiry parsing ("Insurance expires on 15th Dec 2026",
 * "Inspection due next month", "License renewal in 14 days"), timezone
 * resolution from the WhatsApp number, canonical due_at conversion, the
 * 30d/14d/7d/24h/overdue tier ladder (exactly once), driver-licence reminder
 * promotion, the audit notification log and the combined sweep.
 *
 * Uses an in-memory Supabase mock — NOTHING touches the real database.
 * Run: node test_expiry_reminders.js
 */

import assert from 'assert';
import {
  parseExpirySpec,
  buildExpirySpecFromDate,
  describeExpirySpec,
  detectExpiryCategory,
  createExpiryReminder,
  evaluateExpiryReminders,
  syncDriverLicenseReminders,
  runReminderSweep
} from './src/services/maintenanceReminders.js';
import { resolveUserTimezone, resolveTimezoneFromCountry } from './src/services/globalization.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`\u2705 ${message}`);
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function matches(row, filters) {
  return filters.every((filter) => {
    if (filter.op === 'eq') return row[filter.col] === filter.val;
    if (filter.op === 'in') return Array.isArray(filter.val) && filter.val.includes(row[filter.col]);
    return true;
  });
}

function createMockSupabase(seed = {}) {
  const tables = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((row) => ({ ...row }));

  function ensure(table) {
    if (!tables[table]) tables[table] = [];
    return tables[table];
  }

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
      then(resolve) {
        const rows = ensure(table);
        if (insertRows) {
          const stored = insertRows.map((row, index) => ({ id: row.id || `${table}-${rows.length + index + 1}`, ...row }));
          rows.push(...stored);
          return resolve({ data: stored, error: null });
        }
        if (patch) {
          const matched = rows.filter((row) => matches(row, filters));
          matched.forEach((row) => Object.assign(row, patch));
          return resolve({ data: matched, error: null });
        }
        let result = rows.filter((row) => matches(row, filters));
        if (limitN !== null) result = result.slice(0, limitN);
        return resolve({ data: result.map((row) => ({ ...row })), error: null });
      }
    };
    return builder;
  }

  return { tables, client: { from: (table) => makeBuilder(table) } };
}

function expiryRow(overrides = {}) {
  return {
    id: `rem-${Math.random().toString(36).slice(2, 8)}`,
    reminder_type: 'Insurance Renewal',
    category: 'insurance',
    kind: 'expiry',
    threshold_unit: 'date',
    status: 'active',
    notified_30d: false,
    notified_14d: false,
    notified_7d: false,
    notified_24h: false,
    notified_overdue: false,
    ...overrides
  };
}

async function run() {
  const now = new Date('2026-10-29T09:00:00+03:00');

  console.log('=== UNIVERSAL EXPIRY REMINDER TESTS ===\n');
  console.log('--- Test 1: natural expiry parsing ---');
  const insurance = parseExpirySpec('Insurance expires on 15th Dec 2026', { countryCode: 'KE', timeZone: 'Africa/Nairobi', now });
  check(insurance.ok && insurance.localDate === '2026-12-15', 'Ordinal expiry date is normalized to ISO');
  check(insurance.category === 'insurance', 'Insurance phrase maps to the insurance category');
  check(describeExpirySpec(insurance, { locale: 'en-KE' }).includes('Africa/Nairobi'), 'Expiry description includes the confirming timezone');

  const inspection = parseExpirySpec('Inspection due next month', { countryCode: 'KE', now });
  check(inspection.ok && inspection.localDate === '2026-11-29', '"Inspection due next month" resolves from the Nairobi calendar day');
  check(inspection.category === 'inspection', 'Inspection / MOT phrase is classified correctly');

  const license = parseExpirySpec('License renewal in 14 days', { countryCode: 'KE', now });
  check(license.ok && license.localDate === '2026-11-12', '"License renewal in 14 days" resolves relatively');
  check(license.category === 'licensing', 'License phrase maps to the licensing category');

  const permit = parseExpirySpec('Transport permit expires 2027-03-31', { countryCode: 'KE', now });
  check(permit.ok && permit.category === 'permit', 'Permit expiry phrase is classified correctly');

  const driverLicense = parseExpirySpec('Driver license renewal 15/03/2027', { countryCode: 'KE', now });
  check(driverLicense.ok && driverLicense.category === 'driver_license', 'Driver licence phrase is classified correctly');

  check(parseExpirySpec('Oil change in 5000 km', { now }).ok === false, 'A distance threshold is not misread as a date');
  check(detectExpiryCategory('general deadline') === 'deadline', 'Generic deadline phrases fall back to the deadline category');

  console.log('\n--- Test 2: timezone auto-detection & canonical due_at ---');
  check(resolveTimezoneFromCountry('KE') === 'Africa/Nairobi', 'Kenya resolves to Africa/Nairobi');
  check(resolveUserTimezone({ countryInfo: { country_code: 'US' } }) === 'America/New_York', 'US numbers resolve to America/New_York');
  check(resolveUserTimezone({ countryInfo: { country_code: 'GB' }, profile: { timezone: 'Europe/Paris' } }) === 'Europe/Paris', 'A confirmed profile timezone wins over the country default');
  check(resolveUserTimezone({ countryInfo: { country_code: 'GLOBAL' }, profile: { timezone: 'not-a-zone' } }) === 'Africa/Nairobi', 'Invalid profile timezones fall back to Africa/Nairobi');

  const nyExpiry = parseExpirySpec('Insurance expires 2026-12-15', { timeZone: 'America/New_York', now });
  check(nyExpiry.dueAt === '2026-12-15T17:00:00.000Z', 'due_at stores the target instant in the user timezone (EST noon = 17:00Z)');
  const nairobiExpiry = buildExpirySpecFromDate('2026-12-15', { timeZone: 'Africa/Nairobi' });
  check(nairobiExpiry.dueAt === '2026-12-15T09:00:00.000Z', 'Nairobi noon expiry is stored as 09:00Z');

  console.log('\n--- Test 3: linked expiry reminders upsert and reset tiers ---');
  const linkedMock = createMockSupabase({ reminders: [], vehicles: [{ id: 'v1', plate_number: 'KDA 123A' }] });
  const firstCreate = await createExpiryReminder({
    supabase: linkedMock.client,
    vehicle: { id: 'v1' },
    profileId: 'p1',
    reminderType: 'Insurance Renewal',
    category: 'insurance',
    spec: buildExpirySpecFromDate('2026-11-20', { timeZone: 'Africa/Nairobi' }),
    linkedColumn: 'vehicles.insurance_expiry'
  });
  check(firstCreate.ok && linkedMock.tables.reminders.length === 1, 'Linked insurance expiry creates exactly one reminder');
  check(linkedMock.tables.reminders[0].due_at === '2026-11-20T09:00:00.000Z', 'Expiry reminder stores the canonical due_at timestamp');
  check(linkedMock.tables.vehicles[0].insurance_expiry === '2026-11-20', 'Linked vehicle insurance column is kept in sync');

  await evaluateExpiryReminders({ supabase: linkedMock.client, sendFn: async () => {}, now });
  check(linkedMock.tables.reminders[0].notified_30d === true, 'First sweep flags the 30-day tier');

  const updated = await createExpiryReminder({
    supabase: linkedMock.client,
    vehicle: { id: 'v1' },
    profileId: 'p1',
    reminderType: 'Insurance Renewal',
    category: 'insurance',
    spec: buildExpirySpecFromDate('2027-06-30', { timeZone: 'Africa/Nairobi' }),
    linkedColumn: 'vehicles.insurance_expiry'
  });
  check(updated.ok && linkedMock.tables.reminders.length === 1, 'Updating the linked expiry reuses the same reminder row');
  check(linkedMock.tables.reminders[0].due_date === '2027-06-30', 'Renewed expiry date replaces the old due_date');
  check(linkedMock.tables.reminders[0].notified_30d === false, 'Renewing an expiry resets the notification ladder');

  console.log('\n--- Test 4: 30/14/7/24h/overdue ladder fires exactly once ---');
  const ladderMock = createMockSupabase({
    reminders: [
      expiryRow({ id: 'r30', vehicle_id: 'v1', due_date: addDays('2026-10-29', 30) }),
      expiryRow({ id: 'r14', vehicle_id: 'v1', category: 'inspection', reminder_type: 'Inspection', due_date: addDays('2026-10-29', 10) }),
      expiryRow({ id: 'r7', vehicle_id: 'v2', category: 'licensing', reminder_type: 'Road License', due_date: addDays('2026-10-29', 5) }),
      expiryRow({ id: 'r24', vehicle_id: 'v1', category: 'permit', reminder_type: 'Permit', due_date: addDays('2026-10-29', 1) }),
      expiryRow({ id: 'rover', vehicle_id: 'v2', category: 'deadline', reminder_type: 'Deadline', due_date: addDays('2026-10-29', -2) }),
      expiryRow({ id: 'rfar', vehicle_id: 'v1', due_date: addDays('2026-10-29', 40) })
    ],
    vehicles: [
      { id: 'v1', plate_number: 'KDA 123A', owner_id: 'p1', owner_phone: '+254700000001', assigned_driver_id: 'p2' },
      { id: 'v2', plate_number: 'KDB 456B', owner_id: 'p1', owner_phone: '+254700000001', assigned_driver_id: null }
    ],
    profiles: [
      { id: 'p1', phone_number: '+254700000001' },
      { id: 'p2', phone_number: '+254700000002' }
    ]
  });
  const ladderSent = [];
  const firstSweep = await evaluateExpiryReminders({
    supabase: ladderMock.client,
    sendFn: async (phone, text) => ladderSent.push({ phone, text }),
    canDeliver: (phone) => phone !== '+254700000002',
    now
  });
  check(firstSweep.ok && firstSweep.evaluated === 6, 'Sweep evaluates every active date-based reminder');
  check(firstSweep.alerts.length === 5, 'Five reminders inside the ladder windows produce alerts');
  check(firstSweep.dispatched === 5, 'Owner alerts are dispatched and the blocked driver phone is skipped');
  check(firstSweep.overdue === 1, 'Overdue count is reported');

  const byId = (id) => ladderMock.tables.reminders.find((row) => row.id === id);
  check(byId('r30').notified_30d === true, '30-day tier fires for a 30-day expiry');
  check(byId('r14').notified_14d === true, '14-day tier fires for a 10-day expiry');
  check(byId('r7').notified_7d === true, '7-day tier fires for a 5-day expiry');
  check(byId('r24').notified_24h === true, '24-hour tier fires for a tomorrow expiry');
  check(byId('rover').notified_overdue === true, 'Overdue tier fires for an expired item');
  check(byId('rfar').notified_30d !== true, 'A 40-day expiry stays silent until the 30-day window');
  check((ladderMock.tables.expiry_notification_log || []).length === 5, 'Every dispatch writes an audit row to expiry_notification_log');
  check(ladderSent.some((entry) => /expires in 30 days/.test(entry.text)), 'Tier copy states the days remaining');

  const secondSweep = await evaluateExpiryReminders({
    supabase: ladderMock.client,
    sendFn: async () => {},
    canDeliver: () => true,
    now
  });
  check(secondSweep.alerts.length === 0 && secondSweep.dispatched === 0, 'Re-running the same day never duplicates an alert');

  console.log('\n--- Test 5: driver licences + combined sweep ---');
  const driverMock = createMockSupabase({
    reminders: [],
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A', owner_id: 'p1', owner_phone: '+254700000001', assigned_driver_id: 'p2' }],
    profiles: [
      { id: 'p1', phone_number: '+254700000001', is_active: true },
      { id: 'p2', phone_number: '+254700000002', is_active: true, driver_license_expiry: addDays('2026-10-29', 20) }
    ]
  });
  const syncRes = await syncDriverLicenseReminders({ supabase: driverMock.client });
  check(syncRes.ok && syncRes.synced === 1, 'Driver licence expiry is promoted to a first-class reminder');
  check(driverMock.tables.reminders.length === 1
    && driverMock.tables.reminders[0].subject_type === 'driver'
    && driverMock.tables.reminders[0].category === 'driver_license'
    && driverMock.tables.reminders[0].linked_column === 'profiles.driver_license_expiry',
    'Driver reminder is linked to the profile licence column');

  const driverSent = [];
  const driverEval = await evaluateExpiryReminders({
    supabase: driverMock.client,
    sendFn: async (phone, text) => driverSent.push({ phone, text }),
    canDeliver: () => true,
    now
  });
  check(driverEval.alerts.length === 1, 'Driver licence reminder enters the expiry ladder');
  check(driverEval.dispatched === 2, 'Both the driver and the vehicle owner receive the licence alert');
  check(driverSent.some((entry) => /Driver licence/i.test(entry.text)), 'Licence alert copy names the driver licence');

  const sweepMock = createMockSupabase({
    reminders: [expiryRow({ id: 'r5', vehicle_id: 'v1', due_date: addDays('2026-10-29', 5) })],
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A', owner_id: 'p1', owner_phone: '+254700000001', assigned_driver_id: null }],
    profiles: [{ id: 'p1', phone_number: '+254700000001' }]
  });
  const combined = await runReminderSweep({ supabase: sweepMock.client, sendFn: async () => {}, now });
  check(combined.ok && combined.expiry.evaluated === 1, 'Combined sweep evaluates expiry reminders even with no threshold reminders');
  check(combined.alerts === 1 && combined.expiry.alerts === 1, 'Combined sweep reports the expiry alert');
  check(combined.threshold.vehiclesChecked === 0, 'No threshold reminders means no threshold vehicle pass');

  console.log(`\n\u2705 ALL EXPIRY REMINDER TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});



