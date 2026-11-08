import {
  getConvEvalConfig,
  isConvEvalEnabled,
  isConvEvalHealEnabled,
  resolveJudgeConfig,
  runConvEvalBatch,
  recordConvEvalRun,
  caseHash,
  selectCasesForTick,
  shouldSendEvalCallAlert,
  EVAL_CALL_ALERT_CONFIG_KEY,
  CONV_EVAL_STATUS
} from '../services/convEval.js';
import { buildLiveCasesFromFriction, buildLiveCasesFromChatHistory, sampleCorpusCases } from '../services/convEvalCases.js';
import { healFailedCase, notifySuperadminConvEval, isCalibrationCase } from '../services/convEvalHealer.js';
import { AI_USAGE_TABLE } from '../services/aiUsageLog.js';
// v1.72.1 (P2-6) — system_config access rides the dual-window service.
import { readConfig, writeConfig } from '../services/systemConfigService.js';

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
 *   4. Never alerts immediately (v1.73.3): heals, proposals, heal failures and
 *      judge errors are audited and rendered in ONE exhaustive 6-hourly digest.
 */

/**
 * v1.73.3 (12C) — bounded audit rows for judge errors. One row per errored
 * case (max 10) so the exhaustive 6-hourly digest can name the case and the
 * reason without any immediate alert. Pure; never throws.
 */
export function buildJudgeErrorAuditRows(results = [], { phone = 'system', limit = 10 } = {}) {
  const list = Array.isArray(results) ? results : [];
  return list
    .filter((result) => result && result.judged && result.judged.ok === false)
    .slice(0, limit)
    .map((result) => ({
      admin_phone: phone,
      action: 'CONV_EVAL_JUDGE_ERROR',
      details: {
        case_id: result.caseId || 'unknown',
        reason: String(result.judged?.error || 'judge_error').slice(0, 200)
      },
      created_at: new Date().toISOString()
    }));
}

/** Nairobi calendar day key (YYYY-MM-DD) for the soft eval call alert. */
function nairobiDayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
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
  // v1.61.15 — the same read also feeds the spend selector (pass streaks +
  // last-judged times), so the rest lane costs zero extra queries.
  const recentHashes = new Set();
  let recentRunRows = [];
  try {
    const cutoff = new Date(Date.now() - cfg.dedupeHours * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('conversation_eval_runs')
      .select('transcript_hash,case_id,passed,status,created_at')
      .gte('created_at', cutoff)
      .limit(500);
    recentRunRows = data || [];
    for (const row of recentRunRows) {
      if (row.transcript_hash) recentHashes.add(row.transcript_hash);
    }
  } catch (err) {
    // Missing table (rule 50): the run still proceeds, nothing is persisted.
    recentRunRows = [];
    console.warn('[ConversationEval] recent-run read failed:', err?.message || 'unknown');
  }

  const liveLimit = cfg.maxCases === 0 ? 50 : Math.max(1, Math.floor(cfg.maxCases / 2));
  // v1.61.3 — live CHAT EXCHANGES are the primary source (friction snippets are
  // not always transcripts: the circuit breaker wrote prompt-only rows).
  let chatRows = [];
  try {
    const { data } = await supabase
      .from('chat_history')
      .select('user_phone,role,message,created_at')
      .order('created_at', { ascending: false })
      .limit(120);
    chatRows = data || [];
  } catch {
    chatRows = [];
  }
  const { cases: chatCases, skipped: skippedChat } = buildLiveCasesFromChatHistory(chatRows, { limit: liveLimit });
  const { cases: liveCases, skipped: skippedLiveRows } = buildLiveCasesFromFriction(liveRows, { limit: liveLimit });
  const liveCandidates = [...chatCases, ...liveCases];
  const freshLive = liveCandidates.filter((caseDef) => !recentHashes.has(caseHash(caseDef)));
  const skippedLive = [...skippedChat, ...skippedLiveRows];
  const corpus = cfg.maxCases === 0
    ? sampleCorpusCases(1000)
    : (freshLive.length < cfg.maxCases ? sampleCorpusCases(cfg.maxCases - freshLive.length) : []);
  // v1.61.15 — spend selector: live + calibration always stay, proven-green
  // cases rest, recently failed cases jump the queue, and the tick is capped by
  // CONV_EVAL_MAX_JUDGE_CALLS_PER_TICK. Quality lanes are hard-coded first.
  const selection = selectCasesForTick({
    cases: [...freshLive, ...corpus],
    recentRuns: recentRunRows,
    config: cfg
  });
  const cases = selection.cases;
  if (!cases.length) {
    return { ok: true, skipped: 'resting_cases', rest_skipped: selection.skippedRest.slice(0, 10), capped: selection.capped };
  }

  const summary = await runConvEvalBatch({
    supabase,
    cases,
    threshold: cfg.threshold,
    judge: resolveJudgeConfig(),
    persist,
    callBudget: cfg.maxJudgeCallsPerTick > 0 ? cfg.maxJudgeCallsPerTick : null
  });

  // 2. Healing (only when the operator opted in). maxPatches 0 = heal ALL
  // failures this tick (resource-bounded), per the always-on contract.
  const healResults = [];
  let calibrationSkipped = 0;
  if (isConvEvalHealEnabled()) {
    const patchBudget = cfg.maxPatches === 0
      ? Number.MAX_SAFE_INTEGER
      : cfg.maxPatches;
    const failures = summary.results
      .filter((result) => result.judged?.ok && !result.judged.passed)
      // v1.61.9 — calibration cases (`expected: "fail"`) are the judge's
      // false-negative guard and must never be healed (live 2026-11-05: they
      // consumed ~60% of heal attempts and minted duplicate rules each tick).
      .filter((result) => {
        if (isCalibrationCase(result.caseDef)) {
          calibrationSkipped += 1;
          return false;
        }
        return true;
      })
      .slice(0, patchBudget);
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

  // 3. No per-tick failure alert (v1.61.12): failures are audited and land in
  // the 6-hourly `sendEvalDigest()` email.
  const failureDigest = { count: 0 };

  // 4. v1.73.3 (12C) — judge errors are NEVER announced immediately. Each
  // errored case writes ONE bounded audit row; the exhaustive 6-hourly digest
  // renders the "Judge errors" section. A tick where nothing could be scored
  // no longer interrupts the operator on WhatsApp or email.
  const alerted = { whatsapp: false, email: false };
  if (summary.errored > 0 && supabase && persist) {
    try {
      const rows = buildJudgeErrorAuditRows(summary.results, {
        phone: process.env.SUPERADMIN_PHONE || 'system'
      });
      if (rows.length) await supabase.from('admin_audit_logs').insert(rows);
    } catch (auditErr) {
      console.warn('[ConversationEval] judge-error audit skipped:', auditErr?.message || 'unknown');
    }
  }

  // 5. v1.61.15 — soft daily call alert (alert-only; evals NEVER hard-stop —
  // a silent supervision outage would be worse than the spend). One WhatsApp per
  // Nairobi day at most; the digest email remains the detail channel.
  let callAlert = null;
  if (cfg.evalDailyCallAlert > 0) {
    try {
      const todayKey = nairobiDayKey();
      const since = new Date(`${todayKey}T00:00:00+03:00`).toISOString();
      const { count } = await supabase
        .from(AI_USAGE_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('purpose', 'conversation_eval')
        .gte('created_at', since);
      // v1.72.1 (P2-6) — dual read (namespaced key, legacy fallback).
      const lastAlertKey = (await readConfig(supabase, EVAL_CALL_ALERT_CONFIG_KEY)) || '';
      if (shouldSendEvalCallAlert({ calls: count || 0, threshold: cfg.evalDailyCallAlert, todayKey, lastAlertKey })) {
        await notifySuperadminConvEval([
          '📈 *Conversation eval — daily call budget*',
          '',
          `• Eval AI calls today: ${count} (alert at ${cfg.evalDailyCallAlert})`,
          '• Evals keep running — this is a heads-up, not a stop.',
          '',
          '_`admin ai-stats` shows the full picture; the 6-hourly digest shows spend._'
        ].join('\n'), 'Conversation eval: daily call budget', { email: false });
        await writeConfig(supabase, EVAL_CALL_ALERT_CONFIG_KEY, todayKey);
        await supabase.from('admin_audit_logs').insert([{
          admin_phone: process.env.SUPERADMIN_PHONE || 'system',
          action: 'CONV_EVAL_CALL_ALERT',
          details: { calls: count, threshold: cfg.evalDailyCallAlert, day: todayKey },
          created_at: new Date().toISOString()
        }]);
        callAlert = { calls: count, threshold: cfg.evalDailyCallAlert };
      }
    } catch (err) {
      // Alerting is best-effort; record the failure instead of swallowing it.
      callAlert = { error: err?.message || 'alert_failed' };
      console.warn('[ConversationEval] call alert failed:', err?.message || 'unknown');
    }
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
    rejudged: summary.rejudged || 0,
    live_cases: freshLive.length,
    corpus_cases: corpus.length,
    rest_skipped: selection.skippedRest.slice(0, 10),
    rest_skipped_count: selection.skippedRest.length,
    capped: selection.capped,
    call_alert: callAlert,
    skipped_live: skippedLive.slice(0, 10),
    healed: healResults.filter((result) => result.ok),
    heal_attempts: healResults.length,
    calibration_skipped: calibrationSkipped,
    failure_alert: failureDigest,
    notified: alerted
  };
}
