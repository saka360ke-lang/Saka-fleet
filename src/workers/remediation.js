import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { generateText, parseJsonSafely } from '../services/aiClient.js';
import { formatNairobiDate } from '../services/dateParser.js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { sendAdminNotificationEmail, sendRemediationProposalEmail } from '../services/mailer.js';
import { dispatchRepositoryEvent } from '../services/githubDispatch.js';
import { sendProactiveWhatsApp } from './sentinel.js';

/**
 * Saka Fleet — Autonomous Sentinel ↔ Cline Remediation Pipeline (v1.10.0)
 * ------------------------------------------------------------------------
 * Agent boundary (permanent, .clinerules rule 15):
 *   Sentinel — 02:00 EAT audit of error_logs / chat_friction_logs / stalled sessions.
 *   Cline    — 03:00 EAT plan drafting inside GitHub Actions (repository_dispatch),
 *              and post-approval implementation inside the same workflow.
 *   Superadmin — sole approver: admin accept/decline/modify fix <CODE>.
 *
 * Safety model:
 *   - Plans are DESCRIPTIVE JSON work orders. This module never edits source code.
 *   - Execution requires status=APPROVED + a fresh single-use nonce verified from
 *     the database immediately before Cline starts (scripts/remediation_ci.js gate).
 *   - Targeted test suites must pass before AND after edits; red = no push.
 *   - sanitizeRemediationPlan blocks VIN/OTP/auth/schema/payment/CI/self edits.
 */

export const REMEDIATION_STATUS = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  VALIDATED: 'VALIDATED',
  DEPLOYED: 'DEPLOYED',
  DECLINED: 'DECLINED',
  NEEDS_MODIFICATION: 'NEEDS_MODIFICATION'
});

export const REMEDIATION_NONCE_TTL_HOURS = Number(process.env.REMEDIATION_NONCE_TTL_HOURS || 24);
export const REMEDIATION_MAX_ATTEMPTS = Number(process.env.REMEDIATION_MAX_ATTEMPTS || 2);
export const REMEDIATION_EXECUTION_RETRY_MS = Number(process.env.REMEDIATION_EXECUTION_RETRY_MS || 30 * 60 * 1000);
export const REMEDIATION_PLAN_REDISPATCH_MS = Number(process.env.REMEDIATION_PLAN_REDISPATCH_MS || 2 * 60 * 60 * 1000);


/**
 * Boot-time DDL (mirrors scripts/run_remediation_migration.js — the migration is
 * the single source of truth; this copy keeps `npm start` fail-soft on a fresh DB,
 * exactly like ensureSentinelTables).
 */
export const REMEDIATION_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS public.sentinel_audit_runs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        run_date date NOT NULL UNIQUE,
        window_start timestamp with time zone,
        window_end timestamp with time zone,
        error_count integer DEFAULT 0,
        friction_count integer DEFAULT 0,
        stall_count integer DEFAULT 0,
        summary jsonb,
        plan_dispatched_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.remediation_proposals (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        proposal_code text UNIQUE,
        audit_run_id uuid REFERENCES public.sentinel_audit_runs(id) ON DELETE SET NULL,
        title text,
        category text,
        root_cause text,
        evidence jsonb,
        proposed_changes jsonb,
        risk_level text DEFAULT 'low',
        status text DEFAULT 'PENDING_APPROVAL',
        feedback text,
        approval_nonce text,
        nonce_expires_at timestamp with time zone,
        attempts integer DEFAULT 0,
        dispatched_at timestamp with time zone,
        execution_dispatched_at timestamp with time zone,
        execution jsonb,
        created_at timestamp with time zone DEFAULT now(),
        reviewed_at timestamp with time zone,
        executed_at timestamp with time zone
    );
    CREATE INDEX IF NOT EXISTS idx_sentinel_audit_runs_date ON public.sentinel_audit_runs(run_date DESC);
    CREATE INDEX IF NOT EXISTS idx_remediation_proposals_status ON public.remediation_proposals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_remediation_proposals_audit ON public.remediation_proposals(audit_run_id);
`;

/** Forbidden operations anywhere in a generated plan (extends the §6.4C lock). */
export const REMEDIATION_BLOCKED_PATTERN = /\b(bypass vin|ignore vin|skip otp|disable auth|drop table|modify schema|alter table|truncate|disable rls|grant all|force push|dangerously-skip-permissions)\b/i;

/**
 * Files the autonomous executor may never touch. These require a human Cline
 * session with explicit superadmin guidance (governance, security, billing, CI,
 * schema migrations and the remediation pipeline itself = self-modification guard).
 */
export const REMEDIATION_FORBIDDEN_PATHS = Object.freeze([
  '.env',
  '.clinerules',
  '.github/',
  'supabase/',
  'scripts/reset-db.js',
  'scripts/reset_db_slate.js',
  'scripts/provision_staging_schema.js',
  'scripts/run_vin_immutability_migration.js',
  'src/services/paystack.js',
  'src/services/transfers.js',
  'src/services/githubDispatch.js',
  'src/workers/remediation.js',
  'scripts/remediation_ci.js',
  'scripts/run_remediation_migration.js'
]);

function getSupabase(providedSupabase) {
  if (providedSupabase) return providedSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials missing in environment');
  return createClient(url, key);
}

/** Ensure the remediation tables exist (fail-soft; DDL needs a SQL transport). */
export async function ensureRemediationTables(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  const requiredTables = ['sentinel_audit_runs', 'remediation_proposals'];
  const statusMap = {};

  for (const table of requiredTables) {
    const { error } = await supabase.from(table).select('*').limit(1);
    statusMap[table] = error && error.message && error.message.includes('Could not find the table')
      ? 'missing'
      : 'exists';
  }

  const missing = Object.keys(statusMap).filter((t) => statusMap[t] === 'missing');
  if (missing.length > 0 && hasSqlAccess()) {
    try {
      const result = await runSql(REMEDIATION_TABLE_SQL, { label: 'ensureRemediationTables' });
      if (result.ok) missing.forEach((t) => { statusMap[t] = 'created'; });
    } catch (err) {
      console.warn('[Remediation] Table creation notice:', err.message);
    }
  }

  return statusMap;
}


/**
 * Validate a Cline-authored plan against the permanent guardrails.
 * @returns {{ok:boolean, violations:string[], plan:object|null}}
 */
export function sanitizeRemediationPlan(plan) {
  const violations = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, violations: ['Plan payload is missing or not a JSON object.'], plan: null };
  }

  const serialized = JSON.stringify(plan);
  if (REMEDIATION_BLOCKED_PATTERN.test(serialized)) {
    violations.push('Plan contains a forbidden operation keyword (VIN/OTP/auth/schema/destructive/push override).');
  }

  const changes = Array.isArray(plan.changes)
    ? plan.changes
    : (Array.isArray(plan.proposed_changes) ? plan.proposed_changes : []);
  if (changes.length === 0) violations.push('Plan contains no proposed changes.');
  if (changes.length > 12) violations.push(`Plan is too broad (${changes.length} changes); keep it <= 12.`);

  for (const change of changes) {
    const file = String(change?.file || '').replace(/\\/g, '/').trim();
    if (!file) {
      violations.push('A proposed change is missing its target file.');
      continue;
    }
    if (file.startsWith('/') || file.includes('..')) {
      violations.push(`Target path must be repository-relative: ${file}`);
    }
    const forbidden = REMEDIATION_FORBIDDEN_PATHS.find(
      (entry) => file === entry || file.startsWith(entry) || file.endsWith(`/${entry}`)
    );
    if (forbidden) violations.push(`Forbidden target file: ${file} (matches ${forbidden}).`);
  }

  const tests = Array.isArray(plan.tests) ? plan.tests.map(String).filter(Boolean) : [];
  if (tests.length === 0) violations.push('Plan must list at least one targeted test suite.');
  const badTest = tests.find((test) => !/^test_[a-z0-9_]+\.js$/i.test(test));
  if (badTest) violations.push(`Tests must be root-level test_*.js suites: ${badTest}`);

  return { ok: violations.length === 0, violations, plan };
}

/** Record a pipeline transition in the superadmin audit ledger. */
export async function logRemediationAudit(supabase, action, details = {}) {
  try {
    const { error } = await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SENTINEL',
      action,
      details,
      created_at: new Date().toISOString()
    }]);
    if (error) console.warn('[Remediation Audit Log]:', error.message);
  } catch (err) {
    console.warn('[Remediation Audit Log Exception]:', err.message);
  }
}

/** Normalize an error/friction string into a stable clustering signature. */
export function buildSignature(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/[^a-z<>_ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unspecified';
}

/* ------------------------------------------------------------------ */
/* 02:00 EAT — Sentinel remediation audit                              */
/* ------------------------------------------------------------------ */

function buildAuditClusters({ errors = [], friction = [], stalls = [] } = {}) {
  const map = new Map();
  const push = (signature, category, evidenceId, snippet) => {
    const key = `${category}:${signature}`;
    const current = map.get(key) || {
      signature,
      category,
      count: 0,
      severity: 'low',
      evidence_ids: [],
      sample: ''
    };
    current.count += 1;
    if (current.evidence_ids.length < 5 && evidenceId) current.evidence_ids.push(evidenceId);
    if (!current.sample && snippet) current.sample = String(snippet).slice(0, 180);
    map.set(key, current);
  };

  for (const row of errors) {
    push(buildSignature(row.error_message) || 'unknown-backend-error', 'error_log', row.id, row.error_message);
  }
  for (const row of friction) {
    const category = `friction_${String(row.friction_type || 'unknown').toLowerCase()}`;
    push(buildSignature(row.transcript_snippet) || 'unknown-friction', category, row.id, row.transcript_snippet);
  }
  for (const row of stalls) {
    push('conversation-stall', 'conversation_stall', row.phone_number, 'Conversation stalled mid-flow');
  }

  const clusters = [...map.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  for (const cluster of clusters) {
    cluster.severity = cluster.count >= 10 ? 'high' : (cluster.count >= 3 ? 'medium' : 'low');
  }

  return clusters;
}

function buildFallbackSummary(clusters, counts) {
  return {
    title: clusters.length
      ? `Recurring issues detected: ${clusters[0].signature.slice(0, 70)}`
      : 'No actionable issues detected in the audit window',
    overview: `Audited the last ${counts.windowHours}h: ${counts.errors} error log(s), ${counts.friction} friction event(s), ${counts.stalls} stalled session(s).`,
    clusters,
    source: 'deterministic'
  };
}

async function synthesizeAuditSummary(clusters, counts) {
  const fallback = buildFallbackSummary(clusters, counts);
  if (clusters.length === 0) return fallback;

  const prompt = `You are Sentinel, the background supervisor for Saka Fleet (Node.js/Fastify/Supabase fleet app).
Cluster these recurring production issues and identify likely root causes. Do NOT propose schema or security changes.

Clusters (already normalized):
${JSON.stringify(clusters, null, 1)}

Return JSON only:
{"title":"short report title","overview":"2-3 sentence executive summary","clusters":[{"signature":"...","category":"...","count":0,"severity":"low|medium|high","root_cause_hypothesis":"...","recommended_fix_area":"file or service name"}]}`;

  try {
    const rawText = await generateText({ prompt, jsonMode: true, maxTokens: 1200, temperature: 0.2 });
    const parsed = rawText ? parseJsonSafely(rawText) : null;
    if (parsed && Array.isArray(parsed.clusters) && parsed.clusters.length) {
      return {
        title: parsed.title || fallback.title,
        overview: parsed.overview || fallback.overview,
        clusters: parsed.clusters.slice(0, 10),
        source: 'deepseek'
      };
    }
  } catch (err) {
    console.warn('[RemediationAudit] DeepSeek synthesis failed:', err.message);
  }

  return fallback;
}

/**
 * Aggregate the last 24h of error/friction/stall evidence into one audit run.
 * Idempotent per Nairobi calendar date (sentinel_audit_runs.run_date UNIQUE).
 */
export async function runRemediationAudit(providedSupabase, { now = new Date(), windowHours = 24 } = {}) {
  const supabase = getSupabase(providedSupabase);
  await ensureRemediationTables(supabase);

  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const stallCutoffIso = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

  const [errorRes, frictionRes, sessionRes] = await Promise.all([
    supabase
      .from('error_logs')
      .select('id,error_message,route,status,created_at')
      .gte('created_at', windowStartIso)
      .order('created_at', { ascending: false })
      .limit(120),
    supabase
      .from('chat_friction_logs')
      .select('id,friction_type,transcript_snippet,user_phone,detected_at')
      .gte('detected_at', windowStartIso)
      .order('detected_at', { ascending: false })
      .limit(120),
    supabase
      .from('chat_sessions')
      .select('phone_number,updated_at,state')
      .gte('updated_at', windowStartIso)
      .lt('updated_at', stallCutoffIso)
      .limit(120)
  ]);

  const errors = errorRes?.data || [];
  const friction = frictionRes?.data || [];
  // Only sessions with an active quiz snapshot are genuine stalls (idle chats are not).
  const stalls = (sessionRes?.data || []).filter((row) => {
    let snapshot = row.state;
    if (typeof snapshot === 'string') {
      try {
        snapshot = JSON.parse(snapshot);
      } catch {
        return false;
      }
    }
    return Boolean(snapshot?.quiz || snapshot?.session?.quiz);
  });

  const clusters = buildAuditClusters({ errors, friction, stalls });
  const counts = { errors: errors.length, friction: friction.length, stalls: stalls.length, windowHours };
  const summary = await synthesizeAuditSummary(clusters, counts);

  const runDate = formatNairobiDate(now);
  const payload = {
    run_date: runDate,
    window_start: windowStartIso,
    window_end: now.toISOString(),
    error_count: counts.errors,
    friction_count: counts.friction,
    stall_count: counts.stalls,
    summary
  };

  const { data: saved, error: upsertErr } = await supabase
    .from('sentinel_audit_runs')
    .upsert(payload, { onConflict: 'run_date' })
    .select('*')
    .maybeSingle();

  if (upsertErr) {
    console.error('[RemediationAudit] Failed to persist audit run:', upsertErr.message);
    return { status: 'error', message: upsertErr.message, run_date: runDate, counts, summary };
  }

  await logRemediationAudit(supabase, 'REMEDIATION_AUDIT_COMPLETED', {
    run_date: runDate,
    audit_run_id: saved?.id || null,
    counts,
    clusters: clusters.length
  });

  return {
    status: 'success',
    audit_run_id: saved?.id || null,
    run_date: runDate,
    counts,
    summary
  };
}

/** Load an audit run by UUID or by Nairobi run_date (YYYY-MM-DD). */
export async function loadAuditRun(providedSupabase, auditKey) {
  const supabase = getSupabase(providedSupabase);
  if (!auditKey) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(auditKey));
  const { data, error } = await supabase
    .from('sentinel_audit_runs')
    .select('*')
    .eq(isUuid ? 'id' : 'run_date', String(auditKey))
    .maybeSingle();
  if (error) {
    console.warn('[RemediationAudit] loadAuditRun failed:', error.message);
    return null;
  }
  return data || null;
}

/* ------------------------------------------------------------------ */
/* Approval gateway & execution dispatch                              */
/* ------------------------------------------------------------------ */

/** Mint a fresh single-use execution nonce (called only on superadmin ACCEPT). */
export function buildApprovalWindow(now = new Date()) {
  return {
    approval_nonce: randomUUID(),
    nonce_expires_at: new Date(now.getTime() + REMEDIATION_NONCE_TTL_HOURS * 60 * 60 * 1000).toISOString()
  };
}

/** Normalize the stored plan into a flat change list for display/dispatch. */
function planChangesOf(proposal) {
  const stored = proposal?.proposed_changes;
  if (Array.isArray(stored)) return stored;
  if (stored && Array.isArray(stored.changes)) return stored.changes;
  return [];
}

/** WhatsApp + email approval request for one PENDING_APPROVAL proposal. */
export async function dispatchRemediationProposal(providedSupabase, proposal) {
  const supabase = getSupabase(providedSupabase);
  if (!proposal) return { waSent: false, emailSent: false };

  const changes = planChangesOf(proposal);
  const topChanges = changes
    .slice(0, 3)
    .map((change, index) => `${index + 1}. ${change.file || 'file'} — ${String(change.change || '').slice(0, 110)}`)
    .join('\n');

  const message = `🛠️ *Saka Autonomous Remediation — Approval Required*\n\n` +
    `Sentinel audited the last 24h of logs and Cline drafted a scoped fix.\n\n` +
    `• *Proposal:* \`${proposal.proposal_code}\`\n` +
    `• *Title:* ${proposal.title || 'Untitled'}\n` +
    `• *Risk:* ${String(proposal.risk_level || 'low').toUpperCase()}\n` +
    `• *Evidence rows:* ${Array.isArray(proposal.evidence) ? proposal.evidence.length : 0}\n\n` +
    `*Proposed changes:*\n${topChanges || 'See email for the full plan.'}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ \`admin accept fix ${proposal.proposal_code}\`\n` +
    `⛔ \`admin decline fix ${proposal.proposal_code}\`\n` +
    `✏️ \`admin modify fix ${proposal.proposal_code} <your guidance>\`\n\n` +
    `_No code changes until you approve. Tests run before and after execution._`;

  const waSent = await sendProactiveWhatsApp(process.env.SUPERADMIN_PHONE, message);
  const emailSent = await sendRemediationProposalEmail({
    proposalCode: proposal.proposal_code,
    title: proposal.title,
    riskLevel: proposal.risk_level,
    overview: proposal.proposed_changes?.overview || proposal.root_cause || '',
    changes,
    evidenceCount: Array.isArray(proposal.evidence) ? proposal.evidence.length : 0
  });

  if (waSent || emailSent) {
    await supabase
      .from('remediation_proposals')
      .update({ dispatched_at: new Date().toISOString() })
      .eq('id', proposal.id);
  }

  await logRemediationAudit(supabase, 'REMEDIATION_PROPOSAL_DISPATCHED', {
    proposal_code: proposal.proposal_code,
    wa_sent: waSent,
    email_sent: emailSent
  });

  return { waSent, emailSent };
}

/**
 * Execution gate — verified from the database immediately before Cline starts.
 * All five conditions must hold: exists, APPROVED, nonce match, nonce fresh,
 * attempts within the configured ceiling.
 */
export async function verifyProposalGate(providedSupabase, proposalCode, approvalNonce) {
  const supabase = getSupabase(providedSupabase);
  if (!proposalCode || !approvalNonce) {
    return { ok: false, error: 'Missing proposal code or approval nonce.' };
  }

  const { data: proposal, error } = await supabase
    .from('remediation_proposals')
    .select('*')
    .eq('proposal_code', proposalCode)
    .maybeSingle();

  if (error) return { ok: false, error: `Gate query failed: ${error.message}` };
  if (!proposal) return { ok: false, error: `Unknown proposal ${proposalCode}.` };
  if (proposal.status !== REMEDIATION_STATUS.APPROVED) {
    return { ok: false, error: `Proposal status is ${proposal.status}; APPROVED is required.` };
  }
  if (!proposal.approval_nonce || proposal.approval_nonce !== approvalNonce) {
    return { ok: false, error: 'Approval nonce mismatch or already consumed.' };
  }
  if (!proposal.nonce_expires_at || new Date(proposal.nonce_expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Approval nonce has expired.' };
  }
  if ((proposal.attempts || 0) > REMEDIATION_MAX_ATTEMPTS) {
    return { ok: false, error: `Execution attempt limit reached (${REMEDIATION_MAX_ATTEMPTS}).` };
  }

  return { ok: true, proposal };
}

/** Mark a gated proposal EXECUTING (no attempt increment — dispatch owns that). */
export async function markProposalExecuting(providedSupabase, proposal) {
  const supabase = getSupabase(providedSupabase);
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('remediation_proposals')
    .update({
      status: REMEDIATION_STATUS.EXECUTING,
      execution: { ...(proposal.execution || {}), started_at: nowIso }
    })
    .eq('id', proposal.id)
    .select('*')
    .maybeSingle();

  if (!error) {
    await logRemediationAudit(supabase, 'REMEDIATION_EXECUTION_STARTED', {
      proposal_code: proposal.proposal_code,
      attempts: proposal.attempts || 0
    });
  }

  return { ok: !error, proposal: data || null, error: error?.message || null };
}

/** Single-use: null the nonce after a successful run. */
export async function consumeProposalNonce(providedSupabase, proposalId) {
  const supabase = getSupabase(providedSupabase);
  const { error } = await supabase
    .from('remediation_proposals')
    .update({ approval_nonce: null, nonce_expires_at: null })
    .eq('id', proposalId);
  return { ok: !error, error: error?.message || null };
}

/**
 * Dispatch the execution workflow for an APPROVED proposal.
 * Attempts are counted here (server-owned); Cline CI never increments them.
 */
export async function dispatchExecutionForProposal(providedSupabase, proposal) {
  const supabase = getSupabase(providedSupabase);
  if (!proposal) return { ok: false, error: 'Missing proposal.' };

  const nextAttempt = (proposal.attempts || 0) + 1;
  if (nextAttempt > REMEDIATION_MAX_ATTEMPTS) {
    await supabase
      .from('remediation_proposals')
      .update({
        status: REMEDIATION_STATUS.NEEDS_MODIFICATION,
        reviewed_at: new Date().toISOString(),
        execution: { ...(proposal.execution || {}), failure: 'Execution attempt limit reached.' }
      })
      .eq('id', proposal.id);
    await logRemediationAudit(supabase, 'REMEDIATION_ATTEMPT_LIMIT', { proposal_code: proposal.proposal_code });
    return { ok: false, error: 'Execution attempt limit reached.' };
  }

  // Extend the nonce if the previous window lapsed (approval still stands).
  let nonce = proposal.approval_nonce;
  let expiresAt = proposal.nonce_expires_at;
  if (!nonce || !expiresAt || new Date(expiresAt).getTime() < Date.now()) {
    const window = buildApprovalWindow();
    nonce = window.approval_nonce;
    expiresAt = window.nonce_expires_at;
    await supabase
      .from('remediation_proposals')
      .update({ approval_nonce: nonce, nonce_expires_at: expiresAt })
      .eq('id', proposal.id);
  }

  const dispatch = await dispatchRepositoryEvent('remediation_execute', {
    proposal_code: proposal.proposal_code,
    approval_nonce: nonce
  });

  const nowIso = new Date().toISOString();

  if (dispatch.ok) {
    await supabase
      .from('remediation_proposals')
      .update({ attempts: nextAttempt, execution_dispatched_at: nowIso })
      .eq('id', proposal.id);
    await logRemediationAudit(supabase, 'REMEDIATION_EXECUTION_DISPATCHED', {
      proposal_code: proposal.proposal_code,
      attempt: nextAttempt
    });
  } else {
    // Count failed dispatches too, so REMEDIATION_MAX_ATTEMPTS stops retry storms.
    const execution = {
      ...(proposal.execution || {}),
      last_dispatch_error: dispatch.error || 'dispatch failed',
      last_dispatch_at: nowIso
    };
    const { error: bumpErr } = await supabase
      .from('remediation_proposals')
      .update({ attempts: nextAttempt, execution })
      .eq('id', proposal.id);

    if (!bumpErr && nextAttempt >= REMEDIATION_MAX_ATTEMPTS) {
      await supabase
        .from('remediation_proposals')
        .update({ status: REMEDIATION_STATUS.NEEDS_MODIFICATION })
        .eq('id', proposal.id);
      await logRemediationAudit(supabase, 'REMEDIATION_DISPATCH_FAILED', {
        proposal_code: proposal.proposal_code,
        error: dispatch.error || 'unknown',
        attempts: nextAttempt
      });
    }
  }

  return dispatch;
}

/**
 * Report the final outcome from CI (scripts/remediation_ci.js report|fail).
 * Success consumes the nonce; failure preserves the approval for a guided re-plan.
 */
export async function reportRemediationResult(providedSupabase, proposalCode, { deployed = false, commitSha = null, failure = null } = {}) {
  const supabase = getSupabase(providedSupabase);
  const { data: proposal } = await supabase
    .from('remediation_proposals')
    .select('*')
    .eq('proposal_code', proposalCode)
    .maybeSingle();

  if (!proposal) return { ok: false, error: `Unknown proposal ${proposalCode}.` };

  const nowIso = new Date().toISOString();
  const nextStatus = deployed ? REMEDIATION_STATUS.DEPLOYED : REMEDIATION_STATUS.NEEDS_MODIFICATION;
  const execution = {
    ...(proposal.execution || {}),
    finished_at: nowIso,
    commit_sha: commitSha || proposal.execution?.commit_sha || null,
    failure: failure || null
  };

  const { error: updateErr } = await supabase
    .from('remediation_proposals')
    .update({
      status: nextStatus,
      execution,
      executed_at: deployed ? nowIso : proposal.executed_at,
      reviewed_at: deployed ? proposal.reviewed_at : nowIso
    })
    .eq('id', proposal.id);

  if (updateErr) return { ok: false, error: updateErr.message };

  if (deployed) {
    await consumeProposalNonce(supabase, proposal.id);
  }

  const summaryLine = deployed
    ? `✅ *Remediation deployed*\n\n• \`${proposalCode}\`\n• ${proposal.title || 'Fix applied'}\n• Commit: \`${commitSha || 'unknown'}\`\n\nTargeted tests passed before and after the change.`
    : `⚠️ *Remediation needs review*\n\n• \`${proposalCode}\`\n• ${proposal.title || 'Plan not applied'}\n• Reason: ${String(failure || 'validation failed').slice(0, 220)}\n\nNo code was pushed. Refine the plan with \`admin modify fix ${proposalCode} <guidance>\`.`;

  await sendProactiveWhatsApp(process.env.SUPERADMIN_PHONE, summaryLine);
  await sendAdminNotificationEmail(
    deployed ? `Remediation deployed: ${proposalCode}` : `Remediation needs review: ${proposalCode}`,
    `<p>${summaryLine.replace(/\n/g, '<br>')}</p>`
  );
  await logRemediationAudit(supabase, deployed ? 'REMEDIATION_DEPLOYED' : 'REMEDIATION_FAILED', {
    proposal_code: proposalCode,
    commit_sha: commitSha,
    failure
  });

  return { ok: true, status: nextStatus };
}

/* ------------------------------------------------------------------ */
/* Scheduler pollers (server-side fallbacks)                           */
/* ------------------------------------------------------------------ */

/**
 * 03:00 EAT — ask CI/Cline to draft a plan for today's audit.
 * Re-dispatches after REMEDIATION_PLAN_REDISPATCH_MS if CI never produced a
 * proposal (workflow failure), and never duplicates a successful dispatch.
 */
export async function checkRemediationPlanDispatch(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  if (String(process.env.REMEDIATION_AUTONOMY || 'off').toLowerCase() !== 'on') {
    return { status: 'skipped', reason: 'REMEDIATION_AUTONOMY is not enabled.' };
  }

  await ensureRemediationTables(supabase);
  const today = formatNairobiDate();

  const { data: audit } = await supabase
    .from('sentinel_audit_runs')
    .select('*')
    .eq('run_date', today)
    .maybeSingle();
  if (!audit) return { status: 'skipped', reason: 'No audit run for today.' };

  const { data: existing } = await supabase
    .from('remediation_proposals')
    .select('id,status')
    .eq('audit_run_id', audit.id)
    .limit(1);
  if (existing && existing.length > 0) {
    return { status: 'skipped', reason: 'A proposal already exists for today’s audit.' };
  }

  if (audit.plan_dispatched_at) {
    const age = Date.now() - new Date(audit.plan_dispatched_at).getTime();
    if (age < REMEDIATION_PLAN_REDISPATCH_MS) {
      return { status: 'skipped', reason: 'Plan dispatch already requested.' };
    }
  }

  const dispatch = await dispatchRepositoryEvent('remediation_plan', {
    audit_run_id: audit.id,
    run_date: audit.run_date
  });

  if (dispatch.ok) {
    await supabase
      .from('sentinel_audit_runs')
      .update({ plan_dispatched_at: new Date().toISOString() })
      .eq('id', audit.id);
    await logRemediationAudit(supabase, 'REMEDIATION_PLAN_DISPATCHED', {
      audit_run_id: audit.id,
      run_date: audit.run_date
    });
  }

  return { status: dispatch.ok ? 'dispatched' : 'failed', audit_run_id: audit.id, dispatch };
}

/** Deliver approval requests for proposals CI has created but not yet announced. */
export async function checkRemediationProposalDelivery(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  await ensureRemediationTables(supabase);

  const { data: pending } = await supabase
    .from('remediation_proposals')
    .select('*')
    .eq('status', REMEDIATION_STATUS.PENDING_APPROVAL)
    .is('dispatched_at', null)
    .order('created_at', { ascending: true })
    .limit(5);

  const results = [];
  for (const proposal of pending || []) {
    const sent = await dispatchRemediationProposal(supabase, proposal);
    results.push({ proposal_code: proposal.proposal_code, ...sent });
  }

  return { status: 'success', delivered: results.length, results };
}

/**
 * Retry execution dispatch for APPROVED proposals whose CI run never started
 * (dispatch outage, workflow crash) and recover EXECUTING proposals stranded by
 * a crashed run. Stops at REMEDIATION_MAX_ATTEMPTS.
 */
export async function checkRemediationExecutionRetry(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  if (String(process.env.REMEDIATION_AUTONOMY || 'off').toLowerCase() !== 'on') {
    return { status: 'skipped', reason: 'REMEDIATION_AUTONOMY is not enabled.' };
  }

  await ensureRemediationTables(supabase);

  const { data: approved } = await supabase
    .from('remediation_proposals')
    .select('*')
    .in('status', [REMEDIATION_STATUS.APPROVED, REMEDIATION_STATUS.EXECUTING])
    .order('reviewed_at', { ascending: true })
    .limit(10);

  const retried = [];
  for (const proposal of approved || []) {
    const lastDispatch = proposal.execution_dispatched_at
      ? new Date(proposal.execution_dispatched_at).getTime()
      : 0;
    if (lastDispatch && Date.now() - lastDispatch < REMEDIATION_EXECUTION_RETRY_MS) continue;

    // Recover a run stranded in EXECUTING (runner crash) before re-dispatching.
    let target = proposal;
    if (proposal.status === REMEDIATION_STATUS.EXECUTING) {
      const { data: reset } = await supabase
        .from('remediation_proposals')
        .update({ status: REMEDIATION_STATUS.APPROVED })
        .eq('id', proposal.id)
        .select('*')
        .maybeSingle();
      target = reset || { ...proposal, status: REMEDIATION_STATUS.APPROVED };
      await logRemediationAudit(supabase, 'REMEDIATION_STALE_EXECUTION_RESET', {
        proposal_code: proposal.proposal_code
      });
    }

    const dispatch = await dispatchExecutionForProposal(supabase, target);
    retried.push({ proposal_code: proposal.proposal_code, ok: Boolean(dispatch.ok), error: dispatch.error || null });
  }

  return { status: 'success', retried: retried.length, results: retried };
}





