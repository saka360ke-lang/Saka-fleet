/**
 * Saka Fleet — env & secret parity audit (v1.32.4)
 * ------------------------------------------------
 * Answers three questions without exposing a single value:
 *   1. LOCAL  — does .env carry every required key and match .env.example?
 *   2. REMOTE — what does the LIVE revision actually have? (self-reporting
 *      secret-gated /internal/status; no gcloud or service account needed)
 *   3. CLOUD  — optional: which secrets are mounted as PLAIN env vars instead of
 *      --set-secrets? (only when `gcloud` is installed and authenticated)
 *
 * Usage:
 *   npm run env:audit              local audit (.env vs .env.example)
 *   npm run env:audit -- --remote  add the live Cloud Run revision
 *   npm run env:audit -- --cloud   add the gcloud secret-mounting check
 *   npm run env:audit -- --json    machine-readable output
 *
 * Exit code 1 = a required key is missing or the registry drifted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  auditEnv,
  formatEnvDigest,
  envFingerprint,
  envTemplateKeys,
  plaintextSecretWarnings,
  SECRET_ENV,
  ENV_IGNORE,
  ENV_REGISTRY
} from '../src/services/envAudit.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

/** Minimal .env reader (KEY=VALUE, # comments) — no dependency, no writes. */
function loadDotEnv(filePath = '.env') {
  const loaded = {};
  if (!fs.existsSync(filePath)) return loaded;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    loaded[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return loaded;
}

/** Every env key the code actually reads (skips tests, node_modules, tmp). */
function scanCodeKeys(root = process.cwd()) {
  const keys = new Set();
  const skip = new Set(['node_modules', '.git', 'tmp', '.github', 'docs']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.(js|mjs)$/.test(entry.name) || /^test_/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
        keys.add(match[1] || match[2]);
      }
    }
  };
  try {
    walk(root);
  } catch { /* best effort */ }
  return [...keys];
}

async function fetchRemoteStatus() {
  const base = String(process.env.PUBLIC_APP_URL || 'https://app.sakafleet.com').replace(/\/+$/, '');
  const secret = process.env.SENTINEL_SECRET || '';
  if (!secret) return { ok: false, error: 'SENTINEL_SECRET is not set locally — the remote audit needs it.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${base}/internal/status`, {
      headers: { 'x-saka-secret': secret, accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} from ${base}/internal/status` };
    return { ok: true, base, payload: await response.json() };
  } catch (err) {
    return { ok: false, error: `${err.message} (${base}/internal/status)` };
  } finally {
    clearTimeout(timer);
  }
}


function cloudSecretReport() {
  try {
    execFileSync('gcloud', ['--version'], { stdio: 'ignore' });
  } catch {
    return { ok: false, error: 'gcloud is not installed here — run --cloud from a workstation that has gcloud.' };
  }
  try {
    const raw = execFileSync('gcloud', [
      'run', 'services', 'describe', process.env.CLOUD_RUN_SERVICE || 'saka-fleet',
      '--region', process.env.CLOUD_RUN_REGION || 'europe-west1',
      '--format=json'
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const service = JSON.parse(raw);
    const container = service?.spec?.template?.spec?.containers?.[0] || {};
    const env = Array.isArray(container.env) ? container.env : [];
    const plain = env.filter((item) => !item.valueFrom?.secretKeyRef).map((item) => item.name);
    const secretRefs = env.filter((item) => item.valueFrom?.secretKeyRef).map((item) => item.name);
    const plaintextSecrets = SECRET_ENV.filter((key) => plain.includes(key));
    return { ok: true, plainKeys: plain.length, plaintextSecrets, secretRefs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const templateKeys = envTemplateKeys();
  const fileEnv = loadDotEnv();
  // Fill in anything the shell did not provide so `--remote` can read
  // SENTINEL_SECRET / PUBLIC_APP_URL from .env (never overwrites a real value).
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
  const localEnv = { ...fileEnv, ...process.env };
  const codeKeys = scanCodeKeys();

  const local = auditEnv(localEnv, { templateKeys, codeKeys });
  console.log(formatEnvDigest(local, { label: 'LOCAL (.env vs .env.example)' }));
  console.log(`Registry: ${ENV_REGISTRY.length} knobs · ignored platform keys: ${ENV_IGNORE.length} · code reads: ${codeKeys.length}`);
  if (local.undocumented.length) console.log(`Runtime keys nobody documented: ${local.undocumented.join(', ')}`);
  if (local.codeDrift.length) console.log(`Code reads unregistered keys: ${local.codeDrift.join(', ')}`);
  if (local.templateDrift.length) console.log(`Registered but undocumented: ${local.templateDrift.join(', ')}`);

  let remote = null;
  if (has('--remote')) {
    console.log('\n--- REMOTE (live Cloud Run revision) ---');
    remote = await fetchRemoteStatus();
    if (!remote.ok) console.log(`WARN ${remote.error}`);
    else {
      const info = remote.payload?.env;
      console.log(`revision: ${remote.payload?.revision || 'n/a'} · service: ${remote.payload?.service || 'n/a'}`);
      console.log(`shortLinks: ${JSON.stringify(remote.payload?.shortLinks || null)}`);
      if (!info) console.log('WARN: the live revision returned no env block (it predates v1.32.4).');
      else {
        console.log(`env: ${info.present}/${info.total} registered keys · fingerprint ${info.fingerprint}`);
        if (info.missingRequired?.length) console.log(`FAIL Live is MISSING required: ${info.missingRequired.join(', ')}`);
        if (info.missingRecommended?.length) console.log(`WARN Live is missing recommended: ${info.missingRecommended.join(', ')}`);
        if (info.templateDrift?.length) console.log(`NOTE Live build predates: ${info.templateDrift.join(', ')}`);
        if (info.placeholders?.length) console.log(`WARN Live still carries template values: ${info.placeholders.join(', ')}`);
        console.log(`local fingerprint: ${local.fingerprint}${local.fingerprint === info.fingerprint ? ' (same names & lengths)' : ' (differs)'}`);
      }
    }
  }

  let cloud = null;
  if (has('--cloud')) {
    console.log('\n--- CLOUD (secret mounting) ---');
    cloud = cloudSecretReport();
    if (!cloud.ok) console.log(`WARN ${cloud.error}`);
    else {
      console.log(`plain env vars: ${cloud.plainKeys} · secret refs: ${cloud.secretRefs.length}`);
      console.log(cloud.plaintextSecrets.length
        ? `FAIL Mount these with --set-secrets: ${cloud.plaintextSecrets.join(', ')}`
        : 'OK: no known secret is mounted as a plain env var.');
    }
  }

  if (has('--json')) {
    console.log(JSON.stringify({ local, remote, cloud, plaintextCandidates: plaintextSecretWarnings(localEnv) }, null, 2));
  }

  const remoteBroken = Boolean(remote?.ok && remote.payload?.env && remote.payload.env.ok === false);
  if (!local.ok || remoteBroken) {
    console.log('\nenv parity FAILED — fix the FAIL lines above.');
    process.exitCode = 1;
  } else {
    console.log('\nenv parity OK');
  }
}

main().catch((err) => {
  console.error('env audit crashed:', err.message);
  process.exitCode = 1;
});
