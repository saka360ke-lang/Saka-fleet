import 'dotenv/config';
import assert from 'assert';
import { createClient } from '@supabase/supabase-js';
import { runWithCleanup } from './scripts/testCleanup.js';
import {
  REMEDIATION_STATUS,
  ensureRemediationTables,
  sanitizeRemediationPlan,
  buildSignature,
  runRemediationAudit,
  verifyProposalGate,
  markProposalExecuting,
  consumeProposalNonce
} from './src/workers/remediation.js';
import { handleAdminRemediationDecision } from './src/services/superadmin.js';

/**
 * Saka Fleet — Autonomous Remediation Pipeline tests (v1.10.0).
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
    await supabaseClient.from('admin_audit_logs').delete().eq('admin_phone', 'SENTINEL').like('action', 'REMEDIATION_%');
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

  console.log('\n--- Test 3: log signature normalization ---');
  const signatureA = buildSignature('Error 500 at 2026-10-30 id 9f8b1c2d-1111-2222-3333-444455556666 route /webhook');
  const signatureB = buildSignature('Error 502 at 2026-10-31 id 0a1b2c3d-9999-8888-7777-666655554444 route /webhook');
  check(signatureA === signatureB, 'UUIDs/numbers normalize to the same signature');
  check(buildSignature('') === 'unspecified', 'Empty input yields a stable placeholder signature');

  console.log('\n--- Test 4: 02:00 audit run persistence & idempotency ---');
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
  process.env.REMEDIATION_AUTONOMY = 'on';
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
  }

  console.log('\n--- Test 7: kill switch ---');
  const originalKill = process.env.REMEDIATION_AUTONOMY;
  process.env.REMEDIATION_AUTONOMY = 'off';
  try {
    const blocked = await handleAdminRemediationDecision(supabase, PROPOSAL_CODES[3], 'accept');
    check(String(blocked.reply).includes('disabled'), 'REMEDIATION_AUTONOMY=off blocks approvals');
  } finally {
    if (originalKill === undefined) delete process.env.REMEDIATION_AUTONOMY;
    else process.env.REMEDIATION_AUTONOMY = originalKill;
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

