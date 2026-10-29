/**
 * Saka Fleet — OTP-Gated Driver Assignment & Compliance Lifecycle (v1.9.2)
 * ------------------------------------------------------------------------
 * Owner assigns a driver -> owner verifies an EMAIL OTP -> driver replies
 * ACCEPT -> the assignment becomes ACTIVE but the driver is GATED from managing
 * the vehicle until:
 *   1. their email is verified, and
 *   2. the mandatory (economy-specific) compliance item is VALID at assignment
 *      time (future expiry, or lifetime where the economy allows it).
 *
 * Additional region/asset-specific items are optional; Saka keeps collecting
 * them so renewal reminders exist. Three expired minimal submissions cancel the
 * assignment and the owner must restart.
 */

import crypto from 'crypto';
import { resolveUserTimezone } from './globalization.js';
import { sendDriverAssignmentOtp } from './mailer.js';
import { buildExpirySpecFromDate, createExpiryReminder, daysUntilDue } from './maintenanceReminders.js';
import { SYSTEM_TIMEZONE } from './dateParser.js';
import { complianceCategory, getComplianceCatalog } from './complianceCatalog.js';

export const ASSIGNMENT_STATUS = Object.freeze({
  PENDING_OWNER_OTP: 'PENDING_OWNER_OTP',
  PENDING_DRIVER_ACCEPTANCE: 'PENDING_DRIVER_ACCEPTANCE',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
});

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
export const MAX_INVALID_COMPLIANCE_ATTEMPTS = 3;
const ACCEPTANCE_TTL_MS = 48 * 60 * 60 * 1000;

const ACTIVE_STATUSES = [
  ASSIGNMENT_STATUS.PENDING_OWNER_OTP,
  ASSIGNMENT_STATUS.PENDING_DRIVER_ACCEPTANCE,
  ASSIGNMENT_STATUS.ACTIVE
];

export function normalizeDriverPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  return digits ? `+${digits}` : null;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function matchesOtp(provided, expected) {
  const a = Buffer.from(String(provided || '').padStart(6, '0'));
  const b = Buffer.from(String(expected || '').padStart(6, '0'));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function rowsOf(data) {
  return Array.isArray(data) ? data : (data ? [data] : []);
}

async function loadVehicle(supabase, vehicleId) {
  if (!supabase || !vehicleId) return null;
  const { data } = await supabase.from('vehicles').select('*').eq('id', vehicleId).maybeSingle();
  return data || null;
}

export function vehicleLabel(vehicle) {
  return vehicle?.plate_number || 'Vehicle';
}

async function queueOwnerReport({ supabase, ownerId, vehicleId, driverId, actionType, text, now = new Date() }) {
  if (!supabase || !ownerId) return false;
  try {
    await supabase.from('pending_owner_notifications').insert([{
      owner_id: ownerId,
      vehicle_id: vehicleId || null,
      driver_id: driverId || null,
      action_type: actionType,
      details_summary: text,
      scheduled_for: new Date(now).toISOString(),
      processed: false
    }]);
    return true;
  } catch (err) {
    console.warn('[driverAssignments] Owner report queue skipped:', err.message);
    return false;
  }
}

/**
 * Create (or supersede) a pending assignment and dispatch the owner OTP.
 */
export async function createDriverAssignment({
  supabase,
  ownerProfile = null,
  vehicle,
  driverPhone,
  handoverOdometer = null,
  countryInfo = null,
  sendOtpFn = sendDriverAssignmentOtp,
  sendWhatsApp = null,
  now = new Date()
} = {}) {
  if (!supabase || !vehicle?.id) return { ok: false, error: 'Vehicle unavailable.' };
  const cleanPhone = normalizeDriverPhone(driverPhone);
  if (!cleanPhone) return { ok: false, error: 'A valid driver phone number is required.' };

  const ownerId = ownerProfile?.id || vehicle.owner_id;
  const ownerPhone = ownerProfile?.phone_number || vehicle.owner_phone;
  const ownerEmail = String(ownerProfile?.email || vehicle.owner_email || '').trim().toLowerCase();
  if (!ownerId) return { ok: false, error: 'Owner profile not found.' };
  if (ownerPhone && normalizeDriverPhone(ownerPhone) === cleanPhone) {
    return { ok: false, error: 'You cannot assign a vehicle to your own number.' };
  }
  if (!ownerEmail) {
    return { ok: false, error: 'Please add an email address before assigning a driver — reply "update email" to set it.' };
  }
  if (ownerProfile && ownerProfile.email_verified === false) {
    return { ok: false, error: 'Your email is not verified yet — complete email verification, then retry the assignment.' };
  }

  // Strict 1-to-1 at request time: a driver can only hold one active/pending
  // vehicle and a vehicle can only have one active/pending driver.
  const { data: driverRows } = await supabase
    .from('driver_assignments')
    .select('*')
    .eq('driver_phone', cleanPhone)
    .limit(50);
  const driverConflict = rowsOf(driverRows).find((row) =>
    ACTIVE_STATUSES.includes(row.status) && row.vehicle_id !== vehicle.id
  );
  if (driverConflict) {
    return { ok: false, error: 'That driver already has an active or pending vehicle assignment.' };
  }
  const sameVehicleActive = rowsOf(driverRows).find((row) => row.status === ASSIGNMENT_STATUS.ACTIVE && row.vehicle_id === vehicle.id);
  if (sameVehicleActive) {
    return { ok: false, error: 'This driver is already assigned to this vehicle.' };
  }

  const { data: vehicleRows } = await supabase
    .from('driver_assignments')
    .select('*')
    .eq('vehicle_id', vehicle.id)
    .limit(50);
  const vehicleConflict = rowsOf(vehicleRows).find((row) =>
    ACTIVE_STATUSES.includes(row.status) && normalizeDriverPhone(row.driver_phone) !== cleanPhone
  );
  if (vehicleConflict) {
    return { ok: false, error: `${vehicleLabel(vehicle)} already has an active or pending driver assignment.` };
  }

  // Ensure the driver profile exists (Saka builds it up during onboarding).
  let { data: driver } = await supabase.from('profiles').select('*').eq('phone_number', cleanPhone).maybeSingle();
  if (!driver) {
    const { data: created } = await supabase.from('profiles').insert([{
      id: crypto.randomUUID(),
      phone_number: cleanPhone,
      full_name: 'Fleet Driver',
      is_active: true,
      country: countryInfo?.country || null,
      country_code: countryInfo?.country_code || null,
      unit_system: countryInfo?.default_units || 'metric'
    }]).select().single();
    driver = created;
  }
  if (!driver?.id) return { ok: false, error: 'Could not create the driver profile.' };

  // Supersede any previous pending OTP request for this vehicle.
  for (const row of rowsOf(vehicleRows).filter((r) => r.status === ASSIGNMENT_STATUS.PENDING_OWNER_OTP)) {
    await supabase.from('driver_assignments').update({ status: ASSIGNMENT_STATUS.CANCELLED }).eq('id', row.id);
  }

  const otp = generateOtp();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();
  const isoNow = new Date(now).toISOString();
  const row = {
    id: crypto.randomUUID(),
    vehicle_id: vehicle.id,
    owner_id: ownerId,
    driver_id: driver.id,
    driver_phone: cleanPhone,
    handover_odometer: handoverOdometer !== null && handoverOdometer !== undefined ? Number(handoverOdometer) : null,
    owner_otp: otp,
    owner_otp_expires_at: expiresAt,
    owner_otp_attempts: 0,
    invalid_compliance_attempts: 0,
    status: ASSIGNMENT_STATUS.PENDING_OWNER_OTP,
    created_at: isoNow
  };

  const { error } = await supabase.from('driver_assignments').insert([row]);
  if (error) return { ok: false, error: error.message };

  try {
    await sendOtpFn(ownerEmail, otp, { plate: vehicleLabel(vehicle), driverPhone: cleanPhone });
  } catch (sendErr) {
    // Do not leave a dangling pending row when the email could not be sent.
    await supabase.from('driver_assignments').update({
      status: ASSIGNMENT_STATUS.CANCELLED,
      cancelled_reason: 'OWNER_OTP_EMAIL_FAILED'
    }).eq('id', row.id);
    return { ok: false, error: `Could not email the verification code (${sendErr.message}). Please try again.` };
  }

  return {
    ok: true,
    assignment: row,
    driver,
    ownerPhone,
    ownerEmail,
    driverPhone: cleanPhone,
    expiresAt,
    otp
  };
}


/**
 * Owner-side OTP verification. On success the assignment moves to
 * PENDING_DRIVER_ACCEPTANCE and the driver is notified on WhatsApp.
 */
export async function verifyOwnerAssignmentOtp({
  supabase,
  assignmentId = null,
  ownerId = null,
  ownerPhone = null,
  code,
  sendWhatsApp = null,
  now = new Date()
} = {}) {
  if (!supabase || !code) return { ok: false, error: 'A 6-digit code is required.' };
  const cleanCode = String(code).replace(/\D/g, '').slice(0, 6);

  let row = null;
  if (assignmentId) {
    const { data } = await supabase.from('driver_assignments').select('*').eq('id', assignmentId).maybeSingle();
    row = data || null;
  }
  if (!row) {
    const { data } = ownerId
      ? await supabase.from('driver_assignments').select('*').eq('owner_id', ownerId).eq('status', ASSIGNMENT_STATUS.PENDING_OWNER_OTP).limit(50)
      : await supabase.from('driver_assignments').select('*').eq('status', ASSIGNMENT_STATUS.PENDING_OWNER_OTP).limit(50);
    const candidates = rowsOf(data).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    row = candidates[0] || null;
  }
  if (!row || row.status !== ASSIGNMENT_STATUS.PENDING_OWNER_OTP) {
    return { ok: false, error: 'No driver assignment is awaiting verification.' };
  }

  if (new Date(row.owner_otp_expires_at || 0).getTime() < new Date(now).getTime()) {
    await supabase.from('driver_assignments').update({ status: ASSIGNMENT_STATUS.CANCELLED }).eq('id', row.id);
    return { ok: false, error: 'That verification code expired. Please restart the assignment.', expired: true };
  }

  if (!matchesOtp(cleanCode, row.owner_otp)) {
    const attempts = Number(row.owner_otp_attempts || 0) + 1;
    const cancelled = attempts >= MAX_OTP_ATTEMPTS;
    await supabase.from('driver_assignments').update({
      owner_otp_attempts: attempts,
      ...(cancelled ? { status: ASSIGNMENT_STATUS.CANCELLED, cancelled_reason: 'OWNER_OTP_ATTEMPTS' } : {})
    }).eq('id', row.id);
    return {
      ok: false,
      error: cancelled
        ? 'Too many incorrect codes — the assignment was cancelled. Please restart it.'
        : `That code is incorrect (${attempts}/${MAX_OTP_ATTEMPTS}). Please try again or reply Resend.`,
      attempts,
      cancelled
    };
  }

  const verifiedAt = new Date(now).toISOString();
  await supabase.from('driver_assignments').update({
    status: ASSIGNMENT_STATUS.PENDING_DRIVER_ACCEPTANCE,
    owner_otp_verified_at: verifiedAt
  }).eq('id', row.id);

  const vehicle = await loadVehicle(supabase, row.vehicle_id);
  const plate = vehicleLabel(vehicle);
  if (sendWhatsApp) {
    const text = `🚗 *Saka Fleet Driver Assignment*\n\nThe vehicle owner has assigned you to *${plate}*.\n\nReply *ACCEPT* to take over the vehicle, or *DECLINE* to reject.\n\n_You will be asked to verify your email and a valid compliance item before you can manage the vehicle._`;
    try {
      await sendWhatsApp(row.driver_phone, text);
    } catch (sendErr) {
      console.warn('[driverAssignments] Driver notification failed:', sendErr.message);
    }
  }

  return {
    ok: true,
    assignment: { ...row, status: ASSIGNMENT_STATUS.PENDING_DRIVER_ACCEPTANCE, owner_otp_verified_at: verifiedAt },
    driverPhone: row.driver_phone,
    plate,
    vehicle
  };
}

/** Owner cancels a pending request. */
export async function cancelPendingAssignment({ supabase, assignmentId, ownerId = null } = {}) {
  if (!supabase || !assignmentId) return { ok: false, error: 'Assignment unavailable.' };
  let query = supabase.from('driver_assignments').update({
    status: ASSIGNMENT_STATUS.CANCELLED,
    cancelled_reason: 'OWNER_CANCELLED'
  }).eq('id', assignmentId);
  if (ownerId) query = query.eq('owner_id', ownerId);
  const { error } = await query;
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}


/** Compute the driver's compliance gate state (email + minimal + extras). */
export async function getDriverComplianceStatus({
  supabase,
  driverId = null,
  driverPhone = null,
  countryCode = null,
  assetType = null,
  now = new Date()
} = {}) {
  if (!supabase) return { ok: false, emailVerified: false, canManage: false, missingRequired: ['profile'] };
  let profile = null;
  if (driverId) {
    const { data } = await supabase.from('profiles').select('*').eq('id', driverId).maybeSingle();
    profile = data || null;
  } else if (driverPhone) {
    const { data } = await supabase.from('profiles').select('*').eq('phone_number', normalizeDriverPhone(driverPhone)).maybeSingle();
    profile = data || null;
  }
  if (!profile) return { ok: false, emailVerified: false, canManage: false, missingRequired: ['profile'], error: 'Driver profile not found.' };

  const catalog = await getComplianceCatalog({
    supabase,
    countryCode: countryCode || profile.country_code || 'GLOBAL',
    assetType,
    now
  });

  const { data: rows } = await supabase.from('driver_compliances').select('*').eq('driver_id', profile.id).limit(100);
  const records = rowsOf(rows);

  const evaluate = (item) => {
    const record = records.find((row) => String(row.type) === String(item.type));
    if (!record) {
      return { type: item.type, label: item.label, status: 'missing', valid: false, lifetime: false, expiry: null, daysLeft: null, number: null };
    }
    const lifetime = record.lifetime === true;
    const expiry = record.expiry ? String(record.expiry).slice(0, 10) : null;
    const daysLeft = expiry ? daysUntilDue(expiry, now) : null;
    const valid = lifetime ? Boolean(item.lifetimeAllowed) : (daysLeft !== null && daysLeft >= 0);
    return {
      type: item.type,
      label: item.label,
      status: valid ? 'valid' : (daysLeft !== null && daysLeft < 0 ? 'expired' : 'invalid'),
      valid,
      lifetime,
      expiry,
      daysLeft,
      number: record.number || null
    };
  };

  const emailVerified = Boolean(profile.email && profile.email_verified);
  const minimal = evaluate(catalog.minimal);
  const additional = (catalog.additional || []).map(evaluate);
  const missingRequired = [];
  if (!emailVerified) missingRequired.push('email_verification');
  if (!minimal.valid) missingRequired.push('minimal_compliance');

  return {
    ok: true,
    profile,
    catalog,
    emailVerified,
    minimal,
    additional,
    canManage: emailVerified && minimal.valid,
    missingRequired,
    timeZone: resolveUserTimezone({ profile })
  };
}

/** Queue the once-only owner report after the minimal compliance passes. */
export async function notifyOwnerComplianceCleared({ supabase, assignment, status, now = new Date() } = {}) {
  if (!supabase || !assignment?.id) return { ok: false };
  const { data: fresh } = await supabase.from('driver_assignments').select('*').eq('id', assignment.id).maybeSingle();
  const row = fresh || assignment;
  if (row.compliance_report_sent_at) return { ok: true, alreadySent: true };

  const vehicle = await loadVehicle(supabase, row.vehicle_id);
  const text = buildComplianceReportText({
    status,
    plate: vehicleLabel(vehicle),
    driverLabel: status?.profile?.full_name || row.driver_phone
  });
  await queueOwnerReport({
    supabase,
    ownerId: row.owner_id,
    vehicleId: row.vehicle_id,
    driverId: row.driver_id,
    actionType: 'DRIVER_COMPLIANCE_CLEARED',
    text,
    now
  });

  const isoNow = new Date(now).toISOString();
  await supabase.from('driver_assignments').update({
    compliance_completed_at: isoNow,
    compliance_report_sent_at: isoNow
  }).eq('id', row.id);
  return { ok: true, sent: true, text };
}

/** Deterministic owner-facing compliance report text. */
export function buildComplianceReportText({ status, plate, driverLabel }) {
  const minimal = status?.minimal;
  const minimalLine = minimal
    ? `${minimal.label}: ${minimal.number || 'on file'} — ${minimal.lifetime ? 'valid for life' : `expires ${minimal.expiry}`}`
    : 'Not submitted';
  const extras = (status?.additional || []).filter((item) => item.status === 'valid').map((item) => item.label);
  return `✅ *Driver Compliance Cleared — ${plate}*\n\n` +
    `• Driver: ${driverLabel || 'Driver'}\n` +
    `• Email verified: ${status?.emailVerified ? 'Yes ✅' : 'No ⚠️'}\n` +
    `• ${minimalLine}\n` +
    `• Additional: ${extras.length ? extras.join(', ') : 'None yet (optional)'}\n\n` +
    `Renewal reminders are active 30/14/7/24h before expiry.`;
}


/**
 * Record an expired/invalid minimal submission: notify the owner, count the
 * strike and cancel the assignment on the third one (owner must restart).
 */
export async function recordInvalidMinimalSubmission({
  supabase,
  driverId,
  itemLabel = 'Driver licence',
  expiry = null,
  now = new Date()
} = {}) {
  if (!supabase || !driverId) return { attempts: 0, cancelled: false };
  const { data } = await supabase
    .from('driver_assignments')
    .select('*')
    .eq('driver_id', driverId)
    .eq('status', ASSIGNMENT_STATUS.ACTIVE)
    .limit(20);
  const assignment = rowsOf(data).sort((a, b) => new Date(b.accepted_at || b.created_at || 0) - new Date(a.accepted_at || a.created_at || 0))[0];
  if (!assignment) return { attempts: 0, cancelled: false };

  const attempts = Number(assignment.invalid_compliance_attempts || 0) + 1;
  const cancelled = attempts >= MAX_INVALID_COMPLIANCE_ATTEMPTS;
  const vehicle = await loadVehicle(supabase, assignment.vehicle_id);
  const plate = vehicleLabel(vehicle);
  const isoNow = new Date(now).toISOString();

  await supabase.from('driver_assignments').update({
    invalid_compliance_attempts: attempts,
    ...(cancelled
      ? {
          status: ASSIGNMENT_STATUS.CANCELLED,
          cancelled_reason: 'EXPIRED_MINIMAL_COMPLIANCE_3X',
          cancelled_at: isoNow
        }
      : {})
  }).eq('id', assignment.id);

  await queueOwnerReport({
    supabase,
    ownerId: assignment.owner_id,
    vehicleId: assignment.vehicle_id,
    driverId: assignment.driver_id,
    actionType: 'DRIVER_COMPLIANCE_INVALID',
    text: `⚠️ *Invalid Driver Compliance — ${plate}*\n\n` +
      `• Driver: ${assignment.driver_phone}\n` +
      `• ${itemLabel}${expiry ? ` expired ${expiry}` : ' is not valid'}\n` +
      `• Attempt: ${attempts}/${MAX_INVALID_COMPLIANCE_ATTEMPTS}\n\n` +
      `The driver is blocked from managing the vehicle until a valid item is submitted.`,
    now
  });

  if (cancelled) {
    try {
      await supabase.from('vehicles').update({
        assigned_driver_id: null,
        updated_at: isoNow
      }).eq('id', assignment.vehicle_id);
    } catch (unassignErr) {
      console.warn('[driverAssignments] Cancellation unassign skipped:', unassignErr.message);
    }
    await queueOwnerReport({
      supabase,
      ownerId: assignment.owner_id,
      vehicleId: assignment.vehicle_id,
      driverId: assignment.driver_id,
      actionType: 'DRIVER_ASSIGNMENT_CANCELLED',
      text: `🚫 *Driver Assignment Cancelled — ${plate}*\n\nThe driver submitted an expired ${itemLabel.toLowerCase()} ${MAX_INVALID_COMPLIANCE_ATTEMPTS} times. ` +
        `The assignment was cancelled and the vehicle released. Once the driver renews it, restart the assignment (a new owner OTP will be required).`,
      now
    });
  }

  return { attempts, cancelled, assignment, vehicle, maxAttempts: MAX_INVALID_COMPLIANCE_ATTEMPTS };
}


/**
 * Persist one compliance item, mirror the minimal item onto the profile and
 * create/refresh the driver-linked expiry reminder.
 */
export async function submitDriverCompliance({
  supabase,
  driverId,
  item,
  parsed,
  isMinimal = false,
  countryCode = 'GLOBAL',
  assetType = null,
  timeZone = SYSTEM_TIMEZONE,
  now = new Date()
} = {}) {
  if (!supabase || !driverId || !item?.type || !parsed?.ok) {
    return { ok: false, error: 'Invalid compliance submission.' };
  }

  if (parsed.lifetime && !item.lifetimeAllowed) {
    return { ok: false, reason: 'lifetime_not_allowed', error: `${item.label} requires an expiry date in your economy.` };
  }
  if (!parsed.lifetime && !parsed.expiry) {
    return { ok: false, reason: 'missing_expiry', error: `${item.label} needs an expiry date (or "valid for life" where allowed).` };
  }

  if (!parsed.lifetime && parsed.expired) {
    const invalid = isMinimal
      ? await recordInvalidMinimalSubmission({ supabase, driverId, itemLabel: item.label, expiry: parsed.expiry, now })
      : { attempts: 0, cancelled: false };
    return {
      ok: false,
      reason: 'expired',
      error: invalid.cancelled
        ? `${item.label} expired on ${parsed.expiry}. This was the 3rd expired submission — the assignment was cancelled.`
        : `${item.label} expired on ${parsed.expiry}. Please submit a valid one (attempt ${invalid.attempts || 1}/${MAX_INVALID_COMPLIANCE_ATTEMPTS}).`,
      ...invalid
    };
  }

  const isoNow = new Date(now).toISOString();
  const row = {
    driver_id: driverId,
    type: item.type,
    label: item.label,
    number: parsed.number,
    expiry: parsed.lifetime ? null : parsed.expiry,
    lifetime: Boolean(parsed.lifetime),
    country_code: String(countryCode || 'GLOBAL').toUpperCase(),
    asset_type: assetType || null,
    verified_at: isoNow,
    updated_at: isoNow
  };

  const { data: existing } = await supabase
    .from('driver_compliances')
    .select('id')
    .eq('driver_id', driverId)
    .eq('type', item.type)
    .limit(1);
  const found = rowsOf(existing)[0];

  if (found?.id) {
    const { error } = await supabase.from('driver_compliances').update(row).eq('id', found.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from('driver_compliances').insert([{ id: crypto.randomUUID(), ...row }]);
    if (error) return { ok: false, error: error.message };
  }

  if (isMinimal) {
    try {
      await supabase.from('profiles').update({
        compliance_type: item.type,
        compliance_number: parsed.number,
        compliance_expiry: parsed.lifetime ? null : parsed.expiry,
        compliance_updated_at: isoNow,
        driver_license_number: parsed.number,
        driver_license_expiry: parsed.lifetime ? null : parsed.expiry,
        updated_at: isoNow
      }).eq('id', driverId);
    } catch (profileErr) {
      console.warn('[driverAssignments] Profile compliance mirror skipped:', profileErr.message);
    }
  }

  let reminder = null;
  if (!parsed.lifetime) {
    reminder = await createExpiryReminder({
      supabase,
      profileId: driverId,
      subjectType: 'driver',
      subjectId: driverId,
      reminderType: item.label,
      category: complianceCategory(item.type),
      spec: buildExpirySpecFromDate(parsed.expiry, { timeZone }),
      linkedColumn: `driver_compliances:${item.type}`,
      timeZone
    });
  }

  return { ok: true, compliance: row, reminder };
}


/**
 * Driver replies ACCEPT / DECLINE. ACCEPT activates the assignment (vehicle
 * linked) but the management gate stays closed until email + minimal compliance
 * are valid. The owner report is sent only once the minimal item passes.
 */
export async function handleDriverResponse({
  driverPhone,
  response = 'ACCEPT',
  supabase,
  sendWhatsAppFn = null,
  countryInfo = null,
  now = new Date()
} = {}) {
  if (!supabase) return null;
  const phone = normalizeDriverPhone(driverPhone);
  const { data } = await supabase
    .from('driver_assignments')
    .select('*')
    .eq('driver_phone', phone)
    .eq('status', ASSIGNMENT_STATUS.PENDING_DRIVER_ACCEPTANCE)
    .limit(20);
  const row = rowsOf(data).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
  if (!row) return null;

  const vehicle = await loadVehicle(supabase, row.vehicle_id);
  const plate = vehicleLabel(vehicle);
  if (!vehicle) {
    await supabase.from('driver_assignments').update({ status: ASSIGNMENT_STATUS.CANCELLED }).eq('id', row.id);
    return { status: 'CANCELLED', replyMessage: `The assignment to ${plate} is no longer available. Please contact the owner.` };
  }

  const decline = /^(decline|reject|no|refuse)\b/i.test(String(response || ''));
  if (decline) {
    await supabase.from('driver_assignments').update({
      status: ASSIGNMENT_STATUS.REJECTED,
      rejected_at: new Date(now).toISOString()
    }).eq('id', row.id);
    await queueOwnerReport({
      supabase,
      ownerId: row.owner_id,
      vehicleId: row.vehicle_id,
      driverId: row.driver_id,
      actionType: 'DRIVER_ASSIGNMENT_DECLINED',
      text: `❌ *Driver Declined Assignment — ${plate}*\n\n${row.driver_phone} declined the assignment. The vehicle remains unassigned; you can restart the assignment with another driver.`,
      now
    });
    return { status: 'DECLINED', replyMessage: `You declined the assignment to ${plate}. The owner has been notified.` };
  }

  if (vehicle.assigned_driver_id && vehicle.assigned_driver_id !== row.driver_id) {
    await supabase.from('driver_assignments').update({ status: ASSIGNMENT_STATUS.CANCELLED }).eq('id', row.id);
    return { status: 'CANCELLED', replyMessage: `${plate} was assigned to another driver. Please contact the owner.` };
  }

  const assetType = vehicle.asset_type || vehicle.metadata?.asset_type || null;
  const compliance = await getDriverComplianceStatus({
    supabase,
    driverId: row.driver_id,
    countryCode: countryInfo?.country_code || vehicle.country_code,
    assetType,
    now
  });

  const acceptedAt = new Date(now).toISOString();
  const snapshot = {
    at: acceptedAt,
    emailVerified: compliance.emailVerified,
    minimal: compliance.minimal,
    additional: compliance.additional,
    validAtAssignment: Boolean(compliance.emailVerified && compliance.minimal?.valid),
    catalogVersion: compliance.catalog?.catalogVersion || null
  };

  await supabase.from('driver_assignments').update({
    status: ASSIGNMENT_STATUS.ACTIVE,
    accepted_at: acceptedAt,
    activated_at: acceptedAt,
    compliance_snapshot: snapshot
  }).eq('id', row.id);

  const updates = {
    assigned_driver_id: row.driver_id,
    updated_at: acceptedAt,
    metadata: {
      ...(vehicle.metadata || {}),
      odometer_at_assignment: row.handover_odometer ?? vehicle.current_mileage ?? 0,
      assigned_at: acceptedAt,
      assigned_driver_phone: row.driver_phone
    }
  };
  if (Number.isFinite(Number(row.handover_odometer)) && Number(row.handover_odometer) > 0) {
    updates.current_mileage = Number(row.handover_odometer);
    updates.odometer_reading = Number(row.handover_odometer);
  }
  await supabase.from('vehicles').update(updates).eq('id', vehicle.id);

  if (compliance.canManage) {
    await notifyOwnerComplianceCleared({ supabase, assignment: row, status: compliance, now });
  }

  const minimalLabel = compliance.catalog?.minimal?.label || 'driver licence';
  const replyMessage = compliance.canManage
    ? `🎉 You're now the assigned driver of *${plate}*. Your compliance is already valid — you can log fuel, odometer and earnings.`
    : `🎉 You're now the assigned driver of *${plate}*.\n\n` +
      `Step 1: ${compliance.emailVerified ? '✓ Email verified' : 'reply with your email address so we can verify it.'}\n` +
      `Step 2: ${compliance.minimal?.valid
        ? `✓ ${minimalLabel} valid`
        : `send your *${minimalLabel}* number and expiry (e.g. "DL-1234567 expires 15 Dec 2028").`}\n\n` +
      `_This is used only for renewal reminders — we will never share it._`;

  return {
    status: 'ACCEPTED',
    assignment: { ...row, status: ASSIGNMENT_STATUS.ACTIVE, compliance_snapshot: snapshot },
    vehicle,
    compliance,
    replyMessage,
    ownerId: row.owner_id,
    driverId: row.driver_id
  };
}


/** Latest ACTIVE assignment for a driver (optionally scoped to a vehicle). */
export async function getActiveAssignment({ supabase, driverId, vehicleId = null } = {}) {
  if (!supabase || !driverId) return null;
  let query = supabase.from('driver_assignments').select('*').eq('driver_id', driverId).eq('status', ASSIGNMENT_STATUS.ACTIVE).limit(20);
  if (vehicleId) query = query.eq('vehicle_id', vehicleId);
  const { data } = await query;
  return rowsOf(data).sort((a, b) => new Date(b.accepted_at || b.created_at || 0) - new Date(a.accepted_at || a.created_at || 0))[0] || null;
}

/**
 * Management gate used by the quiz engine and route handlers.
 * Legacy assignments without an OTP-gated row are grandfathered.
 */
export async function canManageVehicle({ supabase, profile, vehicle, now = new Date() } = {}) {
  if (!profile?.id || !vehicle) return { gated: false, canManage: true };
  if (vehicle.owner_id === profile.id) return { gated: false, canManage: true, reason: 'owner' };
  if (vehicle.assigned_driver_id !== profile.id) return { gated: false, canManage: true, reason: 'not_assigned' };

  const assignment = await getActiveAssignment({ supabase, driverId: profile.id, vehicleId: vehicle.id });
  if (!assignment) return { gated: false, canManage: true, reason: 'legacy_assignment' };

  const status = await getDriverComplianceStatus({
    supabase,
    driverId: profile.id,
    countryCode: profile.country_code,
    assetType: vehicle.asset_type || vehicle.metadata?.asset_type || null,
    now
  });

  return {
    gated: !status.canManage,
    canManage: status.canManage,
    assignment,
    status,
    reason: status.canManage ? 'compliant' : 'compliance_incomplete'
  };
}

/** Expire assignment requests the driver never accepted (48h). */
export async function expireStaleAssignments({ supabase, now = new Date() } = {}) {
  if (!supabase) return { ok: false, expired: 0 };
  const { data } = await supabase
    .from('driver_assignments')
    .select('*')
    .eq('status', ASSIGNMENT_STATUS.PENDING_DRIVER_ACCEPTANCE)
    .limit(500);
  const cutoff = new Date(now).getTime() - ACCEPTANCE_TTL_MS;
  const stale = rowsOf(data).filter((row) => new Date(row.created_at || 0).getTime() < cutoff);
  let expired = 0;

  for (const row of stale) {
    await supabase.from('driver_assignments').update({
      status: ASSIGNMENT_STATUS.EXPIRED,
      cancelled_reason: 'ACCEPTANCE_TIMEOUT'
    }).eq('id', row.id);
    const vehicle = await loadVehicle(supabase, row.vehicle_id);
    await queueOwnerReport({
      supabase,
      ownerId: row.owner_id,
      vehicleId: row.vehicle_id,
      driverId: row.driver_id,
      actionType: 'DRIVER_ASSIGNMENT_EXPIRED',
      text: `⌛ *Driver Assignment Expired — ${vehicleLabel(vehicle)}*\n\n${row.driver_phone} did not accept within 48 hours. The request expired; you can restart the assignment whenever ready.`,
      now
    });
    expired += 1;
  }
  return { ok: true, expired };
}

export default {
  ASSIGNMENT_STATUS,
  MAX_INVALID_COMPLIANCE_ATTEMPTS,
  normalizeDriverPhone,
  createDriverAssignment,
  verifyOwnerAssignmentOtp,
  cancelPendingAssignment,
  handleDriverResponse,
  getDriverComplianceStatus,
  getActiveAssignment,
  canManageVehicle,
  submitDriverCompliance,
  recordInvalidMinimalSubmission,
  notifyOwnerComplianceCleared,
  buildComplianceReportText,
  expireStaleAssignments
};

