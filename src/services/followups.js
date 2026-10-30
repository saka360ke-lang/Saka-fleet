/**
 * Saka Fleet — Background Follow-up lane (v1.16.0)
 * ------------------------------------------------
 * "Saka chats on the front end while the backend works."
 *
 * Slow operations never block the conversation:
 *   1. The turn replies INSTANTLY with a deterministic ACK (zero AI tokens).
 *   2. The job is queued in `pending_followups`.
 *   3. A 30s worker executes it and pushes the result as a follow-up message,
 *      while the user keeps chatting.
 *
 * Fail-soft everywhere: enqueueing returns false when the table is unavailable
 * so callers can fall back to the synchronous path.
 */

import { buildFleetReport, resolveReportType } from './fleetReports.js';
import { recordActivationEvent, ACTIVATION_EVENTS } from './trialEngine.js';
import { recordReportUsage } from './subscriptions.js';

export const FOLLOWUP_KINDS = Object.freeze({
  FLEET_REPORT: 'fleet_report'
});

/** Queue a follow-up job. Returns true only when it was persisted. */
export async function enqueueFollowUp({ supabase, phone, kind, payload = {}, scheduledFor = null } = {}) {
  if (!supabase || !phone || !kind) return false;
  try {
    const { error } = await supabase.from('pending_followups').insert([{
      phone,
      kind,
      payload,
      status: 'pending',
      scheduled_for: scheduledFor || new Date().toISOString()
    }]);
    return !error;
  } catch {
    return false;
  }
}

/** Build + send a fleet report for a queued job. */
async function runFleetReport(payload = {}) {
  const countryInfo = payload.countryCode
    ? {
      country_code: payload.countryCode,
      locale: payload.locale || 'en-US',
      currency: payload.currency || 'USD',
      country: payload.country || payload.countryCode
    }
    : null;
  const profile = {
    id: payload.profileId || payload.ownerId || null,
    phone_number: payload.phone || null,
    email: payload.email || null,
    preferred_language: payload.language || 'English',
    unit_system: payload.unitSystem || 'metric',
    timezone: payload.timeZone || null
  };

  const reportType = resolveReportType(payload.reportType || 'fleet', 'fleet');
  const report = await buildFleetReport({
    supabase: payload.supabase || null,
    type: reportType,
    ownerId: payload.ownerId || null,
    driverId: payload.driverId || null,
    countryInfo,
    profile
  });
  if (!report?.ok || !report.text) {
    return '📊 I could not build that report right now. Please try again in a moment.';
  }

  if (payload.profileId) {
    try {
      await recordReportUsage({ supabase: payload.supabase, ownerId: payload.profileId });
      await recordActivationEvent({
        supabase: payload.supabase,
        ownerId: payload.profileId,
        event: ACTIVATION_EVENTS.REPORT_GENERATED
      });
    } catch { /* quota + activation are best-effort */ }
  }

  return report.text;
}

/**
 * Process due follow-ups. `sendFn(phone, text)` is the WhatsApp sender.
 * @returns {{processed:number, sent:number, failed:number}}
 */
export async function processPendingFollowUps({ supabase, sendFn, now = new Date(), limit = 10 } = {}) {
  const stats = { processed: 0, sent: 0, failed: 0 };
  if (!supabase || typeof sendFn !== 'function') return stats;

  let jobs = [];
  try {
    const { data } = await supabase
      .from('pending_followups')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', now.toISOString())
      .order('created_at', { ascending: true })
      .limit(limit);
    jobs = data || [];
  } catch {
    return stats;
  }

  for (const job of jobs) {
    stats.processed += 1;
    try {
      let text = null;
      if (job.kind === FOLLOWUP_KINDS.FLEET_REPORT) {
        text = await runFleetReport({ ...(job.payload || {}), supabase });
      }
      if (!text) {
        await supabase.from('pending_followups').update({
          status: 'failed',
          processed_at: new Date().toISOString(),
          error: `unknown or empty follow-up: ${job.kind}`
        }).eq('id', job.id);
        stats.failed += 1;
        continue;
      }
      await sendFn(job.phone, text);
      await supabase.from('pending_followups').update({
        status: 'sent',
        processed_at: new Date().toISOString()
      }).eq('id', job.id);
      stats.sent += 1;
    } catch (err) {
      await supabase.from('pending_followups').update({
        status: 'failed',
        processed_at: new Date().toISOString(),
        error: err.message
      }).eq('id', job.id);
      stats.failed += 1;
    }
  }
  return stats;
}

/** Deterministic instant ACK (zero AI tokens). */
export function followUpAckText(reportType = 'fleet') {
  return `📊 *Building your ${reportType} report…* ⚡\n\nI'm generating it in the background — you'll get it here in a moment. Feel free to keep chatting or send your next command.`;
}

export default {
  FOLLOWUP_KINDS,
  enqueueFollowUp,
  processPendingFollowUps,
  followUpAckText
};
