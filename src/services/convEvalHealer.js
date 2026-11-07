import { generateText, parseJsonSafely } from './aiClient.js';
import { judgeConversation, CONV_EVAL_STATUS, isConvEvalHealEnabled, getConvEvalConfig, CONV_EVAL_DEFAULT_THRESHOLD } from './convEval.js';
import { refinementIsSafe, patchViolatesBoundaryLock, sendProactiveWhatsApp } from '../workers/sentinel.js';
import { sendAdminNotificationEmail } from './mailer.js';
import { nextProposalCode } from './proposalRegistry.js';
import { isSentinelProposalsEnabled } from './sentinelPolicy.js';
import { markFrictionDeployed } from './frictionTracker.js';
import { PROMPT_REFINEMENT_MARKER } from '../../sakaAi.js';

/**
 * Saka Fleet — DeepEval closed-loop healer (v1.60.0)
 * -------------------------------------------------
 * A failed evaluation becomes ONE bounded, prompt-level fix:
 *   1. `conversation_heal` proposes a micro-rule + the reply it should have sent.
 *   2. Deterministic gates reject anything that weakens a boundary, carries a
 *      banned phrase, mentions a file path, or exceeds the length caps.
 *   3. A/B: the corrected reply is re-judged with the SAME criteria and must
 *      pass the threshold AND beat the original score (rule 52 before/after).
 *   4. Ship paths preserve the permanent governance:
 *        - prompt hint      → `saka_dynamic_rules` (the existing autonomous
 *                             precedent: prompt-level hints only, rules 15-18);
 *        - anything else    → `remediation_proposals` PENDING_APPROVAL
 *                             (superadmin reviews; CI executes — rules 16/18).
 *   5. Every outcome is audited (`CONV_EVAL_HEALED` / `CONV_EVAL_PROPOSED` /
 *      `CONV_EVAL_ERROR`). v1.61.12 — heals NEVER notify: one detailed email
 *      every `CONV_EVAL_DIGEST_HOURS` (`sendEvalDigest`) plus ONE WhatsApp ping
 *      announcing it is the whole story (judge-error alerts stay immediate).
 *
 * This module never edits source code, never touches auth/VIN/billing and never
 * throws.
 */

export const CONV_EVAL_MIN_IMPROVEMENT = 0.01;
export const HEAL_PATCH_MAX_CHARS = 280;
export const HEAL_REPLY_MAX_CHARS = 600;

// A prompt-level hint must never point at a file or a protected area.
const FORBIDDEN_PATCH = /(^|[\/\\])(\.env|\.clinerules|\.github|supabase)([\/\\]|$)|src[\/\\]|scripts[\/\\]|\.js\b|paystack|transfers\.js|githubDispatch|remediation|vin_immutability|reset-db|provision_staging/i;

export const HEAL_SYSTEM = [
  'You are the Saka Fleet Conversation Healer. A scored evaluation failed; you propose the SMALLEST durable fix.',
  'Rules:',
  '- Formulate a behavioral prompt hint (1-2 sentences) that would make the assistant pass this case and every sibling case.',
  '- NEVER weaken VIN immutability, OTP/email verification, the confirmation gate, billing math, or any security rule.',
  '- NEVER invent prices, policies, dates, plates, VINs or figures.',
  '- NEVER mention files, paths, code, deployments or tables in the patch instruction.',
  '- Also write the reply the assistant SHOULD have sent under the new hint (the A/B render).',
  'Return ONLY JSON:',
  '{"rule_key":"snake_case_key","rule_description":"short description","patch_instruction":"1-2 sentence behavioral hint","corrected_reply":"the improved reply","patch_scope":"rule","rationale":"one sentence"}',
  'patch_scope is "rule" for a prompt hint and "code" only when the fix genuinely requires a code change.'
].join('\n');

function boundedText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate the healer's output. Returns a sanitized patch or null.
 * Exported so the release test can prove every gate.
 */
export function sanitizeHealPatch(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const ruleKey = String(candidate.rule_key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  const ruleDescription = boundedText(candidate.rule_description, 120);
  const patchInstruction = boundedText(candidate.patch_instruction, HEAL_PATCH_MAX_CHARS);
  const correctedReply = boundedText(candidate.corrected_reply, HEAL_REPLY_MAX_CHARS);
  const patchScope = String(candidate.patch_scope || 'rule').toLowerCase() === 'code' ? 'code' : 'rule';
  const rationale = boundedText(candidate.rationale, 200);
  if (!ruleKey || ruleKey.length < 4) return null;
  if (!ruleDescription) return null;
  if (patchInstruction.length < 12) return null;
  if (correctedReply.length < 12) return null;
  // Content gates: banned phrases, security weakening and file paths (single
  // source with Sentinel's micro-rule optimizer).
  if (!refinementIsSafe(`${PROMPT_REFINEMENT_MARKER}\n- ${patchInstruction}`)) return null;
  if (patchViolatesBoundaryLock(patchInstruction)) return null;
  if (FORBIDDEN_PATCH.test(patchInstruction)) return null;
  if (patchViolatesBoundaryLock(correctedReply)) return null;
  return { ruleKey, ruleDescription, patchInstruction, correctedReply, patchScope, rationale };
}

/** Ask the healer model for one patch; never throws. */
export async function generateHealPatch({ caseDef = {}, judged = {}, generate = generateText } = {}) {
  const scoreLines = Object.entries(judged.scores || {})
    .map(([key, entry]) => `- ${key}: ${Number(entry?.score || 0).toFixed(2)} — ${entry?.reason || 'no reason'}`)
    .join('\n');
  const transcript = (caseDef.turns || [])
    .map((turn) => `${String(turn.role || 'user').toUpperCase()}: ${turn.text}`)
    .join('\n');
  const prompt = [
    `CASE: ${caseDef.id || 'unnamed'}${caseDef.frictionType ? ` (friction: ${caseDef.frictionType})` : ''}`,
    'CONVERSATION:',
    transcript,
    '',
    'REPLY THAT FAILED:',
    String(caseDef.reply || '').trim(),
    '',
    'JUDGE SCORES:',
    scoreLines || '- (no scores)',
    '',
    `OVERALL: ${Number(judged.aggregate || 0).toFixed(2)} (threshold ${Number(judged.threshold || CONV_EVAL_DEFAULT_THRESHOLD).toFixed(2)})`,
    'Propose the minimal fix now.'
  ].join('\n');
  try {
    const raw = await generate({
      system: HEAL_SYSTEM,
      prompt,
      jsonMode: true,
      maxTokens: 800,
      temperature: 0.3,
      purpose: 'conversation_heal'
    });
    if (!raw) return { ok: false, reason: 'empty heal response' };
    return { ok: true, patch: sanitizeHealPatch(parseJsonSafely(raw)), raw };
  } catch (err) {
    return { ok: false, reason: err?.message || 'heal error' };
  }
}

/* ------------------------------------------------------------------ */
/* Audit + superadmin notification (independent channels)             */
/* ------------------------------------------------------------------ */

async function writeAudit(supabase, action, details = {}) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('admin_audit_logs').insert([{
      admin_phone: process.env.SUPERADMIN_PHONE || 'system',
      action,
      details,
      created_at: new Date().toISOString()
    }]);
    return !error;
  } catch {
    return false;
  }
}

/**
 * v1.61.15 — is this case's heal lane cooling down?
 * Counts `CONV_EVAL_ERROR` / `no_improvement` audits for the case inside the
 * cooldown window. Fail-open (a lookup failure never blocks a legitimate heal)
 * but reports the reason so the worker can log it.
 */
export async function healCooldownStatus({ supabase, caseId = null, now = new Date() } = {}) {
  const cfg = getConvEvalConfig();
  const hours = cfg.refusalCooldownHours;
  if (!supabase || !caseId || !cfg.maxRefusalsPerCase || cfg.maxRefusalsPerCase <= 0) {
    return { cooling: false, count: 0, hours };
  }
  try {
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('admin_audit_logs')
      .select('action,details,created_at')
      .eq('action', 'CONV_EVAL_ERROR')
      .gte('created_at', since)
      .limit(200);
    const count = (data || []).filter((row) => String(row?.details?.case_id || '') === String(caseId)
      && String(row?.details?.reason || '') === 'no_improvement').length;
    return { cooling: count >= cfg.maxRefusalsPerCase, count, hours };
  } catch (err) {
    return { cooling: false, count: 0, hours, error: err?.message || 'lookup_failed' };
  }
}

/**
 * WhatsApp-first announcements (v1.61.7, operator policy).
 *
 * - A successful heal or a drafted proposal is **WhatsApp only** — no email.
 * - A heal that fails or needs intervention passes `{ email: true }`, so the
 *   superadmin also gets mail (`sendAdminNotificationEmail`).
 *
 * Channels stay independent: one outage never silences the other. Never throws.
 */
export async function notifySuperadminConvEval(text, subject = 'Saka conversation eval', { email = false } = {}) {
  const phone = process.env.SUPERADMIN_PHONE;
  let whatsapp = false;
  let emailed = false;
  if (phone) {
    try {
      whatsapp = await sendProactiveWhatsApp(phone, text);
    } catch {
      whatsapp = false;
    }
  }
  if (email) {
    try {
      emailed = await sendAdminNotificationEmail(subject, `<p>${String(text || '').replace(/\n/g, '<br>')}</p>`);
    } catch {
      emailed = false;
    }
  }
  return { whatsapp, email: emailed };
}

/** Deterministic heal/proposal announcement body. */
export function formatHealNotice({ caseDef = {}, before = 0, after = 0, patch = {}, shipped = 'rule', proposalCode = null } = {}) {
  return [
    shipped === 'proposal' ? '🧪 *Conversation eval → proposal drafted*' : '🧪 *Conversation eval healed*',
    '',
    `• Case: \`${String(caseDef.id || 'unknown').slice(0, 60)}\``,
    `• Score: ${Number(before || 0).toFixed(2)} → ${Number(after || 0).toFixed(2)}`,
    shipped === 'proposal'
      ? `• Proposal: \`${proposalCode || 'pending'}\` (PENDING_APPROVAL — no code runs without approval)`
      : `• Rule: \`${String(patch.ruleKey || 'unknown').slice(0, 50)}\``,
    `• Hint: ${String(patch.patchInstruction || '').slice(0, 180)}`,
    '',
    shipped === 'proposal'
      ? '_Review it with `admin remediations`, then `admin accept fix <CODE>`._'
      : '_Prompt-level hint only — it is live on the next turn and costs no deploy._'
  ].join('\n');
}

/**
 * v1.61.9 — keep the active prompt-rule table bounded. When `is_active` rows
 * exceed `CONV_EVAL_MAX_ACTIVE_RULES`, the OLDEST rules retire first (0 = no
 * cap). Every retirement is audited (`CONV_EVAL_RULE_RETIRED`) and reversible
 * with `admin rules toggle <key>`. Never throws.
 */
export async function enforceActiveRuleCap(supabase, { maxActive = null } = {}) {
  if (!supabase) return { retired: [] };
  const cap = maxActive === null ? Number(getConvEvalConfig().maxActiveRules) : Number(maxActive);
  if (!Number.isFinite(cap) || cap <= 0) return { retired: [] };
  try {
    const { data: active } = await supabase
      .from('saka_dynamic_rules')
      .select('id,rule_key,updated_at')
      .eq('is_active', true)
      .order('updated_at', { ascending: true })
      .limit(500);
    const list = active || [];
    if (list.length <= cap) return { retired: [] };
    const overflow = list.slice(0, list.length - cap);
    const retired = [];
    for (const rule of overflow) {
      const { error } = await supabase
        .from('saka_dynamic_rules')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', rule.id);
      if (!error) {
        retired.push(rule.rule_key);
        await writeAudit(supabase, 'CONV_EVAL_RULE_RETIRED', { rule_key: rule.rule_key, reason: 'max_active_rules', cap });
      }
    }
    return { retired };
  } catch {
    return { retired: [] };
  }
}

/**
 * Calibration cases (`expected: "fail"`) exist to prove the judge still fails a
 * known-bad reply. They are never healed (v1.61.9). Pure.
 */
export function isCalibrationCase(caseDef = {}) {
  return String(caseDef?.expected || '').toLowerCase() === 'fail';
}

/**
 * Deterministic failure / intervention announcement. This one also goes by email
 * (v1.61.7): a heal that could not ship must never be missed.
 */
export function formatHealFailureNotice({ caseDef = {}, stage = 'heal', reason = 'unknown', before = null, after = null } = {}) {
  // Number(null) === 0, so null-safety must be explicit: absent scores are
  // announced as absent, never as "0.00 → 0.00".
  const hasScores = before !== null && before !== undefined && after !== null && after !== undefined;
  const comparable = hasScores && Number.isFinite(Number(before)) && Number.isFinite(Number(after));
  return [
    '🛠️ *Conversation eval — heal needs attention*',
    '',
    `• Case: \`${String(caseDef.id || 'unknown').slice(0, 60)}\``,
    `• Stage: ${String(stage).slice(0, 40)}`,
    `• Reason: ${String(reason).slice(0, 160)}`,
    comparable
      ? `• Scores: ${Number(before).toFixed(2)} → ${Number(after).toFixed(2)} (did not clear the improvement gate)`
      : '• Scores: not comparable this attempt',
    '',
    '_No prompt rule shipped. Review `admin eval` + `admin friction pending`; code fixes still need `admin accept fix <CODE>`._'
  ].join('\n');
}

/**
 * Heal ONE failed case. Never throws.
 * Returns `{ ok, reason?, patch?, before, after, shipped, ruleKey?, proposalCode? }`.
 */
export async function healFailedCase({
  supabase = null,
  caseDef = null,
  judged = null,
  judgeConfig = {},
  generate = generateText,
  judge = judgeConversation,
  // v1.71.0 — injectable clock (test-only; defaults to now) so the cooldown
  // window is provable against a frozen fixture instead of the wall clock.
  now = new Date()
} = {}) {
  if (!isConvEvalHealEnabled()) return { ok: false, reason: 'heal_disabled' };
  if (!caseDef || !caseDef.id) return { ok: false, reason: 'no_case' };
  // v1.61.9 — calibration cases (`expected: "fail"`) are the false-negative
  // guard: their stored reply is the KNOWN bad one, so a heal can never stick
  // and only mints a duplicate rule every tick (live 2026-11-05: 8 calibration
  // cases fed 60% of heal attempts and ~6 near-identical rules).
  if (isCalibrationCase(caseDef)) return { ok: false, reason: 'calibration_case' };
  if (!judged || judged.ok !== true || judged.passed) return { ok: false, reason: 'not_failed' };

  // v1.61.15 — deterministic-lane churn guard. Once a case has produced
  // `CONV_EVAL_MAX_REFUSALS_PER_CASE` ab_gate refusals inside
  // `CONV_EVAL_REFUSAL_COOLDOWN_HOURS`, a prompt hint has proven it cannot fix
  // it: stop spending the generate + A/B judge calls every tick. The 6-hourly
  // digest still flags it as a code-fix candidate (the developer signal).
  const cooldown = await healCooldownStatus({ supabase, caseId: caseDef.id, now });
  if (cooldown.cooling) {
    await writeAudit(supabase, 'CONV_EVAL_HEAL_SKIPPED_COOLDOWN', {
      case_id: caseDef.id,
      refusals: cooldown.count,
      cooldown_hours: cooldown.hours
    });
    return { ok: false, reason: 'heal_cooldown', refusals: cooldown.count };
  }

  // v1.61.12 — heals never ping the superadmin. Every outcome is audited here,
  // and `sendEvalDigest()` emails ONE detailed 6-hour summary (with one WhatsApp
  // ping announcing it). Failure notifications are part of that digest.

  const threshold = Number.isFinite(Number(judged.threshold)) ? Number(judged.threshold) : CONV_EVAL_DEFAULT_THRESHOLD;
  const generated = await generateHealPatch({ caseDef, judged, generate });
  if (!generated.ok) {
    await writeAudit(supabase, 'CONV_EVAL_ERROR', { case_id: caseDef.id, stage: 'generate', reason: generated.reason });
    return { ok: false, reason: generated.reason };
  }
  const patch = generated.patch;
  if (!patch) {
    await writeAudit(supabase, 'CONV_EVAL_ERROR', { case_id: caseDef.id, stage: 'sanitize', reason: 'patch_rejected' });
    return { ok: false, reason: 'patch_rejected' };
  }

  // A/B: the corrected reply must clear the threshold AND beat the original.
  const after = await judge({ caseDef, reply: patch.correctedReply, judge: { ...judgeConfig, threshold } });
  if (!after.ok) {
    await writeAudit(supabase, 'CONV_EVAL_ERROR', { case_id: caseDef.id, stage: 'ab_judge', reason: after.error });
    return { ok: false, reason: 'ab_judge_failed', detail: after.error };
  }
  const before = Number(judged.aggregate || 0);
  if (!after.passed || after.aggregate <= before + CONV_EVAL_MIN_IMPROVEMENT) {
    await writeAudit(supabase, 'CONV_EVAL_ERROR', {
      case_id: caseDef.id,
      stage: 'ab_gate',
      reason: 'no_improvement',
      before,
      after: after.aggregate
    });
    return { ok: false, reason: 'no_improvement', before, after: after.aggregate, patch: { ruleKey: patch.ruleKey } };
  }

  let shipped = 'none';
  let proposalCode = null;
  let shippedKey = patch.ruleKey;
  // v1.61.9 — reuse the key this case already healed with instead of minting a
  // near-duplicate every tick (live 2026-11-05: six "confirmation opener" rules
  // in 90 minutes). Only prompt-rule patches can be reused.
  if (supabase && patch.patchScope !== 'code') {
    try {
      const { data: prior } = await supabase
        .from('conversation_eval_runs')
        .select('patch_id')
        .eq('case_id', caseDef.id)
        .eq('status', CONV_EVAL_STATUS.HEALED)
        .not('patch_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      const priorKey = prior && prior[0] ? String(prior[0].patch_id || '') : '';
      if (priorKey && !/^PROP-/i.test(priorKey)) shippedKey = priorKey;
    } catch { /* fall back to the freshly generated key */ }
  }
  if (patch.patchScope === 'code') {
    if (!isSentinelProposalsEnabled()) {
      await writeAudit(supabase, 'CONV_EVAL_ERROR', { case_id: caseDef.id, stage: 'ship', reason: 'proposals_disabled' });
      return { ok: false, reason: 'proposals_disabled', before, after: after.aggregate, patch: { ruleKey: patch.ruleKey } };
    }
    if (supabase) {
      try {
        proposalCode = await nextProposalCode(supabase);
        const { error } = await supabase.from('remediation_proposals').insert([{
          proposal_code: proposalCode,
          title: `Conversation eval fix: ${patch.ruleDescription}`.slice(0, 120),
          category: 'conv_eval',
          root_cause: `Case \`${caseDef.id}\` scored ${before.toFixed(2)} (< ${threshold.toFixed(2)}).`,
          proposed_changes: {
            overview: patch.patchInstruction,
            source: 'conversation eval healer',
            case_id: caseDef.id,
            patch_scope: 'code',
            rationale: patch.rationale,
            corrected_reply: patch.correctedReply,
            changes: [],
            tests: ['test_conv_eval.js', 'test_agent_training.js', 'test_conversation_compliance.js'],
            rollback: 'Revert the commit via git revert; no data migration is involved.'
          },
          target_signature: `conv-eval:${caseDef.id}`,
          risk_level: 'low',
          status: 'PENDING_APPROVAL',
          feedback: 'Generated by the conversation eval healer after a failed A/B gate. Review and implement in a superadmin chat session.'
        }]);
        if (error) proposalCode = null;
        else shipped = 'proposal';
      } catch {
        proposalCode = null;
      }
    }
  } else if (supabase) {
    try {
      const { error } = await supabase.from('saka_dynamic_rules').upsert({
        rule_key: shippedKey,
        rule_description: patch.ruleDescription,
        patch_instruction: patch.patchInstruction,
        is_active: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'rule_key' });
      if (!error) {
        shipped = 'rule';
        if (caseDef.frictionLogId) {
          await markFrictionDeployed(supabase, caseDef.frictionLogId, `rule:${shippedKey}`);
        }
        await enforceActiveRuleCap(supabase);
      }
    } catch {
      shipped = 'none';
    }
  }

  if (shipped === 'none') {
    await writeAudit(supabase, 'CONV_EVAL_ERROR', { case_id: caseDef.id, stage: 'ship', reason: 'ship_failed' });
    return { ok: false, reason: 'ship_failed', before, after: after.aggregate, patch: { ruleKey: patch.ruleKey } };
  }

  await writeAudit(supabase, shipped === 'proposal' ? 'CONV_EVAL_PROPOSED' : 'CONV_EVAL_HEALED', {
    case_id: caseDef.id,
    rule_key: shippedKey,
    proposal_code: proposalCode,
    before,
    after: after.aggregate,
    threshold,
    friction_log_id: caseDef.frictionLogId || null,
    // v1.61.10 — keep the corrected reply so `npm run eval:apply-heals` can
    // refresh an `expected: pass` corpus case to the healed behaviour.
    corrected_reply: shipped === 'rule' ? String(patch.correctedReply || '').slice(0, 900) : null
  });

  const notice = formatHealNotice({ caseDef, before, after: after.aggregate, patch: { ...patch, ruleKey: shippedKey }, shipped, proposalCode });
  // v1.61.12 — no per-heal notification. The audit row above plus the 6-hourly
  // `sendEvalDigest()` email (announced by ONE WhatsApp ping) is the whole story.
  const notified = { whatsapp: false, email: false };

  return {
    ok: true,
    patch,
    before,
    after: after.aggregate,
    shipped,
    ruleKey: shipped === 'rule' ? shippedKey : patch.ruleKey,
    proposalCode,
    status: shipped === 'proposal' ? CONV_EVAL_STATUS.PROPOSED : CONV_EVAL_STATUS.HEALED,
    notified,
    notice
  };
}


