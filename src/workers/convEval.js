import {
  getConvEvalConfig,
  isConvEvalEnabled,
  isConvEvalHealEnabled,
  resolveJudgeConfig,
  runConvEvalBatch,
  recordConvEvalRun,
  caseHash,
  CONV_EVAL_STATUS
} from '../services/convEval.js';
import { buildLiveCasesFromFriction, sampleCorpusCases } from '../services/convEvalCases.js';
import { healFailedCase, notifySuperadminConvEval } from '../services/convEvalHealer.js';

/**
 * Saka Fleet — conversation eval tick (v1.60.0)
 * --------------------------------------------
 * Kill-switched (`CONV_EVAL_ENABLED`, default off) and overlap-guarded by the
 * caller. Each tick:
 *   1. Takes PENDING friction transcripts (existing users' real pain, rule 56)
 *      and de-dupes them against hashes already evaluated in the window.
 *   2. Fills the rest of the budget with a deterministic corpus sample.
 *   3. Judges every case on the single AI hub, persists rows, and — only when
 *      `CONV_EVAL_HEAL_ENABLED=on` — heals up to `CONV_EVAL_MAX_PATCHES_PER_RUN`
 *      failures with the bounded heal loop.
 *   4. Alerts the superadmin (WhatsApp + email) when healing/proposals happened
 *      or when the judge itself is failing, with a cooldown so a provider outage
 *      cannot spam the operator.
 */

let lastErrorAlertAt = 0;

export function resetConvEvalAlertThrottle() {
  lastErrorAlertAt = 0;
}

export async function runConvEvalTick(supabase, { force = false, persist = true } = {}) {
  if (!force && !isConvEvalEnabled()) return { skipped: 'disabled' };
  if (!supabase) return { skipped: 'no_client' };
  const cfg = getConvEvalConfig();

  // 1. Live friction transcripts (PENDING only — the permanent record stays).
  let liveRows = [];
  try {
    const { data } = await supabase
      .from('chat_friction_logs')
      .select('id,friction_type,transcript_snippet,detected_at,status')
      .eq('status', 'PENDING')
      .order('detected_at', { ascending: false })
      .limit(Math.max(4, cfg.maxCases * 2));
    liveRows = data || [];
  } catch {
    liveRows = [];
  }

  // De-dupe against cases already evaluated inside the window (one judge bill).
  const recentHashes = new Set();
  try {
    const cutoff = new Date(Date.now() - cfg.dedupeHours * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('conversation_eval_runs')
      .select('transcript_hash')
      .gte('created_at', cutoff)
      .limit(500);
    for (const row of data || []) {
      if (row.transcript_hash) recentHashes.add(row.transcript_hash);
    }
  } catch {
    // Missing table (rule 50): the run still proceeds, nothing is persisted.
  }

  const liveLimit = Math.max(1, Math.floor(cfg.maxCases / 2));
  const { cases: liveCases, skipped: skippedLive } = buildLiveCasesFromFriction(liveRows, { limit: liveLimit });
  const freshLive = liveCases.filter((caseDef) => !recentHashes.has(caseHash(caseDef)));
  const corpus = freshLive.length < cfg.maxCases ? sampleCorpusCases(cfg.maxCases - freshLive.length) : [];
  const cases = [...freshLive, ...corpus];
  if (!cases.length) return { ok: true, skipped: 'no_cases' };

  const summary = await runConvEvalBatch({
    supabase,
    cases,
    threshold: cfg.threshold,
    judge: resolveJudgeConfig(),
    persist
  });

  // 2. Bounded healing (only when the operator opted in).
  const healResults = [];
  if (isConvEvalHealEnabled() && cfg.maxPatches > 0) {
    const failures = summary.results
      .filter((result) => result.judged?.ok && !result.judged.passed)
      .slice(0, cfg.maxPatches);
    for (const failure of failures) {
      const healed = await healFailedCase({
        supabase,
        caseDef: failure.caseDef,
        judged: failure.judged,
        judgeConfig: resolveJudgeConfig()
      });
      healResults.push({ caseId: failure.caseId, ...healed });
      if (healed.ok && supabase && persist) {
        await recordConvEvalRun(supabase, {
          runId: summary.runId,
          caseId: failure.caseId,
          source: failure.source,
          transcriptHash: failure.transcriptHash,
          criteria: healed.patch ? { patched: true } : {},
          scores: {},
          averageScore: healed.after,
          passed: true,
          threshold: cfg.threshold,
          frictionLogId: failure.frictionLogId || null,
          patchId: healed.ruleKey || healed.proposalCode || null,
          beforeScore: healed.before,
          afterScore: healed.after,
          status: healed.status || CONV_EVAL_STATUS.HEALED
        });
      }
    }
  }

  // 3. One throttled alert when the judge itself is unhealthy.
  let alerted = { whatsapp: false, email: false };
  if (summary.errored > 0 && Date.now() - lastErrorAlertAt >= cfg.alertCooldownHours * 60 * 60 * 1000) {
    lastErrorAlertAt = Date.now();
    alerted = await notifySuperadminConvEval(
      [
        '⚠️ *Conversation eval — judge errors*',
        '',
        `• Cases: ${summary.total} · ⚠️ ${summary.errored} could not be scored`,
        '• First error: ' + String(summary.results.find((result) => !result.judged.ok)?.judged?.error || 'unknown').slice(0, 160),
        '',
        '_Nothing was healed. Check the provider keys/breaker and `admin ai-stats`._'
      ].join('\n'),
      'Conversation eval: judge errors'
    );
  }

  return {
    ok: true,
    runId: summary.runId,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    errored: summary.errored,
    average: summary.average,
    byCriterion: summary.byCriterion,
    persisted: summary.persisted,
    live_cases: freshLive.length,
    corpus_cases: corpus.length,
    skipped_live: skippedLive.slice(0, 10),
    healed: healResults.filter((result) => result.ok),
    heal_attempts: healResults.length,
    notified: alerted
  };
}
