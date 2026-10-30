import { buildProReportPdf } from './src/services/pdfEngine.js';

/**
 * Saka Fleet — Legacy report facade (v1.18.0)
 * -------------------------------------------
 * `generateFleetReport(reportData)` is retained for the Cloud Run monthly audit
 * path, but now renders through the Saka Pro PDF design system (fonts, KPI
 * cards, charts, owner/driver panel) instead of the old plain-Helvetica page.
 */

const ASSET_METRICS = {
  EV: (data, units) => [
    { label: 'Energy consumed', value: `${data.kwhCharged || 0} kWh` },
    { label: 'Charge cycles', value: String(data.chargeCycles || 0) },
    { label: 'Total expenditure', value: `${data.currency || 'USD'} ${Number(data.totalCost || 0).toLocaleString()}` },
    { label: 'Energy efficiency', value: `${data.burnRate || 0} ${units.imperial ? 'mi/kWh' : 'km/kWh'}` },
    { label: 'Operational status', value: data.status || 'Active & verified' }
  ],
  HEAVY: (data, units) => [
    { label: 'Operating hours', value: `${data.operatingHours || 0} h` },
    { label: 'Fuel consumed', value: `${data.fuelLiters || 0} ${units.imperial ? 'gal' : 'L'}` },
    { label: 'Total expenditure', value: `${data.currency || 'USD'} ${Number(data.totalCost || 0).toLocaleString()}` },
    { label: 'Hourly consumption', value: `${data.burnRate || 0} ${units.imperial ? 'gal' : 'L'}/h` },
    { label: 'Operational status', value: data.status || 'Active & verified' }
  ],
  ICE: (data, units) => [
    { label: 'Fuel consumed', value: `${data.fuelLiters || 0} ${units.imperial ? 'gal' : 'L'}` },
    { label: 'Total expenditure', value: `${data.currency || 'USD'} ${Number(data.totalCost || 0).toLocaleString()}` },
    { label: 'Fuel efficiency', value: `${data.burnRate || 0} ${units.imperial ? 'MPG' : 'km/L'}` },
    { label: 'Operational status', value: data.status || 'Active & verified' }
  ]
};

function assetFamily(assetType) {
  const clean = String(assetType || 'ICE').toUpperCase();
  if (clean === 'EV' || clean === 'ELECTRIC') return 'EV';
  if (clean.includes('HEAVY') || clean.includes('MACHINERY')) return 'HEAVY';
  return 'ICE';
}

export function generateFleetReport(reportData = {}) {
  const imperial = String(reportData.unitSystem || 'metric').toLowerCase() === 'imperial';
  const family = assetFamily(reportData.assetType);
  const metrics = (ASSET_METRICS[family] || ASSET_METRICS.ICE)(reportData, { imperial });

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
    subtitle: `${reportData.plateNumber || 'Fleet asset'} · ${family === 'ICE' ? 'Internal combustion' : family === 'EV' ? 'Electric' : 'Heavy equipment'}`,
    reportType: 'fleet',
    periodLabel: String(reportData.reportType || 'Standard audit').replace(/_/g, ' '),
    owner: reportData.owner || null,
    drivers: reportData.assignedDriver
      ? [{ name: reportData.assignedDriver, plate: reportData.plateNumber || '', status: 'active' }]
      : [],
    kpis: metrics.map((metric) => ({ label: metric.label, value: metric.value, hint: 'verified engine data' })),
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
        'Figures are engine-calculated from logged fuel, service and odometer records.',
        'VIN and passbook identifiers are immutable and never edited by reports.',
        'Questions? Reply to this email or message Saka on WhatsApp.'
      ]
    }]
  });
}

/** Uploads PDF buffer to Supabase Storage and returns a public URL. */
export async function uploadReportToSupabase(supabase, pdfBuffer, plateNumber) {
  const fileName = `report-${String(plateNumber || 'fleet').replace(/\s+/g, '_')}-${Date.now()}.pdf`;

  const { data, error } = await supabase.storage
    .from('fleet-reports')
    .upload(fileName, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (error) {
    throw new Error(`Supabase Storage Upload Failed: ${error.message}`);
  }

  const { data: publicUrlData } = supabase.storage
    .from('fleet-reports')
    .getPublicUrl(data.path);

  if (!publicUrlData || !publicUrlData.publicUrl) {
    throw new Error('Failed to generate public URL for report.');
  }

  return publicUrlData.publicUrl;
}

export default {
  generateFleetReport,
  uploadReportToSupabase
};
