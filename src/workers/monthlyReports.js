/**
 * Saka Fleet — Monthly PDF summary sweep (v1.77.0, Phase 16)
 * ---------------------------------------------------------
 * 1st of every month, 08:00 Africa/Nairobi: every opted-in owner with at least
 * one ACTIVE vehicle receives ONE email with the branded Financial & Cost PDF
 * attached (the previous Nairobi calendar month).
 *
 * Hard rules baked in (mirrors the weekly sweep, section 39.5 R5 + rule 26):
 *   - EMAIL ONLY. No WhatsApp message, no report link, no follow-up queue.
 *   - It NEVER touches `usage_counters` (recordReportUsage) and NEVER records a
 *     trial activation event: a scheduled system summary is not a user report.
 *   - Claim-first (D5): the Nairobi day marker in system_config is WRITTEN
 *     before the sweep runs, so a second instance or a re-tick cannot double-
 *     send. A hard failure clears the marker so the next 30-minute tick
 *     retries; an un-migrated `monthly_report_opt_in` column also releases the
 *     mark (rule 50 — a missing column must never burn a whole month).
 *
 * The day marker rides the system_config choke point (systemConfigService) and
 * is registered in SYSTEM_CONFIG_KEYS as `monthlyreports.last_sent_date`.
 */
import { buildCustomReport } from '../services/reportMetrics.js';
import { renderReportPdfBuffer } from '../services/reportDelivery.js';
import { sendMonthlyReportEmail } from '../services/mailer.js';
import { readConfig, writeConfig } from '../services/systemConfigService.js';
import { CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT } from '../services/systemConfigKeys.js';
import { formatNairobiDate } from '../services/dateParser.js';
import { detectCountryFromPhone, buildGlobalContext } from '../services/globalization.js';

export const MONTHLY_REPORT_DAY = 1;            // 1st of the Nairobi month
export const MONTHLY_REPORT_HOUR = 8;           // 08:00 Africa/Nairobi
export const MONTHLY_REPORT_WINDOW_MINUTES = 5; // 08:00–08:05 execution window
export const MONTHLY_REPORT_BATCH_LIMIT = 200;
export const MONTHLY_REPORT_MARKER_KEY = CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT;

/** The Financial & Cost metric set (owner lane, engine-owned). */
export const MONTHLY_REPORT_METRICS = Object.freeze([
  'total_spend', 'earnings', 'net_profit', 'fuel_spend', 'fuel_litres', 'distance'
]);

const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]);

/**
 * The previous Nairobi calendar month as an explicit window + a human label.
 * Pure. Bounds are ISO strings with the +03:00 offset so the engine query is
 * unambiguous at the month edges.
 */
export function previousMonthBounds(now = new Date()) {
  const todayKey = formatNairobiDate(now);
  const year = Number(todayKey.slice(0, 4));
  const month = Number(todayKey.slice(5, 7));
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const pad = (value) => String(value).padStart(2, '0');
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  return {
    from: `${prevYear}-${pad(prevMonth)}-01T00:00:00.000+03:00`,
    to: `${prevYear}-${pad(prevMonth)}-${pad(lastDay)}T23:59:59.999+03:00`,
    monthLabel: `${MONTH_NAMES[prevMonth - 1]} ${prevYear}`
  };
}

/** Pure gate: is `now` the 1st, inside the 08:00 (EAT) window? */
export function isMonthlyReportWindow(now = new Date()) {
  const todayKey = formatNairobiDate(now);
  const day = Number(todayKey.slice(8, 10));
  const hour = (now.getUTCHours() + 3) % 24;
  const minute = now.getUTCMinutes();
  return {
    inWindow: day === MONTHLY_REPORT_DAY && hour === MONTHLY_REPORT_HOUR && minute <= MONTHLY_REPORT_WINDOW_MINUTES,
    todayKey,
    ...previousMonthBounds(now)
  };
}


/**
 * One sweep. `buildReport`, `renderPdf` and `sendEmailFn` are injectable for
 * tests. Never throws; every owner is fail-soft.
 */
export async function runMonthlyReportsSweep({
  supabase,
  sendEmailFn = sendMonthlyReportEmail,
  now = new Date(),
  buildReport = buildCustomReport,
  renderPdf = renderReportPdfBuffer
} = {}) {
  if (!supabase || typeof sendEmailFn !== 'function') return { ok: false, reason: 'missing-dependencies' };
  const gate = isMonthlyReportWindow(now);
  if (!gate.inWindow) return { ok: true, skipped: 'outside-window', date: gate.todayKey };
  const alreadySent = await readConfig(supabase, CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT);
  if (String(alreadySent || '') === gate.todayKey) {
    return { ok: true, skipped: 'already-sent', date: gate.todayKey };
  }
  // D5 — CLAIM FIRST. A second instance (or a re-tick) sees the marker and
  // skips; a hard failure below clears it so the next tick retries.
  const claim = await writeConfig(supabase, CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT, gate.todayKey, { updatedBy: 'monthlyReports' });
  if (!claim.ok) return { ok: false, reason: 'claim-failed', error: claim.error || null };
  const result = {
    ok: true,
    date: gate.todayKey,
    monthLabel: gate.monthLabel,
    owners: 0,
    sent: 0,
    skippedEmpty: 0,
    skippedNoEmail: 0,
    failed: 0
  };
  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, phone_number, email, email_verified, full_name, country, country_code, unit_system, preferred_language')
      .eq('monthly_report_opt_in', true)
      .eq('is_active', true)
      .is('deleted_at', null)
      .limit(MONTHLY_REPORT_BATCH_LIMIT);
    if (error) {
      // Rule 50 — an un-migrated column must never burn the month's marker.
      if (/monthly_report_opt_in/i.test(error.message || '')) {
        try { await writeConfig(supabase, CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT, '', { updatedBy: 'monthlyReports' }); } catch { /* best effort */ }
        return { ok: false, reason: 'column-missing', date: gate.todayKey };
      }
      throw new Error(error.message);
    }
    result.owners = (profiles || []).length;
    const bounds = { from: gate.from, to: gate.to, label: gate.monthLabel };
    for (const profile of profiles || []) {
      try {
        if (!profile.email) {
          result.skippedNoEmail += 1;
          continue;
        }
        const { data: vehicles } = await supabase
          .from('vehicles')
          .select('id')
          .eq('owner_id', profile.id)
          .eq('status', 'ACTIVE')
          .is('deleted_at', null)
          .limit(50);
        if (!vehicles || vehicles.length === 0) {
          result.skippedEmpty += 1;
          continue;
        }
        const countryInfo = buildGlobalContext(detectCountryFromPhone(profile.phone_number), profile);
        const built = await buildReport({
          supabase,
          ownerId: profile.id,
          metricIds: [...MONTHLY_REPORT_METRICS],
          range: 'last_30_days',
          bounds,
          countryInfo,
          profile,
          access: { lane: 'owner' },
          now
        });
        if (!built?.ok || !built.data) {
          result.failed += 1;
          continue;
        }
        const pdfReport = {
          type: built.type || 'custom',
          data: {
            ...built.data,
            title: 'Monthly Financial Summary',
            subtitle: `${gate.monthLabel} · ${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'}`,
            periodLabel: gate.monthLabel
          }
        };
        const pdfBuffer = await renderPdf(pdfReport, { owner: profile, drivers: [] });
        if (!pdfBuffer) {
          result.failed += 1;
          continue;
        }
        const emailed = await sendEmailFn({
          to: profile.email,
          firstName: String(profile.full_name || '').split(' ')[0] || '',
          monthLabel: gate.monthLabel,
          countryInfo,
          pdfBuffer
        });
        if (emailed === false) {
          result.failed += 1;
          continue;
        }
        result.sent += 1;
        // NO recordReportUsage / recordActivationEvent here — deliberate (rule 26).
      } catch {
        result.failed += 1;
      }
    }
    return result;
  } catch (err) {
    // Release the claim so the next tick retries (never a silent miss).
    try { await writeConfig(supabase, CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT, '', { updatedBy: 'monthlyReports' }); } catch { /* best effort */ }
    return { ...result, ok: false, reason: 'sweep-failed', error: err.message };
  }
}
