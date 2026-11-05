/**
 * Saka Fleet — conversation-eval 6-hourly digest (v1.61.12, pure builder + sender)
 * ------------------------------------------------------------------------------
 * Operator policy (2026-11-05): a heal NEVER pings the superadmin. Instead one
 * detailed EMAIL every `CONV_EVAL_DIGEST_HOURS` (default 6) says exactly what the
 * eval loop did, and ONE WhatsApp line announces that the email went out.
 *
 * `buildEvalDigest()` and `formatEvalDigestEmail()` are pure (testable without a
 * database). `sendEvalDigest()` reads `conversation_eval_runs` + the eval audit
 * rows, is idempotent across instances through `system_config`, and never throws.
 */
import { sendAdminNotificationEmail } from './mailer.js';
import { sendProactiveWhatsApp } from '../workers/sentinel.js';
import { logSystemError } from './systemErrors.js';

export const EVAL_DIGEST_CONFIG_KEY = 'last_eval_digest_at';
export const EVAL_DIGEST_DEFAULT_HOURS = 6;

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * @param {Array} runs  conversation_eval_runs rows in the window
 * @param {Array} audits admin_audit_logs rows (CONV_EVAL_* in the window)
 * @param {{hours:number, threshold:number}} opts
 */
export function buildEvalDigest(runs = [], audits = [], { hours = EVAL_DIGEST_DEFAULT_HOURS, threshold = 0.7 } = {}) {
  const rows = Array.isArray(runs) ? runs : [];
  const auditRows = Array.isArray(audits) ? audits : [];
  const judged = rows.filter((row) => row && row.status !== 'error');
  const passed = judged.filter((row) => row.passed === true || row.status === 'passed').length;
  const healedRows = rows.filter((row) => row.status === 'healed');
  const failed = judged.length - passed;
  const errored = rows.length - judged.length;

  const healed = healedRows.map((row) => ({
    caseId: row.case_id,
    before: num(row.before_score),
    after: num(row.after_score) !== null ? num(row.after_score) : num(row.average_score),
    patch: row.patch_id || null
  }));

  const proposals = auditRows
    .filter((row) => row.action === 'CONV_EVAL_PROPOSED')
    .map((row) => ({ caseId: row.details?.case_id || null, code: row.details?.proposal_code || null }));

  const refusalsByCase = new Map();
  for (const row of auditRows.filter((entry) => entry.action === 'CONV_EVAL_ERROR')) {
    const caseId = row.details?.case_id || 'unknown';
    const reason = row.details?.reason || row.details?.stage || 'error';
    const entry = refusalsByCase.get(caseId) || { caseId, reasons: [], count: 0 };
    entry.count += 1;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    refusalsByCase.set(caseId, entry);
  }
  const refusals = [...refusalsByCase.values()].sort((a, b) => b.count - a.count);
  // Three or more refusals for the same case = a prompt hint cannot fix it.
  const deterministicCandidates = refusals.filter((entry) => entry.count >= 3).map((entry) => entry.caseId);

  // Weakest criterion across the judged window (criteria JSON stores {score,reason}).
  const totals = {};
  for (const row of judged) {
    const criteria = row.criteria || {};
    for (const key of Object.keys(criteria)) {
      if (key.startsWith('__')) continue;
      const entry = criteria[key];
      const score = entry && typeof entry === 'object' ? num(entry.score) : num(entry);
      if (score === null) continue;
      if (!totals[key]) totals[key] = { sum: 0, n: 0 };
      totals[key].sum += score;
      totals[key].n += 1;
    }
  }
  let weakestCriterion = null;
  let weakestAverage = null;
  for (const key of Object.keys(totals)) {
    const avg = totals[key].sum / totals[key].n;
    if (weakestAverage === null || avg < weakestAverage) {
      weakestAverage = avg;
      weakestCriterion = key;
    }
  }

  return {
    hours,
    threshold,
    total: rows.length,
    passed,
    failed,
    errored,
    healedCount: healed.length,
    healed,
    proposals,
    refusals,
    deterministicCandidates,
    weakestCriterion,
    weakestAverage: weakestAverage === null ? null : Math.round(weakestAverage * 100) / 100,
    live: rows.filter((row) => row.source === 'live').length,
    corpus: rows.filter((row) => row.source === 'corpus').length
  };
}

/** Plain-text body for the 6-hourly email (also used by the WhatsApp ping count). */
export function formatEvalDigestEmail(digest = {}) {
  const lines = [];
  const score = (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(2));
  lines.push(`Conversation eval — last ${digest.hours || EVAL_DIGEST_DEFAULT_HOURS} hours`);
  lines.push('');
  lines.push(`Cases judged: ${digest.total || 0} (${digest.live || 0} live, ${digest.corpus || 0} corpus)`);
  lines.push(`Passed: ${digest.passed || 0} · Failed: ${digest.failed || 0} · Could not score: ${digest.errored || 0}`);
  if (digest.weakestCriterion) {
    lines.push(`Weakest criterion: ${digest.weakestCriterion} (${score(digest.weakestAverage)})`);
  }
  lines.push('');
  lines.push(`Healed: ${digest.healedCount || 0}`);
  for (const heal of digest.healed || []) {
    lines.push(`• ${heal.caseId}: ${score(heal.before)} → ${score(heal.after)}${heal.patch ? ` (${heal.patch})` : ''}`);
  }
  if (!digest.healedCount) lines.push('• none');
  lines.push('');
  lines.push(`Proposals drafted: ${(digest.proposals || []).length}`);
  for (const proposal of digest.proposals || []) {
    lines.push(`• ${proposal.code || 'pending'} — ${proposal.caseId || 'unknown'}`);
  }
  lines.push('');
  lines.push(`Heals that could not ship: ${(digest.refusals || []).length}`);
  for (const refusal of digest.refusals || []) {
    lines.push(`• ${refusal.caseId}: ${refusal.count}× ${refusal.reasons.join(', ')}`);
  }
  if ((digest.deterministicCandidates || []).length) {
    lines.push('');
    lines.push('Needs a code fix (3+ refusals — a prompt hint cannot fix these):');
    for (const caseId of digest.deterministicCandidates) lines.push(`• ${caseId}`);
  }
  lines.push('');
  lines.push('Successful heals are silent by design. This summary is the only eval email.');
  return lines.join('\n');
}

/** One-line WhatsApp ping that announces the email (never a per-heal message). */
export function formatEvalDigestPing(digest = {}) {
  return [
    '📬 *Conversation eval — 6-hour summary emailed*',
    '',
    `• Cases: ${digest.total || 0} · ✅ ${digest.passed || 0} · ❌ ${digest.failed || 0} · ⚠️ ${digest.errored || 0}`,
    `• Healed: ${digest.healedCount || 0} · Proposals: ${(digest.proposals || []).length}`,
    (digest.deterministicCandidates || []).length
      ? `• 🛠️ Needs code: ${digest.deterministicCandidates.join(', ')}`
      : '• Nothing needs code review',
    '',
    '_Details are in your inbox — `admin eval` shows the live picture._'
  ].join('\n');
}

function hoursSince(iso, now) {
  if (!iso) return Infinity;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return Infinity;
  return (now.getTime() - ms) / (60 * 60 * 1000);
}


/**
 * Send the digest when due. Idempotent across instances via `system_config`.
 * Returns `{ sent, reason?, digest? }`. Never throws.
 */
export async function sendEvalDigest({
  supabase,
  hours = EVAL_DIGEST_DEFAULT_HOURS,
  now = new Date(),
  email = sendAdminNotificationEmail,
  whatsapp = sendProactiveWhatsApp
} = {}) {
  if (!supabase) return { sent: false, reason: 'no_client' };
  const windowHours = Number(hours) > 0 ? Number(hours) : EVAL_DIGEST_DEFAULT_HOURS;
  try {
    const { data: configRow } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', EVAL_DIGEST_CONFIG_KEY)
      .maybeSingle();
    const lastAt = configRow?.value || null;
    if (hoursSince(lastAt, now) < windowHours - 0.1) {
      return { sent: false, reason: 'not_due', lastAt };
    }

    const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();
    const { data: runs } = await supabase
      .from('conversation_eval_runs')
      .select('case_id,source,status,passed,average_score,criteria,before_score,after_score,patch_id,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(2000);
    if (!runs || runs.length === 0) {
      return { sent: false, reason: 'no_activity' };
    }
    const { data: audits } = await supabase
      .from('admin_audit_logs')
      .select('action,details,created_at')
      .in('action', ['CONV_EVAL_HEALED', 'CONV_EVAL_PROPOSED', 'CONV_EVAL_ERROR'])
      .gte('created_at', since)
      .limit(1000);

    const digest = buildEvalDigest(runs, audits || [], { hours: windowHours });
    const body = formatEvalDigestEmail(digest);
    const escaped = body.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    let emailSent = false;
    try {
      emailSent = await email(
        `Saka conversation eval — ${windowHours}h summary (${digest.total} cases, ${digest.healedCount} healed)`,
        `<pre style="white-space:pre-wrap;font-family:inherit">${escaped}</pre>`
      );
    } catch { emailSent = false; }

    const phone = process.env.SUPERADMIN_PHONE;
    let pinged = false;
    if (phone) {
      try { pinged = await whatsapp(phone, formatEvalDigestPing(digest)); } catch { pinged = false; }
    }

    try {
      await supabase.from('system_config').upsert([{ key: EVAL_DIGEST_CONFIG_KEY, value: now.toISOString() }]);
    } catch { /* the next window retries */ }
    try {
      await supabase.from('admin_audit_logs').insert([{
        admin_phone: process.env.SUPERADMIN_PHONE || 'system',
        action: 'CONV_EVAL_DIGEST_SENT',
        details: { hours: windowHours, total: digest.total, healed: digest.healedCount, failed: digest.failed, email: emailSent, whatsapp: pinged },
        created_at: now.toISOString()
      }]);
    } catch { /* audit is best-effort */ }

    return { sent: emailSent, reason: emailSent ? 'sent' : 'email_failed', digest, emailed: emailSent, pinged };
  } catch (err) {
    logSystemError(supabase, err, 'evalDigest.sendEvalDigest');
    return { sent: false, reason: 'error' };
  }
}

export default { EVAL_DIGEST_CONFIG_KEY, EVAL_DIGEST_DEFAULT_HOURS, buildEvalDigest, formatEvalDigestEmail, formatEvalDigestPing, sendEvalDigest };

