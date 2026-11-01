import { buildFleetReport, resolveReportType } from './fleetReports.js';
import { buildDriverDaybook, buildVehicleHealthCheck, buildDriverComplianceCard, buildDriverPerformance } from './driverReports.js';
import { buildVehicleDeepDive } from './vehicleDeepDive.js';
import { buildOwnerPortfolio } from './ownerPortfolio.js';
import { buildCustomReport, metricsForAccess } from './reportMetrics.js';
import { resolveReportAccess, reportAccessDeniedText } from './reportAccess.js';
import { buildProReportPdf } from './pdfEngine.js';
import { sendReportByEmail } from './mailer.js';
import { uploadReportToSupabase } from '../../reports.js';
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

/**
 * Adapt a core fleet-report payload into Saka Apex PDF sections (v1.32.0).
 * Single-vehicle scopes get a plate badge, vehicle identity, a snapshot panel
 * and no redundant one-row table; zero values keep honest, neutral tones.
 */
export function fleetReportToPdf(report, reportType) {
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
  deliverReportPdf
};


