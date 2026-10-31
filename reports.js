import { buildProReportPdf } from './src/services/pdfEngine.js';
import { normalizeAssetKind } from './src/services/countryBucket.js';
import {
  getAssetMetricProfile,
  formatMetricValue,
  isElectricFuel
} from './src/services/assetMetrics.js';

/**
 * Saka Fleet — Legacy report facade (v1.18.0, metric-registry v1.28.9)
 * -------------------------------------------------------------------
 * `generateFleetReport(reportData)` is retained for the Cloud Run monthly audit
 * path, but now renders through the Saka Pro PDF design system (fonts, KPI
 * cards, charts, owner/driver panel) and takes its KPIs from the shared
 * ASSET_METRIC_PROFILES registry, so a generator reports hours/kWh and a truck
 * reports km/litres. No metric list is re-declared here.
 */

/** Build KPI lines for any asset kind from the shared metric registry. */
export function assetMetricKpis(reportData = {}) {
  const unitSystem = String(reportData.unitSystem || 'metric').toLowerCase() === 'imperial' ? 'imperial' : 'metric';
  const locale = reportData.locale || 'en-US';
  const currency = reportData.currency || 'USD';
  const assetKind = normalizeAssetKind(reportData.assetType);
  const profile = getAssetMetricProfile(assetKind);
  const electric = isElectricFuel(reportData.fuelType) || /^(?:ev|electric)$/i.test(String(reportData.assetType || ''));

  const fmt = (metricId, value) => formatMetricValue({ metricId, value, unitSystem, locale, currency });
  const kpis = [];
  if (profile.primaryMeter === 'odometer') {
    kpis.push({ label: 'Distance', value: fmt('distance', reportData.distanceKm ?? reportData.odometer ?? 0), hint: 'verified engine data' });
  } else {
    kpis.push({ label: 'Operating hours', value: fmt('engine_hours', reportData.operatingHours ?? 0), hint: 'verified engine data' });
  }
  if (electric) {
    kpis.push({ label: 'Energy consumed', value: fmt('energy_volume', reportData.kwhCharged ?? 0), hint: 'verified engine data' });
    kpis.push({ label: 'Energy efficiency', value: fmt('energy_economy', reportData.burnRate ?? 0), hint: 'verified engine data' });
  } else {
    kpis.push({ label: 'Fuel consumed', value: fmt('fuel_volume', reportData.fuelLiters ?? 0), hint: 'verified engine data' });
    if (profile.primaryMeter === 'hours') {
      kpis.push({ label: 'Fuel burn', value: fmt('fuel_burn_per_hour', reportData.burnRate ?? 0), hint: 'verified engine data' });
      if (profile.metrics.some((metric) => metric.id === 'energy_output')) {
        kpis.push({ label: 'Energy output', value: fmt('energy_output', reportData.kwhCharged ?? 0), hint: 'verified engine data' });
      }
    } else {
      kpis.push({ label: 'Fuel efficiency', value: fmt('fuel_economy', reportData.burnRate ?? 0), hint: 'verified engine data' });
    }
  }
  kpis.push({ label: 'Total expenditure', value: formatMetricValue({ metricId: 'earnings', value: reportData.totalCost ?? 0, unitSystem, locale, currency }), hint: 'verified engine data' });
  kpis.push({ label: 'Operational status', value: reportData.status || 'Active & verified', hint: 'verified engine data' });
  return kpis;
}

export function generateFleetReport(reportData = {}) {
  const unitSystem = String(reportData.unitSystem || 'metric').toLowerCase() === 'imperial' ? 'imperial' : 'metric';
  const assetKind = normalizeAssetKind(reportData.assetType);
  const profile = getAssetMetricProfile(assetKind);
  const metrics = assetMetricKpis(reportData);

  const reminders = (reportData.reminders || []).map((reminder) => ({
    item: reminder.reminder_type || reminder.category || 'Reminder',
    due: reminder.due_date ? new Date(reminder.due_date).toLocaleDateString('en-GB') : '—',
    status: reminder.status || 'active'
  }));

  const operations = (reportData.recentOperations || []).map((operation) => ({
    date: operation.created_at ? new Date(operation.created_at).toLocaleDateString('en-GB') : '—',
    type: operation.type || 'Operation',
    value: String(operation.value ?? '—')
  }));

  return buildProReportPdf({
    title: 'Vehicle & Asset Audit',
    subtitle: `${reportData.plateNumber || reportData.serialNumber || 'Fleet asset'} · ${profile.label} · ${unitSystem === 'imperial' ? 'imperial units' : 'metric units'}`,
    reportType: 'fleet',
    periodLabel: String(reportData.reportType || 'Standard audit').replace(/_/g, ' '),
    owner: reportData.owner || null,
    drivers: reportData.assignedDriver
      ? [{ name: reportData.assignedDriver, plate: reportData.plateNumber || '', status: 'active' }]
      : [],
    kpis: metrics,
    tables: [
      reminders.length ? {
        title: 'Reminders & expirations',
        columns: [
          { key: 'item', label: 'Item', width: 1.6 },
          { key: 'due', label: 'Due', width: 1 },
          { key: 'status', label: 'Status', width: 1, type: 'status' }
        ],
        rows: reminders
      } : null,
      operations.length ? {
        title: 'Recent operations',
        columns: [
          { key: 'date', label: 'Date', width: 1 },
          { key: 'type', label: 'Operation', width: 1.6 },
          { key: 'value', label: 'Value', width: 1, align: 'right' }
        ],
        rows: operations
      } : null
    ].filter(Boolean),
    sections: [{
      title: 'Audit notes',
      lines: [
        `Figures are engine-calculated from logged ${profile.primaryMeter === 'hours' ? 'hours, fuel and service' : 'fuel, service and odometer'} records.`,
        'VIN and passbook identifiers are immutable and never edited by reports.',
        'Questions? Reply to this email or message Saka on WhatsApp.'
      ]
    }]
  });
}

/** Uploads PDF buffer to Supabase Storage and returns a public URL. */
export async function uploadReportToSupabase(supabase, pdfBuffer, plateNumber) {
  const BUCKET = 'fleet-reports';
  const fileName = `report-${String(plateNumber || 'fleet').replace(/\s+/g, '_')}-${Date.now()}.pdf`;

  const doUpload = () => supabase.storage.from(BUCKET).upload(fileName, pdfBuffer, {
    contentType: 'application/pdf',
    upsert: true
  });

  let { data, error } = await doUpload();

  // v1.28.7 — self-heal a missing/private bucket once, then retry. A missing
  // bucket used to fail every report silently (the user never got the file).
  if (error) {
    try {
      await supabase.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: 10 * 1024 * 1024,
        allowedMimeTypes: ['application/pdf']
      });
    } catch { /* already exists or storage unavailable */ }
    ({ data, error } = await doUpload());
  }

  if (error) {
    throw new Error(`Supabase Storage Upload Failed: ${error.message}`);
  }

  const { data: publicUrlData } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(data.path);

  if (publicUrlData && publicUrlData.publicUrl) return publicUrlData.publicUrl;

  // Last resort: a signed link (works even when the bucket is not public).
  try {
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(data.path, 60 * 60 * 24);
    if (signed?.signedUrl) return signed.signedUrl;
  } catch { /* fall through */ }

  throw new Error('Failed to generate a link for the report.');
}

export default {
  generateFleetReport,
  uploadReportToSupabase
};
