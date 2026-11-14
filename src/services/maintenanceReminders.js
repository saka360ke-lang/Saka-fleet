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
// v1.59.7 — reminders can carry the same optional label as any other entry.
import { sanitizeEntryLabel } from './entryLabels.js';
// v1.63.1 — reminder writes land through the shared after-write hook.
import { markUserDataChanged } from './afterWrite.js';
// v1.97.8 — a reminder whose vehicle row is gone reports `missingVehicle`
// instead of surfacing a raw FK error (rule 51).
import { isMissingVehicleError, MISSING_VEHICLE_NOTICE } from './vehicleWriteGuard.js';
import {
  parseFlexibleDate,
  extractDatePhrase,
  zonedDateTimeToUtcIso,
  diffCalendarDays,
  SYSTEM_TIMEZONE
} from './dateParser.js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';

/* ------------------------------------------------------------------ */
/* v1.92.0 (Phase 29) — overdue compliance digest                      */
/* ------------------------------------------------------------------ */
/*
 * D1 (HYBRID): the FIRST overdue item of an episode still fires its immediate
 * one-shot alert; every subsequent item in that episode is stamped but NOT
 * sent, and the owner receives ONE digest at T+3 and ONE at T+7 — three
 * messages maximum per episode regardless of N items. The episode anchor is
 * the FIRST item's due date and never moves while anything stays overdue; when
 * the owner has zero overdue items the row resets, so a genuinely new episode
 * starts a fresh clock.
 */

export const OVERDUE_DIGEST_TABLE = 'overdue_digest_log';
export const OVERDUE_DIGEST_T3_DAYS = 3;
export const OVERDUE_DIGEST_T7_DAYS = 7;

export const OVERDUE_DIGEST_SQL = `
CREATE TABLE IF NOT EXISTS public.overdue_digest_log (
    owner_id uuid PRIMARY KEY,
    first_overdue_at timestamp with time zone,
    sent_t3_at timestamp with time zone,
    sent_t7_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.overdue_digest_log ENABLE ROW LEVEL SECURITY;
`;

let overdueDigestTableReady = false;

/** Idempotent DDL probe (rule 50): a missing table simply disables the digest. */
export async function ensureOverdueDigestTable(providedSupabase) {
  if (!providedSupabase) return { status: 'no_client' };
  try {
    const { error } = await providedSupabase.from(OVERDUE_DIGEST_TABLE).select('owner_id').limit(1);
    if (!error) {
      overdueDigestTableReady = true;
      return { status: 'exists' };
    }
  } catch (err) {
    console.warn('[maintenanceReminders] overdue digest probe failed (falling through to DDL):', err.message);
  }
  if (hasSqlAccess()) {
    const result = await runSql(OVERDUE_DIGEST_SQL, { label: 'ensureOverdueDigestTable' });
    if (result.ok) {
      overdueDigestTableReady = true;
      return { status: 'created' };
    }
  }
  return { status: 'missing' };
}

export function isOverdueDigestTableReady() {
  return overdueDigestTableReady;
}

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

/** Human-readable description of a parsed threshold spec (v1.28.7). */
export function describeThresholdSpec(spec, { relative = null } = {}) {
  if (!spec || spec.ok === false) return '';
  const isRelative = relative === null ? Boolean(spec.relative) : Boolean(relative);
  const prefix = isRelative ? 'in ' : 'at ';
  if (spec.kind === 'hours') return `${prefix}${formatNumber(spec.value)} operating hours`;
  return `${prefix}${formatNumber(spec.value)} ${spec.displayUnit || 'km'}`;
}

/**
 * Create a structured threshold reminder. The baseline (last_service_value)
 * is the vehicle's current reading, so remaining distance/time is tracked
 * from the moment of creation.
 */
export async function createThresholdReminder({ supabase, vehicle, profileId = null, reminderType = 'Service', spec, notes = null, label = null }) {
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
    label: sanitizeEntryLabel(label),
    created_at: new Date().toISOString()
  };

  let { error } = await supabase.from('reminders').insert([row]);
  // Rule 50 — an un-migrated label column must never block the reminder.
  if (error && /column|schema|does not exist/i.test(error.message || '')) {
    const { label: _dropped, ...legacy } = row;
    ({ error } = await supabase.from('reminders').insert([legacy]));
  }
  if (error) {
    // v1.97.8 — the vehicle row is gone: report it so the engine can start
    // registration instead of dead-ending on an FK message (rule 51).
    if (isMissingVehicleError(error)) return { ok: false, missingVehicle: true, error: MISSING_VEHICLE_NOTICE };
    return { ok: false, error: error.message };
  }
  // v1.63.1 — a new reminder changes the user's upcoming-reminders facts.
  markUserDataChanged({ supabase, ownerId: vehicle?.owner_id || profileId || null, reason: 'reminders.createThreshold' });
  return { ok: true, reminder: row };
}

/**
 * Strip the ladder flags from an upsert so an UNCHANGED due date keeps its
 * already-consumed tiers (v1.73.2, 12A — §28.4 reset-on-change contract).
 */
function expiryRowWithoutTierFlags(row = {}) {
  const { notified_30d, notified_14d, notified_7d, notified_24h, notified_overdue, ...rest } = row;
  return rest;
}

/**
 * Create (or refresh) a first-class date-based expiry reminder.
 *
 * Linked items (insurance / inspection / driver licence) are upserted by their
 * canonical column so a vehicle never accumulates duplicate expiry rows, and
 * every date CHANGE resets the notification ladder. Re-upserting the same date
 * (the driver-compliance sync runs every 30 minutes) preserves the consumed
 * tier flags instead of re-firing an alert the user already received.
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
  subjectId = null,
  label = null
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
    label: sanitizeEntryLabel(label),
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
  let existingDueDate = null;
  if (linkedColumn) {
    let query = supabase
      .from('reminders')
      .select('id, due_date')
      .eq('status', 'active')
      .eq('linked_column', linkedColumn)
      .limit(1);
    if (vehicle?.id) query = query.eq('vehicle_id', vehicle.id);
    else if (resolvedSubjectId) query = query.eq('subject_id', resolvedSubjectId);
    const { data } = await query;
    const found = Array.isArray(data) ? data[0] : data;
    existingId = found?.id || null;
    existingDueDate = found?.due_date ? String(found.due_date).slice(0, 10) : null;
  }

  // v1.73.2 (12A) — §28.4 contract: ONLY a changed due date resets the
  // 30d/14d/7d/24h/overdue ladder. The driver-compliance sync re-upserts the
  // same linked row every 30 minutes; resetting the tier flags on an unchanged
  // date made the same tier re-fire on every sweep (duplicate alerts). An
  // unchanged date now keeps its consumed-tier flags; a real date change still
  // resets the whole ladder exactly as before.
  const dateChanged = !existingId || !existingDueDate || existingDueDate !== dueDate;
  const ladderReset = Boolean(existingId) && dateChanged;

  if (existingId) {
    const updateRow = dateChanged ? row : expiryRowWithoutTierFlags(row);
    let { error } = await supabase.from('reminders').update(updateRow).eq('id', existingId);
    if (error && /column|schema|does not exist/i.test(error.message || '')) {
      const { label: _dropped, ...legacy } = updateRow;
      ({ error } = await supabase.from('reminders').update(legacy).eq('id', existingId));
    }
    if (error) {
      if (isMissingVehicleError(error)) return { ok: false, missingVehicle: true, error: MISSING_VEHICLE_NOTICE };
      return { ok: false, error: error.message };
    }
  } else {
    let { data: inserted, error } = await supabase.from('reminders').insert([row]).select();
    if (error && /column|schema|does not exist/i.test(error.message || '')) {
      const { label: _dropped, ...legacy } = row;
      ({ data: inserted, error } = await supabase.from('reminders').insert([legacy]).select());
    }
    if (error) {
      if (isMissingVehicleError(error)) return { ok: false, missingVehicle: true, error: MISSING_VEHICLE_NOTICE };
      return { ok: false, error: error.message };
    }
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

  // v1.63.1 — a created/refreshed expiry changes the user's expiry facts.
  markUserDataChanged({ supabase, ownerId: vehicle?.owner_id || profileId || null, reason: 'reminders.createExpiry' });
  return {
    ok: true,
    reminderId: existingId,
    updated: Boolean(existingId),
    dateChanged,
    ladderReset,
    reminder: { ...row, id: existingId }
  };
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
          if (sendFn) await sendFn(phone, text, vehicle, 'service_reminder', { plate: vehicle?.plate_number || null });
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
  const empty = { ok: true, evaluated: 0, alerts: [], dispatched: 0, overdue: 0, profileIds: [] };
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

  // v1.92.0 (Phase 29, D1 HYBRID) — load every live overdue episode for the
  // owners this sweep touches. An owner WITH an episode receives only the
  // digest for later items; the FIRST item of an episode still sends normally.
  const digestEpisodes = new Set();
  const firstOverdueSent = new Set();
  const hasOverdueReminder = reminders.some((rem) => (daysUntilDue(reminderDueDate(rem), now) ?? 0) < 0);
  if (hasOverdueReminder) {
    const episodeOwners = [...new Set([
      ...vehicles.map((v) => v.owner_id),
      ...driverVehicles.map((v) => v.owner_id)
    ].filter(Boolean))];
    if (episodeOwners.length > 0) {
      try {
        const { data: digestRows, error: digestErr } = await supabase
          .from(OVERDUE_DIGEST_TABLE)
          .select('owner_id, first_overdue_at')
          .in('owner_id', episodeOwners);
        if (!digestErr) {
          for (const row of digestRows || []) {
            if (row?.owner_id && row.first_overdue_at) digestEpisodes.add(row.owner_id);
          }
        }
      } catch (episodeErr) {
        console.warn('[maintenanceReminders] Overdue digest episodes unavailable (suppression off):', episodeErr.message);
      }
    }
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
      const ownerIdsForReminder = isDriver
        ? [...new Set(driverVehicles.filter((v) => v.assigned_driver_id === rem.subject_id).map((v) => v.owner_id).filter(Boolean))]
        : [...new Set([vehicle?.owner_id, rem.profile_id].filter(Boolean))];

      // D1 HYBRID (v1.92.0) — once an episode is live (or its first alert went
      // out earlier THIS sweep), only the first overdue item sends an immediate
      // WhatsApp; every later item is stamped but rides the T+3 / T+7 digest.
      if (tier.key === 'notified_overdue'
        && ownerIdsForReminder.some((id) => digestEpisodes.has(id) || firstOverdueSent.has(id))) {
        await supabase.from('reminders').update({
          ...expiryTierFlags(tier),
          remaining_value: daysLeft,
          remaining_updated_at: nowIso,
          expiry_tier_at: nowIso,
          updated_at: nowIso
        }).eq('id', rem.id);
        alerts.push({ reminderId: rem.id, tier: tier.key, daysLeft, text: '', phones: 0, suppressed: true });
        continue;
      }

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
          if (sendFn) await sendFn(phone, text, vehicle, 'expiry_reminder', { item: String(rem?.label || rem?.type || category || 'document'), due: Number.isFinite(daysLeft) ? (daysLeft > 0 ? 'in ' + daysLeft + ' day(s)' : (daysLeft === 0 ? 'today' : 'now overdue')) : '' });
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

      // The first alert of an episode opens the window: any later overdue item
      // in this same sweep is suppressed above (owner cap = 1 immediate + 2 digests).
      if (tier.key === 'notified_overdue') {
        for (const id of ownerIdsForReminder) firstOverdueSent.add(id);
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

  // v1.63.1 — additive field: the profiles whose reminders this sweep touched
  // (owners + assigned drivers + driver-subject profiles), so the sweep can
  // invalidate exactly those cached contexts.
  return { ok: true, evaluated: reminders.length, alerts, dispatched, overdue, profileIds: [...profileIds] };
}

/**
 * Retire the legacy `profiles.driver_license_expiry` reminder for one driver
 * (v1.73.2, 12A — D2). Once a canonical `driver_compliances` licence row owns
 * the ladder, the profile-mirror reminder is a duplicate and must stop firing.
 * Idempotent, never throws.
 */
export async function retireLegacyDriverLicenceReminder({ supabase, driverId, now = new Date() } = {}) {
  if (!supabase || !driverId) return { ok: false, retired: 0 };
  try {
    const { data } = await supabase
      .from('reminders')
      .select('id')
      .eq('status', 'active')
      .eq('linked_column', 'profiles.driver_license_expiry')
      .eq('subject_type', 'driver')
      .eq('subject_id', driverId);
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    let retired = 0;
    for (const row of rows) {
      if (!row?.id) continue;
      const { error } = await supabase
        .from('reminders')
        .update({ status: 'cancelled', updated_at: new Date(now).toISOString() })
        .eq('id', row.id);
      if (!error) retired += 1;
    }
    return { ok: true, retired };
  } catch (err) {
    return { ok: false, retired: 0, error: err?.message || 'retire_failed' };
  }
}

/**
 * Promote EVERY driver compliance row with an expiry into a first-class
 * driver-linked reminder (licences, PSV badges, PDP, CPC, operator cards,
 * medicals — every catalog type), and keep the legacy
 * `profiles.driver_license_expiry` mirror alive only for drivers who have no
 * driver_compliances licence row.
 *
 * v1.73.2 (12A) — merged from syncDriverLicenseReminders() +
 * syncDriverComplianceReminders() and hardened:
 *  - dedupe key: (subject_id, subject_type, category, linked_column) — one
 *    reminder per document TYPE, never one per category (psv_badge / pdp /
 *    operator_cert all map to category 'permit' and must stay separate rows);
 *  - a synced `driver_compliances:<licence type>` row supersedes (cancels) the
 *    legacy `profiles.driver_license_expiry` reminder — one ladder per licence;
 *  - legacy-only drivers (no compliance row) keep their profile reminder
 *    (rule 56 — existing users must never lose coverage);
 *  - lifetime rows need no reminder; rows without a number are skipped; rows
 *    already EXPIRED are never promoted into a NEW reminder (narrow reading of
 *    §28.5 — existing active reminders still fire their own overdue tier in
 *    evaluateExpiryReminders()).
 */
export async function syncAllDriverComplianceReminders({ supabase, limit = 500, now = new Date() } = {}) {
  if (!supabase) return { ok: false, synced: 0, deactivated: 0, skipped: 0, error: 'Database unavailable.' };
  const { data, error } = await supabase.from('driver_compliances').select('*').limit(limit);
  if (error) return { ok: false, synced: 0, deactivated: 0, skipped: 0, error: error.message };

  const items = (data || []).filter((row) => row && row.driver_id && row.expiry && row.lifetime !== true);
  let synced = 0;
  let deactivated = 0;
  let skipped = 0;
  const licenceDriverIds = new Set();
  for (const item of items) {
    // A document with no number is not a usable compliance record — no ladder.
    if (!String(item.number || '').trim()) { skipped += 1; continue; }
    const timeZone = item.time_zone || SYSTEM_TIMEZONE;
    const dueDate = String(item.expiry).slice(0, 10);
    const spec = buildExpirySpecFromDate(dueDate, { timeZone });
    if (!spec.ok) { skipped += 1; continue; }
    // D1 — never mint a NEW reminder for an already-past row.
    if (daysUntilDue(dueDate, now) < 0) { skipped += 1; continue; }
    const category = complianceCategory(item.type);
    const res = await createExpiryReminder({
      supabase,
      profileId: item.driver_id,
      subjectType: 'driver',
      subjectId: item.driver_id,
      reminderType: item.label || item.type,
      category,
      spec,
      linkedColumn: `driver_compliances:${item.type}`,
      timeZone
    });
    if (res.ok) {
      synced += 1;
      // Only a licence row that actually owns a live reminder may retire the
      // profile mirror. If it was skipped (past/lifetime/no number) the legacy
      // column stays the driver's only source and keeps its reminder.
      if (category === 'driver_license') licenceDriverIds.add(item.driver_id);
    }
  }

  // Legacy profile mirror (v1.9 behaviour, kept for rule 56).
  const { data: profiles, error: profileError } = await supabase.from('profiles').select('*').limit(limit);
  const drivers = (profiles || []).filter((p) => p && p.driver_license_expiry && p.is_active !== false && !p.deleted_at);
  for (const driver of drivers) {
    if (licenceDriverIds.has(driver.id)) {
      const retired = await retireLegacyDriverLicenceReminder({ supabase, driverId: driver.id, now });
      deactivated += retired.retired || 0;
      continue;
    }
    const timeZone = driver.timezone || SYSTEM_TIMEZONE;
    const dueDate = String(driver.driver_license_expiry).slice(0, 10);
    const spec = buildExpirySpecFromDate(dueDate, { timeZone });
    if (!spec.ok) { skipped += 1; continue; }
    if (daysUntilDue(dueDate, now) < 0) { skipped += 1; continue; }
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
  if (profileError) {
    return { ok: true, synced, deactivated, skipped, warning: profileError.message };
  }
  return { ok: true, synced, deactivated, skipped };
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
  // v1.97.8 — a zero-row update means the vehicle row is gone: never report a
  // saved odometer for an asset that no longer exists (rule 51).
  const { data: updatedRows, error } = await supabase.from('vehicles').update({
    current_mileage: canonical,
    odometer_reading: canonical,
    updated_at: nowIso
  }).eq('id', vehicle.id).select('id');
  if (error) return { ok: false, error: error.message };
  if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
    return { ok: false, missingVehicle: true, error: MISSING_VEHICLE_NOTICE };
  }

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
  // v1.97.8 — same zero-row vehicle-gone guard as the odometer lane (rule 51).
  const { data: updatedRows, error } = await supabase.from('vehicles').update({
    operating_hours: raw,
    hours_updated_at: nowIso,
    updated_at: nowIso
  }).eq('id', vehicle.id).select('id');
  if (error) return { ok: false, error: error.message };
  if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
    return { ok: false, missingVehicle: true, error: MISSING_VEHICLE_NOTICE };
  }

  const fresh = { ...vehicle, operating_hours: raw };
  const evaluation = await evaluateVehicleReminders({ supabase, vehicle: fresh, sendFn, canDeliver });
  return { ok: true, canonicalHours: raw, ...evaluation };
}

/**
 * v1.92.0 (Phase 29) — ONE consolidated overdue digest per owner per milestone.
 *
 * Runs as the fourth pass of `runReminderSweep` (after the expiry ladder). The
 * overdue set is recomputed from LIVE active reminders on every sweep, so a
 * renewal (due date moved, reminder completed/cancelled) leaves the episode
 * automatically: nothing overdue → the row resets and no further digest fires.
 * Milestones are per-episode and at-most-once: T+3 (`sent_t3_at`) and T+7
 * (`sent_t7_at`); an owner who clears everything resets, and a genuinely new
 * overdue item later starts a fresh clock. Never throws.
 */
export async function evaluateOverdueDigest({ supabase, sendFn = null, canDeliver = null, now = new Date() }) {
  const empty = {
    ok: true, evaluated: 0, owners: 0, overdueItems: 0,
    sentT3: 0, sentT7: 0, dispatched: 0, reset: 0, profileIds: []
  };
  if (!supabase) return { ...empty, ok: false, error: 'Database unavailable.' };

  let allReminders = [];
  try {
    const { data, error } = await supabase
      .from('reminders')
      .select('*')
      .eq('status', 'active')
      .limit(1000);
    if (error) return { ...empty, ok: false, error: error.message };
    allReminders = data || [];
  } catch (err) {
    return { ...empty, ok: false, error: err.message };
  }

  const reminders = allReminders.filter((rem) => {
    if (!rem || !reminderDueDate(rem)) return false;
    const unit = String(rem.threshold_unit || '').toLowerCase();
    return unit !== 'distance' && unit !== 'hours';
  });
  if (reminders.length === 0) {
    // No active date reminder exists anywhere ⇒ no overdue item can exist, so
    // every episode row is stale. Clear them (bounded table, rule 50 safe).
    let reset = 0;
    try {
      const { data: rows } = await supabase.from(OVERDUE_DIGEST_TABLE).select('owner_id').limit(500);
      for (const row of rows || []) {
        if (!row?.owner_id) continue;
        const { error } = await supabase.from(OVERDUE_DIGEST_TABLE).delete().eq('owner_id', row.owner_id);
        if (!error) reset += 1;
      }
    } catch (clearErr) {
      console.warn('[maintenanceReminders] Overdue digest reset skipped:', clearErr.message);
    }
    return { ...empty, reset };
  }

  // Vehicles: the reminder's own vehicle + every vehicle a driver-subject
  // reminder rides on (mirrors evaluateExpiryReminders).
  const vehicleIds = [...new Set(reminders.filter((r) => r.vehicle_id).map((r) => r.vehicle_id))];
  let vehicles = [];
  if (vehicleIds.length > 0) {
    try {
      const { data } = await supabase.from('vehicles').select('*').in('id', vehicleIds);
      vehicles = data || [];
    } catch { vehicles = []; }
  }
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  const driverSubjectIds = [...new Set(
    reminders
      .filter((r) => String(r.subject_type || '').toLowerCase() === 'driver' && r.subject_id)
      .map((r) => r.subject_id)
  )];
  let driverVehicles = [];
  if (driverSubjectIds.length > 0) {
    try {
      const { data } = await supabase.from('vehicles').select('*').in('assigned_driver_id', driverSubjectIds);
      driverVehicles = data || [];
    } catch { driverVehicles = []; }
  }

  /** Every owner this pass truly evaluated (used for the safe episode reset). */
  const evaluatedOwners = new Set();
  for (const vehicle of [...vehicles, ...driverVehicles]) {
    if (vehicle.owner_id) evaluatedOwners.add(vehicle.owner_id);
  }

  /** owner_id → overdue items (label, daysLeft, dueDate). */
  const groups = new Map();
  let overdueItems = 0;
  for (const rem of reminders) {
    const dueDate = reminderDueDate(rem);
    const daysLeft = daysUntilDue(dueDate, now);
    if (daysLeft === null || daysLeft >= 0) continue;
    const isDriver = String(rem.subject_type || '').toLowerCase() === 'driver';
    const vehicle = rem.vehicle_id ? vehicleById.get(rem.vehicle_id) : null;
    let owners = [];
    let plate = vehicle?.plate_number || null;
    if (isDriver) {
      const assigned = driverVehicles.filter((v) => v.assigned_driver_id === rem.subject_id);
      owners = assigned.map((v) => v.owner_id).filter(Boolean);
      const plates = assigned.map((v) => v.plate_number).filter(Boolean);
      plate = plates.length ? plates.join(', ') : null;
    } else if (vehicle?.owner_id) {
      owners = [vehicle.owner_id];
    } else if (rem.profile_id) {
      owners = [rem.profile_id];
    }
    const baseLabel = rem.label || rem.reminder_type || EXPIRY_CATEGORIES[rem.category]?.label || 'Compliance item';
    for (const ownerId of new Set(owners)) {
      evaluatedOwners.add(ownerId);
      const items = groups.get(ownerId) || [];
      items.push({ label: plate ? `${baseLabel} (${plate})` : baseLabel, daysLeft, dueDate });
      groups.set(ownerId, items);
      overdueItems += 1;
    }
  }

  // Episode rows for every evaluated owner + the phone of each digest recipient.
  let digestRows = [];
  try {
    const { data, error } = await supabase.from(OVERDUE_DIGEST_TABLE).select('*').limit(500);
    if (!error) digestRows = data || [];
  } catch { digestRows = []; }
  const rowByOwner = new Map(digestRows.map((row) => [row.owner_id, row]));

  let phoneById = new Map();
  if (evaluatedOwners.size > 0) {
    try {
      const { data } = await supabase.from('profiles').select('id, phone_number').in('id', [...evaluatedOwners]);
      phoneById = new Map((data || []).map((p) => [p.id, p.phone_number]));
    } catch { phoneById = new Map(); }
  }

  const nowIso = new Date(now).toISOString();
  let sentT3 = 0;
  let sentT7 = 0;
  let dispatched = 0;
  const profileIds = [];
  for (const [ownerId, items] of groups.entries()) {
    try {
      const anchorDue = items.map((item) => item.dueDate).sort()[0];
      const existing = rowByOwner.get(ownerId);
      const anchorIso = existing?.first_overdue_at
        ? String(existing.first_overdue_at)
        : `${anchorDue}T00:00:00.000Z`;
      if (!existing) {
        await supabase.from(OVERDUE_DIGEST_TABLE).insert([{
          owner_id: ownerId,
          first_overdue_at: anchorIso,
          created_at: nowIso,
          updated_at: nowIso
        }]);
      }
      // Calendar days since the episode's FIRST overdue item went due.
      const daysSinceFirst = -(daysUntilDue(anchorIso, now) ?? 0);
      const worst = items.reduce((a, b) => (a.daysLeft <= b.daysLeft ? a : b), items[0]);
      const count = items.length;
      const worstDays = Math.abs(worst.daysLeft);
      const milestone = (!existing?.sent_t7_at && daysSinceFirst >= OVERDUE_DIGEST_T7_DAYS)
        ? 't7'
        : (!existing?.sent_t3_at && daysSinceFirst >= OVERDUE_DIGEST_T3_DAYS)
          ? 't3'
          : null;
      if (!milestone) continue;

      const text = `\u{1F6A8} *Overdue compliance digest*\n\nYou have *${count}* overdue compliance item${count === 1 ? '' : 's'}. The oldest is *${worst.label}* — *${worstDays}* day${worstDays === 1 ? '' : 's'} past due.\n\nReply *reminders* to see them all, and "Renewed <item>" once sorted.`;
      const phone = phoneById.get(ownerId);
      if (sendFn && phone && (!canDeliver || canDeliver(phone, null))) {
        try {
          await sendFn(phone, text, null, 'overdue_digest', {
            count: String(count),
            worst_item: String(worst.label),
            worst_days: String(worstDays)
          });
          dispatched += 1;
        } catch (sendErr) {
          console.warn('[maintenanceReminders] Overdue digest dispatch failed:', sendErr.message);
        }
      }

      // A single send can satisfy both milestones when the sweep missed T+3 —
      // stamping both keeps two digests from landing back-to-back.
      const patch = { updated_at: nowIso };
      if (milestone === 't7') {
        patch.sent_t7_at = nowIso;
        if (!existing?.sent_t3_at) patch.sent_t3_at = nowIso;
        sentT7 += 1;
      } else {
        patch.sent_t3_at = nowIso;
        sentT3 += 1;
      }
      await supabase.from(OVERDUE_DIGEST_TABLE).update(patch).eq('owner_id', ownerId);
      profileIds.push(ownerId);
    } catch (ownerErr) {
      console.warn('[maintenanceReminders] Overdue digest evaluation failed:', ownerErr.message);
    }
  }

  // Safe episode reset: an owner this pass evaluated who has ZERO overdue items
  // has closed their episode. Owners outside the bounded read are never touched.
  let reset = 0;
  for (const row of digestRows) {
    if (!evaluatedOwners.has(row.owner_id) || groups.has(row.owner_id)) continue;
    try {
      const { error } = await supabase.from(OVERDUE_DIGEST_TABLE).delete().eq('owner_id', row.owner_id);
      if (!error) reset += 1;
    } catch (delErr) {
      console.warn('[maintenanceReminders] Overdue digest reset failed:', delErr.message);
    }
  }

  return {
    ok: true,
    evaluated: reminders.length,
    owners: groups.size,
    overdueItems,
    sentT3,
    sentT7,
    dispatched,
    reset,
    profileIds
  };
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
  // v1.63.1 — every profile whose reminder facts this sweep mutates.
  const sweptProfileIds = new Set();

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
        for (const v of vehicles) {
          if (v.owner_id) sweptProfileIds.add(v.owner_id);
          if (v.assigned_driver_id) sweptProfileIds.add(v.assigned_driver_id);
        }
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

  let driverSync = { synced: 0, deactivated: 0, skipped: 0 };
  try {
    driverSync = await syncAllDriverComplianceReminders({ supabase, now });
  } catch (syncErr) {
    console.warn('[maintenanceReminders] Driver compliance sync skipped:', syncErr.message);
  }

  let expiry = { evaluated: 0, alerts: [], dispatched: 0, overdue: 0 };
  try {
    expiry = await evaluateExpiryReminders({ supabase, sendFn, canDeliver, now });
  } catch (expiryErr) {
    console.warn('[maintenanceReminders] Expiry sweep failed:', expiryErr.message);
  }

  // v1.92.0 (Phase 29) — pass 4: ONE consolidated overdue digest per owner at
  // T+3 / T+7 of an episode (runs after expiry so the episode's first item has
  // already sent its immediate alert).
  let digest = { evaluated: 0, owners: 0, overdueItems: 0, sentT3: 0, sentT7: 0, dispatched: 0, reset: 0, profileIds: [] };
  try {
    digest = await evaluateOverdueDigest({ supabase, sendFn, canDeliver, now });
  } catch (digestErr) {
    console.warn('[maintenanceReminders] Overdue digest sweep failed:', digestErr.message);
  }

  for (const id of (expiry.profileIds || [])) sweptProfileIds.add(id);
  for (const id of (digest.profileIds || [])) sweptProfileIds.add(id);
  // v1.63.1 — the sweep mutated reminder facts (remaining values, tier stamps,
  // newly promoted driver reminders): drop each affected user's cached context.
  for (const id of sweptProfileIds) {
    markUserDataChanged({ supabase, ownerId: id, reason: 'reminders.sweep' });
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
    driverRemindersSynced: driverSync.synced || 0,
    driverRemindersRetired: driverSync.deactivated || 0,
    driverRemindersSkipped: driverSync.skipped || 0,
    // v1.92.0 (Phase 29) — the overdue digest pass (kept out of the top-level
    // ladder counters so an existing alert count can never change meaning).
    digest: {
      evaluated: digest.evaluated || 0,
      owners: digest.owners || 0,
      overdueItems: digest.overdueItems || 0,
      sentT3: digest.sentT3 || 0,
      sentT7: digest.sentT7 || 0,
      dispatched: digest.dispatched || 0,
      reset: digest.reset || 0
    }
  };
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
  // v1.92.0 (Phase 29) — the overdue compliance digest (T+3 / T+7 per episode).
  evaluateOverdueDigest,
  ensureOverdueDigestTable,
  OVERDUE_DIGEST_TABLE,
  OVERDUE_DIGEST_SQL,
  syncAllDriverComplianceReminders,
  retireLegacyDriverLicenceReminder,
  reminderDueDate,
  daysUntilDue,
  EXPIRY_CATEGORIES,
  EXPIRY_TIERS
};

