import { sendFinalEarningsReportEmail } from '../services/mailer.js';
import { buildRecordsPdf } from '../services/dashboard.js';
import { buildGlobalContext, detectCountryFromPhone, formatMoney } from '../services/globalization.js';
import { earningToLedgerRow } from '../services/reportLedger.js';

/**
 * Saka Fleet — Final Earnings Report queue worker (v1.92.0, Phase 29).
 * -------------------------------------------------------------------
 * `completePassbookTransfer` inserts ONE row into `earnings_report_queue` with
 * `due_at = now + 10 minutes` (D2/D5) after the earnings are archived. This
 * worker (30-second tick in index.js) builds the seller's Final Earnings
 * Report PDF from the archived rows and emails it, then stamps `sent_at`.
 *
 * Contract:
 *   - At most `EARNINGS_REPORT_MAX_ATTEMPTS` (3) tries per row; a failure keeps
 *     the row and reports honestly (`last_error`), never throws.
 *   - A row whose seller has no email (or no archived rows) is closed with an
 *     honest `last_error` marker instead of retrying forever.
 *   - Sent rows are pruned after `EARNINGS_REPORT_RETENTION_DAYS` (30) — the
 *     archive itself is permanent evidence in `private_earnings`.
 */

export const EARNINGS_REPORT_MAX_ATTEMPTS = 3;
export const EARNINGS_REPORT_BATCH = 20;
export const EARNINGS_REPORT_RETENTION_DAYS = 30;

/** Deliver ONE queue row: load, render, email, report honestly. */
async function deliverOne({ supabase, row, sendEmailFn, buildPdfFn }) {
  const { data: transfer } = await supabase
    .from('passbook_transfers')
    .select('id, vehicle_id, from_owner_id, completed_at')
    .eq('id', row.transfer_id)
    .maybeSingle();
  if (!transfer) return { ok: false, retry: false, reason: 'transfer_missing' };

  const { data: earnings } = await supabase
    .from('private_earnings')
    .select('*')
    .eq('archived_by_transfer_id', row.transfer_id)
    .limit(2000);
  const rows = earnings || [];
  if (rows.length === 0) return { ok: false, retry: false, reason: 'no_archived_earnings' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, email, phone_number, preferred_language, country_code')
    .eq('id', transfer.from_owner_id || row.owner_id)
    .maybeSingle();
  const to = row.email || profile?.email || null;
  if (!to) return { ok: false, retry: false, reason: 'seller_has_no_email' };

  let plate = null;
  if (transfer.vehicle_id) {
    const { data: vehicle } = await supabase
      .from('vehicles')
      .select('id, plate_number')
      .eq('id', transfer.vehicle_id)
      .maybeSingle();
    plate = vehicle?.plate_number || null;
  }

  const countryInfo = detectCountryFromPhone(profile?.phone_number || '');
  const ctx = buildGlobalContext(countryInfo, profile);
  const days = rows
    .map((entry) => String(entry.logged_at || entry.created_at || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  const from = days[0] || null;
  const toDay = days[days.length - 1] || null;
  const pdfBuffer = await buildPdfFn({ rows, profile, countryInfo, plate, from, to: toDay });
  const total = rows.reduce((sum, entry) => sum + (Number(entry.revenue_amount ?? entry.amount) || 0), 0);
  const sent = await sendEmailFn({
    to,
    firstName: profile?.full_name || '',
    plateLabel: plate || 'your asset',
    transferDate: String(transfer.completed_at || '').slice(0, 10),
    entryCount: rows.length,
    totalAmountLabel: formatMoney(total, ctx.currency, ctx.locale),
    pdfBuffer
  });
  return sent ? { ok: true, sent: true, to } : { ok: false, retry: true, reason: 'email_failed' };
}

/** Drain every due queue row (bounded batch). Never throws. */
export async function runEarningsReportQueue({
  supabase,
  sendEmailFn = sendFinalEarningsReportEmail,
  buildPdfFn = buildFinalEarningsReportPdf,
  now = new Date()
} = {}) {
  const result = { ok: true, processed: 0, sent: 0, failed: 0, closed: 0 };
  if (!supabase) return { ...result, ok: false, error: 'Database unavailable.' };
  let rows = [];
  try {
    const { data, error } = await supabase
      .from('earnings_report_queue')
      .select('*')
      .lte('due_at', new Date(now).toISOString())
      .is('sent_at', null)
      .lt('attempts', EARNINGS_REPORT_MAX_ATTEMPTS)
      .limit(EARNINGS_REPORT_BATCH);
    if (error) return { ...result, ok: false, error: error.message };
    rows = data || [];
  } catch (err) {
    return { ...result, ok: false, error: err.message };
  }

  const nowIso = new Date(now).toISOString();
  for (const row of rows) {
    result.processed += 1;
    try {
      const outcome = await deliverOne({ supabase, row, sendEmailFn, buildPdfFn });
      if (outcome.ok) {
        await supabase.from('earnings_report_queue').update({ sent_at: nowIso, last_error: null }).eq('id', row.id);
        result.sent += 1;
      } else if (outcome.retry) {
        await supabase.from('earnings_report_queue').update({
          attempts: (Number(row.attempts) || 0) + 1,
          last_error: String(outcome.reason || 'delivery_failed').slice(0, 300)
        }).eq('id', row.id);
        result.failed += 1;
      } else {
        // Nothing to send and retrying cannot help: close the row honestly.
        await supabase.from('earnings_report_queue').update({
          sent_at: nowIso,
          last_error: String(outcome.reason || 'skipped').slice(0, 300)
        }).eq('id', row.id);
        result.closed += 1;
      }
    } catch (err) {
      console.warn('[earningsReports] queue row failed:', err.message);
      try {
        await supabase.from('earnings_report_queue').update({
          attempts: (Number(row.attempts) || 0) + 1,
          last_error: String(err.message || 'queue_error').slice(0, 300)
        }).eq('id', row.id);
      } catch (attemptErr) {
        console.warn('[earningsReports] attempt bookkeeping skipped:', attemptErr.message);
      }
      result.failed += 1;
    }
  }
  return result;
}

/** Delete SENT queue rows older than the retention window. Never throws. */
export async function pruneEarningsReportQueue({ supabase, now = new Date() } = {}) {
  if (!supabase) return { ok: false, removed: 0 };
  try {
    const cutoff = new Date(new Date(now).getTime() - EARNINGS_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await supabase
      .from('earnings_report_queue')
      .delete({ count: 'exact' })
      .not('sent_at', 'is', null)
      .lt('sent_at', cutoff);
    if (error) return { ok: false, removed: 0, error: error.message };
    return { ok: true, removed: count || 0 };
  } catch (err) {
    return { ok: false, removed: 0, error: err.message };
  }
}

/** Build the Final Earnings Report PDF (reuses the records renderer, rule 55). */
export async function buildFinalEarningsReportPdf({
  rows = [],
  profile = null,
  countryInfo = null,
  plate = null,
  from = null,
  to = null
} = {}) {
  const ctx = buildGlobalContext(countryInfo, profile);
  const ledgerRows = (rows || []).map((row) => ({
    ...earningToLedgerRow(row, { ctx, vehiclePlate: plate }),
    id: row.id,
    sourceId: row.id,
    kind: 'earning',
    vehicleId: row.vehicle_id || null,
    typeLabel: row.earning_type || 'Earning',
    notes: row.notes || null,
    label: row.label || null,
    raw: row
  })).filter((row) => row.at);
  return buildRecordsPdf(ledgerRows, { from, to }, {
    profile,
    countryInfo,
    heading: 'Final Earnings Report',
    ledgerTitle: 'Archived earnings',
    note: 'Your earnings history, archived at the passbook handover — it stays yours. The new owner never sees it.'
  });
}

export default {
  buildFinalEarningsReportPdf,
  runEarningsReportQueue,
  pruneEarningsReportQueue
};
