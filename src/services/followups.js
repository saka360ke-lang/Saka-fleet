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

import { resolveAnyReportType, buildReportForLane, loadReportPeople, deliverReportPdf } from './reportDelivery.js';
import { recordActivationEvent, ACTIVATION_EVENTS } from './trialEngine.js';
import { recordReportUsage } from './subscriptions.js';

export const FOLLOWUP_KINDS = Object.freeze({
  FLEET_REPORT: 'fleet_report',
  DRIVER_UNASSIGNED: 'driver_unassigned'
});

/** Deterministic unassignment copy (reason-aware, never claims a write). */
function driverUnassignedText({ plate, reason = 'owner' }) {
  const vehicle = plate || 'the vehicle';
  if (reason === 'vehicle_deleted') {
    return `🔔 *Vehicle removed* — *${vehicle}* was deleted by its owner, so you are no longer assigned to it.\n\nYour passbook history and records stay intact. Reply *"help"* to see what you can still do.`;
  }
  if (reason === 'compliance') {
    return `🔔 *Assignment ended — ${vehicle}*\n\nYour access was removed because the licence on file expired three times. Ask the owner to reassign you once it is renewed.\n\nYour historical records stay intact.`;
  }
  return `🔔 *You've been unassigned* — *${vehicle}* is no longer assigned to you.\n\nThe owner can reassign you at any time; your passbook history stays intact. Reply *"help"* to see what you can still do.`;
}

/** Queue a WhatsApp notice to a driver who lost a vehicle (fail-soft). */
export async function notifyDriverUnassigned({ supabase, driverPhone, plate, reason = 'owner' } = {}) {
  if (!supabase || !driverPhone) return false;
  return enqueueFollowUp({
    supabase,
    phone: driverPhone,
    kind: FOLLOWUP_KINDS.DRIVER_UNASSIGNED,
    payload: { plate: plate || null, reason }
  });
}

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

/** Build + send a fleet report for a queued job (never throws, never silent). */
async function runFleetReport(payload = {}) {
  const countryInfo = payload.countryCode
    ? {
      country_code: payload.countryCode,
      locale: payload.locale || 'en-US',
      currency: payload.currency || 'USD',
      country: payload.country || payload.countryCode
    }
    : null;
  const reportType = resolveAnyReportType(payload.reportType || 'fleet', 'fleet');
  const accessProfile = {
    id: payload.profileId || payload.ownerId || payload.driverId || null,
    roles: payload.roles || [],
    phone_number: payload.phone || null,
    email: payload.email || null,
    preferred_language: payload.language || 'English',
    unit_system: payload.unitSystem || 'metric',
    timezone: payload.timeZone || null
  };
  let report = null;
  try {
    report = await buildReportForLane({
      supabase: payload.supabase || null,
      reportType,
      ownerId: payload.ownerId || null,
      driverId: payload.driverId || null,
      profile: accessProfile,
      countryInfo,
      metricIds: Array.isArray(payload.metricIds) ? payload.metricIds : [],
      range: payload.range || 'this_month',
      grants: Array.isArray(payload.grants) ? payload.grants : [],
      roles: Array.isArray(payload.roles) ? payload.roles : []
    });
  } catch (err) {
    console.warn('[FollowUp] Report build failed:', err.message);
  }
  if (!report?.ok) {
    return report?.text || '📊 I could not build that report right now. Please try again in a moment.';
  }

  // PDF: render → upload → email (best effort, never blocks the text).
  let pdfNote = '';
  try {
    const people = await loadReportPeople({
      supabase: payload.supabase,
      ownerId: payload.ownerId || null,
      driverId: payload.driverId || null,
      vehicleIds: report.access?.vehicleIds || []
    });
    const delivery = await deliverReportPdf({
      supabase: payload.supabase,
      report,
      people,
      ownerEmail: payload.email || people.owner?.email || null,
      plateLabel: payload.plate || people.drivers[0]?.plate || 'Fleet'
    });
    if (delivery.ok && delivery.url) {
      pdfNote += `\n\n📄 *PDF report:* ${delivery.url}`;
      if (delivery.emailed) pdfNote += `\n📧 Sent to *${payload.email || people.owner?.email}*`;
    } else if (delivery.ok) {
      // The summary already went out; never leave the user with an empty link.
      pdfNote += '\n\n📄 The PDF could not be linked this time — the summary above is complete. Reply *"report pdf"* to retry the file.';
    } else {
      pdfNote += '\n\n📄 The PDF hit a snag while rendering — the summary above is complete. Reply *"report pdf"* to retry the file.';
    }
  } catch {
    pdfNote += '\n\n📄 The PDF could not be generated this time — the summary above is complete. Reply *"report pdf"* to retry the file.';
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

  return `${report.text}${pdfNote}`;
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
    let text = null;
    let runError = null;
    try {
      if (job.kind === FOLLOWUP_KINDS.FLEET_REPORT) {
        text = await runFleetReport({ ...(job.payload || {}), supabase });
      } else if (job.kind === FOLLOWUP_KINDS.DRIVER_UNASSIGNED) {
        text = driverUnassignedText(job.payload || {});
      }
    } catch (err) {
      runError = err.message;
    }

    // v1.28.7 — the user must ALWAYS receive something. A failed background job
    // used to die silently (the "building your report…" ACK was the last thing
    // they ever saw), so a report job now sends a deterministic recovery line.
    if (!text) {
      if (job.kind === FOLLOWUP_KINDS.FLEET_REPORT) {
        try {
          await sendFn(job.phone, '📊 Your report hit a snag while building — nothing was lost. Reply *"report"* and I will run it again right away.');
        } catch { /* best effort */ }
      }
      await supabase.from('pending_followups').update({
        status: 'failed',
        processed_at: new Date().toISOString(),
        error: runError || `unknown or empty follow-up: ${job.kind}`
      }).eq('id', job.id);
      stats.failed += 1;
      continue;
    }

    try {
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
  notifyDriverUnassigned,
  processPendingFollowUps,
  followUpAckText
};
