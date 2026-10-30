/**
 * Saka Fleet — Vehicle vs Driver Compliance separation suite (v1.16.0)
 * --------------------------------------------------------------------
 * Asserts:
 *   1. Vehicles and drivers have SEPARATE catalogs and ledgers.
 *   2. One paragraph can save several vehicle permits at once.
 *   3. Legacy insurance/inspection columns stay in sync + reminders link.
 *
 * Run: node --env-file=.env test_vehicle_compliance.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  resolveVehicleComplianceCatalog,
  parseVehicleComplianceParagraph,
  submitVehicleCompliance,
  getVehicleComplianceStatus
} from './src/services/vehicleCompliance.js';
import { resolveBundledCatalog } from './src/services/complianceCatalog.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const NOW = new Date('2026-10-30T00:00:00Z');

async function run() {
  console.log('=== VEHICLE vs DRIVER COMPLIANCE (v1.16.0) ===\n');

  console.log('--- Test 1: catalogs are separate and region-aware ---');
  const keBus = resolveVehicleComplianceCatalog({ countryCode: 'KE', assetType: 'BUS' });
  const keBusTypes = keBus.items.map((i) => i.type);
  check(keBus.scope === 'vehicle', 'Vehicle catalog declares its scope');
  check(keBusTypes.includes('insurance') && keBusTypes.includes('inspection'), 'Vehicle catalog carries insurance + inspection');
  check(keBusTypes.includes('road_service_licence'), 'Vehicle catalog carries road service licence (PSL)');
  check(keBusTypes.includes('speed_limiter'), 'PSV/asset-specific speed limiter applies to BUS');

  const keIce = resolveVehicleComplianceCatalog({ countryCode: 'KE', assetType: 'ICE' });
  check(!keIce.items.map((i) => i.type).includes('speed_limiter'), 'Speed limiter is filtered out for a non-PSV asset');

  const driverCatalog = resolveBundledCatalog({ countryCode: 'KE', assetType: 'BUS' });
  check(driverCatalog.minimal.type === 'driver_license', 'Driver catalog minimal item is the driver licence');
  check(!keBusTypes.includes('driver_license'), 'Vehicle catalog never contains driver licences');
  check(!driverCatalog.additional.some((i) => i.type === 'insurance'), 'Driver catalog never contains vehicle insurance');

  console.log('\n--- Test 2: one paragraph saves several vehicle permits ---');
  const paragraph = 'Insurance policy ABC-123 expires 2027-05-15, PSL 445566 expires 2026-11-30';
  const parsed = parseVehicleComplianceParagraph(paragraph, {
    countryCode: 'KE',
    assetType: 'ICE',
    timeZone: 'Africa/Nairobi',
    now: NOW
  });
  check(parsed.length === 2, 'Both vehicle items are parsed from one paragraph');
  const insurance = parsed.find((entry) => entry.item.type === 'insurance');
  const psl = parsed.find((entry) => entry.item.type === 'road_service_licence');
  check(insurance?.parsed?.expiry === '2027-05-15', 'Insurance expiry is isolated from its own segment');
  check(insurance?.parsed?.number === 'ABC-123', 'Insurance policy number is captured');
  check(psl?.parsed?.expiry === '2026-11-30', 'PSL expiry is isolated from its own segment');
  check(psl?.parsed?.number === '445566', 'PSL number is captured');

  console.log('\n--- Test 3: vehicle compliance saves + dual-writes legacy columns ---');
  const mock = createMockSupabase({
    vehicle_compliances: [],
    reminders: [],
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A', insurance_expiry: null }]
  });
  const insuranceItem = keIce.items.find((item) => item.type === 'insurance');
  const saved = await submitVehicleCompliance({
    supabase: mock.client,
    vehicle: { id: 'v1', plate_number: 'KDA 123A' },
    item: insuranceItem,
    parsed: insurance.parsed,
    countryCode: 'KE',
    assetType: 'ICE',
    ownerId: 'owner-1',
    timeZone: 'Africa/Nairobi',
    now: NOW
  });
  check(saved.ok === true, 'Insurance compliance is saved');
  check(mock.db.vehicle_compliances.length === 1, 'One vehicle_compliances row exists');
  check(mock.db.vehicle_compliances[0].type === 'insurance', 'Row type is insurance (vehicle scope)');
  check(mock.db.vehicles[0].insurance_expiry === '2027-05-15', 'Legacy vehicles.insurance_expiry is dual-written');
  check(mock.db.reminders.length === 1, 'A linked expiry reminder is created');
  check(mock.db.reminders[0].linked_column === 'vehicles.insurance_expiry', 'Reminder links to the legacy column');
  check(mock.db.reminders[0].category === 'insurance', 'Reminder category is insurance');

  console.log('\n--- Test 4: non-column permits still get their own reminder link ---');
  const pslSaved = await submitVehicleCompliance({
    supabase: mock.client,
    vehicle: { id: 'v1', plate_number: 'KDA 123A' },
    item: keIce.items.find((item) => item.type === 'road_service_licence'),
    parsed: psl.parsed,
    countryCode: 'KE',
    assetType: 'ICE',
    ownerId: 'owner-1',
    timeZone: 'Africa/Nairobi',
    now: NOW
  });
  check(pslSaved.ok === true && mock.db.vehicle_compliances.length === 2, 'PSL is saved as its own vehicle compliance');
  const pslReminder = mock.db.reminders.find((r) => r.linked_column === 'vehicle_compliances:road_service_licence');
  check(Boolean(pslReminder), 'PSL reminder links to the vehicle compliance ledger');
  check(pslReminder?.category === 'licensing', 'PSL uses the licensing reminder ladder');

  console.log('\n--- Test 5: status reports expired / valid / missing per item ---');
  const statusMock = createMockSupabase({
    vehicle_compliances: [
      { id: 'c1', vehicle_id: 'v1', type: 'insurance', label: 'Insurance', expiry: '2026-01-01', lifetime: false },
      { id: 'c2', vehicle_id: 'v1', type: 'inspection', label: 'Inspection', expiry: '2027-01-01', lifetime: false }
    ],
    reminders: [],
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A' }]
  });
  const status = await getVehicleComplianceStatus({
    supabase: statusMock.client,
    vehicle: { id: 'v1' },
    countryCode: 'KE',
    assetType: 'ICE',
    now: NOW
  });
  const byType = Object.fromEntries(status.items.map((item) => [item.type, item]));
  check(status.ok === true && status.scope === 'vehicle', 'Status is vehicle-scoped');
  check(byType.insurance.status === 'expired', 'Expired insurance is flagged');
  check(byType.inspection.status === 'valid', 'Future inspection is valid');
  check(byType.road_service_licence.status === 'missing', 'Missing PSL is surfaced as missing');
  check(status.missing.includes('Road Service Licence (PSL)'), 'Missing list names the PSL');

  console.log(`\n🎉 ${passed} vehicle-compliance assertions passed.`);
}

run().catch((err) => {
  console.error('\n❌ Vehicle compliance suite failed:', err.message);
  process.exit(1);
});
