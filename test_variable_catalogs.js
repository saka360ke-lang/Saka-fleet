/**
 * Saka Fleet — Variable catalogs test suite (v1.31.0, stateless)
 * --------------------------------------------------------------
 * Proves the reminder, earning, compliance and vehicle-attribute vocabularies
 * resolve real phrases, adapt to the asset kind, map to the right compliance
 * categories, and are wired into the quiz and the ledger.
 *
 * Run: node test_variable_catalogs.js
 */

import assert from 'assert';
import {
  REMINDER_TYPES,
  reminderTypeChoices,
  reminderTypeMenu,
  resolveReminderType,
  reminderCategoryOf,
  reminderMeterOf,
  reminderTypesForAssetKind
} from './src/services/reminderCatalog.js';
import {
  EARNING_TYPES,
  earningTypeChoices,
  earningTypeMenu,
  resolveEarningType,
  normalizeEarningType
} from './src/services/earningCatalog.js';
import {
  DRIVER_COMPLIANCE_TYPES,
  driverComplianceChoices,
  resolveDriverComplianceType
} from './src/services/driverComplianceCatalog.js';
import { VEHICLE_COMPLIANCE_CATALOG, resolveVehicleComplianceCatalog, VEHICLE_COMPLIANCE_CATALOG_VERSION } from './src/services/vehicleCompliance.js';
import { REGIONS } from './src/services/globalization.js';
import { getFlowDefinition } from './src/services/quizEngine.js';
import { extractVehicleAttributes } from './sakaAi.js';
import { earningToLedgerRow } from './src/services/reportLedger.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const COUNTRY = { country: 'Kenya', country_code: 'KE', currency: 'KES', locale: 'en-KE', default_units: 'metric', default_language: 'English' };
const VEHICLE = { id: 'v1', plate_number: 'KAS 628T', owner_id: 'p1', current_mileage: 50350, odometer_reading: 50350, asset_type: 'vehicle', fuel_type: 'Diesel' };
const PROFILE = { id: 'p1', unit_system: 'metric', preferred_language: 'English' };
const CTX = { profile: PROFILE, vehicles: [VEHICLE], countryInfo: COUNTRY, language: 'English' };

console.log('=== SAKA FLEET — VARIABLE CATALOGS (v1.31.0) ===\n');

console.log('--- Test 1: reminder registry + real phrases ---');
check(REMINDER_TYPES.length >= 21, `Reminder catalog is exhaustive (${REMINDER_TYPES.length} types)`);
const reminderCases = [
  ['Log an oil change reminder. To happen @370,000km', 'Oil change'],
  ['Remind to Change fuel filter and air filter @370000km', 'Fuel filter'],
  ['Front tyre change reminder', 'Tyres'],
  ['Reminder Change front tyres @369000km', 'Tyres'],
  ['Brake pads in 3000 miles', 'Brake pads'],
  ['hydraulic service in 36 hours', 'Hydraulic service'],
  ['generator service at 890 hours', 'Generator service'],
  ['hull cleaning due next month', 'Hull service'],
  ['Insurance ABC123 expires 2027-05-15', 'Insurance Renewal'],
  ['Inspection due next month', 'Inspection'],
  ['PSL 445566 expires 30 Nov 2026', 'Road Service Licence'],
  ['speed limiter certificate expires in 60 days', 'Permit'],
  ['Road license expires 2027-03-31', 'Road License'],
  ['Driver licence renewal in 14 days', 'Driver License'],
  ['Deadline 15th Dec 2026', 'Deadline']
];
for (const [phrase, expected] of reminderCases) {
  check(resolveReminderType(phrase) === expected, `"${phrase.slice(0, 52)}" → ${expected}`);
}

console.log('\n--- Test 2: reminder categories + meters ---');
check(reminderCategoryOf('Oil change') === 'maintenance', 'Oil change → maintenance');
check(reminderCategoryOf('Fuel filter') === 'maintenance', 'Fuel filter → maintenance');
check(reminderCategoryOf('Insurance Renewal') === 'insurance', 'Insurance → insurance');
check(reminderCategoryOf('Inspection') === 'inspection', 'Inspection → inspection');
check(reminderCategoryOf('Road Service Licence') === 'licensing', 'PSL → licensing');
check(reminderCategoryOf('Permit') === 'permit', 'Permit → permit');
check(reminderCategoryOf('Driver License') === 'driver_license', 'Driver licence → driver_license');
check(reminderMeterOf('Oil change') === 'distance', 'Oil change uses the distance meter');
check(reminderMeterOf('Hydraulic service') === 'hours', 'Hydraulic service uses the hours meter');
check(reminderMeterOf('Insurance Renewal') === 'date', 'Insurance uses the date meter');

console.log('\n--- Test 3: asset-kind reminder menus ---');
const roadMenu = reminderTypeChoices('vehicle').map((choice) => choice.value);
const machineMenu = reminderTypeChoices('machinery').map((choice) => choice.value);
const generatorMenu = reminderTypeChoices('generator').map((choice) => choice.value);
const boatMenu = reminderTypeChoices('watercraft').map((choice) => choice.value);
check(roadMenu.length <= 8 && roadMenu.includes('Other'), 'Road menu stays short and keeps the Other escape');
check(roadMenu.includes('Oil change') && roadMenu.includes('Inspection'), 'Road menu includes oil change and inspection');
check(!roadMenu.includes('Hydraulic service'), 'Road menu excludes machine-only reminders');
check(machineMenu.includes('Hydraulic service') && !machineMenu.includes('Road License'), 'Machinery swaps road licence for hydraulic service');
check(generatorMenu.includes('Generator service') && generatorMenu.includes('Other'), 'Generator menu includes generator service');
check(boatMenu.includes('Hull service'), 'Watercraft menu includes hull service');
check(reminderTypeMenu('vehicle').includes('Insurance Renewal'), 'Reminder menu copy is available for prompts');
check(reminderTypesForAssetKind('watercraft').includes('Engine service'), 'Watercraft exposes engine service');

console.log('\n--- Test 4: earning catalog + real phrases ---');
check(EARNING_TYPES.length === 8, 'Eight canonical earning types');
check(earningTypeChoices().length <= 6, 'Earning menu stays WhatsApp-short (max 6)');
const earningCases = [
  ['matatu fares', 'Trip fares'],
  ['daily takings', 'Daily takings'],
  ['cargo load to Mombasa', 'Cargo & freight'],
  ['vehicle hire for a wedding', 'Vehicle hire'],
  ['generator hire for the event', 'Equipment hire'],
  ['school contract', 'Contract & charter'],
  ['school run', 'Transport service'],
  ['income', 'Other']
];
for (const [phrase, expected] of earningCases) {
  check(resolveEarningType(phrase) === expected, `"${phrase.slice(0, 42)}" → ${expected}`);
}
check(normalizeEarningType('generator hire') === 'Equipment hire', 'normalizeEarningType resolves known values');
check(normalizeEarningType('something unknown') === null, 'Unknown earnings stay null (never invented)');
check(earningTypeMenu().includes('Cargo & freight'), 'Earning menu copy is available for prompts');

console.log('\n--- Test 5: global vehicle compliance catalogs ---');
check(VEHICLE_COMPLIANCE_CATALOG_VERSION === '2026.17.0', 'Compliance catalog version bumped');
for (const region of REGIONS) {
  check(Boolean(VEHICLE_COMPLIANCE_CATALOG[region.country_code]), `Compliance catalog exists for ${region.country_code}`);
}
const kePsv = resolveVehicleComplianceCatalog({ countryCode: 'KE', assetType: 'PSV' });
const keCar = resolveVehicleComplianceCatalog({ countryCode: 'KE', assetType: 'vehicle' });
check(kePsv.items.some((item) => item.type === 'speed_limiter'), 'Kenya PSV catalog includes the speed limiter');
check(!keCar.items.some((item) => item.type === 'speed_limiter'), 'Kenya private-vehicle catalog excludes the speed limiter');
check(resolveVehicleComplianceCatalog({ countryCode: 'MY' }).items.some((item) => item.type === 'puspakom'), 'Malaysia includes Puspakom inspection');
check(resolveVehicleComplianceCatalog({ countryCode: 'DE' }).items.some((item) => item.type === 'tuv'), 'Germany includes TÜV inspection');
check(resolveVehicleComplianceCatalog({ countryCode: 'JP' }).items.some((item) => item.type === 'shaken'), 'Japan includes Shaken inspection');
check(resolveVehicleComplianceCatalog({ countryCode: 'ZZ' }).items.length >= 2, 'Unknown countries fall back to the global catalog');

console.log('\n--- Test 6: driver compliance catalog ---');
check(DRIVER_COMPLIANCE_TYPES.length >= 8, 'Driver compliance registry is populated');
check(resolveDriverComplianceType('PSV badge') === 'psv_badge', 'PSV badge resolves');
check(resolveDriverComplianceType('PDP') === 'pdp', 'PDP resolves');
check(resolveDriverComplianceType('medical certificate') === 'medical_certificate', 'Medical certificate resolves');
const keDriverChoices = driverComplianceChoices({ countryCode: 'KE' }).map((choice) => choice.value);
const globalDriverChoices = driverComplianceChoices({ countryCode: 'US' }).map((choice) => choice.value);
check(keDriverChoices.includes('driving_licence') && keDriverChoices.includes('psv_badge'), 'Kenya driver menu includes licence + PSV badge');
check(globalDriverChoices.includes('operator_card') && !globalDriverChoices.includes('psv_badge'), 'Non-EA driver menu includes the operator card');

console.log('\n--- Test 7: vehicle attribute expansion ---');
const hilux = extractVehicleAttributes('Toyota Hilux double cab, navy, bullbar, tow bar, dashcam');
check(/toyota hilux/i.test(hilux.make_model || ''), 'Brand capture: Toyota Hilux');
check(hilux.color === 'Navy', 'New colours are captured (navy)');
check(/bullbar/i.test(hilux.custom_attributes?.modifications || ''), 'Accessories: bullbar');
check(/tow hitch/i.test(hilux.custom_attributes?.modifications || ''), 'Accessories: tow hitch');
check(/dashcam/i.test(hilux.custom_attributes?.modifications || ''), 'Accessories: dashcam');
const scania = extractVehicleAttributes('Scania R500 truck with trailer');
check(/scania r500/i.test(scania.make_model || ''), 'Truck brands are captured (Scania R500)');
check(/trailer/i.test(scania.custom_attributes?.modifications || ''), 'Accessories: trailer');

console.log('\n--- Test 8: quiz + ledger integration ---');
const reminderDef = getFlowDefinition('set_reminder', CTX);
const reminderField = reminderDef.fields.find((field) => field.key === 'reminder_type');
const dueField = reminderDef.fields.find((field) => field.key === 'due');
check(reminderField.parse('fuel filter', CTX) === 'Fuel filter', 'Quiz resolves "fuel filter"');
check(reminderField.parse('hydraulic service', CTX) === 'Hydraulic service', 'Quiz resolves "hydraulic service"');
check(reminderField.validate('Road Service Licence', CTX).ok === true, 'Free-text reminder types validate outside the menu');
check(/hours/i.test(dueField.hint), 'The due field still accepts dates, distance or hours');

const earningDef = getFlowDefinition('log_earnings', CTX);
const earningField = earningDef.fields.find((field) => field.key === 'earning_type');
check(Boolean(earningField), 'The earnings quiz asks for a type');
check(earningField.optional === true, 'The earning type is optional (skippable)');
check(earningField.parse('generator hire', CTX) === 'Equipment hire', 'Quiz resolves "generator hire"');
check(earningField.parse('matatu fares', CTX) === 'Trip fares', 'Quiz resolves "matatu fares"');

const ledgerRow = earningToLedgerRow(
  { earning_type: 'Cargo & freight', notes: 'Nairobi to Mombasa', revenue_amount: 18000, logged_at: '2026-11-01T09:00:00Z' },
  { ctx: { currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' } }
);
check(ledgerRow.kind === 'earning' && ledgerRow.kindLabel === 'EARNING', 'Earning ledger badge stays EARNING');
check(/Cargo & freight - Nairobi to Mombasa/.test(ledgerRow.description), 'Earning type prefixes the ledger description');
check(ledgerRow.amount === 18000, 'Earning amount is preserved');

console.log(`\n🎉 ${passed} variable-catalog assertions passed.`);
console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
