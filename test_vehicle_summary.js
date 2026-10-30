import assert from 'assert';
import { buildVehicleSummary } from './src/services/vehicleSummary.js';
import { buildProReportPdf } from './src/services/pdfEngine.js';

/**
 * Saka Fleet — Vehicle registration summary tests (v1.19.1).
 * No network, no DB: summary assembly + PDF render only.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const vehicle = {
  id: 'veh-1',
  owner_id: 'owner-1',
  plate_number: 'KDA 123A',
  make_model: 'Toyota Hilux',
  yom: 2019,
  fuel_type: 'Diesel',
  transmission: 'Manual',
  color: 'White',
  tire_size: '265/65R17',
  vin: 'AHTFR22G10L123456',
  current_mileage: 367359,
  insurance_expiry: '2026-12-01',
  qr_passbook_token: 'abc123'
};

const kenya = { country_code: 'KE', currency: 'KES', locale: 'en-KE' };

console.log('=== SAKA FLEET — VEHICLE SUMMARY TESTS ===\n');

console.log('--- Test 1: summary text ---');
const summary = await buildVehicleSummary({
  vehicle,
  owner: { full_name: 'Amina Yusuf', email: 'amina@example.com' },
  countryInfo: kenya,
  now: new Date('2026-10-30T09:00:00Z')
});
check(summary.ok === true, 'summary builds without a DB client');
check(summary.text.includes('KDA 123A'), 'plate leads the summary');
check(summary.text.includes('AHTFR22G10L123456'), 'VIN is shown to the owner');
check(summary.text.includes('367,359 km'), 'odometer uses locale formatting with units');
check(/Insurance:\* 32 days left/.test(summary.text), 'insurance countdown is engine-calculated');
check(summary.text.includes('Open reminders') === false, 'empty reminder list stays quiet (no zero-noise line)');

console.log('--- Test 2: PDF payload & render ---');
check(summary.data.title === 'Vehicle Registration Summary', 'PDF carries a plain-language title');
check(summary.data.tables[0].rows.some((row) => row.label === 'Make & model' && row.value === 'Toyota Hilux'), 'specs table is populated');
check(summary.data.sections[0].rows.some((row) => row.value === 'amina@example.com' || row.value === 'Amina Yusuf'), 'people panel names the owner');
const pdf = await buildProReportPdf(summary.data);
check(Buffer.isBuffer(pdf) && pdf.length > 1500, `Saka Pro PDF renders (${pdf.length} bytes)`);
check(pdf.subarray(0, 4).toString() === '%PDF', 'output is a real PDF document');

console.log('--- Test 3: missing data is forgiving ---');
const bare = await buildVehicleSummary({
  vehicle: { id: 'veh-2', owner_id: 'owner-1', plate_number: 'ABC 123', vin: 'VIN0000000000000' },
  owner: null,
  countryInfo: null,
  now: new Date('2026-10-30T09:00:00Z')
});
check(bare.ok === true && bare.text.includes('ABC 123'), 'partial records still produce a summary');
check(bare.text.includes('Not set') === false && bare.data.kpis[1].value === 'Not set', 'missing insurance is labelled Not set in the PDF');
const empty = await buildVehicleSummary({ vehicle: null });
check(empty.ok === false, 'no vehicle returns a safe failure');

console.log(`\n🎉 ${passed} vehicle summary assertions passed.`);
