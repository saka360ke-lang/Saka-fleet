/**
 * Saka Fleet — Expense Catalog test suite (v1.30.0, stateless)
 * -----------------------------------------------------------
 * Proves the exhaustive expense registry resolves the real phrases users sent
 * (puncture, parts, filters, oil change, parking, tolls…), maps them to report
 * categories/ledger badges, adapts the quiz menu to the asset kind, and never
 * mistakes the trigger word "expense" for a type.
 *
 * Run: node test_expense_catalog.js
 */

import assert from 'assert';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_TYPES,
  expenseTypeChoices,
  expenseTypeMenu,
  resolveExpenseType,
  normalizeExpenseType,
  hasExpenseTypeMarker,
  expenseCategoryOf,
  expenseCategoryBadge,
  expenseCategoryLabel,
  expenseTypesForAssetKind
} from './src/services/expenseCatalog.js';
import { getFlowDefinition } from './src/services/quizEngine.js';
import { buildLedgerGroups } from './src/services/reportLedger.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const COUNTRY = { country: 'Kenya', country_code: 'KE', currency: 'KES', locale: 'en-KE', default_units: 'metric', default_language: 'English' };
const LEDGER_CTX = { currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' };
const VEHICLE = { id: 'v1', plate_number: 'KAS 628T', owner_id: 'p1', current_mileage: 50350, odometer_reading: 50350, asset_type: 'vehicle', fuel_type: 'Diesel' };
const PROFILE = { id: 'p1', unit_system: 'metric', preferred_language: 'English' };

console.log('=== SAKA FLEET — EXPENSE CATALOG (v1.30.0) ===\n');

console.log('--- Test 1: registry integrity ---');
check(EXPENSE_TYPES.length >= 19, `The catalog covers all asset families (${EXPENSE_TYPES.length} types)`);
check(new Set(EXPENSE_TYPES.map((type) => type.value)).size === EXPENSE_TYPES.length, 'Canonical type values are unique');
check(EXPENSE_TYPES.every((type) => EXPENSE_CATEGORIES[type.category]), 'Every type maps to a declared category');
check(EXPENSE_TYPES.every((type) => Array.isArray(type.aliases) && type.aliases.length > 0), 'Every type declares free-text aliases');
check(EXPENSE_CATEGORY_KEYS.length >= 18, `Report categories are exhaustive (${EXPENSE_CATEGORY_KEYS.length})`);
for (const legacy of ['Fuel', 'Maintenance', 'Insurance', 'Tolls', 'Other']) {
  check(EXPENSE_TYPES.some((type) => type.value === legacy), `Legacy stored value stays canonical: ${legacy}`);
}

console.log('\n--- Test 2: real chat phrases resolve correctly ---');
const liveCases = [
  ['Parts', 'Parts'],
  ['I repaired a puncture in Nanyuki. Front left tyre. Cost me 300kes.', 'Tyres'],
  ['Remind to Change fuel filter and air filter @370000km', 'Parts'],
  ['Log an oil change reminder. To happen @370,000km', 'Maintenance'],
  ['Topped up fuel; 1000kes @227kes per liter, @367365km', 'Fuel'],
  ['Diesel Current odometer 367359km', 'Fuel'],
  ['Service', 'Maintenance'],
  ['Engine oil', 'Maintenance'],
  ['Engine repair', 'Repairs'],
  ['Brake pads', 'Parts'],
  ['Brake fluid', 'Consumables'],
  ['Hydraulic oil', 'Consumables'],
  ['car wash', 'Washing'],
  ['parking fee', 'Parking'],
  ['toll fees', 'Tolls'],
  ['speeding fine', 'Fines'],
  ['annual insurance renewal', 'Insurance'],
  ['road licence', 'Insurance'],
  ['mooring fees', 'Mooring & Berthing'],
  ['crew salary', 'Crew Wages'],
  ['tyre rotation', 'Tyres'],
  ['windshield replacement', 'Bodywork & Paint'],
  ['tracking subscription', 'Subscriptions'],
  ['tow truck', 'Towing & Recovery'],
  ['Other', 'Other']
];
for (const [phrase, expected] of liveCases) {
  check(resolveExpenseType(phrase) === expected, `"${phrase.slice(0, 52)}" → ${expected}`);
}

console.log('\n--- Test 3: longest-alias precedence ---');
check(resolveExpenseType('fuel filter') === 'Parts', '"fuel filter" is Parts, not Fuel');
check(resolveExpenseType('oil change') === 'Maintenance', '"oil change" is Maintenance, not Consumables');
check(resolveExpenseType('engine oil') === 'Maintenance', '"engine oil" is Maintenance, not Repairs');
check(resolveExpenseType('brake pads') === 'Parts' && resolveExpenseType('brake fluid') === 'Consumables', 'Brake parts vs brake fluid split correctly');
check(resolveExpenseType('road licence') === 'Insurance', '"road licence" is compliance, not tolls');
check(hasExpenseTypeMarker('log expense') === false, 'The trigger word "expense" is never mistaken for a type');

console.log('\n--- Test 4: categories, labels and badges ---');
check(expenseCategoryOf('Fuel') === 'fuel' && expenseCategoryBadge('fuel') === 'FUEL', 'Fuel → FUEL badge');
check(expenseCategoryOf('Tyres') === 'tyres' && expenseCategoryBadge('tyres') === 'TYRES', 'Tyres → TYRES badge');
check(expenseCategoryOf('Insurance') === 'compliance' && expenseCategoryBadge('compliance') === 'COMPLIANCE', 'Insurance → COMPLIANCE badge');
check(expenseCategoryOf('puncture') === 'tyres', 'Free-text puncture classifies as tyres');
check(expenseCategoryOf('Expense') === 'other', 'Unknown/legacy "Expense" falls back to other');
check(expenseCategoryLabel('fines') === 'Fines & penalties', 'Category labels are human-readable');
check(normalizeExpenseType(null) === 'Other' && normalizeExpenseType('puncture') === 'Tyres', 'normalizeExpenseType never returns null');

console.log('\n--- Test 5: asset-kind menus ---');
const vehicleMenu = expenseTypeChoices('vehicle', { fuelType: 'Diesel' }).map((choice) => choice.value);
const evMenu = expenseTypeChoices('vehicle', { fuelType: 'Electric' }).map((choice) => choice.value);
const generatorMenu = expenseTypeChoices('generator').map((choice) => choice.value);
const boatMenu = expenseTypeChoices('watercraft').map((choice) => choice.value);
check(vehicleMenu.length <= 8, 'Road menu stays WhatsApp-short (max 8)');
check(vehicleMenu.includes('Fuel') && vehicleMenu.includes('Tyres') && vehicleMenu.includes('Parking'), 'Road menu includes fuel, tyres and parking');
check(!vehicleMenu.includes('Consumables') && !vehicleMenu.includes('Crew Wages'), 'Road menu excludes machine-only types');
check(evMenu.includes('Charging') && !evMenu.includes('Fuel'), 'EV menu swaps Fuel for Charging');
check(generatorMenu.includes('Consumables') && generatorMenu.includes('Crew Wages'), 'Generator menu includes consumables and crew wages');
check(!generatorMenu.includes('Tyres') && !generatorMenu.includes('Parking'), 'Generator menu excludes road-only types');
check(boatMenu.includes('Consumables'), 'Watercraft menu includes machine consumables');
check(expenseTypeMenu('vehicle').includes('Fuel'), 'Menu copy is available for prompts');
check(expenseTypesForAssetKind('watercraft').includes('Mooring & Berthing'), 'Watercraft exposes mooring/berthing by free text');

console.log('\n--- Test 6: quiz + ledger integration ---');
const ctx = { profile: PROFILE, vehicles: [VEHICLE], countryInfo: COUNTRY, language: 'English' };
const def = getFlowDefinition('log_expense', ctx);
const typeField = def.fields.find((field) => field.key === 'expense_type');
const odoField = def.fields.find((field) => field.key === 'odometer_reading');
check(typeField.parse('Parts', ctx) === 'Parts', 'The quiz accepts the live "Parts" answer');
check(typeField.parse('puncture', ctx) === 'Tyres', 'The quiz resolves free-text "puncture" to Tyres');
check(typeField.validate('Mooring & Berthing', ctx).ok === true, 'Free-text catalog types validate even outside the menu');
check(typeField.validate('Other', ctx).ok === true, 'The Other escape validates');
check(!/fill-up/i.test(odoField.label), 'The odometer label no longer says "fill-up" for every type');
check(/fill-up, service or repair/i.test(odoField.hint), 'The odometer hint names fill-up, service and repair');

const ledger = buildLedgerGroups({
  expenses: [{ id: 'e1', vehicle_id: 'v1', expense_type: 'puncture', amount: 300, created_at: '2026-11-01T09:00:00Z' }],
  earnings: [],
  vehicles: [VEHICLE],
  ctx: LEDGER_CTX
});
check(ledger.groups[0].rows[0].kind === 'tyres', 'A puncture expense becomes a tyres ledger row');
check(ledger.groups[0].rows[0].kindLabel === 'TYRES', 'The ledger badge reads TYRES');
check(ledger.totals.expenseTotal === 300, 'Ledger totals still reconcile');

console.log(`\n🎉 ${passed} expense-catalog assertions passed.`);
console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
