/**
 * Saka Fleet — Background Follow-up lane (v1.16.0)
 * ------------------------------------------------
 * "Saka chats on the front end while the backend works."
 *
 * v1.77.0 (Phase 16) — the lane is now DRIVER-NOTICE ONLY. The async fleet-report
 * job ("building your report…" ACK → background PDF → link) was retired: the
 * WhatsApp report lane answers instantly with the dashboard link (plus an inline
 * PDF when it fits the budget), and the dashboard serves every PDF directly.
 * What remains is the unassignment notice (`driver_unassigned`), which a driver
 * must still receive without blocking the owner's turn.
 *
 * Fail-soft everywhere: enqueueing returns false when the table is unavailable.
 */

export const FOLLOWUP_KINDS = Object.freeze({
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
      if (job.kind === FOLLOWUP_KINDS.DRIVER_UNASSIGNED) {
        text = driverUnassignedText(job.payload || {});
      }
    } catch (err) {
      runError = err.message;
    }

    // v1.77.0 (Phase 16) — the fleet-report job no longer exists; any unknown or
    // empty kind is recorded honestly (never a silent send, never a crash).
    if (!text) {
      await supabase.from('pending_followups').update({
        status: 'failed',
        processed_at: new Date().toISOString(),
        error: runError || `unknown or empty follow-up: ${job.kind}`
      }).eq('id', job.id);
      stats.failed += 1;
      continue;
    }

    try {
      // v1.63.0 - the driver-release notice rides the driver_unassigned template
      // when configured; otherwise the same text goes out unchanged (sec 182).
      const followupKind = job.kind === FOLLOWUP_KINDS.DRIVER_UNASSIGNED ? 'driver_unassigned' : null;
      const followupVars = followupKind ? { plate: String(job.payload?.plate || job.payload?.plate_number || '') } : null;
      await sendFn(job.phone, text, followupKind, followupVars);
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

export default {
  FOLLOWUP_KINDS,
  enqueueFollowUp,
  notifyDriverUnassigned,
  processPendingFollowUps
};
