/**
 * Saka Fleet — SQL runner for schema migrations.
 *
 * DDL cannot go through PostgREST, so migrations need one of two transports:
 *   1. Supabase Management API  — requires SUPABASE_ACCESS_TOKEN (preferred;
 *      the original behaviour of every migration in this repo).
 *   2. Direct Postgres          — requires DATABASE_URL and the optional `pg`
 *      driver (`npm i -D pg`), used when no access token is configured.
 *
 * `runSql` never throws: callers get `{ ok, via, status, body, error }` and
 * degrade gracefully, matching the existing fail-soft migration behaviour.
 */

const TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS || 15000);

export function getProjectRef() {
  return (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];
}

export function hasSqlAccess() {
  return Boolean(process.env.SUPABASE_ACCESS_TOKEN || process.env.DATABASE_URL);
}

async function runViaManagementApi(sql) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = getProjectRef();
  if (!token || !projectRef) return { ok: false, via: 'management-api', error: 'Missing SUPABASE_ACCESS_TOKEN or SUPABASE_URL' };

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(Math.max(TIMEOUT_MS, 60000))
  });
  const body = await res.text();
  return { ok: res.ok, via: 'management-api', status: res.status, body };
}

/**
 * Build a pg client config from DATABASE_URL.
 *
 * `sslmode` is stripped deliberately: pg-connection-string maps it to full
 * certificate verification, which fails against the Supabase pooler's chain
 * (`SELF_SIGNED_CERT_IN_CHAIN`). TLS is still enforced, just without CA pinning.
 */
function pgClientConfig() {
  const parsed = new URL(process.env.DATABASE_URL);
  parsed.searchParams.delete('sslmode');
  parsed.searchParams.delete('uselibpqcompat');
  return {
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: Math.max(TIMEOUT_MS, 15000),
    statement_timeout: Math.max(TIMEOUT_MS, 120000)
  };
}

async function runViaPg(sql) {
  let pg = null;
  try {
    pg = await import('pg');
  } catch {
    return { ok: false, via: 'pg', error: 'DATABASE_URL set but the optional `pg` driver is not installed (npm i -D pg)' };
  }

  const client = new pg.default.Client(pgClientConfig());
  try {
    await client.connect();
    await client.query(sql);
    return { ok: true, via: 'pg', status: 200, body: 'ok' };
  } catch (err) {
    return { ok: false, via: 'pg', error: `${err.code || ''} ${err.message}`.trim(), detail: err.detail, hint: err.hint };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Execute a DDL/DML batch over the best available transport.
 * @param {string} sql
 * @param {{ label?: string }} [options]
 */
export async function runSql(sql, { label = 'sql' } = {}) {
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    try {
      const result = await runViaManagementApi(sql);
      if (!result.ok) console.warn(`[sqlRunner] ${label} via management-api failed:`, result.status, String(result.body || '').slice(0, 400));
      return result;
    } catch (err) {
      return { ok: false, via: 'management-api', error: err.message };
    }
  }
  if (process.env.DATABASE_URL) {
    const result = await runViaPg(sql);
    if (!result.ok) console.warn(`[sqlRunner] ${label} via pg failed:`, result.error);
    return result;
  }
  return { ok: false, via: 'none', error: 'No SQL transport configured (set SUPABASE_ACCESS_TOKEN or DATABASE_URL)' };
}

export default { runSql, hasSqlAccess, getProjectRef };
