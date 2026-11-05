import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { CONV_EVAL_CRITERIA, formatConvEvalReply, getConvEvalConfig, resolveJudgeConfig, runConvEvalBatch } from '../src/services/convEval.js';
import { CONVERSATION_CASES, buildLiveCasesFromFriction, sampleCorpusCases, CASE_VALIDATION_ERRORS, SYNTHETIC_CASES, SYNTHETIC_CASE_ERRORS } from '../src/services/convEvalCases.js';
import { healFailedCase, isCalibrationCase } from '../src/services/convEvalHealer.js';

/**
 * Saka Fleet — conversation eval CLI (v1.60.0)
 * -------------------------------------------
 * Usage:
 *   node scripts/run_conv_eval.js                 # score the offline corpus
 *   node scripts/run_conv_eval.js --live          # live friction transcripts (+ corpus fill)
 *   node scripts/run_conv_eval.js --synth         # include global synthetic batches (syn_*.json)
 *   node scripts/run_conv_eval.js --heal          # heal failures (needs CONV_EVAL_HEAL_ENABLED=on)
 *   node scripts/run_conv_eval.js --limit=6       # cap cases
 *   node scripts/run_conv_eval.js --fail-on-failures  # exit 1 when any case fails (CI gate)
 *   node scripts/run_conv_eval.js --export        # DeepEval-compatible JSONL (no provider calls)
 *
 * The judge rides `aiClient` (`purpose: conversation_eval`); DEEPSEEK_API_KEY is
 * required unless CONV_EVAL_JUDGE_PROVIDER=anthropic (ANTHROPIC_API_KEY).
 */

function parseArgs(argv = []) {
  const args = { live: false, heal: false, json: false, export: false, synth: false, failOnFailures: false, limit: null };
  for (const raw of argv) {
    if (raw === '--live') args.live = true;
    else if (raw === '--heal') args.heal = true;
    else if (raw === '--json') args.json = true;
    else if (raw === '--export') args.export = true;
    else if (raw === '--synth') args.synth = true;
    else if (raw === '--fail-on-failures') args.failOnFailures = true;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Math.min(50, Number(raw.slice(8)) || 0));
  }
  return args;
}

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
  const args = parseArgs(process.argv.slice(2));
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
  console.log(`🧪 Running ${cases.length} conversation eval case(s) · threshold ${cfg.threshold} · judge ${judge.provider || 'default'}${judge.model ? `:${judge.model}` : ''}`);
  const summary = await runConvEvalBatch({ supabase, cases, threshold: cfg.threshold, judge, persist });
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n${formatConvEvalReply(summary, { title: '🧪 *Conversation eval results*' })}`);
    for (const result of summary.results) {
      const verdict = result.judged?.ok ? (result.judged.passed ? '✅' : '❌') : '⚠️';
      const detail = result.judged?.ok
        ? `${result.judged.aggregate.toFixed(2)}${result.judged.passed ? '' : ` — ${(result.judged.failing || []).join(', ')}`}`
        : String(result.judged?.error || 'judge error');
      console.log(`  ${verdict} ${result.caseId}${result.source === 'live' ? ' (live)' : ''} — ${detail}`);
    }
    if (persist) console.log(`\n📝 Persisted ${summary.persisted}/${summary.total} rows to conversation_eval_runs.`);
    else console.log('\n(No Supabase client: results were not persisted.)');
  }

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

  if (summary.errored > 0) return 1;
  if (args.failOnFailures && summary.failed > 0) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Conversation eval error:', err);
    process.exit(1);
  });
