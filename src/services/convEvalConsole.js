import { CONVERSATION_CASES, sampleCorpusCases, buildLiveCasesFromFriction } from './convEvalCases.js';
import {
  runConvEvalBatch,
  getConvEvalSummary,
  formatConvEvalReply,
  getConvEvalConfig,
  resolveJudgeConfig,
  judgeConversation,
  isConvEvalHealEnabled
} from './convEval.js';
import { healFailedCase } from './convEvalHealer.js';

/**
 * Saka Fleet — superadmin console for conversation evals (v1.60.0)
 * ---------------------------------------------------------------
 * `admin eval`            → digest of the last 24 h (deterministic, zero tokens)
 * `admin eval run`        → score the offline corpus now (judge calls, capped)
 * `admin eval last [Nh]`  → digest for a custom window
 * `admin eval heal <id>`  → score one corpus case, then heal it if it fails
 *
 * Every result is persisted to `conversation_eval_runs` when the table exists;
 * the audit row is written by the caller (`handleSuperadminFlow`).
 */

function failingCaseLines(summary = {}) {
  const rows = (summary.results || [])
    .filter((result) => result.judged && !result.judged.ok)
    .map((result) => `• ${result.caseId} — ⚠️ ${String(result.judged.error || 'judge error').slice(0, 80)}`);
  const failed = (summary.results || [])
    .filter((result) => result.judged?.ok && !result.judged.passed)
    .map((result) => `• ${result.caseId} — failed: ${(result.judged.failing || []).join(', ')}`);
  const lines = [...rows, ...failed];
  if (!lines.length) return '';
  return `\n\n*Needs attention (${lines.length}):*\n${lines.slice(0, 10).join('\n')}${
    lines.length > 10 ? `\n…and ${lines.length - 10} more (see \`conversation_eval_runs\`).` : ''
  }`;
}

export function formatBatchFailures(summary = {}) {
  return failingCaseLines(summary);
}

/** Heal one case (id from the corpus or a live transcript) and format the reply. */
export async function healConvEvalCaseCommand(supabase, caseId = '') {
  const id = String(caseId || '').trim();
  if (!id) return { reply: 'Reply `admin eval heal <case-id>` — e.g. `admin eval heal loop-expense-litres`.', details: { reason: 'missing_case' } };
  if (!isConvEvalHealEnabled()) {
    return {
      reply: 'Healing is OFF. Set `CONV_EVAL_HEAL_ENABLED=on` (and `SENTINEL_PROPOSALS_ENABLED=on` for code proposals), redeploy, then retry.',
      details: { reason: 'heal_disabled' }
    };
  }
  let caseDef = CONVERSATION_CASES.find((entry) => entry.id === id) || null;
  if (!caseDef && supabase) {
    const { data } = await supabase
      .from('chat_friction_logs')
      .select('id,friction_type,transcript_snippet,detected_at')
      .order('detected_at', { ascending: false })
      .limit(50);
    const live = buildLiveCasesFromFriction(data || [], { limit: 50 }).cases;
    caseDef = live.find((entry) => entry.id === id || String(entry.frictionLogId || '').startsWith(id)) || null;
  }
  if (!caseDef) return { reply: `No eval case \`${id}\` in the corpus or recent friction logs.`, details: { reason: 'case_not_found' } };
  const threshold = getConvEvalConfig().threshold;
  const judged = await judgeConversation({ caseDef, judge: { ...resolveJudgeConfig(), threshold } });
  if (!judged.ok) return { reply: `⚠️ The judge could not score \`${id}\`: ${judged.error}`, details: { reason: judged.error } };
  if (judged.passed) {
    return {
      reply: `✅ \`${id}\` already passes (${judged.aggregate.toFixed(2)} ≥ ${threshold.toFixed(2)}) — nothing to heal.`,
      details: { case_id: id, passed: true, aggregate: judged.aggregate }
    };
  }
  const healed = await healFailedCase({ supabase, caseDef, judged });
  if (!healed.ok) {
    return {
      reply: [
        `🧪 \`${id}\` failed (${judged.aggregate.toFixed(2)}) but no patch shipped: *${healed.reason}*.`,
        healed.before !== undefined ? `• Before: ${Number(healed.before).toFixed(2)} · After: ${Number(healed.after || 0).toFixed(2)}` : '',
        '_Nothing was changed. A heuristic patch is never forced (rule 52)._'
      ].filter(Boolean).join('\n'),
      details: { case_id: id, reason: healed.reason, before: healed.before, after: healed.after }
    };
  }
  return {
    reply: healed.notice,
    details: {
      case_id: id,
      shipped: healed.shipped,
      rule_key: healed.ruleKey,
      proposal_code: healed.proposalCode,
      before: healed.before,
      after: healed.after
    }
  };
}

/**
 * Deterministic command handler. Returns `{ reply, details }` (never throws).
 * `mode`: 'stats' | 'run' | 'heal'
 */
export async function handleConvEvalCommand(supabase, { mode = 'stats', hours = 24, caseId = null } = {}) {
  const normalized = String(mode || 'stats').toLowerCase();
  if (normalized === 'heal') return healConvEvalCaseCommand(supabase, caseId);
  if (normalized === 'run') {
    const cfg = getConvEvalConfig();
    const cases = sampleCorpusCases(cfg.maxCases);
    const summary = await runConvEvalBatch({
      supabase,
      cases,
      threshold: cfg.threshold,
      judge: resolveJudgeConfig()
    });
    return {
      reply: `${formatConvEvalReply(summary, { title: `🧪 *Conversation eval run — ${summary.total} cases*` })}${formatBatchFailures(summary)}`,
      details: {
        run_id: summary.runId,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        errored: summary.errored,
        average: summary.average,
        threshold: summary.threshold,
        persisted: summary.persisted
      }
    };
  }
  const windowHours = Number.isFinite(Number(hours)) ? Number(hours) : 24;
  const summary = await getConvEvalSummary(supabase, windowHours);
  return {
    reply: formatConvEvalReply(summary, { hours: windowHours }),
    details: {
      hours: windowHours,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      errored: summary.errored,
      average: summary.average,
      weakest: summary.weakestCriterion,
      error: summary.error || null
    }
  };
}
