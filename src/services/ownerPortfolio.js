import { buildGlobalContext, formatDate, formatMoney, formatNumber, kmToUserDistance } from './globalization.js';
import { buildLedgerGroups, expenseKind } from './reportLedger.js';

/**
 * Saka Fleet — Owner Profile & Asset Portfolio Report (v1.29.0)
 * ------------------------------------------------------------
 * One owner, every asset: aggregated revenue, expenses and net payouts, a
 * multi-vehicle distribution, per-vehicle performance and a consolidated
 * itemized ledger. Owners only - never assembled in a driver lane.
 */

function money(value, currency, locale) {
  return formatMoney(Number(value) || 0, currency, locale);
}

function kpi(label, value, hint, tone = null) {
  return { label, value: String(value ?? '—'), hint, ...(tone ? { tone } : {}) };
}

function vehicleLabel(vehicle = {}) {
  return vehicle.make_model
    || [vehicle.make, vehicle.model].filter(Boolean).join(' ')
    || vehicle.asset_type
    || vehicle.vehicle_type
    || 'Vehicle';
}

function distanceFor(rows = []) {
  const values = rows
    .map((row) => Number(row.odometer_reading))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length >= 2 ? Math.max(...values) - Math.min(...values) : null;
}

function statusTone(status) {
  const clean = String(status || 'ACTIVE').toUpperCase();
  if (clean === 'ACTIVE') return 'good';
  if (clean === 'PAUSED' || clean === 'INACTIVE') return 'warn';
  return 'bad';
}

export async function buildOwnerPortfolio({
  supabase,
  ownerId = null,
  countryInfo = null,
  profile = null,
  access = {},
  now = new Date()
} = {}) {
  if (!supabase) return { ok: false, type: 'owner_portfolio', error: 'Database unavailable.' };
  const effectiveOwnerId = ownerId || profile?.id || null;
  if (!effectiveOwnerId) return { ok: false, type: 'owner_portfolio', error: 'Owner context required.' };
  if (access?.lane === 'driver') {
    return { ok: false, type: 'owner_portfolio', denied: true, error: 'The portfolio report is in the owner lane.' };
  }
  const ctx = buildGlobalContext(countryInfo, profile);

  let vehicles = [];
  try {
    const { data } = await supabase.from('vehicles').select('*').eq('owner_id', effectiveOwnerId).is('deleted_at', null).limit(200);
    vehicles = data || [];
  } catch { vehicles = []; }
  const laneIds = Array.isArray(access?.vehicleIds) ? access.vehicleIds : [];
  if (laneIds.length) vehicles = vehicles.filter((vehicle) => laneIds.includes(vehicle.id));
  if (!vehicles.length) {
    return { ok: false, type: 'owner_portfolio', error: 'No vehicles registered yet. Register your first asset to unlock the portfolio report.' };
  }

  const vehicleIds = vehicles.map((vehicle) => vehicle.id);
  let expenses = [];
  try {
    const { data } = await supabase.from('expense_logs').select('*').in('vehicle_id', vehicleIds).limit(3000);
    expenses = data || [];
  } catch { expenses = []; }
  let earnings = [];
  try {
    const { data } = await supabase.from('private_earnings').select('*').in('vehicle_id', vehicleIds).limit(3000);
    earnings = data || [];
  } catch { earnings = []; }
  let reminders = [];
  try {
    const { data } = await supabase.from('reminders').select('*').in('vehicle_id', vehicleIds).limit(500);
    reminders = (data || []).filter((row) => String(row.status || 'active').toUpperCase() !== 'COMPLETED');
  } catch { reminders = []; }

  // Per-vehicle consolidation (transparency: every asset is listed, even at zero).
  const rows = vehicles.map((vehicle) => {
    const vehicleExpenses = expenses.filter((row) => row.vehicle_id === vehicle.id);
    const vehicleEarnings = earnings.filter((row) => row.vehicle_id === vehicle.id);
    const spend = vehicleExpenses.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const earned = vehicleEarnings.reduce((sum, row) => sum + (Number(row.revenue_amount ?? row.amount) || 0), 0);
    const distanceKm = distanceFor(vehicleExpenses);
    return {
      id: vehicle.id,
      plate: vehicle.plate_number || 'Vehicle',
      asset: vehicleLabel(vehicle),
      status: vehicle.status || 'ACTIVE',
      entries: vehicleExpenses.length + vehicleEarnings.length,
      distance: distanceKm === null ? null : (ctx.unitSystem === 'imperial' ? kmToUserDistance(distanceKm, 'imperial') : distanceKm),
      expenses: Math.round(spend * 100) / 100,
      earnings: Math.round(earned * 100) / 100,
      net: Math.round((earned - spend) * 100) / 100
    };
  }).sort((a, b) => b.expenses - a.expenses);

  const totalExpenses = Math.round(rows.reduce((sum, row) => sum + row.expenses, 0) * 100) / 100;
  const totalEarnings = Math.round(rows.reduce((sum, row) => sum + row.earnings, 0) * 100) / 100;
  const netPayout = Math.round((totalEarnings - totalExpenses) * 100) / 100;
  const totalDistance = rows.reduce((sum, row) => sum + (Number(row.distance) || 0), 0);
  const fuelLitres = expenses
    .filter((row) => expenseKind(row.expense_type) === 'fuel')
    .reduce((sum, row) => sum + (Number(row.fuel_liters ?? row.liters ?? row.fuel_litres) || 0), 0);

  const categoryTotals = { fuel: 0, maintenance: 0, parts: 0, tolls: 0, compliance: 0, other: 0 };
  for (const row of expenses) categoryTotals[expenseKind(row.expense_type)] += Number(row.amount) || 0;
  const categoryLabels = { fuel: 'Fuel', maintenance: 'Maintenance', parts: 'Parts', tolls: 'Tolls & parking', compliance: 'Compliance', other: 'Other' };
  const categorySeries = Object.entries(categoryTotals)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ label: categoryLabels[key] || key, value: Math.round(value * 100) / 100 }));

  const vehicleSpendSeries = rows
    .filter((row) => row.expenses > 0)
    .slice(0, 7)
    .map((row) => ({ label: row.plate, value: row.expenses }));
  const otherVehiclesSpend = rows.slice(7).reduce((sum, row) => sum + row.expenses, 0);
  if (otherVehiclesSpend > 0) vehicleSpendSeries.push({ label: 'Other vehicles', value: Math.round(otherVehiclesSpend * 100) / 100 });

  const activeVehicles = rows.filter((row) => statusTone(row.status) === 'good').length;
  const bestPerformer = [...rows].sort((a, b) => b.net - a.net)[0] || null;
  const weakestPerformer = [...rows].sort((a, b) => a.net - b.net)[0] || null;

  const ledger = buildLedgerGroups({
    expenses,
    earnings,
    vehicles,
    ctx,
    includeEarnings: true,
    includeVehicle: true,
    title: 'Consolidated activity ledger',
    subtitle: 'Every transaction across every asset you own'
  });

  const charts = [
    ...(vehicleSpendSeries.length ? [{
      type: 'segment',
      title: 'Spend by vehicle',
      note: 'Where the money goes across your portfolio',
      currency: ctx.currency,
      segments: vehicleSpendSeries
    }] : []),
    {
      type: 'vs',
      title: 'Portfolio earnings vs expenses',
      note: 'All assets combined',
      currency: ctx.currency,
      earnings: totalEarnings,
      expenses: totalExpenses
    },
    ...(categorySeries.length ? [{
      type: 'segment',
      title: 'Spend by category',
      note: 'Fleet-wide cost structure',
      currency: ctx.currency,
      segments: categorySeries
    }] : [])
  ];

  const callouts = [];
  if (totalEarnings > 0 || totalExpenses > 0) {
    callouts.push({
      tone: netPayout >= 0 ? 'positive' : 'negative',
      title: netPayout >= 0 ? 'Portfolio surplus' : 'Portfolio shortfall',
      body: `${money(totalEarnings, ctx.currency, ctx.locale)} revenue against ${money(totalExpenses, ctx.currency, ctx.locale)} expenses leaves a ${netPayout >= 0 ? 'net payout' : 'net shortfall'} of ${money(Math.abs(netPayout), ctx.currency, ctx.locale)}.`
    });
  }
  if (bestPerformer && rows.length > 1) {
    callouts.push({
      tone: 'brand',
      title: 'Strongest asset',
      body: `${bestPerformer.plate} leads the portfolio with a net position of ${money(bestPerformer.net, ctx.currency, ctx.locale)}.`
    });
  }
  if (weakestPerformer && weakestPerformer.net < 0) {
    callouts.push({
      tone: 'warn',
      title: 'Asset needing attention',
      body: `${weakestPerformer.plate} is running at a net ${money(Math.abs(weakestPerformer.net), ctx.currency, ctx.locale)} ${weakestPerformer.net < 0 ? 'shortfall' : 'surplus'} - review its cost lines below.`
    });
  }

  const kpis = [
    kpi('Assets', String(rows.length), `${activeVehicles} active`),
    kpi('Total revenue', money(totalEarnings, ctx.currency, ctx.locale), `${earnings.length} earning record(s)`, 'positive'),
    kpi('Total expenses', money(totalExpenses, ctx.currency, ctx.locale), `${expenses.length} expense record(s)`, 'negative'),
    kpi('Net payouts', money(netPayout, ctx.currency, ctx.locale), netPayout >= 0 ? 'surplus' : 'shortfall', netPayout >= 0 ? 'positive' : 'negative'),
    kpi('Distance logged', `${formatNumber(Math.round(totalDistance), ctx.locale)} ${ctx.labels.distance}`, 'across all assets'),
    kpi('Fuel logged', `${formatNumber(Math.round(fuelLitres * 10) / 10, ctx.locale)} ${ctx.labels.volume}`, 'portfolio-wide')
  ];

  const data = {
    title: 'Owner Portfolio Report',
    subtitle: `${rows.length} asset(s) - consolidated owner view`,
    reportType: 'owner_portfolio',
    periodLabel: 'All recorded activity',
    generatedAt: now.toISOString(),
    currency: ctx.currency,
    kpis,
    charts,
    ledgers: [ledger],
    callouts,
    tables: [{
      title: 'Portfolio performance',
      subtitle: 'Every asset you own, including assets with zero activity',
      currency: ctx.currency,
      columns: [
        { key: 'plate', label: 'Vehicle', width: 1.1 },
        { key: 'distance', label: `Distance (${ctx.labels.distance})`, width: 1, type: 'number', align: 'right' },
        { key: 'expenses', label: 'Expenses', width: 1, type: 'money', align: 'right' },
        { key: 'earnings', label: 'Earnings', width: 1, type: 'money', align: 'right' },
        { key: 'net', label: 'Net', width: 1, type: 'money', align: 'right' },
        { key: 'status', label: 'Status', width: 0.9, type: 'status' }
      ],
      rows
    }],
    sections: [
      {
        title: 'Owner profile',
        rows: [
          { label: 'Owner', value: profile?.full_name || 'Fleet owner' },
          { label: 'Phone', value: profile?.phone_number || '—' },
          { label: 'Email', value: profile?.email || '—' },
          { label: 'Plan', value: profile?.plan || 'Free', status: 'good' },
          { label: 'Language', value: profile?.preferred_language || ctx.preferredLanguage || 'English' }
        ]
      },
      {
        title: 'Scope & coverage',
        rows: [
          { label: 'Assets in portfolio', value: String(rows.length) },
          { label: 'Active assets', value: String(activeVehicles) },
          { label: 'Open reminders', value: String(reminders.length) },
          { label: 'Currency', value: ctx.currency },
          { label: 'Units', value: `${ctx.unitSystem} (distance ${ctx.labels.distance}, volume ${ctx.labels.volume})` }
        ],
        lines: ['Every asset appears above - zero-activity assets are shown as KES 0, never hidden.']
      },
      {
        title: 'Data completeness',
        rows: [
          { label: 'Expense records scanned', value: String(expenses.length) },
          { label: 'Earning records scanned', value: String(earnings.length) },
          { label: 'Ledger rows shown', value: String(ledger.totals.shown) }
        ],
        lines: ['Your ledger lists every transaction in scope, grouped by month - nothing is sampled.']
      }
    ],
    notes: [
      `Generated by Saka Fleet on ${formatDate(now, ctx.locale, { timeZone: ctx.timeZone })} - ${ctx.timeZone}`,
      'Engine-calculated owner figures. Drivers never see this report or its earnings.'
    ]
  };

  return {
    ok: true,
    type: 'owner_portfolio',
    data,
    text: buildOwnerPortfolioText({ ctx, rows, totalEarnings, totalExpenses, netPayout, ledger })
  };
}

/** Deterministic WhatsApp digest for the owner portfolio. */
function buildOwnerPortfolioText({ ctx, rows, totalEarnings, totalExpenses, netPayout, ledger }) {
  const top = [...rows].sort((a, b) => b.expenses - a.expenses).slice(0, 3);
  return [
    `📁 *Owner Portfolio - ${rows.length} asset(s)*`,
    '',
    `• Revenue: *${money(totalEarnings, ctx.currency, ctx.locale)}*`,
    `• Expenses: *${money(totalExpenses, ctx.currency, ctx.locale)}*`,
    `• Net payouts: *${money(netPayout, ctx.currency, ctx.locale)}*`,
    `• Ledger: *${ledger.totals.shown} record(s)* - all shown`,
    '',
    '*Top assets by spend*',
    ...top.map((row) => `• ${row.plate} - ${money(row.expenses, ctx.currency, ctx.locale)} spend · net ${money(row.net, ctx.currency, ctx.locale)}`),
    '',
    '📄 A branded PDF with the consolidated ledger is attached/linked where email is available.'
  ].join('\n');
}

export default {
  buildOwnerPortfolio
};
