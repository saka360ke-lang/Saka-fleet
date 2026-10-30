import assert from 'assert';
import {
  CUSTOM_METRICS,
  CUSTOM_METRIC_CATEGORIES,
  resolveMetricIds,
  metricsForAccess,
  customMetricMenu,
  dateRangeBounds
} from './src/services/reportMetrics.js';
import { buildProReportPdf, getReportAccent, SAKA_PDF_THEME } from './src/services/pdfEngine.js';

/**
 * Saka Fleet — Bespoke metrics + PDF engine tests (v1.18.0). Stateless.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — BESPOKE METRICS & PDF TESTS ===\n');

console.log('--- Test 1: metric registry integrity ---');
check(CUSTOM_METRICS.length >= 12, 'metric catalog is populated');
check(new Set(CUSTOM_METRICS.map((metric) => metric.id)).size === CUSTOM_METRICS.length, 'metric ids are unique');
check(CUSTOM_METRICS.every((metric) => ['owner', 'both'].includes(metric.access)), 'every metric declares its access lane');
check(CUSTOM_METRICS.every((metric) => ['money', 'litres', 'economy', 'number', 'text'].includes(metric.kind)), 'every metric declares a formatter kind');
check(CUSTOM_METRIC_CATEGORIES.includes('Financial') && CUSTOM_METRIC_CATEGORIES.includes('Compliance'), 'categories are derived correctly');

console.log('--- Test 2: natural-language metric resolution ---');
const resolved = resolveMetricIds('custom report: fuel economy, total spend and distance for last 3 months');
check(resolved.includes('fuel_economy') && resolved.includes('total_spend') && resolved.includes('distance'), 'metrics resolved from one sentence');
check(resolveMetricIds('earnings and profit').includes('net_profit'), 'profit alias resolves');
check(resolveMetricIds('nothing relevant here').length === 0, 'unknown text resolves to no metrics');
check(resolveMetricIds('').length === 0, 'empty input is safe');

console.log('--- Test 3: driver-safe metric filtering ---');
const driverMetrics = metricsForAccess({ lane: 'driver' }).map((metric) => metric.id);
check(!driverMetrics.includes('earnings') && !driverMetrics.includes('net_profit') && !driverMetrics.includes('total_spend'), 'driver lane excludes owner financials');
check(driverMetrics.includes('fuel_economy') && driverMetrics.includes('distance'), 'driver lane keeps operational metrics');
const ownerMetrics = metricsForAccess({ lane: 'owner' }).map((metric) => metric.id);
check(ownerMetrics.includes('net_profit') && ownerMetrics.includes('earnings'), 'owner lane keeps financials');
const menu = customMetricMenu({ lane: 'driver' });
check(menu.length > 0 && !menu.includes('Net profit'), 'menu is lane-aware');

console.log('--- Test 4: date range bounds ---');
const now = new Date('2026-10-30T12:00:00.000Z');
check(dateRangeBounds('this_month', now).from.startsWith('2026-10-01'), 'this month starts on the 1st');
check(dateRangeBounds('last_3_months', now).from.startsWith('2026-07-30'), 'last 3 months rolls back three months');
check(dateRangeBounds('this_year', now).from.startsWith('2026-01-01'), 'this year starts in January');
check(dateRangeBounds('this_year', now).label === 'This year', 'range label is human readable');

console.log('--- Test 5: accents ---');
check(getReportAccent('financial') === SAKA_PDF_THEME.accents.financial, 'report accents resolve');
check(getReportAccent('unknown') === SAKA_PDF_THEME.accents.default, 'unknown types fall back safely');

console.log('--- Test 6: PDF engine renders a real document ---');
const sampleReport = {
  title: 'Fleet Financial Report',
  subtitle: 'A beautiful summary of your fleet',
  reportType: 'financial',
  periodLabel: 'Last 3 months',
  owner: { name: 'Jane Owner', email: 'jane@example.com', phone: '+254700000000', plan: 'Solo Pro', language: 'English' },
  drivers: [{ name: 'Brian Driver', plate: 'KDA 123A', licenceLabel: 'PSV Badge', status: 'active' }],
  kpis: [
    { label: 'Total spend', value: '$12,400', hint: 'operating expenses' },
    { label: 'Earnings', value: '$18,200', hint: 'recorded revenue' },
    { label: 'Net', value: '$5,800', hint: 'earnings − spend' },
    { label: 'Fuel economy', value: '11.25 km/L', hint: 'full tank segments' }
  ],
  charts: [
    { type: 'donut', title: 'Spend by category', totalLabel: 'spend', series: [{ label: 'Fuel', value: 7000 }, { label: 'Maintenance', value: 3000 }, { label: 'Other', value: 2400 }] },
    { type: 'line', title: 'Fuel economy trend', series: [{ label: 'Sep', value: 10.4 }, { label: 'Oct', value: 11.25 }, { label: 'Nov', value: 11.9 }] },
    { type: 'bar', title: 'Monthly spend', series: [{ label: 'Sep', value: 3200 }, { label: 'Oct', value: 4100 }, { label: 'Nov', value: 5100 }] }
  ],
  tables: [{
    title: 'Per-vehicle performance',
    currency: 'USD',
    columns: [
      { key: 'plate', label: 'Vehicle', width: 1.2 },
      { key: 'spend', label: 'Spend', width: 1, type: 'money', align: 'right' },
      { key: 'status', label: 'Status', width: 1, type: 'status' }
    ],
    rows: [
      { plate: 'KDA 123A', spend: 7200, status: 'active' },
      { plate: 'KBC 456B', spend: 3100, status: 'due this month' }
    ]
  }],
  sections: [{ title: 'Owner & drivers', rows: [{ label: 'Owner', value: 'Jane Owner' }, { label: 'Driver', value: 'Brian Driver (KDA 123A)' }] }],
  notes: ['Engine-calculated. Never estimated silently.']
};

const pdfBuffer = await buildProReportPdf(sampleReport);
check(Buffer.isBuffer(pdfBuffer), 'PDF engine returns a buffer');
check(pdfBuffer.length > 4000, `PDF has real content (${pdfBuffer.length} bytes)`);
check(pdfBuffer.subarray(0, 5).toString() === '%PDF-', 'valid PDF header');
check(pdfBuffer.includes(Buffer.from('/Type /Page')), 'PDF contains page objects');
check((pdfBuffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 2, 'cover + content pages exist');

const minimal = await buildProReportPdf({ title: 'Empty report', reportType: 'fleet' });
check(Buffer.isBuffer(minimal) && minimal.length > 1000, 'minimal report still renders (no sections needed)');

console.log(`\n🎉 ${passed} bespoke-metrics & PDF assertions passed.`);

