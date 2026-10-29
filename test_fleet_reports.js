/**
 * Saka Fleet — Core Fleet Reports Test Suite (stateless)
 * ------------------------------------------------------
 * Verifies the four report builders produce structured JSON + localized
 * WhatsApp text from a mocked fleet dataset:
 *   1. Fleet Status  — overview, health index, urgent items, activity.
 *   2. Compliance    — insurance/inspection matrix, alert log, prompts.
 *   3. Maintenance   — thresholds, PM compliance, service history.
 *   4. Financial     — expenses, earnings, net per vehicle, cost per km/hour.
 *
 * Uses an in-memory Supabase mock — NOTHING touches the real database.
 * Run: node test_fleet_reports.js
 */

import assert from 'assert';
import {
  buildFleetReport,
  resolveReportType,
  REPORT_TYPES
} from './src/services/fleetReports.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`\u2705 ${message}`);
}

function matches(row, filters) {
  return filters.every((filter) => {
    if (filter.op === 'eq') return row[filter.col] === filter.val;
    if (filter.op === 'in') return Array.isArray(filter.val) && filter.val.includes(row[filter.col]);
    if (filter.op === 'is') {
      if (filter.val === null) return row[filter.col] === null || row[filter.col] === undefined;
      return row[filter.col] === filter.val;
    }
    return true;
  });
}

function createMockSupabase(seed = {}) {
  const tables = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((row) => ({ ...row }));

  function makeBuilder(table) {
    const filters = [];
    let limitN = null;
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      in(col, vals) { filters.push({ op: 'in', col, val: vals }); return builder; },
      is(col, val) { filters.push({ op: 'is', col, val }); return builder; },
      limit(n) { limitN = n; return builder; },
      then(resolve) {
        const rows = tables[table] || [];
        let result = rows.filter((row) => matches(row, filters));
        if (limitN !== null) result = result.slice(0, limitN);
        return resolve({ data: result.map((row) => ({ ...row })), error: null });
      }
    };
    return builder;
  }

  return { tables, client: { from: (table) => makeBuilder(table) } };
}

function seedFleet() {
  return {
    vehicles: [
      {
        id: 'v1', plate_number: 'KDA 123A', make_model: 'Toyota Hilux', status: 'ACTIVE',
        owner_id: 'p1', assigned_driver_id: 'd1', current_mileage: 50000, odometer_reading: 50000,
        operating_hours: 1200, unit_system: 'metric', insurance_expiry: '2026-11-05',
        inspection_expiry: '2026-10-20', created_at: '2026-01-05T08:00:00Z'
      },
      {
        id: 'v2', plate_number: 'KDB 456B', make_model: 'Isuzu D-Max', status: 'ACTIVE',
        owner_id: 'p1', assigned_driver_id: null, current_mileage: 80000, odometer_reading: 80000,
        operating_hours: 0, unit_system: 'metric', created_at: '2026-02-01T08:00:00Z'
      },
      {
        id: 'v3', plate_number: 'KDC 789C', make_model: 'Mazda Bongo', status: 'INACTIVE',
        owner_id: 'p1', assigned_driver_id: null, current_mileage: 30000, odometer_reading: 30000,
        operating_hours: 0, unit_system: 'metric', created_at: '2026-03-01T08:00:00Z'
      }
    ],
    reminders: [
      { id: 'r1', vehicle_id: 'v1', reminder_type: 'Oil change', status: 'active', threshold_unit: 'distance', target_value: 60000, last_service_value: 50000, remaining_value: 3000, display_unit: 'km' },
      { id: 'r2', vehicle_id: 'v1', reminder_type: 'Hydraulic service', status: 'active', threshold_unit: 'hours', target_value: 1300, last_service_value: 1000, remaining_value: -50, display_unit: 'hours' },
      { id: 'r3', vehicle_id: 'v1', reminder_type: 'Insurance Renewal', category: 'insurance', status: 'active', threshold_unit: 'date', due_date: '2026-11-05', notified_30d: false },
      { id: 'r4', vehicle_id: 'v2', reminder_type: 'Insurance Renewal', category: 'insurance', status: 'active', threshold_unit: 'date', due_date: '2026-09-01', notified_overdue: true },
      { id: 'r5', vehicle_id: 'v2', reminder_type: 'Service', category: 'maintenance', status: 'done', threshold_unit: 'date', due_date: '2026-12-01', completed_at: '2026-11-28T10:00:00Z', completed_on_time: true }
    ],
    expense_logs: [
      { id: 'e1', vehicle_id: 'v1', expense_type: 'Fuel', amount: 5000, fuel_liters: 40, odometer_reading: 49500, created_at: '2026-10-05T09:00:00Z' },
      { id: 'e2', vehicle_id: 'v1', expense_type: 'Fuel', amount: 4000, fuel_liters: 32, odometer_reading: 50000, created_at: '2026-10-20T09:00:00Z' },
      { id: 'e3', vehicle_id: 'v2', expense_type: 'Maintenance', amount: 12000, odometer_reading: 79000, notes: 'Brake pads replaced', created_at: '2026-10-10T09:00:00Z' },
      { id: 'e4', vehicle_id: 'v2', expense_type: 'Tolls', amount: 500, odometer_reading: 80000, created_at: '2026-10-25T09:00:00Z' }
    ],
    private_earnings: [
      { id: 'ea1', vehicle_id: 'v1', revenue_amount: 20000, logged_at: '2026-10-15T09:00:00Z' },
      { id: 'ea2', vehicle_id: 'v2', revenue_amount: 15000, logged_at: '2026-10-18T09:00:00Z' }
    ],
    passbook_transfers: [
      { id: 't1', vehicle_id: 'v1', status: 'COMPLETED', completed_at: '2026-10-01T12:00:00Z' }
    ],
    profiles: [
      { id: 'p1', phone_number: '+254700000001', full_name: 'Fleet Owner' },
      { id: 'd1', phone_number: '+254700000002', full_name: 'Driver One' }
    ],
    expiry_notification_log: [
      { id: 'log1', reminder_id: 'r3', vehicle_id: 'v1', category: 'insurance', tier: 'notified_7d', phone: '+254700000001', sent_at: '2026-10-28T09:00:00Z', message: 'Insurance expiring' }
    ]
  };
}

async function run() {
  const now = new Date('2026-10-29T09:00:00+03:00');
  const countryInfo = { country: 'Kenya', country_code: 'KE', currency: 'KES', locale: 'en-KE', default_units: 'metric', default_language: 'English', plate_example: 'KDA 123A' };
  const profile = { id: 'p1', preferred_language: 'English', unit_system: 'metric' };
  const mock = createMockSupabase(seedFleet());
  const base = { supabase: mock.client, ownerId: 'p1', countryInfo, profile, now };

  console.log('=== CORE FLEET REPORTS TESTS ===\n');
  console.log('--- Test 1: report type resolution ---');
  check(resolveReportType('show me the compliance report') === 'compliance', 'Compliance report phrase resolves');
  check(resolveReportType('financial report please') === 'financial', 'Financial report phrase resolves');
  check(resolveReportType('maintenance report') === 'maintenance', 'Maintenance report phrase resolves');
  check(resolveReportType('send the summary') === 'fleet', 'Generic summary falls back to the fleet status report');
  check(Object.keys(REPORT_TYPES).length === 4, 'Exactly four core report types are registered');

  console.log('\n--- Test 2: Fleet Status Report ---');
  const fleet = await buildFleetReport({ ...base, type: 'fleet' });
  check(fleet.ok && fleet.type === 'fleet', 'Fleet status report builds');
  check(fleet.data.overview.totalVehicles === 3 && fleet.data.overview.activeVehicles === 2, 'Fleet overview counts total and active vehicles');
  check(fleet.data.overview.unassignedVehicles === 2 && fleet.data.overview.activeDrivers === 1, 'Unassigned vehicles and active drivers are counted');
  check(fleet.data.health.availabilityRate === 66.7, 'Availability rate is calculated');
  check(fleet.data.health.distanceThisMonth === 1500 && fleet.data.health.distanceUnit === 'km', 'Month distance derives from odometer readings');
  check(fleet.data.urgent.overdueMaintenance === 1, 'Overdue threshold maintenance is flagged');
  check(fleet.data.urgent.overdueExpiries >= 2, 'Overdue expiries include inspection and insurance');
  check(fleet.data.urgent.expiredInsurance >= 1, 'Expired insurance is counted');
  check(fleet.data.recentActivity.length > 0, 'Recent activity feed is populated');
  check(/Fleet Status Report/.test(fleet.text) && /KDA 123A/.test(fleet.text), 'WhatsApp text carries the report title and a plate');

  console.log('\n--- Test 3: Compliance & Expiry Report ---');
  const compliance = await buildFleetReport({ ...base, type: 'compliance' });
  check(compliance.ok && compliance.type === 'compliance', 'Compliance report builds');
  check(compliance.data.insuranceStatusMatrix.expired >= 1, 'Expired insurance appears in the matrix');
  check(compliance.data.insuranceStatusMatrix.due7 >= 1, 'A 7-day insurance renewal appears in the matrix');
  check(compliance.data.inspectionAndPermits.inspections.expired >= 1, 'Expired inspections are tracked');
  check(compliance.data.notificationLog.length === 1 && compliance.data.notificationLog[0].tier === 'notified_7d', 'Tiered notification log is included');
  check(compliance.data.actionPrompt.length >= 1, 'Actionable owner prompts are generated');
  check(/Compliance & Expiry Report/.test(compliance.text) && /Recent Tiered Alerts/.test(compliance.text), 'Compliance text includes the alert log');

  console.log('\n--- Test 4: Maintenance & Service Report ---');
  const maintenance = await buildFleetReport({ ...base, type: 'maintenance' });
  check(maintenance.ok && maintenance.data.thresholds.length === 2, 'Both distance and hours thresholds are tracked');
  check(maintenance.data.thresholds.some((item) => item.dueState === 'overdue'), 'Overdue threshold state is reported');
  check(maintenance.data.pmCompliance.completedOnTime === 1, 'On-time PM completions are counted');
  check(maintenance.data.pmCompliance.overdue === 2, 'Overdue PM items include thresholds and expired dates');
  check(maintenance.data.pmCompliance.complianceRate === 33.3, 'PM compliance rate is calculated');
  check(maintenance.data.serviceHistory.length === 1 && /Brake pads/.test(maintenance.data.serviceHistory[0].notes), 'Service history includes workshop notes');
  check(/Maintenance & Service Report/.test(maintenance.text) && /PM Compliance/.test(maintenance.text), 'Maintenance text includes PM compliance');

  console.log('\n--- Test 5: Financial & Cost Report ---');
  const financial = await buildFleetReport({ ...base, type: 'financial' });
  check(financial.ok && financial.data.expenses.fuel === 9000, 'Fuel expenses are itemized');
  check(financial.data.expenses.maintenance === 12000 && financial.data.expenses.tolls === 500, 'Maintenance and toll expenses are itemized');
  check(financial.data.expenses.total === 21500, 'Operating expenses total correctly');
  check(financial.data.earnings.total === 35000, 'Earnings total correctly');
  check(financial.data.net.total === 13500, 'Net profit is earnings minus expenses');
  check(financial.data.efficiency.distance === 1500 && financial.data.efficiency.distanceUnit === 'km', 'Efficiency distance uses the owner unit system');
  check(financial.data.efficiency.costPerDistance === 14.33, 'Cost per km is normalized against distance covered');
  check(financial.data.efficiency.costPerHour === 17.92, 'Cost per operating hour is normalized');
  check(financial.data.net.byVehicle.some((row) => row.plate === 'KDB 456B' && row.net === 2500), 'Per-vehicle net performance is calculated');
  check(/Financial & Cost Report/.test(financial.text) && /Ksh|KES/.test(financial.text), 'Financial text is localized to the owner currency');
  check(/1,500 km/.test(financial.text), 'Financial text localizes the distance figure');

  console.log('\n--- Test 6: USD / imperial localization ---');
  const usCtx = { country: 'United States', country_code: 'US', currency: 'USD', locale: 'en-US', default_units: 'imperial', default_language: 'English', plate_example: '7ABC123' };
  const imperialFinancial = await buildFleetReport({
    supabase: mock.client,
    ownerId: 'p1',
    countryInfo: usCtx,
    profile: { id: 'p1', unit_system: 'imperial' },
    type: 'financial',
    now
  });
  check(imperialFinancial.data.currency === 'USD' && imperialFinancial.data.efficiency.distanceUnit === 'mi', 'US owners receive USD and miles');
  check(imperialFinancial.data.efficiency.distance === 932, 'Month distance is converted to miles');

  console.log(`\n\u2705 ALL FLEET REPORT TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});


