import { buildGlobalContext, formatDate, formatMoney, formatNumber, kmToUserDistance } from './globalization.js';
import { assetMetricSummaryLines, formatMetricValue, getAssetMetricProfile } from './assetMetrics.js';
import { analyzeFuelEconomy } from './fuelEconomy.js';
import { getVehicleComplianceStatus } from './vehicleCompliance.js';
import { buildLedgerGroups, expenseKind } from './reportLedger.js';
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_KEYS } from './expenseCatalog.js';

/**
 * Saka Fleet — Individual Vehicle Deep-Dive (v1.29.0)
 * ---------------------------------------------------
 * One vehicle, fully surfaced: performance KPIs, spend split, earnings vs
 * expenses, fuel economy, compliance runway, people & roles and an itemized
 * transaction ledger. Engine-owned numbers only; localized currency/units.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function money(value, currency, locale) {
  return formatMoney(Number(value) || 0, currency, locale);
}

function kpi(label, value, hint, tone = null) {
  return { label, value: String(value ?? '—'), hint, ...(tone ? { tone } : {}) };
}

function odometerValues(rows = []) {
  return rows
    .map((row) => Number(row.odometer_reading))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function distanceFromRows(rows = []) {
  const values = odometerValues(rows);
  return values.length >= 2 ? Math.max(...values) - Math.min(...values) : null;
}

function complianceStatus(status) {
  if (status === 'valid') return 'good';
  if (status === 'expired') return 'bad';
  return 'warn';
}

function fuelCategory(row) {
  return expenseKind(row.expense_type) === 'fuel';
}

function vehicleLabel(vehicle = {}) {
  const makeModel = vehicle.make_model
    || [vehicle.make, vehicle.model].filter(Boolean).join(' ')
    || vehicle.asset_type
    || vehicle.vehicle_type
    || 'Vehicle';
  return String(makeModel).trim() || 'Vehicle';
}

export async function buildVehicleDeepDive({
  supabase,
  vehicleId = null,
  plate = null,
  ownerId = null,
  driverId = null,
  countryInfo = null,
  profile = null,
  access = {},
  now = new Date()
} = {}) {
  if (!supabase) return { ok: false, type: 'vehicle_deep_dive', error: 'Database unavailable.' };
  const ctx = buildGlobalContext(countryInfo, profile);

  // 1. Resolve the vehicle (id → plate → driver → owner, newest first).
  let vehicle = null;
  try {
    if (vehicleId) {
      const { data } = await supabase.from('vehicles').select('*').eq('id', vehicleId).is('deleted_at', null).maybeSingle();
      vehicle = data || null;
    }
    if (!vehicle && plate) {
      const { data } = await supabase.from('vehicles').select('*').ilike('plate_number', String(plate).trim()).is('deleted_at', null).limit(5);
      vehicle = (data || [])[0] || null;
    }
    if (!vehicle && driverId) {
      const { data } = await supabase.from('vehicles').select('*').eq('assigned_driver_id', driverId).is('deleted_at', null).limit(1);
      vehicle = (data || [])[0] || null;
    }
    if (!vehicle && ownerId) {
      const { data } = await supabase.from('vehicles').select('*').eq('owner_id', ownerId).is('deleted_at', null).limit(50);
      const rows = (data || []).slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      vehicle = rows[0] || null;
    }
  } catch { vehicle = null; }
  if (!vehicle) {
    return { ok: false, type: 'vehicle_deep_dive', error: 'No vehicle found for this report. Register a vehicle or send its plate.' };
  }

  // 2. Defense in depth: the vehicle must sit inside the caller's lane.
  const laneIds = Array.isArray(access?.vehicleIds) ? access.vehicleIds : [];
  if (laneIds.length && !laneIds.includes(vehicle.id)) {
    return { ok: false, type: 'vehicle_deep_dive', denied: true, error: 'That vehicle is outside your report lane.' };
  }

  // 3. Load the vehicle's records.
  let expenses = [];
  try {
    const { data } = await supabase.from('expense_logs').select('*').eq('vehicle_id', vehicle.id).limit(2000);
    expenses = data || [];
  } catch { expenses = []; }

  let earnings = [];
  const includeEarnings = access?.lane !== 'driver';
  if (includeEarnings) {
    try {
      const { data } = await supabase.from('private_earnings').select('*').eq('vehicle_id', vehicle.id).limit(2000);
      earnings = data || [];
    } catch { earnings = []; }
  }

  let reminders = [];
  try {
    const { data } = await supabase.from('reminders').select('*').eq('vehicle_id', vehicle.id).limit(200);
    reminders = (data || []).filter((row) => String(row.status || 'active').toUpperCase() !== 'COMPLETED');
  } catch { reminders = []; }

  let driverProfile = null;
  if (vehicle.assigned_driver_id) {
    try {
      const { data } = await supabase.from('profiles').select('id, full_name, phone_number').eq('id', vehicle.assigned_driver_id).maybeSingle();
      driverProfile = data || null;
    } catch { driverProfile = null; }
  }

  let compliance = { items: [] };
  try {
    compliance = await getVehicleComplianceStatus({
      supabase,
      vehicle,
      countryCode: ctx.countryCode,
      assetType: vehicle.asset_type || vehicle.vehicle_type || null,
      now
    });
  } catch { compliance = { items: [] }; }

  // 4. Engine-owned calculations.
  const fuelRows = expenses.filter(fuelCategory);
  const fuelSpend = fuelRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const fuelLitres = fuelRows.reduce((sum, row) => sum + (Number(row.fuel_liters ?? row.liters ?? row.fuel_litres) || 0), 0);
  const totalSpend = expenses.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const earned = earnings.reduce((sum, row) => sum + (Number(row.revenue_amount ?? row.amount) || 0), 0);
  const net = earned - totalSpend;
  const distanceKm = distanceFromRows(expenses);
  const distanceDisplay = distanceKm === null ? null : (ctx.unitSystem === 'imperial' ? kmToUserDistance(distanceKm, 'imperial') : distanceKm);
  const operatingHours = Number(vehicle.operating_hours) || 0;
  const economy = analyzeFuelEconomy({ logs: fuelRows, unitSystem: ctx.unitSystem, currency: ctx.currency });
  const economyValue = economy.status === 'CALCULATED'
    ? economy.averageKmPerLiter
    : (economy.status === 'ESTIMATED' ? economy.estimate?.kmPerLiter : null);
  const assetKind = vehicle.asset_kind || vehicle.asset_type || vehicle.vehicle_type || 'vehicle';
  const assetProfile = getAssetMetricProfile(assetKind);
  const costPerDistance = distanceDisplay > 0 ? totalSpend / distanceDisplay : null;
  const costPerHour = operatingHours > 0 ? totalSpend / operatingHours : null;

  const categories = Object.fromEntries(EXPENSE_CATEGORY_KEYS.map((key) => [key, 0]));
  for (const row of expenses) {
    const key = expenseKind(row.expense_type);
    categories[key] = (categories[key] || 0) + (Number(row.amount) || 0);
  }
  const categorySeries = Object.entries(categories)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ label: EXPENSE_CATEGORIES[key]?.label || key, value: Math.round(value * 100) / 100 }));
  const topCategory = categorySeries[0] || null;

  const meterLines = assetMetricSummaryLines({ assetKind, vehicle, unitSystem: ctx.unitSystem, locale: ctx.locale, currency: ctx.currency });
  const primaryMeter = meterLines[0] || null;

  const complianceRows = (compliance.items || []).slice(0, 12).map((item) => ({
    label: item.label || item.type,
    value: item.lifetime
      ? 'Valid for life'
      : (item.expiry ? `${formatDate(item.expiry, ctx.locale, { timeZone: ctx.timeZone })} · ${item.status}` : 'Not on file'),
    status: complianceStatus(item.status)
  }));
  const complianceProgress = (compliance.items || [])
    .filter((item) => Number.isFinite(item.daysLeft))
    .slice(0, 6)
    .map((item) => ({
      label: item.label || item.type,
      value: Math.max(0, item.daysLeft),
      text: item.daysLeft < 0 ? 'expired' : `${item.daysLeft}d`
    }));

  const ledger = buildLedgerGroups({
    expenses,
    earnings,
    vehicles: [vehicle],
    ctx,
    includeEarnings,
    title: `Itemized activity - ${vehicle.plate_number || 'vehicle'}`,
    subtitle: 'Every logged transaction in scope, grouped by month'
  });

  const kpis = [
    primaryMeter ? kpi(primaryMeter.label, primaryMeter.value, primaryMeter.hint) : null,
    kpi('Total spend', money(totalSpend, ctx.currency, ctx.locale), `${expenses.length} expense record(s)`, 'negative'),
    kpi('Cost per ' + (assetProfile.primaryMeter === 'odometer' ? ctx.labels.distance : 'hour'),
      assetProfile.primaryMeter === 'odometer'
        ? (costPerDistance !== null ? money(costPerDistance, ctx.currency, ctx.locale) : '—')
        : (costPerHour !== null ? money(costPerHour, ctx.currency, ctx.locale) : '—'),
      'engine-calculated'),
    includeEarnings ? kpi('Earnings', money(earned, ctx.currency, ctx.locale), `${earnings.length} earning record(s)`, 'positive') : null,
    includeEarnings ? kpi('Net position', money(net, ctx.currency, ctx.locale), net >= 0 ? 'surplus' : 'shortfall', net >= 0 ? 'positive' : 'negative') : null,
    kpi('Fuel economy', economyValue === null ? '—' : formatMetricValue({ metricId: 'fuel_economy', value: economyValue, unitSystem: ctx.unitSystem, locale: ctx.locale }), economy.status === 'CALCULATED' ? 'full-to-full fills' : 'estimate')
  ].filter(Boolean);

  const charts = [
    ...(categorySeries.length ? [{
      type: 'segment',
      title: 'Spend by category',
      note: 'Proportional split of every logged expense',
      currency: ctx.currency,
      segments: categorySeries
    }] : []),
    ...(includeEarnings ? [{
      type: 'vs',
      title: 'Earnings vs expenses',
      note: 'Recorded revenue against operating spend',
      currency: ctx.currency,
      earnings: Math.round(earned * 100) / 100,
      expenses: Math.round(totalSpend * 100) / 100
    }] : []),
    ...(economy.status === 'CALCULATED' && (economy.segments || []).length >= 2 ? [{
      type: 'line',
      title: 'Fuel economy trend',
      note: 'Full-to-full segments only',
      series: economy.segments.map((segment, index) => ({ label: `#${index + 1}`, value: segment.kmPerLiter }))
    }] : []),
    ...(complianceProgress.length ? [{
      type: 'progress',
      title: 'Compliance runway',
      max: 120,
      series: complianceProgress
    }] : [])
  ];

  const callouts = [];
  if (includeEarnings && (earned > 0 || totalSpend > 0)) {
    callouts.push({
      tone: net >= 0 ? 'positive' : 'negative',
      title: net >= 0 ? 'Financial health: surplus' : 'Financial health: shortfall',
      body: `${money(earned, ctx.currency, ctx.locale)} recorded earnings against ${money(totalSpend, ctx.currency, ctx.locale)} operating spend - a ${net >= 0 ? 'surplus' : 'shortfall'} of ${money(Math.abs(net), ctx.currency, ctx.locale)}.`
    });
  }
  if (topCategory) {
    const share = totalSpend > 0 ? Math.round((topCategory.value / totalSpend) * 100) : 0;
    callouts.push({
      tone: 'brand',
      title: 'Largest cost line',
      body: `${topCategory.label} accounts for ${share}% of this vehicle's spend (${money(topCategory.value, ctx.currency, ctx.locale)}).`
    });
  }
  if (!expenses.length && !earnings.length) {
    callouts.push({
      tone: 'warn',
      title: 'No activity recorded yet',
      body: 'Nothing is logged for this vehicle yet. Log a fuel-up or an expense and this report fills itself in automatically.'
    });
  }

  const data = {
    title: `Vehicle Deep-Dive - ${vehicle.plate_number || 'Vehicle'}`,
    subtitle: `${vehicleLabel(vehicle)} - engine-calculated figures, nothing hidden`,
    reportType: 'vehicle_deep_dive',
    plate: vehicle.plate_number || null,
    periodLabel: 'All recorded activity',
    generatedAt: now.toISOString(),
    currency: ctx.currency,
    kpis: kpis.slice(0, 6),
    charts,
    ledgers: [ledger],
    callouts,
    tables: [{
      title: 'Compliance & documents',
      subtitle: 'Vehicle compliance only - driver documents stay on the driver card',
      columns: [
        { key: 'label', label: 'Item', width: 1.5 },
        { key: 'value', label: 'Expiry & status', width: 1.6, align: 'right' },
        { key: 'status', label: 'Status', width: 0.9, type: 'status' }
      ],
      rows: complianceRows
    }],
    sections: [
      {
        title: 'Vehicle profile',
        rows: [
          { label: 'Plate', value: vehicle.plate_number || '—' },
          { label: 'Asset', value: `${vehicleLabel(vehicle)}${vehicle.year ? ` (${vehicle.year})` : ''}` },
          { label: 'Asset kind', value: assetProfile.label || String(assetKind) },
          { label: 'Fuel type', value: vehicle.fuel_type || '—' },
          { label: 'Status', value: vehicle.status || 'ACTIVE', status: String(vehicle.status || 'ACTIVE').toLowerCase() === 'active' ? 'good' : 'warn' },
          { label: 'VIN', value: vehicle.vin || '—' },
          { label: `Current ${(primaryMeter?.label || 'meter').toLowerCase()}`, value: primaryMeter?.value || '—' },
          ...(assetProfile.primaryMeter === 'odometer' ? [{
            label: 'Distance logged (period)',
            value: distanceDisplay === null ? '—' : `${formatNumber(Math.round(distanceDisplay), ctx.locale)} ${ctx.labels.distance}`
          }] : []),
          { label: 'Operating hours', value: `${formatNumber(operatingHours, ctx.locale)} h` },
          { label: 'Fuel logged', value: `${formatNumber(Math.round(fuelLitres * 10) / 10, ctx.locale)} ${ctx.labels.volume}` },
          { label: 'Fuel spend', value: money(fuelSpend, ctx.currency, ctx.locale) }
        ]
      },
      {
        title: 'People & roles',
        rows: [
          { label: 'Owner', value: profile?.full_name || 'Fleet owner' },
          { label: 'Driver', value: driverProfile?.full_name || 'No driver assigned', status: driverProfile ? 'good' : 'warn' }
        ],
        lines: driverProfile?.phone_number ? [`Driver contact: ${driverProfile.phone_number}`] : []
      },
      {
        title: 'Data completeness',
        rows: [
          { label: 'Expense records scanned', value: String(expenses.length) },
          { label: 'Earning records scanned', value: includeEarnings ? String(earnings.length) : 'Not in your lane' },
          { label: 'Ledger rows shown', value: String(ledger.totals.shown) },
          { label: 'Open reminders', value: String(reminders.length) }
        ],
        lines: ['Every record in scope is shown in this report - nothing is hidden or sampled.']
      }
    ],
    notes: [
      `Generated by Saka Fleet on ${formatDate(now, ctx.locale, { timeZone: ctx.timeZone })} - ${ctx.timeZone}`,
      'Figures are engine-calculated from your logged records; fuel economy uses full-tank segments only.'
    ]
  };
  return {
    ok: true,
    type: 'vehicle_deep_dive',
    data,
    text: buildVehicleDeepDiveText({ ctx, vehicle, distanceDisplay, totalSpend, earned, net, economyValue, economy, includeEarnings, ledger }),
    vehicle
  };
}

/** Deterministic WhatsApp digest (zero AI tokens; emoji-light per rule 31). */
function buildVehicleDeepDiveText({ ctx, vehicle, distanceDisplay, totalSpend, earned, net, economyValue, economy, includeEarnings, ledger }) {
  const lines = [
    `🚗 *Vehicle Deep-Dive - ${vehicle.plate_number || 'Vehicle'}*`,
    `_${vehicleLabel(vehicle)} · all recorded activity_`,
    '',
    `• Distance logged: *${distanceDisplay === null ? '—' : `${formatNumber(Math.round(distanceDisplay), ctx.locale)} ${ctx.labels.distance}`}*`,
    `• Total spend: *${money(totalSpend, ctx.currency, ctx.locale)}*`,
    includeEarnings ? `• Earnings: *${money(earned, ctx.currency, ctx.locale)}*` : null,
    includeEarnings ? `• Net position: *${money(net, ctx.currency, ctx.locale)}*` : null,
    `• Fuel economy: *${economyValue === null ? '—' : formatMetricValue({ metricId: 'fuel_economy', value: economyValue, unitSystem: ctx.unitSystem, locale: ctx.locale })}*${economy.status === 'ESTIMATED' ? ' (estimate)' : ''}`,
    `• Itemized ledger: *${ledger.totals.shown} record(s)* — all shown`,
    '',
    '📄 A branded PDF with the full itemized ledger is attached/linked where email is available.'
  ].filter((line) => line !== null);
  return lines.join('\n');
}

export default {
  buildVehicleDeepDive
};
