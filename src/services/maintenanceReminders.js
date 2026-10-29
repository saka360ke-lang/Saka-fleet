/**
 * Saka Fleet - Universal Reminder Engine (v1.9)
 * ---------------------------------------------
 * Single source of truth for every reminder item:
 *   - Distance thresholds in kilometres (canonical) or miles (converted),
 *     e.g. "oil change in 5000 km" or "brake pads in 3000 miles".
 *   - Operating-hours thresholds, e.g. "spare part change in 36 operating hours".
 *   - Date-based expiries (insurance, inspection/MOT, licensing, permits,
 *     driver licences and general deadlines), e.g. "Insurance expires on
 *     15th Dec 2026" or "License renewal in 14 days".
 *
 * The engine EXPLICITLY tracks and records the remaining distance/time/days
 * until a reminder triggers (reminders.remaining_value + remaining_updated_at)
 * and dispatches proactive WhatsApp alerts as thresholds approach
 * (75% / 25% / 5% / due-now / overdue) and on the expiry ladder
 * (30d / 14d / 7d / 24h / overdue), exactly once per tier.
 *
 * Global rule: distances are stored canonically as kilometres, hours as
 * decimal operating hours and dates as ISO YYYY-MM-DD plus a UTC due_at
 * resolved in the user's confirmed timezone. Display units adapt to the
 * vehicle unit_system (metric -> km, imperial -> mi).
 */

import { kmToUserDistance, userDistanceToKm, formatNumber, formatDate } from './globalization.js';
import { complianceCategory } from './complianceCatalog.js';
import {
  parseFlexibleDate,
  extractDatePhrase,
  zonedDateTimeToUtcIso,
  diffCalendarDays,
  SYSTEM_TIMEZONE
} from './dateParser.js';

const round1 = (n) => Math.round(Number(n) * 10) / 10;

const TIER_COLUMNS = {
  approach: 'notified_75p',
  warning: 'notified_25p',
  urgent: 'notified_5p',
  dueNow: 'notified_0p',
  overdue: 'notified_overdue'
};

/**
 * First-class expiry categories. Any time-bound obligation (insurance, MOT /
 * inspection, licensing, permits, driver licences, general deadlines) is a
 * reminder item with the same tiered monitoring as distance / operating hours.
 */
export const EXPIRY_CATEGORIES = Object.freeze({
  insurance: { label: 'Insurance', reminderType: 'Insurance Renewal', aliases: ['insurance', 'insure', 'cover note', 'policy'] },
  inspection: { label: 'Inspection / MOT', reminderType: 'Inspection', aliases: ['inspection', 'mot', 'ntac', 'roadworthiness', 'safety check'] },
  licensing: { label: 'Licensing', reminderType: 'Road License', aliases: ['license', 'licence', 'licensing', 'road tax', 'road license', 'registration renewal'] },
  permit: { label: 'Permit', reminderType: 'Permit', aliases: ['permit', 'transport permit', 'operator permit', 'route permit', 'special permit'] },
  driver_license: { label: 'Driver License', reminderType: 'Driver License', aliases: ['driver license', 'driver licence', 'drivers license', 'drivers licence', 'driving license', 'driving licence', 'dl renewal'] },
  maintenance: { label: 'Maintenance', reminderType: 'Service', aliases: ['service', 'oil change', 'brake', 'tyre', 'tire', 'filter', 'repair', 'maintenance', 'spare part'] },
  deadline: { label: 'Deadline', reminderType: 'Deadline', aliases: ['deadline', 'renewal', 'renew', 'expires', 'expiry', 'due'] },
  other: { label: 'Other', reminderType: 'Reminder', aliases: [] }
});

const CATEGORY_PRIORITY = ['driver_license', 'insurance', 'inspection', 'permit', 'licensing', 'maintenance'];

/**
 * Expiry notification ladder. `order` runs most-urgent first so a sweep that
 * missed a window still sends the single most relevant alert.
 */
export const EXPIRY_TIERS = Object.freeze([
  { key: 'notified_overdue', order: 0, minDays: Number.NEGATIVE_INFINITY, maxDays: -1, label: 'overdue' },
  { key: 'notified_24h', order: 1, minDays: 0, maxDays: 1, label: '24 hours' },
  { key: 'notified_7d', order: 2, minDays: 2, maxDays: 7, label: '7 days' },
  { key: 'notified_14d', order: 3, minDays: 8, maxDays: 14, label: '14 days' },
  { key: 'notified_30d', order: 4, minDays: 15, maxDays: 30, label: '30 days' }
]);

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Detect the compliance category of a phrase (word-boundary matched). */
export function detectExpiryCategory(text, fallback = 'other') {
  const clean = String(text || '').toLowerCase();
  if (!clean) return fallback;
  for (const key of CATEGORY_PRIORITY) {
    const aliases = EXPIRY_CATEGORIES[key]?.aliases || [];
    if (aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i').test(clean))) return key;
  }
  if (/\b(deadline|renewal|renew|expires?|expiry|due)\b/i.test(clean)) return 'deadline';
  return fallback;
}

/** Map a reminder type chosen in the quiz to its compliance category. */
export function categoryForReminderType(reminderType, fallback = 'other') {
  return detectExpiryCategory(reminderType, fallback);
}

/**
 * Parse a date-based expiry statement, e.g.
 *   "Insurance expires on 15th Dec 2026"
 *   "Inspection due next month"
 *   "License renewal in 14 days"
 * Returns { ok, kind: 'date', category, localDate, dueAt, timeZone, ... }.
 */
export function parseExpirySpec(text, {
  countryCode = 'GLOBAL',
  locale = 'en-US',
  now = new Date(),
  timeZone = SYSTEM_TIMEZONE
} = {}) {
  const extracted = extractDatePhrase(text, { countryCode, locale, now });
  if (!extracted.ok) return { ok: false, reason: 'no-date', error: extracted.error };
  const dueAt = zonedDateTimeToUtcIso(extracted.localDate, timeZone);
  return {
    ok: true,
    kind: 'date',
    category: detectExpiryCategory(text),
    localDate: extracted.localDate,
    iso: dueAt || extracted.iso,
    dueAt,
    timeZone,
    phrase: extracted.phrase,
    source: extracted.source,
    confidence: extracted.confidence
  };
}

/** Build an expiry spec from an already-canonical YYYY-MM-DD value. */
export function buildExpirySpecFromDate(localDate, { timeZone = SYSTEM_TIMEZONE } = {}) {
  const text = String(localDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, reason: 'invalid-date' };
  const dueAt = zonedDateTimeToUtcIso(text, timeZone);
  return {
    ok: true,
    kind: 'date',
    category: 'other',
    localDate: text,
    iso: dueAt,
    dueAt,
    timeZone,
    source: 'canonical',
    confidence: 'high'
  };
}

/** Human-readable expiry description with the confirming timezone. */
export function describeExpirySpec(spec, { locale = 'en-US' } = {}) {
  if (!spec?.localDate) return '';
  const tz = spec.timeZone || SYSTEM_TIMEZONE;
  const instant = spec.dueAt || zonedDateTimeToUtcIso(spec.localDate, tz);
  const pretty = instant ? formatDate(instant, locale, { timeZone: tz }) : spec.localDate;
  return `${pretty} (${tz})`;
}

/** ISO day (YYYY-MM-DD) for a reminder due date or timestamp. */
export function reminderDueDate(reminder) {
  const raw = reminder?.due_date || reminder?.due_at;
  if (!raw) return null;
  const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** Calendar days until an expiry (negative when already expired). */
export function daysUntilDue(dueDateLike, now = new Date()) {
  return diffCalendarDays(now, dueDateLike);
}

function nextExpiryTier(daysLeft, reminder) {
  const ordered = [...EXPIRY_TIERS].sort((a, b) => a.order - b.order);
  for (const tier of ordered) {
    if (reminder?.[tier.key]) continue;
    if (daysLeft >= tier.minDays && daysLeft <= tier.maxDays) return tier;
  }
  return null;
}

function expiryTierFlags(tier) {
  const flags = { [tier.key]: true };
  for (const candidate of EXPIRY_TIERS) {
    if (candidate.order > tier.order) flags[candidate.key] = true;
  }
  return flags;
}

/** Resolve the vehicle display unit system (default metric). */
export function resolveVehicleUnitSystem(vehicle) {
  return (vehicle?.unit_system || 'metric').toLowerCase() === 'imperial' ? 'imperial' : 'metric';
}

/**
 * Parse a maintenance threshold specification from user text.
 * Examples: "in 5000 km", "5000 kms", "3000 miles", "36 operating hours",
 * "in 36 engine hours", "1200 hrs", "at 45000 km", bare "45000".
 *
 * Returns { ok: true, kind: 'distance'|'hours', value, canonicalValue,
 *           inputUnit, displayUnit, relative } or { ok: false, reason }.
 * canonicalValue is kilometres for distance and hours for time.
 */
export function parseThresholdSpec(text, { unitSystem = 'metric' } = {}) {
  if (text === null || text === undefined) return { ok: false, reason: 'empty' };
  const clean = String(text).replace(/,/g, '').trim();
  if (!clean) return { ok: false, reason: 'empty' };

  const relative = /\b(?:in|after|every|within)\b/i.test(clean);

  // 1. Operating / engine hours: "36 operating hours", "in 36 engine hours", "36 hrs", "1200h"
  const hoursMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:operating|engine|machine|running|work)?\s*(?:hours?|hrs?|h)\b/i);
  if (hoursMatch) {
    const value = Number(hoursMatch[1]);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'invalid' };
    return {
      ok: true,
      kind: 'hours',
      value,
      canonicalValue: value,
      inputUnit: 'hours',
      displayUnit: 'hours',
      relative
    };
  }

  // 2. Distance with an explicit unit: "5000 km", "3000 miles"
  const distMatch = clean.match(/(\d+(?:\.\d+)?)\s*(kms?|kilometers?|kilometres?|miles?|mi)\b/i);
  if (distMatch) {
    const value = Number(distMatch[1]);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'invalid' };
    const isMile = /^miles?$|^mi$/i.test(distMatch[2]);
    const inputUnit = isMile ? 'mi' : 'km';
    const canonicalValue = userDistanceToKm(value, isMile ? 'imperial' : 'metric');
    return {
      ok: true,
      kind: 'distance',
      value,
      canonicalValue,
      inputUnit,
      displayUnit: inputUnit,
      relative
    };
  }

  // 3. Bare number -> distance in the vehicle/region unit system
  const bare = clean.match(/\d+(?:\.\d+)?/);
  if (bare) {
    const value = Number(bare[0]);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'invalid' };
    const imperial = unitSystem === 'imperial';
    const canonicalValue = userDistanceToKm(value, unitSystem);
    return {
      ok: true,
      kind: 'distance',
      value,
      canonicalValue,
      inputUnit: imperial ? 'mi' : 'km',
      displayUnit: imperial ? 'mi' : 'km',
      relative
    };
  }

  return { ok: false, reason: 'unrecognized' };
}

/**
 * Parse an operating-hours submission, e.g. "log 1250 engine hours",
 * "hours now 36.5", "update operating hours to 1200" or bare "1200".
 */
export function parseOperatingHours(text) {
  if (text === null || text === undefined) return null;
  const clean = String(text).replace(/,/g, '').trim();
  if (!clean) return null;

  const before = clean.match(/(\d+(?:\.\d+)?)\s*(?:operating|engine|machine|running|work)?\s*hours?\b/i);
  if (before) {
    const v = Number(before[1]);
    if (Number.isFinite(v) && v >= 0) return v;
  }

  const after = clean.match(/\b(?:operating|engine|machine|running)?\s*hours?\s*(?:at|now|reading|updated?\s*(?:to)?|=|:|is)?\s*(\d+(?:\.\d+)?)/i);
  if (after) {
    const v = Number(after[1]);
    if (Number.isFinite(v) && v >= 0) return v;
  }

  const bare = clean.match(/\d+(?:\.\d+)?/);
  if (bare) {
    const v = Number(bare[0]);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/** Human-readable description of a parsed threshold spec. */
export function describeThresholdSpec(spec) {
  if (!spec || spec.ok === false) return '';
  if (spec.kind === 'hours') return `${formatNumber(spec.value)} operating hours`;
  return `${formatNumber(spec.value)} ${spec.displayUnit || 'km'}`;
}

/**
 * Create a structured threshold reminder. The baseline (last_service_value)
 * is the vehicle's current reading, so remaining distance/time is tracked
 * from the moment of creation.
 */
export async function createThresholdReminder({ supabase, vehicle, profileId = null, reminderType = 'Service', spec, notes = null }) {
  if (!supabase || !vehicle?.id) return { ok: false, error: 'Vehicle or database unavailable.' };
  if (!spec || spec.ok === false) return { ok: false, error: 'Invalid threshold specification.' };

  const current = spec.kind === 'hours'
    ? Number(vehicle.operating_hours ?? vehicle.current_engine_hours ?? 0)
    : Number(vehicle.current_mileage ?? vehicle.odometer_reading ?? 0);
  const target = spec.relative ? round1(current + spec.canonicalValue) : round1(spec.canonicalValue);
  const remaining = round1(target - current);
  const unitSystem = resolveVehicleUnitSystem(vehicle);

  const row = {
    vehicle_id: vehicle.id,
    profile_id: profileId,
    reminder_type: reminderType,
    status: 'active',
    threshold_unit: spec.kind, // 'distance' | 'hours'
    threshold_input_unit: spec.inputUnit, // 'km' | 'mi' | 'hours'
    target_value: target,
    last_service_value: round1(current),
    remaining_value: remaining,
    remaining_updated_at: new Date().toISOString(),
    display_unit: spec.kind === 'hours' ? 'hours' : (unitSystem === 'imperial' ? 'mi' : 'km'),
    notes: notes || null,
    created_at: new Date().toISOString()
  };

  const { error } = await supabase.from('reminders').insert([row]);
  if (error) return { ok: false, error: error.message };
  return { ok: true, reminder: row };
}

/**
 * Create (or refresh) a first-class date-based expiry reminder.
 *
 * Linked items (insurance / inspection / driver licence) are upserted by their
 * canonical column so a vehicle never accumulates duplicate expiry rows, and
 * every date change RESETS the notification ladder.
 */
export async function createExpiryReminder({
  supabase,
  vehicle = null,
  profileId = null,
  reminderType = null,
  category = 'other',
  spec = null,
  notes = null,
  timeZone = SYSTEM_TIMEZONE,
  linkedColumn = null,
  subjectType = null,
  subjectId = null
}) {
  if (!supabase) return { ok: false, error: 'Database unavailable.' };
  if (!spec?.localDate) return { ok: false, error: 'Invalid expiry date.' };

  const resolvedCategory = EXPIRY_CATEGORIES[category] ? category : 'other';
  const resolvedSubjectType = subjectType || (vehicle?.id ? 'vehicle' : 'driver');
  const resolvedSubjectId = subjectId || vehicle?.id || profileId || null;
  const nowIso = new Date().toISOString();
  const dueDate = spec.localDate;
  const dueAt = spec.dueAt || zonedDateTimeToUtcIso(dueDate, timeZone);

  const row = {
    vehicle_id: vehicle?.id || null,
    profile_id: profileId,
    reminder_type: reminderType || EXPIRY_CATEGORIES[resolvedCategory].reminderType,
    category: resolvedCategory,
    kind: 'expiry',
    threshold_unit: 'date',
    due_date: dueDate,
    due_at: dueAt,
    timezone: timeZone,
    linked_column: linkedColumn,
    subject_type: resolvedSubjectType,
    subject_id: resolvedSubjectId,
    status: 'active',
    notes: notes || null,
    notified_30d: false,
    notified_14d: false,
    notified_7d: false,
    notified_24h: false,
    notified_overdue: false,
    remaining_value: daysUntilDue(dueDate),
    remaining_updated_at: nowIso,
    updated_at: nowIso
  };

  let existingId = null;
  if (linkedColumn) {
    let query = supabase
      .from('reminders')
      .select('id')
      .eq('status', 'active')
      .eq('linked_column', linkedColumn)
      .limit(1);
    if (vehicle?.id) query = query.eq('vehicle_id', vehicle.id);
    else if (resolvedSubjectId) query = query.eq('subject_id', resolvedSubjectId);
    const { data } = await query;
    const found = Array.isArray(data) ? data[0] : data;
    existingId = found?.id || null;
  }

  if (existingId) {
    const { error } = await supabase.from('reminders').update(row).eq('id', existingId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data: inserted, error } = await supabase.from('reminders').insert([row]).select();
    if (error) return { ok: false, error: error.message };
    const stored = Array.isArray(inserted) ? inserted[0] : inserted;
    existingId = stored?.id || null;
  }

  // Keep the canonical vehicle date column in sync for linked compliance items.
  if (vehicle?.id && linkedColumn && linkedColumn.startsWith('vehicles.')) {
    const column = linkedColumn.split('.')[1];
    try {
      await supabase.from('vehicles').update({ [column]: dueDate, updated_at: nowIso }).eq('id', vehicle.id);
    } catch (syncErr) {
      console.warn('[maintenanceReminders] Linked expiry sync skipped:', syncErr.message);
    }
  }

  return { ok: true, reminderId: existingId, updated: Boolean(existingId), reminder: { ...row, id: existingId } };
}

function buildAlertText({ vehicle, reminder, tier, remainingRatio, currentDisplay, targetDisplay, remainingDisplay, unitLabel }) {
  const plate = vehicle?.plate_number || 'Vehicle';
  const type = reminder?.reminder_type || 'Service';
  switch (tier) {
    case 'approach':
      return `\u{1F6E0}\uFE0F *Service Reminder (${plate})*\n${type} is approaching. Current: ${currentDisplay} ${unitLabel}, Target: ${targetDisplay} ${unitLabel} (${Math.round(remainingRatio * 100)}% remaining).`;
    case 'warning':
      return `\u26A0\uFE0F *Service Warning (${plate})*\n${type} due soon! Remaining: ${remainingDisplay} ${unitLabel}. Target: ${targetDisplay} ${unitLabel}.`;
    case 'urgent':
      return `\u{1F6A8} *URGENT Service Alert (${plate})*\n${type} due imminently! Remaining: ${remainingDisplay} ${unitLabel}.`;
    case 'dueNow':
      return `\u203C\uFE0F *CRITICAL: Service Due Now (${plate})*\n${type} reached target ${targetDisplay} ${unitLabel}! Perform service and reply "Renewed ${type}".`;
    case 'overdue':
      return `\u{1F6A8} *OVERDUE Service Alert (${plate})*\n${type} is OVERDUE by ${remainingDisplay} ${unitLabel}! Target was ${targetDisplay} ${unitLabel}, current is ${currentDisplay} ${unitLabel}.`;
    default:
      return null;
  }
}

/**
 * Evaluate a vehicle's active threshold reminders against its current
 * odometer / operating-hours readings. Persists remaining_value, marks each
 * notification tier once and dispatches WhatsApp alerts through sendFn.
 */
export async function evaluateVehicleReminders({ supabase, vehicle, sendFn = null, canDeliver = null }) {
  if (!supabase || !vehicle?.id) return { ok: false, error: 'Vehicle or database unavailable.' };

  const { data: activeReminders, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('vehicle_id', vehicle.id)
    .eq('status', 'active')
    .in('threshold_unit', ['distance', 'hours']);

  if (error || !activeReminders || activeReminders.length === 0) {
    return { ok: true, alerts: [], dispatched: 0, evaluated: 0 };
  }

  const unitSystem = resolveVehicleUnitSystem(vehicle);
  const nowIso = new Date().toISOString();
  const alerts = [];
  let dispatched = 0;

  for (const rem of activeReminders) {
    try {
      const current = rem.threshold_unit === 'hours'
        ? Number(vehicle.operating_hours ?? vehicle.current_engine_hours ?? 0)
        : Number(vehicle.current_mileage ?? vehicle.odometer_reading ?? 0);
      const target = Number(rem.target_value);
      const lastServ = Number(rem.last_service_value ?? 0);
      if (!Number.isFinite(target) || target <= 0) continue;

      const interval = target - lastServ;
      const remaining = target - current;
      const remainingRatio = interval > 0 ? remaining / interval : (remaining > 0 ? 1 : 0);

      // Explicitly record remaining distance/time until the reminder triggers.
      await supabase.from('reminders')
        .update({ remaining_value: round1(remaining), remaining_updated_at: nowIso })
        .eq('id', rem.id);

      let tier = null;
      if (remainingRatio <= 0.75 && remainingRatio > 0.25) tier = 'approach';
      else if (remainingRatio <= 0.25 && remainingRatio > 0.05) tier = 'warning';
      else if (remainingRatio <= 0.05 && remainingRatio > 0) tier = 'urgent';
      else if (remainingRatio <= 0 && remainingRatio > -0.05) tier = 'dueNow';
      else if (remainingRatio <= -0.05) tier = 'overdue';
      if (!tier) continue;

      const column = TIER_COLUMNS[tier];
      if (rem[column]) continue; // Tier already notified - no spam.

      const isHours = rem.threshold_unit === 'hours';
      const unitLabel = isHours ? 'operating hours' : (unitSystem === 'imperial' ? 'mi' : 'km');
      const display = (v) => (isHours
        ? formatNumber(Math.round(Math.abs(v)))
        : formatNumber(Math.round(Math.abs(kmToUserDistance(v, unitSystem)))));
      const text = buildAlertText({
        vehicle,
        reminder: rem,
        tier,
        remainingRatio,
        currentDisplay: display(current),
        targetDisplay: display(target),
        remainingDisplay: display(remaining),
        unitLabel
      });
      if (!text) continue;

      // Dispatch to owner and driver (unique phone numbers).
      const phones = [
        vehicle.owner_phone,
        vehicle.profiles?.phone_number,
        vehicle.assigned_driver_profile?.phone_number,
        vehicle.assigned_driver?.phone_number
      ].filter(Boolean);
      const seen = new Set();
      for (const phone of phones) {
        const key = String(phone).replace(/\D/g, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (canDeliver && !canDeliver(phone, vehicle)) continue;
        try {
          if (sendFn) await sendFn(phone, text, vehicle);
          dispatched += 1;
        } catch (sendErr) {
          console.warn('[maintenanceReminders] WhatsApp dispatch failed:', sendErr.message);
        }
      }

      await supabase.from('reminders').update({ [column]: true }).eq('id', rem.id);
      alerts.push({ reminderId: rem.id, tier, text, remaining: round1(remaining), unit: unitLabel });
    } catch (remErr) {
      console.warn('[maintenanceReminders] Evaluation failed for a reminder:', remErr.message);
    }
  }

  return { ok: true, alerts, dispatched, evaluated: activeReminders.length };
}

function buildExpiryAlertText({ plate, reminder, tier, daysLeft, dueLabel, category }) {
  const type = reminder?.reminder_type || EXPIRY_CATEGORIES[category]?.reminderType || 'Compliance item';
  const subject = category === 'driver_license' ? 'Driver licence' : type;
  const when = tier.key === 'notified_overdue'
    ? `expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago on ${dueLabel}`
    : daysLeft === 0
      ? `expires today (${dueLabel})`
      : daysLeft === 1
        ? `expires tomorrow (${dueLabel})`
        : `expires in ${daysLeft} days (${dueLabel})`;
  const emoji = tier.key === 'notified_overdue'
    ? '\u{1F6A8}'
    : tier.key === 'notified_24h'
      ? '\u23F0'
      : tier.key === 'notified_7d'
        ? '\u26A0\uFE0F'
        : '\u{1F6E1}\uFE0F';
  const headline = tier.key === 'notified_overdue' ? 'EXPIRED' : 'Expiry Reminder';
  return `${emoji} *${headline} (${plate})*\n${subject} ${when}. Reply "Renewed ${type}" once completed.`;
}

/**
 * Evaluate every active date-based reminder (insurance, inspection / MOT,
 * licensing, permits, driver licences and general deadlines) against its
 * target expiry. Dispatches the 30d -> 14d -> 7d -> 24h -> overdue ladder once
 * per tier to owners and assigned drivers, and writes an audit row to
 * expiry_notification_log for the Compliance report.
 */
export async function evaluateExpiryReminders({ supabase, sendFn = null, canDeliver = null, now = new Date() }) {
  const empty = { ok: true, evaluated: 0, alerts: [], dispatched: 0, overdue: 0 };
  if (!supabase) return { ...empty, ok: false, error: 'Database unavailable.' };

  const { data: allReminders, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('status', 'active')
    .limit(500);
  if (error) return { ...empty, ok: false, error: error.message };

  const reminders = (allReminders || []).filter((rem) => {
    if (!rem || !reminderDueDate(rem)) return false;
    const unit = String(rem.threshold_unit || '').toLowerCase();
    return unit !== 'distance' && unit !== 'hours';
  });
  if (reminders.length === 0) return empty;

  const vehicleIds = [...new Set(reminders.filter((r) => r.vehicle_id).map((r) => r.vehicle_id))];
  let vehicles = [];
  if (vehicleIds.length > 0) {
    const { data } = await supabase.from('vehicles').select('*').in('id', vehicleIds);
    vehicles = data || [];
  }
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  const driverSubjectIds = [...new Set(
    reminders
      .filter((r) => String(r.subject_type || '').toLowerCase() === 'driver' && r.subject_id)
      .map((r) => r.subject_id)
  )];
  let driverVehicles = [];
  if (driverSubjectIds.length > 0) {
    const { data } = await supabase.from('vehicles').select('*').in('assigned_driver_id', driverSubjectIds);
    driverVehicles = data || [];
  }

  const profileIds = new Set();
  for (const vehicle of [...vehicles, ...driverVehicles]) {
    if (vehicle.owner_id) profileIds.add(vehicle.owner_id);
    if (vehicle.assigned_driver_id) profileIds.add(vehicle.assigned_driver_id);
  }
  for (const id of driverSubjectIds) profileIds.add(id);
  let phoneById = new Map();
  if (profileIds.size > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, phone_number').in('id', [...profileIds]);
    phoneById = new Map((profiles || []).map((p) => [p.id, p.phone_number]));
  }

  const nowIso = new Date().toISOString();
  const alerts = [];
  let dispatched = 0;
  let overdue = 0;

  for (const rem of reminders) {
    try {
      const dueDate = reminderDueDate(rem);
      const daysLeft = daysUntilDue(dueDate, now);
      if (daysLeft === null) continue;
      if (daysLeft < 0) overdue += 1;

      const tier = nextExpiryTier(daysLeft, rem);
      if (!tier) continue;

      const isDriver = String(rem.subject_type || '').toLowerCase() === 'driver';
      const vehicle = rem.vehicle_id ? vehicleById.get(rem.vehicle_id) : null;
      const category = rem.category || 'other';
      const driverPlates = driverVehicles
        .filter((v) => v.assigned_driver_id === rem.subject_id)
        .map((v) => v.plate_number)
        .filter(Boolean);
      const text = buildExpiryAlertText({
        plate: isDriver ? (driverPlates.join(', ') || 'Assigned driver') : (vehicle?.plate_number || 'Fleet vehicle'),
        reminder: rem,
        tier,
        daysLeft,
        dueLabel: dueDate,
        category
      });

      const phones = [];
      if (isDriver) {
        const direct = phoneById.get(rem.subject_id);
        if (direct) phones.push(direct);
        for (const assigned of driverVehicles.filter((v) => v.assigned_driver_id === rem.subject_id)) {
          const ownerPhone = assigned.owner_phone || phoneById.get(assigned.owner_id);
          if (ownerPhone) phones.push(ownerPhone);
        }
      } else if (vehicle) {
        phones.push(vehicle.owner_phone, phoneById.get(vehicle.owner_id), phoneById.get(vehicle.assigned_driver_id));
      } else if (rem.profile_id) {
        phones.push(phoneById.get(rem.profile_id));
      }

      const seen = new Set();
      for (const phone of phones.filter(Boolean)) {
        const key = String(phone).replace(/\D/g, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (canDeliver && !canDeliver(phone, vehicle)) continue;
        try {
          if (sendFn) await sendFn(phone, text, vehicle);
          dispatched += 1;
          try {
            await supabase.from('expiry_notification_log').insert([{
              reminder_id: rem.id,
              vehicle_id: rem.vehicle_id || null,
              category,
              tier: tier.key,
              phone,
              channel: 'whatsapp',
              message: text,
              sent_at: nowIso
            }]);
          } catch (logErr) {
            console.warn('[maintenanceReminders] Expiry notification log skipped:', logErr.message);
          }
        } catch (sendErr) {
          console.warn('[maintenanceReminders] Expiry dispatch failed:', sendErr.message);
        }
      }

      await supabase.from('reminders').update({
        ...expiryTierFlags(tier),
        remaining_value: daysLeft,
        remaining_updated_at: nowIso,
        expiry_tier_at: nowIso,
        updated_at: nowIso
      }).eq('id', rem.id);

      alerts.push({ reminderId: rem.id, tier: tier.key, daysLeft, text, phones: seen.size });
    } catch (remErr) {
      console.warn('[maintenanceReminders] Expiry evaluation failed:', remErr.message);
    }
  }

  return { ok: true, evaluated: reminders.length, alerts, dispatched, overdue };
}

/**
 * Promote profiles.driver_license_expiry into first-class driver-linked
 * reminders so the universal expiry engine notifies both the driver and the
 * owners of every vehicle assigned to them.
 */
export async function syncDriverLicenseReminders({ supabase, limit = 500 } = {}) {
  if (!supabase) return { ok: false, synced: 0, error: 'Database unavailable.' };
  const { data: profiles, error } = await supabase.from('profiles').select('*').limit(limit);
  if (error) return { ok: false, synced: 0, error: error.message };

  const drivers = (profiles || []).filter((p) => p && p.driver_license_expiry && p.is_active !== false && !p.deleted_at);
  let synced = 0;
  for (const driver of drivers) {
    const timeZone = driver.timezone || SYSTEM_TIMEZONE;
    const spec = buildExpirySpecFromDate(String(driver.driver_license_expiry).slice(0, 10), { timeZone });
    if (!spec.ok) continue;
    const res = await createExpiryReminder({
      supabase,
      profileId: driver.id,
      subjectType: 'driver',
      subjectId: driver.id,
      reminderType: 'Driver License',
      category: 'driver_license',
      spec,
      linkedColumn: 'profiles.driver_license_expiry',
      timeZone
    });
    if (res.ok) synced += 1;
  }
  return { ok: true, synced };
}

/**
 * Record a new odometer reading (canonical km) and immediately evaluate the
 * vehicle's active distance reminders, dispatching proactive alerts.
 */
export async function applyOdometerReading({ supabase, vehicle, reading, inputUnit = 'km', sendFn = null, canDeliver = null }) {
  if (!supabase || !vehicle?.id) return { ok: false, error: 'Vehicle or database unavailable.' };
  const raw = Number(reading);
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: 'Invalid odometer reading.' };
  const canonical = userDistanceToKm(raw, inputUnit === 'mi' ? 'imperial' : 'metric');
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('vehicles').update({
    current_mileage: canonical,
    odometer_reading: canonical,
    updated_at: nowIso
  }).eq('id', vehicle.id);
  if (error) return { ok: false, error: error.message };

  const fresh = { ...vehicle, current_mileage: canonical, odometer_reading: canonical };
  const evaluation = await evaluateVehicleReminders({ supabase, vehicle: fresh, sendFn, canDeliver });
  return { ok: true, canonicalKm: canonical, ...evaluation };
}

/**
 * Record a new operating-hours submission and immediately evaluate the
 * vehicle's active hours reminders, dispatching proactive alerts.
 */
export async function applyOperatingHours({ supabase, vehicle, hours, sendFn = null, canDeliver = null }) {
  if (!supabase || !vehicle?.id) return { ok: false, error: 'Vehicle or database unavailable.' };
  const raw = Number(hours);
  if (!Number.isFinite(raw) || raw < 0) return { ok: false, error: 'Invalid operating hours.' };
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('vehicles').update({
    operating_hours: raw,
    hours_updated_at: nowIso,
    updated_at: nowIso
  }).eq('id', vehicle.id);
  if (error) return { ok: false, error: error.message };

  const fresh = { ...vehicle, operating_hours: raw };
  const evaluation = await evaluateVehicleReminders({ supabase, vehicle: fresh, sendFn, canDeliver });
  return { ok: true, canonicalHours: raw, ...evaluation };
}

/**
 * Background sweep (single entry point).
 *
 * 1. Threshold reminders: evaluate every active distance / operating-hours
 *    reminder against the vehicle's live readings.
 * 2. Driver licences: promote profiles.driver_license_expiry into reminders.
 * 3. Expiry ladder: evaluate insurance, inspection/MOT, licensing, permits,
 *    driver licences and general deadlines (30d / 14d / 7d / 24h / overdue).
 *
 * Runs every 30 minutes from index.js and can also be triggered on demand.
 */
export async function runReminderSweep({ supabase, sendFn = null, canDeliver = null, now = new Date() }) {
  if (!supabase) return { ok: false, error: 'Database unavailable.' };

  let vehiclesChecked = 0;
  let thresholdEvaluated = 0;
  let thresholdAlerts = 0;
  let thresholdDispatched = 0;

  const { data: reminders, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('status', 'active')
    .in('threshold_unit', ['distance', 'hours'])
    .limit(500);

  if (!error && reminders?.length) {
    const vehicleIds = [...new Set(reminders.map((r) => r.vehicle_id).filter(Boolean))];
    if (vehicleIds.length > 0) {
      const { data: vehicles } = await supabase.from('vehicles').select('*').in('id', vehicleIds);
      if (vehicles?.length) {
        vehiclesChecked = vehicles.length;
        const profileIds = [...new Set([
          ...vehicles.map((v) => v.owner_id),
          ...vehicles.map((v) => v.assigned_driver_id)
        ].filter(Boolean))];
        let phoneById = new Map();
        if (profileIds.length > 0) {
          const { data: profiles } = await supabase.from('profiles').select('id, phone_number').in('id', profileIds);
          phoneById = new Map((profiles || []).map((p) => [p.id, p.phone_number]));
        }

        for (const vehicle of vehicles) {
          const enriched = {
            ...vehicle,
            profiles: vehicle.owner_id && phoneById.get(vehicle.owner_id)
              ? { phone_number: phoneById.get(vehicle.owner_id) }
              : undefined,
            assigned_driver_profile: vehicle.assigned_driver_id && phoneById.get(vehicle.assigned_driver_id)
              ? { phone_number: phoneById.get(vehicle.assigned_driver_id) }
              : undefined
          };
          const res = await evaluateVehicleReminders({ supabase, vehicle: enriched, sendFn, canDeliver });
          thresholdEvaluated += res.evaluated || 0;
          thresholdAlerts += (res.alerts || []).length;
          thresholdDispatched += res.dispatched || 0;
        }
      }
    }
  }

  let driverSync = { synced: 0 };
  try {
    const legacySync = await syncDriverLicenseReminders({ supabase });
    const complianceSync = await syncDriverComplianceReminders({ supabase });
    driverSync = { synced: (legacySync.synced || 0) + (complianceSync.synced || 0) };
  } catch (syncErr) {
    console.warn('[maintenanceReminders] Driver compliance sync skipped:', syncErr.message);
  }

  let expiry = { evaluated: 0, alerts: [], dispatched: 0, overdue: 0 };
  try {
    expiry = await evaluateExpiryReminders({ supabase, sendFn, canDeliver, now });
  } catch (expiryErr) {
    console.warn('[maintenanceReminders] Expiry sweep failed:', expiryErr.message);
  }

  const expiryAlerts = (expiry.alerts || []).length;
  return {
    ok: true,
    vehiclesChecked,
    evaluated: thresholdEvaluated + (expiry.evaluated || 0),
    alerts: thresholdAlerts + expiryAlerts,
    dispatched: thresholdDispatched + (expiry.dispatched || 0),
    threshold: {
      vehiclesChecked,
      evaluated: thresholdEvaluated,
      alerts: thresholdAlerts,
      dispatched: thresholdDispatched
    },
    expiry: {
      evaluated: expiry.evaluated || 0,
      alerts: expiryAlerts,
      dispatched: expiry.dispatched || 0,
      overdue: expiry.overdue || 0
    },
    driverRemindersSynced: driverSync.synced || 0
  };
}

/**
 * Promote driver_compliances (minimal + additional items with an expiry) into
 * first-class driver-linked reminders. Lifetime items need no reminder.
 */
export async function syncDriverComplianceReminders({ supabase, limit = 500 } = {}) {
  if (!supabase) return { ok: false, synced: 0, error: 'Database unavailable.' };
  const { data, error } = await supabase.from('driver_compliances').select('*').limit(limit);
  if (error) return { ok: false, synced: 0, error: error.message };

  const items = (data || []).filter((row) => row && row.driver_id && row.expiry && row.lifetime !== true);
  let synced = 0;
  for (const item of items) {
    const timeZone = item.time_zone || SYSTEM_TIMEZONE;
    const spec = buildExpirySpecFromDate(String(item.expiry).slice(0, 10), { timeZone });
    if (!spec.ok) continue;
    const res = await createExpiryReminder({
      supabase,
      profileId: item.driver_id,
      subjectType: 'driver',
      subjectId: item.driver_id,
      reminderType: item.label || item.type,
      category: complianceCategory(item.type),
      spec,
      linkedColumn: `driver_compliances:${item.type}`,
      timeZone
    });
    if (res.ok) synced += 1;
  }
  return { ok: true, synced };
}

export default {
  parseThresholdSpec,
  parseOperatingHours,
  describeThresholdSpec,
  resolveVehicleUnitSystem,
  createThresholdReminder,
  evaluateVehicleReminders,
  applyOdometerReading,
  applyOperatingHours,
  runReminderSweep,
  parseExpirySpec,
  buildExpirySpecFromDate,
  describeExpirySpec,
  detectExpiryCategory,
  categoryForReminderType,
  createExpiryReminder,
  evaluateExpiryReminders,
  syncDriverLicenseReminders,
  syncDriverComplianceReminders,
  reminderDueDate,
  daysUntilDue,
  EXPIRY_CATEGORIES,
  EXPIRY_TIERS
};

