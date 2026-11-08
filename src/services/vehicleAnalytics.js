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
 * One row per live vehicle: what the tyre clock says. Rows are honest when the
 * data is not there ("no Tyres expense with an odometer reading yet").
 */
export function buildTyreWearRows({ vehicles = [], expenses = [], unitSystem = 'metric' } = {}) {
  const lifespanKm = getTyreLifespanKm();
  const replaceSoonKm = getTyreReplaceSoonKm(lifespanKm);
  const rows = (vehicles || [])
    .filter((vehicle) => String(vehicle.status || 'ACTIVE').toUpperCase() !== 'DELETED')
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

/** SVG geometry for the trend (viewBox 0 0 640 200). Pure + testable. */
export function buildCostPerKmChart(trend = {}, { width = 640, height = 200, padding = 34 } = {}) {
  const months = Array.isArray(trend.months) ? trend.months : [];
  const values = months.map((bucket) => bucket.costPerKm);
  const finite = values.filter((value) => value !== null && Number.isFinite(value));
  const maxValue = finite.length ? Math.max(...finite) : 0;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const stepX = months.length > 1 ? plotWidth / (months.length - 1) : 0;
  const points = [];
  months.forEach((bucket, index) => {
    if (bucket.costPerKm === null || !Number.isFinite(bucket.costPerKm)) return;
    const x = padding + stepX * index;
    const y = maxValue > 0 ? padding + plotHeight - (bucket.costPerKm / maxValue) * plotHeight : padding + plotHeight;
    points.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, value: bucket.costPerKm, month: bucket });
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
  buildTyreWearRows,
  buildCostPerKmTrend,
  buildCostPerKmChart
};

