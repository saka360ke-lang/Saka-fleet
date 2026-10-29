/**
 * Saka Fleet — OTP-Gated Driver Assignment & Compliance Gate (stateless)
 * ----------------------------------------------------------------------
 * Covers the regional compliance catalog, delta-honest OTP gate, driver ACCEPT,
 * valid-at-assignment rules (expiry vs lifetime), asset-aware extras, the
 * once-only owner compliance report, the 3-strike cancellation, the management
 * gate and stale-assignment expiry.
 *
 * Run: node test_driver_assignment_gate.js
 */

import assert from 'assert';
import {
  resolveBundledCatalog,
  getComplianceCatalog,
  clearComplianceCatalogCache,
  parseComplianceItem,
  complianceCategory
} from './src/services/complianceCatalog.js';
import {
  createDriverAssignment,
  verifyOwnerAssignmentOtp,
  handleDriverResponse,
  getDriverComplianceStatus,
  submitDriverCompliance,
  notifyOwnerComplianceCleared,
  canManageVehicle,
  expireStaleAssignments
} from './src/services/driverAssignments.js';
import { getFlowDefinition, detectQuizStart } from './src/services/quizEngine.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`\u2705 ${message}`);
}

function matches(row, filters) {
  return filters.every((filter) => {
    if (filter.op === 'eq') return row[filter.col] === filter.val;
    if (filter.op === 'in') return Array.isArray(filter.val) && filter.val.includes(row[filter.col]);
    return true;
  });
}

function createMockSupabase(seed = {}) {
  const tables = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((row) => ({ ...row }));
  const ensure = (table) => (tables[table] ||= []);

  function makeBuilder(table) {
    const filters = [];
    let patch = null;
    let insertRows = null;
    let limitN = null;

    function execute() {
      const rows = ensure(table);
      if (insertRows) {
        const stored = insertRows.map((row, index) => ({ id: row.id || `${table}-${rows.length + index + 1}`, ...row }));
        rows.push(...stored);
        return { data: stored.map((row) => ({ ...row })), error: null };
      }
      if (patch) {
        const matched = rows.filter((row) => matches(row, filters));
        matched.forEach((row) => Object.assign(row, patch));
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      let result = rows.filter((row) => matches(row, filters));
      if (limitN !== null) result = result.slice(0, limitN);
      return { data: result.map((row) => ({ ...row })), error: null };
    }

    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      in(col, vals) { filters.push({ op: 'in', col, val: vals }); return builder; },
      limit(n) { limitN = n; return builder; },
      insert(rows) { insertRows = rows; return builder; },
      update(p) { patch = p; return builder; },
      maybeSingle() {
        const result = execute();
        return Promise.resolve({ data: result.data[0] || null, error: result.error });
      },
      single() {
        const result = execute();
        return Promise.resolve({ data: result.data[0] || null, error: result.error });
      },
      then(resolve) {
        return Promise.resolve(execute()).then(resolve);
      }
    };
    return builder;
  }

  return { tables, client: { from: (table) => makeBuilder(table) } };
}

function seedFleet() {
  return {
    profiles: [
      { id: 'owner1', phone_number: '+254700000001', full_name: 'Fleet Owner', country_code: 'KE', email: 'owner@example.com', email_verified: true },
      { id: 'drv1', phone_number: '+254700000002', full_name: 'Fleet Driver', country_code: 'KE', is_active: true, email_verified: false }
    ],
    vehicles: [
      { id: 'v1', plate_number: 'KDA 123A', owner_id: 'owner1', owner_phone: '+254700000001', current_mileage: 50000, asset_type: 'ICE', status: 'ACTIVE' },
      { id: 'v2', plate_number: 'KDB 456B', owner_id: 'owner1', owner_phone: '+254700000001', current_mileage: 80000, asset_type: 'PSV', status: 'ACTIVE' }
    ]
  };
}

const OWNER = { id: 'owner1', phone_number: '+254700000001', email: 'owner@example.com', email_verified: true };

async function createVerifiedAssignment(mock, { vehicle = { id: 'v1' }, driverPhone = '+254700000002' } = {}) {
  const created = await createDriverAssignment({
    supabase: mock.client,
    ownerProfile: OWNER,
    vehicle,
    driverPhone,
    handoverOdometer: 50000,
    countryInfo: { country_code: 'KE', country: 'Kenya', default_units: 'metric' },
    sendOtpFn: async () => true
  });
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  const verified = await verifyOwnerAssignmentOtp({
    supabase: mock.client,
    assignmentId: created.assignment.id,
    ownerId: OWNER.id,
    code: created.otp
  });
  if (!verified.ok) throw new Error(`verify failed: ${verified.error}`);
  return { created, verified };
}

async function run() {
  const now = new Date('2026-10-29T09:00:00+03:00');
  console.log('=== DRIVER ASSIGNMENT & COMPLIANCE GATE TESTS ===\n');

  console.log('--- Test 1: regional + asset-aware catalog ---');
  const keBus = resolveBundledCatalog({ countryCode: 'KE', assetType: 'BUS' });
  check(keBus.minimal.type === 'driver_license', 'KE minimal compliance is the driver licence');
  check(keBus.additional.some((item) => item.type === 'psv_badge'), 'KE PSV badge is offered for a bus/PSV asset');
  const keCar = resolveBundledCatalog({ countryCode: 'KE', assetType: 'ICE' });
  check(keCar.additional.length === 0, 'No extra compliance is demanded for a standard car');
  const gbExcavator = resolveBundledCatalog({ countryCode: 'GB', assetType: 'EXCAVATOR' });
  check(gbExcavator.additional.some((item) => item.type === 'plant_card'), 'UK excavator operators are offered the plant card');
  check(!gbExcavator.additional.some((item) => item.type === 'driver_cpc'), 'Driver CPC is not offered for an excavator');
  const usTruck = resolveBundledCatalog({ countryCode: 'US', assetType: 'TRUCK' });
  check(usTruck.additional.some((item) => item.type === 'cdl'), 'US trucks offer the CDL');
  check(resolveBundledCatalog({ countryCode: 'BE' }).minimal.lifetimeAllowed === true, 'Belgium allows a lifetime licence');
  check(resolveBundledCatalog({ countryCode: 'ZZ' }).minimal.type === 'driver_license', 'Unknown economies fall back to the driver licence');

  console.log('\n--- Test 2: natural compliance parsing ---');
  const valid = parseComplianceItem('DL-1234567 expires 15 Dec 2028', { countryCode: 'KE', now });
  check(valid?.number === 'DL-1234567' && valid.expiry === '2028-12-15', 'Licence number and expiry are extracted');
  check(valid && !valid.expired, 'A future expiry is valid');
  const expired = parseComplianceItem('DL-999888 expired 01 Jan 2020', { countryCode: 'KE', now });
  check(expired?.expired === true, 'An expired licence is flagged');
  const lifetime = parseComplianceItem('PSV 445566 valid for life', { countryCode: 'KE', now });
  check(lifetime?.lifetime === true && lifetime.number === '445566', '"Valid for life" is detected');
  check(parseComplianceItem('DL-1234567', { now }) === null, 'A missing expiry is rejected');
  check(complianceCategory('psv_badge') === 'permit' && complianceCategory('driver_license') === 'driver_license', 'Compliance types map to reminder categories');

  console.log('\n--- Test 3: owner OTP gate (email delivery) ---');
  const otpMock = createMockSupabase(seedFleet());
  const emails = [];
  const created = await createDriverAssignment({
    supabase: otpMock.client,
    ownerProfile: OWNER,
    vehicle: { id: 'v1', plate_number: 'KDA 123A' },
    driverPhone: '+254700000002',
    handoverOdometer: 50000,
    countryInfo: { country_code: 'KE', country: 'Kenya' },
    sendOtpFn: async (email, code, meta) => emails.push({ email, code, meta })
  });
  check(created.ok && created.otp?.length === 6, 'Creating an assignment generates a 6-digit owner OTP');
  check(created.ownerEmail === 'owner@example.com', 'Assignment resolves the owner email');
  check(emails.some((m) => m.email === 'owner@example.com' && m.code === created.otp), 'Owner receives the OTP by email');
  check(emails[0]?.meta?.plate === 'KDA 123A', 'Assignment OTP email carries the vehicle context');
  check(otpMock.tables.driver_assignments[0].status === 'PENDING_OWNER_OTP', 'Assignment waits for owner verification');

  const noEmailMock = createMockSupabase(seedFleet());
  const blocked = await createDriverAssignment({
    supabase: noEmailMock.client,
    ownerProfile: { id: 'owner1', phone_number: '+254700000001' },
    vehicle: { id: 'v1', owner_id: 'owner1', plate_number: 'KDA 123A' },
    driverPhone: '+254700000002',
    sendOtpFn: async () => true
  });
  check(!blocked.ok && /email/i.test(blocked.error), 'Assignments are blocked without an owner email');
  check((noEmailMock.tables.driver_assignments || []).length === 0, 'No pending assignment is created without an email');

  const failMock = createMockSupabase(seedFleet());
  const emailFailure = await createDriverAssignment({
    supabase: failMock.client,
    ownerProfile: OWNER,
    vehicle: { id: 'v1' },
    driverPhone: '+254700000002',
    handoverOdometer: 50000,
    countryInfo: { country_code: 'KE' },
    sendOtpFn: async () => { throw new Error('resend down'); }
  });
  check(!emailFailure.ok && /verification code/i.test(emailFailure.error), 'Email delivery failure is surfaced to the owner');
  check(failMock.tables.driver_assignments[0].status === 'CANCELLED', 'Pending request is cancelled when the OTP email fails');

  const firstBad = await verifyOwnerAssignmentOtp({ supabase: otpMock.client, assignmentId: created.assignment.id, code: '000000', now });
  check(!firstBad.ok && firstBad.attempts === 1, 'A wrong OTP is rejected and counted');
  await verifyOwnerAssignmentOtp({ supabase: otpMock.client, assignmentId: created.assignment.id, code: '111111', now });
  const thirdBad = await verifyOwnerAssignmentOtp({ supabase: otpMock.client, assignmentId: created.assignment.id, code: '222222', now });
  check(thirdBad.cancelled && otpMock.tables.driver_assignments[0].status === 'CANCELLED', 'Three wrong OTPs cancel the request');

  const good = await createDriverAssignment({
    supabase: otpMock.client,
    ownerProfile: OWNER,
    vehicle: { id: 'v1' },
    driverPhone: '+254700000002',
    handoverOdometer: 50000,
    countryInfo: { country_code: 'KE' },
    sendOtpFn: async () => true,
    sendWhatsApp: async () => {}
  });
  const verified = await verifyOwnerAssignmentOtp({
    supabase: otpMock.client,
    assignmentId: good.assignment.id,
    ownerId: OWNER.id,
    code: good.otp,
    sendWhatsApp: async () => {}
  });
  check(verified.ok && verified.assignment.status === 'PENDING_DRIVER_ACCEPTANCE', 'Correct OTP moves the request to driver acceptance');
  check(!otpMock.tables.vehicles.find((v) => v.id === 'v1').assigned_driver_id, 'Vehicle is not assigned before the driver accepts');
  const conflict = await createDriverAssignment({
    supabase: otpMock.client,
    ownerProfile: OWNER,
    vehicle: { id: 'v2' },
    driverPhone: '+254700000002',
    countryInfo: { country_code: 'KE' },
    sendOtpFn: async () => true
  });
  check(!conflict.ok, 'A pending assignment reserves the driver (strict 1-to-1)');

  console.log('\n--- Test 4: driver ACCEPT, snapshot & gate ---');
  const acceptMock = createMockSupabase(seedFleet());
  await createVerifiedAssignment(acceptMock);
  const accepted = await handleDriverResponse({
    driverPhone: '+254700000002',
    response: 'ACCEPT',
    supabase: acceptMock.client,
    countryInfo: { country_code: 'KE' },
    now
  });
  check(accepted?.status === 'ACCEPTED', 'Driver ACCEPT activates the assignment');
  check(acceptMock.tables.vehicles.find((v) => v.id === 'v1').assigned_driver_id === 'drv1', 'Vehicle is linked to the driver only after ACCEPT');
  const assignment = acceptMock.tables.driver_assignments[0];
  check(assignment.compliance_snapshot?.validAtAssignment === false, 'Snapshot records that compliance was not valid at assignment');
  const driverProfile = acceptMock.tables.profiles.find((p) => p.id === 'drv1');
  const gate = await canManageVehicle({
    supabase: acceptMock.client,
    profile: driverProfile,
    vehicle: acceptMock.tables.vehicles.find((v) => v.id === 'v1'),
    now
  });
  check(gate.gated === true, 'Driver is gated immediately after accepting');
  check(/Step 1/.test(accepted.replyMessage) && /Step 2/.test(accepted.replyMessage), 'Driver is told the two compliance steps');

  console.log('\n--- Test 5: valid minimal compliance opens the gate + once-only report ---');
  driverProfile.email = 'driver@example.com';
  driverProfile.email_verified = true;
  const submitted = await submitDriverCompliance({
    supabase: acceptMock.client,
    driverId: 'drv1',
    item: { type: 'driver_license', label: 'Driver licence', lifetimeAllowed: false },
    parsed: valid,
    isMinimal: true,
    countryCode: 'KE',
    timeZone: 'Africa/Nairobi',
    now
  });
  check(submitted.ok, 'A valid minimal compliance is stored');
  const cleared = await getDriverComplianceStatus({ supabase: acceptMock.client, driverId: 'drv1', now });
  check(cleared.canManage === true, 'Gate opens after email verification + valid minimal compliance');
  const report = await notifyOwnerComplianceCleared({ supabase: acceptMock.client, assignment, status: cleared, now });
  check(report.sent === true, 'Owner receives the compliance-cleared report once');
  const reportAgain = await notifyOwnerComplianceCleared({ supabase: acceptMock.client, assignment, status: cleared, now });
  check(reportAgain.alreadySent === true, 'The compliance report never repeats');
  check(acceptMock.tables.pending_owner_notifications.filter((n) => n.action_type === 'DRIVER_COMPLIANCE_CLEARED').length === 1, 'Exactly one owner compliance report is queued');

  console.log('\n--- Test 6: 3 expired submissions cancel the assignment ---');
  const strikeMock = createMockSupabase(seedFleet());
  await createVerifiedAssignment(strikeMock);
  await handleDriverResponse({ driverPhone: '+254700000002', response: 'ACCEPT', supabase: strikeMock.client, now });
  let lastInvalid;
  for (let i = 0; i < 3; i += 1) {
    lastInvalid = await submitDriverCompliance({
      supabase: strikeMock.client,
      driverId: 'drv1',
      item: { type: 'driver_license', label: 'Driver licence', lifetimeAllowed: false },
      parsed: expired,
      isMinimal: true,
      countryCode: 'KE',
      now
    });
  }
  check(lastInvalid.cancelled === true && lastInvalid.attempts === 3, 'Third expired minimal submission cancels the assignment');
  check(strikeMock.tables.driver_assignments[0].status === 'CANCELLED', 'Cancelled assignment is persisted');
  check(!strikeMock.tables.vehicles.find((v) => v.id === 'v1').assigned_driver_id, 'Vehicle is released on cancellation');
  check(strikeMock.tables.pending_owner_notifications.filter((n) => n.action_type === 'DRIVER_COMPLIANCE_INVALID').length === 3, 'Owner is alerted on every invalid attempt');
  check(strikeMock.tables.pending_owner_notifications.filter((n) => n.action_type === 'DRIVER_ASSIGNMENT_CANCELLED').length === 1, 'Owner is told to restart the assignment');

  console.log('\n--- Test 7: lifetime economy vs expiring economy ---');
  const beSeed = seedFleet();
  beSeed.profiles = [
    { id: 'owner1', phone_number: '+254700000001', full_name: 'Fleet Owner', country_code: 'BE', email: 'owner@example.com', email_verified: true },
    { id: 'drv1', phone_number: '+254700000002', full_name: 'Fleet Driver', country_code: 'BE', email: 'be@example.com', email_verified: true, is_active: true }
  ];
  const beMock = createMockSupabase(beSeed);
  const beItem = resolveBundledCatalog({ countryCode: 'BE' }).minimal;
  const beParsed = parseComplianceItem('DL-BE-778899 valid for life', { timeZone: 'Europe/Brussels', now });
  const lifetimeSubmit = await submitDriverCompliance({
    supabase: beMock.client,
    driverId: 'drv1',
    item: beItem,
    parsed: beParsed,
    isMinimal: true,
    countryCode: 'BE',
    timeZone: 'Europe/Brussels',
    now
  });
  check(lifetimeSubmit.ok, 'A lifetime compliance is stored where the economy allows it');
  const beStatus = await getDriverComplianceStatus({ supabase: beMock.client, driverId: 'drv1', countryCode: 'BE', now });
  check(beStatus.minimal.valid === true && beStatus.canManage === true, 'Lifetime minimal compliance opens the gate');
  const keLifetime = await submitDriverCompliance({
    supabase: beMock.client,
    driverId: 'drv1',
    item: { type: 'driver_license', label: 'Driver licence', lifetimeAllowed: false },
    parsed: lifetime,
    isMinimal: true,
    countryCode: 'KE',
    now
  });
  check(!keLifetime.ok && keLifetime.reason === 'lifetime_not_allowed', 'Lifetime is rejected in an economy that requires an expiry');

  console.log('\n--- Test 8: catalog overrides + effective dating ---');
  const overrideMock = createMockSupabase({
    compliance_catalog: [{
      id: 'cat1', country_code: 'KE',
      minimal: { type: 'psv_badge', label: 'PSV licence only' },
      additional: [], is_active: true, effective_from: '2026-01-01', next_review_at: '2026-06-01', catalog_version: 'test'
    }]
  });
  clearComplianceCatalogCache();
  const overridden = await getComplianceCatalog({ supabase: overrideMock.client, countryCode: 'KE' });
  check(overridden.minimal.type === 'psv_badge' && overridden.source === 'override', 'An active catalog override wins over bundled defaults');
  const futureMock = createMockSupabase({
    compliance_catalog: [{
      id: 'cat2', country_code: 'KE',
      minimal: { type: 'psv_badge', label: 'Future rule' },
      additional: [], is_active: true, effective_from: '2099-01-01'
    }]
  });
  clearComplianceCatalogCache();
  const future = await getComplianceCatalog({ supabase: futureMock.client, countryCode: 'KE' });
  check(future.minimal.type === 'driver_license', 'A future-dated override is not applied early');
  clearComplianceCatalogCache();

  console.log('\n--- Test 9: stale acceptance expiry ---');
  const staleSeed = seedFleet();
  staleSeed.driver_assignments = [{
    id: 'a-stale', vehicle_id: 'v1', owner_id: 'owner1', driver_id: 'drv1',
    driver_phone: '+254700000002', status: 'PENDING_DRIVER_ACCEPTANCE',
    created_at: '2026-10-24T09:00:00Z'
  }];
  const staleMock = createMockSupabase(staleSeed);
  const stale = await expireStaleAssignments({ supabase: staleMock.client, now });
  check(stale.expired === 1 && staleMock.tables.driver_assignments[0].status === 'EXPIRED', 'Assignments not accepted within 48h expire');
  check(staleMock.tables.pending_owner_notifications.some((n) => n.action_type === 'DRIVER_ASSIGNMENT_EXPIRED'), 'Owner is notified when an assignment expires');

  console.log('\n--- Test 10: driver onboarding flow wiring ---');
  check(
    detectQuizStart({ intent: 'LOG_EXPENSE', messageText: 'log fuel', hasVehicleRegistered: true, driverOnboardingPending: true }) === 'driver_onboarding',
    'A gated driver is routed into the compliance onboarding flow'
  );
  const keFlowCtx = {
    countryInfo: { country_code: 'KE', locale: 'en-KE' },
    profile: { id: 'drv1', full_name: 'Fleet Driver', email: 'driver@example.com', email_verified: true },
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A', assigned_driver_id: 'drv1', asset_type: 'BUS' }]
  };
  const keFlow = getFlowDefinition('driver_onboarding', keFlowCtx);
  const keKeys = keFlow.fields.map((f) => f.key);
  check(keFlow.label === 'Driver compliance onboarding', 'Driver onboarding flow is registered');
  check(keKeys.includes('minimal_compliance') && keKeys.includes('compliance_psv_badge'), 'KE bus driver is asked for the licence and the PSV badge');
  const beFlowCtx = {
    countryInfo: { country_code: 'BE', locale: 'en-GB' },
    profile: { id: 'drv2', full_name: 'Belgian Driver', email: 'be@example.com', email_verified: true },
    vehicles: [{ id: 'v2', plate_number: 'BE 123', assigned_driver_id: 'drv2', asset_type: 'ICE' }]
  };
  const beMinimal = getFlowDefinition('driver_onboarding', beFlowCtx).fields.find((f) => f.key === 'minimal_compliance');
  check(/valid for life/i.test(beMinimal.hint), 'Belgian drivers are told a lifetime licence is acceptable');

  console.log(`\n\u2705 ALL DRIVER ASSIGNMENT GATE TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});

