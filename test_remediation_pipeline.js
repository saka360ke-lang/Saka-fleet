import 'dotenv/config';
import assert from 'assert';
import { createClient } from '@supabase/supabase-js';
import { runWithCleanup } from './scripts/testCleanup.js';
import {
  REMEDIATION_STATUS,
  ensureRemediationTables,
  sanitizeRemediationPlan,
  matchForbiddenRemediationPath,
  buildSignature,
  runRemediationAudit,
  runRemediationScan,
  refreshRemediationSynthesis,
  computeHealthScore,
  checkRemediationPlanTriggers,
  computeDigestFrequency,
  REMEDIATION_AUDIT_WINDOW_HOURS,
  dispatchTwiceDailyDigests,
  selectPlanTriggerClusters,
  sendRemediationDigest,
  getDigestFrequency,
  maybeSendUrgentRemediationAlert,
  verifyProposalGate,
  markProposalExecuting,
  consumeProposalNonce
} from './src/workers/remediation.js';
import { handleAdminRemediationDecision } from './src/services/superadmin.js';
import { dispatchRepositoryEvent, isRemediationAutonomyEnabled } from './src/services/githubDispatch.js';

/**
 * Saka Fleet — Autonomous Remediation Pipeline tests (v1.11.2).
 *
 * Covers: schema creation, audit-run persistence/idempotency, the plan
 * sanitizer guardrails, the approval state machine and the execution nonce
 * gate (status/replay/expiry). All rows created here are removed afterwards
 * per the permanent cleanup rule (`.clinerules` rule 10).
 *
 * Run: node scripts/run_tests.js test_remediation_pipeline.js
 */

const TEST_RUN_DATE = '2000-01-03'; // far-past Nairobi date owned by this suite
const PROPOSAL_CODES = ['FIX-TEST-0001', 'FIX-TEST-0002', 'FIX-TEST-0003', 'FIX-TEST-0004'];
const TEST_STARTED_AT = new Date().toISOString();

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`✅ ${message}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const safePlan = {
  title: 'Clarify stalled quiz recovery copy',
  category: 'friction_pattern',
  root_cause: 'Stall nudges omit the pending question.',
  risk_level: 'low',
  evidence: ['CONVERSATION_STALL'],
  changes: [{ file: 'src/workers/sentinel.js', function: 'monitorActiveConversations', change: 'Include the pending question.', rationale: 'Reduce repeats.' }],
  tests: ['test_sentinel_recovery.js'],
  rollback: 'git revert'
};

const testProposal = (code, overrides = {}) => ({
  proposal_code: code,
  title: 'Test proposal',
  category: 'error_cluster',
  root_cause: 'Test root cause',
  evidence: [{ signature: 'test-signature' }],
  proposed_changes: { overview: 'Test overview', changes: safePlan.changes, tests: safePlan.tests },
  risk_level: 'low',
  status: REMEDIATION_STATUS.PENDING_APPROVAL,
  ...overrides
});

async function cleanup(supabaseClient) {
  try {
    await supabaseClient.from('remediation_proposals').delete().in('proposal_code', PROPOSAL_CODES);
    await supabaseClient.from('sentinel_audit_runs').delete().eq('run_date', TEST_RUN_DATE);
    await supabaseClient
      .from('admin_audit_logs')
      .delete()
      .eq('admin_phone', 'SENTINEL')
      .like('action', 'REMEDIATION_%')
      .gte('created_at', TEST_STARTED_AT);
  } catch (err) {
    console.warn('[test_remediation_pipeline] cleanup warning:', err.message);
  }
}

async function run() {
  console.log('=== AUTONOMOUS REMEDIATION PIPELINE TESTS ===\n');

  console.log('--- Test 1: schema provisioning ---');
  const tableStatus = await ensureRemediationTables(supabase);
  check(['exists', 'created'].includes(tableStatus.sentinel_audit_runs), 'sentinel_audit_runs table is available');
  check(['exists', 'created'].includes(tableStatus.remediation_proposals), 'remediation_proposals table is available');

  console.log('\n--- Test 2: plan sanitizer guardrails ---');
  check(sanitizeRemediationPlan(safePlan).ok, 'Safe scoped plan passes the sanitizer');
  check(!sanitizeRemediationPlan({ ...safePlan, changes: [{ file: '.env', change: 'rotate keys' }] }).ok, 'Forbidden .env target is rejected');
  check(!sanitizeRemediationPlan({ ...safePlan, changes: [{ file: '.github/workflows/remediation.yml', change: 'disable gate' }] }).ok, 'Forbidden CI workflow target is rejected');
  check(!sanitizeRemediationPlan({ ...safePlan, changes: [{ file: 'scripts/run_vin_immutability_migration.js', change: 'drop trigger' }] }).ok, 'VIN immutability migration is rejected');
  check(!sanitizeRemediationPlan({ ...safePlan, tests: [] }).ok, 'Plan without targeted tests is rejected');
  check(!sanitizeRemediationPlan({ ...safePlan, root_cause: 'drop table reminders' }).ok, 'Destructive keyword is rejected');
  check(!sanitizeRemediationPlan({ ...safePlan, changes: [] }).ok, 'Empty change list is rejected');

  // v1.17.0 — model-update work orders carry their own scope gate.
  const modelPlan = {
    category: 'ai_model_update',
    model_id: 'deepseek-chat-test-1017',
    traffic_split: 25,
    rollback: 'admin model rollback tier_2',
    changes: [{ file: 'src/services/aiModelRegistry.js', change: 'activate benchmarked model' }],
    tests: ['test_model_scout.js', 'test_model_router.js', 'test_agent_training.js']
  };
  check(sanitizeRemediationPlan(modelPlan).ok, 'Valid model-update plan passes the sanitizer');
  check(!sanitizeRemediationPlan({ ...modelPlan, rollback: '' }).ok, 'Model-update plan without rollback is rejected');
  check(!sanitizeRemediationPlan({ ...modelPlan, traffic_split: 90 }).ok, 'Model-update canary above the ceiling is rejected');
  check(!sanitizeRemediationPlan({ ...modelPlan, changes: [{ file: 'src/services/transfers.js', change: 'x' }] }).ok, 'Model-update plan touching transfers is rejected');
  check(!sanitizeRemediationPlan({ ...modelPlan, tests: ['test_model_scout.js'] }).ok, 'Model-update plan must run all model suites');
  check(matchForbiddenRemediationPath('.github/workflows/remediation.yml') === '.github/', 'Forbidden-path helper matches CI workflows');
  check(matchForbiddenRemediationPath('src/services/paystack.js') === 'src/services/paystack.js', 'Forbidden-path helper matches payment services');
  check(matchForbiddenRemediationPath('src/workers/sentinel.js') === null, 'Forbidden-path helper allows normal source files');

  console.log('\n--- Test 3: log signature normalization ---');
  const signatureA = buildSignature('Error 500 at 2026-10-30 id 9f8b1c2d-1111-2222-3333-444455556666 route /webhook');
  const signatureB = buildSignature('Error 502 at 2026-10-31 id 0a1b2c3d-9999-8888-7777-666655554444 route /webhook');
  check(signatureA === signatureB, 'UUIDs/numbers normalize to the same signature');
  check(buildSignature('') === 'unspecified', 'Empty input yields a stable placeholder signature');

  console.log('\n--- Test 4: rolling audit run persistence & idempotency ---');
  const auditNow = new Date('2000-01-03T00:30:00.000Z');
  const auditOne = await runRemediationAudit(supabase, { now: auditNow });
  check(auditOne.status === 'success', 'Audit run completes');
  check(auditOne.run_date === TEST_RUN_DATE, 'Audit run uses the Nairobi calendar date');
  check(Boolean(auditOne.audit_run_id), 'Audit run is persisted with an id');
  const auditTwo = await runRemediationAudit(supabase, { now: auditNow });
  check(auditTwo.audit_run_id === auditOne.audit_run_id, 'Re-running the audit upserts the same daily row (idempotent)');

  console.log('\n--- Test 5: execution gate (status + nonce) ---');
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  await supabase.from('remediation_proposals').insert([
    testProposal(PROPOSAL_CODES[0], { audit_run_id: auditOne.audit_run_id }),
    testProposal(PROPOSAL_CODES[1], { status: REMEDIATION_STATUS.APPROVED, approval_nonce: 'nonce-active', nonce_expires_at: future, attempts: 1 }),
    testProposal(PROPOSAL_CODES[2], { status: REMEDIATION_STATUS.APPROVED, approval_nonce: 'nonce-expired', nonce_expires_at: past, attempts: 1 }),
    testProposal(PROPOSAL_CODES[3])
  ]);

  const pendingGate = await verifyProposalGate(supabase, PROPOSAL_CODES[0], 'anything');
  check(!pendingGate.ok, 'PENDING_APPROVAL proposals cannot execute');

  const validGate = await verifyProposalGate(supabase, PROPOSAL_CODES[1], 'nonce-active');
  check(validGate.ok, 'APPROVED + fresh matching nonce passes the gate');

  const wrongNonce = await verifyProposalGate(supabase, PROPOSAL_CODES[1], 'nonce-wrong');
  check(!wrongNonce.ok, 'Wrong nonce is rejected');

  const expiredGate = await verifyProposalGate(supabase, PROPOSAL_CODES[2], 'nonce-expired');
  check(!expiredGate.ok, 'Expired nonce is rejected');

  const executing = await markProposalExecuting(supabase, validGate.proposal);
  check(executing.ok && executing.proposal.status === REMEDIATION_STATUS.EXECUTING, 'Gate marks the proposal EXECUTING');
  const replayGate = await verifyProposalGate(supabase, PROPOSAL_CODES[1], 'nonce-active');
  check(!replayGate.ok, 'A non-APPROVED (already executing) proposal cannot be re-gated');

  await supabase.from('remediation_proposals')
    .update({ status: REMEDIATION_STATUS.APPROVED, approval_nonce: 'nonce-consumable', nonce_expires_at: future })
    .eq('proposal_code', PROPOSAL_CODES[1]);
  const consumable = await verifyProposalGate(supabase, PROPOSAL_CODES[1], 'nonce-consumable');
  check(consumable.ok, 'Re-approved proposal passes the gate again');
  await consumeProposalNonce(supabase, consumable.proposal.id);
  const afterConsume = await verifyProposalGate(supabase, PROPOSAL_CODES[1], 'nonce-consumable');
  check(!afterConsume.ok, 'Consumed nonce cannot be replayed (single-use)');

  console.log('\n--- Test 6: Superadmin approval state machine ---');
  const originalAutonomy = process.env.REMEDIATION_AUTONOMY;
  const originalGhToken = process.env.GH_REMEDIATION_TOKEN;
  const originalGhRepo = process.env.GH_REMEDIATION_REPO;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  process.env.REMEDIATION_AUTONOMY = 'on';
  delete process.env.GH_REMEDIATION_TOKEN;
  delete process.env.GH_REMEDIATION_REPO;
  delete process.env.GITHUB_TOKEN;
  try {
    const accepted = await handleAdminRemediationDecision(supabase, PROPOSAL_CODES[3], 'accept');
    check(String(accepted.reply).includes('Approved'), 'ACCEPT returns an approval confirmation');
    const { data: acceptedRow } = await supabase.from('remediation_proposals').select('*').eq('proposal_code', PROPOSAL_CODES[3]).maybeSingle();
    check(acceptedRow.status === REMEDIATION_STATUS.APPROVED, 'ACCEPT moves the proposal to APPROVED');
    check(Boolean(acceptedRow.approval_nonce), 'ACCEPT mints an approval nonce');
    check(Boolean(acceptedRow.nonce_expires_at), 'ACCEPT sets the nonce expiry window');

    const declined = await handleAdminRemediationDecision(supabase, PROPOSAL_CODES[3], 'decline');
    check(String(declined.reply).includes('Declined'), 'DECLINE returns a decline confirmation');
    const { data: declinedRow } = await supabase.from('remediation_proposals').select('status').eq('proposal_code', PROPOSAL_CODES[3]).maybeSingle();
    check(declinedRow.status === REMEDIATION_STATUS.DECLINED, 'DECLINE moves the proposal to DECLINED');

    const modified = await handleAdminRemediationDecision(supabase, PROPOSAL_CODES[3], 'modify', 'Keep the fix inside src/workers/sentinel.js only');
    check(String(modified.reply).includes('Modification requested'), 'MODIFY returns a re-plan confirmation');
    const { data: modifiedRow } = await supabase.from('remediation_proposals').select('status,feedback').eq('proposal_code', PROPOSAL_CODES[3]).maybeSingle();
    check(modifiedRow.status === REMEDIATION_STATUS.NEEDS_MODIFICATION, 'MODIFY moves the proposal to NEEDS_MODIFICATION');
    check(String(modifiedRow.feedback).includes('sentinel.js'), 'MODIFY stores the superadmin guidance verbatim');
  } finally {
    if (originalAutonomy === undefined) delete process.env.REMEDIATION_AUTONOMY;
    else process.env.REMEDIATION_AUTONOMY = originalAutonomy;
    if (originalGhToken === undefined) delete process.env.GH_REMEDIATION_TOKEN;
    else process.env.GH_REMEDIATION_TOKEN = originalGhToken;
    if (originalGhRepo === undefined) delete process.env.GH_REMEDIATION_REPO;
    else process.env.GH_REMEDIATION_REPO = originalGhRepo;
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
  }

  console.log('\n--- Test 7: kill switch ---');
  const originalKill = process.env.REMEDIATION_AUTONOMY;
  process.env.REMEDIATION_AUTONOMY = 'off';
  try {
    const blocked = await handleAdminRemediationDecision(supabase, PROPOSAL_CODES[3], 'accept');
    check(String(blocked.reply).includes('disabled'), 'REMEDIATION_AUTONOMY=off blocks approvals');
    const triggerSkip = await checkRemediationPlanTriggers(supabase, { now: auditNow });
    check(triggerSkip.status === 'skipped', 'REMEDIATION_AUTONOMY=off skips plan dispatch');
    const dispatchSkip = await dispatchRepositoryEvent('remediation_execute', { proposal_code: PROPOSAL_CODES[3], approval_nonce: 'test' });
    check(dispatchSkip.skipped === true && dispatchSkip.ok === false, 'REMEDIATION_AUTONOMY=off short-circuits repository_dispatch');
    process.env.REMEDIATION_AUTONOMY = 'true';
    check(isRemediationAutonomyEnabled() === true, 'Autonomy gate treats true as enabled');
    process.env.REMEDIATION_AUTONOMY = '1';
    check(isRemediationAutonomyEnabled() === true, 'Autonomy gate treats 1 as enabled');
    process.env.REMEDIATION_AUTONOMY = 'off';
  } finally {
    if (originalKill === undefined) delete process.env.REMEDIATION_AUTONOMY;
    else process.env.REMEDIATION_AUTONOMY = originalKill;
  }

  console.log('\n--- Test 8: continuous scan idempotency & health score ---');
  const scanOne = await runRemediationScan(supabase, { now: auditNow });
  const scanTwo = await runRemediationScan(supabase, { now: auditNow });
  check(scanOne.status === 'success' && scanTwo.status === 'success', 'Continuous scan ticks complete');
  check(scanOne.audit_run_id === auditTwo.audit_run_id, 'Scan ticks update the same daily audit row');
  check(scanTwo.scan_count === scanOne.scan_count + 1, 'Every tick increments scan_count');
  check(scanOne.changed === false, 'An unchanged window is detected without rewriting the summary');
  check(Number.isFinite(scanOne.health_score), 'Health score is persisted on every scan');
  check(scanOne.counts.windowHours === REMEDIATION_AUDIT_WINDOW_HOURS, 'Scan window honours REMEDIATION_AUDIT_WINDOW_HOURS');
  check(computeHealthScore({ errors: 10, friction: 20, stalls: 4 }) === 54, 'Health score formula is deterministic (54 for 10/20/4)');
  check(computeHealthScore({ errors: 500, friction: 0, stalls: 0 }) === 0, 'Health score clamps at 0');
  const synthesis = await refreshRemediationSynthesis(supabase, { now: auditNow, force: true });
  check(['success', 'skipped'].includes(synthesis.status), 'Throttled AI synthesis runs without throwing');

  console.log('\n--- Test 9: threshold-driven plan triggers ---');
  const triggerClusters = selectPlanTriggerClusters([
    { signature: 'quiet', severity: 'low', count: 1 },
    { signature: 'repeating', severity: 'low', count: 3 },
    { signature: 'critical', severity: 'high', count: 1 }
  ]);
  check(
    triggerClusters.map((cluster) => cluster.signature).join(',') === 'repeating,critical',
    'Plan triggers select high severity OR count >= threshold'
  );
  const strictTriggers = selectPlanTriggerClusters(
    [{ signature: 'repeating', severity: 'low', count: 3 }, { signature: 'critical', severity: 'high', count: 1 }],
    { triggerCount: 5 }
  );
  check(strictTriggers.length === 1 && strictTriggers[0].signature === 'critical', 'Custom trigger threshold is honoured');

  console.log('\n--- Test 10: adaptive digest frequency ---');
  const thresholds = { dailyThreshold: 10, weeklyThreshold: 3 };
  check(computeDigestFrequency(50, 'twice_daily', thresholds) === 'twice_daily', 'High activity keeps twice-daily digests');
  check(computeDigestFrequency(5, 'twice_daily', thresholds) === 'daily', 'Improvement steps twice_daily → daily');
  check(computeDigestFrequency(2, 'daily', thresholds) === 'weekly', 'Improvement steps daily → weekly');
  check(computeDigestFrequency(2, 'weekly', thresholds) === 'weekly', 'Weekly is the floor (never disables)');
  check(computeDigestFrequency(50, 'weekly', thresholds) === 'twice_daily', 'Regression escalates immediately to twice_daily');
  check(computeDigestFrequency(50, 'daily', thresholds) === 'twice_daily', 'Regression escalates daily → twice_daily');
  check(['twice_daily', 'daily', 'weekly'].includes(await getDigestFrequency(supabase)), 'Persisted digest frequency is always valid');

  console.log('\n--- Test 11: twice-daily digest batching ---');
  check(Number.isInteger(REMEDIATION_AUDIT_WINDOW_HOURS) && REMEDIATION_AUDIT_WINDOW_HOURS >= 1, `Audit window knob is a positive integer (${REMEDIATION_AUDIT_WINDOW_HOURS}h)`);
  check(dispatchTwiceDailyDigests === sendRemediationDigest, 'dispatchTwiceDailyDigests is a naming-parity alias of sendRemediationDigest');
  const digestOne = await sendRemediationDigest(supabase, { now: auditNow, force: true, dryRun: true });
  check(digestOne.status === 'success', 'Digest dispatch completes');
  check(digestOne.proposals >= 1, 'Digest aggregates pending proposals');
  check(['twice_daily', 'daily', 'weekly'].includes(digestOne.frequency), 'Digest reports the adaptive frequency');
  check(Number.isFinite(digestOne.health.health_score), 'Digest includes the health snapshot');
  check(digestOne.health.window_hours === REMEDIATION_AUDIT_WINDOW_HOURS, 'Digest health snapshot reports the rolling window hours');
  const digestTwo = await sendRemediationDigest(supabase, { now: auditNow, force: true, dryRun: true });
  check(digestTwo.proposals === 0, 'Already-digested proposals are not re-sent');
  const urgent = await maybeSendUrgentRemediationAlert(supabase, { now: auditNow, dryRun: true });
  check(['skipped', 'success'].includes(urgent.status), 'Urgent escalation evaluates cleanly');
  const storedAutonomy = process.env.REMEDIATION_AUTONOMY;
  process.env.REMEDIATION_AUTONOMY = 'off';
  try {
    const digestOff = await sendRemediationDigest(supabase, { now: auditNow, force: true, dryRun: true });
    check(digestOff.status === 'success', 'Digests stay notification-only when autonomy is off');
  } finally {
    if (storedAutonomy === undefined) delete process.env.REMEDIATION_AUTONOMY;
    else process.env.REMEDIATION_AUTONOMY = storedAutonomy;
  }

  console.log(`\n🎉 ALL ${passed} REMEDIATION PIPELINE ASSERTIONS PASSED`);
}

await runWithCleanup({
  testFn: async () => {
    try {
      await run();
    } finally {
      await cleanup(supabase);
    }
  },
  phones: [],
  vins: [],
  supabase
});

