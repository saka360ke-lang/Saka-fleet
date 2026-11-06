/**
 * Saka Fleet — Sentinel bi-weekly deep audit (v1.58.5)
 * ---------------------------------------------------
 * Twice a week Sentinel runs a deterministic, code-integrity scan (no AI for
 * detection) over the live source tree and the error log, then mints
 * PENDING_APPROVAL `PROP-*` proposals (category `deep_audit_finding`) for human
 * review. It NEVER mutates code — it only writes auditable proposals and an
 * `admin_audit_logs` run marker. Governance firewall per .clinerules 15–19.
 *
 * Checks:
 *   1. Mojibake lint   — double-encoded UTF-8 in sources.
 *   2. Nairobi time    — server-local/UTC time where Africa/Nairobi is required.
 *   3. Ledger scoping  — the vehicle-scoping guards are present.
 *   4. Silent failures — recurring unresolved error_logs by route.
 *
 * Never throws: every function returns a plain result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { formatNairobiDate } from './dateParser.js';
import { nextProposalCode } from './proposalRegistry.js';
import { isSentinelProposalsEnabled } from './sentinelPolicy.js';

export const DEEP_AUDIT_ACTION = 'SENTINEL_DEEP_AUDIT';
export const DEEP_AUDIT_CATEGORY = 'deep_audit_finding';
export const DEEP_AUDIT_DEFAULT_SCHEDULE = 'Mon,Thu@03:00';

const PENDING = 'PENDING_APPROVAL';
const MODIFY = 'NEEDS_MODIFICATION';

// Never point a finding's remediation at a governance-protected path.
const FORBIDDEN_PATH = /(^|\/)(\.env|\.clinerules|\.github|supabase)(\/|$)|paystack\.js|transfers\.js|githubDispatch\.js|remediation(\.js|_ci\.js)|run_vin_immutability|reset-db|provision_staging|vin_immutability/i;

// Mojibake signatures as code points so THIS file never carries the literal
// mangled bytes it hunts for.
const MOJIBAKE_SIGNATURES = ['\u00f0\u0178', '\u00e2\u20ac'];

const WEEKDAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6
};

export function isDeepAuditEnabled(env = process.env) {
  const v = (env && env.SENTINEL_DEEP_AUDIT_ENABLED) || process.env.SENTINEL_DEEP_AUDIT_ENABLED || 'on';
  return /^(?:on|true|1|yes)$/i.test(String(v));
}

/** Parse "Mon,Thu@03:00" → { weekdays:Set<number>, nairobiHour:number }. */
export function parseDeepAuditSchedule(spec = process.env.SENTINEL_DEEP_AUDIT_SCHEDULE || DEEP_AUDIT_DEFAULT_SCHEDULE) {
  const raw = String(spec || DEEP_AUDIT_DEFAULT_SCHEDULE).trim();
  const [daysPart, hourPart] = raw.split('@');
  const weekdays = new Set();
  for (const token of String(daysPart || '').split(',')) {
    const n = WEEKDAY_ALIASES[token.trim().toLowerCase()];
    if (n !== undefined) weekdays.add(n);
  }
  let nairobiHour = 3;
  if (hourPart) {
    const h = Number(String(hourPart).split(':')[0]);
    if (Number.isInteger(h) && h >= 0 && h <= 23) nairobiHour = h;
  }
  if (weekdays.size === 0) { weekdays.add(1); weekdays.add(4); }
  return { weekdays, nairobiHour };
}

function slugify(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'finding';
}

/** 1) Mojibake lint: double-encoded UTF-8 sequences in the source tree. */
export function lintMojibake(sources = []) {
  const findings = [];
  for (const src of sources) {
    if (!src || typeof src.text !== 'string') continue;
    const hits = [];
    src.text.split(/\r?\n/).forEach((line, i) => {
      if (MOJIBAKE_SIGNATURES.some((sig) => line.includes(sig))) {
        hits.push({ line: i + 1, snippet: line.trim().slice(0, 120) });
      }
    });
    if (hits.length) {
      findings.push({
        slug: `mojibake-${slugify(src.path)}`,
        severity: 'high',
        title: `UTF-8 mojibake in ${src.path}`,
        description: `${src.path} contains ${hits.length} line(s) of double-encoded UTF-8 (emojis/dashes) that render as garbage in WhatsApp messages.`,
        files: [src.path],
        evidence: hits.slice(0, 5),
        remediation: `Re-save ${src.path} as UTF-8 and replace the mojibake sequences with correct emoji/dash characters.`
      });
    }
  }
  return findings;
}

// Server-local / UTC time where Africa/Nairobi is required.
const NAIROBI_ANTI_PATTERNS = [
  { re: /\bnow\.getHours\(\)/, label: 'now.getHours() (server-local hour)' },
  { re: /\bnow\.getDay\(\)/, label: 'now.getDay() (server-local weekday)' },
  // UTC-midnight only drifts as a DB window bound; `new Date(...T00:00:00Z)` is
  // legitimate weekday math, so exclude it.
  { re: /T00:00:00Z/, excludeIf: /new\s+Date\(/, label: 'UTC-midnight window (use +03:00 / Africa/Nairobi)' }
];
const NAIROBI_SCAN_FILES = ['index.js', 'src/workers/sentinel.js', 'src/workers/remediation.js'];

/** 2) Nairobi-time lint: scheduling/window code that drifts from Africa/Nairobi. */
export function lintNairobiTime(sources = [], files = NAIROBI_SCAN_FILES) {
  const findings = [];
  for (const src of sources) {
    if (!files.includes(src.path) || typeof src.text !== 'string') continue;
    const hits = [];
    src.text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const p of NAIROBI_ANTI_PATTERNS) {
        if (p.excludeIf && p.excludeIf.test(line)) continue;
        if (p.re.test(line)) hits.push({ line: i + 1, label: p.label, snippet: line.trim().slice(0, 120) });
      }
    });
    if (hits.length) {
      findings.push({
        slug: `nairobi-drift-${slugify(src.path)}`,
        severity: 'medium',
        title: `Server-local/UTC time in ${src.path}`,
        description: `${src.path} uses server-local or UTC time where Africa/Nairobi is required, so scheduled jobs and audit windows can drift by up to 3 hours.`,
        files: [src.path],
        evidence: hits.slice(0, 5),
        remediation: `Use formatNairobiDate()/getNairobiParts() with (getUTCHours()+3)%24 and +03:00 window bounds in ${src.path}.`
      });
    }
  }
  return findings;
}

/** 3) Ledger scoping lint: the vehicle-scoping guards must be present. */
export function lintLedgerScoping(sources = []) {
  const findings = [];
  const textOf = (p) => (sources.find((s) => s.path === p) || {}).text || '';
  const entryLedger = textOf('src/services/entryLedger.js');
  if (entryLedger && !entryLedger.includes(".in('vehicle_id', scoped)")) {
    findings.push({
      slug: 'ledger-scope-list',
      severity: 'medium',
      title: 'Ledger list query is not vehicle-scoped',
      description: 'src/services/entryLedger.js listLedgerEntries no longer scopes by vehicle_id.',
      files: ['src/services/entryLedger.js'],
      remediation: "Restore the `.in('vehicle_id', scoped)` guard in listLedgerEntries."
    });
  }
  const whatsapp = textOf('src/routes/whatsapp/messages.js');
  if (whatsapp.includes('queryRecordLedger(') && !whatsapp.includes('resolveLedgerVehicleScope')) {
    findings.push({
      slug: 'ledger-scope-record',
      severity: 'medium',
      title: 'Record query is not vehicle-scoped',
      description: 'src/routes/whatsapp/messages.js calls queryRecordLedger without resolveLedgerVehicleScope.',
      files: ['src/routes/whatsapp/messages.js'],
      remediation: 'Scope the record lane with resolveLedgerVehicleScope before queryRecordLedger.'
    });
  }
  return findings;
}

/** 4) Silent-failure watch: recurring unresolved error_logs by route. */
export async function lintSilentFailures(supabase, { hours = 168, threshold = 3 } = {}) {
  if (!supabase) return [];
  try {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('error_logs')
      .select('route')
      .gte('created_at', since)
      .eq('status', 'unresolved')
      .limit(2000);
    if (error) return [];
    const counts = new Map();
    for (const row of data || []) {
      const route = String(row.route || 'unknown');
      counts.set(route, (counts.get(route) || 0) + 1);
    }
    const findings = [];
    for (const [route, count] of counts.entries()) {
      if (count < threshold) continue;
      findings.push({
        slug: `silent-failure-${slugify(route)}`,
        severity: 'medium',
        title: `Recurring failures on ${route}`,
        description: `${count} unresolved error_logs entries on "${route}" in the last ${hours}h — a silent failure loop the user never sees answered.`,
        files: [],
        evidence: [{ route, count }],
        remediation: `Inspect error_logs for route "${route}"; fix the root cause or add a user-facing fallback reply.`
      });
    }
    return findings;
  } catch { return []; }
}

/** Walk the live source tree (never node_modules/.git/landing/tmp or itself). */
export function collectSourceFiles(rootDir = process.cwd()) {
  const abs = [];
  for (const f of ['index.js', 'sakaAi.js', 'reports.js']) {
    const p = path.join(rootDir, f);
    if (fs.existsSync(p)) abs.push(p);
  }
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', 'tmp', 'landing', '.github', 'supabase'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) abs.push(p);
    }
  };
  const srcDir = path.join(rootDir, 'src');
  if (fs.existsSync(srcDir)) walk(srcDir);
  const out = [];
  for (const filePath of abs) {
    const rel = path.relative(rootDir, filePath).split(path.sep).join('/');
    if (rel === 'src/services/deepAudit.js') continue;
    try { out.push({ path: rel, text: fs.readFileSync(filePath, 'utf8') }); } catch { /* skip unreadable */ }
  }
  return out;
}

/** Strip any governance-protected path from a finding; drop empties. */
export function sanitizeFinding(finding) {
  if (!finding || !finding.title || typeof finding.title !== 'string') return null;
  const files = (finding.files || []).filter((f) => typeof f === 'string' && !FORBIDDEN_PATH.test(f));
  return { ...finding, files };
}

/** v1.58.14 - log-only finding: a friction entry for a human to tend later. */
export async function mintFindingLog(supabase, { runKey, finding } = {}) {
  if (!supabase || !finding) return { ok: false, reason: 'missing' };
  if (!isDeepAuditEnabled()) return { ok: false, reason: 'disabled' };
  try {
    const { data, error } = await supabase.from('chat_friction_logs').insert([{
      user_phone: 'SENTINEL',
      session_id: 'deep_audit',
      friction_type: 'DEEP_AUDIT_FINDING',
      transcript_snippet: String(finding.title + ' :: ' + (finding.description || '')).slice(0, 2000),
      source: 'deep_audit',
      diagnosis: {
        run_key: runKey,
        slug: finding.slug,
        severity: finding.severity || 'medium',
        files: finding.files || [],
        remediation: String(finding.remediation || '').slice(0, 2000)
      },
      detected_at: new Date().toISOString()
    }]).select('id').maybeSingle();
    if (error) return { ok: false, reason: error.message };
    return { ok: true, logged: true, id: data?.id || null };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Mint one deduped PENDING_APPROVAL proposal for a finding. */
export async function mintFindingProposal(supabase, { runKey, finding } = {}) {
  if (!isSentinelProposalsEnabled()) return { ok: false, reason: 'proposals_disabled' };
  if (!supabase || !finding) return { ok: false, reason: 'missing' };
  if (!isDeepAuditEnabled()) return { ok: false, reason: 'disabled' };
  const signature = `DEEP-AUDIT:${runKey}:${finding.slug}`;
  try {
    const { data: existing } = await supabase
      .from('remediation_proposals')
      .select('proposal_code,status')
      .eq('target_signature', signature)
      .in('status', [PENDING, MODIFY])
      .limit(1);
    if (existing && existing.length) return { ok: true, duplicate: true, code: existing[0].proposal_code };

    const code = await nextProposalCode(supabase, `PROP-${formatNairobiDate()}-`);
    const { data, error } = await supabase.from('remediation_proposals').insert([{
      proposal_code: code,
      title: String(finding.title).slice(0, 80),
      category: DEEP_AUDIT_CATEGORY,
      root_cause: String(finding.description || finding.title).slice(0, 2000),
      target_signature: signature,
      risk_level: finding.severity === 'high' ? 'medium' : 'low',
      status: PENDING,
      proposed_changes: {
        overview: String(finding.remediation || finding.description || finding.title).slice(0, 2000),
        source: 'Sentinel bi-weekly deep audit',
        automation: 'deep_audit',
        finding_slug: finding.slug,
        severity: finding.severity || 'medium',
        files: finding.files || [],
        evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 5) : [],
        changes: [],
        tests: ['test_agent_training.js'],
        rollback: 'Diagnostic finding only — nothing is executed automatically.'
      },
      feedback: 'Sentinel bi-weekly deep audit finding — review and implement in a superadmin chat session.'
    }]).select('proposal_code').maybeSingle();
    if (error) return { ok: false, reason: error.message };
    return { ok: true, code: data?.proposal_code || code };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Idempotency: has this run_key already been recorded today? */
export async function hasRunThisWindow(supabase, runKey) {
  if (!supabase || !runKey) return false;
  try {
    const { data } = await supabase
      .from('admin_audit_logs')
      .select('id,details')
      .eq('action', DEEP_AUDIT_ACTION)
      .order('created_at', { ascending: false })
      .limit(25);
    return (data || []).some((row) => row.details && row.details.run_key === runKey);
  } catch { return false; }
}

/** Write the durable run marker (admin_audit_logs). Best-effort. */
export async function recordDeepAuditRun(supabase, { runKey, findings = [], summary = '' } = {}) {
  if (!supabase) return { ok: false };
  try {
    const { error } = await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SENTINEL',
      action: DEEP_AUDIT_ACTION,
      details: {
        run_key: runKey,
        findings: findings.length,
        slugs: findings.map((f) => f.slug).slice(0, 20),
        summary
      },
      created_at: new Date().toISOString()
    }]);
    return error ? { ok: false, reason: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Run all four deterministic checks over the source tree + DB. */
export async function runDeepAuditChecks({ supabase = null, sources = collectSourceFiles() } = {}) {
  const findings = [
    ...lintMojibake(sources),
    ...lintNairobiTime(sources),
    ...lintLedgerScoping(sources),
    ...await lintSilentFailures(supabase)
  ].map(sanitizeFinding).filter(Boolean);
  return findings;
}

/**
 * Top-level orchestrator: idempotency gate → checks → deduped proposals →
 * durable run marker. Never throws.
 */
export async function runDeepAudit(supabase, { dryRun = false, force = false } = {}) {
  if (!isDeepAuditEnabled()) return { status: 'disabled' };
  const runKey = `DEEP-AUDIT-${formatNairobiDate()}`;
  try {
    if (!dryRun && !force && await hasRunThisWindow(supabase, runKey)) {
      return { status: 'skipped', reason: 'already_run', runKey };
    }
    const findings = await runDeepAuditChecks({ supabase });
    const results = [];
    if (!dryRun) {
      for (const finding of findings) {
        const minted = isSentinelProposalsEnabled()
          ? await mintFindingProposal(supabase, { runKey, finding })
          : await mintFindingLog(supabase, { runKey, finding });
        results.push({ slug: finding.slug, ...minted });
      }
      const summary = findings.length
        ? `${findings.length} deep-audit finding(s): ${findings.map((f) => f.slug).join(', ')}`
        : 'No findings.';
      await recordDeepAuditRun(supabase, { runKey, findings, summary });
    }
    return {
      status: 'success',
      runKey,
      dryRun,
      findings: findings.length,
      findingsList: findings.map((f) => ({ slug: f.slug, severity: f.severity, title: f.title, files: f.files })),
      results
    };
  } catch (err) {
    return { status: 'error', error: err.message, runKey };
  }
}

export default {
  DEEP_AUDIT_ACTION,
  DEEP_AUDIT_CATEGORY,
  DEEP_AUDIT_DEFAULT_SCHEDULE,
  isDeepAuditEnabled,
  parseDeepAuditSchedule,
  lintMojibake,
  lintNairobiTime,
  lintLedgerScoping,
  lintSilentFailures,
  collectSourceFiles,
  sanitizeFinding,
  mintFindingLog,
  mintFindingProposal,
  hasRunThisWindow,
  recordDeepAuditRun,
  runDeepAuditChecks,
  runDeepAudit
};



