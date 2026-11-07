import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { CONV_EVAL_CRITERIA, aggregateEvalRuns, evalGateExitCode, formatConvEvalReply, getConvEvalConfig, parseConvEvalArgs, resolveJudgeConfig, runConvEvalBatch } from '../src/services/convEval.js';
import { CONVERSATION_CASES, buildLiveCasesFromFriction, sampleCorpusCases, CASE_VALIDATION_ERRORS, SYNTHETIC_CASES, SYNTHETIC_CASE_ERRORS } from '../src/services/convEvalCases.js';
import { healFailedCase, isCalibrationCase } from '../src/services/convEvalHealer.js';
import { installAiUsageSink } from '../src/services/aiUsageLog.js';
import { evaluateDeepSeekOffPeakGate, logDeepSeekDeferralAudit } from '../src/services/deepseekSchedule.js';

/**
 * Saka Fleet — conversation eval CLI (v1.60.0)
 * -------------------------------------------
 * Usage:
 *   node scripts/run_conv_eval.js                 # score the offline corpus
 *   node scripts/run_conv_eval.js --live          # live friction transcripts (+ corpus fill)
 *   node scripts/run_conv_eval.js --synth         # include global synthetic batches (syn_*.json)
 *   node scripts/run_conv_eval.js --heal          # heal failures (needs CONV_EVAL_HEAL_ENABLED=on)
 *   node scripts/run_conv_eval.js --limit=6       # cap cases
 *   node scripts/run_conv_eval.js --case=id1,id2  # judge only these cases (curation)
 *   node scripts/run_conv_eval.js --fail-on-failures  # exit 1 when any case fails (CI gate)
 *   node scripts/run_conv_eval.js --exclude-calibration  # gate on signal cases only (calibration still judged + persisted)
 *   node scripts/run_conv_eval.js --exclude-calibration --repeat 3 --min-pass-rate 0.95
 *                                                        # flake-tolerant gate (v1.70.1): a case failing
 *                                                        # 1 of 3 runs still passes at 0.95 (e.g. 68/69)
 *   Exit codes (v1.70.1): 0 clean · 1 signal pass rate below --min-pass-rate ·
 *   2 judge errors only (visible warning, never a hard gate failure)
 *   node scripts/run_conv_eval.js --export        # DeepEval-compatible JSONL (no provider calls)
 *   node scripts/run_conv_eval.js --force         # override the DeepSeek peak-hours gate
 *
 * The judge rides `aiClient` (`purpose: conversation_eval`); DEEPSEEK_API_KEY is
 * required unless CONV_EVAL_JUDGE_PROVIDER=anthropic (ANTHROPIC_API_KEY).
 */

// v1.70.1 — argv parsing moved to convEval.js (`parseConvEvalArgs`) so the
// flag contract (--repeat, --min-pass-rate) is unit-testable without running
// the CLI. It keeps every legacy flag and adds the flake-tolerant gate flags.

function deepEvalExport(cases = []) {
  return cases.map((caseDef) => JSON.stringify({
    name: caseDef.id,
    input: (caseDef.turns || []).map((turn) => `${turn.role}: ${turn.text}`).join('\n'),
    actual_output: caseDef.reply,
    criteria: CONV_EVAL_CRITERIA.map((criterion) => `${criterion.key}: ${criterion.rubric}`),
    tags: caseDef.tags,
    expected: caseDef.expected
  })).join('\n');
}

async function main() {
  const args = parseConvEvalArgs(process.argv.slice(2));
  const cfg = getConvEvalConfig();
  const limit = args.limit || cfg.maxCases;

  if (args.export) {
    // Pure export: no provider call, no database row.
    process.stdout.write(`${deepEvalExport(CONVERSATION_CASES)}\n`);
    return 0;
  }

  if (CASE_VALIDATION_ERRORS.length) {
    console.warn(`⚠️ Corpus validation dropped ${CASE_VALIDATION_ERRORS.length} case(s):`);
    for (const error of CASE_VALIDATION_ERRORS.slice(0, 10)) console.warn(`   - ${error}`);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const supabase = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  const persist = Boolean(supabase);
  // v1.61.12 — CLI judge calls must reach ai_usage_logs (rules 20/21).
  if (supabase) installAiUsageSink(supabase);

  // v1.62.0 — rule 61: judge batches are heavy DeepSeek work. Peak runs are
  // deferred with exact next-off-peak guidance (audited), never silently billed
  // at the peak rate. `--export` returned above (no provider calls); `--force`
  // is the explicit operator escape hatch.
  const gate = evaluateDeepSeekOffPeakGate({ now: new Date(), force: args.force });
  if (!gate.allowed) {
    console.warn(gate.message);
    await logDeepSeekDeferralAudit(supabase, {
      adminPhone: 'cli:eval',
      script: 'run_conv_eval',
      reason: gate.reason,
      next_off_peak: gate.state?.nextTransition ? gate.state.nextTransition.toISOString() : null
    });
    return 2;
  }

  let cases = sampleCorpusCases(limit);
  if (args.live) {
    if (!supabase) {
      console.warn('⚠️ --live needs SUPABASE_URL + SUPABASE_SERVICE_KEY; falling back to the corpus.');
    } else {
      const { data } = await supabase
        .from('chat_friction_logs')
        .select('id,friction_type,transcript_snippet,detected_at,status')
        .eq('status', 'PENDING')
        .order('detected_at', { ascending: false })
        .limit(limit * 2);
      const live = buildLiveCasesFromFriction(data || [], { limit: Math.floor(limit / 2) });
      cases = [...live.cases, ...sampleCorpusCases(Math.max(0, limit - live.cases.length))];
      if (live.skipped.length) console.warn(`⚠️ Skipped ${live.skipped.length} unparseable friction row(s).`);
    }
  }

  if (!cases.length) {
    console.error('No eval cases to run.');
    return 1;
  }

  if (args.synth) {
    if (SYNTHETIC_CASE_ERRORS.length) {
      console.warn(`⚠️ ${SYNTHETIC_CASE_ERRORS.length} synthetic case(s) were skipped during load:`);
      for (const error of SYNTHETIC_CASE_ERRORS.slice(0, 5)) console.warn(`   - ${error}`);
    }
    if (!SYNTHETIC_CASES.length) {
      console.warn('⚠️ --synth requested but no evals/cases/syn_*.json batches exist (run `npm run synth:cases` first).');
    }
    const known = new Set(cases.map((caseDef) => caseDef.id));
    const merged = [...cases];
    for (const caseDef of SYNTHETIC_CASES) {
      if (merged.length >= limit) break;
      if (!known.has(caseDef.id)) {
        merged.push(caseDef);
        known.add(caseDef.id);
      }
    }
    const added = merged.length - cases.length;
    if (added > 0) {
      const buckets = [...new Set(merged.filter((caseDef) => caseDef.source === 'synthetic').map((caseDef) => caseDef.countryBucket))];
      console.log(`🌍 Added ${added} synthetic case(s) — buckets: ${buckets.join(', ')}`);
    }
    cases = merged;
  }

  const judge = resolveJudgeConfig();
  // v1.61.15 — curation filter: judge ONLY the named cases (spend control).
  if (args.caseIds?.length) {
    const wanted = new Set(args.caseIds);
    cases = cases.filter((caseDef) => wanted.has(caseDef.id));
    if (!cases.length) {
      console.warn(`⚠️ --case matched none of: ${args.caseIds.join(', ')}`);
      return 1;
    }
  }
  const runCount = Math.max(1, Number(args.repeat) || 1);
  console.log(`🧪 Running ${cases.length} conversation eval case(s) · threshold ${cfg.threshold} · judge ${judge.provider || 'default'}${judge.model ? `:${judge.model}` : ''}${runCount > 1 ? ` · ${runCount} repeat run(s) · min pass rate ${(args.minPassRate * 100).toFixed(1)}%` : ''}`);
  // v1.70.1 — run the corpus N times; the gate below aggregates every run so a
  // single noisy judge verdict cannot flip a shipping decision.
  const summaries = [];
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    if (runIndex > 0) console.log(`\n🔁 Repeat run ${runIndex + 1}/${runCount}…`);
    const runSummary = await runConvEvalBatch({ supabase, cases, threshold: cfg.threshold, judge, persist });
    summaries.push(runSummary);
    if (args.json) {
      console.log(JSON.stringify(runSummary, null, 2));
    } else {
      const runTitle = `🧪 *Conversation eval results*${runCount > 1 ? ` — run ${runIndex + 1}/${runCount}` : ''}`;
      console.log(`\n${formatConvEvalReply(runSummary, { title: runTitle })}`);
      for (const result of runSummary.results) {
        const verdict = result.judged?.ok ? (result.judged.passed ? '✅' : '❌') : '⚠️';
        const detail = result.judged?.ok
          ? `${result.judged.aggregate.toFixed(2)}${result.judged.passed ? '' : ` — ${(result.judged.failing || []).join(', ')}`}`
          : String(result.judged?.error || 'judge error');
        console.log(`  ${verdict} ${result.caseId}${result.source === 'live' ? ' (live)' : ''} — ${detail}`);
      }
      if (persist) console.log(`\n📝 Persisted ${runSummary.persisted}/${runSummary.total} rows to conversation_eval_runs.`);
      else console.log('\n(No Supabase client: results were not persisted.)');
    }
  }
  // Healing acts on the FIRST run only — a measurement repeat must never
  // re-heal the same failures and burn the patch budget.
  const summary = summaries[0];

  if (args.heal && summary.failed > 0) {
    console.log('\n🩹 Healing failed cases…');
    const failures = summary.results
      .filter((result) => result.judged?.ok && !result.judged.passed)
      // v1.61.9 — calibration cases (`expected: "fail"`) are never healed.
      .filter((result) => {
        if (isCalibrationCase(result.caseDef)) {
          console.log(`  ⏭️ ${result.caseId}: calibration case (expected fail) — not healed`);
          return false;
        }
        return true;
      })
      .slice(0, cfg.maxPatches);
    for (const failure of failures) {
      const healed = await healFailedCase({ supabase, caseDef: failure.caseDef, judged: failure.judged, judgeConfig: judge });
      if (healed.ok) {
        console.log(`  ✅ ${failure.caseId}: ${healed.before.toFixed(2)} → ${healed.after.toFixed(2)} · ${healed.shipped} ${healed.ruleKey || healed.proposalCode}`);
      } else {
        console.log(`  ⚠️ ${failure.caseId}: no patch shipped (${healed.reason})`);
      }
    }
  }

  // v1.70.1 — flake-tolerant gate across EVERY repeat run. Errored cases are
  // excluded from the pass-rate denominator (a judge hiccup can never block a
  // valid refactor) but surface as exit 2 when the gate itself passes.
  // Calibration expected-fails are held, never counted as signal failures.
  const aggregate = aggregateEvalRuns(summaries, { minPassRate: args.minPassRate });
  const gateExit = evalGateExitCode(aggregate);
  const passPct = (aggregate.passRate * 100).toFixed(1);
  const minPct = (aggregate.minPassRate * 100).toFixed(1);
  const holdPct = aggregate.calibrationTotal ? (aggregate.calibrationHeld / aggregate.calibrationTotal) * 100 : 0;
  if (args.json) {
    console.log(JSON.stringify({ aggregate }, null, 2));
  }
  if (args.excludeCalibration) {
    console.log(`\n🎯 Calibration-aware gate: ${aggregate.signalTotal} signal result(s) across ${aggregate.runs} run(s) · min pass rate ${minPct}%`);
    console.log(`   Signal pass rate: ${passPct}% (${aggregate.signalPassed}/${aggregate.signalTotal})`);
    console.log(`   Judge errors: ${aggregate.errored}${aggregate.errored > 0 ? ' — warning only (exit 2), never a hard fail' : ''}`);
    console.log(`   Calibration hold: ${holdPct.toFixed(1)}% (${aggregate.calibrationHeld}/${aggregate.calibrationTotal})`);
    console.log(`   Gate: ${aggregate.gatePassed ? 'PASS ✅' : 'FAIL ❌ (signal pass rate below the min pass rate)'}${gateExit === 2 ? ' — judge errors kept the exit at 2' : ''}`);
  } else {
    console.log(`\n🎯 Signal gate: ${aggregate.signalTotal} case result(s) across ${aggregate.runs} run(s) · min pass rate ${minPct}%`);
    console.log(`   Signal pass rate: ${passPct}% (${aggregate.signalPassed}/${aggregate.signalTotal})`);
    console.log(`   Judge errors: ${aggregate.errored}`);
    console.log(`   Gate: ${aggregate.gatePassed ? 'PASS ✅' : 'FAIL ❌'}`);
  }
  if (gateExit === 1) return 1;
  if (gateExit === 2) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Conversation eval error:', err);
    process.exit(1);
  });
