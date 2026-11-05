// v1.61.10 — refresh `expected: pass` corpus cases with healed replies so the
// next eval tick verifies the fix instead of re-failing the stale transcript.
//
//   npm run eval:apply-heals                 # dry run, last 48 h
//   npm run eval:apply-heals -- --hours=72   # wider window
//   npm run eval:apply-heals -- --write      # write the corpus file
//
// Calibration cases (`expected: "fail"`) are never touched.
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { healsFromAuditRows, selectCorpusUpdates, applyCorpusUpdates } from '../src/services/convEvalCorpusSync.js';

const args = { hours: 48, write: false };
for (const raw of process.argv.slice(2)) {
  if (raw === '--write') args.write = true;
  else if (raw.startsWith('--hours=')) args.hours = Math.max(1, Math.min(720, Number(raw.split('=')[1]) || 48));
}

const corpusPath = path.join(process.cwd(), 'evals/cases/conversation_cases.json');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY are required.');
    return 1;
  }
  const supabase = createClient(url, key);
  const since = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('admin_audit_logs')
    .select('action,details,created_at')
    .eq('action', 'CONV_EVAL_HEALED')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) {
    console.error('❌ Could not read admin_audit_logs:', error.message);
    return 1;
  }
  const heals = healsFromAuditRows(data || []);
  console.log(`🔎 ${heals.length} heal record(s) in the last ${args.hours}h (${(data || []).length} audit rows).`);
  if (heals.length === 0) {
    console.log('Nothing to apply — heals written before v1.61.10 carry no corrected reply.');
    return 0;
  }

  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const { updates, skipped } = selectCorpusUpdates(corpus.cases, heals);
  for (const skip of skipped) console.log(`  ⏭️  ${skip.id}: ${skip.reason}`);
  if (updates.length === 0) {
    console.log('✅ Corpus already matches every healed reply.');
    return 0;
  }
  for (const update of updates) {
    console.log(`  ✏️  ${update.id}${update.ruleKey ? ` (${update.ruleKey})` : ''} → ${update.reply.slice(0, 80).replace(/\n/g, ' ')}…`);
  }
  if (!args.write) {
    console.log(`\nDry run. Re-run with --write to update ${updates.length} case(s) in ${path.relative(process.cwd(), corpusPath)}.`);
    return 0;
  }
  const applied = applyCorpusUpdates(corpus.cases, updates);
  corpus.cases = applied.cases;
  fs.writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  console.log(`\n✅ Updated ${applied.applied} corpus case(s). Re-run \`node test_conv_eval.js\` and the next tick verifies them.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('❌ apply_eval_heals failed:', err.message);
    process.exit(1);
  });
