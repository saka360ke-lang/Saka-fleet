import assert from 'assert';
import {
  ASSET_KINDS,
  COUNTRY_KB,
  COUNTRY_KB_VERSION,
  JURISDICTION_DISCLAIMER,
  normalizeAssetKind,
  detectAssetKind,
  requiresPlate,
  requiresVin,
  meterForAssetKind,
  assetDisplayName,
  resolveCountryInput,
  getCountryBucket,
  loadCountryBucket,
  buildJurisdictionContext,
  formatCountryRulesReply,
  formatRequiredDocumentsReply,
  formatExampleComplianceReply
} from './src/services/countryBucket.js';
import { getFlowDefinition } from './src/services/quizEngine.js';

/**
 * Saka Fleet — Country Bucket suite (v1.21.0).
 * Stateless: pure functions + bundled knowledgebase only, no DB writes.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const baseCtx = {
  countryInfo: { country: 'Kenya', country_code: 'KE', locale: 'en-KE', currency: 'KES', plate_example: 'KDA 123A' },
  profile: { id: 'p1', country_code: 'KE' },
  vehicles: [],
  activeVehicle: null,
  language: 'English',
  intent: 'REGISTER_VEHICLE',
  aiExtracted: {},
  messageText: ''
};

async function run() {
  console.log('=== SAKA FLEET — COUNTRY BUCKET TESTS (v1.21.0) ===\n');

  console.log('--- Test 1: asset kinds & identity tracks ---');
  check(normalizeAssetKind('Car') === 'vehicle', 'cars map to the vehicle kind');
  check(normalizeAssetKind('generator') === 'generator', 'generators are first-class');
  check(normalizeAssetKind('EXCAVATOR') === 'heavy_equipment', 'asset_type EXCAVATOR maps to heavy equipment');
  check(normalizeAssetKind('bus') === 'bus', 'buses keep their own kind');
  check(normalizeAssetKind(null) === 'vehicle', 'missing kind defaults safely to vehicle');
  check(detectAssetKind('I have a 5kVA generator') === 'generator', 'free-text generator detection');
  check(detectAssetKind('my boda') === 'motorcycle', 'free-text motorcycle detection');
  check(requiresPlate('vehicle') === true && requiresPlate('generator') === false, 'only road assets need a plate');
  check(requiresVin('motorcycle') === true && requiresVin('machinery') === false, 'VIN is road-asset only');
  check(meterForAssetKind('generator') === 'hours' && meterForAssetKind('truck') === 'odometer', 'meters follow the asset kind');
  check(assetDisplayName({ plate_number: 'KDA 123A' }) === 'KDA 123A', 'plate is the display name for road assets');
  check(assetDisplayName({ make_model: 'Honda 5.5kVA', serial_number: 'EK-8831', asset_kind: 'generator' }) === 'Honda 5.5kVA (SN EK-8831)', 'serial becomes the display name for equipment');
  check(Object.keys(ASSET_KINDS).length === 8, 'eight asset kinds are registered');

  console.log('\n--- Test 2: country resolution ---');
  check(resolveCountryInput('Kenya')?.country_code === 'KE', 'country names resolve');
  check(resolveCountryInput('ke')?.country === 'Kenya', 'ISO codes resolve');
  check(resolveCountryInput('+254')?.country_code === 'KE', 'phone prefixes resolve');
  check(resolveCountryInput('Narnia') === null, 'unknown countries are rejected');

  console.log('\n--- Test 3: country buckets ---');
  const kenyaCar = getCountryBucket({ countryCode: 'KE', assetKind: 'vehicle' });
  check(kenyaCar.country === 'Kenya' && kenyaCar.authority.includes('NTSA'), 'Kenya bucket carries the authority');
  check(kenyaCar.required.some((r) => r.key === 'vehicle_insurance'), 'insurance is mandatory');
  check(kenyaCar.required.some((r) => r.key === 'driver_licence'), 'driver licence is mandatory');
  check(!kenyaCar.rules.some((r) => r.key === 'speed_limiter'), 'speed limiter is not asked for private cars');

  const kenyaBus = getCountryBucket({ countryCode: 'KE', assetKind: 'bus' });
  check(kenyaBus.rules.some((r) => r.key === 'speed_limiter'), 'speed limiter applies to buses');
  check(kenyaBus.rules.some((r) => r.key === 'psv_badge'), 'PSV badge applies to buses');

  const kenyaGenerator = getCountryBucket({ countryCode: 'KE', assetKind: 'generator' });
  check(kenyaGenerator.assetLabel === 'Generator', 'the bucket names the asset label');
  check(!kenyaGenerator.rules.some((r) => r.key === 'psv_badge'), 'driver badges never leak into generator guidance');
  check(kenyaGenerator.meter === 'hours', 'generator bucket uses the hour meter');

  const unknown = getCountryBucket({ countryCode: 'ZZ', assetKind: 'vehicle' });
  check(unknown.fallback === true && unknown.rules.length > 0, 'unknown countries fall back to the global bundle');
  check(Object.keys(COUNTRY_KB).length >= 14, 'at least 14 country bundles ship in code');
  check(COUNTRY_KB_VERSION.startsWith('2026.'), 'knowledgebase is versioned');

  console.log('\n--- Test 4: superadmin overrides ---');
  const overridden = getCountryBucket({
    countryCode: 'KE',
    assetKind: 'vehicle',
    overrides: [{ country_code: 'KE', rule_key: 'vehicle_insurance', title: 'Insurance (override)', summary: 'Updated rule', required: true, is_active: true }]
  });
  check(overridden.rules.find((r) => r.key === 'vehicle_insurance')?.title === 'Insurance (override)', 'active overrides replace bundled rules');
  const inactive = getCountryBucket({
    countryCode: 'KE',
    assetKind: 'vehicle',
    overrides: [{ country_code: 'KE', rule_key: 'vehicle_insurance', title: 'Ignored', is_active: false }]
  });
  check(inactive.rules.find((r) => r.key === 'vehicle_insurance')?.title === 'Motor insurance', 'inactive overrides are ignored');
  const scoped = getCountryBucket({
    countryCode: 'KE',
    assetKind: 'generator',
    overrides: [{ country_code: 'KE', asset_kind: 'bus', rule_key: 'generator_only', title: 'Bus only', is_active: true }]
  });
  check(!scoped.rules.some((r) => r.key === 'generator_only'), 'asset-scoped overrides never leak across kinds');
  const dbless = await loadCountryBucket(null, { countryCode: 'KE', assetKind: 'generator' });
  check(dbless.country === 'Kenya', 'the DB-less loader still returns the bundled bucket');

  console.log('\n--- Test 5: guidance, examples & disclaimers ---');
  const context = buildJurisdictionContext(kenyaCar);
  check(context.includes('NTSA') && context.includes('JURISDICTION CONTEXT'), 'prompt context names the authority');
  check(context.includes('Required documents') && context.includes('Example submissions'), 'prompt context carries requirements + examples');
  check(context.includes('never invent a law'), 'prompt context forbids invented law');

  const rulesReply = formatCountryRulesReply(kenyaCar);
  check(rulesReply.includes('🌍') && rulesReply.includes('Kenya') && rulesReply.includes('NTSA'), 'rules reply is country-scoped');
  check(rulesReply.includes(JURISDICTION_DISCLAIMER), 'rules reply carries the disclaimer');

  const docsReply = formatRequiredDocumentsReply(kenyaCar);
  check(/1\. \*/.test(docsReply) && docsReply.includes('Motor insurance'), 'required-documents reply numbers the list');
  check(docsReply.includes('expires'), 'required-documents reply offers an example submission');

  const example = formatExampleComplianceReply(kenyaCar, { plate: 'KDB 456B' });
  check(example.includes('KDB 456B'), 'example text is personalized with the plate');
  check(example.includes('confirm before saving'), 'example reminds the user nothing saves before confirmation');

  const generatorExample = formatExampleComplianceReply(kenyaGenerator);
  check(generatorExample.includes('Example for Kenya'), 'generator guidance is still country-aware');

  console.log('\n--- Test 6: onboarding collects the asset kind ---');
  const registration = getFlowDefinition('vehicle_registration', baseCtx);
  const fields = registration.fields;
  check(fields[0].key === 'asset_kind', 'asset kind is the first onboarding question');
  const plateField = fields.find((f) => f.key === 'plate_number');
  const serialField = fields.find((f) => f.key === 'serial_number');
  const vinField = fields.find((f) => f.key === 'vin');
  const mileageField = fields.find((f) => f.key === 'current_mileage');
  const hoursField = fields.find((f) => f.key === 'operating_hours');
  check(plateField.when({ asset_kind: 'vehicle' }) === true, 'road assets are asked for a plate');
  check(plateField.when({ asset_kind: 'generator' }) === false, 'generators skip the plate question');
  check(serialField.when({ asset_kind: 'generator' }) === true, 'generators are asked for a serial');
  check(serialField.when({ asset_kind: 'vehicle' }) === false, 'cars skip the serial question');
  check(vinField.when({ asset_kind: 'truck' }) === true, 'road assets are asked for a VIN');
  check(vinField.when({ asset_kind: 'machinery' }) === false, 'machinery skips the VIN');
  check(mileageField.when({ asset_kind: 'vehicle' }) === true, 'road assets use the odometer');
  check(hoursField.when({ asset_kind: 'generator' }) === true, 'generators use the hour meter');
  check(hoursField.when({ asset_kind: 'vehicle' }) === false, 'cars never see the hour-meter question');
  check(fields.find((f) => f.key === 'asset_kind').choices.includes('generator'), 'the asset-kind menu offers generators');

  console.log(`\n🎉 ALL COUNTRY BUCKET TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: bundled knowledgebase only, so no cleanup is required.');
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

