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
import {
  detectRemindersListCommand,
  detectComplianceStatusCommand,
  detectComplianceExpiryQuestion,
  detectComplianceCorrection,
  detectComplianceItemAsked,
  detectMaintenanceScheduleQuestion,
  detectMaintenancePart,
  buildMaintenanceScheduleAnswer,
  carriesExplicitDate,
  buildComplianceExpiryAnswer,
  buildComplianceStatusReply,
  buildRemindersListReply,
  applyComplianceCorrection
} from './src/services/complianceAnswers.js';

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

  // v1.32.1 — a motor certificate prints COMMENCING + EXPIRING dates; the
  // labelled expiry must win (live evidence 2026-11-01: saved as 2026-10-21).
  const certificate = parseVehicleComplianceParagraph(
    'CERTIFICATE OF INSURANCE No: C35343842 POLICY HOLDER: DAVID MWAURA NJONJO COMMENCING DATE 21/10/2026 EXPIRING: 20/11/2026',
    { countryCode: 'KE', assetType: 'ICE', timeZone: 'Africa/Nairobi', now: NOW }
  );
  const certificateInsurance = certificate.find((entry) => entry.item.type === 'insurance');
  check(certificateInsurance?.parsed?.expiry === '2026-11-20', 'Expiry label wins over the COMMENCING date on a certificate');
  check(certificateInsurance?.parsed?.number === 'C35343842', 'Certificate number is captured for the insurance item');

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

  // v1.32.2 — deterministic answers for the three unanswered live questions and
  // the ignored typed correction (chat evidence 2026-11-01 07:02–07:04).
  console.log('\n--- Test 6: deterministic compliance/reminder answers (v1.32.2) ---');
  check(detectRemindersListCommand('List recent tiered alerts'), 'Alerts list is recognised (typo-tolerant wording)');
  check(detectRemindersListCommand('alerts report'), 'Alerts report routes to the list, not a reminder quiz');
  check(!detectRemindersListCommand('set reminder insurance'), 'Reminder creation is never captured as a list');
  check(detectComplianceStatusCommand('my compliance'), 'Compliance card command is recognised');
  check(!detectComplianceStatusCommand('compliance report'), 'Compliance PDF report stays with the report engine');
  check(detectComplianceExpiryQuestion('When does KAS insurance expires?'), 'Insurance-expiry question is recognised');
  check(detectComplianceItemAsked('Please tell me insurance expiry date') === 'insurance', 'Insurance item is identified');
  const typedCorrection = detectComplianceCorrection('You read the document wrong. 2026-10-21 is the commencement date. The expiry is 2026-11-20');
  check(typedCorrection.isCorrection === true && typedCorrection.kind === 'insurance', 'Typed correction is detected as insurance');
  const answer = buildComplianceExpiryAnswer({
    vehicle: { plate_number: 'KAS 628T' },
    rows: [{ type: 'insurance', label: 'Insurance', number: 'C35343842', expiry: '2026-11-20', lifetime: false }],
    asked: 'insurance',
    now: NOW
  });
  check(answer.includes('20 Nov 2026') && answer.includes('C35343842'), 'Expiry answer renders the labelled date and policy');

  // v1.56.3 — a maintenance-schedule question routes to the user's reminders,
  // never a generic menu (live 2026-11-03: "when am I supposed to buy my
  // front tyres" got a menu).
  check(detectMaintenanceScheduleQuestion('When am I supposed to buy my front tyres?'), 'Tyre-replacement question is recognised');
  check(!detectMaintenanceScheduleQuestion('insurance expires 20/11/2026'), 'A supplied date is not a maintenance question');
  check(detectMaintenancePart('when should I change the oil') === 'oil', 'The maintenance part is identified');
  const tyreAnswer = buildMaintenanceScheduleAnswer({
    vehicle: { plate_number: 'KAS 628T' },
    reminders: [{ reminder_type: 'Tyres', threshold_unit: 'distance', threshold_value: 400000, due_date: null }],
    asked: 'tyres'
  });
  check(/Tyres/.test(tyreAnswer) && /400,000 km/.test(tyreAnswer), 'A tyre reminder is cited from the user own reminders');
  const noTyre = buildMaintenanceScheduleAnswer({ vehicle: { plate_number: 'KAS 628T' }, reminders: [], asked: 'tyres' });
  check(/won't guess/.test(noTyre) && /KAS 628T/.test(noTyre), 'No tyre reminder is answered honestly with a next step');
  const card = buildComplianceStatusReply({
    vehicle: { plate_number: 'KAS 628T' },
    rows: [
      { type: 'insurance', label: 'Insurance', number: 'C35343842', expiry: '2026-11-20', lifetime: false },
      { type: 'inspection', label: 'Inspection', expiry: '2026-01-01', lifetime: false }
    ],
    now: NOW
  });
  check(card.includes('Insurance') && card.includes('Inspection') && card.includes('🔴'), 'Compliance card lists items with status chips');
  const reminderList = buildRemindersListReply({
    reminders: [
      { reminder_type: 'Insurance', due_date: '2026-11-20T00:00:00Z', status: 'active', vehicle_id: 'v1' }
    ],
    vehicles: [{ id: 'v1', plate_number: 'KAS 628T' }],
    now: NOW
  });
  check(reminderList.includes('Insurance') && reminderList.includes('KAS 628T') && reminderList.includes('🟡'), 'Reminders list shows the item, plate and chip');

  const correctionMock = createMockSupabase({
    vehicle_compliances: [{ id: 'c1', vehicle_id: 'v1', type: 'insurance', label: 'Insurance', number: 'C35343842', expiry: '2026-10-21', lifetime: false }],
    reminders: [],
    vehicles: [{ id: 'v1', plate_number: 'KAS 628T', insurance_expiry: '2026-10-21' }]
  });
  const corrected = await applyComplianceCorrection({
    supabase: correctionMock.client,
    vehicle: { id: 'v1', plate_number: 'KAS 628T' },
    kind: 'insurance',
    text: 'you read it wrong, the expiry is 20/11/2026',
    countryCode: 'KE',
    locale: 'en-KE',
    timeZone: 'Africa/Nairobi',
    ownerId: 'owner-1',
    now: NOW
  });
  check(corrected.ok === true && corrected.expiry === '2026-11-20', 'Typed correction writes the expiry date');
  const savedRow = correctionMock.db.vehicle_compliances.find((row) => row.type === 'insurance');
  check(savedRow?.expiry === '2026-11-20', 'Compliance ledger carries the corrected expiry');
  const legacyRow = correctionMock.db.vehicles.find((row) => row.id === 'v1');
  check(legacyRow?.insurance_expiry === '2026-11-20', 'Legacy insurance column follows the correction');

  console.log('\n--- Test: read commands survive a stale quiz (v1.32.3) ---');
  // Live evidence 2026-11-01: every one of these was swallowed by the model or
  // by an abandoned quiz draft. They must all route deterministically.
  const reminderReads = [
    'Report of recent tired alerts',
    'List recent tiered alerts',
    'tiered alerts',
    'I want to see active reminders',
    'Does my car have active reminders?',
    'See reminders for kas',
    'my reminders'
  ];
  reminderReads.forEach((text) => {
    check(detectRemindersListCommand(text), `Reminder list command detected: "${text}"`);
  });
  check(detectComplianceExpiryQuestion('When does my insurance expire'), 'Insurance expiry question detected');
  check(detectComplianceExpiryQuestion('When does my drivers license expire?'), 'Driver-licence expiry question detected');
  check(detectComplianceStatusCommand('Show me insurance details for my cars'), 'Insurance details request detected');
  check(detectComplianceStatusCommand('my compliance'), 'Compliance card command detected');
  check(detectComplianceStatusCommand('compliance report') === false, 'PDF report requests are never stolen by the status card');
  check(detectRemindersListCommand('remind me to renew insurance on 20/11/2026') === false, 'Reminder creation is never read as a list request');
  check(detectRemindersListCommand('no alerts yet') === false, 'A negated answer ("no alerts yet") is not a command');
  check(carriesExplicitDate('insurance expires 20/11/2026'), 'Date-bearing messages are recognised as answers');
  check(carriesExplicitDate('my insurance expired 20 Nov 2026'), 'Written dates are recognised as answers');
  check(!carriesExplicitDate('when does my insurance expire?'), 'A pure question carries no date');
  check(detectComplianceExpiryQuestion('insurance expires 20/11/2026') === false, 'A supplied expiry date is never answered as a question');

  console.log(`\n🎉 ${passed} vehicle-compliance assertions passed.`);
}

run().catch((err) => {
  console.error('\n❌ Vehicle compliance suite failed:', err.message);
  process.exit(1);
});
