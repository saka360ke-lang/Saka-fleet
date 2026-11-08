/**
 * Saka Fleet — vehicle analytics (v1.80.0, Phase 19, stateless).
 * Proves the tyre-wear math (the spec example: 25,000 km on a 50,000 km set =
 * 50% remaining), the Replace-Soon flag, honest empty states, the six monthly
 * cost-per-km buckets (shared distance engine) and the SVG chart geometry.
 */
import assert from 'assert';
import {
  buildTyreWearRows,
  buildCostPerKmTrend,
  buildCostPerKmChart,
  getTyreLifespanKm,
  getTyreReplaceSoonKm,
  isTyreExpenseType
} from './src/services/vehicleAnalytics.js';
import { distanceInWindow } from './src/services/fleetReports.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

const NOW = new Date('2026-11-08T06:00:00Z');
const vehicle = (overrides = {}) => ({ id: 'v1', plate_number: 'KAS 628T', make_model: 'Toyota Land Cruiser', status: 'ACTIVE', current_mileage: 120000, ...overrides });
const tyre = (odometer, at = '2026-09-01T00:00:00Z', overrides = {}) => ({
  id: 'tyre-' + odometer,
  vehicle_id: 'v1',
  expense_type: 'Tyres',
  amount: 40000,
  odometer_reading: odometer,
  created_at: at,
  ...overrides
});
const fuel = (odometer, at, amount = 5000) => ({
  id: 'fuel-' + at,
  vehicle_id: 'v1',
  expense_type: 'Fuel',
  amount,
  odometer_reading: odometer,
  created_at: at
});

const PREV_LIFESPAN = process.env.TYRE_LIFESPAN_KM;

console.log('=== SAKA FLEET — VEHICLE ANALYTICS (v1.80.0) ===\n');

console.log('--- Test 1: tyre type + defaults ---');
check(isTyreExpenseType('Tyres') === true && isTyreExpenseType('Tyre') === true && isTyreExpenseType('tire') === true,
  'Tyres / Tyre / tire all count');
check(isTyreExpenseType('Fuel') === false && isTyreExpenseType('Tyre repair kit') === false, 'a one-off "tyre repair kit" is not a tyre set');
check(getTyreLifespanKm() === 50000 && getTyreReplaceSoonKm() === 40000, 'the 50,000 / 40,000 defaults are locked (D3)');

console.log('\n--- Test 2: the spec example — 25,000 km since the last set ---');
const example = buildTyreWearRows({ vehicles: [vehicle()], expenses: [tyre(95000)] });
check(example.length === 1 && example[0].kmSince === 25000, 'current odometer minus the last tyre reading = 25,000 km');
check(example[0].remainingPct === 50, '25,000 of 50,000 km = 50% life remaining');
check(example[0].status === 'ok' && example[0].replaceSoon === false, '25,000 km is not Replace Soon');
check(example[0].lifespan === 50000 && example[0].replaceSoonAt === 40000, 'the assumptions ride the row (labelled in the UI)');
check(example[0].lastTyreOdometer === 95000 && example[0].currentOdometer === 120000, 'both odometers are surfaced');

console.log('\n--- Test 3: Replace Soon + the latest set wins ---');
const replaced = buildTyreWearRows({
  vehicles: [vehicle()],
  expenses: [tyre(95000, '2026-09-01T00:00:00Z'), tyre(70000, '2026-03-01T00:00:00Z')]
});
check(replaced[0].kmSince === 25000, 'the NEWEST tyre expense starts the clock (not the oldest)');
const soon = buildTyreWearRows({ vehicles: [vehicle()], expenses: [tyre(75000)] });
check(soon[0].kmSince === 45000 && soon[0].replaceSoon === true && soon[0].status === 'replace_soon', '45,000 km flags Replace Soon');
check(soon[0].remainingPct === 10, '45,000 of 50,000 km = 10% remaining');

console.log('\n--- Test 4: honest empty + broken data ---');
const none = buildTyreWearRows({ vehicles: [vehicle()], expenses: [tyre(0), fuel(118000, '2026-10-01T00:00:00Z')] });
check(none[0].status === 'no_data' && none[0].kmSince === null && none[0].remainingPct === null,
  'a Tyres row without an odometer reading never drives the math (no_data)');
const negative = buildTyreWearRows({ vehicles: [vehicle({ current_mileage: 90000 })], expenses: [tyre(95000)] });
check(negative[0].kmSince === 0 && /below the last tyre reading/.test(negative[0].note), 'a rollback clamps to 0 and says so');
const noOdo = buildTyreWearRows({ vehicles: [vehicle({ current_mileage: null, odometer_reading: null })], expenses: [tyre(95000)] });
check(noOdo[0].kmSince === null && /no current odometer/.test(noOdo[0].note), 'no current odometer is honest, not invented');
const deleted = buildTyreWearRows({ vehicles: [vehicle({ status: 'DELETED' })], expenses: [tyre(95000)] });
check(deleted.length === 0, 'deleted vehicles never appear');

console.log('\n--- Test 5: imperial owners see miles ---');
const imperial = buildTyreWearRows({ vehicles: [vehicle()], expenses: [tyre(95000)], unitSystem: 'imperial' });
check(imperial[0].distanceUnit === 'mi' && imperial[0].kmSince < 25000 && imperial[0].kmSince > 10000,
  'kilometres convert to miles for display');
check(imperial[0].remainingPct === 50, 'the percentage is unit-independent');


console.log('\n--- Test 6: the six monthly cost-per-km buckets ---');
const trendExpenses = [
  // September: two readings 1,000 km apart + 5,000 spend = 5 per km
  fuel(100000, '2026-09-02T08:00:00Z', 2000),
  fuel(101000, '2026-09-28T08:00:00Z', 3000),
  // October: one reading only → spend exists, distance cannot be derived
  fuel(102000, '2026-10-10T08:00:00Z', 4000),
  // November: two readings 500 km apart + 1,500 spend = 3 per km
  fuel(102500, '2026-11-02T08:00:00Z', 700),
  fuel(103000, '2026-11-07T08:00:00Z', 800)
];
const trend = buildCostPerKmTrend({ expenses: trendExpenses, now: NOW });
check(trend.months.length === 6, 'exactly six monthly buckets');
check(trend.months[5].key === '2026-11' && trend.months[0].key === '2026-06', 'the buckets run oldest → newest and end in the current month');
const sep = trend.months.find((bucket) => bucket.key === '2026-09');
const oct = trend.months.find((bucket) => bucket.key === '2026-10');
const nov = trend.months.find((bucket) => bucket.key === '2026-11');
check(sep.spend === 5000 && sep.distance === 1000 && sep.costPerKm === 5, 'September: 5,000 ÷ 1,000 km = 5.00 per km');
check(oct.spend === 4000 && oct.distance === 0 && oct.costPerKm === null, 'October has spend but no movement → cost is null, never invented');
check(nov.spend === 1500 && nov.distance === 500 && nov.costPerKm === 3, 'November: 1,500 ÷ 500 km = 3.00 per km');
check(trend.totalSpend === 10500 && trend.totalDistance === 1500, 'the totals sum the six buckets');
check(trend.averageCostPerKm === 7, 'the six-month average is spend ÷ distance (10,500 ÷ 1,500 = 7)');
check(trend.peakCostPerKm === 5, 'the peak is the highest priced month (5.00, not the six-month average)');
check(trend.months[0].costPerKm === null && trend.months[0].spend === 0, 'an empty month is 0 spend and null cost');

console.log('\n--- Test 7: one distance engine (no formula drift) ---');
const windowKm = distanceInWindow(trendExpenses, { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) });
check(windowKm === sep.distance, 'the buckets call the SAME distanceInWindow the reports use');
check(distanceInWindow([], {}) === 0, 'an empty ledger is 0 km (never NaN)');

console.log('\n--- Test 8: SVG chart geometry ---');
const chart = buildCostPerKmChart(trend);
check(chart.points.length === 2, 'only priced months become points (null months are skipped)');
check(chart.maxValue === 5, 'the y-scale uses the highest cost per km');
check(chart.points[0].y === chart.padding, 'the highest month maps to the top of the plot');
check(chart.points[1].y > chart.points[0].y, 'a lower cost per km sits lower on the chart (3 < 5)');
check(chart.points.every((point) => point.x >= chart.padding && point.x <= chart.width - chart.padding), 'every point stays inside the plot area');
check(/^\d+(\.\d+)?,\d+(\.\d+)? \d+(\.\d+)?,\d+(\.\d+)?$/.test(chart.polyline), 'the polyline is a valid SVG points string');
const emptyChart = buildCostPerKmChart({ months: [{ costPerKm: null }, { costPerKm: null }] });
check(emptyChart.points.length === 0 && emptyChart.polyline === '' && emptyChart.maxValue === 0, 'an empty trend renders no points (honest empty state)');

console.log('\n--- Test 9: the lifespans are env-tunable ---');
process.env.TYRE_LIFESPAN_KM = '40000';
check(getTyreLifespanKm() === 40000 && getTyreReplaceSoonKm() === 40000, 'a 40,000 km lifespan clamps Replace Soon to 40,000');
const tuned = buildTyreWearRows({ vehicles: [vehicle()], expenses: [tyre(95000)] });
check(tuned[0].remainingPct === 38 && tuned[0].replaceSoon === false, '25,000 of 40,000 km = ~38% remaining (Replace Soon only at 40,000)');
if (PREV_LIFESPAN === undefined) delete process.env.TYRE_LIFESPAN_KM; else process.env.TYRE_LIFESPAN_KM = PREV_LIFESPAN;

console.log('\n🎉 ' + passed + ' vehicle-analytics assertions passed.');
console.log('Stateless suite: pure math only; nothing was written to the database.');

