/**
 * Saka Fleet — Asset metric registry tests (v1.28.9)
 * --------------------------------------------------
 * Proves every asset kind Saka supports declares a complete metric profile and
 * that reports, summaries, bespoke-report menus, the prompt glossary and the QA
 * facts all read that one registry (no odometer forced on a generator, no litres
 * invented for an EV).
 *
 * Run: node test_asset_metrics.js
 */

import assert from 'assert';
import { ASSET_KINDS } from './src/services/countryBucket.js';
import {
  ASSET_METRIC_PROFILES,
  METRIC_IDS,
  getAssetMetricProfile,
  metricsForAssetKind,
  primaryMeterForAssetKind,
  fuelTypesForAssetKind,
  formatMetricValue,
  assetMetricSummaryLines,
  buildMetricGlossaryBlock,
  getMetricCoverage,
  isElectricFuel
} from './src/services/assetMetrics.js';
import { metricsForAccess } from './src/services/reportMetrics.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

console.log('=== SAKA FLEET — ASSET METRIC REGISTRY (v1.28.9) ===\n');

console.log('--- Test 1: every asset kind is populated ---');
const coverage = getMetricCoverage();
check(coverage.kinds === 8 && Object.keys(ASSET_KINDS).length === 8, 'Saka still supports exactly 8 asset kinds');
check(coverage.covered === coverage.kinds && coverage.missing.length === 0, 'Every asset kind has a metric profile');
check(coverage.metricCount === METRIC_IDS.length && coverage.metricCount >= 10, 'Metric catalog is populated');
for (const [kind, profile] of Object.entries(ASSET_METRIC_PROFILES)) {
  check(['odometer', 'hours'].includes(profile.primaryMeter), `${kind}: primary meter is odometer or hours`);
  check(Array.isArray(profile.metrics) && profile.metrics.length >= 4, `${kind}: at least four metrics declared`);
  check(profile.metrics.every((metric) => metric.canonicalUnit && metric.units?.metric && metric.units?.imperial), `${kind}: every metric has canonical + display units`);
  check(profile.metrics.every((metric) => Array.isArray(metric.flows) && metric.flows.length > 0), `${kind}: every metric declares the flows it serves`);
}

console.log('\n--- Test 2: kind-specific measurement rules ---');
check(primaryMeterForAssetKind('generator') === 'hours', 'Generators measure engine hours, not distance');
check(primaryMeterForAssetKind('vehicle') === 'odometer', 'Cars measure the odometer');
check(getAssetMetricProfile('generator').distance === 'never', 'A generator can never report distance');
check(metricsForAssetKind('generator').some((metric) => metric.id === 'energy_output'), 'Generators report kWh output');
check(!metricsForAssetKind('generator').some((metric) => metric.id === 'fuel_economy'), 'Generators use fuel/hour, not km/L');
check(metricsForAssetKind('truck').some((metric) => metric.id === 'trips'), 'Trucks and buses track trips/jobs');
check(fuelTypesForAssetKind('vehicle').includes('Electric'), 'Road vehicles accept Electric');
check(!fuelTypesForAssetKind('generator').includes('Electric'), 'Generators never offer Electric fuel');

console.log('\n--- Test 3: electric vehicles swap litres for kWh ---');
const evMetrics = metricsForAssetKind('vehicle', { fuelType: 'Electric' }).map((metric) => metric.id);
check(evMetrics.includes('energy_volume') && evMetrics.includes('energy_economy'), 'EV metrics include kWh and km/kWh');
check(!evMetrics.includes('fuel_volume') && !evMetrics.includes('fuel_economy'), 'EV metrics exclude litres and km/L');
check(isElectricFuel('electric') && isElectricFuel('EV'), 'Electric fuel detection is tolerant');
check(!isElectricFuel('Diesel'), 'Diesel is never treated as electric');

console.log('\n--- Test 4: metric formatting (metric ↔ imperial) ---');
check(formatMetricValue({ metricId: 'distance', value: 100 }) === '100 km', 'Distance formats in km');
check(formatMetricValue({ metricId: 'distance', value: 100, unitSystem: 'imperial' }) === '62.1 mi', 'Distance converts to miles');
check(formatMetricValue({ metricId: 'fuel_volume', value: 100 }) === '100 L', 'Fuel formats in litres');
check(formatMetricValue({ metricId: 'fuel_volume', value: 100, unitSystem: 'imperial' }) === '26.4 gal', 'Fuel converts to gallons');
check(formatMetricValue({ metricId: 'fuel_economy', value: 10 }) === '10.00 km/L', 'Economy formats in km/L');
check(formatMetricValue({ metricId: 'fuel_economy', value: 10, unitSystem: 'imperial' }) === '23.52 MPG', 'Economy converts to MPG');
check(formatMetricValue({ metricId: 'fuel_burn_per_hour', value: 10 }) === '10.00 L/h', 'Hours-led burn formats in L/h');
check(formatMetricValue({ metricId: 'fuel_burn_per_hour', value: 10, unitSystem: 'imperial' }) === '2.64 gal/h', 'Burn converts to gal/h');
check(formatMetricValue({ metricId: 'energy_economy', value: 5, unitSystem: 'imperial' }) === '3.11 mi/kWh', 'Energy efficiency converts to mi/kWh');
check(formatMetricValue({ metricId: 'engine_hours', value: 36 }) === '36 h', 'Operating hours format in hours');
check(formatMetricValue({ metricId: 'earnings', value: 1500, currency: 'KES' }).includes('KES'), 'Money uses the local currency');
check(formatMetricValue({ metricId: 'distance', value: null }) === '—', 'Missing values never break formatting');

console.log('\n--- Test 5: summaries use the primary meter ---');
const generatorLines = assetMetricSummaryLines({
  assetKind: 'generator',
  vehicle: { operating_hours: 36, fuel_type: 'Diesel', current_mileage: 0 },
  unitSystem: 'metric'
});
check(generatorLines[0].label === 'Engine hours' && generatorLines[0].value === '36 h', 'A generator summary shows engine hours first');
check(!generatorLines.some((line) => line.label === 'Odometer'), 'A generator summary never invents an odometer');
const truckLines = assetMetricSummaryLines({ assetKind: 'truck', vehicle: { current_mileage: 12450, fuel_type: 'Diesel' } });
check(truckLines[0].label === 'Odometer' && truckLines[0].value === '12,450 km', 'A truck summary shows the odometer in km');
const evLines = assetMetricSummaryLines({ assetKind: 'vehicle', vehicle: { current_mileage: 21000, fuel_type: 'Electric', kwh_charged: 320 } });
check(evLines.some((line) => line.label === 'Energy charged' && line.value === '320 kWh'), 'An EV summary shows energy charged');
check(!evLines.some((line) => line.label === 'Fuel type'), 'An EV summary never claims a fuel type');

console.log('\n--- Test 6: report menus + prompt glossary use the registry ---');
const generatorMenu = metricsForAccess({ lane: 'owner', assetKinds: ['generator'] }).map((metric) => metric.id);
check(!generatorMenu.includes('distance'), 'A generator-only bespoke menu hides distance');
check(generatorMenu.includes('operating_hours') && generatorMenu.includes('energy_kwh'), 'It offers hours and kWh instead');
const roadMenu = metricsForAccess({ lane: 'owner', assetKinds: ['vehicle'] }).map((metric) => metric.id);
check(roadMenu.includes('distance') && roadMenu.includes('fuel_litres'), 'A vehicle menu keeps distance and litres');
const glossary = buildMetricGlossaryBlock();
check(Object.keys(ASSET_METRIC_PROFILES).every((kind) => glossary.includes(kind)), 'Glossary lists every asset kind');
check(/never force an odometer/i.test(glossary), 'Glossary forbids odometer-on-hours mistakes');
check(/km\/kWh/.test(glossary) && /litres/i.test(glossary), 'Glossary states the EV rule and canonical units');

console.log(`\n🎉 ${passed} asset-metric assertions passed.`);
