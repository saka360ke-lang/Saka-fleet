/**
 * Saka Fleet — Apex Report Builders test suite (v1.29.0, stateless)
 * ----------------------------------------------------------------
 * Proves the five Apex report categories produce engine-owned, fully surfaced
 * data and render to valid PDFs:
 *   1. Fleet executive (core fleet + financial data with a ledger)
 *   2. Vehicle deep-dive (one asset, plate badge, full ledger)
 *   3. Driver performance & compliance (activity, adherence, ledger)
 *   4. Owner portfolio (multi-asset consolidation, per-vehicle distribution)
 *   5. Bespoke/custom ledgers (covered by test_report_metrics.js)
 *
 * Uses an in-memory Supabase mock — NOTHING touches the real database.
 * Run: node test_report_builders.js
 */

import assert from 'assert';
import { buildVehicleDeepDive } from './src/services/vehicleDeepDive.js';
import { buildOwnerPortfolio } from './src/services/ownerPortfolio.js';
import { buildDriverPerformance } from './src/services/driverReports.js';
import { buildLedgerGroups, expenseToLedgerRow } from './src/services/reportLedger.js';
import { resolveAnyReportType, buildReportForLane, deliverReportPdf, renderReportPdfBuffer, fleetReportToPdf } from './src/services/reportDelivery.js';
import { REPORT_ACCESS_MATRIX } from './src/services/reportAccess.js';
import { buildProReportPdf } from './src/services/pdfEngine.js';
import { extractPdfText } from './src/services/pdfTextExtractor.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

function matches(row, filters) {
  return filters.every((filter) => {
    if (filter.op === 'eq') return row[filter.col] === filter.val;
    if (filter.op === 'ilike') return String(row[filter.col] || '').toLowerCase() === String(filter.val || '').toLowerCase();
    if (filter.op === 'in') return Array.isArray(filter.val) && filter.val.includes(row[filter.col]);
    if (filter.op === 'is') {
      if (filter.val === null) return row[filter.col] === null || row[filter.col] === undefined;
      return row[filter.col] === filter.val;
    }
    if (filter.op === 'gte') return String(row[filter.col] || '') >= String(filter.val);
    if (filter.op === 'lte') return String(row[filter.col] || '') <= String(filter.val);
    return true;
  });
}

function createMockSupabase(seed = {}) {
  const tables = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((row) => ({ ...row }));

  function makeBuilder(table) {
    const filters = [];
    let limitN = null;
    const run = () => {
      let result = (tables[table] || []).filter((row) => matches(row, filters));
      if (limitN !== null) result = result.slice(0, limitN);
      return { data: result.map((row) => ({ ...row })), error: null };
    };
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      ilike(col, val) { filters.push({ op: 'ilike', col, val }); return builder; },
      in(col, vals) { filters.push({ op: 'in', col, val: vals }); return builder; },
      is(col, val) { filters.push({ op: 'is', col, val }); return builder; },
      gte(col, val) { filters.push({ op: 'gte', col, val }); return builder; },
      lte(col, val) { filters.push({ op: 'lte', col, val }); return builder; },
      limit(n) { limitN = n; return builder; },
      maybeSingle() {
        const outcome = run();
        return Promise.resolve({ data: outcome.data[0] || null, error: null });
      },
      then(resolve) { return resolve(run()); }
    };
    return builder;
  }

  return { tables, client: { from: (table) => makeBuilder(table) } };
}

const NOW = new Date('2026-11-10T09:00:00+03:00');
const COUNTRY = Object.freeze({
  country: 'Kenya', country_code: 'KE', currency: 'KES', locale: 'en-KE',
  default_units: 'metric', default_language: 'English', plate_example: 'KDA 123A'
});
const OWNER = Object.freeze({
  id: 'p1', full_name: 'Daudi Mwangi', phone_number: '+254700000001',
  email: 'owner@sakafleet.com', preferred_language: 'English', unit_system: 'metric'
});
const OWNER_ACCESS = Object.freeze({ lane: 'owner', vehicleIds: ['v1', 'v2', 'v4'] });
const LEDGER_CTX = Object.freeze({ currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' });

function seedFleet() {
  return {
    vehicles: [
      {
        id: 'v1', plate_number: 'KDA 123A', make_model: 'Toyota Hilux', year: 2021, status: 'ACTIVE',
        owner_id: 'p1', assigned_driver_id: 'd1', current_mileage: 51200, odometer_reading: 51200,
        operating_hours: 0, fuel_type: 'Diesel', asset_type: 'vehicle', vin: 'JT1234567890ABCDE',
        created_at: '2026-01-05T08:00:00Z'
      },
      {
        id: 'v2', plate_number: 'KDB 456B', make_model: 'Isuzu D-Max', status: 'ACTIVE',
        owner_id: 'p1', assigned_driver_id: null, current_mileage: 80000, odometer_reading: 80000,
        operating_hours: 0, fuel_type: 'Diesel', asset_type: 'vehicle', created_at: '2026-02-01T08:00:00Z'
      },
      {
        id: 'v3', plate_number: 'KDC 999C', make_model: 'Mazda Bongo', status: 'ACTIVE',
        owner_id: 'p2', assigned_driver_id: 'd2', current_mileage: 30000, odometer_reading: 30000,
        operating_hours: 0, asset_type: 'vehicle', created_at: '2026-03-01T08:00:00Z'
      },
      {
        id: 'v4', plate_number: 'KDD 111D', make_model: 'Toyota Probox', status: 'PAUSED',
        owner_id: 'p1', assigned_driver_id: null, current_mileage: 120000, odometer_reading: 120000,
        operating_hours: 0, asset_type: 'vehicle', created_at: '2026-04-01T08:00:00Z'
      }
    ],
    expense_logs: [
      { id: 'e1', vehicle_id: 'v1', driver_id: 'd1', expense_type: 'Fuel', amount: 6000, fuel_liters: 45, odometer_reading: 50800, fill_type: 'full', notes: 'Shell Westlands', created_at: '2026-11-02T09:00:00Z' },
      { id: 'e2', vehicle_id: 'v1', driver_id: 'd1', expense_type: 'Fuel', amount: 5000, fuel_liters: 40, odometer_reading: 51200, fill_type: 'full', created_at: '2026-10-20T09:00:00Z' },
      { id: 'e3', vehicle_id: 'v1', driver_id: 'd1', expense_type: 'Maintenance', amount: 12000, odometer_reading: 51000, notes: 'Brake pads replaced', created_at: '2026-10-10T09:00:00Z' },
      { id: 'e4', vehicle_id: 'v2', driver_id: null, expense_type: 'Tolls', amount: 0, odometer_reading: null, created_at: '2026-11-01T09:00:00Z' },
      { id: 'e5', vehicle_id: 'v3', driver_id: 'd2', expense_type: 'Fuel', amount: 99999, fuel_liters: 10, odometer_reading: 30000, created_at: '2026-11-05T09:00:00Z' }
    ],
    private_earnings: [
      { id: 'ea1', vehicle_id: 'v1', driver_id: 'd1', revenue_amount: 25000, odometer_reading: 51250, logged_at: '2026-11-03T09:00:00Z', created_at: '2026-11-03T09:00:00Z' },
      { id: 'ea2', vehicle_id: 'v2', driver_id: null, revenue_amount: 15000, logged_at: '2026-10-18T09:00:00Z', created_at: '2026-10-18T09:00:00Z' }
    ],
    reminders: [
      { id: 'r1', vehicle_id: 'v1', reminder_type: 'Insurance Renewal', category: 'insurance', status: 'active', threshold_unit: 'date', due_date: '2026-12-01' }
    ],
    profiles: [
      { id: 'p1', full_name: 'Daudi Mwangi', phone_number: '+254700000001', email: 'owner@sakafleet.com' },
      { id: 'd1', full_name: 'Amina Wanjiku', phone_number: '+254700000002', email: 'amina@sakafleet.com' },
      { id: 'd2', full_name: 'Other Driver', phone_number: '+254700000003' }
    ],
    driver_compliances: [
      { id: 'c1', driver_id: 'd1', label: 'Driving Licence', type: 'driving_licence', number: 'DL123456', expiry: '2027-05-15' }
    ],
    vehicle_compliances: [],
    driver_assignments: []
  };
}

async function run() {
  const mock = createMockSupabase(seedFleet());

  console.log('=== SAKA FLEET - APEX REPORT BUILDERS (v1.29.0) ===\n');

  console.log('--- Test 1: ledger mapping + transparency ---');
  const fuelRow = expenseToLedgerRow(mock.tables.expense_logs[0], { ctx: LEDGER_CTX });
  check(fuelRow.kind === 'fuel' && fuelRow.kindLabel === 'FUEL', 'Fuel expense maps to a FUEL ledger badge');
  check(fuelRow.unitCost === 133.33, 'Unit cost is engine-derived from amount / litres (133.33)');
  check(fuelRow.odometer === 50800, 'Odometer reading is carried into the ledger row');
  const zeroRow = expenseToLedgerRow(mock.tables.expense_logs[3], { ctx: LEDGER_CTX });
  check(zeroRow.amount === 0, 'A real zero amount stays 0 (surfaced, not hidden)');
  check(zeroRow.odometer === null, 'A missing odometer stays null (renders as a dash)');

  const ledger = buildLedgerGroups({
    expenses: mock.tables.expense_logs,
    earnings: mock.tables.private_earnings,
    vehicles: mock.tables.vehicles,
    ctx: LEDGER_CTX,
    includeVehicle: true
  });
  check(ledger.groups.length === 2, 'Ledger groups transactions by month (Nov + Oct)');
  check(ledger.groups[0].label === 'November 2026', 'Newest month group comes first');
  check(ledger.totals.expenseTotal === 122999, 'Expense total includes every amount (zero included)');
  check(ledger.totals.earningTotal === 40000, 'Earning total is engine-calculated');
  check(ledger.totals.scanned === ledger.totals.shown, 'Every scanned record is shown - nothing truncated');
  check(ledger.showVehicle === true && ledger.groups[0].rows.every((row) => 'vehicle' in row), 'Portfolio ledgers carry a vehicle column');

  console.log('\n--- Test 2: vehicle deep-dive ---');
  const deepDive = await buildVehicleDeepDive({
    supabase: mock.client,
    plate: 'KDA 123A',
    ownerId: 'p1',
    countryInfo: COUNTRY,
    profile: OWNER,
    access: OWNER_ACCESS,
    now: NOW
  });
  check(deepDive.ok && deepDive.type === 'vehicle_deep_dive', 'Deep-dive builds for a named plate');
  check(deepDive.data.plate === 'KDA 123A', 'Plate badge data is attached to the cover');
  check(deepDive.data.ledgers[0].totals.expenseTotal === 23000, 'Deep-dive ledger totals this vehicle only (23,000)');
  check(deepDive.data.ledgers[0].totals.earningTotal === 25000, 'Deep-dive surfaces the vehicle earnings (25,000)');
  check(deepDive.data.kpis.some((item) => item.label === 'Earnings'), 'Owner deep-dive includes an earnings KPI');
  check(deepDive.data.kpis.some((item) => item.label === 'Total spend' && item.tone === 'negative'), 'Spend KPI carries the negative semantic tone');
  check(deepDive.data.charts.some((chart) => chart.type === 'segment'), 'Category spend split renders as a segmented bar');
  check(deepDive.data.charts.some((chart) => chart.type === 'vs'), 'Earnings vs expenses bars are included');
  check(deepDive.data.callouts.some((callout) => /surplus|shortfall/i.test(callout.title)), 'Financial-health callout is present');
  check(deepDive.data.sections.some((section) => section.title === 'Data completeness'), 'Data-completeness panel is surfaced');

  const deniedDive = await buildVehicleDeepDive({
    supabase: mock.client,
    plate: 'KDA 123A',
    ownerId: 'p1',
    countryInfo: COUNTRY,
    profile: OWNER,
    access: { lane: 'owner', vehicleIds: ['v2'] },
    now: NOW
  });
  check(deniedDive.ok === false && deniedDive.denied === true, 'A vehicle outside the lane is denied (defense in depth)');

  const driverDive = await buildVehicleDeepDive({
    supabase: mock.client,
    driverId: 'd1',
    countryInfo: COUNTRY,
    profile: OWNER,
    access: { lane: 'driver', vehicleIds: ['v1'] },
    now: NOW
  });
  check(driverDive.ok && driverDive.data.ledgers[0].totals.earningTotal === 0, 'Driver-lane deep-dive never includes owner earnings');
  check(!driverDive.data.kpis.some((item) => item.label === 'Earnings'), 'Driver-lane KPIs never show owner earnings');
  check(driverDive.data.sections.some((section) => section.rows?.some((row) => row.value === 'Not in your lane')), 'Driver lane is explicit about excluded earnings');

  console.log('\n--- Test 3: owner portfolio ---');
  const portfolio = await buildOwnerPortfolio({
    supabase: mock.client,
    ownerId: 'p1',
    countryInfo: COUNTRY,
    profile: OWNER,
    access: OWNER_ACCESS,
    now: NOW
  });
  check(portfolio.ok && portfolio.type === 'owner_portfolio', 'Owner portfolio builds');
  check(portfolio.data.tables[0].rows.length === 3, 'All three owned assets are listed (another owner\'s vehicle is excluded)');
  check(portfolio.data.tables[0].rows.some((row) => row.plate === 'KDD 111D' && row.expenses === 0), 'Zero-activity asset is surfaced with an explicit 0');
  check(portfolio.data.ledgers[0].showVehicle === true, 'Consolidated ledger carries the vehicle column');
  check(portfolio.data.ledgers[0].totals.expenseTotal === 23000, 'Portfolio expense total excludes other owners');
  check(portfolio.data.ledgers[0].totals.earningTotal === 40000, 'Portfolio earnings total is consolidated');
  check(portfolio.data.kpis.some((item) => item.label === 'Net payouts'), 'Net payouts KPI is present');
  check(portfolio.data.charts.filter((chart) => chart.type === 'segment').length >= 1, 'Multi-vehicle distribution segment chart is included');
  check(portfolio.data.callouts.some((callout) => /strongest asset/i.test(callout.title)), 'Portfolio insight callouts are generated');

  const deniedPortfolio = await buildOwnerPortfolio({
    supabase: mock.client,
    ownerId: 'p1',
    countryInfo: COUNTRY,
    profile: OWNER,
    access: { lane: 'driver', vehicleIds: ['v1'] },
    now: NOW
  });
  check(deniedPortfolio.ok === false && deniedPortfolio.denied === true, 'Driver lane can never build the owner portfolio');

  console.log('\n--- Test 4: driver performance & compliance ---');
  const performance = await buildDriverPerformance({
    supabase: mock.client,
    ownerId: 'p1',
    countryInfo: COUNTRY,
    profile: OWNER,
    now: NOW,
    days: 90
  });
  check(performance.ok && performance.type === 'driver_performance', 'Driver performance builds for the assigned driver');
  check(performance.data.kpis.length === 6, 'Six KPI cards are produced');
  check(performance.data.kpis.some((item) => item.label === 'Active days' && item.value === '4 of 90'), 'Adherence counts distinct active days (4 of 90)');
  check(performance.data.kpis.some((item) => item.label === 'Compliance valid' && item.value === '1/1'), 'Compliance verification is surfaced');
  check(performance.data.ledgers[0].totals.shown === 4, 'Ledger shows the driver\'s own 4 records only');
  check(performance.data.ledgers[0].totals.earningTotal === 25000, 'Driver earnings submitted are included for the owner');
  check(performance.data.tables[0].rows.length === 3, 'Daily activity log groups the logs by day');
  check(performance.data.callouts.some((callout) => /fuel data discipline/i.test(callout.title)), 'Fill-type discipline callout is generated');
  check(performance.data.sections.some((section) => section.title === 'Data completeness'), 'Driver data-completeness panel is present');

  const deniedPerformance = await buildDriverPerformance({
    supabase: mock.client,
    ownerId: 'p1',
    driverId: 'd2',
    countryInfo: COUNTRY,
    profile: OWNER,
    now: NOW
  });
  check(deniedPerformance.ok === false && deniedPerformance.denied === true, 'Another owner\'s driver is denied');

  console.log('\n--- Test 5: report type routing + access matrix ---');
  check(resolveAnyReportType('vehicle report') === 'vehicle_deep_dive', 'Vehicle report phrase resolves to the deep-dive');
  check(resolveAnyReportType('show me my assets') === 'owner_portfolio', 'Assets phrase resolves to the owner portfolio');
  check(resolveAnyReportType('driver performance') === 'driver_performance', 'Driver performance resolves to the new report');
  check(resolveAnyReportType('driver scorecard') === 'driver_scorecard', 'The legacy driver scorecard alias still resolves');
  check(resolveAnyReportType('vehicle_deep_dive') === 'vehicle_deep_dive', 'Exact registry keys resolve (underscored report_type)');
  check(resolveAnyReportType('fuel report') === 'fuel_economy', 'Existing fuel aliases still resolve first');
  check(REPORT_ACCESS_MATRIX.vehicle_deep_dive.owner === true && REPORT_ACCESS_MATRIX.vehicle_deep_dive.driver === false, 'Deep-dive is owner-only');
  check(REPORT_ACCESS_MATRIX.owner_portfolio.driver === false && REPORT_ACCESS_MATRIX.driver_performance.driver === false, 'Portfolio and driver performance stay owner-only');

  console.log('\n--- Test 5b: lane wiring reaches the Apex builders ---');
  const laneDive = await buildReportForLane({
    supabase: mock.client,
    reportType: 'vehicle_deep_dive',
    ownerId: 'p1',
    plate: 'KDA 123A',
    profile: OWNER,
    countryInfo: COUNTRY,
    now: NOW
  });
  check(laneDive.ok && laneDive.type === 'vehicle_deep_dive' && laneDive.access?.lane === 'owner', 'buildReportForLane routes the deep-dive with owner access');
  const lanePortfolio = await buildReportForLane({
    supabase: mock.client,
    reportType: 'owner_portfolio',
    ownerId: 'p1',
    profile: OWNER,
    countryInfo: COUNTRY,
    now: NOW
  });
  check(lanePortfolio.ok && lanePortfolio.type === 'owner_portfolio', 'buildReportForLane routes the owner portfolio');
  const lanePerformance = await buildReportForLane({
    supabase: mock.client,
    reportType: 'driver_performance',
    ownerId: 'p1',
    profile: OWNER,
    countryInfo: COUNTRY,
    now: NOW
  });
  check(lanePerformance.ok && lanePerformance.type === 'driver_performance', 'buildReportForLane routes driver performance');

  const laneFinancial = await buildReportForLane({
    supabase: mock.client,
    reportType: 'financial',
    ownerId: 'p1',
    profile: OWNER,
    countryInfo: COUNTRY,
    now: NOW
  });
  check(laneFinancial.ok && laneFinancial.type === 'financial', 'Financial report builds through the lane');
  const financialDelivery = await deliverReportPdf({
    supabase: mock.client,
    report: laneFinancial,
    people: { owner: OWNER, drivers: [] },
    plateLabel: 'Fleet'
  });
  check(financialDelivery.ok && financialDelivery.bytes > 5000, 'Financial PDF renders through the Apex adapter');

  const laneFleet = await buildReportForLane({
    supabase: mock.client,
    reportType: 'fleet',
    ownerId: 'p1',
    profile: OWNER,
    countryInfo: COUNTRY,
    now: NOW
  });
  const fleetDelivery = await deliverReportPdf({
    supabase: mock.client,
    report: laneFleet,
    people: { owner: OWNER, drivers: [] },
    plateLabel: 'Fleet'
  });
  check(fleetDelivery.ok && fleetDelivery.bytes > 5000, 'Fleet executive PDF renders with its financial block + ledger');

  // v1.93.0 (Phase 30, Task 1) — the variant rides the one shared renderer:
  // WhatsApp-shipped reports pass 'mobile'; the default stays the A4 email.
  const mobileVariantBuffer = await renderReportPdfBuffer(laneFleet, { owner: OWNER, drivers: [] }, { variant: 'mobile' });
  check(Buffer.isBuffer(mobileVariantBuffer) && mobileVariantBuffer.subarray(0, 5).toString() === '%PDF-', 'the shared renderer builds the mobile variant');
  check(/\b419(\.0+)?\s+595(\.0+)?\b/.test(mobileVariantBuffer.toString('latin1')), 'the report renderer threads variant=mobile (A5 page)');
  const defaultVariantBuffer = await renderReportPdfBuffer(laneFleet, { owner: OWNER, drivers: [] });
  check(/\b595(\.\d+)?\s+841(\.\d+)?\b/.test(defaultVariantBuffer.toString('latin1')), 'the report renderer defaults to A4 (email sweeps unchanged)');

  console.log('\n--- Test 5c: financial PDF presentation (v1.32.0) ---');
  const singleVehicleFinancial = {
    data: {
      type: 'financial',
      currency: 'KES',
      expenses: { fuel: 5300, total: 5300 },
      earnings: { total: 0 },
      net: { total: -5300, byVehicle: [{ plate: 'KAS 628T', expenses: 5300, earnings: 0, net: -5300 }] },
      counts: { expenses: 3, earnings: 0 },
      fuelLitres: 22.5,
      vehicles: [{ plate: 'KAS 628T', make_model: 'Toyota Land Cruiser', fuel_type: 'Diesel', asset_kind: 'vehicle', odometer: 367359 }],
      efficiency: { distance: 0, distanceUnit: 'km', costPerDistance: null, costPerHour: null },
      ledger: { title: 'Transaction ledger - KAS 628T', currency: 'KES', groups: [], totals: { scanned: 3, shown: 3 } }
    },
    text: 'Financial & Cost Report\nOperating Expenses\nTotal: KES 5,300\nNet: -KES 5,300'
  };
  const singlePdf = fleetReportToPdf(singleVehicleFinancial, 'financial');
  check(singlePdf.title === 'Financial & Cost Report - KAS 628T', 'Single-vehicle title names the report and plate');
  check(singlePdf.plate === 'KAS 628T', 'Plate badge data reaches the cover');
  check(singlePdf.periodLabel === 'All recorded activity', 'Cover period is a period, never a timezone');
  check(/Toyota Land Cruiser/.test(singlePdf.subtitle), 'Subtitle carries the vehicle identity');
  check(singlePdf.kpis.length === 6, 'Six KPI cards fill the grid');
  check(singlePdf.kpis.find((k) => k.label === 'Earnings')?.tone === undefined, 'Zero earnings are neutral, never emerald');
  check(singlePdf.kpis.find((k) => k.label === 'Net')?.tone === 'negative', 'A negative net stays coral');
  check(singlePdf.kpis.find((k) => k.label === 'Transactions')?.value === '3', 'Transactions KPI counts records in scope');
  // v1.86.0 (Phase 25) — the hint is now meter-neutral ("nothing logged") because
  // an hours-led scope reports Operating hours instead of a distance at all.
  check(singlePdf.kpis.find((k) => k.label === 'Distance (km)')?.hint === 'nothing logged this month', 'Zero distance explains itself');
  check(singlePdf.tables.length === 0, 'The redundant one-row per-vehicle table is removed');
  check(singlePdf.sections.some((s) => s.title === 'Vehicle snapshot'), 'Vehicle snapshot panel replaces it');

  console.log('\n--- v1.86.0: hours-led PDF (Engine hours, never Odometer) ---');
  const generatorFinancialPdf = fleetReportToPdf({
    type: 'financial',
    text: 'Engine hours report',
    data: {
      type: 'financial',
      currency: 'KES',
      meter: { label: 'Engine hours', id: 'engine_hours' },
      assignmentMeter: 'hours',
      vehicles: [{ plate: 'GEN-01', make_model: 'Cummins 60kVA', asset_kind: 'generator', meterLabel: 'Engine hours', meterValue: 1240, meterUnit: 'h' }],
      expenses: { total: 8500 },
      earnings: { total: 0 },
      net: { total: -8500 },
      health: { operatingHours: 1240 },
      ledger: { title: 'Generator ledger', currency: 'KES', meterLabel: 'Engine hours', groups: [], totals: { shown: 0, expenseTotal: 8500, earningTotal: 0 } }
    }
  }, 'financial');
  check(generatorFinancialPdf.kpis.some((k) => k.label === 'Operating hours'), 'an hours-led report shows OPERATING HOURS, not a distance');
  check(!generatorFinancialPdf.kpis.some((k) => k.label.startsWith('Distance')), 'an hours-led report never prints a Distance KPI');
  const generatorSnapshot = generatorFinancialPdf.sections.find((s) => s.title === 'Vehicle snapshot');
  check(generatorSnapshot?.rows.some((row) => row.label === 'Engine hours' && row.value === '1,240 h'), 'the snapshot prints Engine hours 1,240 h');
  check(!generatorSnapshot?.rows.some((row) => row.label === 'Odometer'), 'the snapshot never prints Odometer for a generator');
  check(singlePdf.kpis.some((k) => k.label === 'Distance (km)'), 'a road scope keeps the Distance KPI (no regression)');
  check(singlePdf.callouts.every((c) => c.title !== 'Cost efficiency'), 'No cost-efficiency callout when cost metrics are null');
  check(singlePdf.callouts.every((c) => !/—/.test(c.body || '')), 'No dash-only callout bodies');
  check(singlePdf.callouts.some((c) => /Financial health/.test(c.title)), 'Financial-health callout survives');
  check(singlePdf.ledgers[0].title.startsWith('Transaction ledger'), 'Ledger title is scope-aware');

  const positiveEarnings = {
    ...singleVehicleFinancial,
    data: {
      ...singleVehicleFinancial.data,
      earnings: { total: 2000 },
      net: { total: -3300, byVehicle: [{ plate: 'KAS 628T', expenses: 5300, earnings: 2000, net: -3300 }] },
      counts: { expenses: 3, earnings: 1 }
    }
  };
  const positivePdf = fleetReportToPdf(positiveEarnings, 'financial');
  check(positivePdf.kpis.find((k) => k.label === 'Earnings')?.tone === 'positive', 'Non-zero earnings keep the positive tone');

  console.log('\n--- Test 6: Apex PDF rendering + readable ledger text ---');
  for (const [label, data] of [
    ['vehicle deep-dive', deepDive.data],
    ['owner portfolio', portfolio.data],
    ['driver performance', performance.data]
  ]) {
    const buffer = await buildProReportPdf(data);
    check(Buffer.isBuffer(buffer) && buffer.slice(0, 5).toString() === '%PDF-', `${label} renders a valid PDF (${buffer.length} bytes)`);
  }
  const ledgerPdf = await buildProReportPdf({
    title: 'Ledger proof',
    reportType: 'vehicle_deep_dive',
    plate: 'KDA 123A',
    useStandardFonts: true,
    ledgers: [ledger],
    notes: ['Transparency check']
  });
  const extracted = extractPdfText(ledgerPdf);
  const text = String(extracted.text || '').toLowerCase();
  check(Boolean(extracted.text), 'Rendered ledger has a readable text layer');
  check(text.includes('kda 123a'), 'Plate badge text is drawn on the cover');
  check(text.includes('fuel'), 'Ledger type badges are drawn (FUEL)');
  check(text.includes('total'), 'Ledger TOTAL band is drawn');
  check(text.includes('nothing hidden'), 'Transparency footer is drawn ("nothing hidden")');

  console.log(`\n🎉 ${passed} Apex report-builder assertions passed.`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\n❌ Apex report-builder suite failed:', err.message);
  process.exit(1);
});
