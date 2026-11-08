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
  COMPLIANCE_ASSET_TOKENS,
  complianceAssetTokens,
  complianceAssetMatches,
  ASSET_ROLES,
  assetRoleLabel,
  assetRolePlural,
  assetRolePossessive,
  resolveCountryInput,
  getCountryBucket,
  loadCountryBucket,
  buildJurisdictionContext,
  formatCountryRulesReply,
  formatRequiredDocumentsReply,
  formatExampleComplianceReply
} from './src/services/countryBucket.js';
import { resolvePhoneCountryLock, detectCountryFromPhone, regionForCountryCode, COUNTRY_TIMEZONES } from './src/services/globalization.js';
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

  console.log('\n--- Test 1b: compliance tokens + handover roles (v1.86.0) ---');
  const kinds = Object.keys(ASSET_KINDS);
  check(kinds.every((kind) => Array.isArray(COMPLIANCE_ASSET_TOKENS[kind]) && COMPLIANCE_ASSET_TOKENS[kind].length > 0), 'every asset kind carries a compliance token set');
  check(kinds.every((kind) => Object.prototype.hasOwnProperty.call(ASSET_ROLES, kind)), 'every asset kind carries a handover role');
  check(complianceAssetMatches(['PSV', 'BUS'], { assetKind: 'bus', assetType: 'ICE' }) === true, 'a bus resolves the PSV token through its kind');
  check(complianceAssetMatches(['TRUCK', 'HGV'], { assetKind: 'truck', assetType: 'ICE' }) === true, 'a truck resolves the TRUCK/HGV tokens through its kind');
  check(complianceAssetMatches(['PSV', 'BUS', 'TRUCK'], { assetKind: 'vehicle', assetType: 'ICE' }) === false, 'a car never matches a PSV/TRUCK token');
  check(complianceAssetMatches(['EXCAVATOR'], { assetKind: 'machinery' }) === true, 'plant resolves an excavator-scoped item');
  check(complianceAssetMatches(null, { assetKind: 'generator' }) === true, 'an unscoped item applies to every kind');
  check(complianceAssetMatches(['PSV'], {}) === false, 'a scoped item never matches an unknown asset');
  check(complianceAssetTokens({ assetKind: 'truck', assetType: 'HGV' }).has('HGV') && complianceAssetTokens({ assetKind: 'truck' }).has('TRUCK'), 'kind tokens and the literal asset_type both count');
  check(assetRoleLabel('vehicle') === 'Driver' && assetRoleLabel('truck') === 'Driver' && assetRoleLabel('bus') === 'Driver', 'road assets keep a Driver');
  check(assetRoleLabel('motorcycle') === 'Rider', 'a boda has a Rider');
  check(assetRoleLabel('generator') === 'Operator' && assetRoleLabel('machinery') === 'Operator' && assetRoleLabel('heavy_equipment') === 'Operator', 'machines have an Operator');
  check(assetRoleLabel('watercraft') === 'Captain', 'a boat has a Captain');
  check(assetRolePlural('motorcycle') === 'Riders' && assetRolePlural('watercraft') === 'Captains', 'plural roles follow the kind');
  check(assetRolePossessive('generator') === "Operator's" && assetRolePossessive(null) === "Driver's", 'possessive roles are safe by default');

  console.log('\n--- Test 2: country resolution ---');
  check(resolveCountryInput('Kenya')?.country_code === 'KE', 'country names resolve');
  check(resolveCountryInput('ke')?.country === 'Kenya', 'ISO codes resolve');
  check(resolveCountryInput('+254')?.country_code === 'KE', 'phone prefixes resolve');
  check(resolveCountryInput('Narnia') === null, 'unknown countries are rejected');

  console.log('\n--- Test 2b: phone-primary country lock (v1.59.0) ---');
  check(resolvePhoneCountryLock('+254711000001')?.country_code === 'KE', 'a Kenyan number locks Kenya');
  check(resolvePhoneCountryLock('+12025550123')?.country_code === 'US', 'a US number locks the United States');
  check(resolvePhoneCountryLock('+447700900123')?.country_code === 'GB', 'a UK number locks the United Kingdom');
  check(resolvePhoneCountryLock('+999700000000') === null, 'an unresolvable number never locks a country');
  check(resolvePhoneCountryLock(null) === null, 'a missing number never locks a country');
  check(resolvePhoneCountryLock('+254711000001')?.unit_system === 'metric', 'the lock carries the country unit system');
  check(resolvePhoneCountryLock('+12025550123')?.unit_system === 'imperial', 'the US lock is imperial');

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

  console.log('\n--- Phase 24 (v1.85.0): Canada, Belgium and the equipment exemption ---');
const canada = resolveCountryInput('Canada');
check(Boolean(canada) && canada.country_code === 'CA' && canada.currency === 'CAD' && canada.locale === 'en-CA',
  'the explicit "Canada" choice resolves CAD / en-CA');
const canadaCode = resolveCountryInput('ca');
check(Boolean(canadaCode) && canadaCode.country_code === 'CA', 'the CA code resolves through the extra-region table');
const belgium = resolveCountryInput('Belgium');
check(Boolean(belgium) && belgium.country_code === 'BE' && belgium.currency === 'EUR' && belgium.locale === 'nl-BE',
  'Belgium resolves EUR / nl-BE');
const bePhone = detectCountryFromPhone('+32470123456');
check(bePhone.country_code === 'BE' && bePhone.currency === 'EUR', '+32 numbers resolve Belgium from the phone');
const usPhone = detectCountryFromPhone('+14155550123');
check(usPhone.country_code === 'US', 'the +1 default stays the United States (Canada needs the explicit choice)');
check(COUNTRY_TIMEZONES.BE === 'Europe/Brussels' && COUNTRY_TIMEZONES.CA === 'America/Toronto',
  'CA and BE carry their IANA timezones');
check(regionForCountryCode('CA').currency === 'CAD' && regionForCountryCode('BE').currency === 'EUR',
  'regionForCountryCode supplies CAD and EUR facts for stored profiles');
const keGenerator = getCountryBucket({ countryCode: 'KE', assetKind: 'generator' });
const generatorKeys = keGenerator.rules.map((entry) => entry.key);
check(!generatorKeys.includes('vehicle_inspection') && !generatorKeys.includes('vehicle_insurance'),
  'a Kenyan generator is NEVER shown NTSA road rules');
check(generatorKeys.includes('equipment_insurance'), 'a generator gets the lighter equipment-insurance hint instead');
const keCar = getCountryBucket({ countryCode: 'KE', assetKind: 'vehicle' });
check(keCar.rules.some((entry) => entry.key === 'vehicle_inspection') && keCar.rules.some((entry) => entry.key === 'equipment_insurance') === false,
  'road assets keep NTSA inspection and never the equipment hint');

console.log(`\n🎉 ALL COUNTRY BUCKET TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: bundled knowledgebase only, so no cleanup is required.');
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

