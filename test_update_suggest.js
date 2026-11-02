/**
 * test_update_suggest.js — UPDATE-SUGGEST> command (v1.48.0, Model A).
 *
 * Stateless: command parsing, non-superadmin gating, delivery-receipt webhook.
 * Stateful (cleaned up in finally): capture creates a PENDING_APPROVAL SUG- row,
 * the execution gate accepts a free-text suggestion and blocks a destructive one.
 */
import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import {
  parseSuperadminCommand,
  handleSuperadminFlow,
  captureUpdateSuggestion,
  handleAdminRemediationStatus,
  handleAdminRemediationsList,
  handleAdminRemediationDecision
} from './src/services/superadmin.js';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  verifyProposalGate,
  buildApprovalWindow,
  REMEDIATION_STATUS
} from './src/workers/remediation.js';
import { handleWhatsAppWebhook } from './src/routes/whatsapp.js';

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { pass += 1; console.log(`✅ ${label}`); }
  else { fail += 1; console.error(`❌ ${label}`); }
};

// ---- 1. Command parsing (stateless) ----
const parsed = await parseSuperadminCommand('UPDATE-SUGGEST> Sign up should be primarily from website');
check(parsed.intent === 'ADMIN_UPDATE_SUGGEST', 'parse: UPDATE-SUGGEST> resolves to ADMIN_UPDATE_SUGGEST');
check(parsed.suggestion === 'Sign up should be primarily from website', 'parse: suggestion text extracted verbatim');

const parsedLower = await parseSuperadminCommand('update-suggest> lowercase form works');
check(parsedLower.intent === 'ADMIN_UPDATE_SUGGEST' && parsedLower.suggestion === 'lowercase form works', 'parse: command is case-insensitive');

const parsedEmpty = await parseSuperadminCommand('UPDATE-SUGGEST>');
check(parsedEmpty.intent === 'ADMIN_UPDATE_SUGGEST' && parsedEmpty.suggestion === '', 'parse: empty suggestion is recognized (usage-hint path)');

const parsedAdmin = await parseSuperadminCommand('admin remediations');
check(parsedAdmin.intent === 'ADMIN_REMEDIATIONS', 'parse: existing admin commands still route correctly');

const parsedFixStatus = await parseSuperadminCommand('Status of FIX-2026-10-30-01');
check(parsedFixStatus.intent === 'ADMIN_REMEDIATION_STATUS' && parsedFixStatus.proposal_code === 'FIX-2026-10-30-01', 'parse: "Status of FIX-<code>" resolves to a single-proposal status lookup');
const parsedFixStatusAdmin = await parseSuperadminCommand('admin FIX-2026-10-30-01');
check(parsedFixStatusAdmin.intent === 'ADMIN_REMEDIATION_STATUS', 'parse: "admin FIX-<code>" resolves too');
const parsedBareCode = await parseSuperadminCommand('FIX-2026-10-30-01');
check(parsedBareCode.intent === 'ADMIN_REMEDIATION_STATUS', 'parse: a bare FIX- code resolves to a status lookup');
const parsedRemPending = await parseSuperadminCommand('admin remediations pending');
check(parsedRemPending.intent === 'ADMIN_REMEDIATIONS' && parsedRemPending.filter === 'pending', 'parse: "admin remediations pending" resolves to the pending filter');
const parsedRemDeployed = await parseSuperadminCommand('admin remediations deployed');
check(parsedRemDeployed.intent === 'ADMIN_REMEDIATIONS' && parsedRemDeployed.filter === 'deployed', 'parse: "admin remediations deployed" resolves to the deployed filter');
const parsedRemAll = await parseSuperadminCommand('admin remediations');
check(parsedRemAll.intent === 'ADMIN_REMEDIATIONS' && parsedRemAll.filter === 'all', 'parse: "admin remediations" defaults to the all filter');

const parsedBacklog = await parseSuperadminCommand('admin backlog');
check(parsedBacklog.intent === 'ADMIN_BACKLOG' && parsedBacklog.filter === 'all', 'parse: "admin backlog" resolves to the unified backlog');
const parsedBacklogPending = await parseSuperadminCommand('admin backlog pending');
check(parsedBacklogPending.intent === 'ADMIN_BACKLOG' && parsedBacklogPending.filter === 'pending', 'parse: "admin backlog pending" filters to pending');
const parsedBacklogDeployed = await parseSuperadminCommand('admin backlog deployed');
check(parsedBacklogDeployed.intent === 'ADMIN_BACKLOG' && parsedBacklogDeployed.filter === 'deployed', 'parse: "admin backlog deployed" filters to deployed');

// ---- 2. Non-superadmin gating (stateless) ----
const nonAdmin = await handleSuperadminFlow(null, '+254700000000', 'UPDATE-SUGGEST> sneaky change');
check(nonAdmin.isSuperadmin === false, 'gate: non-superadmin is rejected before capture');

// ---- 2b. Fix-status lookup (stateless, in-memory double) ----
{
  const makeStatusMock = (row) => ({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); }
      };
    }
  });
  const found = await handleAdminRemediationStatus(
    makeStatusMock({ proposal_code: 'FIX-2026-10-30-01', title: 'Stop the OTP loop', status: 'DEPLOYED', risk_level: 'low' }),
    'fix-2026-10-30-01'
  );
  check(/Remediation status/.test(found.reply) && /DEPLOYED/.test(found.reply) && /FIX-2026-10-30-01/.test(found.reply), 'status: single-proposal lookup returns the status and title');
  const missing = await handleAdminRemediationStatus(makeStatusMock(null), 'FIX-0000-00-00-00');
  check(/No remediation proposal matches/.test(missing.reply), 'status: an unknown code returns a not-found hint');

  const remListMock = (rows) => ({
    from() {
      return {
        select() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: rows, error: null }); }
      };
    }
  });
  const grouped = await handleAdminRemediationsList(remListMock([
    { proposal_code: 'FIX-2026-10-30-01', title: 'Stop the OTP loop', status: 'DEPLOYED', risk_level: 'low' },
    { proposal_code: 'FIX-2026-11-01-01', title: 'Something pending', status: 'PENDING_APPROVAL', risk_level: 'medium' }
  ]), 'all');
  check(/Pending/.test(grouped.reply) && /Deployed/.test(grouped.reply), 'remediations: the grouped list shows pending and deployed sections');
  const onlyPending = await handleAdminRemediationsList(remListMock([
    { proposal_code: 'FIX-2026-10-30-01', title: 'Stop the OTP loop', status: 'DEPLOYED', risk_level: 'low' },
    { proposal_code: 'FIX-2026-11-01-01', title: 'Something pending', status: 'PENDING_APPROVAL', risk_level: 'medium' }
  ]), 'pending');
  check(/Pending/.test(onlyPending.reply) && !/Deployed/.test(onlyPending.reply), 'remediations: the pending filter hides the deployed section');
}

// ---- 2c. FEAT-* codes are review-only, not fixes (stateless) ----
{
  const featMock = createMockSupabase({
    remediation_proposals: [],
    weekly_feature_proposals: [{ proposal_code: 'FEAT-2026-W43-01', title: 'Smart Document Intelligence', status: 'pending', impact_score: 9 }]
  });
  const featAccept = await handleAdminRemediationDecision(featMock.client, 'FEAT-2026-W43-01', 'accept');
  check(/review-only/.test(featAccept.reply) && /feature blueprint/.test(featAccept.reply) && !/Unknown proposal/.test(featAccept.reply), 'decision: accepting a FEAT-* code explains it is a review-only blueprint');

  const featStatus = await handleAdminRemediationStatus(featMock.client, 'FEAT-2026-W43-01');
  check(/review-only/.test(featStatus.reply) && !/No remediation proposal matches/.test(featStatus.reply), 'status: a FEAT-* code returns the review-only hint, not the not-found hint');

  const unknownDecision = await handleAdminRemediationDecision(featMock.client, 'FIX-0000-00-00-00', 'accept');
  check(/Unknown proposal/.test(unknownDecision.reply), 'decision: a genuinely unknown non-FEAT code still says Unknown proposal');
}

// ---- 3. Delivery-receipt webhook (stateless) ----
{
  const savedSecret = process.env.META_APP_SECRET;
  delete process.env.META_APP_SECRET;
  const captured = [];
  const fakeReply = {
    status() { return this; },
    send(payload) { captured.push(payload); return payload; }
  };
  await handleWhatsAppWebhook({
    body: {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550000000', phone_number_id: '123456' },
            statuses: [{ id: 'wamid.status1', status: 'delivered', timestamp: '1700000000', recipient_id: '254720641985' }]
          }
        }]
      }]
    },
    headers: {}
  }, fakeReply, { log: { info() {}, warn() {}, error() {} } });
  check(captured[0]?.status_ack === 'message_status_recorded', 'status webhook: delivery receipt is acknowledged');
  if (savedSecret !== undefined) process.env.META_APP_SECRET = savedSecret;
}

// ---- 4. Capture + gate (DB, cleaned up in finally) ----
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const createdCodes = [];
try {
  const capture = await captureUpdateSuggestion(supabase, '+254700000000', 'Redirect chat signups to the website');
  check(capture.ok === true && /^SUG-\d{4}-\d{2}-\d{2}-\d{2}$/.test(String(capture.code || '')), `capture: creates a SUG- code (${capture.code})`);
  check(String(capture.reply).includes('admin accept fix'), 'capture: reply includes the approval next-step');
  if (capture.code) createdCodes.push(capture.code);

  const emptyCapture = await captureUpdateSuggestion(supabase, '+254700000000', '   ');
  check(emptyCapture.ok === false && /Usage/i.test(emptyCapture.reply), 'capture: empty suggestion returns a usage hint');

  if (capture.code) {
    const { data: row } = await supabase.from('remediation_proposals').select('*').eq('proposal_code', capture.code).maybeSingle();
    check(row?.status === REMEDIATION_STATUS.PENDING_APPROVAL, 'capture: row lands as PENDING_APPROVAL');
    check(row?.category === 'update_suggest', 'capture: row category is update_suggest');
    check(Array.isArray(row?.proposed_changes?.tests) && row.proposed_changes.tests.includes('test_agent_training.js'), 'capture: default stateless suite declared');

    // Simulate `admin accept fix` then verify the gate's suggestion path.
    const window = buildApprovalWindow();
    await supabase.from('remediation_proposals').update({
      status: REMEDIATION_STATUS.APPROVED,
      approval_nonce: window.approval_nonce,
      nonce_expires_at: window.nonce_expires_at,
      attempts: 0
    }).eq('proposal_code', capture.code);
    const gateOk = await verifyProposalGate(supabase, capture.code, window.approval_nonce);
    check(gateOk.ok === true && gateOk.sanitizer === 'suggestion', 'gate: free-text suggestion passes the suggestion gate path');

    // A suggestion carrying a destructive keyword must be blocked at the gate.
    const blockedCapture = await captureUpdateSuggestion(supabase, '+254700000000', 'drop table reminders to clean up');
    if (blockedCapture.code) {
      createdCodes.push(blockedCapture.code);
      const win2 = buildApprovalWindow();
      await supabase.from('remediation_proposals').update({
        status: REMEDIATION_STATUS.APPROVED,
        approval_nonce: win2.approval_nonce,
        nonce_expires_at: win2.nonce_expires_at,
        attempts: 0
      }).eq('proposal_code', blockedCapture.code);
      const blockedGate = await verifyProposalGate(supabase, blockedCapture.code, win2.approval_nonce);
      check(blockedGate.ok === false && /blocked/i.test(blockedGate.error || ''), 'gate: suggestion with a destructive keyword is blocked');
    }
  }
} finally {
  for (const code of createdCodes) {
    await supabase.from('remediation_proposals').delete().eq('proposal_code', code);
  }
}

console.log(`\n${pass}/${pass + fail} update-suggest assertions passed.`);
if (fail > 0) process.exit(1);

