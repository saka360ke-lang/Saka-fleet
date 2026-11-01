import { formatDate, formatNumber } from './globalization.js';
import { EXPENSE_CATEGORIES, expenseCategoryOf } from './expenseCatalog.js';

/**
 * Saka Fleet — Transaction Ledger Builder (v1.30.0)
 * ------------------------------------------------
 * One pure module that turns raw expense_logs / private_earnings rows into the
 * month-grouped, badge-tagged itemized ledger consumed by the Apex PDF engine.
 * Expense classification is delegated to `expenseCatalog.js` (single source of
 * truth). Full transparency: every row in scope is surfaced (no truncation) and
 * totals are engine-calculated. Missing values stay null (rendered "—"), real
 * zeros stay 0 (rendered as an explicit amount).
 */

/** Expense type → canonical report/ledger category (fuel, parts, tyres…). */
export function expenseKind(expenseType) {
  return expenseCategoryOf(expenseType);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function ledgerKindLabel(kind) {
  if (String(kind || '').toLowerCase() === 'earning') return 'EARNING';
  return EXPENSE_CATEGORIES[kind]?.badge || EXPENSE_CATEGORIES.other.badge;
}

function trimText(value, max = 64) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function monthKey(at) {
  const match = String(at || '').match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : 'activity';
}

function monthLabel(key, timeZone = 'Africa/Nairobi') {
  if (key === 'activity') return 'Activity';
  const date = new Date(`${key}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'Activity';
  try {
    const label = date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone });
    return label || `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  } catch {
    return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }
}

function odometerOf(row) {
  const value = row?.odometer_reading;
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Expense row → ledger row (date, badge kind, odometer, unit cost, total). */
export function expenseToLedgerRow(row = {}, { ctx = {}, vehiclePlate = null } = {}) {
  const at = row.created_at || row.logged_at || null;
  const amount = Number(row.amount) || 0;
  const litres = Number(row.fuel_liters ?? row.liters ?? row.fuel_litres) || 0;
  const kind = expenseKind(row.expense_type);
  const pieces = [row.expense_type || 'Expense'];
  if (litres > 0) pieces.push(`${formatNumber(litres, ctx.locale || 'en-US')} L`);
  const note = trimText(row.notes, 56);
  if (note) pieces.push(note);
  return {
    at,
    date: at ? formatDate(at, ctx.locale || 'en-US', { timeZone: ctx.timeZone }) : '—',
    vehicle: vehiclePlate || null,
    kind,
    kindLabel: ledgerKindLabel(kind),
    description: pieces.join(' - '),
    odometer: odometerOf(row),
    unitCost: row.unit_cost !== undefined && row.unit_cost !== null
      ? Number(row.unit_cost)
      : (litres > 0 ? Math.round((amount / litres) * 100) / 100 : null),
    unitCurrency: null,
    amount
  };
}

/** Earnings row → ledger row. */
export function earningToLedgerRow(row = {}, { ctx = {}, vehiclePlate = null } = {}) {
  const at = row.logged_at || row.created_at || null;
  const amount = Number(row.revenue_amount ?? row.amount) || 0;
  return {
    at,
    date: at ? formatDate(at, ctx.locale || 'en-US', { timeZone: ctx.timeZone }) : '—',
    vehicle: vehiclePlate || null,
    kind: 'earning',
    kindLabel: ledgerKindLabel('earning'),
    description: trimText(row.notes || row.source || 'Earnings recorded', 64) || 'Earnings recorded',
    odometer: odometerOf(row),
    unitCost: null,
    unitCurrency: null,
    amount
  };
}

/**
 * Build the Apex ledger payload:
 * { title, currency, showVehicle, groups[], totals{scanned,shown,expenseTotal,earningTotal,net} }
 */
export function buildLedgerGroups({
  expenses = [],
  earnings = [],
  vehicles = [],
  ctx = {},
  includeEarnings = true,
  includeVehicle = false,
  title = 'Itemized activity & ledger',
  subtitle = null,
  footnote = null
} = {}) {
  const plateFor = (vehicleId) => vehicles.find((vehicle) => vehicle.id === vehicleId)?.plate_number || null;
  const rows = [];

  for (const row of expenses || []) {
    rows.push(expenseToLedgerRow(row, { ctx, vehiclePlate: includeVehicle ? plateFor(row.vehicle_id) : null }));
  }
  if (includeEarnings) {
    for (const row of earnings || []) {
      rows.push(earningToLedgerRow(row, { ctx, vehiclePlate: includeVehicle ? plateFor(row.vehicle_id) : null }));
    }
  }

  rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  const groupMap = new Map();
  for (const row of rows) {
    const key = monthKey(row.at);
    if (!groupMap.has(key)) groupMap.set(key, { key, label: monthLabel(key, ctx.timeZone), rows: [], expenseTotal: 0, earningTotal: 0 });
    const group = groupMap.get(key);
    group.rows.push(row);
    if (row.kind === 'earning') group.earningTotal += row.amount;
    else group.expenseTotal += row.amount;
  }

  const groups = [...groupMap.values()].sort((a, b) => String(b.key).localeCompare(String(a.key)));
  const expenseTotal = Math.round(rows.reduce((sum, row) => sum + (row.kind === 'earning' ? 0 : row.amount), 0) * 100) / 100;
  const earningTotal = Math.round(rows.reduce((sum, row) => sum + (row.kind === 'earning' ? row.amount : 0), 0) * 100) / 100;

  return {
    title,
    subtitle,
    currency: ctx.currency || 'USD',
    showVehicle: includeVehicle === true,
    groups: groups.map((group) => ({
      ...group,
      expenseTotal: Math.round(group.expenseTotal * 100) / 100,
      earningTotal: Math.round(group.earningTotal * 100) / 100
    })),
    totals: {
      scanned: (expenses || []).length + (includeEarnings ? (earnings || []).length : 0),
      shown: rows.length,
      expenseTotal,
      earningTotal,
      net: Math.round((earningTotal - expenseTotal) * 100) / 100
    },
    footnote: footnote || `All ${rows.length} record(s) in this period are shown — nothing hidden.`
  };
}

export default {
  expenseKind,
  ledgerKindLabel,
  expenseToLedgerRow,
  earningToLedgerRow,
  buildLedgerGroups
};
