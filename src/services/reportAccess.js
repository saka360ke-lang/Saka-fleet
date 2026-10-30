/**
 * Saka Fleet — Report Access Lanes (v1.18.0)
 * ------------------------------------------
 * One deterministic choke point for WHO may see WHICH report and over WHICH
 * vehicles. Owners see everything about what they own; assigned drivers get a
 * small, driver-first lane scoped strictly to their assigned vehicle and their
 * own activity. Drivers never see owner earnings, net profit, other vehicles,
 * passbook/transfer data or another driver's card.
 *
 * Used by the WhatsApp report branch, the background report worker and the PDF
 * builder (defense in depth: a denied PDF is never assembled).
 */

export const REPORT_LANES = Object.freeze({
  OWNER: 'owner',
  DRIVER: 'driver',
  ADMIN: 'admin'
});

/**
 * `driver: true` = always allowed in the driver lane.
 * `driverGrant: true` = owner may grant it on driver_assignments.
 * `false` = never for drivers.
 */
export const REPORT_ACCESS_MATRIX = Object.freeze({
  fleet: { label: 'Fleet Status Report', owner: true, driver: false },
  compliance: { label: 'Compliance & Expiry Report', owner: true, driver: false, driverGrant: true },
  maintenance: { label: 'Maintenance & Service Report', owner: true, driver: true },
  financial: { label: 'Financial & Cost Report', owner: true, driver: false },
  fuel_economy: { label: 'Fuel Economy Deep-Dive', owner: true, driver: true },
  driver_daybook: { label: 'Driver Daybook', owner: true, driver: true },
  vehicle_health: { label: 'Vehicle Health Check-in', owner: true, driver: true },
  driver_compliance_card: { label: 'My Compliance Card', owner: true, driver: true },
  driver_scorecard: { label: 'Driver Scorecard', owner: true, driver: false },
  year_review: { label: 'Year-in-Review Digest', owner: true, driver: false },
  eco_footprint: { label: 'Eco-Footprint Summary', owner: true, driver: false },
  custom: { label: 'Bespoke Report', owner: true, driver: true, driverSafeOnly: true }
});

/** Report types a driver may ask for without any owner grant. */
export const DRIVER_DEFAULT_REPORTS = Object.freeze(
  Object.entries(REPORT_ACCESS_MATRIX)
    .filter(([, meta]) => meta.driver === true)
    .map(([key]) => key)
);

export const OWNER_REPORTS = Object.freeze(
  Object.entries(REPORT_ACCESS_MATRIX)
    .filter(([, meta]) => meta.owner)
    .map(([key]) => key)
);

function normalizeRoles(profile = {}, roles = []) {
  const list = [...(Array.isArray(roles) ? roles : []), ...(Array.isArray(profile.roles) ? profile.roles : [])];
  const normalized = list.map((role) => String(role || '').toLowerCase()).filter(Boolean);
  if (profile.is_superadmin) normalized.push('superadmin');
  if (profile.role) normalized.push(String(profile.role).toLowerCase());
  return new Set(normalized);
}

/**
 * Resolve the caller's lane, scoped vehicles and report permissions.
 * Pure and unit-testable — never touches the database.
 */
export function resolveReportAccess({
  reportType = 'fleet',
  profile = null,
  roles = [],
  vehicles = [],
  ownerId = null,
  driverId = null,
  grants = []
} = {}) {
  const roleSet = normalizeRoles(profile || {}, roles);
  const isAdmin = roleSet.has('superadmin');
  const profileId = profile?.id || null;
  const effectiveOwnerId = ownerId || profileId;
  const effectiveDriverId = driverId || profileId;

  const ownedVehicles = vehicles.filter((vehicle) => vehicle?.owner_id && vehicle.owner_id === effectiveOwnerId);
  const assignedVehicles = vehicles.filter((vehicle) => vehicle?.assigned_driver_id && vehicle.assigned_driver_id === effectiveDriverId);

  const lane = isAdmin
    ? REPORT_LANES.ADMIN
    : (ownedVehicles.length > 0 ? REPORT_LANES.OWNER : (assignedVehicles.length > 0 ? REPORT_LANES.DRIVER : null));
  const meta = REPORT_ACCESS_MATRIX[reportType] || null;

  if (!meta) {
    return { allowed: false, lane, vehicleIds: [], reason: `Unknown report type: ${reportType}`, available: [] };
  }

  if (isAdmin) {
    return {
      allowed: true,
      lane: REPORT_LANES.ADMIN,
      vehicleIds: vehicles.map((vehicle) => vehicle.id),
      reason: null,
      reportType,
      driverSafeOnly: false,
      available: Object.keys(REPORT_ACCESS_MATRIX)
    };
  }

  if (lane === REPORT_LANES.OWNER) {
    const allowed = meta.owner === true;
    return {
      allowed,
      lane,
      vehicleIds: ownedVehicles.map((vehicle) => vehicle.id),
      reason: allowed ? null : `${meta.label} is not available to owners`,
      reportType,
      driverSafeOnly: false,
      available: OWNER_REPORTS.filter((key) => REPORT_ACCESS_MATRIX[key].owner)
    };
  }

  if (lane === REPORT_LANES.DRIVER) {
    const granted = (Array.isArray(grants) ? grants : []).map((grant) => String(grant || '').toLowerCase());
    const grantAllows = meta.driverGrant === true && granted.includes(reportType);
    const allowed = meta.driver === true || grantAllows;
    return {
      allowed,
      lane,
      vehicleIds: assignedVehicles.map((vehicle) => vehicle.id),
      reason: allowed
        ? null
        : `${meta.label} is in the owner's lane. Your driver reports are the Daybook, Vehicle Health Check-in and your Compliance Card.`,
      reportType,
      driverSafeOnly: meta.driverSafeOnly === true,
      granted: grantAllows,
      available: [...DRIVER_DEFAULT_REPORTS, ...granted.filter((grant) => REPORT_ACCESS_MATRIX[grant]?.driverGrant)]
    };
  }

  return {
    allowed: false,
    lane: null,
    vehicleIds: [],
    reason: 'Register a vehicle (owner) or accept a driver assignment to unlock reports.',
    available: []
  };
}

/** Warm, lane-aware denial copy (Tone Compass: empathy + one next step). */
export function reportAccessDeniedText(reportType = 'fleet', access = {}) {
  const label = REPORT_ACCESS_MATRIX[reportType]?.label || 'That report';
  if (access?.lane === 'driver') {
    return `🔒 *${label}* is in the owner's lane.\n\nAs a driver you get:\n• 📓 Driver Daybook\n• 🩺 Vehicle Health Check-in\n• 🎫 My Compliance Card\n\nTry *"driver report"* or ask the owner to grant you access.`;
  }
  return `🔒 *${label}* isn't available on this account yet.\n\nRegister a vehicle to unlock fleet, financial and compliance reports.`;
}

export default {
  REPORT_LANES,
  REPORT_ACCESS_MATRIX,
  DRIVER_DEFAULT_REPORTS,
  OWNER_REPORTS,
  resolveReportAccess,
  reportAccessDeniedText
};

