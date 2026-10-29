import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { generateText, parseJsonSafely } from '../services/aiClient.js';
import { formatNairobiDate } from '../services/dateParser.js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { sendAdminNotificationEmail, sendRemediationProposalEmail, sendRemediationDigestEmail } from '../services/mailer.js';
import { dispatchRepositoryEvent } from '../services/githubDispatch.js';
import { sendProactiveWhatsApp } from './sentinel.js';

/**
 * Saka Fleet — Autonomous Sentinel ↔ Cline Remediation Pipeline (v1.10.0)
 * ------------------------------------------------------------------------
 * Agent boundary (permanent, .clinerules rule 15):
 *   Sentinel — continuous (60s) rolling-window audit of error_logs / chat_friction_logs / stalled sessions.
 *   Cline    — threshold-triggered plan drafting inside GitHub Actions (repository_dispatch),
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

/* v1.11.0 — high-frequency scanning + adaptive digest tunables */
export const REMEDIATION_SCAN_INTERVAL_MS = Number(process.env.REMEDIATION_SCAN_INTERVAL_MS || 60000);
export const REMEDIATION_SYNTHESIS_INTERVAL_MS = Number(process.env.REMEDIATION_SYNTHESIS_INTERVAL_MS || 15 * 60 * 1000);
export const REMEDIATION_PLAN_TRIGGER_COUNT = Number(process.env.REMEDIATION_PLAN_TRIGGER_COUNT || 3);
export const REMEDIATION_PLAN_COOLDOWN_MS = Number(process.env.REMEDIATION_PLAN_COOLDOWN_MS || 6 * 60 * 60 * 1000);
export const REMEDIATION_MAX_PLANS_PER_DAY = Number(process.env.REMEDIATION_MAX_PLANS_PER_DAY || 4);
export const REMEDIATION_DIGEST_HOURS = String(process.env.REMEDIATION_DIGEST_HOURS_CSV || '8,20')
  .split(',')
  .map((hour) => Number(String(hour).trim()))
  .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
export const REMEDIATION_DIGEST_FREQUENCIES = Object.freeze(['weekly', 'daily', 'twice_daily']);
export const REMEDIATION_DIGEST_SCALE_DOWN_WINDOW_DAYS = Number(process.env.REMEDIATION_DIGEST_SCALE_DOWN_WINDOW_DAYS || 7);
export const REMEDIATION_DIGEST_DAILY_THRESHOLD = Number(process.env.REMEDIATION_DIGEST_DAILY_THRESHOLD || 10);
export const REMEDIATION_DIGEST_WEEKLY_THRESHOLD = Number(process.env.REMEDIATION_DIGEST_WEEKLY_THRESHOLD || 3);
export const REMEDIATION_URGENT_ERROR_THRESHOLD = Number(process.env.REMEDIATION_URGENT_ERROR_THRESHOLD || 10);
export const REMEDIATION_URGENT_COOLDOWN_MS = Number(process.env.REMEDIATION_URGENT_COOLDOWN_MS || 60 * 60 * 1000);

const DIGEST_FREQUENCY_KEY = 'remediation_digest_frequency';
const DIGEST_LAST_SENT_KEY = 'remediation_digest_last_sent';
const URGENT_LAST_SENT_KEY = 'remediation_urgent_last_sent';


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
        clusters jsonb,
        health_score integer,
        scan_count integer DEFAULT 0,
        last_scanned_at timestamp with time zone,
        last_synthesis_at timestamp with time zone,
        plan_dispatches jsonb DEFAULT '{}'::jsonb,
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
        target_signature text,
        feedback text,
        approval_nonce text,
        nonce_expires_at timestamp with time zone,
        attempts integer DEFAULT 0,
        dispatched_at timestamp with time zone,
        digest_sent_at timestamp with time zone,
        execution_dispatched_at timestamp with time zone,
        execution jsonb,
        created_at timestamp with time zone DEFAULT now(),
        reviewed_at timestamp with time zone,
        executed_at timestamp with time zone
    );
    CREATE INDEX IF NOT EXISTS idx_sentinel_audit_runs_date ON public.sentinel_audit_runs(run_date DESC);
    CREATE INDEX IF NOT EXISTS idx_remediation_proposals_status ON public.remediation_proposals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_remediation_proposals_audit ON public.remediation_proposals(audit_run_id);
    CREATE INDEX IF NOT EXISTS idx_remediation_proposals_signature ON public.remediation_proposals(target_signature, status);
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
/* Continuous Sentinel remediation scan (tier 1 + shared collector)   */
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

/** 0–100 health score derived from the rolling audit window. */
export function computeHealthScore({ errors = 0, friction = 0, stalls = 0 } = {}) {
  const score = 100 - errors * 2 - friction * 1 - stalls * 1.5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function clusterFingerprint(clusters = []) {
  return JSON.stringify((clusters || [])
    .map((cluster) => [cluster.signature, cluster.category, cluster.count])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Deterministic clusters persisted on the audit row (AI narrative lives in summary). */
export function auditClustersOf(audit) {
  if (!audit) return [];
  if (Array.isArray(audit.clusters)) return audit.clusters;
  return Array.isArray(audit.summary?.clusters) ? audit.summary.clusters : [];
}

/** Collect + cluster the rolling window (shared by the scan and manual refresh). */
async function collectAuditWindow(supabase, now, windowHours) {
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = now.toISOString();
  const stallCutoffIso = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

  const [errorRes, frictionRes, sessionRes] = await Promise.all([
    supabase
      .from('error_logs')
      .select('id,error_message,route,status,created_at')
      .gte('created_at', windowStartIso)
      .lte('created_at', windowEndIso)
      .order('created_at', { ascending: false })
      .limit(120),
    supabase
      .from('chat_friction_logs')
      .select('id,friction_type,transcript_snippet,user_phone,detected_at')
      .gte('detected_at', windowStartIso)
      .lte('detected_at', windowEndIso)
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

  return {
    counts: { errors: errors.length, friction: friction.length, stalls: stalls.length, windowHours },
    clusters: buildAuditClusters({ errors, friction, stalls }),
    windowStartIso
  };
}

/**
 * Tier 1 — high-frequency deterministic scan (no AI call).
 * Idempotent per Nairobi date: updates the same row, bumps scan_count, and only
 * rewrites the deterministic summary when the window materially changed.
 * Tier 2 (`refreshRemediationSynthesis`) supplies the throttled AI narrative.
 */
export async function runRemediationScan(providedSupabase, { now = new Date(), windowHours = 24 } = {}) {
  const supabase = getSupabase(providedSupabase);
  await ensureRemediationTables(supabase);

  const { counts, clusters, windowStartIso } = await collectAuditWindow(supabase, now, windowHours);

  const health_score = computeHealthScore(counts);
  const runDate = formatNairobiDate(now);

  const { data: existing } = await supabase
    .from('sentinel_audit_runs')
    .select('*')
    .eq('run_date', runDate)
    .maybeSingle();

  const changed = !existing
    || existing.error_count !== counts.errors
    || existing.friction_count !== counts.friction
    || existing.stall_count !== counts.stalls
    || clusterFingerprint(auditClustersOf(existing)) !== clusterFingerprint(clusters);

  const payload = {
    run_date: runDate,
    window_start: windowStartIso,
    window_end: now.toISOString(),
    error_count: counts.errors,
    friction_count: counts.friction,
    stall_count: counts.stalls,
    clusters,
    health_score,
    scan_count: (existing?.scan_count || 0) + 1,
    last_scanned_at: now.toISOString(),
    summary: changed || !existing?.summary
      ? buildFallbackSummary(clusters, counts)
      : existing.summary
  };

  const { data: saved, error: upsertErr } = await supabase
    .from('sentinel_audit_runs')
    .upsert(payload, { onConflict: 'run_date' })
    .select('*')
    .maybeSingle();

  if (upsertErr) {
    console.error('[RemediationScan] Failed to persist scan:', upsertErr.message);
    return { status: 'error', message: upsertErr.message, run_date: runDate, counts, health_score, clusters };
  }

  if (changed) {
    await logRemediationAudit(supabase, 'REMEDIATION_SCAN_UPDATED', {
      run_date: runDate,
      audit_run_id: saved?.id || null,
      counts,
      clusters: clusters.length,
      health_score
    });
  }

  return {
    status: 'success',
    audit_run_id: saved?.id || null,
    run_date: runDate,
    changed,
    counts,
    health_score,
    clusters,
    summary: payload.summary,
    scan_count: payload.scan_count
  };
}

/**
 * Tier 2 — throttled AI synthesis. Refreshes the narrative summary at most every
 * REMEDIATION_SYNTHESIS_INTERVAL_MS (or immediately when forced).
 */
export async function refreshRemediationSynthesis(providedSupabase, { now = new Date(), force = false } = {}) {
  const supabase = getSupabase(providedSupabase);
  await ensureRemediationTables(supabase);

  const runDate = formatNairobiDate(now);
  const { data: audit } = await supabase
    .from('sentinel_audit_runs')
    .select('*')
    .eq('run_date', runDate)
    .maybeSingle();

  if (!audit) return { status: 'skipped', reason: 'No scan for today yet.' };
  if (!force && audit.last_synthesis_at) {
    const age = now.getTime() - new Date(audit.last_synthesis_at).getTime();
    if (age < REMEDIATION_SYNTHESIS_INTERVAL_MS) {
      return { status: 'skipped', reason: 'Synthesis is fresh.' };
    }
  }

  const clusters = auditClustersOf(audit);
  if (clusters.length === 0) {
    await supabase
      .from('sentinel_audit_runs')
      .update({ last_synthesis_at: now.toISOString() })
      .eq('id', audit.id);
    return { status: 'success', synthesized: false, reason: 'No clusters in the window.' };
  }

  const counts = {
    errors: audit.error_count || 0,
    friction: audit.friction_count || 0,
    stalls: audit.stall_count || 0,
    windowHours: 24
  };
  const summary = await synthesizeAuditSummary(clusters, counts);
  const { error } = await supabase
    .from('sentinel_audit_runs')
    .update({ summary, last_synthesis_at: now.toISOString() })
    .eq('id', audit.id);

  if (error) return { status: 'error', message: error.message };

  await logRemediationAudit(supabase, 'REMEDIATION_SYNTHESIS_COMPLETED', {
    run_date: runDate,
    source: summary.source,
    clusters: clusters.length
  });

  return { status: 'success', synthesized: true, source: summary.source };
}

/** Manual full refresh (cron endpoint / tests): deterministic scan + forced AI synthesis. */
export async function runRemediationAudit(providedSupabase, options = {}) {
  const scan = await runRemediationScan(providedSupabase, options);
  if (scan.status === 'success') {
    await refreshRemediationSynthesis(providedSupabase, { now: options.now || new Date(), force: true });
  }
  return scan;
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

/* ------------------------------------------------------------------ */
/* Tier 3 — event/threshold-driven plan dispatch                      */
/* ------------------------------------------------------------------ */

/** A cluster qualifies when it is high severity or crosses the repeat threshold. */
export function selectPlanTriggerClusters(clusters = [], { triggerCount = REMEDIATION_PLAN_TRIGGER_COUNT } = {}) {
  return (clusters || []).filter((cluster) => {
    const count = Number(cluster?.count || 0);
    const severity = String(cluster?.severity || 'low').toLowerCase();
    return severity === 'high' || count >= triggerCount;
  });
}

/**
 * Ask CI/Cline to draft a plan for each qualifying cluster, with a per-signature
 * cooldown, active-proposal dedupe and a hard daily plan cap.
 * Gated by REMEDIATION_AUTONOMY=on.
 */
export async function checkRemediationPlanTriggers(providedSupabase, { now = new Date() } = {}) {
  const supabase = getSupabase(providedSupabase);
  if (String(process.env.REMEDIATION_AUTONOMY || 'off').toLowerCase() !== 'on') {
    return { status: 'skipped', reason: 'REMEDIATION_AUTONOMY is not enabled.' };
  }

  await ensureRemediationTables(supabase);
  const runDate = formatNairobiDate(now);

  const { data: audit } = await supabase
    .from('sentinel_audit_runs')
    .select('*')
    .eq('run_date', runDate)
    .maybeSingle();
  if (!audit) return { status: 'skipped', reason: 'No scan for today yet.' };

  const eligible = selectPlanTriggerClusters(auditClustersOf(audit));
  if (eligible.length === 0) return { status: 'success', dispatched: 0, eligible: 0 };

  const ledger = audit.plan_dispatches && typeof audit.plan_dispatches === 'object'
    ? audit.plan_dispatches
    : {};
  const todayDispatches = Object.values(ledger)
    .filter((value) => value && formatNairobiDate(new Date(value)) === runDate)
    .length;

  if (todayDispatches >= REMEDIATION_MAX_PLANS_PER_DAY) {
    return {
      status: 'skipped',
      reason: `Daily plan cap reached (${REMEDIATION_MAX_PLANS_PER_DAY}).`,
      eligible: eligible.length
    };
  }

  const signatures = eligible.map((cluster) => cluster.signature);
  const { data: active } = await supabase
    .from('remediation_proposals')
    .select('target_signature,status')
    .in('target_signature', signatures)
    .in('status', [REMEDIATION_STATUS.PENDING_APPROVAL, REMEDIATION_STATUS.APPROVED, REMEDIATION_STATUS.EXECUTING]);
  const activeSignatures = new Set((active || []).map((row) => row.target_signature));

  const ledgerUpdates = {};
  let dispatchedCount = 0;

  for (const cluster of eligible) {
    if (todayDispatches + dispatchedCount >= REMEDIATION_MAX_PLANS_PER_DAY) break;
    if (activeSignatures.has(cluster.signature)) continue;

    const last = ledger[cluster.signature] ? new Date(ledger[cluster.signature]).getTime() : 0;
    if (last && now.getTime() - last < REMEDIATION_PLAN_COOLDOWN_MS) continue;

    const dispatch = await dispatchRepositoryEvent('remediation_plan', {
      audit_run_id: audit.id,
      run_date: runDate,
      cluster_signature: cluster.signature,
      cluster
    });

    if (dispatch.ok) {
      ledgerUpdates[cluster.signature] = now.toISOString();
      dispatchedCount += 1;
    }
  }

  if (dispatchedCount > 0) {
    await supabase
      .from('sentinel_audit_runs')
      .update({ plan_dispatches: { ...ledger, ...ledgerUpdates } })
      .eq('id', audit.id);
    await logRemediationAudit(supabase, 'REMEDIATION_PLAN_DISPATCHED', {
      run_date: runDate,
      signatures: Object.keys(ledgerUpdates),
      dispatched: dispatchedCount
    });
  }

  return {
    status: 'success',
    dispatched: dispatchedCount,
    eligible: eligible.length,
    skipped_active: [...activeSignatures]
  };
}

/* ------------------------------------------------------------------ */
/* Twice-daily digest + adaptive frequency + urgent escalation        */
/* ------------------------------------------------------------------ */

async function getConfigValue(supabase, key) {
  try {
    const { data } = await supabase.from('system_config').select('value').eq('key', key).maybeSingle();
    return data?.value || null;
  } catch {
    return null;
  }
}

async function setConfigValue(supabase, key, value) {
  try {
    const { error } = await supabase
      .from('system_config')
      .upsert([{ key, value, updated_by: 'SENTINEL', updated_at: new Date().toISOString() }], { onConflict: 'key' });
    if (error) console.warn(`[Remediation] ${key} write failed:`, error.message);
  } catch (err) {
    console.warn(`[Remediation] ${key} write exception:`, err.message);
  }
}

/**
 * Pure adaptive-frequency state machine.
 * - More events than the daily threshold → escalate immediately.
 * - Fewer events → scale DOWN one step per evaluation (twice_daily → daily → weekly).
 */
export function computeDigestFrequency(events, current = 'twice_daily', {
  dailyThreshold = REMEDIATION_DIGEST_DAILY_THRESHOLD,
  weeklyThreshold = REMEDIATION_DIGEST_WEEKLY_THRESHOLD
} = {}) {
  const order = REMEDIATION_DIGEST_FREQUENCIES; // ['weekly', 'daily', 'twice_daily']
  const currentIndex = order.indexOf(current);
  const targetIndex = events <= weeklyThreshold ? 0 : (events <= dailyThreshold ? 1 : 2);

  if (currentIndex === -1) return order[targetIndex];
  if (targetIndex > currentIndex) return order[targetIndex]; // escalate immediately
  return order[Math.max(targetIndex, currentIndex - 1)]; // one step down per evaluation
}

/** Current persisted digest frequency (defaults to twice_daily). */
export async function getDigestFrequency(supabase) {
  const stored = await getConfigValue(supabase, DIGEST_FREQUENCY_KEY);
  return REMEDIATION_DIGEST_FREQUENCIES.includes(stored) ? stored : 'twice_daily';
}

async function setDigestFrequency(supabase, value) {
  await setConfigValue(supabase, DIGEST_FREQUENCY_KEY, value);
}

/** Error + friction events in the trailing window (used for adaptive scaling). */
async function countRecentEvents(supabase, now, days) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [errors, friction] = await Promise.all([
      supabase.from('error_logs').select('*', { count: 'exact', head: true }).gte('created_at', since),
      supabase.from('chat_friction_logs').select('*', { count: 'exact', head: true }).gte('detected_at', since)
    ]);
    return (errors.count || 0) + (friction.count || 0);
  } catch {
    return 0;
  }
}


/**
 * Twice-daily (adaptive) Superadmin digest: pending approvals + health snapshot.
 * Sends regardless of REMEDIATION_AUTONOMY (notification-only); `force` bypasses
 * the slot/frequency checks, `dryRun` marks proposals without external sends.
 */
export async function sendRemediationDigest(providedSupabase, { now = new Date(), force = false, dryRun = false } = {}) {
  const supabase = getSupabase(providedSupabase);
  await ensureRemediationTables(supabase);

  const frequency = await getDigestFrequency(supabase);
  const nairobiHour = (now.getUTCHours() + 3) % 24;
  const morningHour = REMEDIATION_DIGEST_HOURS[0] ?? 8;

  if (!force) {
    const allowed = frequency === 'twice_daily'
      ? REMEDIATION_DIGEST_HOURS.includes(nairobiHour)
      : (frequency === 'daily'
        ? nairobiHour === morningHour
        : (now.getUTCDay() === 1 && nairobiHour === morningHour));
    if (!allowed) {
      return { status: 'skipped', reason: `Frequency ${frequency} does not allow a digest at ${nairobiHour}:00 EAT.` };
    }
  }

  const runDate = formatNairobiDate(now);
  const { data: audit } = await supabase
    .from('sentinel_audit_runs')
    .select('*')
    .eq('run_date', runDate)
    .maybeSingle();

  const { data: pending } = await supabase
    .from('remediation_proposals')
    .select('id,proposal_code,title,risk_level,status,target_signature,created_at')
    .in('status', [REMEDIATION_STATUS.PENDING_APPROVAL, REMEDIATION_STATUS.NEEDS_MODIFICATION])
    .is('digest_sent_at', null)
    .order('created_at', { ascending: true })
    .limit(10);
  const proposals = pending || [];

  const { count: unresolvedErrors } = await supabase
    .from('error_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'unresolved');
  const { count: activeRules } = await supabase
    .from('saka_dynamic_rules')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  const weeklyEvents = await countRecentEvents(supabase, now, REMEDIATION_DIGEST_SCALE_DOWN_WINDOW_DAYS);
  const nextFrequency = computeDigestFrequency(weeklyEvents, frequency);
  if (nextFrequency !== frequency && !dryRun) {
    await setDigestFrequency(supabase, nextFrequency);
    await logRemediationAudit(supabase, 'REMEDIATION_DIGEST_FREQUENCY_CHANGED', {
      from: frequency,
      to: nextFrequency,
      weekly_events: weeklyEvents
    });
  }

  const health = {
    health_score: audit?.health_score ?? computeHealthScore({
      errors: audit?.error_count || 0,
      friction: audit?.friction_count || 0,
      stalls: audit?.stall_count || 0
    }),
    errors_24h: audit?.error_count || 0,
    friction_24h: audit?.friction_count || 0,
    stalls_24h: audit?.stall_count || 0,
    unresolved_errors: unresolvedErrors || 0,
    active_rules: activeRules || 0,
    scans: audit?.scan_count || 0
  };

  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(now);
  const slotLabel = nairobiHour < 12 ? 'Morning' : 'Evening';

  const lines = [
    `🩺 *Saka Remediation Digest — ${slotLabel}*`,
    `_${dateLabel} • frequency: ${nextFrequency}_`,
    '',
    `📊 *System health: ${health.health_score}/100*`,
    `• Errors (24h): ${health.errors_24h} (unresolved: ${health.unresolved_errors})`,
    `• Friction events (24h): ${health.friction_24h}`,
    `• Stalled sessions: ${health.stalls_24h}`,
    `• Active Sentinel rules: ${health.active_rules}`,
    '',
    proposals.length
      ? `🛠️ *Pending approvals (${proposals.length}):*\n${proposals
        .map((proposal, index) => `${index + 1}. \`${proposal.proposal_code}\` — ${proposal.title || 'Untitled'} (${String(proposal.risk_level || 'low').toUpperCase()})`)
        .join('\n')}`
      : '✅ *No pending remediation approvals.*',
    proposals.length
      ? '✅ `admin accept fix <CODE>`\n⛔ `admin decline fix <CODE>`\n✏️ `admin modify fix <CODE> <guidance>`'
      : '',
    `_Digest frequency auto-scales with stability (${REMEDIATION_DIGEST_SCALE_DOWN_WINDOW_DAYS}-day events: ${weeklyEvents})._`
  ].filter(Boolean).join('\n');

  let waSent = false;
  let emailSent = false;

  if (!dryRun) {
    waSent = await sendProactiveWhatsApp(process.env.SUPERADMIN_PHONE, lines);
    emailSent = await sendRemediationDigestEmail({
      dateLabel,
      slotLabel,
      frequency: nextFrequency,
      health,
      pending: proposals,
      weeklyEvents
    });

    if (waSent || emailSent) {
      if (proposals.length) {
        await supabase
          .from('remediation_proposals')
          .update({ digest_sent_at: now.toISOString() })
          .in('id', proposals.map((proposal) => proposal.id));
      }
      await setConfigValue(supabase, DIGEST_LAST_SENT_KEY, now.toISOString());
    }
  } else if (proposals.length) {
    await supabase
      .from('remediation_proposals')
      .update({ digest_sent_at: now.toISOString() })
      .in('id', proposals.map((proposal) => proposal.id));
  }

  await logRemediationAudit(supabase, 'REMEDIATION_DIGEST_SENT', {
    date: runDate,
    slot: slotLabel,
    proposals: proposals.length,
    frequency: nextFrequency,
    wa_sent: waSent,
    email_sent: emailSent,
    dry_run: dryRun
  });

  return {
    status: 'success',
    proposals: proposals.length,
    frequency: nextFrequency,
    health,
    waSent,
    emailSent,
    dryRun
  };
}

/**
 * Urgent escalation: unresolved errors above threshold or high-risk pending
 * proposals trigger an immediate WhatsApp+email alert (deduped by cooldown),
 * in addition to the regular digest. Notification-only → not autonomy-gated.
 */
export async function maybeSendUrgentRemediationAlert(providedSupabase, { now = new Date(), dryRun = false } = {}) {
  const supabase = getSupabase(providedSupabase);
  await ensureRemediationTables(supabase);

  const { count: unresolvedErrors } = await supabase
    .from('error_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'unresolved');

  const { data: highRisk } = await supabase
    .from('remediation_proposals')
    .select('proposal_code,title,status')
    .eq('status', REMEDIATION_STATUS.PENDING_APPROVAL)
    .eq('risk_level', 'high')
    .order('created_at', { ascending: true })
    .limit(5);

  const errorBreach = (unresolvedErrors || 0) >= REMEDIATION_URGENT_ERROR_THRESHOLD;
  const proposals = highRisk || [];
  if (!errorBreach && proposals.length === 0) {
    return { status: 'skipped', reason: 'No urgent condition.' };
  }

  const lastSent = await getConfigValue(supabase, URGENT_LAST_SENT_KEY);
  if (lastSent && now.getTime() - new Date(lastSent).getTime() < REMEDIATION_URGENT_COOLDOWN_MS) {
    return { status: 'skipped', reason: 'Urgent alert cooldown active.' };
  }

  const lines = `🚨 *Saka Remediation — Urgent Attention*\n\n` +
    (errorBreach ? `• Unresolved errors: *${unresolvedErrors}* (threshold ${REMEDIATION_URGENT_ERROR_THRESHOLD})\n` : '') +
    (proposals.length
      ? `• High-risk proposals:\n${proposals.map((proposal) => `   – \`${proposal.proposal_code}\` ${proposal.title || ''}`).join('\n')}\n`
      : '') +
    `\nReply \`admin remediations\` to review, then \`admin accept fix <CODE>\` to approve.`;

  let waSent = false;
  let emailSent = false;

  if (!dryRun) {
    waSent = await sendProactiveWhatsApp(process.env.SUPERADMIN_PHONE, lines);
    emailSent = await sendAdminNotificationEmail(
      '🚨 Saka Remediation — urgent attention required',
      `<p>${lines.replace(/\n/g, '<br>')}</p>`
    );
    if (waSent || emailSent) {
      await setConfigValue(supabase, URGENT_LAST_SENT_KEY, now.toISOString());
    }
  }

  await logRemediationAudit(supabase, 'REMEDIATION_URGENT_ALERT', {
    unresolved_errors: unresolvedErrors || 0,
    proposals: proposals.length,
    wa_sent: waSent,
    email_sent: emailSent,
    dry_run: dryRun
  });

  return { status: 'success', urgent: true, proposals: proposals.length, waSent, emailSent };
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





