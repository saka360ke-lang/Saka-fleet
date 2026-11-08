/**
 * Saka Fleet — Vehicle analytics (v1.80.0, Phase 19)
 * -------------------------------------------------
 * Pure, dependency-light math for the owner's /d/analytics page:
 *   1. Tyre wear — the latest "Tyres" expense with an odometer reading starts
 *      the clock; current odometer minus that reading = distance on this set.
 *   2. Cost-per-km trend — six monthly buckets of spend ÷ distance, where the
 *      distance comes from the SAME `distanceInWindow` engine the reports use.
 *
 * No database, no AI, no rendering. Every number here is engine-owned; the
 * lifespans are assumptions (env-tunable) and are labelled as such in the UI.
 */
import { distanceInWindow, monthStartMs } from './fleetReports.js';
import { kmToUserDistance } from './globalization.js';
import { isHoursLedKind } from './expenseCatalog.js';

export const TYRE_DEFAULT_LIFESPAN_KM = 50000;
export const TYRE_DEFAULT_REPLACE_SOON_KM = 40000;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getTyreLifespanKm() {
  return positiveNumber(process.env.TYRE_LIFESPAN_KM, TYRE_DEFAULT_LIFESPAN_KM);
}

export function getTyreReplaceSoonKm(lifespanKm = getTyreLifespanKm()) {
  const configured = positiveNumber(process.env.TYRE_REPLACE_SOON_KM, TYRE_DEFAULT_REPLACE_SOON_KM);
  return Math.min(configured, lifespanKm);
}

/** The catalog stores "Tyres"; accept the singular/tyre/tire variants exactly.
 *  A "tyre repair kit" is a different expense and must not reset the clock. */
export function isTyreExpenseType(type) {
  const clean = String(type || '').trim().toLowerCase();
  return clean === 'tyre' || clean === 'tyres' || clean === 'tire' || clean === 'tires';
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function displayDistance(km, unitSystem) {
  if (km === null || km === undefined || !Number.isFinite(Number(km))) return null;
  const value = unitSystem === 'imperial' ? kmToUserDistance(Number(km), 'imperial') : Number(km);
  return Math.round(value);
}

function expenseTime(expense) {
  return new Date(expense?.created_at || expense?.logged_at || 0).getTime();
}

/**
 * v1.85.0 (Phase 24) — ENGINE HOURS ride the entry notes ("Engine hours: N h",
 * written by the expense path since v1.39.0; canonical storage is notes, no
 * DDL). Returns the numeric reading or null.
 */
export function parseHoursFromNotes(notes) {
  const match = String(notes || '').match(/(?:engine|operating)\s*hours\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A vehicle is hours-led when its registry profile says so (never by guess). */
export function isHoursLedVehicle(vehicle = {}) {
  return isHoursLedKind(vehicle.asset_kind || vehicle.asset_type || vehicle.vehicle_type || 'vehicle');
}

/**
 * Hours covered in a window, derived from the engine-hours readings logged in
 * expense notes — the hours twin of `distanceInWindow` (per vehicle: max − min).
 */
export function hoursInWindow(expenses, { from = -Infinity, to = Infinity } = {}) {
  const byVehicle = new Map();
  for (const expense of expenses || []) {
    const ts = expenseTime(expense);
    if (!Number.isFinite(ts) || ts < from || ts >= to) continue;
    const hours = parseHoursFromNotes(expense.notes);
    if (hours === null) continue;
    const list = byVehicle.get(expense.vehicle_id) || [];
    list.push(hours);
    byVehicle.set(expense.vehicle_id, list);
  }
  let total = 0;
  for (const readings of byVehicle.values()) {
    if (readings.length >= 2) total += Math.max(...readings) - Math.min(...readings);
  }
  return Math.round(total * 10) / 10;
}

/**
 * One row per live vehicle: what the tyre clock says. Rows are honest when the
 * data is not there ("no Tyres expense with an odometer reading yet").
 */
export function buildTyreWearRows({ vehicles = [], expenses = [], unitSystem = 'metric' } = {}) {
  const lifespanKm = getTyreLifespanKm();
  const replaceSoonKm = getTyreReplaceSoonKm(lifespanKm);
  const rows = (vehicles || [])
    .filter((vehicle) => String(vehicle.status || 'ACTIVE').toUpperCase() !== 'DELETED')
    // v1.85.0 — tyre wear is a ROAD-asset concern; hours-led assets never appear.
    .filter((vehicle) => !isHoursLedVehicle(vehicle))
    .map((vehicle) => {
      const currentRaw = Number(vehicle.current_mileage ?? vehicle.odometer_reading);
      const currentKm = Number.isFinite(currentRaw) && currentRaw > 0 ? currentRaw : null;
      const tyreRows = (expenses || [])
        .filter((expense) => String(expense.vehicle_id) === String(vehicle.id)
          && isTyreExpenseType(expense.expense_type)
          && Number(expense.odometer_reading) > 0)
        .sort((a, b) => expenseTime(b) - expenseTime(a));
      const base = {
        vehicleId: vehicle.id,
        plate: vehicle.plate_number || 'Fleet vehicle',
        makeModel: vehicle.make_model || null,
        currentOdometer: displayDistance(currentKm, unitSystem),
        distanceUnit: unitSystem === 'imperial' ? 'mi' : 'km'
      };
      if (!tyreRows.length) {
        return {
          ...base,
          status: 'no_data',
          lastTyreOdometer: null,
          kmSince: null,
          remainingPct: null,
          lifespan: displayDistance(lifespanKm, unitSystem),
          replaceSoonAt: displayDistance(replaceSoonKm, unitSystem),
          replaceSoon: false,
          replacedAt: null,
          note: 'No Tyres expense with an odometer reading yet.'
        };
      }
      const latest = tyreRows[0];
      const lastTyreKm = Number(latest.odometer_reading);
      const kmSinceRaw = currentKm !== null ? currentKm - lastTyreKm : null;
      const kmSince = kmSinceRaw !== null ? Math.max(0, kmSinceRaw) : null;
      const remainingPct = kmSince === null ? null : Math.max(0, Math.min(1, 1 - kmSince / lifespanKm));
      return {
        ...base,
        status: kmSince !== null && kmSince >= replaceSoonKm ? 'replace_soon' : 'ok',
        lastTyreOdometer: displayDistance(lastTyreKm, unitSystem),
        kmSince: displayDistance(kmSince, unitSystem),
        remainingPct: remainingPct === null ? null : Math.round(remainingPct * 100),
        lifespan: displayDistance(lifespanKm, unitSystem),
        replaceSoonAt: displayDistance(replaceSoonKm, unitSystem),
        replaceSoon: kmSince !== null && kmSince >= replaceSoonKm,
        replacedAt: latest.created_at || latest.logged_at || null,
        note: kmSinceRaw !== null && kmSinceRaw < 0
          ? 'The current odometer is below the last tyre reading — please check both readings.'
          : (currentKm === null ? 'This vehicle has no current odometer reading yet.' : null)
      };
    });
  return rows;
}

/**
 * Six monthly buckets (oldest → newest). Spend is every expense in the bucket;
 * distance is the odometer delta per vehicle in the SAME bucket via the shared
 * `distanceInWindow` engine. costPerKm is null when there was no movement.
 */
export function buildCostPerKmTrend({ expenses = [], now = new Date(), months = 6, unitSystem = 'metric' } = {}) {
  const count = Math.max(1, Math.min(Number(months) || 6, 12));
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const from = Date.UTC(year, month - i, 1);
    const to = Date.UTC(year, month - i + 1, 1);
    const start = new Date(from);
    const rows = (expenses || []).filter((expense) => {
      const ts = expenseTime(expense);
      return Number.isFinite(ts) && ts >= from && ts < to;
    });
    const spend = round2(rows.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0));
    const distanceKm = distanceInWindow(expenses, { from, to });
    const costPerKm = distanceKm > 0 ? round2(spend / distanceKm) : null;
    buckets.push({
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      label: start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      spend,
      distance: displayDistance(distanceKm, unitSystem),
      distanceUnit: unitSystem === 'imperial' ? 'mi' : 'km',
      costPerKm
    });
  }
  const totalSpend = round2(buckets.reduce((sum, bucket) => sum + bucket.spend, 0));
  const totalDistance = buckets.reduce((sum, bucket) => sum + (Number(bucket.distance) || 0), 0);
  const priced = buckets.filter((bucket) => bucket.costPerKm !== null);
  return {
    months: buckets,
    totalSpend,
    totalDistance,
    averageCostPerKm: totalDistance > 0 ? round2(totalSpend / totalDistance) : null,
    peakCostPerKm: priced.length ? Math.max(...priced.map((bucket) => bucket.costPerKm)) : null
  };
}

/**
 * v1.85.0 (Phase 24) — the hours twin of the cost-per-km trend. Spend is every
 * expense in the bucket; hours come from the engine-hours readings in expense
 * notes via `hoursInWindow` (max − min per vehicle). costPerHour is null when
 * no two readings landed in the month.
 */
export function buildCostPerHourTrend({ vehicles = [], expenses = [], now = new Date(), months = 6 } = {}) {
  const count = Math.max(1, Math.min(Number(months) || 6, 12));
  const idSet = new Set((vehicles || []).map((vehicle) => String(vehicle.id)).filter(Boolean));
  const scoped = idSet.size
    ? (expenses || []).filter((expense) => idSet.has(String(expense.vehicle_id)))
    : (expenses || []);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const from = Date.UTC(year, month - i, 1);
    const to = Date.UTC(year, month - i + 1, 1);
    const start = new Date(from);
    const rows = scoped.filter((expense) => {
      const ts = expenseTime(expense);
      return Number.isFinite(ts) && ts >= from && ts < to;
    });
    const spend = round2(rows.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0));
    const hours = hoursInWindow(scoped, { from, to });
    const costPerHour = hours > 0 ? round2(spend / hours) : null;
    buckets.push({
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      label: start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      spend,
      hours,
      costPerHour
    });
  }
  const totalSpend = round2(buckets.reduce((sum, bucket) => sum + bucket.spend, 0));
  const totalHours = Math.round(buckets.reduce((sum, bucket) => sum + (Number(bucket.hours) || 0), 0) * 10) / 10;
  const priced = buckets.filter((bucket) => bucket.costPerHour !== null);
  return {
    months: buckets,
    totalSpend,
    totalHours,
    averageCostPerHour: totalHours > 0 ? round2(totalSpend / totalHours) : null,
    peakCostPerHour: priced.length ? Math.max(...priced.map((bucket) => bucket.costPerHour)) : null
  };
}

/**
 * v1.85.0 — the hours-led replacement for the tyre cards: one row per active
 * HOURS-threshold service reminder, with the live reading and remaining hours.
 */
export function buildServiceIntervalRows({ vehicles = [], reminders = [] } = {}) {
  const hoursVehicles = (vehicles || []).filter((vehicle) => isHoursLedVehicle(vehicle)
    && String(vehicle.status || 'ACTIVE').toUpperCase() !== 'DELETED');
  const byId = new Map(hoursVehicles.map((vehicle) => [String(vehicle.id), vehicle]));
  return (reminders || [])
    .filter((reminder) => String(reminder.threshold_unit || '').toLowerCase() === 'hours')
    .filter((reminder) => byId.has(String(reminder.vehicle_id)))
    .filter((reminder) => !reminder.status || String(reminder.status).toLowerCase() === 'active')
    .map((reminder) => {
      const vehicle = byId.get(String(reminder.vehicle_id));
      const currentHours = Math.round(Number(vehicle.operating_hours ?? vehicle.current_engine_hours ?? 0) * 10) / 10;
      const target = Number(reminder.target_value);
      const remaining = Number.isFinite(Number(reminder.remaining_value))
        ? Number(reminder.remaining_value)
        : (Number.isFinite(target) ? Math.round((target - currentHours) * 10) / 10 : null);
      const interval = Number.isFinite(target)
        ? Math.round((target - Number(reminder.last_service_value || 0)) * 10) / 10
        : null;
      return {
        vehicleId: vehicle.id,
        plate: vehicle.plate_number || 'Fleet asset',
        makeModel: vehicle.make_model || null,
        reminderId: reminder.id || null,
        label: reminder.reminder_type || 'Service',
        currentHours,
        target: Number.isFinite(target) ? target : null,
        remaining,
        percentRemaining: interval && interval > 0 && remaining !== null
          ? Math.max(0, Math.min(100, Math.round((remaining / interval) * 1000) / 10))
          : null,
        status: remaining !== null && remaining <= 0 ? 'overdue' : 'active'
      };
    })
    .sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity));
}

/** SVG geometry for a monthly money-per-unit trend (viewBox 0 0 640 200). Pure. */
export function buildCostPerKmChart(trend = {}, { width = 640, height = 200, padding = 34, valueKey = 'costPerKm' } = {}) {
  const months = Array.isArray(trend.months) ? trend.months : [];
  const values = months.map((bucket) => bucket[valueKey]);
  const finite = values.filter((value) => value !== null && Number.isFinite(value));
  const maxValue = finite.length ? Math.max(...finite) : 0;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const stepX = months.length > 1 ? plotWidth / (months.length - 1) : 0;
  const points = [];
  months.forEach((bucket, index) => {
    const value = bucket[valueKey];
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const x = padding + stepX * index;
    const y = maxValue > 0 ? padding + plotHeight - (value / maxValue) * plotHeight : padding + plotHeight;
    points.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, value, month: bucket });
  });
  return {
    width,
    height,
    padding,
    maxValue,
    points,
    polyline: points.map((point) => `${point.x},${point.y}`).join(' ')
  };
}

export default {
  TYRE_DEFAULT_LIFESPAN_KM,
  TYRE_DEFAULT_REPLACE_SOON_KM,
  getTyreLifespanKm,
  getTyreReplaceSoonKm,
  isTyreExpenseType,
  parseHoursFromNotes,
  isHoursLedVehicle,
  hoursInWindow,
  buildTyreWearRows,
  buildCostPerKmTrend,
  buildCostPerHourTrend,
  buildServiceIntervalRows,
  buildCostPerKmChart
};

