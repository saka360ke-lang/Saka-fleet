import assert from 'assert';
import {
  REPORT_ACCESS_MATRIX,
  DRIVER_DEFAULT_REPORTS,
  resolveReportAccess,
  reportAccessDeniedText
} from './src/services/reportAccess.js';

/**
 * Saka Fleet — Report Access Lanes tests (v1.18.0). Stateless.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const owner = { id: 'owner-1', roles: ['Owner'] };
const driver = { id: 'driver-1', roles: ['Driver'] };
const stranger = { id: 'stranger-1', roles: [] };
const admin = { id: 'admin-1', roles: ['Superadmin'] };

const vehicles = [
  { id: 'v1', owner_id: 'owner-1', assigned_driver_id: 'driver-1', plate_number: 'KDA 123A' },
  { id: 'v2', owner_id: 'owner-1', assigned_driver_id: null, plate_number: 'KBC 456B' },
  { id: 'v3', owner_id: 'owner-2', assigned_driver_id: 'driver-2', plate_number: 'KDD 789C' }
];

console.log('=== SAKA FLEET — REPORT ACCESS LANE TESTS ===\n');

console.log('--- Test 1: owner lane ---');
const ownerFleet = resolveReportAccess({ reportType: 'fleet', profile: owner, vehicles });
check(ownerFleet.allowed === true && ownerFleet.lane === 'owner', 'owner can request fleet status');
check(ownerFleet.vehicleIds.length === 2 && ownerFleet.vehicleIds.includes('v1') && ownerFleet.vehicleIds.includes('v2'), 'owner scope is exactly their vehicles');
check(ownerFleet.vehicleIds.includes('v3') === false, 'owner never sees another owner\'s vehicle');
check(resolveReportAccess({ reportType: 'financial', profile: owner, vehicles }).allowed, 'owner can request financials');
check(resolveReportAccess({ reportType: 'driver_scorecard', profile: owner, vehicles }).allowed, 'owner can request driver scorecards');
check(resolveReportAccess({ reportType: 'custom', profile: owner, vehicles }).allowed, 'owner can request bespoke reports');

console.log('--- Test 2: driver lane ---');
const driverDaybook = resolveReportAccess({ reportType: 'driver_daybook', profile: driver, vehicles });
check(driverDaybook.allowed === true && driverDaybook.lane === 'driver', 'driver can request the daybook');
check(driverDaybook.vehicleIds.length === 1 && driverDaybook.vehicleIds[0] === 'v1', 'driver scope is the assigned vehicle only');
check(resolveReportAccess({ reportType: 'vehicle_health', profile: driver, vehicles }).allowed, 'driver can request vehicle health');
check(resolveReportAccess({ reportType: 'driver_compliance_card', profile: driver, vehicles }).allowed, 'driver can request their compliance card');
check(resolveReportAccess({ reportType: 'maintenance', profile: driver, vehicles }).allowed, 'driver can request maintenance');
check(resolveReportAccess({ reportType: 'fuel_economy', profile: driver, vehicles }).allowed, 'driver can request fuel economy');

console.log('--- Test 3: blocked driver reports ---');
for (const blocked of ['fleet', 'financial', 'driver_scorecard', 'year_review', 'eco_footprint']) {
  const access = resolveReportAccess({ reportType: blocked, profile: driver, vehicles });
  check(access.allowed === false, `driver is denied ${blocked}`);
  check(typeof access.reason === 'string' && access.reason.length > 0, `denial reason present for ${blocked}`);
}
const financialDenied = resolveReportAccess({ reportType: 'financial', profile: driver, vehicles });
check(financialDenied.vehicleIds.length === 1, 'denied responses still scope to the assigned vehicle (no leakage)');

console.log('--- Test 4: owner grants (Report Passes) ---');
const granted = resolveReportAccess({ reportType: 'compliance', profile: driver, vehicles, grants: ['compliance'] });
check(granted.allowed === true && granted.granted === true, 'owner grant unlocks compliance for the driver');
const ungranted = resolveReportAccess({ reportType: 'compliance', profile: driver, vehicles, grants: [] });
check(ungranted.allowed === false, 'compliance stays locked without a grant');
check(resolveReportAccess({ reportType: 'financial', profile: driver, vehicles, grants: ['financial'] }).allowed === false, 'grants can never unlock financials');

console.log('--- Test 5: custom report safety ---');
const driverCustom = resolveReportAccess({ reportType: 'custom', profile: driver, vehicles });
check(driverCustom.allowed === true && driverCustom.driverSafeOnly === true, 'driver custom reports are marked driver-safe only');

console.log('--- Test 6: admin and strangers ---');
const adminAccess = resolveReportAccess({ reportType: 'financial', profile: admin, vehicles });
check(adminAccess.allowed === true && adminAccess.lane === 'admin', 'superadmin sees every lane');
check(adminAccess.vehicleIds.length === vehicles.length, 'superadmin scope is the full fleet');
const strangerAccess = resolveReportAccess({ reportType: 'fleet', profile: stranger, vehicles });
check(strangerAccess.allowed === false && strangerAccess.lane === null, 'unregistered users have no lane');

console.log('--- Test 7: denial copy + matrix integrity ---');
const denial = reportAccessDeniedText('financial', financialDenied);
check(denial.includes("owner's lane") && denial.includes('Driver Daybook'), 'driver denial copy is warm and offers the driver lane');
check(Object.keys(REPORT_ACCESS_MATRIX).length >= 10, 'matrix covers the full report catalog');
check(DRIVER_DEFAULT_REPORTS.includes('driver_daybook') && !DRIVER_DEFAULT_REPORTS.includes('financial'), 'driver defaults are driver-first only');

console.log(`\n🎉 ${passed} report-access assertions passed.`);
