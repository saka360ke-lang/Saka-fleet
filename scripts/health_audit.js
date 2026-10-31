/**
 * Saka Fleet — One-command health audit (v1.16.2)
 * ------------------------------------------------
 * Read-only. Runs the stateless suites, lints the CI workflows, snapshots the
 * pipeline/DB state and prints one report. Never writes to the database.
 *
 * Usage: npm run health
 */

import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const STATLESS_SUITES = [
  'test_trial_unbind.js',
  'test_vehicle_compliance.js',
  'test_driver_profile_onboarding.js',
  'test_dunning_reengagement.js',
  'test_followups.js',
  'test_subscription_billing.js',
  'test_trial_engine.js',
  'test_agent_training.js',
  // v1.24.2 — the wipe registry and its TRUNCATE SQL must never drift apart.
  'test_db_reset_scope.js',
  // v1.24.4 — operator status probes (public vs secret-gated payloads).
  'test_status_probe.js'
];

const WORKFLOW_DIR = '.github/workflows';
let failures = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function ok(label, detail = '') {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
}

function bad(label, detail = '') {
  failures += 1;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
}

function runSuite(file) {
  const res = spawnSync(process.execPath, ['--env-file=.env', file], { encoding: 'utf8' });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  const passed = res.status === 0 && /assertions passed|TESTS PASSED|PART 1 OK/i.test(output);
  const match = output.match(/(\d+)\s+(?:assertions passed|assertions)/i);
  if (passed) ok(file, match ? `${match[1]} assertions` : 'green');
  else bad(file, output.split('\n').filter((l) => /fail|error/i.test(l)).slice(-1)[0] || `exit ${res.status}`);
}

function lintWorkflows() {
  if (!fs.existsSync(WORKFLOW_DIR)) return bad('workflow lint', 'missing .github/workflows');
  for (const name of fs.readdirSync(WORKFLOW_DIR)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const full = path.join(WORKFLOW_DIR, name);
    const buffer = fs.readFileSync(full);
    const text = buffer.toString('utf8');
    if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      bad(`${name} lint`, 'UTF-8 BOM breaks GitHub Actions parsing');
      continue;
    }
    if (/[^\x00-\x7F]/.test(text)) {
      bad(`${name} lint`, 'non-ASCII characters risk GitHub parsing');
      continue;
    }
    const trailingSlashPath = /^\s{10,}[\w./-]+\/\s*$/m.test(text);
    if (trailingSlashPath) {
      bad(`${name} lint`, 'artifact path entry must not end with "/" (use "/**")');
      continue;
    }
    ok(`${name} lint`, 'BOM-free, ASCII, artifact paths safe');
  }
}

async function dbSnapshot() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return bad('DB snapshot', 'credentials missing');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  try {
    const proposals = await supabase
      .from('remediation_proposals')
      .select('proposal_code,status,approval_kind,attempts,created_at')
      .order('created_at', { ascending: false })
      .limit(3);
    if (proposals.error) throw proposals.error;
    const latest = (proposals.data || [])[0];
    if (latest) ok('latest proposal', `${latest.proposal_code} ${latest.status}${latest.approval_kind ? ` (${latest.approval_kind})` : ''}`);
    else ok('latest proposal', 'none yet');

    const audit = await supabase
      .from('sentinel_audit_runs')
      .select('run_date,health_score,error_count,friction_count,last_scanned_at')
      .order('created_at', { ascending: false })
      .limit(1);
    const row = (audit.data || [])[0];
    if (row) ok('Sentinel', `health ${row.health_score}, ${row.error_count} error(s), ${row.friction_count} friction, scanned ${row.last_scanned_at}`);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const friction = await supabase.from('chat_friction_logs').select('id', { count: 'exact', head: true }).gte('detected_at', since);
    ok('friction (24h)', String(friction.count ?? 0));

    const followups = await supabase.from('pending_followups').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    ok('pending follow-ups', String(followups.count ?? 0));

    const pastDue = await supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('subscription_status', 'PAST_DUE');
    ok('past-due accounts', String(pastDue.count ?? 0));
  } catch (err) {
    bad('DB snapshot', err.message);
  }
}

function gitState() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    ok('git', `${branch} @ ${head}${dirty ? ' (uncommitted changes)' : ' (clean)'}`);
  } catch (err) {
    bad('git', err.message);
  }
}

function releaseTracker() {
  try {
    const archPath = 'SAKA_FLEET_ARCHITECTURE.md';
    const arch = fs.readFileSync(archPath, 'utf8');
    const m = arch.match(/\*\*Version:\*\*\s*([0-9]+\.[0-9]+\.[0-9]+)/);
    if (!m) { bad('release tracker', 'Version line missing'); return; }
    execSync('git ls-files --error-unmatch ' + archPath, { encoding: 'utf8' });
    ok('release tracker', 'v' + m[1] + ' (architecture tracker committed)');
  } catch (err) { bad('release tracker', err.message); }
}
async function main() {
  console.log('🩺 SAKA FLEET HEALTH AUDIT');
  section('Stateless suites');
  for (const suite of STATLESS_SUITES) runSuite(suite);

  section('Workflow lint');
  lintWorkflows();

  section('Git state');
  gitState();
  releaseTracker();

  section('Pipeline & DB snapshot');
  await dbSnapshot();

  console.log(`\n${failures === 0 ? '🎉 ALL HEALTH CHECKS PASSED' : `❌ ${failures} HEALTH CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ Health audit crashed:', err.message);
  process.exit(1);
});
