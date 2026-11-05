import { generateText, parseJsonSafely } from './aiClient.js';
import { judgeConversation, CONV_EVAL_STATUS, isConvEvalHealEnabled, CONV_EVAL_DEFAULT_THRESHOLD } from './convEval.js';
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
 *      `CONV_EVAL_ERROR`) and announced to the superadmin on WhatsApp + email.
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
 * WhatsApp + email, independent channels (one outage never silences the other).
 * Injected in tests. Never throws.
 */
export async function notifySuperadminConvEval(text, subject = 'Saka conversation eval') {
  const phone = process.env.SUPERADMIN_PHONE;
  let whatsapp = false;
  let email = false;
  if (phone) {
    try {
      whatsapp = await sendProactiveWhatsApp(phone, text);
    } catch {
      whatsapp = false;
    }
  }
  try {
    email = await sendAdminNotificationEmail(subject, `<p>${String(text || '').replace(/\n/g, '<br>')}</p>`);
  } catch {
    email = false;
  }
  return { whatsapp, email };
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
  notify = notifySuperadminConvEval
} = {}) {
  if (!isConvEvalHealEnabled()) return { ok: false, reason: 'heal_disabled' };
  if (!caseDef || !caseDef.id) return { ok: false, reason: 'no_case' };
  if (!judged || judged.ok !== true || judged.passed) return { ok: false, reason: 'not_failed' };

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
        rule_key: patch.ruleKey,
        rule_description: patch.ruleDescription,
        patch_instruction: patch.patchInstruction,
        is_active: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'rule_key' });
      if (!error) {
        shipped = 'rule';
        if (caseDef.frictionLogId) {
          await markFrictionDeployed(supabase, caseDef.frictionLogId, `rule:${patch.ruleKey}`);
        }
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
    rule_key: patch.ruleKey,
    proposal_code: proposalCode,
    before,
    after: after.aggregate,
    threshold,
    friction_log_id: caseDef.frictionLogId || null
  });

  const notice = formatHealNotice({ caseDef, before, after: after.aggregate, patch, shipped, proposalCode });
  let notified = { whatsapp: false, email: false };
  try {
    notified = await notify(
      notice,
      shipped === 'proposal' ? `Conversation eval proposal: ${proposalCode}` : `Conversation eval healed: ${caseDef.id}`
    );
  } catch {
    notified = { whatsapp: false, email: false };
  }

  return {
    ok: true,
    patch,
    before,
    after: after.aggregate,
    shipped,
    ruleKey: patch.ruleKey,
    proposalCode,
    status: shipped === 'proposal' ? CONV_EVAL_STATUS.PROPOSED : CONV_EVAL_STATUS.HEALED,
    notified,
    notice
  };
}


