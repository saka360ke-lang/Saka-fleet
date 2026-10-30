import { formatNumber } from './globalization.js';
import { analyzeFuelEconomy } from './fuelEconomy.js';

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

/** Metrics a lane may request. */
export function metricsForAccess(access = {}) {
  const driverLane = access?.lane === 'driver' || access?.driverSafeOnly;
  return driverLane ? CUSTOM_METRICS.filter((metric) => metric.access === 'both') : CUSTOM_METRICS;
}

/** Human menu for the quiz prompt (one line, easy to scan). */
export function customMetricMenu(access = {}) {
  return metricsForAccess(access).map((metric) => metric.label).join(' · ');
}

export function dateRangeBounds(range, now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  if (range === 'last_3_months') start.setUTCMonth(start.getUTCMonth() - 3);
  else if (range === 'this_year') start.setUTCMonth(0, 1);
  else start.setUTCDate(1);
  return { from: start.toISOString(), to: end.toISOString(), label: range === 'last_3_months' ? 'Last 3 months' : range === 'this_year' ? 'This year' : 'This month' };
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
  countryInfo = null,
  profile = null,
  access = {},
  now = new Date()
} = {}) {
  if (!supabase) return { ok: false, error: 'Database unavailable' };
  const currency = countryInfo?.currency || profile?.currency || 'USD';
  const locale = countryInfo?.locale || 'en-US';
  const bounds = dateRangeBounds(range, now);
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
      const { data } = await supabase.from('private_earnings').select('*').gte('created_at', bounds.from).lte('created_at', bounds.to).limit(1000);
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
    const key = String(row.expense_type || 'other').toLowerCase();
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
    top_category: topCategory ? topCategory[0] : '—',
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

  const chartSeries = Object.entries(categories).map(([label, value]) => ({ label, value }));
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
        ...(economy.segments?.length >= 2 ? [{
          type: 'line',
          title: 'Fuel economy trend',
          note: 'Full-to-full segments',
          series: economy.segments.map((segment, index) => ({ label: `#${index + 1}`, value: segment.kmPerLiter }))
        }] : [])
      ],
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


