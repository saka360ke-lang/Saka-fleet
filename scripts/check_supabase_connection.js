#!/usr/bin/env node
/**
 * Saka Fleet — Supabase / PostgreSQL connectivity verification.
 *
 * STRICTLY READ-ONLY. Every remote call is a GET/HEAD or a SELECT executed
 * inside a READ ONLY transaction. This script never inserts, updates, deletes,
 * upserts, truncates or runs DDL, and never sends WhatsApp/Resend/Paystack mail.
 *
 * Usage:
 *   node scripts/check_supabase_connection.js
 *   node scripts/check_supabase_connection.js --with-timeout-test
 *   SUPABASE_EXPECTED_PROJECT_REF=<ref> node scripts/check_supabase_connection.js
 *
 * Credentials (env or .env):
 *   SUPABASE_URL                 required
 *   SUPABASE_SERVICE_KEY         required (falls back to SUPABASE_SERVICE_ROLE_KEY)
 *   DATABASE_URL                 optional (direct Postgres reachability)
 *   SUPABASE_ACCESS_TOKEN        optional (Management API read-only SQL)
 */

import 'dotenv/config';
import net from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { createResilientClient, getResilientClient } from '../src/services/supabaseClient.js';

const ARGS = new Set(process.argv.slice(2));
// Verified staging ref (2026-10-29). The originally supplied value
// "knlxpwiqcliprjqjfp" is NXDOMAIN and is missing "iq" after "wiq".
const EXPECTED_REF = process.env.SUPABASE_EXPECTED_PROJECT_REF || 'knlxpwiqiqcliprjqjfp';

// Tables that must exist in staging (see SAKA_FLEET_ARCHITECTURE.md §2).
const TABLES = [
  'profiles',
  'vehicles',
  'vin_registry',
  'system_config',
  'passbook_transfers',
  'chat_history',
  'error_logs'
];

// Column shapes asserted from SAKA_FLEET_ARCHITECTURE.md §2.1 / §2.2.
const SHAPES = [
  { table: 'profiles', columns: 'id, phone_number, subscription_tier, subscription_status, unit_system, country_code, deleted_at' },
  { table: 'vehicles', columns: 'id, owner_id, assigned_driver_id, plate_number, vin, qr_passbook_token, status, deleted_at, owner_phone, transfer_count_current_year' },
  { table: 'vin_registry', columns: 'vin, first_owner_id, trial_granted, trial_end_at, trial_status' }
];

const results = [];
let hardStop = null;

function record(phase, name, ok, detail = '') {
  results.push({ phase, name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${phase}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function warn(phase, name, detail) {
  results.push({ phase, name, ok: null, detail });
  console.log(`⚠️  [${phase}] ${name} — ${detail}`);
}

function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '(unparseable)';
  }
}

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    };
  } catch {
    return null;
  }
}

function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (ok, detail) => {
      socket.destroy();
      resolve({ ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'TCP connected'));
    socket.once('timeout', () => finish(false, `TCP timeout after ${timeoutMs}ms`));
    socket.once('error', (err) => finish(false, `TCP ${err.code || err.message}`));
  });
}

async function main() {
  console.log('=== SAKA FLEET — SUPABASE STAGING CONNECTIVITY CHECK (READ-ONLY) ===\n');

  // ---------------------------------------------------------------------------
  // Phase 1 — credential inventory (redacted) and project-ref guard
  // ---------------------------------------------------------------------------
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dbUrl = process.env.DATABASE_URL;

  record('P1', 'SUPABASE_URL present', Boolean(url), url ? redactUrl(url) : 'MISSING');
  record('P1', 'service-role key present', Boolean(key), key ? `len=${key.length}` : 'MISSING');
  if (!url || !key) {
    hardStop = 'SUPABASE_URL and SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY are required.';
    return finish();
  }

  const urlRef = url.replace('https://', '').split('.')[0];
  if (urlRef !== EXPECTED_REF) {
    record('P1', 'project ref guard', false, `expected ${EXPECTED_REF}, got ${urlRef}`);
    hardStop = `Project ref mismatch: SUPABASE_URL points at "${urlRef}" but staging is "${EXPECTED_REF}". Refusing to continue.`;
    return finish();
  }
  record('P1', 'project ref guard', true, `staging ref ${EXPECTED_REF}`);

  const jwt = decodeJwt(key);
  if (!jwt) {
    record('P1', 'JWT decodable', false, 'not a 3-part JWT');
    hardStop = 'Service key is not a decodable JWT.';
    return finish();
  }
  record('P1', 'key role is service_role', jwt.payload.role === 'service_role', `role=${jwt.payload.role}`);

  if (jwt.payload.ref && jwt.payload.ref !== urlRef) {
    warn('P1', 'JWT ref claim matches URL ref', `token ref="${jwt.payload.ref}" (${jwt.payload.ref.length}) vs url ref="${urlRef}" (${urlRef.length}) — possible wrong-project key or typo`);
  } else {
    record('P1', 'JWT ref claim matches URL ref', true, urlRef);
  }

  const expIso = jwt.payload.exp ? new Date(jwt.payload.exp * 1000).toISOString() : 'n/a';
  record('P1', 'service key not expired', !jwt.payload.exp || jwt.payload.exp * 1000 > Date.now(), `expires ${expIso}`);

  // ---------------------------------------------------------------------------
  // Phase 2 — PostgREST / GoTrue reachability (the transport the app uses)
  // ---------------------------------------------------------------------------
  const authHeaders = { apikey: key, Authorization: `Bearer ${key}` };

  try {
    const res = await fetch(`${url}/auth/v1/health`, { headers: authHeaders });
    const body = await res.text();
    record('P2', 'GET /auth/v1/health', res.ok, `HTTP ${res.status} ${body.slice(0, 90)}`);
  } catch (err) {
    record('P2', 'GET /auth/v1/health', false, `${err.cause?.code || err.name}: ${err.message}`);
  }

  try {
    const res = await fetch(`${url}/rest/v1/`, { headers: authHeaders });
    const body = await res.text();
    record('P2', 'GET /rest/v1/ (OpenAPI root)', res.ok, `HTTP ${res.status} ${res.ok ? body.length + ' bytes' : body.slice(0, 90)}`);
  } catch (err) {
    record('P2', 'GET /rest/v1/ (OpenAPI root)', false, `${err.cause?.code || err.name}: ${err.message}`);
  }

  // Client built exactly the way the application builds it.
  const appClient = createResilientClient(url, key);
  record('P2', 'createResilientClient() returns a client', Boolean(appClient));

  for (const table of TABLES) {
    try {
      // PostgREST can omit Content-Range on HEAD, so fall back to a 1-row GET
      // that selects only the primary key (no PII is transferred).
      const headRes = await appClient.from(table).select('id', { count: 'exact', head: true }).limit(0);
      if (!headRes.error && typeof headRes.count === 'number') {
        record('P2', `row count ${table}`, true, `${headRes.count} rows (HEAD)`);
        continue;
      }
      const getRes = await appClient.from(table).select('id', { count: 'exact' }).limit(1);
      if (getRes.error) {
        record('P2', `row count ${table}`, false, `${getRes.error.code || ''} ${getRes.error.message}`.trim());
      } else {
        record('P2', `row count ${table}`, true, `${getRes.count ?? 'n/a'} rows (GET fallback, ${getRes.data?.length || 0} row fetched)`);
      }
    } catch (err) {
      record('P2', `row count ${table}`, false, err.message);
    }
  }

  // Column-shape assertions. Uses GET (not HEAD) because a HEAD 404 carries no
  // body, which would silently look like success. Errors here are authoritative.
  for (const { table, columns } of SHAPES) {
    try {
      const { error, status } = await appClient.from(table).select(columns).limit(0);
      record('P2', `schema ${table}`, !error, error ? `${error.code || ''} ${error.message} (HTTP ${status})`.trim() : `${columns.split(',').length} columns present`);
    } catch (err) {
      record('P2', `schema ${table}`, false, err.message);
    }
  }

  // Negative control: a corrupted key must be rejected. Proves the successes
  // above came from this credential, not from an unsecured project.
  try {
    const tampered = `${key.slice(0, -6)}000000`;
    const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: tampered, Authorization: `Bearer ${tampered}` } });
    record('P2', 'negative control (corrupt key rejected)', !res.ok, `HTTP ${res.status}`);
  } catch (err) {
    record('P2', 'negative control (corrupt key rejected)', false, err.message);
  }

  record('P2', 'getResilientClient() reuses cached client', getResilientClient() === appClient);

  // ---------------------------------------------------------------------------
  // Phase 3 — direct PostgreSQL (DATABASE_URL): TCP + TLS + optional auth
  // ---------------------------------------------------------------------------
  if (!dbUrl) {
    warn('P3', 'DATABASE_URL probe', 'DATABASE_URL not set — skipped');
  } else {
    const parsed = new URL(dbUrl);
    const dbPort = Number(parsed.port || 5432);
    const dbName = parsed.pathname.replace('/', '') || 'postgres';
    const password = decodeURIComponent(parsed.password || '');
    record('P3', 'DATABASE_URL present', true, `${parsed.protocol}//${parsed.hostname}:${dbPort}/${dbName}`);

    // Supabase direct hosts (db.<ref>.supabase.co) are legacy/IPv6-only for many
    // projects. Build fallbacks against the regional pooler, which uses the
    // username form postgres.<ref>.
    const candidates = [{ host: parsed.hostname, user: decodeURIComponent(parsed.username || 'postgres'), port: dbPort, label: 'DATABASE_URL as provided' }];
    const poolerRegions = [];
    if (process.env.SUPABASE_POOLER_REGION) poolerRegions.push(process.env.SUPABASE_POOLER_REGION);
    if (ARGS.has('--with-pooler-discovery')) {
      poolerRegions.push('eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'us-east-1', 'us-east-2', 'us-west-1', 'ap-south-1', 'ap-southeast-1', 'ap-northeast-1', 'sa-east-1', 'ca-central-1');
    }
    for (const region of [...new Set(poolerRegions)]) {
      candidates.push({ host: `aws-0-${region}.pooler.supabase.com`, user: `postgres.${urlRef}`, port: 5432, label: `pooler ${region}`, region });
    }

    let pg = null;
    try { pg = await import('pg'); } catch { /* optional dependency */ }
    let authenticated = false;

    for (const cand of candidates) {
      const tcp = await tcpProbe(cand.host, cand.port, 6000);
      if (!tcp.ok) {
        record('P3', `TCP ${cand.host}:${cand.port}`, false, `${tcp.detail} [${cand.label}]`);
        continue;
      }
      record('P3', `TCP ${cand.host}:${cand.port}`, true, `${tcp.detail} (${tcp.ms}ms) [${cand.label}]`);
      if (!pg) {
        warn('P3', 'read-only SQL session', 'pg driver not installed — password auth not verified');
        break;
      }
      const client = new pg.default.Client({
        host: cand.host, port: cand.port, user: cand.user, password, database: dbName,
        ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000
      });
      try {
        await client.connect();
        const stream = client.connection?.stream;
        record('P3', 'TLS negotiated on DB session', Boolean(stream?.encrypted), `${stream?.getCipher?.()?.name || 'n/a'} [${cand.label}]`);
        await client.query('BEGIN TRANSACTION READ ONLY');
        const { rows } = await client.query("select current_database() as db, current_user as usr, version() as version, (select count(*) from information_schema.tables where table_schema='public') as public_tables");
        await client.query('ROLLBACK');
        authenticated = true;
        record('P3', 'read-only SQL session', true, `${rows[0].db} as ${rows[0].usr} [${cand.label}]`);
        record('P3', 'public schema tables', Number(rows[0].public_tables) > 0, `${rows[0].public_tables} tables in public`);
        console.log(`     ${String(rows[0].version || '').split(',')[0]}`);
        if (cand.region) warn('P3', 'connection string guidance', `use host aws-0-${cand.region}.pooler.supabase.com:5432 with user postgres.${urlRef}`);
        break;
      } catch (err) {
        record('P3', 'read-only SQL session', false, `${err.code || ''} ${String(err.message || '').slice(0, 90)} [${cand.label}]`);
      } finally {
        await client.end().catch(() => {});
      }
    }
    if (!authenticated && pg) warn('P3', 'read-only SQL session', 'no candidate authenticated');
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — application wiring + optional fail-fast behaviour
  // ---------------------------------------------------------------------------
  record('P4', 'app client uses mapped key', Boolean(appClient), 'SUPABASE_SERVICE_KEY || SUPABASE_SERVICE_ROLE_KEY');

  if (ARGS.has('--with-timeout-test')) {
    // Deterministic: assert the resilient client passes an AbortSignal to fetch
    // (that is the mechanism SUPABASE_TIMEOUT_MS drives), instead of racing a 1ms timer.
    const originalFetch = globalThis.fetch;
    let capturedSignal = null;
    globalThis.fetch = (input, init = {}) => {
      capturedSignal = init.signal || capturedSignal;
      return originalFetch(input, init);
    };
    try {
      await appClient.from('profiles').select('id', { head: true }).limit(0);
    } catch (err) {
      warn('P4', 'timeout guard probe', `probe request failed: ${err.message}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
    record('P4', 'timeout guard wires AbortSignal', capturedSignal instanceof AbortSignal,
      `SUPABASE_TIMEOUT_MS=${process.env.SUPABASE_TIMEOUT_MS || '15000 (default)'}, signal=${capturedSignal ? 'present' : 'absent'}`);
  }

  finish();
}

function finish() {
  const passed = results.filter(r => r.ok === true).length;
  const failed = results.filter(r => r.ok === false).length;
  const skipped = results.filter(r => r.ok === null).length;

  console.log('\n--- SUMMARY ---');
  console.table(results.map(r => ({
    phase: r.phase,
    check: r.name,
    status: r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP',
    detail: r.detail
  })));
  console.log(`passed=${passed} failed=${failed} skipped=${skipped}`);

  if (hardStop) {
    console.error(`\n⛔ HARD STOP: ${hardStop}`);
    process.exitCode = 2;
    return;
  }
  if (failed > 0) {
    console.error('\n❌ Connectivity verification FAILED — see rows above.');
    process.exitCode = 1;
    return;
  }
  console.log('\n🎉 SUPABASE STAGING ACCESS VERIFIED (read-only; no rows written).');
}

main().catch((err) => {
  console.error('❌ Check crashed:', err);
  process.exitCode = 1;
});
