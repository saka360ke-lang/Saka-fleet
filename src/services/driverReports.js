import { formatDate, formatNumber } from './globalization.js';
import { daysUntilDue, reminderDueDate } from './maintenanceReminders.js';

/**
 * Saka Fleet — Driver-first reports (v1.18.0)
 * ------------------------------------------
 * Driver lane only: scoped to the assigned vehicle and the driver's own
 * activity. No owner earnings, no net profit, no other vehicles/drivers.
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

function kpi(label, value, hint) {
  return { label, value: String(value ?? '—'), hint };
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
    const { data } = await supabase.from('private_earnings').select('*').eq('driver_id', driverId).gte('created_at', since).limit(300);
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
    const key = String(row.expense_type || 'other').toLowerCase();
    categories[key] = (categories[key] || 0) + (Number(row.amount) || 0);
  });
  const categorySeries = Object.entries(categories).map(([label, value]) => ({ label, value }));

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
  countryInfo = null
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
      label: row.label || row.type || 'Compliance',
      number: maskNumber(row.number),
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

export default {
  buildDriverDaybook,
  buildVehicleHealthCheck,
  buildDriverComplianceCard
};



