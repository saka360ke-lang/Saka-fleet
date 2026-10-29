/**
 * Saka Fleet — Core Fleet Reporting Service (v1.9)
 * ------------------------------------------------
 * Structured data collection + WhatsApp-friendly formatting for the four
 * executive reports:
 *
 *   1. Fleet Status Report      — availability, health index, urgent items.
 *   2. Compliance & Expiry      — insurance / inspection / licence / permit matrix.
 *   3. Maintenance & Service    — thresholds, PM compliance, service history.
 *   4. Financial & Cost         — expenses, earnings, net per asset, cost/km.
 *
 * Every builder returns { ok, type, data (structured JSON), text (WhatsApp) }
 * and localizes currency, units and dates through globalization.js — never a
 * hard-coded KES.
 */

import {
  buildGlobalContext,
  formatNumber,
  formatMoney,
  formatDate,
  kmToUserDistance,
  resolveUserTimezone
} from './globalization.js';
import { detectExpiryCategory, reminderDueDate, daysUntilDue } from './maintenanceReminders.js';

export const REPORT_TYPES = Object.freeze({
  fleet: { label: 'Fleet Status Report', aliases: ['fleet', 'status', 'overview', 'executive', 'rollup', 'summary'] },
  compliance: { label: 'Compliance & Expiry Report', aliases: ['compliance', 'insurance', 'expiry', 'expiries', 'license', 'licence', 'inspection', 'permit', 'regulatory'] },
  maintenance: { label: 'Maintenance & Service Report', aliases: ['maintenance', 'service', 'repair', 'repairs', 'workshop', 'servicing'] },
  financial: { label: 'Financial & Cost Report', aliases: ['financial', 'finance', 'cost', 'costs', 'expense', 'expenses', 'profit', 'earnings', 'revenue', 'tco'] }
});

/** Resolve a report type from free text ("show me the compliance report"). */
export function resolveReportType(text, fallback = 'fleet') {
  const clean = String(text || '').toLowerCase();
  if (!clean) return fallback;
  for (const [type, meta] of Object.entries(REPORT_TYPES)) {
    if (new RegExp(`\\b${type}\\b`, 'i').test(clean)) return type;
    if (meta.aliases.some((alias) => new RegExp(`\\b${alias}\\b`, 'i').test(clean))) return type;
  }
  return fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KNOWN_CATEGORIES = ['insurance', 'inspection', 'licensing', 'permit', 'driver_license', 'maintenance', 'deadline', 'other'];

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function monthStartMs(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function isActiveVehicle(vehicle) {
  return String(vehicle?.status || 'ACTIVE').toUpperCase() === 'ACTIVE' && !vehicle?.deleted_at;
}

function normalizeCategory(...values) {
  const parts = values.map((v) => String(v || '').toLowerCase()).filter(Boolean);
  for (const part of parts) {
    if (KNOWN_CATEGORIES.includes(part)) return part;
  }
  return detectExpiryCategory(parts.join(' '));
}

function expenseCategory(expenseType) {
  const clean = String(expenseType || '').toLowerCase();
  if (/fuel|petrol|diesel|gas|charge/.test(clean)) return 'fuel';
  if (/part|tyre|tire|battery|filter/.test(clean)) return 'parts';
  if (/toll|parking|gate|road fee/.test(clean)) return 'tolls';
  if (/repair|service|maintenance|mechanic|workshop/.test(clean)) return 'maintenance';
  return 'other';
}

function vehicleDisplay(vehicle, ctx) {
  const value = toNumber(vehicle.current_mileage ?? vehicle.odometer_reading);
  const distance = ctx.unitSystem === 'imperial' ? kmToUserDistance(value, 'imperial') : value;
  return { odometer: Math.round(distance), distanceUnit: ctx.labels.distance };
}

function expiryStatus(daysLeft) {
  if (daysLeft === null) return 'unknown';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 7) return 'due_7d';
  if (daysLeft <= 14) return 'due_14d';
  if (daysLeft <= 30) return 'due_30d';
  return 'active';
}

function plateFor(vehicleId, vehicles) {
  const vehicle = vehicles.find((v) => v.id === vehicleId);
  return vehicle?.plate_number || 'Fleet vehicle';
}

/** Load the shared fleet dataset used by all four reports. */
async function loadFleetData({ supabase, ownerId = null, driverId = null, vehicleId = null }) {
  const empty = { vehicles: [], reminders: [], expenses: [], earnings: [], transfers: [], profiles: [], notificationLog: [] };
  if (!supabase) return empty;

  const scopes = [];
  if (ownerId) scopes.push({ column: 'owner_id', value: ownerId });
  if (driverId) scopes.push({ column: 'assigned_driver_id', value: driverId });
  if (scopes.length === 0) scopes.push({ column: null, value: null });

  let vehicles = [];
  const seenVehicles = new Set();
  for (const scope of scopes) {
    let vehicleQuery = supabase.from('vehicles').select('*').is('deleted_at', null).limit(500);
    if (vehicleId) vehicleQuery = vehicleQuery.eq('id', vehicleId);
    if (scope.column) vehicleQuery = vehicleQuery.eq(scope.column, scope.value);
    try {
      const { data } = await vehicleQuery;
      for (const vehicle of data || []) {
        if (!seenVehicles.has(vehicle.id)) {
          seenVehicles.add(vehicle.id);
          vehicles.push(vehicle);
        }
      }
    } catch (err) {
      console.warn('[fleetReports] Vehicle query failed:', err.message);
    }
  }
  if (vehicles.length === 0) return empty;

  const vehicleIds = vehicles.map((v) => v.id).filter(Boolean);
  const driverIds = [...new Set(vehicles.map((v) => v.assigned_driver_id).filter(Boolean))];
  const profileIds = [...new Set([
    ...vehicles.map((v) => v.owner_id),
    ...vehicles.map((v) => v.assigned_driver_id)
  ].filter(Boolean))];

  let reminders = [];
  try {
    const { data } = await supabase.from('reminders').select('*').in('vehicle_id', vehicleIds).limit(500);
    reminders = data || [];
  } catch { reminders = []; }

  if (driverIds.length > 0) {
    try {
      const { data } = await supabase.from('reminders').select('*').eq('subject_type', 'driver').in('subject_id', driverIds).limit(200);
      const seen = new Set(reminders.map((r) => r.id));
      for (const row of data || []) {
        if (!seen.has(row.id)) reminders.push(row);
      }
    } catch { /* driver reminders are optional */ }
  }

  let expenses = [];
  try {
    const { data } = await supabase.from('expense_logs').select('*').in('vehicle_id', vehicleIds).limit(2000);
    expenses = data || [];
  } catch { expenses = []; }

  let earnings = [];
  try {
    const { data } = await supabase.from('private_earnings').select('*').in('vehicle_id', vehicleIds).limit(2000);
    earnings = data || [];
  } catch { earnings = []; }

  let transfers = [];
  try {
    const { data } = await supabase.from('passbook_transfers').select('*').in('vehicle_id', vehicleIds).limit(100);
    transfers = data || [];
  } catch { transfers = []; }

  let profiles = [];
  if (profileIds.length > 0) {
    try {
      const { data } = await supabase.from('profiles').select('id, phone_number, full_name, timezone').in('id', profileIds);
      profiles = data || [];
    } catch { profiles = []; }
  }

  let notificationLog = [];
  try {
    const { data } = await supabase.from('expiry_notification_log').select('*').in('vehicle_id', vehicleIds).limit(200);
    notificationLog = data || [];
  } catch { notificationLog = []; }

  return { vehicles, reminders, expenses, earnings, transfers, profiles, notificationLog };
}

/** Unified expiry item list from reminders + canonical vehicle date columns. */
function collectExpiryItems({ vehicles, reminders }, now, ctx) {
  const items = [];
  const seen = new Set();

  for (const reminder of reminders || []) {
    const dueDate = reminderDueDate(reminder);
    if (!dueDate) continue;
    const category = normalizeCategory(reminder.category, reminder.reminder_type);
    const key = `${reminder.vehicle_id || reminder.subject_id}:${category}`;
    seen.add(key);
    items.push({
      reminderId: reminder.id,
      vehicleId: reminder.vehicle_id || null,
      plate: reminder.vehicle_id ? plateFor(reminder.vehicle_id, vehicles) : 'Assigned driver',
      category,
      reminderType: reminder.reminder_type || category,
      dueDate,
      daysLeft: daysUntilDue(dueDate, now),
      status: expiryStatus(daysUntilDue(dueDate, now)),
      subjectType: reminder.subject_type || 'vehicle',
      notes: reminder.notes || null
    });
  }

  const canonicalColumns = [
    ['insurance_expiry', 'insurance', 'Insurance Renewal'],
    ['inspection_expiry', 'inspection', 'Inspection'],
    ['road_license_expiry', 'licensing', 'Road License'],
    ['permit_expiry', 'permit', 'Permit']
  ];
  for (const vehicle of vehicles || []) {
    for (const [column, category, reminderType] of canonicalColumns) {
      const raw = vehicle[column];
      if (!raw) continue;
      const dueDate = String(raw).slice(0, 10);
      const key = `${vehicle.id}:${category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const daysLeft = daysUntilDue(dueDate, now);
      items.push({
        reminderId: null,
        vehicleId: vehicle.id,
        plate: vehicle.plate_number || 'Fleet vehicle',
        category,
        reminderType,
        dueDate,
        daysLeft,
        status: expiryStatus(daysLeft),
        subjectType: 'vehicle',
        notes: null
      });
    }
  }

  return items.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
}

/* ------------------------------------------------------------------ */
/* 1. Fleet Status Report                                              */
/* ------------------------------------------------------------------ */

/** Distance covered this month, derived from odometer readings on expense logs. */
function distanceThisMonth(expenses, now) {
  const start = monthStartMs(now);
  const byVehicle = new Map();
  for (const expense of expenses || []) {
    const ts = new Date(expense.created_at || expense.logged_at || 0).getTime();
    if (!Number.isFinite(ts) || ts < start) continue;
    const odo = Number(expense.odometer_reading ?? expense.odometer);
    if (!Number.isFinite(odo) || odo <= 0) continue;
    const list = byVehicle.get(expense.vehicle_id) || [];
    list.push(odo);
    byVehicle.set(expense.vehicle_id, list);
  }
  let km = 0;
  for (const readings of byVehicle.values()) {
    if (readings.length >= 2) km += Math.max(...readings) - Math.min(...readings);
  }
  return km;
}

export async function buildFleetStatusReport({ supabase, ownerId = null, driverId = null, vehicleId = null, countryInfo = null, profile = null, now = new Date() } = {}) {
  if (!supabase) return { ok: false, type: 'fleet', error: 'Database unavailable.' };
  const ctx = buildGlobalContext(countryInfo, profile);
  const dataset = await loadFleetData({ supabase, ownerId, driverId, vehicleId });
  const { vehicles, reminders, expenses, transfers } = dataset;

  const activeVehicles = vehicles.filter(isActiveVehicle);
  const unassignedVehicles = vehicles.filter((v) => !v.assigned_driver_id).length;
  const driverSet = new Set(vehicles.map((v) => v.assigned_driver_id).filter(Boolean));
  const ownerSet = new Set(vehicles.map((v) => v.owner_id).filter(Boolean));
  const totalKm = vehicles.reduce((sum, v) => sum + toNumber(v.current_mileage ?? v.odometer_reading), 0);
  const monthKm = distanceThisMonth(expenses, now);
  const monthDisplayKm = ctx.unitSystem === 'imperial' ? kmToUserDistance(monthKm, 'imperial') : monthKm;
  const operatingHours = vehicles.reduce((sum, v) => sum + toNumber(v.operating_hours), 0);

  const expiryItems = collectExpiryItems(dataset, now, ctx);
  const overdueExpiries = expiryItems.filter((item) => item.daysLeft !== null && item.daysLeft < 0);
  const expiredInsurance = expiryItems.filter((item) => item.category === 'insurance' && item.status === 'expired');
  const expiredInspection = expiryItems.filter((item) => item.category === 'inspection' && item.status === 'expired');
  const upcoming30 = expiryItems.filter((item) => item.daysLeft !== null && item.daysLeft >= 0 && item.daysLeft <= 30);
  const overdueThresholds = (reminders || []).filter((rem) =>
    ['distance', 'hours'].includes(String(rem.threshold_unit || '').toLowerCase()) && toNumber(rem.remaining_value) <= 0
  );

  const sortedExpenses = [...(expenses || [])].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const sortedTransfers = [...(transfers || [])].sort((a, b) => new Date(b.completed_at || b.created_at || 0) - new Date(a.completed_at || a.created_at || 0));
  const recentActivity = [
    ...vehicles.slice(-3).map((v) => ({ type: 'vehicle_registered', label: `${v.plate_number} registered`, at: v.created_at || null })),
    ...sortedTransfers.slice(0, 3).map((t) => ({ type: 'passbook_transfer', label: `${plateFor(t.vehicle_id, vehicles)} transfer ${String(t.status || '').toLowerCase()}`, at: t.completed_at || t.created_at || null })),
    ...sortedExpenses.slice(0, 3).map((e) => ({ type: 'expense_logged', label: `${plateFor(e.vehicle_id, vehicles)} ${e.expense_type || 'expense'} ${formatMoney(toNumber(e.amount), ctx.currency, ctx.locale)}`, at: e.created_at || null }))
  ].filter((item) => item.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);

  const data = {
    type: 'fleet',
    generatedAt: now.toISOString(),
    timeZone: ctx.timeZone,
    scope: ownerId ? 'owner' : 'fleet',
    currency: ctx.currency,
    overview: {
      totalVehicles: vehicles.length,
      activeVehicles: activeVehicles.length,
      unassignedVehicles,
      activeDrivers: driverSet.size,
      owners: ownerSet.size
    },
    health: {
      availabilityRate: vehicles.length ? Math.round((activeVehicles.length / vehicles.length) * 1000) / 10 : 0,
      distanceThisMonth: Math.round(monthDisplayKm),
      distanceUnit: ctx.labels.distance,
      totalOdometer: Math.round(ctx.unitSystem === 'imperial' ? kmToUserDistance(totalKm, 'imperial') : totalKm),
      operatingHours: Math.round(operatingHours * 10) / 10,
      expiryItemsMonitored: expiryItems.length,
      upcoming30Days: upcoming30.length
    },
    urgent: {
      overdueMaintenance: overdueThresholds.length,
      overdueExpiries: overdueExpiries.length,
      expiredInsurance: expiredInsurance.length,
      expiredInspection: expiredInspection.length,
      total: overdueThresholds.length + overdueExpiries.length
    },
    recentActivity
  };

  return { ok: true, type: 'fleet', data, text: formatFleetStatusText(data, ctx) };
}

function formatFleetStatusText(data, ctx) {
  const lines = [
    `📊 *${REPORT_TYPES.fleet.label}*`,
    `_${formatDate(data.generatedAt, ctx.locale, { timeZone: ctx.timeZone })} • ${ctx.timeZone}_`,
    '',
    '🚗 *Fleet Overview*',
    `• Vehicles: ${data.overview.totalVehicles} (${data.overview.activeVehicles} active, ${data.overview.unassignedVehicles} unassigned)`,
    `• Active drivers: ${data.overview.activeDrivers}`,
    '',
    '🩺 *Operational Health*',
    `• Availability: ${data.health.availabilityRate}%`,
    `• Distance this month: ${formatNumber(data.health.distanceThisMonth, ctx.locale)} ${data.health.distanceUnit}`,
    `• Operating hours logged: ${formatNumber(data.health.operatingHours, ctx.locale)}`,
    `• Expiry items monitored: ${data.health.expiryItemsMonitored} (${data.health.upcoming30Days} in the next 30 days)`,
    '',
    '🚨 *Urgent Action Items*',
    `• Overdue maintenance: ${data.urgent.overdueMaintenance}`,
    `• Overdue expiries: ${data.urgent.overdueExpiries}`,
    `• Expired insurance: ${data.urgent.expiredInsurance}`,
    `• Expired inspections: ${data.urgent.expiredInspection}`
  ];
  if (data.recentActivity.length > 0) {
    lines.push('', '🕒 *Recent Activity*');
    for (const item of data.recentActivity) {
      lines.push(`• ${item.label} (${formatDate(item.at, ctx.locale, { timeZone: ctx.timeZone })})`);
    }
  }
  lines.push('', 'Reply *compliance report*, *maintenance report* or *financial report* for detail.');
  return lines.join('\n');
}



/* ------------------------------------------------------------------ */
/* 2. Compliance & Expiry Report                                       */
/* ------------------------------------------------------------------ */

function summarizeCategory(items, category) {
  const rows = items.filter((item) => item.category === category);
  return {
    total: rows.length,
    active: rows.filter((row) => row.status === 'active').length,
    due30: rows.filter((row) => row.status === 'due_30d').length,
    due14: rows.filter((row) => row.status === 'due_14d').length,
    due7: rows.filter((row) => row.status === 'due_7d').length,
    expired: rows.filter((row) => row.status === 'expired').length,
    items: rows
  };
}

export async function buildComplianceReport({ supabase, ownerId = null, driverId = null, vehicleId = null, countryInfo = null, profile = null, now = new Date() } = {}) {
  if (!supabase) return { ok: false, type: 'compliance', error: 'Database unavailable.' };
  const ctx = buildGlobalContext(countryInfo, profile);
  const dataset = await loadFleetData({ supabase, ownerId, driverId, vehicleId });
  const items = collectExpiryItems(dataset, now, ctx);

  const insurance = summarizeCategory(items, 'insurance');
  const inspections = summarizeCategory(items, 'inspection');
  const permits = summarizeCategory(items, 'permit');
  const licensing = summarizeCategory(items, 'licensing');
  const driverLicenses = summarizeCategory(items, 'driver_license');

  const notificationLog = [...(dataset.notificationLog || [])]
    .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0))
    .slice(0, 10)
    .map((row) => ({
      tier: row.tier,
      category: row.category,
      plate: row.vehicle_id ? plateFor(row.vehicle_id, dataset.vehicles) : 'Assigned driver',
      phone: row.phone,
      sentAt: row.sent_at,
      message: row.message || null
    }));

  const upcoming = items.filter((item) => item.daysLeft !== null && item.daysLeft >= 0 && item.daysLeft <= 30);
  const actionPrompt = upcoming.slice(0, 5).map((item) => {
    const target = new Date(now.getTime() + Math.max(item.daysLeft, 1) * DAY_MS).toISOString().slice(0, 10);
    return `Update ${item.reminderType.toLowerCase()} for ${item.plate} to ${target}`;
  });

  const data = {
    type: 'compliance',
    generatedAt: now.toISOString(),
    timeZone: ctx.timeZone,
    currency: ctx.currency,
    insuranceStatusMatrix: insurance,
    inspectionAndPermits: { inspections, permits, licensing },
    driverLicenses,
    notificationLog,
    actionPrompt,
    totals: {
      monitored: items.length,
      active: items.filter((item) => item.status === 'active').length,
      expiring30Days: upcoming.length,
      expiring7Days: items.filter((item) => item.status === 'due_7d').length,
      expired: items.filter((item) => item.status === 'expired').length
    }
  };

  return { ok: true, type: 'compliance', data, text: formatComplianceText(data, ctx) };
}

function expiryLine(item, ctx) {
  const due = formatDate(`${item.dueDate}T12:00:00Z`, ctx.locale, { timeZone: ctx.timeZone });
  if (item.daysLeft === null) return `${item.plate}: ${item.reminderType} — date unavailable`;
  if (item.daysLeft < 0) return `${item.plate}: ${item.reminderType} EXPIRED ${Math.abs(item.daysLeft)} day(s) ago (${due})`;
  if (item.daysLeft === 0) return `${item.plate}: ${item.reminderType} expires TODAY (${due})`;
  return `${item.plate}: ${item.reminderType} in ${item.daysLeft} day(s) (${due})`;
}

function formatComplianceText(data, ctx) {
  const lines = [
    `🛡️ *${REPORT_TYPES.compliance.label}*`,
    `_${formatDate(data.generatedAt, ctx.locale, { timeZone: ctx.timeZone })} • ${ctx.timeZone}_`,
    '',
    `📋 *Monitored:* ${data.totals.monitored} item(s) • ${data.totals.active} active • ${data.totals.expiring30Days} due within 30 days • ${data.totals.expired} expired`,
    '',
    '🚗 *Insurance Matrix*',
    `• Active: ${data.insuranceStatusMatrix.active} • 30d: ${data.insuranceStatusMatrix.due30} • 14d: ${data.insuranceStatusMatrix.due14} • 7d: ${data.insuranceStatusMatrix.due7} • Expired: ${data.insuranceStatusMatrix.expired}`,
    '',
    '🔎 *Inspections & Permits*',
    `• Inspections — active ${data.inspectionAndPermits.inspections.active}, due 30d ${data.inspectionAndPermits.inspections.due30}, expired ${data.inspectionAndPermits.inspections.expired}`,
    `• Permits — active ${data.inspectionAndPermits.permits.active}, due 30d ${data.inspectionAndPermits.permits.due30}, expired ${data.inspectionAndPermits.permits.expired}`,
    `• Licensing — active ${data.inspectionAndPermits.licensing.active}, due 30d ${data.inspectionAndPermits.licensing.due30}, expired ${data.inspectionAndPermits.licensing.expired}`,
    `• Driver licences — active ${data.driverLicenses.active}, expired ${data.driverLicenses.expired}`
  ];

  const upcoming = [...data.insuranceStatusMatrix.items, ...data.inspectionAndPermits.inspections.items, ...data.inspectionAndPermits.permits.items, ...data.inspectionAndPermits.licensing.items, ...data.driverLicenses.items]
    .filter((item) => item.daysLeft !== null && item.daysLeft <= 30)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 6);
  if (upcoming.length > 0) {
    lines.push('', '⏳ *Upcoming / Overdue*');
    for (const item of upcoming) lines.push(`• ${expiryLine(item, ctx)}`);
  }

  if (data.notificationLog.length > 0) {
    lines.push('', '📨 *Recent Tiered Alerts*');
    for (const row of data.notificationLog) {
      lines.push(`• ${row.tier.replace('notified_', '').replace('_', ' ')} → ${row.plate} (${formatDate(row.sentAt, ctx.locale, { timeZone: ctx.timeZone })})`);
    }
  }

  if (data.actionPrompt.length > 0) {
    lines.push('', '✏️ *Quick Updates* (reply in chat)');
    for (const prompt of data.actionPrompt) lines.push(`• ${prompt}`);
  }

  return lines.join('\n');
}


/* ------------------------------------------------------------------ */
/* 3. Maintenance & Service Report                                     */
/* ------------------------------------------------------------------ */

function buildThresholdItem(reminder, vehicles) {
  const vehicle = vehicles.find((v) => v.id === reminder.vehicle_id) || {};
  const isHours = String(reminder.threshold_unit || '').toLowerCase() === 'hours';
  const unit = reminder.display_unit || (isHours ? 'hours' : (vehicle.unit_system === 'imperial' ? 'mi' : 'km'));
  const target = toNumber(reminder.target_value);
  const current = isHours
    ? toNumber(vehicle.operating_hours)
    : toNumber(vehicle.current_mileage ?? vehicle.odometer_reading);
  let remaining = Number(reminder.remaining_value);
  if (!Number.isFinite(remaining)) remaining = target - current;
  const interval = target - toNumber(reminder.last_service_value);
  const percentRemaining = interval > 0 ? Math.round((remaining / interval) * 1000) / 10 : null;
  const displayValue = (value) => {
    if (isHours) return Math.round(value * 10) / 10;
    return Math.round(unit === 'mi' ? kmToUserDistance(value, 'imperial') : value);
  };
  const dueState = remaining <= 0
    ? 'overdue'
    : percentRemaining !== null && percentRemaining <= 5
      ? 'due_now'
      : percentRemaining !== null && percentRemaining <= 25
        ? 'warning'
        : 'on_track';

  return {
    reminderId: reminder.id,
    plate: vehicle.plate_number || 'Fleet vehicle',
    reminderType: reminder.reminder_type || 'Service',
    unit,
    target: displayValue(target),
    current: displayValue(current),
    remaining: displayValue(remaining),
    percentRemaining,
    dueState
  };
}

export async function buildMaintenanceReport({ supabase, ownerId = null, driverId = null, vehicleId = null, countryInfo = null, profile = null, now = new Date() } = {}) {
  if (!supabase) return { ok: false, type: 'maintenance', error: 'Database unavailable.' };
  const ctx = buildGlobalContext(countryInfo, profile);
  const dataset = await loadFleetData({ supabase, ownerId, driverId, vehicleId });
  const { vehicles, reminders, expenses } = dataset;

  const thresholds = (reminders || [])
    .filter((rem) => ['distance', 'hours'].includes(String(rem.threshold_unit || '').toLowerCase()))
    .map((rem) => buildThresholdItem(rem, vehicles))
    .sort((a, b) => (a.percentRemaining ?? 999) - (b.percentRemaining ?? 999));

  const dateReminders = (reminders || []).filter((rem) => reminderDueDate(rem));
  const overdueDateReminders = dateReminders.filter((rem) => daysUntilDue(reminderDueDate(rem), now) < 0);
  const overdueThresholds = thresholds.filter((item) => item.dueState === 'overdue');
  const completed = (reminders || []).filter((rem) => rem.completed_at || String(rem.status || '').toLowerCase() === 'done');
  const completedOnTime = completed.filter((rem) => rem.completed_on_time === true);
  const overdueCount = overdueThresholds.length + overdueDateReminders.length;
  const pmBase = completedOnTime.length + overdueCount;
  const pmComplianceRate = pmBase > 0 ? Math.round((completedOnTime.length / pmBase) * 1000) / 10 : null;

  const serviceHistory = [...(expenses || [])]
    .filter((expense) => ['maintenance', 'parts'].includes(expenseCategory(expense.expense_type)))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 10)
    .map((expense) => ({
      plate: plateFor(expense.vehicle_id, vehicles),
      date: expense.created_at || null,
      type: expense.expense_type || 'Maintenance',
      amount: toNumber(expense.amount),
      currency: ctx.currency,
      notes: expense.notes || null
    }));

  const extraNoteSet = [];
  for (const reminder of reminders || []) {
    if (reminder.notes) extraNoteSet.push(`${reminder.reminder_type || 'Reminder'}: ${reminder.notes}`);
  }
  for (const vehicle of vehicles) {
    if (vehicle.other_details) extraNoteSet.push(`${vehicle.plate_number}: ${vehicle.other_details}`);
  }
  const extraNotes = [...new Set(extraNoteSet)].slice(0, 10);

  const data = {
    type: 'maintenance',
    generatedAt: now.toISOString(),
    timeZone: ctx.timeZone,
    currency: ctx.currency,
    thresholds,
    pmCompliance: {
      scheduled: (reminders || []).length,
      completed: completed.length,
      completedOnTime: completedOnTime.length,
      overdue: overdueCount,
      complianceRate: pmComplianceRate
    },
    serviceHistory,
    extraNotes
  };

  return { ok: true, type: 'maintenance', data, text: formatMaintenanceText(data, ctx) };
}

function formatMaintenanceText(data, ctx) {
  const lines = [
    `🔧 *${REPORT_TYPES.maintenance.label}*`,
    `_${formatDate(data.generatedAt, ctx.locale, { timeZone: ctx.timeZone })} • ${ctx.timeZone}_`,
    '',
    `📈 *PM Compliance:* ${data.pmCompliance.complianceRate === null ? 'no completions yet' : `${data.pmCompliance.complianceRate}% on time`} • ${data.pmCompliance.scheduled} scheduled • ${data.pmCompliance.overdue} overdue`
  ];

  if (data.thresholds.length > 0) {
    lines.push('', '⏱️ *Threshold Tracking*');
    for (const item of data.thresholds.slice(0, 8)) {
      const percent = item.percentRemaining === null ? '' : ` (${item.percentRemaining}% left)`;
      lines.push(`• ${item.plate}: ${item.reminderType} — ${formatNumber(item.remaining, ctx.locale)} ${item.unit} remaining${percent}`);
    }
  }

  if (data.serviceHistory.length > 0) {
    lines.push('', '🧾 *Recent Service History*');
    for (const entry of data.serviceHistory.slice(0, 6)) {
      const when = entry.date ? formatDate(entry.date, ctx.locale, { timeZone: ctx.timeZone }) : '—';
      lines.push(`• ${entry.plate} — ${entry.type} ${formatMoney(entry.amount, entry.currency, ctx.locale)} (${when})`);
    }
  }

  if (data.extraNotes.length > 0) {
    lines.push('', '📝 *Extra Notes*');
    for (const note of data.extraNotes.slice(0, 5)) lines.push(`• ${note}`);
  }

  return lines.join('\n');
}


/* ------------------------------------------------------------------ */
/* 4. Financial & Cost Report                                          */
/* ------------------------------------------------------------------ */

export async function buildFinancialReport({ supabase, ownerId = null, driverId = null, vehicleId = null, countryInfo = null, profile = null, now = new Date() } = {}) {
  if (!supabase) return { ok: false, type: 'financial', error: 'Database unavailable.' };
  const ctx = buildGlobalContext(countryInfo, profile);
  const dataset = await loadFleetData({ supabase, ownerId, driverId, vehicleId });
  const { vehicles, expenses, earnings } = dataset;

  const expenseTotals = { fuel: 0, maintenance: 0, parts: 0, tolls: 0, other: 0 };
  const expenseByVehicle = new Map();
  for (const expense of expenses || []) {
    const category = expenseCategory(expense.expense_type);
    const amount = toNumber(expense.amount);
    expenseTotals[category] += amount;
    expenseByVehicle.set(expense.vehicle_id, (expenseByVehicle.get(expense.vehicle_id) || 0) + amount);
  }
  const totalExpenses = Object.values(expenseTotals).reduce((sum, value) => sum + value, 0);

  const earningsByVehicle = new Map();
  let totalEarnings = 0;
  for (const earning of earnings || []) {
    const amount = toNumber(earning.revenue_amount ?? earning.amount);
    totalEarnings += amount;
    earningsByVehicle.set(earning.vehicle_id, (earningsByVehicle.get(earning.vehicle_id) || 0) + amount);
  }

  const byVehicle = vehicles.map((vehicle) => {
    const exp = expenseByVehicle.get(vehicle.id) || 0;
    const earn = earningsByVehicle.get(vehicle.id) || 0;
    return {
      plate: vehicle.plate_number || 'Fleet vehicle',
      earnings: Math.round(earn * 100) / 100,
      expenses: Math.round(exp * 100) / 100,
      net: Math.round((earn - exp) * 100) / 100
    };
  }).sort((a, b) => b.expenses - a.expenses);

  const distanceKm = distanceThisMonth(expenses, now);
  const distanceDisplay = ctx.unitSystem === 'imperial' ? kmToUserDistance(distanceKm, 'imperial') : distanceKm;
  const operatingHours = vehicles.reduce((sum, v) => sum + toNumber(v.operating_hours), 0);

  const data = {
    type: 'financial',
    generatedAt: now.toISOString(),
    timeZone: ctx.timeZone,
    currency: ctx.currency,
    locale: ctx.locale,
    expenses: {
      fuel: Math.round(expenseTotals.fuel * 100) / 100,
      maintenance: Math.round(expenseTotals.maintenance * 100) / 100,
      parts: Math.round(expenseTotals.parts * 100) / 100,
      tolls: Math.round(expenseTotals.tolls * 100) / 100,
      other: Math.round(expenseTotals.other * 100) / 100,
      total: Math.round(totalExpenses * 100) / 100
    },
    earnings: {
      total: Math.round(totalEarnings * 100) / 100,
      byVehicle: byVehicle.filter((row) => row.earnings > 0)
    },
    net: {
      total: Math.round((totalEarnings - totalExpenses) * 100) / 100,
      byVehicle
    },
    efficiency: {
      distance: Math.round(distanceDisplay),
      distanceUnit: ctx.labels.distance,
      operatingHours: Math.round(operatingHours * 10) / 10,
      costPerDistance: distanceDisplay > 0 ? Math.round((totalExpenses / distanceDisplay) * 100) / 100 : null,
      costPerHour: operatingHours > 0 ? Math.round((totalExpenses / operatingHours) * 100) / 100 : null
    }
  };

  return { ok: true, type: 'financial', data, text: formatFinancialText(data, ctx) };
}

function formatFinancialText(data, ctx) {
  const money = (value) => formatMoney(value, ctx.currency, ctx.locale);
  const lines = [
    `💰 *${REPORT_TYPES.financial.label}*`,
    `_${formatDate(data.generatedAt, ctx.locale, { timeZone: ctx.timeZone })} • ${ctx.timeZone}_`,
    '',
    '💸 *Operating Expenses*',
    `• Fuel: ${money(data.expenses.fuel)}`,
    `• Maintenance: ${money(data.expenses.maintenance)}`,
    `• Parts: ${money(data.expenses.parts)}`,
    `• Tolls / parking: ${money(data.expenses.tolls)}`,
    `• Other: ${money(data.expenses.other)}`,
    `• *Total: ${money(data.expenses.total)}*`,
    '',
    `📥 *Earnings:* ${money(data.earnings.total)}`,
    `📈 *Net:* ${money(data.net.total)}`,
    '',
    '🎯 *Cost Efficiency*',
    `• Distance this month: ${formatNumber(data.efficiency.distance, ctx.locale)} ${data.efficiency.distanceUnit}`,
    `• Operating hours: ${formatNumber(data.efficiency.operatingHours, ctx.locale)}`,
    `• Cost per ${data.efficiency.distanceUnit}: ${data.efficiency.costPerDistance === null ? 'n/a' : money(data.efficiency.costPerDistance)}`,
    `• Cost per operating hour: ${data.efficiency.costPerHour === null ? 'n/a' : money(data.efficiency.costPerHour)}`
  ];

  const top = data.net.byVehicle.filter((row) => row.expenses > 0 || row.earnings > 0).slice(0, 5);
  if (top.length > 0) {
    lines.push('', '🚗 *Per-Vehicle Performance*');
    for (const row of top) {
      lines.push(`• ${row.plate} — earnings ${money(row.earnings)} • expenses ${money(row.expenses)} • net ${money(row.net)}`);
    }
  }

  return lines.join('\n');
}


/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

const REPORT_BUILDERS = {
  fleet: buildFleetStatusReport,
  compliance: buildComplianceReport,
  maintenance: buildMaintenanceReport,
  financial: buildFinancialReport
};

/** Build any of the four core reports (structured JSON + WhatsApp text). */
export async function buildFleetReport({
  supabase,
  type = 'fleet',
  ownerId = null,
  driverId = null,
  vehicleId = null,
  countryInfo = null,
  profile = null,
  now = new Date()
} = {}) {
  const resolvedType = REPORT_TYPES[type] ? type : resolveReportType(type, 'fleet');
  const builder = REPORT_BUILDERS[resolvedType] || REPORT_BUILDERS.fleet;
  return builder({ supabase, ownerId, driverId, vehicleId, countryInfo, profile, now });
}

export default {
  REPORT_TYPES,
  resolveReportType,
  buildFleetReport,
  buildFleetStatusReport,
  buildComplianceReport,
  buildMaintenanceReport,
  buildFinancialReport
};

