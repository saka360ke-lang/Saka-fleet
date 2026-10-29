/**
 * Saka Fleet - Maintenance Reminder Engine (v1.8)
 * ------------------------------------------------
 * Single source of truth for threshold-based maintenance reminders:
 *   - Distance thresholds in kilometres (canonical) or miles (converted),
 *     e.g. "oil change in 5000 km" or "brake pads in 3000 miles".
 *   - Operating-hours thresholds, e.g. "spare part change in 36 operating hours".
 *   - Date-based reminders keep flowing through reminders.due_date (quiz flow).
 *
 * The engine EXPLICITLY tracks and records the remaining distance/time until a
 * reminder triggers (reminders.remaining_value + remaining_updated_at) and
 * dispatches proactive WhatsApp alerts as thresholds approach
 * (75% / 25% / 5% / due-now / overdue), exactly once per tier via the
 * notified_75p / notified_25p / notified_5p / notified_0p / notified_overdue
 * columns.
 *
 * Global rule: distances are stored canonically as kilometres and hours as
 * decimal operating hours. Display units adapt to the vehicle unit_system
 * (metric -> km, imperial -> mi) and the user's regional settings.
 */

import { kmToUserDistance, userDistanceToKm, formatNumber } from './globalization.js';

const round1 = (n) => Math.round(Number(n) * 10) / 10;

const TIER_COLUMNS = {
  approach: 'notified_75p',
  warning: 'notified_25p',
  urgent: 'notified_5p',
  dueNow: 'notified_0p',
  overdue: 'notified_overdue'
};

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
 * Background sweep: evaluate every active distance/operating-hours reminder
 * against its vehicle's current readings and dispatch approaching/urgent/
 * overdue WhatsApp alerts. Runs on a fixed interval in index.js and can also
 * be triggered on demand.
 */
export async function runReminderSweep({ supabase, sendFn = null, canDeliver = null }) {
  if (!supabase) return { ok: false, error: 'Database unavailable.' };

  const { data: reminders, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('status', 'active')
    .in('threshold_unit', ['distance', 'hours'])
    .limit(500);
  if (error || !reminders?.length) {
    return { ok: true, vehiclesChecked: 0, evaluated: 0, alerts: 0, dispatched: 0 };
  }

  const vehicleIds = [...new Set(reminders.map((r) => r.vehicle_id).filter(Boolean))];
  if (vehicleIds.length === 0) {
    return { ok: true, vehiclesChecked: 0, evaluated: 0, alerts: 0, dispatched: 0 };
  }

  const { data: vehicles } = await supabase.from('vehicles').select('*').in('id', vehicleIds);
  if (!vehicles?.length) {
    return { ok: true, vehiclesChecked: 0, evaluated: 0, alerts: 0, dispatched: 0 };
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

  let evaluated = 0;
  let alerts = 0;
  let dispatched = 0;
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
    evaluated += res.evaluated || 0;
    alerts += (res.alerts || []).length;
    dispatched += res.dispatched || 0;
  }

  return { ok: true, vehiclesChecked: vehicles.length, evaluated, alerts, dispatched };
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
  runReminderSweep
};

