import { ASSET_KINDS, normalizeAssetKind } from './countryBucket.js';
import { formatNumber, formatMoney, kmToUserDistance, litersToUserVolume } from './globalization.js';

/**
 * Saka Fleet — Asset Metric Registry (v1.28.9)
 * --------------------------------------------
 * ONE source of truth for "what can this asset measure?", because Saka supports
 * very different machines:
 *   - road vehicles / motorcycles / trucks / buses → odometer + litres + km/L
 *   - heavy equipment / machinery → operating hours + litres + litres/hour
 *   - generators → hours + litres + kWh output
 *   - watercraft → hours + litres + litres/hour
 *   - electric road vehicles → odometer + kWh + km/kWh
 *
 * Every consumer (reports, PDF, summaries, bespoke report menus, the prompt and
 * the QA facts) reads this registry — no metric list is re-declared elsewhere.
 */

const LITRES_PER_US_GALLON = 3.785411784;
const MPG_PER_KM_PER_L = 2.352145833;
const MILES_PER_KM = 0.6213711922;

/** Metric descriptors. `units` is the display pair (canonical → imperial). */
const METRIC = Object.freeze({
  distance: { id: 'distance', label: 'Distance', family: 'distance', canonicalUnit: 'km', units: { metric: 'km', imperial: 'mi' }, flows: ['log', 'report', 'summary', 'pdf'] },
  engine_hours: { id: 'engine_hours', label: 'Operating hours', family: 'time', canonicalUnit: 'hours', units: { metric: 'h', imperial: 'h' }, flows: ['log', 'report', 'summary', 'pdf', 'reminder'] },
  fuel_volume: { id: 'fuel_volume', label: 'Fuel volume', family: 'volume', canonicalUnit: 'L', units: { metric: 'L', imperial: 'gal' }, flows: ['log', 'report', 'pdf'] },
  energy_volume: { id: 'energy_volume', label: 'Energy charged', family: 'energy', canonicalUnit: 'kWh', units: { metric: 'kWh', imperial: 'kWh' }, flows: ['log', 'report', 'pdf'] },
  fuel_economy: { id: 'fuel_economy', label: 'Fuel economy', family: 'economy', canonicalUnit: 'km/L', units: { metric: 'km/L', imperial: 'MPG' }, flows: ['report', 'pdf'] },
  fuel_burn_per_hour: { id: 'fuel_burn_per_hour', label: 'Fuel burn', family: 'economy', canonicalUnit: 'L/h', units: { metric: 'L/h', imperial: 'gal/h' }, flows: ['report', 'pdf'] },
  energy_economy: { id: 'energy_economy', label: 'Energy efficiency', family: 'economy', canonicalUnit: 'km/kWh', units: { metric: 'km/kWh', imperial: 'mi/kWh' }, flows: ['report', 'pdf'] },
  energy_output: { id: 'energy_output', label: 'Energy output', family: 'energy', canonicalUnit: 'kWh', units: { metric: 'kWh', imperial: 'kWh' }, flows: ['log', 'report', 'pdf'] },
  earnings: { id: 'earnings', label: 'Earnings', family: 'money', canonicalUnit: 'currency', units: { metric: 'currency', imperial: 'currency' }, flows: ['log', 'report', 'pdf'] },
  trips: { id: 'trips', label: 'Trips / jobs', family: 'count', canonicalUnit: 'trips', units: { metric: 'trips', imperial: 'trips' }, flows: ['report', 'pdf'] }
});

const ROAD_FUEL_TYPES = Object.freeze(['Diesel', 'Petrol', 'Hybrid', 'Electric']);
const HOURS_FUEL_TYPES = Object.freeze(['Diesel', 'Petrol']);

const ROAD_METRICS = Object.freeze([
  METRIC.distance, METRIC.fuel_volume, METRIC.fuel_economy, METRIC.engine_hours, METRIC.earnings
]);
const ROAD_ELECTRIC_METRICS = Object.freeze([
  METRIC.distance, METRIC.energy_volume, METRIC.energy_economy, METRIC.earnings
]);
/** The complete per-kind metric profile (single source of truth). */
export const ASSET_METRIC_PROFILES = Object.freeze({
  vehicle: {
    label: ASSET_KINDS.vehicle.label,
    primaryMeter: 'odometer',
    distance: 'primary',
    hours: 'optional',
    fuelFamily: 'combustion_or_electric',
    fuelTypes: ROAD_FUEL_TYPES,
    metrics: ROAD_METRICS,
    electricMetrics: ROAD_ELECTRIC_METRICS
  },
  motorcycle: {
    label: ASSET_KINDS.motorcycle.label,
    primaryMeter: 'odometer',
    distance: 'primary',
    hours: 'optional',
    fuelFamily: 'combustion_or_electric',
    fuelTypes: ROAD_FUEL_TYPES,
    metrics: ROAD_METRICS,
    electricMetrics: ROAD_ELECTRIC_METRICS
  },
  truck: {
    label: ASSET_KINDS.truck.label,
    primaryMeter: 'odometer',
    distance: 'primary',
    hours: 'optional',
    fuelFamily: 'combustion_or_electric',
    fuelTypes: ROAD_FUEL_TYPES,
    metrics: Object.freeze([...ROAD_METRICS, METRIC.trips]),
    electricMetrics: Object.freeze([...ROAD_ELECTRIC_METRICS, METRIC.trips])
  },
  bus: {
    label: ASSET_KINDS.bus.label,
    primaryMeter: 'odometer',
    distance: 'primary',
    hours: 'optional',
    fuelFamily: 'combustion_or_electric',
    fuelTypes: ROAD_FUEL_TYPES,
    metrics: Object.freeze([...ROAD_METRICS, METRIC.trips]),
    electricMetrics: Object.freeze([...ROAD_ELECTRIC_METRICS, METRIC.trips])
  },
  heavy_equipment: {
    label: ASSET_KINDS.heavy_equipment.label,
    primaryMeter: 'hours',
    distance: 'optional',
    hours: 'primary',
    fuelFamily: 'combustion',
    fuelTypes: HOURS_FUEL_TYPES,
    metrics: Object.freeze([METRIC.engine_hours, METRIC.fuel_volume, METRIC.fuel_burn_per_hour, METRIC.earnings])
  },
  machinery: {
    label: ASSET_KINDS.machinery.label,
    primaryMeter: 'hours',
    distance: 'optional',
    hours: 'primary',
    fuelFamily: 'combustion',
    fuelTypes: HOURS_FUEL_TYPES,
    metrics: Object.freeze([METRIC.engine_hours, METRIC.fuel_volume, METRIC.fuel_burn_per_hour, METRIC.earnings])
  },
  generator: {
    label: ASSET_KINDS.generator.label,
    primaryMeter: 'hours',
    distance: 'never',
    hours: 'primary',
    fuelFamily: 'combustion',
    fuelTypes: HOURS_FUEL_TYPES,
    metrics: Object.freeze([METRIC.engine_hours, METRIC.fuel_volume, METRIC.fuel_burn_per_hour, METRIC.energy_output, METRIC.earnings])
  },
  watercraft: {
    label: ASSET_KINDS.watercraft.label,
    primaryMeter: 'hours',
    distance: 'optional',
    hours: 'primary',
    fuelFamily: 'combustion',
    fuelTypes: HOURS_FUEL_TYPES,
    metrics: Object.freeze([METRIC.engine_hours, METRIC.fuel_volume, METRIC.fuel_burn_per_hour, METRIC.earnings])
  }
});

export const METRIC_IDS = Object.freeze(Object.keys(METRIC));

export function isElectricFuel(fuelType) {
  return /^(?:electric|ev|bev)$/i.test(String(fuelType || '').trim());
}

export function isCombustionFuel(fuelType) {
  return /^(?:diesel|petrol|gas|gasoline|hybrid|fuel|oil)$/i.test(String(fuelType || '').trim());
}

/** Full profile for any asset kind (never null). */
export function getAssetMetricProfile(assetKind) {
  return ASSET_METRIC_PROFILES[normalizeAssetKind(assetKind)] || ASSET_METRIC_PROFILES.vehicle;
}

/**
 * Metrics that apply to this asset (electric road vehicles swap litres/km-L for
 * kWh/km-per-kWh instead of showing both).
 */
export function metricsForAssetKind(assetKind, { fuelType = null } = {}) {
  const profile = getAssetMetricProfile(assetKind);
  if (isElectricFuel(fuelType) && profile.electricMetrics) return profile.electricMetrics;
  return profile.metrics;
}

export function metricById(metricId) {
  return Object.values(METRIC).find((metric) => metric.id === metricId) || null;
}

export function primaryMeterForAssetKind(assetKind) {
  return getAssetMetricProfile(assetKind).primaryMeter;
}

export function fuelTypesForAssetKind(assetKind) {
  return getAssetMetricProfile(assetKind).fuelTypes;
}

/** Display-unit label for a metric (km/mi, L/gal, h, kWh, km/L/MPG…). */
export function displayUnitForMetric(metricId, unitSystem = 'metric') {
  const metric = metricById(metricId);
  if (!metric) return '';
  return unitSystem === 'imperial' ? metric.units.imperial : metric.units.metric;
}

/** Format any metric value with canonical→display conversion (never throws). */
export function formatMetricValue({
  metricId,
  value,
  unitSystem = 'metric',
  locale = 'en-US',
  currency = 'USD'
} = {}) {
  const metric = metricById(metricId);
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!metric || !Number.isFinite(num)) return '—';
  const imperial = String(unitSystem).toLowerCase() === 'imperial';
  if (metric.family === 'money') return formatMoney(num, currency, locale);
  if (metric.family === 'distance') {
    const shown = imperial ? kmToUserDistance(num, 'imperial') : num;
    return `${formatNumber(Math.round(shown * 10) / 10, locale)} ${imperial ? 'mi' : 'km'}`;
  }
  if (metric.family === 'volume') {
    const shown = imperial ? litersToUserVolume(num, 'imperial') : num;
    return `${formatNumber(Math.round(shown * 10) / 10, locale)} ${imperial ? 'gal' : 'L'}`;
  }
  if (metric.family === 'energy') {
    return `${formatNumber(Math.round(num * 10) / 10, locale)} kWh`;
  }
  if (metric.family === 'time') {
    return `${formatNumber(Math.round(num * 10) / 10, locale)} h`;
  }
  if (metric.family === 'count') {
    return formatNumber(num, locale);
  }
  if (metric.family === 'economy') {
    if (metricId === 'fuel_economy') {
      return imperial ? `${(num * MPG_PER_KM_PER_L).toFixed(2)} MPG` : `${num.toFixed(2)} km/L`;
    }
    if (metricId === 'fuel_burn_per_hour') {
      const shown = imperial ? num / LITRES_PER_US_GALLON : num;
      return `${shown.toFixed(2)} ${imperial ? 'gal/h' : 'L/h'}`;
    }
    if (metricId === 'energy_economy') {
      const shown = imperial ? num * MILES_PER_KM : num;
      return `${shown.toFixed(2)} ${imperial ? 'mi/kWh' : 'km/kWh'}`;
    }
  }
  return formatNumber(num, locale);
}
/**
 * Meter/fuel/energy lines used by the registration summary and PDF: the primary
 * meter for the asset kind, never a hardcoded odometer for a generator.
 */
export function assetMetricSummaryLines({ assetKind, vehicle = {}, unitSystem = 'metric', locale = 'en-US', currency = 'USD' } = {}) {
  const profile = getAssetMetricProfile(assetKind);
  const lines = [];
  if (profile.primaryMeter === 'odometer') {
    lines.push({
      metricId: 'distance',
      label: 'Odometer',
      value: formatMetricValue({
        metricId: 'distance',
        value: vehicle.current_mileage ?? vehicle.odometer_reading ?? 0,
        unitSystem, locale
      }),
      hint: 'current reading'
    });
  } else {
    lines.push({
      metricId: 'engine_hours',
      label: 'Engine hours',
      value: formatMetricValue({
        metricId: 'engine_hours',
        value: vehicle.operating_hours ?? vehicle.current_engine_hours ?? 0,
        unitSystem, locale
      }),
      hint: 'current reading'
    });
  }
  if (isElectricFuel(vehicle.fuel_type)) {
    lines.push({
      metricId: 'energy_volume',
      label: 'Energy charged',
      value: formatMetricValue({ metricId: 'energy_volume', value: vehicle.kwh_charged ?? 0, unitSystem, locale }),
      hint: 'from logged charging sessions'
    });
  } else if (vehicle.fuel_type) {
    lines.push({
      metricId: 'fuel_volume',
      label: 'Fuel type',
      value: String(vehicle.fuel_type),
      hint: profile.primaryMeter === 'hours' ? 'fuels the hour meter' : 'fuels the odometer'
    });
  }
  const purchase = Number(vehicle.purchase_cost || 0);
  if (purchase > 0) {
    lines.push({ metricId: 'earnings', label: 'Purchase cost', value: formatMoney(purchase, currency, locale), hint: 'asset value' });
  }
  return lines;
}

/** Compact glossary for the core prompt (one line per asset kind). */
export function buildMetricGlossaryBlock() {
  const rows = Object.entries(ASSET_METRIC_PROFILES).map(([kind, profile]) => {
    const metricIds = profile.metrics.map((metric) => metric.id).join(', ');
    return `- ${kind} (${profile.label}): primary meter = ${profile.primaryMeter}; metrics = ${metricIds}; fuels = ${profile.fuelTypes.join('/')}.`;
  });
  return [
    'METRIC GLOSSARY (authoritative — assets measure different things; never force an odometer on an hours-based asset):',
    ...rows,
    '- Electric road vehicles: litres and km/L do NOT apply; use kWh and km/kWh (mi/kWh in imperial).',
    '- Canonical storage is km, litres, hours and kWh; imperial (miles, gallons, MPG, mi/kWh) is display-only.',
    '- Never invent a metric an asset cannot measure (no distance for a generator, no fuel for a pure EV).'
  ].join('\n');
}

/** Coverage snapshot (tests + admin audits). */
export function getMetricCoverage() {
  const kinds = Object.keys(ASSET_KINDS);
  return {
    kinds: kinds.length,
    covered: kinds.filter((kind) => Boolean(ASSET_METRIC_PROFILES[kind])).length,
    metricCount: METRIC_IDS.length,
    missing: kinds.filter((kind) => !ASSET_METRIC_PROFILES[kind])
  };
}

export default {
  ASSET_METRIC_PROFILES,
  METRIC_IDS,
  getAssetMetricProfile,
  metricsForAssetKind,
  metricById,
  primaryMeterForAssetKind,
  fuelTypesForAssetKind,
  displayUnitForMetric,
  formatMetricValue,
  assetMetricSummaryLines,
  buildMetricGlossaryBlock,
  getMetricCoverage,
  isElectricFuel,
  isCombustionFuel
};
