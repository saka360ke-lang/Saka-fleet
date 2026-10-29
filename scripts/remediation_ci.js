import 'dotenv/config';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { formatNairobiDate } from '../src/services/dateParser.js';
import {
  REMEDIATION_STATUS,
  REMEDIATION_MAX_ATTEMPTS,
  REMEDIATION_FORBIDDEN_PATHS,
  ensureRemediationTables,
  loadAuditRun,
  sanitizeRemediationPlan,
  matchForbiddenRemediationPath,
  verifyProposalGate,
  markProposalExecuting,
  reportRemediationResult,
  logRemediationAudit
} from '../src/workers/remediation.js';

/**
 * Saka Fleet — Remediation CI runner (v1.10.0)
 * --------------------------------------------
 * Executed inside .github/workflows/remediation.yml only. Subcommands:
 *
 *   fetch-audit <auditRunId|run_date> [modifyFeedback] [clusterSignature]
 *   submit-plan <auditRunId> <planFile> [clusterSignature]
 *   tests <proposalCode>
 *   gate <proposalCode> <approvalNonce>
 *   guard <proposalCode>
 *   fetch <proposalCode>
 *   report <proposalCode> <commitSha>
 *   fail <proposalCode> <message>
 *
 * This script never edits source code and never pushes. Cline does the edits;
 * the workflow performs the commit/push only after both test passes are green.
 */

const WORK_ORDER_DIR = process.env.REMEDIATION_WORK_ORDER_DIR || path.join('remediation', 'work-orders');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing in CI environment');
  return createClient(url, key);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function changesOf(proposal) {
  const stored = proposal?.proposed_changes;
  if (Array.isArray(stored)) return stored;
  if (stored && Array.isArray(stored.changes)) return stored.changes;
  return [];
}

async function getProposal(supabase, proposalCode) {
  const { data, error } = await supabase
    .from('remediation_proposals')
    .select('*')
    .eq('proposal_code', proposalCode)
    .maybeSingle();
  if (error) throw new Error(`Proposal lookup failed: ${error.message}`);
  if (!data) throw new Error(`Unknown proposal: ${proposalCode}`);
  return data;
}

async function fetchAudit(supabase, [auditKey, modifyFeedback, clusterSignature]) {
  const audit = await loadAuditRun(supabase, auditKey);
  if (!audit) throw new Error(`Audit run not found: ${auditKey}`);

  const allClusters = Array.isArray(audit.clusters)
    ? audit.clusters
    : (Array.isArray(audit.summary?.clusters) ? audit.summary.clusters : []);
  const focusedClusters = clusterSignature
    ? allClusters.filter((cluster) => cluster.signature === clusterSignature)
    : allClusters;

  const context = {
    audit_run_id: audit.id,
    run_date: audit.run_date,
    window_start: audit.window_start,
    window_end: audit.window_end,
    counts: {
      errors: audit.error_count,
      friction: audit.friction_count,
      stalls: audit.stall_count
    },
    health_score: audit.health_score ?? null,
    cluster_signature: clusterSignature || null,
    clusters: focusedClusters,
    summary: audit.summary,
    modify_feedback: modifyFeedback || null,
    plan_schema: {
      title: 'short imperative title',
      category: 'error_cluster | friction_pattern | conversation_anomaly',
      root_cause: 'one paragraph grounded in the evidence',
      risk_level: 'low | medium | high',
      evidence: ['cluster signatures or ids'],
      changes: [{ file: 'repo/relative/path.js', function: 'function name', change: 'precise description', rationale: 'why' }],
      tests: ['test_some_suite.js'],
      rollback: 'how to revert safely'
    },
    forbidden_paths: [...REMEDIATION_FORBIDDEN_PATHS],
    constraints: [
      'At most 12 changes.',
      'Repository-relative paths only — never .env, .github/, supabase/, .clinerules, payment/transfer/OTP code, or the remediation pipeline itself.',
      'At least one existing root-level test_*.js suite.',
      'Descriptive plan only: no SQL, no schema edits, no destructive operations.',
      'Never weaken VIN immutability, OTP verification, driver 1-to-1 rules or subscription/payment math.'
    ]
  };

  console.log(JSON.stringify(context, null, 2));
}

async function nextProposalCode(supabase) {
  const prefix = `FIX-${formatNairobiDate()}-`;
  const { data } = await supabase
    .from('remediation_proposals')
    .select('proposal_code')
    .like('proposal_code', `${prefix}%`);
  const numbers = (data || [])
    .map((row) => Number(String(row.proposal_code || '').replace(prefix, '')))
    .filter((value) => Number.isFinite(value));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `${prefix}${String(next).padStart(2, '0')}`;
}

async function submitPlan(supabase, [auditKey, planFile, clusterSignature]) {
  if (!planFile || !fs.existsSync(planFile)) {
    throw new Error(`Plan file not found: ${planFile}`);
  }

  const audit = await loadAuditRun(supabase, auditKey);
  if (!audit) throw new Error(`Audit run not found: ${auditKey}`);

  const raw = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const plan = {
    title: raw.title || 'Untitled remediation plan',
    category: raw.category || 'error_cluster',
    root_cause: raw.root_cause || '',
    risk_level: ['low', 'medium', 'high'].includes(String(raw.risk_level)) ? raw.risk_level : 'low',
    evidence: Array.isArray(raw.evidence) ? raw.evidence : (audit.summary?.clusters || []),
    changes: Array.isArray(raw.changes)
      ? raw.changes
      : (Array.isArray(raw.proposed_changes) ? raw.proposed_changes : []),
    tests: Array.isArray(raw.tests) ? raw.tests : [],
    rollback: raw.rollback || ''
  };

  const verdict = sanitizeRemediationPlan(plan);
  const status = verdict.ok ? REMEDIATION_STATUS.PENDING_APPROVAL : REMEDIATION_STATUS.NEEDS_MODIFICATION;

  let proposalCode = await nextProposalCode(supabase);
  let inserted = null;
  let lastError = null;

  for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
    const { data, error } = await supabase
      .from('remediation_proposals')
      .insert([{
        proposal_code: proposalCode,
        audit_run_id: audit.id,
        target_signature: clusterSignature || null,
        title: plan.title,
        category: plan.category,
        root_cause: plan.root_cause,
        evidence: plan.evidence,
        proposed_changes: {
          overview: raw.overview || '',
          changes: plan.changes,
          tests: plan.tests,
          rollback: plan.rollback,
          violations: verdict.violations
        },
        risk_level: plan.risk_level,
        status,
        feedback: verdict.ok ? null : `Blocked by sanitizer: ${verdict.violations.join(' ')}`
      }])
      .select('*')
      .maybeSingle();

    if (!error) {
      inserted = data;
      break;
    }

    lastError = error;
    const prefix = `FIX-${formatNairobiDate()}-`;
    const sequence = Number(String(proposalCode).replace(prefix, '')) + 1;
    proposalCode = `${prefix}${String(sequence).padStart(2, '0')}`;
  }

  if (!inserted) throw new Error(`Failed to persist plan: ${lastError?.message || 'unknown error'}`);

  await logRemediationAudit(supabase, 'REMEDIATION_PLAN_SUBMITTED', {
    proposal_code: inserted.proposal_code,
    audit_run_id: audit.id,
    sanitized: verdict.ok,
    violations: verdict.violations
  });

  if (!verdict.ok) {
    await reportRemediationResult(supabase, inserted.proposal_code, {
      deployed: false,
      failure: `Plan rejected by the guardrail sanitizer: ${verdict.violations.join(' ')}`
    });
  }

  console.log(JSON.stringify({
    ok: verdict.ok,
    proposal_code: inserted.proposal_code,
    status: inserted.status,
    violations: verdict.violations
  }, null, 2));
}

async function printTests(supabase, [proposalCode]) {
  const proposal = await getProposal(supabase, proposalCode);
  const tests = proposal.proposed_changes?.tests || [];
  if (!tests.length) {
    console.error(`No targeted tests declared for ${proposalCode}; refusing to execute.`);
    process.exit(1);
  }
  console.log(tests.join(' '));
}

async function gate(supabase, [proposalCode, approvalNonce]) {
  const gateResult = await verifyProposalGate(supabase, proposalCode, approvalNonce);
  if (!gateResult.ok) {
    console.error(JSON.stringify({ ok: false, error: gateResult.error }, null, 2));
    process.exit(1);
  }

  const marked = await markProposalExecuting(supabase, gateResult.proposal);
  if (!marked.ok) {
    console.error(JSON.stringify({ ok: false, error: marked.error }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    proposal_code: proposalCode,
    attempt: gateResult.proposal.attempts || 0,
    max_attempts: REMEDIATION_MAX_ATTEMPTS
  }, null, 2));
}

async function fetchWorkOrder(supabase, [proposalCode]) {
  const proposal = await getProposal(supabase, proposalCode);
  const changes = changesOf(proposal);
  const tests = proposal.proposed_changes?.tests || [];

  ensureDir(WORK_ORDER_DIR);
  const filePath = path.join(WORK_ORDER_DIR, `${proposalCode}.md`);

  const changeRows = changes
    .map((change, index) => `| ${index + 1} | \`${change.file || ''}\` | ${change.function || '—'} | ${String(change.change || '').replace(/\|/g, '\\|')} | ${String(change.rationale || '').replace(/\|/g, '\\|')} |`)
    .join('\n');

  const content = `# Approved Remediation Work Order — ${proposalCode}

> Generated by scripts/remediation_ci.js after the Superadmin approval gate.
> Implement **exactly** this scope. Do not expand it.

## Mandatory reading (in this order)
1. \`.clinerules\`
2. \`SAKA_FLEET_ARCHITECTURE.md\`
3. This work order

## Proposal
- **Title:** ${proposal.title || 'Untitled'}
- **Category:** ${proposal.category || 'error_cluster'}
- **Risk level:** ${proposal.risk_level || 'low'}
- **Status:** ${proposal.status}
- **Approval attempt:** ${proposal.attempts || 0} / ${REMEDIATION_MAX_ATTEMPTS}

## Root cause
${proposal.root_cause || 'See audit evidence.'}

## Evidence
\`\`\`json
${JSON.stringify(proposal.evidence || [], null, 2).slice(0, 4000)}
\`\`\`

## Approved changes (exact scope)
| # | File | Function | Change | Rationale |
| :--- | :--- | :--- | :--- | :--- |
${changeRows || '| — | — | — | No changes listed | — |'}

## Tests that must pass (before and after)
${tests.length ? tests.map((test) => `- \`${test}\``).join('\n') : '- ⚠️ none declared — abort and report failure'}

## Rollback
${proposal.proposed_changes?.rollback || 'Revert the commit via git revert; no data migrations are involved.'}

## Forbidden paths (NEVER edit in this run)
${REMEDIATION_FORBIDDEN_PATHS.map((entry) => `- \`${entry}\``).join('\n')}

## Execution rules
- Keep the diff minimal and scoped to the approved changes.
- Run the listed targeted test suites and fix only regressions you introduced.
- NEVER push, force-push, rewrite history, or commit from this run — CI commits after post-tests pass.
- NEVER edit \`.clinerules\`, \`SAKA_FLEET_ARCHITECTURE.md\` guardrail sections, CI workflows, schema migrations, payment/transfer/OTP code or the remediation pipeline itself.
- If the approved scope is impossible or unsafe, make NO changes and exit with a clear explanation.
`;

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(filePath);
}

async function report(supabase, [proposalCode, commitSha]) {
  const result = await reportRemediationResult(supabase, proposalCode, {
    deployed: true,
    commitSha: commitSha || null
  });
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function fail(supabase, [proposalCode, ...messageParts]) {
  const message = messageParts.join(' ') || 'Remediation workflow failed.';
  const result = await reportRemediationResult(supabase, proposalCode, {
    deployed: false,
    failure: message
  });
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

/** Repository-relative paths changed in the working tree (tracked + untracked). */
function changedPaths() {
  const out = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' });
  const paths = new Set();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let rest = line.slice(3).trim();
    if (rest.includes(' -> ')) rest = rest.split(' -> ').pop().trim();
    rest = rest.replace(/^"|"$/g, '').replace(/\\/g, '/');
    if (rest) paths.add(rest);
  }
  return [...paths];
}

/** Post-edit guard: refuse to commit any change touching a forbidden path. */
async function guardWorkOrder([proposalCode]) {
  const files = changedPaths();
  const blocked = files
    .map((file) => ({ file, forbidden: matchForbiddenRemediationPath(file) }))
    .filter((entry) => entry.forbidden);

  if (blocked.length > 0) {
    console.error(JSON.stringify({
      ok: false,
      proposal_code: proposalCode || null,
      reason: 'Forbidden path modification blocked before commit.',
      blocked
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, proposal_code: proposalCode || null, changed: files.length, files }, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const supabase = getClient();
  await ensureRemediationTables(supabase);

  switch (command) {
    case 'fetch-audit':
      return fetchAudit(supabase, args);
    case 'submit-plan':
      return submitPlan(supabase, args);
    case 'tests':
      return printTests(supabase, args);
    case 'gate':
      return gate(supabase, args);
    case 'guard':
      return guardWorkOrder(args);
    case 'fetch':
      return fetchWorkOrder(supabase, args);
    case 'report':
      return report(supabase, args);
    case 'fail':
      return fail(supabase, args);
    default:
      console.error(`Unknown remediation CI command: ${command || '(none)'}`);
      console.error('Usage: node scripts/remediation_ci.js <fetch-audit|submit-plan|tests|gate|guard|fetch|report|fail> [...args]');
      process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[remediation_ci] Fatal:', err.message);
      process.exit(1);
    });
}


