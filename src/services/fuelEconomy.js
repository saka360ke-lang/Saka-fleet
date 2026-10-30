import { runSql, hasSqlAccess } from '../db/sqlRunner.js';

/**
 * Saka Fleet — Fuel Economy Engine (v1.17.1)
 * -----------------------------------------
 * Fuel economy is only mathematically valid between FULL tank fills
 * (brim-to-brim). Every litre added between two full fills was consumed over
 * that distance, so top-ups and unclassified fills belong in the denominator;
 * they simply cannot act as segment anchors.
 *
 * This module is pure (no DB, no AI) except for `ensureFuelEconomySchema`, so
 * the math is fully unit-testable. `analytics.calculateFuelConsumption` is the
 * DB wrapper.
 *
 * Canonical units: litres and kilometres. Display converts to gallons/miles.
 */

export const FUEL_FILL_TYPE = Object.freeze({ FULL: 'full', PARTIAL: 'partial' });

export const FUEL_ECON_MIN_SEGMENT_KM = Math.max(0, Number(process.env.FUEL_ECON_MIN_SEGMENT_KM || 20));
export const FUEL_ECON_MAX_PLAUSIBLE_KML = Math.max(10, Number(process.env.FUEL_ECON_MAX_PLAUSIBLE_KML || 80));
export const FUEL_RATING_GOOD_KML = Math.max(1, Number(process.env.FUEL_RATING_GOOD_KML || 10));
export const FUEL_RATING_EXCELLENT_KML = Math.max(FUEL_RATING_GOOD_KML + 1, Number(process.env.FUEL_RATING_EXCELLENT_KML || 14));

export const KM_PER_MILE = 1.609344;
export const LITRES_PER_GALLON = 3.785411784;

/** Normalize any user/provider value into 'full' | 'partial' | null. */
export function normalizeFillType(value) {
  const clean = String(value ?? '').trim().toLowerCase();
  if (!clean) return null;
  if (/\b(full|brim|brimmed|fill(ed)?\s*(it\s*)?(up|to\s*the\s*top)|tank\s*full)\b/.test(clean)) {
    return FUEL_FILL_TYPE.FULL;
  }
  if (/\b(partial|top[\s-]?up|topped|half|not\s*full|some\s*fuel)\b/.test(clean)) {
    return FUEL_FILL_TYPE.PARTIAL;
  }
  return null;
}

/** Legacy rows carried "full tank" only in the notes text — recover it. */
export function inferFillTypeFromNotes(notes) {
  return normalizeFillType(notes || '');
}

export function litersToGallons(liters) {
  return Number(liters) / LITRES_PER_GALLON;
}

export function gallonsToLiters(gallons) {
  return Number(gallons) * LITRES_PER_GALLON;
}

export function kmToMiles(km) {
  return Number(km) / KM_PER_MILE;
}

export function milesToKm(miles) {
  return Number(miles) * KM_PER_MILE;
}

export function kmPerLiterToMpg(kmPerLiter) {
  // US MPG: 1 km/L = 2.352145833 MPG (1 US gallon = 3.785411784 L, 1 mile = 1.609344 km).
  return Number(kmPerLiter) * 2.352145833;
}

/** Normalize a DB row into the engine's canonical shape. */
export function normalizeFuelLog(row = {}, fallbackIndex = 0) {
  const litres = Number(row.fuel_liters ?? row.liters ?? 0) || 0;
  const odometer = Number(row.odometer_reading ?? row.odometer ?? 0) || null;
  const amount = Number(row.amount ?? row.cost ?? 0) || 0;
  const at = row.created_at || row.logged_at || null;
  return {
    id: row.id || `log-${fallbackIndex}`,
    at,
    timestamp: at ? new Date(at).getTime() : fallbackIndex,
    litres,
    odometer,
    amount,
    currency: row.currency || null,
    fillType: normalizeFillType(row.fill_type) || inferFillTypeFromNotes(row.notes)
  };
}

/** Metric rating label (thresholds are physical km/L, independent of display). */
export function rateEconomy(kmPerLiter) {
  const value = Number(kmPerLiter);
  if (!Number.isFinite(value)) return { key: 'unknown', label: 'Not enough data' };
  if (value >= FUEL_RATING_EXCELLENT_KML) return { key: 'excellent', label: 'Excellent 🟢' };
  if (value >= FUEL_RATING_GOOD_KML) return { key: 'good', label: 'Good 🟡' };
  return { key: 'heavy', label: 'Heavy Consumption 🔴' };
}

export function formatVolume(liters, unitSystem) {
  const value = unitSystem === 'imperial' ? litersToGallons(liters) : liters;
  const unit = unitSystem === 'imperial' ? 'gal' : 'L';
  return `${round(value, 2)} ${unit}`;
}

export function formatDistance(km, unitSystem) {
  const value = unitSystem === 'imperial' ? kmToMiles(km) : km;
  const unit = unitSystem === 'imperial' ? 'mi' : 'km';
  return `${Math.round(value).toLocaleString()} ${unit}`;
}

export function formatEconomy(kmPerLiter, unitSystem) {
  if (unitSystem === 'imperial') return `${round(kmPerLiterToMpg(kmPerLiter), 2)} MPG`;
  return `${round(kmPerLiter, 2)} km/L`;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function formatMoney(amount, currency) {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'KES', maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency || 'KES'} ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
}

/**
 * The core brim-to-brim engine (pure).
 *
 * Rule: a valid segment runs between two FULL fills. Every litre logged after
 * the opening full fill (top-ups, unclassified fills, and even a full fill that
 * lacks an odometer) is consumed by the time the closing full fill is reached,
 * so all of it belongs in the denominator. That makes the math correct for
 * fleets that mostly top up.
 */
export function analyzeFuelEconomy({
  logs = [],
  unitSystem = 'metric',
  currency = 'KES',
  minSegmentKm = FUEL_ECON_MIN_SEGMENT_KM
} = {}) {
  const chronological = logs
    .map((row, index) => normalizeFuelLog(row, index))
    .sort((a, b) => (a.timestamp - b.timestamp));
  const totalSpend = chronological.reduce((sum, log) => sum + (log.amount || 0), 0);

  const segments = [];
  const skipped = [];
  const warnings = [];
  let lastFull = null;
  let intermediateLitres = 0;
  let intermediateCost = 0;
  let unclassifiedFills = 0;
  let bestOdometer = null;
  let latestPricePerLiter = null;

  for (const log of chronological) {
    if (log.litres > 0 && log.amount > 0) {
      latestPricePerLiter = { price: round(log.amount / log.litres, 2), at: log.at, currency: log.currency || currency };
    }

    if (!log.litres || log.litres <= 0) {
      skipped.push({ id: log.id, reason: 'missing_litres' });
      continue;
    }

    if (log.fillType !== FUEL_FILL_TYPE.FULL) {
      if (!log.fillType) unclassifiedFills += 1;
      if (lastFull) {
        intermediateLitres += log.litres;
        intermediateCost += log.amount || 0;
      }
      if (log.odometer) bestOdometer = log.odometer;
      continue;
    }

    // A full fill without an odometer cannot anchor a segment, but its litres
    // were still consumed inside the surrounding segment.
    if (!log.odometer) {
      if (lastFull) {
        intermediateLitres += log.litres;
        intermediateCost += log.amount || 0;
      }
      skipped.push({ id: log.id, reason: 'full_fill_missing_odometer' });
      continue;
    }

    bestOdometer = log.odometer;

    if (!lastFull) {
      lastFull = log;
      intermediateLitres = 0;
      intermediateCost = 0;
      continue;
    }

    const distanceKm = log.odometer - lastFull.odometer;
    const litres = log.litres + intermediateLitres;
    const cost = (log.amount || 0) + intermediateCost;

    if (distanceKm <= 0) {
      skipped.push({ id: log.id, reason: 'odometer_regression', distanceKm });
    } else if (distanceKm < minSegmentKm) {
      skipped.push({ id: log.id, reason: 'short_segment', distanceKm });
    } else {
      const kmPerLiter = litres > 0 ? distanceKm / litres : null;
      if (!kmPerLiter || kmPerLiter > FUEL_ECON_MAX_PLAUSIBLE_KML) {
        skipped.push({ id: log.id, reason: 'implausible_economy', distanceKm, litres });
      } else {
        segments.push({
          fromId: lastFull.id,
          toId: log.id,
          fromAt: lastFull.at,
          toAt: log.at,
          distanceKm,
          litres: round(litres, 2),
          cost: round(cost, 2),
          kmPerLiter: round(kmPerLiter, 2),
          litersPer100km: round((litres / distanceKm) * 100, 2),
          mpg: round(kmPerLiterToMpg(kmPerLiter), 2),
          rating: rateEconomy(kmPerLiter)
        });
      }
    }

    lastFull = log;
    intermediateLitres = 0;
    intermediateCost = 0;
  }

  const totalDistanceKm = segments.reduce((sum, segment) => sum + segment.distanceKm, 0);
  const totalLitres = segments.reduce((sum, segment) => sum + segment.litres, 0);
  const totalSegmentCost = segments.reduce((sum, segment) => sum + segment.cost, 0);
  const averageKmPerLiter = totalDistanceKm > 0 && totalLitres > 0 ? totalDistanceKm / totalLitres : null;
  const latest = segments.length > 0 ? segments[segments.length - 1] : null;

  const currentTank = lastFull && bestOdometer && bestOdometer > lastFull.odometer
    ? {
      sinceAt: lastFull.at,
      distanceKm: bestOdometer - lastFull.odometer,
      litresAdded: round(intermediateLitres, 2),
      cost: round(intermediateCost, 2)
    }
    : null;

  if (skipped.some((row) => row.reason === 'odometer_regression')) {
    warnings.push('Some fill-ups were skipped because the odometer reading went backwards.');
  }
  if (skipped.some((row) => row.reason === 'short_segment')) {
    warnings.push(`Fill-ups closer than ${minSegmentKm} km apart were skipped to protect accuracy.`);
  }
  if (skipped.some((row) => row.reason === 'implausible_economy')) {
    warnings.push('One fill-up produced an implausible economy figure and was excluded.');
  }
  if (skipped.some((row) => row.reason === 'missing_litres')) {
    warnings.push('Some fuel entries had no volume and were ignored.');
  }
  if (skipped.some((row) => row.reason === 'full_fill_missing_odometer')) {
    warnings.push('A full-tank fill had no odometer reading; its litres were folded into the next full-to-full segment.');
  }
  if (unclassifiedFills > 0) {
    warnings.push(`${unclassifiedFills} fill(s) were not labelled full or top-up; they were counted as top-ups between full fills.`);
  }

  const base = {
    unitSystem,
    currency,
    segments,
    latest,
    currentTank,
    totalSpend: round(totalSpend, 2),
    totalDistanceKm,
    totalLitres: round(totalLitres, 2),
    averageKmPerLiter: averageKmPerLiter === null ? null : round(averageKmPerLiter, 2),
    averageLitersPer100km: averageKmPerLiter === null ? null : round((totalLitres / totalDistanceKm) * 100, 2),
    averageMpg: averageKmPerLiter === null ? null : round(kmPerLiterToMpg(averageKmPerLiter), 2),
    rating: averageKmPerLiter === null ? null : rateEconomy(averageKmPerLiter),
    costPerKm: totalDistanceKm > 0 ? round(totalSegmentCost / totalDistanceKm, 2) : null,
    latestPricePerLiter,
    unclassifiedFills,
    skipped,
    warnings
  };

  if (segments.length > 0) {
    return { ...base, status: 'CALCULATED', confidence: 'exact', segmentCount: segments.length };
  }

  // No full-to-full pair yet: span estimate only, honestly labelled.
  const usable = chronological.filter((log) => log.odometer && log.litres > 0);
  if (usable.length >= 2) {
    const first = usable[0];
    const last = usable[usable.length - 1];
    const distanceKm = last.odometer - first.odometer;
    const litres = usable.slice(1).reduce((sum, log) => sum + log.litres, 0);
    if (distanceKm >= minSegmentKm && litres > 0) {
      const kmPerLiter = distanceKm / litres;
      if (kmPerLiter <= FUEL_ECON_MAX_PLAUSIBLE_KML) {
        return {
          ...base,
          status: 'ESTIMATED',
          confidence: 'estimate',
          segmentCount: 0,
          estimate: {
            distanceKm,
            litres: round(litres, 2),
            kmPerLiter: round(kmPerLiter, 2),
            litersPer100km: round((litres / distanceKm) * 100, 2),
            mpg: round(kmPerLiterToMpg(kmPerLiter), 2),
            rating: rateEconomy(kmPerLiter)
          },
          warnings: [
            ...warnings,
            'No full-to-full pair yet: this is a span estimate. Mark the next fill as FULL to unlock exact economy.'
          ]
        };
      }
    }
  }

  return { ...base, status: 'NEEDS_MORE_DATA', confidence: 'none', segmentCount: 0 };
}

/** Deterministic WhatsApp reply for any analysis result. */
export function buildFuelEconomyReply({ plate, model, analysis, currency = null } = {}) {
  const unitSystem = analysis?.unitSystem || 'metric';
  const curr = currency || analysis?.currency || 'KES';
  const header = `📊 *Fuel Economy: ${plate || 'Vehicle'}${model ? ` (${model})` : ''}*`;
  const fullTankHint = `👉 Next fill: fill the tank to FULL and reply e.g. _"Logged 40L at 368000 km — full tank"_ so I can measure it exactly.`;

  if (!analysis || analysis.status === 'NEEDS_MORE_DATA') {
    return [
      header,
      '',
      'Not enough fuel history to calculate economy yet.',
      '',
      '🔍 *How exact economy works:* Saka measures km/L between two *full-tank* fills. Top-ups in between are counted automatically.',
      fullTankHint
    ].join('\n');
  }

  if (analysis.status === 'ESTIMATED') {
    const estimate = analysis.estimate;
    const warnings = (analysis.warnings || []).slice(0, 2).map((warning) => `⚠️ ${warning}`);
    return [
      `📊 *Fuel Economy (estimate): ${plate || 'Vehicle'}${model ? ` (${model})` : ''}*`,
      '',
      `• *Estimated economy:* *${formatEconomy(estimate.kmPerLiter, unitSystem)}* (${round(estimate.litersPer100km, 2)} L/100km)`,
      `• *Distance:* ${formatDistance(estimate.distanceKm, unitSystem)} · *Fuel:* ${formatVolume(estimate.litres, unitSystem)}`,
      `• *Fuel spend:* ${formatMoney(analysis.totalSpend, curr)}`,
      analysis.latestPricePerLiter ? `• *Latest price:* ${formatMoney(analysis.latestPricePerLiter.price, analysis.latestPricePerLiter.currency || curr)} per ${unitSystem === 'imperial' ? 'gallon' : 'litre'}` : '',
      '',
      '⚠️ This is a span estimate, not exact — no full-to-full pair yet.',
      ...warnings,
      fullTankHint
    ].filter(Boolean).join('\n');
  }

  const latest = analysis.latest;
  const average = analysis.averageKmPerLiter;
  const lines = [
    header,
    '',
    `• *Latest full-to-full:* *${formatEconomy(latest.kmPerLiter, unitSystem)}*`,
    `• *Average (${analysis.segmentCount} full tank${analysis.segmentCount === 1 ? '' : 's'}):* ${formatEconomy(average, unitSystem)} (${round(analysis.averageLitersPer100km, 2)} L/100km)`,
    `• *Rating:* ${analysis.rating?.label || '—'}`,
    `• *Distance analyzed:* ${formatDistance(analysis.totalDistanceKm, unitSystem)}`,
    `• *Fuel used:* ${formatVolume(analysis.totalLitres, unitSystem)}`,
    `• *Fuel spend:* ${formatMoney(analysis.totalSpend, curr)}${analysis.costPerKm !== null ? ` · *Cost per km:* ${formatMoney(analysis.costPerKm, curr)}` : ''}`,
    analysis.latestPricePerLiter ? `• *Latest price:* ${formatMoney(analysis.latestPricePerLiter.price, analysis.latestPricePerLiter.currency || curr)} per ${unitSystem === 'imperial' ? 'gallon' : 'litre'}` : '',
    analysis.currentTank
      ? `• *Current tank:* ${formatDistance(analysis.currentTank.distanceKm, unitSystem)} since last full${analysis.currentTank.litresAdded > 0 ? ` · ${formatVolume(analysis.currentTank.litresAdded, unitSystem)} added so far` : ''}`
      : ''
  ];

  const warnings = (analysis.warnings || []).slice(0, 3).map((warning) => `⚠️ ${warning}`);
  return [
    ...lines,
    ...(warnings.length ? ['', ...warnings] : []),
    '',
    `_Exact economy is measured between full tanks — top-ups in between are counted automatically. ${analysis.segmentCount < 2 ? 'More full fills will sharpen the average.' : ''}_`
  ].filter((line) => line !== '' || true).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const FUEL_ECONOMY_SQL = `
    ALTER TABLE public.expense_logs ADD COLUMN IF NOT EXISTS fill_type text;
    CREATE INDEX IF NOT EXISTS idx_expense_logs_fill_type
        ON public.expense_logs(vehicle_id, fill_type);
    UPDATE public.expense_logs SET fill_type = 'full'
        WHERE fill_type IS NULL AND notes ~* '(full[[:space:]]*tank|brim|filled[[:space:]]+to[[:space:]]+full|fill[[:space:]]+to[[:space:]]+full)';
    UPDATE public.expense_logs SET fill_type = 'partial'
        WHERE fill_type IS NULL AND notes ~* '(top[[:space:]-]*up|topped[[:space:]]+up|half[[:space:]]*tank|partial)';
`;

/** Ensure the fill-type column exists (fail-soft; DDL needs a SQL transport). */
export async function ensureFuelEconomySchema(providedSupabase) {
  if (!providedSupabase) return { ok: false, status: 'no-client' };
  const { error } = await providedSupabase.from('expense_logs').select('fill_type').limit(1);
  if (!error) return { ok: true, status: 'exists' };
  if (!/fill_type|column/i.test(error.message || '')) return { ok: false, status: 'error', error: error.message };
  if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
  try {
    const result = await runSql(FUEL_ECONOMY_SQL, { label: 'ensureFuelEconomySchema' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

export default {
  FUEL_FILL_TYPE,
  FUEL_ECON_MIN_SEGMENT_KM,
  FUEL_RATING_GOOD_KML,
  FUEL_RATING_EXCELLENT_KML,
  normalizeFillType,
  inferFillTypeFromNotes,
  normalizeFuelLog,
  analyzeFuelEconomy,
  buildFuelEconomyReply,
  rateEconomy,
  formatEconomy,
  formatVolume,
  formatDistance,
  ensureFuelEconomySchema,
  FUEL_ECONOMY_SQL
};



