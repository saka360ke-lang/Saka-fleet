import { buildProReportPdf } from './pdfEngine.js';
import { sendReportByEmail } from './mailer.js';
import { uploadReportToSupabase } from '../../reports.js';
import { formatDate, formatNumber } from './globalization.js';

/**
 * Saka Fleet — Vehicle Registration Summary (v1.19.1)
 * --------------------------------------------------
 * "Send me my registration summary as a PDF" is a real request from a live
 * user. This builds the Saka Pro PDF for the owner's active vehicle, emails it,
 * uploads it to the fleet-reports bucket and returns a warm WhatsApp reply.
 * Owners only (drivers get the Vehicle Health Check instead).
 */

function money(value, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(Number(value) || 0);
  } catch {
    return `${currency || 'USD'} ${Math.round(Number(value) || 0).toLocaleString()}`;
  }
}

function daysLeft(value, now = new Date()) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - now.getTime()) / 86400000);
}

/** Structured summary for text + PDF (never throws on missing fields). */
export async function buildVehicleSummary({ supabase, vehicle, owner = null, countryInfo = null, now = new Date() } = {}) {
  if (!vehicle) return { ok: false, error: 'No active vehicle' };
  const locale = countryInfo?.locale || 'en-US';
  const currency = countryInfo?.currency || 'USD';

  let reminders = [];
  if (supabase) {
    try {
      const { data } = await supabase.from('reminders').select('*').eq('vehicle_id', vehicle.id).limit(50);
      reminders = (data || []).filter((row) => String(row.status || 'active').toUpperCase() !== 'COMPLETED');
    } catch { reminders = []; }
  }

  let driver = null;
  if (supabase && vehicle.assigned_driver_id) {
    try {
      const { data } = await supabase.from('profiles').select('id, full_name, phone_number, email').eq('id', vehicle.assigned_driver_id).maybeSingle();
      driver = data || null;
    } catch { driver = null; }
  }

  const odometer = Number(vehicle.current_mileage ?? vehicle.odometer_reading) || 0;
  const specs = [
    { label: 'Make & model', value: vehicle.make_model || '—' },
    { label: 'Year of manufacture', value: vehicle.yom ? String(vehicle.yom) : '—' },
    { label: 'Fuel type', value: vehicle.fuel_type || '—' },
    { label: 'Transmission', value: vehicle.transmission || '—' },
    { label: 'Colour', value: vehicle.color || '—' },
    { label: 'Tyre size', value: vehicle.tire_size || '—' },
    { label: 'Engine number', value: vehicle.engine_number || '—' },
    { label: 'Purchase cost', value: vehicle.purchase_cost ? money(vehicle.purchase_cost, currency) : '—' }
  ];
  const insuranceDays = daysLeft(vehicle.insurance_expiry, now);
  const inspectionDays = daysLeft(vehicle.inspection_expiry, now);
  const kpis = [
    { label: 'Odometer', value: `${formatNumber(odometer, locale)} km`, hint: 'current reading' },
    { label: 'Insurance', value: insuranceDays === null ? 'Not set' : (insuranceDays < 0 ? 'Expired' : `${insuranceDays} days`), hint: vehicle.insurance_expiry ? formatDate(vehicle.insurance_expiry, locale) : 'add a date anytime' },
    { label: 'Inspection', value: inspectionDays === null ? 'Not set' : (inspectionDays < 0 ? 'Expired' : `${inspectionDays} days`), hint: vehicle.inspection_expiry ? formatDate(vehicle.inspection_expiry, locale) : 'add a date anytime' },
    { label: 'Open reminders', value: String(reminders.length), hint: 'active items' }
  ];

  const data = {
    title: 'Vehicle Registration Summary',
    subtitle: `${vehicle.plate_number || 'Vehicle'}${vehicle.make_model ? ` · ${vehicle.make_model}` : ''}`,
    reportType: 'fleet',
    periodLabel: 'Current',
    owner: owner ? {
      name: owner.full_name || 'Fleet owner',
      email: owner.email || '',
      phone: owner.phone_number || '',
      language: owner.preferred_language || 'English',
      plan: owner.plan || null
    } : null,
    drivers: driver ? [{ name: driver.full_name || 'Assigned driver', plate: vehicle.plate_number || '', status: 'active' }] : [],
    kpis,
    tables: [
      {
        title: 'Vehicle details',
        columns: [
          { key: 'label', label: 'Field', width: 1.4 },
          { key: 'value', label: 'Value', width: 1.6, align: 'right' }
        ],
        rows: specs
      },
      reminders.length ? {
        title: 'Upcoming reminders',
        columns: [
          { key: 'item', label: 'Item', width: 1.6 },
          { key: 'due', label: 'Due', width: 1 },
          { key: 'status', label: 'Status', width: 1, type: 'status' }
        ],
        rows: reminders.slice(0, 10).map((reminder) => {
          const left = daysLeft(reminder.due_date, now);
          return {
            item: reminder.reminder_type || reminder.category || 'Reminder',
            due: reminder.due_date ? formatDate(reminder.due_date, locale) : '—',
            status: left === null ? 'active' : (left < 0 ? 'overdue' : (left <= 7 ? 'due in 7 days' : 'active'))
          };
        })
      } : null
    ].filter(Boolean),
    sections: [{
      title: 'Identity & ownership',
      rows: [
        { label: 'Registration plate', value: vehicle.plate_number || '—' },
        { label: 'VIN (immutable)', value: vehicle.vin || '—' },
        { label: 'Owner', value: owner?.full_name || '—' },
        { label: 'Assigned driver', value: driver?.full_name || 'None' },
        { label: 'Passbook token', value: vehicle.qr_passbook_token || 'Issued at registration' }
      ]
    }],
    notes: ['VIN and passbook identifiers are permanent. Figures are engine-calculated from your fleet records.']
  };

  const text = `🚗 *Vehicle Summary — ${vehicle.plate_number || 'Vehicle'}*\n\n` +
    `• *Make & model:* ${vehicle.make_model || '—'}\n` +
    `• *Year:* ${vehicle.yom || '—'} · *Fuel:* ${vehicle.fuel_type || '—'}\n` +
    `• *Odometer:* ${formatNumber(odometer, locale)} km\n` +
    `• *VIN:* ${vehicle.vin || '—'}\n` +
    (insuranceDays === null ? '' : `• *Insurance:* ${insuranceDays < 0 ? 'expired' : `${insuranceDays} days left`}\n`) +
    (reminders.length ? `• *Open reminders:* ${reminders.length}\n` : '') +
    (driver?.full_name ? `• *Assigned driver:* ${driver.full_name}\n` : '');

  return { ok: true, data, text: text.trim() };
}

/** Build → upload → email the summary PDF (best effort). */
export async function emailVehicleSummary({ supabase, summary, ownerEmail = null, plateNumber = 'Vehicle' } = {}) {
  if (!supabase || !summary?.data) return { ok: false, error: 'No summary to send' };
  try {
    const pdfBuffer = await buildProReportPdf(summary.data);
    let url = null;
    try {
      url = await uploadReportToSupabase(supabase, pdfBuffer, `Vehicle_Summary_${plateNumber}`.replace(/\s+/g, '_'));
    } catch { url = null; }
    let emailed = false;
    if (ownerEmail) {
      try {
        emailed = await sendReportByEmail(ownerEmail, plateNumber, pdfBuffer);
      } catch { emailed = false; }
    }
    return { ok: true, url, emailed, bytes: pdfBuffer.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { buildVehicleSummary, emailVehicleSummary };

