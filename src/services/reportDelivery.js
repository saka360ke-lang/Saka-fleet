import { buildFleetReport, resolveReportType } from './fleetReports.js';
import { buildDriverDaybook, buildVehicleHealthCheck, buildDriverComplianceCard, buildDriverPerformance } from './driverReports.js';
import { buildVehicleDeepDive } from './vehicleDeepDive.js';
import { buildOwnerPortfolio } from './ownerPortfolio.js';
import { buildCustomReport, metricsForAccess } from './reportMetrics.js';
import { resolveReportAccess, reportAccessDeniedText } from './reportAccess.js';
import { buildProReportPdf } from './pdfEngine.js';
import { sendReportByEmail } from './mailer.js';
import { uploadReportToSupabase } from '../../reports.js';
import { shortenUrl } from './linkShortener.js';
import { EXPENSE_CATEGORIES } from './expenseCatalog.js';

/**
 * Saka Fleet — Report delivery pipeline (v1.29.0)
 * ----------------------------------------------
 * resolve → enforce the access lane → build structured data → render the
 * Saka Apex PDF → upload + email → return the WhatsApp text with a link.
 */

export const REPORT_TYPE_ALIASES = Object.freeze({
  fuel_economy: ['fuel economy', 'fuel efficiency', 'economy report', 'fuel deep dive', 'fuel report', 'km/l report', 'mpg report'],
  driver_daybook: ['daybook', 'driver report', 'my report', 'my daybook', 'shift report', 'activity report'],
  vehicle_health: ['vehicle health', 'health check', 'pre trip', 'pre-trip', 'car health', 'check in'],
  driver_compliance_card: ['compliance card', 'licence card', 'license card', 'my compliance', 'my documents'],
  vehicle_deep_dive: ['vehicle deep dive', 'deep dive', 'vehicle report', 'car report', 'vehicle profile report', 'profile report', 'full vehicle report', 'asset deep dive'],
  owner_portfolio: ['owner portfolio', 'portfolio report', 'asset portfolio', 'my assets', 'asset report', 'portfolio'],
  driver_performance: ['driver performance and compliance', 'driver performance & compliance', 'driver performance report', 'driver performance', 'driver audit', 'performance report'],
  driver_scorecard: ['driver scorecard', 'driver score card'],
  year_review: ['year review', 'year in review', 'annual report', 'yearly report'],
  eco_footprint: ['eco footprint', 'emissions report', 'carbon report', 'co2 report'],
  custom: ['custom report', 'bespoke report', 'build a report', 'choose metrics', 'my metrics']
});

/** Resolve any report type (core four + creative + Apex types). */
export function resolveAnyReportType(text, fallback = 'fleet') {
  const clean = String(text || '').toLowerCase().trim();
  if (REPORT_TYPE_ALIASES[clean]) return clean; // exact registry key (report_type = vehicle_deep_dive)
  for (const [type, aliases] of Object.entries(REPORT_TYPE_ALIASES)) {
    if (aliases.some((alias) => clean.includes(alias))) return type;
  }
  return resolveReportType(clean, fallback);
}

/** Load the owner + assigned drivers for the People panel. */
export async function loadReportPeople({ supabase, ownerId = null, driverId = null, vehicleIds = [] } = {}) {
  if (!supabase) return { owner: null, drivers: [] };
  let vehicles = [];
  try {
    const { data } = vehicleIds.length
      ? await supabase.from('vehicles').select('*').in('id', vehicleIds)
      : await supabase.from('vehicles').select('*').eq(ownerId ? 'owner_id' : 'assigned_driver_id', ownerId || driverId);
    vehicles = data || [];
  } catch { vehicles = []; }

  const ownerIds = [...new Set(vehicles.map((vehicle) => vehicle.owner_id).filter(Boolean))];
  const driverIds = [...new Set(vehicles.map((vehicle) => vehicle.assigned_driver_id).filter(Boolean))];
  const profileIds = [...new Set([...ownerIds, ...driverIds, ownerId].filter(Boolean))];

  let profiles = [];
  try {
    const { data } = await supabase.from('profiles').select('id, full_name, phone_number, email, preferred_language, unit_system, timezone').in('id', profileIds);
    profiles = data || [];
  } catch { profiles = []; }

  let compliances = [];
  if (driverIds.length) {
    try {
      const { data } = await supabase.from('driver_compliances').select('*').in('driver_id', driverIds).limit(100);
      compliances = data || [];
    } catch { compliances = []; }
  }

  const ownerProfile = profiles.find((profile) => profile.id === (ownerId || ownerIds[0])) || null;
  const owner = ownerProfile
    ? {
      name: ownerProfile.full_name || 'Fleet owner',
      phone: ownerProfile.phone_number || '',
      email: ownerProfile.email || '',
      language: ownerProfile.preferred_language || 'English',
      plan: ownerProfile.plan || null
    }
    : null;

  const drivers = driverIds.slice(0, 4).map((id) => {
    const profile = profiles.find((row) => row.id === id);
    const vehicle = vehicles.find((row) => row.assigned_driver_id === id);
    const compliance = compliances.find((row) => row.driver_id === id);
    return {
      name: profile?.full_name || 'Assigned driver',
      phone: profile?.phone_number || '',
      plate: vehicle?.plate_number || '',
      licenceLabel: compliance?.label || '',
      licenceExpiry: compliance?.expiry || null,
      status: compliance ? 'active' : 'pending'
    };
  });

  return { owner, drivers };
}

const CORE_TYPES = new Set(['fleet', 'compliance', 'maintenance', 'financial']);

function stripRichText(text) {
  return String(text || '')
    .replace(/\*+/g, '')
    .replace(/^•\s*/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function money(value, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value) || 0);
  } catch {
    return `${currency} ${Math.round(Number(value) || 0).toLocaleString()}`;
  }
}

const CORE_REPORT_TITLES = Object.freeze({
  fleet: 'Fleet Status Report',
  financial: 'Financial & Cost Report',
  compliance: 'Compliance & Expiry Report',
  maintenance: 'Maintenance & Service Report'
});

/* ------------------------------------------------------------------ */
/* v1.32.3 — Compliance & Expiry PDF (itemized, never aggregate-only)  */
/* ------------------------------------------------------------------ */

function readableDate(iso) {
  const clean = String(iso || '').slice(0, 10);
  if (!clean) return '—';
  const date = new Date(`${clean}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return clean;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function daysLeftLabel(daysLeft) {
  const days = Number(daysLeft);
  if (daysLeft === null || daysLeft === undefined || !Number.isFinite(days)) return '—';
  if (days === 0) return 'Today';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `${days}d left`;
}

/** Status word the PDF colours (expired -> red, due -> amber, valid -> green). */
function complianceStatusLabel(daysLeft, { lifetime = false } = {}) {
  if (lifetime) return 'Valid';
  const days = Number(daysLeft);
  if (daysLeft === null || daysLeft === undefined || !Number.isFinite(days)) return 'Unknown';
  if (days < 0) return 'Expired';
  if (days <= 7) return 'Due in 7 days';
  if (days <= 30) return 'Due in 30 days';
  return 'Valid';
}

/**
 * Compliance & Expiry report -> Saka Apex PDF payload.
 *
 * Live incident 2026-11-01: page 2 rendered four aggregate bullets and then
 * stopped, because the renderer consumed `report.text` (summary lines) instead
 * of the structured expiry rows. Every panel below is built from
 * `data.expiryItems` / `data.documents`, so an expired insurance always shows
 * its plate, item, expiry date, days-left and a coloured status.
 */
export function complianceReportToPdf(report, reportType = 'compliance') {
  const data = report?.data || {};
  const totals = data.totals || {};
  const scopedVehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
  const single = scopedVehicles.length === 1 ? scopedVehicles[0] : null;
  const plate = single?.plate || null;
  const items = (Array.isArray(data.expiryItems) ? data.expiryItems : [])
    .slice()
    .sort((a, b) => {
      const aDays = Number.isFinite(Number(a.daysLeft)) ? Number(a.daysLeft) : 99999;
      const bDays = Number.isFinite(Number(b.daysLeft)) ? Number(b.daysLeft) : 99999;
      return aDays - bDays;
    });
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const expired = Number(totals.expired ?? items.filter((item) => Number(item.daysLeft) < 0).length) || 0;
  const due30 = Number(totals.expiring30Days ?? items.filter((item) => Number(item.daysLeft) >= 0 && Number(item.daysLeft) <= 30).length) || 0;
  const monitored = Number(totals.monitored ?? items.length) || 0;
  const valid = Number(totals.active ?? items.filter((item) => Number(item.daysLeft) > 30).length) || 0;

  const kpis = [
    { label: 'Monitored items', value: String(monitored), hint: 'documents tracked' },
    {
      label: 'Valid',
      value: String(valid),
      hint: valid > 0 ? 'valid beyond 30 days' : 'nothing current yet',
      ...(valid > 0 ? { tone: 'positive' } : {})
    },
    {
      label: 'Due within 30 days',
      value: String(due30),
      hint: due30 > 0 ? 'renew before they lapse' : 'nothing close to expiry',
      ...(due30 > 0 ? { tone: 'warn' } : {})
    },
    {
      label: 'Expired',
      value: String(expired),
      hint: expired > 0 ? 'renew now' : 'clean record',
      ...(expired > 0 ? { tone: 'negative' } : {})
    }
  ];

  const callouts = [];
  if (expired > 0) {
    const first = items.find((item) => Number(item.daysLeft) < 0);
    callouts.push({
      tone: 'negative',
      title: `${expired} document${expired === 1 ? '' : 's'} expired`,
      body: `${first ? `${first.plate} ${first.categoryLabel || first.item} lapsed ${Math.abs(Number(first.daysLeft))} day(s) ago. ` : ''}Renew the expired item(s) first, then reply with the new expiry date in WhatsApp so the record and reminders update.`
    });
  } else if (due30 > 0) {
    callouts.push({
      tone: 'warn',
      title: `${due30} item${due30 === 1 ? '' : 's'} due within 30 days`,
      body: 'Renew early to avoid a lapse - each date below is engine-calculated from your saved documents.'
    });
  } else {
    callouts.push({
      tone: 'positive',
      title: 'Everything is current',
      body: monitored > 0
        ? `All ${monitored} monitored item(s) are valid beyond 30 days. You will be nudged 30, 14 and 7 days before each expiry.`
        : 'No expiring documents are on file yet. Send an insurance, inspection or permit photo and Saka will track the date for you.'
    });
  }

  const tables = [];
  const shownItems = items.slice(0, 24);
  if (shownItems.length) {
    tables.push({
      title: 'Upcoming & overdue items',
      subtitle: expired > 0 ? 'Expired items come first - renew those today' : 'Sorted by days left, nearest first',
      columns: [
        { key: 'plate', label: 'Vehicle', width: 1.1 },
        { key: 'item', label: 'Item', width: 1.6 },
        { key: 'expires', label: 'Expires', width: 1.05 },
        { key: 'daysLeft', label: 'Time left', width: 0.95, align: 'right' },
        { key: 'status', label: 'Status', width: 1.05, type: 'status' }
      ],
      rows: shownItems.map((item) => ({
        plate: item.plate || '—',
        item: item.categoryLabel || item.item || 'Document',
        expires: readableDate(item.dueDate),
        daysLeft: daysLeftLabel(item.daysLeft),
        status: complianceStatusLabel(item.daysLeft)
      }))
    });
  }
  if (documents.length) {
    tables.push({
      title: 'Documents on file',
      subtitle: 'Policy and certificate numbers from your compliance ledger',
      columns: [
        { key: 'plate', label: 'Vehicle', width: 1 },
        { key: 'document', label: 'Document', width: 1.5 },
        { key: 'number', label: 'Number', width: 1.5 },
        { key: 'expires', label: 'Expires', width: 1.05 },
        { key: 'status', label: 'Status', width: 0.95, type: 'status' }
      ],
      rows: documents.slice(0, 20).map((doc) => ({
        plate: doc.plate || '—',
        document: doc.label || 'Document',
        number: doc.number || 'not recorded',
        expires: doc.lifetime ? 'Life' : readableDate(doc.expiry),
        status: complianceStatusLabel(doc.daysLeft, { lifetime: doc.lifetime })
      }))
    });
  }

  // Category matrix — only categories that actually hold items are listed, so an
  // empty category never inflates the page with rows of zeros.
  const categoryRows = [
    { label: 'Insurance', summary: data.insuranceStatusMatrix },
    { label: 'Inspection', summary: data.inspectionAndPermits?.inspections },
    { label: 'Road licence', summary: data.inspectionAndPermits?.licensing },
    { label: 'Permit', summary: data.inspectionAndPermits?.permits },
    { label: 'Driver licence', summary: data.driverLicenses }
  ]
    .filter((entry) => Number(entry.summary?.total || 0) > 0)
    .map((entry) => {
      const summary = entry.summary || {};
      const dueSoon = Number(summary.due30 || 0) + Number(summary.due14 || 0) + Number(summary.due7 || 0);
      const parts = [`${summary.active || 0} valid`];
      if (dueSoon) parts.push(`${dueSoon} due within 30d`);
      if (summary.expired) parts.push(`${summary.expired} expired`);
      return {
        label: `${entry.label} (${summary.total})`,
        value: parts.join(' · '),
        ...(summary.expired ? { valueColor: '#EF4444' } : {})
      };
    });

  const sections = [];
  if (categoryRows.length) sections.push({ title: 'Category matrix', rows: categoryRows });
  if (single) {
    const rows = [
      { label: 'Plate', value: single.plate || '—' },
      { label: 'Vehicle', value: single.make_model || '—' }
    ];
    if (single.asset_kind) rows.push({ label: 'Asset kind', value: String(single.asset_kind).replace(/_/g, ' ') });
    rows.push({ label: 'Items monitored', value: String(monitored) });
    sections.push({ title: 'Vehicle snapshot', rows });
  } else if (scopedVehicles.length > 1) {
    sections.push({
      title: 'Vehicles in scope',
      lines: scopedVehicles.slice(0, 12).map((vehicle) => `${vehicle.plate}${vehicle.make_model ? ` - ${vehicle.make_model}` : ''}`)
    });
  }

  const notes = [
    'Every date above was read from a document or a stored correction - Saka never estimates expiry dates.',
    'Reminder ladder: 30, 14 and 7 days before expiry, then daily once overdue.',
    'Reply in WhatsApp with the new date (e.g. "insurance expires 20/11/2026") to update a record instantly.'
  ];
  if (items.length > shownItems.length) {
    notes.unshift(`Showing the ${shownItems.length} most urgent of ${items.length} monitored items - the full list is on your WhatsApp card.`);
  }

  return {
    title: plate ? `Compliance Report - ${plate}` : 'Compliance & Expiry Report',
    subtitle: plate
      ? `${single?.make_model || 'Vehicle'} - every document, verified from your ledger`
      : 'Every insured, inspected and licensed asset in one place',
    periodLabel: 'All monitored items',
    plate,
    reportType,
    generatedAt: data.generatedAt,
    coverHighlights: [
      { label: 'Monitored', value: String(monitored), tone: 'brand' },
      { label: 'Expired', value: String(expired), tone: expired > 0 ? 'negative' : 'positive' },
      { label: 'Due within 30d', value: String(due30), tone: due30 > 0 ? 'warn' : 'positive' }
    ],
    kpis,
    charts: [],
    ledgers: [],
    callouts,
    tables,
    sections,
    notes
  };
}

/**
 * Adapt a core fleet-report payload into Saka Apex PDF sections (v1.32.0).
 * Single-vehicle scopes get a plate badge, vehicle identity, a snapshot panel
 * and no redundant one-row table; zero values keep honest, neutral tones.
 */
export function fleetReportToPdf(report, reportType) {
  // v1.32.3 — compliance has a dedicated itemized renderer; the generic
  // summary-led layout produced an almost-empty page 2.
  if (reportType === 'compliance') return complianceReportToPdf(report, reportType);
  const data = report?.data || {};
  const currency = data.currency || 'USD';
  const kpis = [];
  const charts = [];
  const tables = [];
  const callouts = [];
  const sections = [];
  const ledgers = data.ledger ? [data.ledger] : [];

  const byVehicle = Array.isArray(data.net?.byVehicle) ? data.net.byVehicle : [];
  const scopedVehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
  const single = scopedVehicles.length === 1
    ? scopedVehicles[0]
    : (byVehicle.length === 1 ? { plate: byVehicle[0].plate } : null);
  const plate = single?.plate || null;

  const financial = data.financial || null;
  const expenseBreakdown = data.expenses || (financial ? { ...financial.expenses } : null);
  const expenseTotal = expenseBreakdown ? Number(expenseBreakdown.total ?? 0) : 0;
  const earningTotal = expenseBreakdown ? Number((data.earnings?.total ?? financial?.earnings) || 0) : 0;
  const netTotal = expenseBreakdown ? Number((data.net?.total ?? financial?.net) || 0) : 0;
  const distance = Number(data.efficiency?.distance ?? data.health?.distanceThisMonth ?? 0);
  const distanceUnit = data.efficiency?.distanceUnit || data.health?.distanceUnit || 'km';
  const costPerDistance = data.efficiency?.costPerDistance;
  const costPerHour = data.efficiency?.costPerHour;
  const counts = data.counts || null;
  const fuelLitres = Number(data.fuelLitres) || 0;

  if (data.overview) {
    kpis.push(
      { label: 'Vehicles', value: String(data.overview.totalVehicles ?? data.overview.vehicles ?? '—'), hint: 'in scope' },
      { label: 'Active', value: String(data.overview.activeVehicles ?? '—'), hint: 'available now' }
    );
  }
  if (expenseBreakdown) {
    kpis.push(
      { label: 'Total spend', value: money(expenseTotal, currency), hint: 'operating expenses', tone: 'negative' },
      {
        label: 'Earnings',
        value: money(earningTotal, currency),
        hint: earningTotal > 0 ? 'recorded revenue' : 'none recorded yet',
        ...(earningTotal > 0 ? { tone: 'positive' } : {})
      },
      {
        label: 'Net',
        value: money(netTotal, currency),
        hint: 'earnings - spend',
        ...(netTotal > 0 ? { tone: 'positive' } : (netTotal < 0 ? { tone: 'negative' } : {}))
      }
    );
    if (counts) {
      kpis.push({
        label: 'Transactions',
        value: String((counts.expenses || 0) + (counts.earnings || 0)),
        hint: 'records in scope'
      });
    }
    if (fuelLitres > 0) {
      kpis.push({ label: 'Fuel logged', value: `${fuelLitres.toLocaleString('en-US')} L`, hint: 'in scope' });
    }
    if (!data.overview) {
      kpis.push({
        label: `Distance (${distanceUnit})`,
        value: String(distance),
        hint: distance > 0 ? 'this month' : 'no odometer movement logged this month'
      });
    }
  }
  if (data.health) {
    kpis.push({ label: 'Availability', value: `${data.health.availabilityRate ?? '—'}%`, hint: 'fleet readiness' });
  } else if (data.overview) {
    kpis.push({ label: 'Assigned drivers', value: String(data.overview.activeDrivers ?? '—'), hint: 'on duty' });
  }

  if (expenseBreakdown) {
    const segments = Object.entries(expenseBreakdown)
      .filter(([key, value]) => key !== 'total' && Number(value) > 0)
      .map(([key, value]) => ({ label: EXPENSE_CATEGORIES[key]?.label || key, value: Number(value) }));
    if (segments.length) charts.push({ type: 'segment', title: 'Spend by category', currency, segments });
    if (expenseTotal > 0 || earningTotal > 0) {
      charts.push({ type: 'vs', title: 'Earnings vs expenses', currency, earnings: earningTotal, expenses: expenseTotal });
      callouts.push({
        tone: netTotal >= 0 ? 'positive' : 'negative',
        title: netTotal >= 0 ? 'Financial health: surplus' : 'Financial health: shortfall',
        body: `${money(earningTotal, currency)} earnings against ${money(expenseTotal, currency)} spend - a ${netTotal >= 0 ? 'surplus' : 'shortfall'} of ${money(Math.abs(netTotal), currency)}.`
      });
    }
    const top = [...segments].sort((a, b) => b.value - a.value)[0];
    if (top) {
      callouts.push({
        tone: 'brand',
        title: 'Largest cost line',
        body: `${top.label} ${single ? 'is' : 'leads'} ${single ? "this vehicle's" : 'fleet'} spend at ${money(top.value, currency)}.`
      });
    }
  }
  // Only surface the efficiency callout when there is a real cost metric.
  if (data.efficiency && ((costPerDistance !== null && costPerDistance !== undefined) || (costPerHour !== null && costPerHour !== undefined))) {
    const parts = [];
    if (costPerDistance !== null && costPerDistance !== undefined) parts.push(`cost per ${distanceUnit}: ${money(costPerDistance, currency)}`);
    if (costPerHour !== null && costPerHour !== undefined) parts.push(`cost per operating hour: ${money(costPerHour, currency)}`);
    callouts.push({ tone: 'brand', title: 'Cost efficiency', body: `${parts.join(' - ')}.` });
  }

  if (single) {
    const rows = [
      { label: 'Plate', value: plate || '—' },
      { label: 'Vehicle', value: single.make_model || '—' },
      { label: 'Asset kind', value: single.asset_kind ? String(single.asset_kind).replace(/_/g, ' ') : '—' },
      { label: 'Fuel type', value: single.fuel_type || '—' }
    ];
    if (Number(single.odometer) > 0) rows.push({ label: 'Odometer', value: `${Number(single.odometer).toLocaleString('en-US')} km` });
    if (counts) rows.push({ label: 'Records in scope', value: String((counts.expenses || 0) + (counts.earnings || 0)) });
    if (ledgers[0]?.totals) rows.push({ label: 'Ledger rows shown', value: String(ledgers[0].totals.shown) });
    sections.push({ title: 'Vehicle snapshot', rows });
  } else if (byVehicle.length > 1) {
    tables.push({
      title: 'Per-vehicle performance',
      currency,
      columns: [
        { key: 'plate', label: 'Vehicle', width: 1.2 },
        { key: 'earnings', label: 'Earnings', width: 1, type: 'money', align: 'right' },
        { key: 'expenses', label: 'Expenses', width: 1, type: 'money', align: 'right' },
        { key: 'net', label: 'Net', width: 1, type: 'money', align: 'right' }
      ],
      rows: byVehicle.slice(0, 40)
    });
  }

  // Condensed plain-language summary (never a raw 40-line WhatsApp dump).
  const summary = stripRichText(report?.text)
    .filter((line) => !/report|^_|engine-calculated/i.test(line) || /KES|spend|net/i.test(line))
    .slice(0, 8);
  if (summary.length) sections.push({ title: 'Summary', lines: summary });

  const titleBase = CORE_REPORT_TITLES[reportType]
    || (data.type ? `${String(data.type).charAt(0).toUpperCase()}${String(data.type).slice(1)} report` : 'Fleet report');
  return {
    title: plate ? `${titleBase} - ${plate}` : titleBase,
    subtitle: plate
      ? `${single.make_model || 'Vehicle'} - engine-calculated figures, nothing hidden`
      : 'Verified fleet data, beautifully delivered',
    periodLabel: reportType === 'financial' ? 'All recorded activity' : 'This month',
    plate,
    reportType,
    kpis: kpis.slice(0, 6),
    charts,
    ledgers,
    callouts,
    tables,
    sections,
    notes: ['Figures are engine-calculated from your fleet records. Saka never estimates silently.']
  };
}

/**
 * Build any report under the caller's access lane.
 */
export async function buildReportForLane({
  supabase,
  reportType = 'fleet',
  ownerId = null,
  driverId = null,
  plate = null,
  profile = null,
  countryInfo = null,
  metricIds = [],
  range = 'this_month',
  grants = [],
  roles = [],
  now = new Date()
} = {}) {
  if (!supabase) return { ok: false, error: 'Database unavailable' };

  let vehicles = [];
  try {
    const { data } = await supabase.from('vehicles').select('*').is('deleted_at', null).limit(500);
    vehicles = data || [];
  } catch { vehicles = []; }

  let effectiveGrants = Array.isArray(grants) ? grants : [];
  if (!effectiveGrants.length && driverId) {
    try {
      const { data } = await supabase.from('driver_assignments').select('report_grants').eq('driver_id', driverId).limit(1);
      effectiveGrants = Array.isArray(data?.[0]?.report_grants) ? data[0].report_grants : [];
    } catch { effectiveGrants = []; }
  }

  const access = resolveReportAccess({ reportType, profile, roles, vehicles, ownerId, driverId, grants: effectiveGrants });
  if (!access.allowed) {
    return { ok: false, denied: true, access, text: reportAccessDeniedText(reportType, access) };
  }
  const laneOwnerId = access.lane === 'driver' ? null : (ownerId || profile?.id || null);
  const laneDriverId = access.lane === 'driver' ? (driverId || profile?.id || null) : null;

  if (CORE_TYPES.has(reportType)) {
    const report = await buildFleetReport({ supabase, type: reportType, ownerId: laneOwnerId, driverId: laneDriverId, countryInfo, profile, now });
    if (!report?.ok) return { ok: false, error: report?.error || 'Report build failed', access };
    return { ok: true, type: reportType, text: report.text, data: fleetReportToPdf(report, reportType), access };
  }

  if (reportType === 'driver_daybook') {
    const report = await buildDriverDaybook({ supabase, driverId: laneDriverId || driverId, now, countryInfo, profile });
    return { ...report, access };
  }
  if (reportType === 'vehicle_health') {
    const report = await buildVehicleHealthCheck({ supabase, vehicleId: access.vehicleIds[0] || null, driverId: laneDriverId || driverId, now, countryInfo });
    return { ...report, access };
  }
  if (reportType === 'driver_compliance_card') {
    const report = await buildDriverComplianceCard({ supabase, driverId: laneDriverId || driverId, now, countryInfo });
    return { ...report, access };
  }

  // v1.29.0 — Apex report types.
  if (reportType === 'vehicle_deep_dive') {
    const report = await buildVehicleDeepDive({
      supabase,
      vehicleId: plate ? null : (access.vehicleIds[0] || null),
      plate,
      ownerId: laneOwnerId,
      driverId: laneDriverId,
      countryInfo,
      profile,
      access,
      now
    });
    return { ...report, access };
  }
  if (reportType === 'owner_portfolio') {
    const report = await buildOwnerPortfolio({
      supabase,
      ownerId: laneOwnerId || profile?.id || null,
      countryInfo,
      profile,
      access,
      now
    });
    return { ...report, access };
  }
  if (reportType === 'driver_performance') {
    const report = await buildDriverPerformance({
      supabase,
      ownerId: laneOwnerId,
      driverId: driverId || null,
      countryInfo,
      profile,
      now
    });
    return { ...report, access };
  }

  const presets = {
    fuel_economy: { title: 'Fuel Economy Deep-Dive', metrics: ['fuel_economy', 'fuel_litres', 'fuel_spend', 'distance'], range },
    eco_footprint: { title: 'Eco-Footprint Summary', metrics: ['co2', 'fuel_litres', 'distance'], range },
    year_review: { title: 'Year-in-Review', metrics: ['total_spend', 'earnings', 'net_profit', 'distance', 'fuel_litres'], range: 'this_year' },
    driver_scorecard: { title: 'Driver Scorecard', metrics: ['driver_entries', 'distance'], range },
    custom: { title: 'Bespoke Report', metrics: metricIds, range }
  };
  const preset = presets[reportType] || presets.custom;
  const safeMetrics = preset.metrics.length
    ? preset.metrics
    : metricsForAccess(access).map((metric) => metric.id).slice(0, 5);
  const report = await buildCustomReport({
    supabase,
    ownerId: laneOwnerId,
    driverId: laneDriverId,
    vehicleIds: access.vehicleIds,
    metricIds: safeMetrics,
    range: preset.range,
    countryInfo,
    profile,
    access,
    now
  });
  if (!report.ok) return { ok: false, error: report.error, access };
  if (report.data) {
    report.data.title = preset.title;
    report.data.reportType = reportType;
  }
  return { ...report, type: reportType, access };
}

/** Render, upload and email the branded PDF (best effort, never throws). */
export async function deliverReportPdf({ supabase, report, people = {}, ownerEmail = null, plateLabel = 'Fleet' } = {}) {
  if (!supabase || !report?.data) return { ok: false, error: 'No report data' };
  try {
    const pdfBuffer = await buildProReportPdf({
      ...report.data,
      reportType: report.type,
      owner: people.owner || null,
      drivers: people.drivers || []
    });
    let url = null;
    let uploadError = null;
    try {
      url = await uploadReportToSupabase(supabase, pdfBuffer, `Saka_${report.type || 'report'}_${plateLabel}`.replace(/\s+/g, '_'));
      // v1.32.4 — the delivered link is shortened HERE, at the single source of
      // truth, so every caller (WhatsApp reply, follow-up worker, email) gets the
      // branded URL. Fail-soft and idempotent: `shortenUrl` returns the original
      // string for an already-short link or an unverified base.
      if (url) url = await shortenUrl(supabase, url);
    } catch (err) {
      uploadError = err.message;
      url = null;
    }
    let emailed = false;
    if (ownerEmail) {
      try {
        emailed = await sendReportByEmail(ownerEmail, plateLabel, pdfBuffer);
      } catch { emailed = false; }
    }
    return { ok: true, url, emailed, bytes: pdfBuffer.length, uploadError };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default {
  REPORT_TYPE_ALIASES,
  resolveAnyReportType,
  loadReportPeople,
  buildReportForLane,
  deliverReportPdf,
  complianceReportToPdf
};


