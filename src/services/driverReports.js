import { buildGlobalContext, formatDate, formatNumber } from './globalization.js';
import { daysUntilDue, reminderDueDate } from './maintenanceReminders.js';
import { buildLedgerGroups, expenseKind } from './reportLedger.js';
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_KEYS } from './expenseCatalog.js';
import { driverComplianceLabel } from './driverComplianceCatalog.js';
// v1.92.0 (Phase 29) — LIVE earnings only (archived = the seller's history).
import { selectLiveEarnings } from './earningsScope.js';

/**
 * Saka Fleet — Driver-first reports (v1.29.0)
 * ------------------------------------------
 * Driver lane only: scoped to the assigned vehicle and the driver's own
 * activity. No owner earnings, no net profit, no other vehicles/drivers.
 * Owner lane adds the Driver Performance & Compliance report with a ledger.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function currencyOf(countryInfo, profile) {
  return countryInfo?.currency || profile?.currency || 'USD';
}

function localeOf(countryInfo) {
  return countryInfo?.locale || 'en-US';
}

function money(value, currency, locale) {
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
}

function kpi(label, value, hint, tone = null) {
  return { label, value: String(value ?? '—'), hint, ...(tone ? { tone } : {}) };
}

function maskNumber(value) {
  const clean = String(value || '').trim();
  if (clean.length <= 4) return clean || '—';
  return `${'•'.repeat(Math.max(0, clean.length - 4))}${clean.slice(-4)}`;
}

function statusFromDays(days) {
  if (days === null || days === undefined) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= 7) return 'due in 7 days';
  if (days <= 30) return 'due this month';
  return 'valid';
}

/** 📓 Driver Daybook — the driver's own week at a glance. */
export async function buildDriverDaybook({
  supabase,
  driverId,
  vehicleId = null,
  now = new Date(),
  days = 7,
  countryInfo = null,
  profile = null
} = {}) {
  if (!supabase || !driverId) return { ok: false, type: 'driver_daybook', error: 'Missing driver context' };
  const currency = currencyOf(countryInfo, profile);
  const locale = localeOf(countryInfo);
  const ctx = buildGlobalContext(countryInfo, profile);
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();

  let vehicles = [];
  try {
    const query = supabase.from('vehicles').select('*').is('deleted_at', null);
    const { data } = vehicleId
      ? await query.eq('id', vehicleId)
      : await query.eq('assigned_driver_id', driverId);
    vehicles = data || [];
  } catch { vehicles = []; }
  const scopedIds = vehicles.map((vehicle) => vehicle.id);

  let expenses = [];
  let earnings = [];
  try {
    const { data } = await supabase.from('expense_logs').select('*').eq('driver_id', driverId).gte('created_at', since).limit(300);
    expenses = (data || []).filter((row) => !scopedIds.length || scopedIds.includes(row.vehicle_id));
  } catch { expenses = []; }
  try {
    // v1.92.0 (Phase 29) — archived earnings belong to the seller's history.
    const { data } = await selectLiveEarnings(supabase, {
      apply: (query) => query.eq('driver_id', driverId).gte('created_at', since).limit(300)
    });
    earnings = (data || []).filter((row) => !scopedIds.length || scopedIds.includes(row.vehicle_id));
  } catch { earnings = []; }

  const fuelLitres = expenses.reduce((sum, row) => sum + (Number(row.fuel_liters) || 0), 0);
  const spend = expenses.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const earned = earnings.reduce((sum, row) => sum + (Number(row.revenue_amount ?? row.amount) || 0), 0);
  const odometers = expenses.map((row) => Number(row.odometer_reading)).filter((value) => Number.isFinite(value) && value > 0);
  const distance = odometers.length >= 2 ? Math.max(...odometers) - Math.min(...odometers) : null;

  const daily = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dayStart = new Date(now.getTime() - offset * DAY_MS);
    const key = dayStart.toISOString().slice(0, 10);
    const count = expenses.filter((row) => String(row.created_at || '').slice(0, 10) === key).length;
    daily.push({ label: dayStart.toLocaleDateString('en-GB', { weekday: 'short' }), value: count });
  }

  const categories = {};
  expenses.forEach((row) => {
    const key = expenseKind(row.expense_type);
    categories[key] = (categories[key] || 0) + (Number(row.amount) || 0);
  });
  const categorySeries = Object.entries(categories).map(([key, value]) => ({
    label: EXPENSE_CATEGORIES[key]?.label || key,
    value
  }));

  const recent = [...expenses]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 12)
    .map((row) => ({
      date: formatDate(row.created_at, locale),
      type: row.expense_type || 'Expense',
      plate: vehicles.find((vehicle) => vehicle.id === row.vehicle_id)?.plate_number || '—',
      amount: `${money(row.amount, currency, locale)}${Number(row.fuel_liters) ? ` · ${formatNumber(row.fuel_liters, locale)} L` : ''}`
    }));

  const plate = vehicles[0]?.plate_number || 'your vehicle';
  const kpis = [
    kpi('Entries logged', formatNumber(expenses.length + earnings.length, locale), `${days}-day window`),
    kpi('Fuel logged', `${formatNumber(fuelLitres, locale)} L`, plate),
    kpi('Spend recorded', money(spend, currency, locale), 'your own logs'),
    kpi('Earnings submitted', money(earned, currency, locale), 'your own logs'),
    kpi('Distance logged', distance ? `${formatNumber(distance, locale)} km` : '—', 'from odometer readings')
  ];
  return {
    ok: true,
    type: 'driver_daybook',
    data: {
      title: 'Driver Daybook',
      subtitle: `Your own activity over the last ${days} days on ${plate}`,
      periodLabel: `Last ${days} days`,
      kpis,
      charts: [
        { type: 'bar', title: 'Daily activity', note: 'Entries you logged each day', series: daily },
        { type: 'donut', title: 'Spend by category', totalLabel: 'total', series: categorySeries.length ? categorySeries : [{ label: 'No activity', value: 1 }] }
      ],
      ledgers: [buildLedgerGroups({
        expenses,
        earnings,
        vehicles,
        ctx,
        includeEarnings: true,
        title: 'Your activity ledger',
        subtitle: `Every entry you logged in the last ${days} days - nothing hidden`
      })],
      tables: [{
        title: 'Recent activity',
        currency,
        columns: [
          { key: 'date', label: 'Date', width: 1 },
          { key: 'type', label: 'Type', width: 1.2 },
          { key: 'plate', label: 'Vehicle', width: 1 },
          { key: 'amount', label: 'Details', width: 1.6, align: 'right' }
        ],
        rows: recent
      }],
      sections: [{
        title: 'How to keep this strong',
        lines: [
          'Log fuel with the odometer reading and say whether it was a full tank or a top-up.',
          'Submit earnings on the day they happen — daily logs build the clearest picture.',
          'Ask “vehicle health” before a long trip.'
        ]
      }]
    },
    text: `📓 *Driver Daybook — ${plate}*\n_Last ${days} days_\n\n` +
      `• Entries logged: *${formatNumber(expenses.length + earnings.length, locale)}*\n` +
      `• Fuel logged: *${formatNumber(fuelLitres, locale)} L*\n` +
      `• Spend recorded: *${money(spend, currency, locale)}*\n` +
      `• Earnings submitted: *${money(earned, currency, locale)}*\n` +
      `${distance ? `• Distance logged: *${formatNumber(distance, locale)} km*\n` : ''}` +
      '\n📄 A branded PDF copy is attached/linked where email is available.'
  };
}

function daysLeft(date, now = new Date()) {
  if (!date) return null;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return Math.ceil((value.getTime() - now.getTime()) / DAY_MS);
}

/** 🩺 Vehicle Health Check-in — pre-trip briefing for the assigned vehicle. */
export async function buildVehicleHealthCheck({
  supabase,
  vehicleId = null,
  driverId = null,
  now = new Date(),
  countryInfo = null
} = {}) {
  if (!supabase) return { ok: false, type: 'vehicle_health', error: 'Database unavailable' };
  const locale = localeOf(countryInfo);
  let vehicle = null;
  try {
    if (vehicleId) {
      const { data } = await supabase.from('vehicles').select('*').eq('id', vehicleId).is('deleted_at', null).maybeSingle();
      vehicle = data || null;
    } else if (driverId) {
      const { data } = await supabase.from('vehicles').select('*').eq('assigned_driver_id', driverId).is('deleted_at', null).limit(1);
      vehicle = (data || [])[0] || null;
    }
  } catch { vehicle = null; }
  if (!vehicle) return { ok: false, type: 'vehicle_health', error: 'No assigned vehicle found' };

  let reminders = [];
  try {
    const { data } = await supabase.from('reminders').select('*').eq('vehicle_id', vehicle.id).limit(100);
    reminders = (data || []).filter((row) => String(row.status || 'active').toUpperCase() !== 'COMPLETED');
  } catch { reminders = []; }

  const items = [];
  reminders.forEach((reminder) => {
    const due = reminderDueDate(reminder);
    if (!due) return;
    const left = daysLeft(due, now);
    items.push({ label: reminder.reminder_type || reminder.category || 'Reminder', due: formatDate(due, locale), daysLeft: left, status: statusFromDays(left) });
  });
  for (const [label, value] of [['Insurance', vehicle.insurance_expiry], ['Inspection', vehicle.inspection_expiry]]) {
    const left = daysLeft(value, now);
    if (left === null) continue;
    items.push({ label, due: formatDate(value, locale), daysLeft: left, status: statusFromDays(left) });
  }
  items.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

  const odometer = Number(vehicle.current_mileage ?? vehicle.odometer_reading) || 0;
  const nextItem = items[0] || null;
  const kpis = [
    kpi('Odometer', `${formatNumber(odometer, locale)} km`, vehicle.plate_number),
    kpi('Open reminders', formatNumber(items.length, locale), 'active items'),
    kpi('Next due', nextItem ? (nextItem.daysLeft < 0 ? 'Overdue' : `${nextItem.daysLeft} days`) : 'All clear', nextItem?.label || 'nothing due'),
    kpi('Vehicle', [vehicle.make_model, vehicle.fuel_type].filter(Boolean).join(' · ') || 'Fleet vehicle', 'assigned to you')
  ];

  return {
    ok: true,
    type: 'vehicle_health',
    data: {
      title: 'Vehicle Health Check-in',
      subtitle: `Pre-trip briefing for ${vehicle.plate_number}`,
      periodLabel: 'Today',
      kpis,
      charts: [{
        type: 'progress',
        title: 'Expiry runway (90 days)',
        max: 90,
        series: items.slice(0, 6).map((item) => ({
          label: item.label,
          value: Math.max(0, item.daysLeft ?? 0),
          text: item.daysLeft < 0 ? 'overdue' : `${item.daysLeft}d`
        }))
      }],
      tables: [{
        title: 'Upcoming items',
        columns: [
          { key: 'label', label: 'Item', width: 1.4 },
          { key: 'due', label: 'Due', width: 1 },
          { key: 'status', label: 'Status', width: 1.4, type: 'status' }
        ],
        rows: items
      }],
      sections: [{
        title: 'Before you drive',
        lines: [
          'Check tyre pressure, lights and fluids — 60 seconds keeps you safe.',
          'Log fuel with the odometer reading; say “full tank” or “top-up”.',
          items.some((item) => item.daysLeft < 0)
            ? 'One item is overdue — tell the owner so it can be renewed.'
            : 'Everything on this vehicle is in good standing.'
        ]
      }]
    },
    text: `🩺 *Vehicle Health — ${vehicle.plate_number}*\n\n` +
      `• Odometer: *${formatNumber(odometer, locale)} km*\n` +
      `• Open reminders: *${items.length}*\n` +
      (nextItem
        ? `• Next: *${nextItem.label}* — ${nextItem.daysLeft < 0 ? '*overdue*' : `in ${nextItem.daysLeft} days`}\n`
        : '• No upcoming expiries 🎉\n') +
      '\n✅ Drive safe. A branded PDF copy is attached/linked where email is available.'
  };
}

/** 🎫 My Compliance Card — the driver's own licence/permit status. */
export async function buildDriverComplianceCard({
  supabase,
  driverId,
  now = new Date(),
  countryInfo = null,
  // v1.76.0 (Phase 15, D3) — the driver's OWN dashboard shows real numbers;
  // every other surface (WhatsApp card, reports) keeps the mask.
  mask = true
} = {}) {
  if (!supabase || !driverId) return { ok: false, type: 'driver_compliance_card', error: 'Missing driver context' };
  const locale = localeOf(countryInfo);
  let rows = [];
  try {
    const { data } = await supabase.from('driver_compliances').select('*').eq('driver_id', driverId).limit(50);
    rows = data || [];
  } catch { rows = []; }

  const items = rows.map((row) => {
    const left = row.lifetime ? null : daysLeft(row.expiry, now);
    return {
      label: row.label || (row.type ? driverComplianceLabel(row.type) : 'Compliance'),
      number: mask ? maskNumber(row.number) : (row.number || '—'),
      expiry: row.lifetime ? 'Valid for life' : (row.expiry ? formatDate(row.expiry, locale) : 'Not set'),
      status: row.lifetime ? 'valid' : statusFromDays(left),
      daysLeft: left
    };
  });
  const valid = items.filter((item) => !/expired|due/.test(item.status)).length;
  const expiring = items.filter((item) => /due/.test(item.status)).length;
  const expired = items.filter((item) => /expired/.test(item.status)).length;

  return {
    ok: true,
    type: 'driver_compliance_card',
    data: {
      title: 'My Compliance Card',
      subtitle: 'Your professional documents, always ready',
      periodLabel: 'Current',
      kpis: [
        kpi('Documents', formatNumber(items.length, locale), 'on your profile'),
        kpi('Valid', formatNumber(valid, locale), 'good standing'),
        kpi('Expiring soon', formatNumber(expiring, locale), 'renew early'),
        kpi('Expired', formatNumber(expired, locale), expired ? 'action needed' : 'all clear')
      ],
      charts: [{
        type: 'progress',
        title: 'Renewal runway (90 days)',
        max: 90,
        series: items.filter((item) => item.daysLeft !== null).slice(0, 6).map((item) => ({
          label: item.label,
          value: Math.max(0, item.daysLeft ?? 0),
          text: item.daysLeft < 0 ? 'expired' : `${item.daysLeft}d`
        }))
      }],
      tables: [{
        title: 'Your documents',
        columns: [
          { key: 'label', label: 'Document', width: 1.5 },
          { key: 'number', label: 'Number', width: 1.2 },
          { key: 'expiry', label: 'Expiry', width: 1.1 },
          { key: 'status', label: 'Status', width: 1.2, type: 'status' }
        ],
        rows: items
      }],
      sections: [{
        title: 'Keep it current',
        lines: [
          'Renew before the expiry date — Saka reminds you 30, 14 and 7 days ahead.',
          'Show this card at checkpoints instead of paper documents.'
        ]
      }]
    },
    text: `🎫 *My Compliance Card*\n\n` +
      (items.length
        ? items.map((item) => `• *${item.label}*: ${item.expiry} — ${item.status}`).join('\n')
        : 'No compliance documents on file yet. Reply *“driver profile”* to add your licence.') +
      '\n\n📄 A branded PDF copy is attached/linked where email is available.'
  };
}

/**
 * 🧑‍✈️ Driver Performance & Compliance (owner lane, v1.29.0)
 * Activity, adherence, fill discipline, compliance verification, a daily
 * activity log and the driver's full itemized ledger. Never cross-driver.
 */
export async function buildDriverPerformance({
  supabase,
  ownerId = null,
  driverId = null,
  now = new Date(),
  days = 90,
  countryInfo = null,
  profile = null
} = {}) {
  if (!supabase) return { ok: false, type: 'driver_performance', error: 'Database unavailable.' };
  const ctx = buildGlobalContext(countryInfo, profile);
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();

  let vehicles = [];
  try {
    let query = supabase.from('vehicles').select('*').is('deleted_at', null).limit(200);
    if (driverId) query = query.eq('assigned_driver_id', driverId);
    if (ownerId) query = query.eq('owner_id', ownerId);
    const { data } = await query;
    vehicles = data || [];
  } catch { vehicles = []; }

  if (!driverId && ownerId) {
    const candidate = vehicles.find((vehicle) => vehicle.assigned_driver_id);
    if (candidate) {
      driverId = candidate.assigned_driver_id;
      vehicles = vehicles.filter((vehicle) => vehicle.assigned_driver_id === driverId);
    }
  }
  if (!driverId) {
    return { ok: false, type: 'driver_performance', error: 'No driver is assigned to this fleet yet. Assign a driver to unlock this report.' };
  }
  if (ownerId && !vehicles.some((vehicle) => vehicle.owner_id === ownerId && vehicle.assigned_driver_id === driverId)) {
    return { ok: false, type: 'driver_performance', denied: true, error: 'That driver is not assigned to any of your vehicles.' };
  }

  let driverProfile = null;
  try {
    const { data } = await supabase.from('profiles').select('id, full_name, phone_number, email').eq('id', driverId).maybeSingle();
    driverProfile = data || null;
  } catch { driverProfile = null; }

  const scopeIds = vehicles.map((vehicle) => vehicle.id);
  let expenses = [];
  try {
    const { data } = await supabase.from('expense_logs').select('*').eq('driver_id', driverId).gte('created_at', since).limit(2000);
    expenses = (data || []).filter((row) => !scopeIds.length || scopeIds.includes(row.vehicle_id));
  } catch { expenses = []; }
  let earnings = [];
  try {
    // v1.92.0 (Phase 29) — archived earnings belong to the seller's history.
    const { data } = await selectLiveEarnings(supabase, {
      apply: (query) => query.eq('driver_id', driverId).gte('created_at', since).limit(2000)
    });
    earnings = (data || []).filter((row) => !scopeIds.length || scopeIds.includes(row.vehicle_id));
  } catch { earnings = []; }
  let compliances = [];
  try {
    const { data } = await supabase.from('driver_compliances').select('*').eq('driver_id', driverId).limit(50);
    compliances = data || [];
  } catch { compliances = []; }

  // Engine-owned performance math.
  const fuelRows = expenses.filter((row) => expenseKind(row.expense_type) === 'fuel');
  const spend = expenses.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const earned = earnings.reduce((sum, row) => sum + (Number(row.revenue_amount ?? row.amount) || 0), 0);
  const odometers = expenses
    .map((row) => Number(row.odometer_reading))
    .filter((value) => Number.isFinite(value) && value > 0);
  const distanceKm = odometers.length >= 2 ? Math.max(...odometers) - Math.min(...odometers) : null;
  const distanceDisplay = distanceKm === null ? null : (ctx.unitSystem === 'imperial' ? distanceKm / 1.609344 : distanceKm);
  const labelledFills = fuelRows.filter((row) => row.fill_type).length;
  const fullFills = fuelRows.filter((row) => String(row.fill_type || '').toLowerCase() === 'full').length;
  const fillDiscipline = fuelRows.length ? Math.round((fullFills / fuelRows.length) * 100) : null;

  const dayKeys = new Set();
  for (const row of [...expenses, ...earnings]) {
    const at = row.created_at || row.logged_at;
    if (at) dayKeys.add(String(at).slice(0, 10));
  }
  const activeDays = dayKeys.size;
  const adherence = Math.round((activeDays / days) * 100);

  const daily = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * DAY_MS);
    const key = day.toISOString().slice(0, 10);
    const count = [...expenses, ...earnings]
      .filter((row) => String(row.created_at || row.logged_at || '').slice(0, 10) === key).length;
    daily.push({ label: day.toLocaleDateString('en-GB', { weekday: 'short' }), value: count });
  }

  const categoryTotals = Object.fromEntries(EXPENSE_CATEGORY_KEYS.map((key) => [key, 0]));
  for (const row of expenses) {
    const key = expenseKind(row.expense_type);
    categoryTotals[key] = (categoryTotals[key] || 0) + (Number(row.amount) || 0);
  }
  const categorySeries = Object.entries(categoryTotals)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ label: EXPENSE_CATEGORIES[key]?.label || key, value: Math.round(value * 100) / 100 }));

  const complianceItems = compliances.map((row) => {
    const left = row.lifetime ? null : daysUntilDue(row.expiry, now);
    const status = row.lifetime ? 'valid' : (left === null ? 'unknown' : left < 0 ? 'expired' : left <= 30 ? 'due' : 'valid');
    return {
      label: row.label || driverComplianceLabel(row.type),
      number: maskNumber(row.number),
      expiry: row.lifetime ? 'Valid for life' : (row.expiry ? formatDate(row.expiry, localeOf(countryInfo), { timeZone: ctx.timeZone }) : 'Not set'),
      status,
      daysLeft: left
    };
  });
  const complianceValid = complianceItems.filter((item) => item.status === 'valid').length;
  const complianceDue = complianceItems.filter((item) => item.status === 'due').length;
  const complianceExpired = complianceItems.filter((item) => item.status === 'expired').length;

  const dayMap = new Map();
  for (const row of expenses) {
    const key = String(row.created_at || '').slice(0, 10);
    if (!key) continue;
    if (!dayMap.has(key)) dayMap.set(key, { entries: 0, spend: 0, min: null, max: null });
    const day = dayMap.get(key);
    day.entries += 1;
    day.spend += Number(row.amount) || 0;
    const odometer = Number(row.odometer_reading);
    if (Number.isFinite(odometer) && odometer > 0) {
      day.min = day.min === null ? odometer : Math.min(day.min, odometer);
      day.max = day.max === null ? odometer : Math.max(day.max, odometer);
    }
  }
  const activityRows = [...dayMap.entries()]
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .slice(0, 31)
    .map(([key, value]) => ({
      date: formatDate(key, localeOf(countryInfo), { timeZone: ctx.timeZone }),
      entries: value.entries,
      distance: value.min !== null && value.max !== null ? Math.round((value.max - value.min) * 10) / 10 : null,
      spend: Math.round(value.spend * 100) / 100
    }));

  const ledger = buildLedgerGroups({
    expenses,
    earnings,
    vehicles,
    ctx,
    includeEarnings: true,
    title: `Activity ledger - ${driverProfile?.full_name || 'driver'}`,
    subtitle: 'Every log and earning submitted by this driver in the period'
  });

  const complianceProgress = complianceItems
    .filter((item) => Number.isFinite(item.daysLeft))
    .slice(0, 6)
    .map((item) => ({ label: item.label, value: Math.max(0, item.daysLeft), text: item.daysLeft < 0 ? 'expired' : `${item.daysLeft}d` }));

  const callouts = [
    {
      tone: adherence >= 50 ? 'positive' : 'warn',
      title: 'Logging adherence',
      body: `${activeDays} active day(s) out of ${days} (${adherence}%). Daily logs build the clearest vehicle history and the strongest passbook.`
    },
    ...(fuelRows.length ? [{
      tone: fillDiscipline >= 60 ? 'positive' : 'warn',
      title: 'Fuel data discipline',
      body: `${fullFills} of ${fuelRows.length} fuel fill(s) marked full tank (${fillDiscipline}%; ${labelledFills} labelled). Full-to-full fills give exact km/L.`
    }] : []),
    ...(complianceItems.length ? [{
      tone: complianceExpired ? 'negative' : (complianceDue ? 'warn' : 'positive'),
      title: 'Compliance verification',
      body: `${complianceValid} valid document(s), ${complianceDue} expiring within 30 days, ${complianceExpired} expired.`
    }] : [{
      tone: 'warn',
      title: 'Compliance not on file',
      body: 'No driver documents are recorded yet. Add the licence and badge so this report can verify compliance.'
    }])
  ];

  const driverLocale = localeOf(countryInfo);
  const driverCurrency = currencyOf(countryInfo, profile);
  const kpis = [
    kpi('Entries logged', formatNumber(expenses.length + earnings.length, driverLocale), `last ${days} days`),
    kpi('Active days', `${activeDays} of ${days}`, `${adherence}% adherence`),
    kpi('Distance logged', distanceDisplay === null ? '—' : `${formatNumber(Math.round(distanceDisplay), driverLocale)} ${ctx.labels.distance}`, 'between odometer readings'),
    kpi('Spend recorded', money(spend, driverCurrency, driverLocale), 'driver logs', 'negative'),
    kpi('Earnings submitted', money(earned, driverCurrency, driverLocale), 'driver logs', 'positive'),
    kpi('Compliance valid', complianceItems.length ? `${complianceValid}/${complianceItems.length}` : '—', complianceExpired ? `${complianceExpired} expired` : 'no expired documents', complianceExpired ? 'negative' : 'positive')
  ];

  const data = {
    title: `Driver Performance - ${driverProfile?.full_name || 'Driver'}`,
    subtitle: `Activity, adherence and compliance over the last ${days} days`,
    reportType: 'driver_performance',
    plate: vehicles.length === 1 ? vehicles[0].plate_number : null,
    periodLabel: `Last ${days} days`,
    generatedAt: now.toISOString(),
    currency: driverCurrency,
    kpis,
    charts: [
      { type: 'bar', title: 'Daily activity', note: 'Entries this driver logged each day (14-day window)', series: daily },
      ...(categorySeries.length ? [{
        type: 'segment',
        title: 'Spend by category',
        note: 'This driver\'s logged expenses',
        currency: driverCurrency,
        segments: categorySeries
      }] : []),
      ...(complianceProgress.length ? [{
        type: 'progress',
        title: 'Compliance runway',
        max: 90,
        series: complianceProgress
      }] : [])
    ],
    ledgers: [ledger],
    callouts,
    tables: [
      {
        title: 'Daily activity log',
        subtitle: 'Every day this driver logged activity - nothing omitted',
        currency: driverCurrency,
        columns: [
          { key: 'date', label: 'Date', width: 1.2 },
          { key: 'entries', label: 'Entries', width: 0.8, type: 'number', align: 'right' },
          { key: 'distance', label: 'Distance', width: 0.9, type: 'number', align: 'right' },
          { key: 'spend', label: 'Spend', width: 1, type: 'money', align: 'right' }
        ],
        rows: activityRows
      },
      ...(complianceItems.length ? [{
        title: 'Compliance documents',
        columns: [
          { key: 'label', label: 'Document', width: 1.4 },
          { key: 'number', label: 'Number', width: 1.1 },
          { key: 'expiry', label: 'Expiry', width: 1.1 },
          { key: 'status', label: 'Status', width: 0.9, type: 'status' }
        ],
        rows: complianceItems
      }] : [])
    ],
    sections: [
      {
        title: 'Driver profile',
        rows: [
          { label: 'Driver', value: driverProfile?.full_name || 'Assigned driver' },
          { label: 'Phone', value: driverProfile?.phone_number || '—' },
          { label: 'Email', value: driverProfile?.email || '—' },
          { label: 'Assigned vehicle(s)', value: vehicles.map((vehicle) => vehicle.plate_number).filter(Boolean).join(', ') || '—' },
          { label: 'Period', value: `Last ${days} days` }
        ]
      },
      {
        title: 'Data completeness',
        rows: [
          { label: 'Expense records scanned', value: String(expenses.length) },
          { label: 'Earning records scanned', value: String(earnings.length) },
          { label: 'Ledger rows shown', value: String(ledger.totals.shown) },
          { label: 'Compliance documents', value: String(complianceItems.length) }
        ],
        lines: ['Only this driver\'s own logs are shown - no other driver and no owner-only data.']
      }
    ],
    notes: [
      `Generated by Saka Fleet on ${formatDate(now, ctx.locale, { timeZone: ctx.timeZone })} - ${ctx.timeZone}`,
      'Engine-calculated from the driver\'s logged records. Adherence counts days with at least one log.'
    ]
  };

  const text = [
    `🧑‍✈️ *Driver Performance - ${driverProfile?.full_name || 'Driver'}*`,
    `_Last ${days} days_`,
    '',
    `• Entries logged: *${formatNumber(expenses.length + earnings.length, driverLocale)}*`,
    `• Active days: *${activeDays} of ${days}* (${adherence}%)`,
    distanceDisplay === null ? null : `• Distance logged: *${formatNumber(Math.round(distanceDisplay), driverLocale)} ${ctx.labels.distance}*`,
    `• Spend recorded: *${money(spend, driverCurrency, driverLocale)}*`,
    `• Compliance: *${complianceItems.length ? `${complianceValid}/${complianceItems.length} valid` : 'not on file'}*`,
    '',
    '📄 A branded PDF with the daily activity log and itemized ledger is attached/linked where email is available.'
  ].filter((line) => line !== null).join('\n');

  return { ok: true, type: 'driver_performance', data, text };
}

export default {
  buildDriverDaybook,
  buildVehicleHealthCheck,
  buildDriverComplianceCard,
  buildDriverPerformance
};



