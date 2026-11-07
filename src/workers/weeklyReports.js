/**
 * Saka Fleet — Weekly report sweep (v1.73.0, Phase 10, P3-4)
 * ----------------------------------------------------------
 * Monday 08:00 Africa/Nairobi: every opted-in owner with at least one ACTIVE
 * vehicle receives a ONE-MESSAGE fleet-status TEXT summary.
 *
 * Hard rules baked in (section 39.5 R5 + rule 26):
 *   - TEXT ONLY. No PDF, no report link, no follow-up queue.
 *   - It NEVER touches `usage_counters` (recordReportUsage) and NEVER records a
 *     trial activation event: the weekly summary is a system nudge, not a
 *     user-generated report.
 *   - Claim-first (D5): the Nairobi day marker in system_config is WRITTEN
 *     before the sweep runs, so a second instance or a re-tick cannot double-
 *     send. A hard failure clears the marker so the next 30-minute tick
 *     retries (at-least-once — a missed week is worse than a rare duplicate).
 *
 * The day marker rides the system_config choke point (systemConfigService) and
 * is registered in SYSTEM_CONFIG_KEYS as `weeklyreports.last_sent_date`.
 */
import { buildFleetReport } from '../services/fleetReports.js';
import { readConfig, writeConfig } from '../services/systemConfigService.js';
import { CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT } from '../services/systemConfigKeys.js';
import { formatNairobiDate } from '../services/dateParser.js';
import { detectCountryFromPhone, buildGlobalContext } from '../services/globalization.js';

export const WEEKLY_REPORT_WEEKDAY = 1;        // Monday (Nairobi calendar day)
export const WEEKLY_REPORT_HOUR = 8;           // 08:00 Africa/Nairobi
export const WEEKLY_REPORT_WINDOW_MINUTES = 5; // 08:00–08:05 execution window
export const WEEKLY_REPORT_BATCH_LIMIT = 200;
export const WEEKLY_REPORT_MARKER_KEY = CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT;

/** Pure gate: is `now` inside the Monday 08:00 (EAT) window? */
export function isWeeklyReportWindow(now = new Date()) {
  const todayKey = formatNairobiDate(now);
  const weekday = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
  const hour = (now.getUTCHours() + 3) % 24;
  const minute = now.getUTCMinutes();
  return {
    inWindow: weekday === WEEKLY_REPORT_WEEKDAY && hour === WEEKLY_REPORT_HOUR && minute <= WEEKLY_REPORT_WINDOW_MINUTES,
    todayKey
  };
}

/**
 * One sweep. `buildReport` is injectable for tests (the sendFn pattern).
 * Never throws; every owner is fail-soft.
 */
export async function runWeeklyReportsSweep({
  supabase,
  sendFn,
  now = new Date(),
  buildReport = buildFleetReport
} = {}) {
  if (!supabase || typeof sendFn !== 'function') return { ok: false, reason: 'missing-dependencies' };
  const gate = isWeeklyReportWindow(now);
  if (!gate.inWindow) return { ok: true, skipped: 'outside-window', date: gate.todayKey };
  const alreadySent = await readConfig(supabase, CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT);
  if (String(alreadySent || '') === gate.todayKey) {
    return { ok: true, skipped: 'already-sent', date: gate.todayKey };
  }
  // D5 — CLAIM FIRST. A second instance (or a re-tick) sees the marker and
  // skips; a hard failure below clears it so the next tick retries.
  const claim = await writeConfig(supabase, CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT, gate.todayKey, { updatedBy: 'weeklyReports' });
  if (!claim.ok) return { ok: false, reason: 'claim-failed', error: claim.error || null };
  const result = { ok: true, date: gate.todayKey, owners: 0, sent: 0, skippedEmpty: 0, failed: 0 };
  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, phone_number, full_name, country, country_code, unit_system, preferred_language')
      .eq('weekly_report_opt_in', true)
      .eq('is_active', true)
      .is('deleted_at', null)
      .limit(WEEKLY_REPORT_BATCH_LIMIT);
    if (error) throw new Error(error.message);
    result.owners = (profiles || []).length;
    for (const profile of profiles || []) {
      try {
        const phone = profile.phone_number;
        if (!phone) continue;
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
        const countryInfo = buildGlobalContext(detectCountryFromPhone(phone), profile);
        const report = await buildReport({ supabase, type: 'fleet', ownerId: profile.id, countryInfo, profile, now });
        if (!report?.ok || !report.text) {
          result.failed += 1;
          continue;
        }
        const text = `🗓️ *Your weekly fleet summary*\n\n${report.text}\n\n_Full reports anytime: reply *report*. Turn these off: *weekly report off*._`;
        await sendFn(phone, text, profile, 'weekly_report');
        result.sent += 1;
        // NO recordReportUsage / recordActivationEvent here — deliberate.
      } catch {
        result.failed += 1;
      }
    }
    return result;
  } catch (err) {
    // Release the claim so the next tick retries (never a silent miss).
    try { await writeConfig(supabase, CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT, '', { updatedBy: 'weeklyReports' }); } catch { /* best effort */ }
    return { ...result, ok: false, reason: 'sweep-failed', error: err.message };
  }
}
