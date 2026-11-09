import { buildGlobalContext, formatNumber } from './globalization.js';
import { analyzeFuelEconomy } from './fuelEconomy.js';
import { getAssetMetricProfile } from './assetMetrics.js';
import { buildLedgerGroups } from './reportLedger.js';
import { EXPENSE_CATEGORIES, expenseCategoryOf } from './expenseCatalog.js';
// v1.92.0 (Phase 29) — LIVE earnings only (archived = the seller's history).
import { selectLiveEarnings } from './earningsScope.js';

/**
 * Saka Fleet — Bespoke Report Metric Registry (v1.18.0)
 * ----------------------------------------------------
 * Declarative metric blocks for user-designed reports. Every metric declares
 * who may see it (`owner` or `both`) so driver-lane custom reports can never
 * reveal owner-only financials. Numbers are engine-owned; the AI never computes.
 */

export const CUSTOM_METRICS = Object.freeze([
  { id: 'fuel_spend', label: 'Fuel spend', category: 'Financial', access: 'owner', kind: 'money', aliases: ['fuel spend', 'fuel cost'] },
  { id: 'fuel_litres', label: 'Fuel volume', category: 'Fuel', access: 'both', kind: 'litres', aliases: ['fuel', 'litres', 'liters', 'volume'] },
  { id: 'fuel_economy', label: 'Fuel economy', category: 'Fuel', access: 'both', kind: 'economy', aliases: ['economy', 'km/l', 'mpg', 'efficiency'] },
  { id: 'maintenance_spend', label: 'Maintenance spend', category: 'Financial', access: 'owner', kind: 'money', aliases: ['maintenance', 'service spend', 'repairs'] },
  { id: 'total_spend', label: 'Total spend', category: 'Financial', access: 'owner', kind: 'money', aliases: ['total spend', 'expenses', 'spend'] },
  { id: 'earnings', label: 'Earnings', category: 'Financial', access: 'owner', kind: 'money', aliases: ['earnings', 'revenue', 'income'] },
  { id: 'net_profit', label: 'Net profit', category: 'Financial', access: 'owner', kind: 'money', aliases: ['profit', 'net', 'margin'] },
  { id: 'distance', label: 'Distance covered', category: 'Operations', access: 'both', kind: 'number', aliases: ['distance', 'km', 'miles', 'mileage'] },
  // v1.28.9 — metric-registry additions: hours-led assets and electric assets.
  { id: 'operating_hours', label: 'Operating hours', category: 'Operations', access: 'both', kind: 'number', aliases: ['hours', 'engine hours', 'operating hours', 'hour meter'] },
  { id: 'energy_kwh', label: 'Energy (kWh)', category: 'Fuel', access: 'both', kind: 'kwh', aliases: ['kwh', 'energy', 'charge', 'charging'] },
  { id: 'expiring_30', label: 'Expiring in 30 days', category: 'Compliance', access: 'both', kind: 'number', aliases: ['expiring', 'expiry', 'renewals'] },
  { id: 'overdue', label: 'Overdue items', category: 'Compliance', access: 'both', kind: 'number', aliases: ['overdue', 'past due'] },
  { id: 'top_category', label: 'Top expense category', category: 'Financial', access: 'owner', kind: 'text', aliases: ['top category', 'biggest expense'] },
  { id: 'driver_entries', label: 'Logged entries', category: 'Driver', access: 'both', kind: 'number', aliases: ['entries', 'logs', 'driver activity'] },
  { id: 'co2', label: 'Estimated CO₂', category: 'Eco', access: 'owner', kind: 'number', aliases: ['co2', 'emissions', 'carbon', 'eco'] }
]);

export const CUSTOM_METRIC_CATEGORIES = Object.freeze([...new Set(CUSTOM_METRICS.map((metric) => metric.category))]);

/** Resolve metric ids from free text ("fuel, earnings and distance"). */
export function resolveMetricIds(text = '') {
  const clean = String(text || '').toLowerCase();
  if (!clean.trim()) return [];
  const found = [];
  for (const metric of CUSTOM_METRICS) {
    if (metric.aliases.some((alias) => clean.includes(alias)) || clean.includes(metric.label.toLowerCase())) {
      found.push(metric.id);
    }
  }
  return [...new Set(found)];
}

/** Metrics a lane may request (v1.28.9 — filtered by the fleet's asset kinds). */
export function metricsForAccess(access = {}) {
  const driverLane = access?.lane === 'driver' || access?.driverSafeOnly;
  let metrics = driverLane ? CUSTOM_METRICS.filter((metric) => metric.access === 'both') : CUSTOM_METRICS;
  const kinds = Array.isArray(access?.assetKinds) ? access.assetKinds.filter(Boolean) : [];
  if (kinds.length) metrics = metrics.filter((metric) => metricAppliesToAssetKinds(metric, kinds));
  return metrics;
}

/**
 * Does this bespoke metric make sense for at least one asset kind in scope?
 * A generator-only fleet never sees "distance"; an EV fleet never sees "litres".
 */
export function metricAppliesToAssetKinds(metric, assetKinds = []) {
  if (!Array.isArray(assetKinds) || assetKinds.length === 0) return true;
  const profiles = assetKinds.map((kind) => getAssetMetricProfile(kind));
  const has = (metricId) => profiles.some((profile) =>
    profile.metrics.some((entry) => entry.id === metricId)
    || (profile.electricMetrics || []).some((entry) => entry.id === metricId)
  );
  if (metric?.id === 'distance') return profiles.some((profile) => profile.distance !== 'never');
  if (metric?.id === 'fuel_litres' || metric?.id === 'fuel_spend') return has('fuel_volume');
  if (metric?.id === 'fuel_economy') return has('fuel_economy') || has('energy_economy');
  if (metric?.id === 'energy_kwh') return has('energy_volume') || has('energy_output');
  if (metric?.id === 'operating_hours') return has('engine_hours');
  return true;
}

/** Human menu for the quiz prompt (one line, easy to scan). */
export function customMetricMenu(access = {}) {
  return metricsForAccess(access).map((metric) => metric.label).join(' · ');
}

export function dateRangeBounds(range, now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  // v1.75.3 (Phase 14D, D1) — `last_30_days` is additive; every pre-existing
  // range keeps its exact semantics, so the WhatsApp lane is untouched.
  if (range === 'last_3_months') start.setUTCMonth(start.getUTCMonth() - 3);
  else if (range === 'last_30_days') start.setUTCDate(start.getUTCDate() - 30);
  else if (range === 'this_year') start.setUTCMonth(0, 1);
  else start.setUTCDate(1);
  const label = range === 'last_3_months'
    ? 'Last 3 months'
    : range === 'last_30_days'
      ? 'Last 30 days'
      : range === 'this_year' ? 'This year' : 'This month';
  return { from: start.toISOString(), to: end.toISOString(), label };
}

export function money(value, currency, locale) {
  try {
    return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(Number(value) || 0);
  } catch {
    return `${currency || 'USD'} ${Math.round(Number(value) || 0).toLocaleString()}`;
  }
}

function formatMetricValue(metric, raw, { currency, locale }) {
  if (raw === null || raw === undefined) return '—';
  if (metric.kind === 'money') return money(raw, currency, locale);
  if (metric.kind === 'litres') return `${formatNumber(raw, locale)} L`;
  if (metric.kind === 'kwh') return `${formatNumber(raw, locale)} kWh`;
  if (metric.kind === 'economy') return `${Number(raw).toFixed(2)} km/L`;
  if (metric.kind === 'text') return String(raw);
  return formatNumber(raw, locale);
}

/** Build a bespoke report from the user's selected metrics. */
export async function buildCustomReport({
  supabase,
  ownerId = null,
  driverId = null,
  vehicleIds = [],
  metricIds = [],
  range = 'this_month',
  // v1.75.3 (Phase 14D, D1) — optional explicit window { from, to, label }.
  // Additive: when absent the range presets behave exactly as before, so the
  // WhatsApp lane (which never passes it) is untouched.
  bounds: boundsOverride = null,
  countryInfo = null,
  profile = null,
  access = {},
  now = new Date()
} = {}) {
  if (!supabase) return { ok: false, error: 'Database unavailable' };
  const currency = countryInfo?.currency || profile?.currency || 'USD';
  const locale = countryInfo?.locale || 'en-US';
  const bounds = boundsOverride && boundsOverride.from && boundsOverride.to
    ? { from: String(boundsOverride.from), to: String(boundsOverride.to), label: String(boundsOverride.label || range) }
    : dateRangeBounds(range, now);
  const allowed = metricsForAccess(access).map((metric) => metric.id);
  const selected = (metricIds.length ? metricIds : allowed).filter((id) => allowed.includes(id));
  if (!selected.length) return { ok: false, error: 'No metrics available for this account' };

  let vehicles = [];
  try {
    const { data } = vehicleIds.length
      ? await supabase.from('vehicles').select('*').in('id', vehicleIds).is('deleted_at', null)
      : await supabase.from('vehicles').select('*').eq(ownerId ? 'owner_id' : 'assigned_driver_id', ownerId || driverId).is('deleted_at', null);
    vehicles = data || [];
  } catch { vehicles = []; }
  const scopedIds = vehicles.map((vehicle) => vehicle.id);

  let expenses = [];
  try {
    const { data } = await supabase.from('expense_logs').select('*').gte('created_at', bounds.from).lte('created_at', bounds.to).limit(1000);
    expenses = (data || []).filter((row) => (!scopedIds.length || scopedIds.includes(row.vehicle_id))
      && (!driverId || access?.lane === 'owner' || row.driver_id === driverId));
  } catch { expenses = []; }

  let earnings = [];
  if (access?.lane !== 'driver') {
    try {
      // v1.92.0 (Phase 29) — archived earnings belong to the seller's history.
      const { data } = await selectLiveEarnings(supabase, {
        apply: (query) => query.gte('created_at', bounds.from).lte('created_at', bounds.to).limit(1000)
      });
      earnings = (data || []).filter((row) => !scopedIds.length || scopedIds.includes(row.vehicle_id));
    } catch { earnings = []; }
  }

  let reminders = [];
  try {
    const { data } = await supabase.from('reminders').select('*').limit(300);
    reminders = (data || []).filter((row) => !scopedIds.length || scopedIds.includes(row.vehicle_id));
  } catch { reminders = []; }

  const fuelRows = expenses.filter((row) => /fuel|petrol|diesel|gas|charge/i.test(String(row.expense_type || '')));
  const fuelSpend = fuelRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const fuelLitres = fuelRows.reduce((sum, row) => sum + (Number(row.fuel_liters) || 0), 0);
  const economy = analyzeFuelEconomy({ logs: fuelRows, unitSystem: 'metric', currency });
  const economyValue = economy.status === 'CALCULATED' ? economy.averageKmPerLiter : (economy.status === 'ESTIMATED' ? economy.estimate.kmPerLiter : null);

  const maintenanceSpend = expenses
    .filter((row) => /repair|service|maintenance|part|tyre|tire|battery/i.test(String(row.expense_type || '')))
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const totalSpend = expenses.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const earned = earnings.reduce((sum, row) => sum + (Number(row.revenue_amount ?? row.amount) || 0), 0);
  const odometers = expenses.map((row) => Number(row.odometer_reading)).filter((value) => Number.isFinite(value) && value > 0);
  const distance = odometers.length >= 2 ? Math.max(...odometers) - Math.min(...odometers) : 0;

  let overdue = 0;
  let expiring30 = 0;
  for (const reminder of reminders) {
    if (String(reminder.status || 'active').toUpperCase() === 'COMPLETED') continue;
    const due = reminder.due_date ? new Date(reminder.due_date) : null;
    if (!due || Number.isNaN(due.getTime())) continue;
    const days = Math.ceil((due.getTime() - now.getTime()) / 86400000);
    if (days < 0) overdue += 1;
    else if (days <= 30) expiring30 += 1;
  }

  const categories = {};
  expenses.forEach((row) => {
    const key = expenseCategoryOf(row.expense_type);
    categories[key] = (categories[key] || 0) + (Number(row.amount) || 0);
  });
  const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];

  const values = {
    fuel_spend: fuelSpend,
    fuel_litres: fuelLitres,
    fuel_economy: economyValue,
    maintenance_spend: maintenanceSpend,
    total_spend: totalSpend,
    earnings: earned,
    net_profit: earned - totalSpend,
    distance,
    expiring_30: expiring30,
    overdue,
    top_category: topCategory ? (EXPENSE_CATEGORIES[topCategory[0]]?.label || topCategory[0]) : '—',
    driver_entries: expenses.length + earnings.length,
    co2: fuelLitres * 2.68
  };

  const selectedMetrics = selected.map((id) => {
    const metric = CUSTOM_METRICS.find((item) => item.id === id);
    return {
      id,
      label: metric.label,
      category: metric.category,
      value: formatMetricValue(metric, values[id], { currency, locale }),
      hint: metric.kind === 'money' ? 'engine-owned total' : (id === 'co2' ? 'estimate · 2.68 kg per litre' : metric.category)
    };
  });

  const chartSeries = Object.entries(categories).map(([key, value]) => ({
    label: EXPENSE_CATEGORIES[key]?.label || key,
    value
  }));
  const ctx = buildGlobalContext(countryInfo, profile);
  const ledger = buildLedgerGroups({
    expenses,
    earnings,
    vehicles,
    ctx,
    includeEarnings: access?.lane !== 'driver',
    includeVehicle: vehicles.length > 1,
    title: 'Itemized activity ledger',
    subtitle: `${bounds.label} - every transaction in scope`
  });
  return {
    ok: true,
    type: 'custom',
    data: {
      title: 'Bespoke Report',
      subtitle: `Your selected metrics · ${bounds.label.toLowerCase()}`,
      periodLabel: bounds.label,
      kpis: selectedMetrics.slice(0, 6),
      charts: [
        ...(chartSeries.length ? [{ type: 'donut', title: 'Spend by category', totalLabel: 'total', series: chartSeries }] : []),
        ...(access?.lane !== 'driver' && (totalSpend > 0 || earned > 0) ? [{
          type: 'vs',
          title: 'Earnings vs expenses',
          currency,
          earnings: Math.round(earned * 100) / 100,
          expenses: Math.round(totalSpend * 100) / 100
        }] : []),
        ...(economy.segments?.length >= 2 ? [{
          type: 'line',
          title: 'Fuel economy trend',
          note: 'Full-to-full segments',
          series: economy.segments.map((segment, index) => ({ label: `#${index + 1}`, value: segment.kmPerLiter }))
        }] : [])
      ],
      ledgers: [ledger],
      tables: [{
        title: 'Selected metrics',
        columns: [
          { key: 'label', label: 'Metric', width: 1.6 },
          { key: 'value', label: 'Value', width: 1.2, align: 'right' },
          { key: 'category', label: 'Category', width: 1 }
        ],
        rows: selectedMetrics
      }],
      sections: [{
        title: 'Scope',
        rows: [
          { label: 'Period', value: bounds.label },
          { label: 'Vehicles', value: vehicles.length ? vehicles.map((vehicle) => vehicle.plate_number).join(', ') : 'All scoped vehicles' },
          { label: 'Metrics', value: String(selectedMetrics.length) }
        ]
      }]
    },
    text: `📊 *Bespoke Report — ${bounds.label}*\n\n` +
      selectedMetrics.map((metric) => `• *${metric.label}:* ${metric.value}`).join('\n') +
      `\n\n_${vehicles.length ? vehicles.map((vehicle) => vehicle.plate_number).join(', ') : 'All scoped vehicles'} · engine-calculated, never estimated silently._`
  };
}

export default {
  CUSTOM_METRICS,
  CUSTOM_METRIC_CATEGORIES,
  resolveMetricIds,
  metricsForAccess,
  customMetricMenu,
  dateRangeBounds,
  buildCustomReport
};


