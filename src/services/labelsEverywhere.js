/**
 * Saka Fleet — labels everywhere (v1.59.7)
 * ----------------------------------------
 * The optional per-entry label (`label: karen run` / `#karen`) now reaches every
 * entry kind: expenses + earnings (v1.59.0), receipts, reminders and standalone
 * odometer readings. One place for the idempotent schema, the reading ledger
 * write and the cross-kind keyword lookup — never re-implemented per lane.
 *
 * Rule 50: every write degrades on an un-migrated schema instead of breaking
 * the core action (a mileage update must never fail because a label column is
 * missing).
 */
import { sanitizeEntryLabel } from './entryLabels.js';

export const ODOMETER_READINGS_TABLE = 'odometer_readings';

export const LABELS_EVERYWHERE_SQL = `
ALTER TABLE public.receipts ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS label text;
CREATE TABLE IF NOT EXISTS public.${ODOMETER_READINGS_TABLE} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL,
  profile_id uuid,
  reading numeric NOT NULL,
  label text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_odometer_readings_vehicle
  ON public.${ODOMETER_READINGS_TABLE} (vehicle_id, recorded_at DESC);
`;

/** Does this error look like an un-migrated optional column/table? (rule 50) */
export function isSchemaDriftError(message) {
  return /column|schema|does not exist|relation/i.test(String(message || ''));
}

/**
 * Persist a standalone odometer reading with its optional label. Never throws;
 * a schema drift retries without the optional parts so `Odometer 50350 km`
 * always updates the vehicle.
 */
export async function recordLabeledReading(supabase, {
  vehicleId,
  profileId = null,
  reading,
  label = null,
  recordedAt = null
} = {}) {
  const numeric = Number(reading);
  if (!supabase || !vehicleId || !Number.isFinite(numeric)) return { ok: false, skipped: true };
  const clean = sanitizeEntryLabel(label);
  try {
    const row = { vehicle_id: vehicleId, profile_id: profileId, reading: numeric, label: clean };
    if (recordedAt) row.recorded_at = recordedAt;
    const { error } = await supabase.from(ODOMETER_READINGS_TABLE).insert([row]);
    if (!error) return { ok: true, label: clean };
    if (!isSchemaDriftError(error.message)) return { ok: false, error: error.message };
    const { error: retryError } = await supabase.from(ODOMETER_READINGS_TABLE).insert([{ vehicle_id: vehicleId, reading: numeric }]);
    return retryError ? { ok: false, error: retryError.message } : { ok: true, degraded: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Keyword search across the label surfaces that are not the expense/earning
 * ledger: receipts, reminders and odometer readings. Never throws; an
 * un-migrated schema simply returns empty groups.
 */
export async function searchOtherLabels(supabase, { vehicleIds = [], keyword = '', limit = 3 } = {}) {
  const clean = String(keyword || '').replace(/[%,()]/g, '').trim().slice(0, 40);
  const ids = (vehicleIds || []).filter(Boolean);
  const empty = { receipts: [], reminders: [], readings: [] };
  if (!supabase || !clean || ids.length === 0) return empty;
  const pattern = `%${clean}%`;
  const safely = async (run) => {
    try {
      const { data, error } = await run();
      return error ? [] : (data || []);
    } catch { return []; }
  };
  const [receipts, reminders, readings] = await Promise.all([
    safely(() => supabase.from('receipts').select('id,vendor,amount,currency,label,created_at,vehicle_id').in('vehicle_id', ids).ilike('label', pattern).order('created_at', { ascending: false }).limit(limit)),
    safely(() => supabase.from('reminders').select('id,reminder_type,due_date,label,status,created_at,vehicle_id').in('vehicle_id', ids).ilike('label', pattern).order('created_at', { ascending: false }).limit(limit)),
    safely(() => supabase.from(ODOMETER_READINGS_TABLE).select('id,reading,label,recorded_at,vehicle_id').in('vehicle_id', ids).ilike('label', pattern).order('recorded_at', { ascending: false }).limit(limit))
  ]);
  return { receipts, reminders, readings };
}

/** Render the "also labelled" block for a keyword search answer (plain WhatsApp). */
export function formatOtherLabelMatches(groups = {}) {
  const lines = [];
  for (const row of (groups.receipts || []).slice(0, 2)) {
    const amount = row.amount != null ? ` · ${row.currency || ''} ${Number(row.amount).toLocaleString('en-US')}`.trim() : '';
    lines.push(`📸 Receipt *${row.vendor || 'receipt'}*${amount}${row.label ? ` · #${row.label}` : ''}`);
  }
  for (const row of (groups.reminders || []).slice(0, 2)) {
    lines.push(`🔔 Reminder *${row.reminder_type || 'reminder'}*${row.label ? ` · #${row.label}` : ''}${row.status ? ` (${row.status})` : ''}`);
  }
  for (const row of (groups.readings || []).slice(0, 2)) {
    lines.push(`📟 Odometer *${Number(row.reading).toLocaleString('en-US')} km*${row.label ? ` · #${row.label}` : ''}`);
  }
  return lines.length ? `\n\nAlso labelled:\n${lines.join('\n')}` : '';
}

export default {
  ODOMETER_READINGS_TABLE,
  LABELS_EVERYWHERE_SQL,
  isSchemaDriftError,
  recordLabeledReading,
  searchOtherLabels,
  formatOtherLabelMatches
};
