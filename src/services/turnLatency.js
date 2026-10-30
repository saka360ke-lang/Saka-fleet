import { createClient } from '@supabase/supabase-js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';

/**
 * Turn-latency telemetry (v1.24.1).
 *
 * One row per answered WhatsApp turn: how long the user waited from webhook
 * receipt to the final reply, and whether an instant ack was sent first.
 * It is the metric that decides whether the two-lane Cloud Tasks worker is
 * worth building (§62.3), so it must stay cheap, capped and fail-soft.
 */

export const TURN_LATENCY_TABLE = 'turn_latency_logs';
export const TURN_LATENCY_DEFAULT_WINDOW_HOURS = 24;
export const TURN_LATENCY_MAX_WINDOW_HOURS = 168;
export const TURN_LATENCY_PAGE_SIZE = Math.max(100, Number(process.env.TURN_LATENCY_PAGE_SIZE || 1000));
export const TURN_LATENCY_MAX_ROWS = Math.max(100, Number(process.env.TURN_LATENCY_MAX_ROWS || 10000));
export const TURN_LATENCY_TRIM_EVERY = Math.max(10, Number(process.env.TURN_LATENCY_TRIM_EVERY || 250));

const FALSY = new Set(['off', 'false', '0', 'no', 'disabled']);

/** Kill switch for latency writes (TURN_LATENCY_LOGGING_ENABLED, default on). */
export function isTurnLatencyLoggingEnabled() {
  return !FALSY.has(String(process.env.TURN_LATENCY_LOGGING_ENABLED || 'on').toLowerCase());
}

const TURN_LATENCY_SQL = `
CREATE TABLE IF NOT EXISTS public.turn_latency_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    phone text,
    turn_ms integer,
    ack_sent boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_turn_latency_logs_created ON public.turn_latency_logs(created_at DESC);
NOTIFY pgrst, 'reload schema';
`;

function getSupabase(providedSupabase) {
  if (providedSupabase) return providedSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials missing in environment');
  return createClient(url, key);
}

/** Ensure the latency table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureTurnLatencyTable(providedSupabase) {
  try {
    const supabase = getSupabase(providedSupabase);
    const { error } = await supabase.from(TURN_LATENCY_TABLE).select('id').limit(1);
    const missing = Boolean(error && /could not find the table/i.test(error.message || ''));
    if (missing && hasSqlAccess()) {
      const result = await runSql(TURN_LATENCY_SQL, { label: 'ensureTurnLatencyTable' });
      return { [TURN_LATENCY_TABLE]: result.ok ? 'created' : 'missing' };
    }
    return { [TURN_LATENCY_TABLE]: missing ? 'missing' : 'exists' };
  } catch (err) {
    console.warn('[TurnLatency] Table provisioning notice:', err.message);
    return { [TURN_LATENCY_TABLE]: 'unknown' };
  }
}

/**
 * Nearest-rank percentile (lower rank for even samples, like p50 elsewhere).
 * Exported for the offline regression suite.
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, Number(p) || 0));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

let writesSinceTrim = 0;
let trimInFlight = false;

/** Delete rows beyond TURN_LATENCY_MAX_ROWS (fire-and-forget, fail-soft). */
export async function trimTurnLatencyLogs(providedSupabase) {
  try {
    const supabase = getSupabase(providedSupabase);
    const { data, error } = await supabase
      .from(TURN_LATENCY_TABLE)
      .select('id')
      .order('created_at', { ascending: false })
      .range(TURN_LATENCY_MAX_ROWS, TURN_LATENCY_MAX_ROWS + 499);
    if (error || !data || data.length === 0) return 0;
    const ids = data.map((row) => row.id);
    const { error: deleteError } = await supabase.from(TURN_LATENCY_TABLE).delete().in('id', ids);
    if (deleteError) return 0;
    return ids.length;
  } catch {
    return 0;
  }
}

/** Persist one turn latency. Never throws; warns and returns false on failure. */
export async function logTurnLatency(providedSupabase, { phone = null, turnMs = null, ackSent = false } = {}) {
  try {
    if (!isTurnLatencyLoggingEnabled()) return false;
    if (!Number.isFinite(turnMs) || turnMs < 0) return false;
    const supabase = getSupabase(providedSupabase);
    const { error } = await supabase.from(TURN_LATENCY_TABLE).insert([{
      phone: phone ? String(phone).slice(0, 32) : null,
      turn_ms: Math.round(turnMs),
      ack_sent: ackSent === true,
      created_at: new Date().toISOString()
    }]);
    if (error) {
      console.warn('[TurnLatency] insert skipped:', error.message);
      return false;
    }
    writesSinceTrim += 1;
    if (writesSinceTrim >= TURN_LATENCY_TRIM_EVERY && !trimInFlight) {
      writesSinceTrim = 0;
      trimInFlight = true;
      void trimTurnLatencyLogs(supabase)
        .catch(() => {})
        .finally(() => { trimInFlight = false; });
    }
    return true;
  } catch (err) {
    console.warn('[TurnLatency] logging skipped:', err.message);
    return false;
  }
}

/**
 * Aggregate reply latency for the Superadmin digest. Fail-soft: returns
 * `{ ok: false, error }` with zeroed figures instead of throwing.
 */
export async function getTurnLatencySummary(providedSupabase, hours = TURN_LATENCY_DEFAULT_WINDOW_HOURS) {
  const requested = Number(hours);
  const windowHours = Math.min(
    TURN_LATENCY_MAX_WINDOW_HOURS,
    Math.max(1, Math.round(Number.isFinite(requested) && requested > 0 ? requested : TURN_LATENCY_DEFAULT_WINDOW_HOURS))
  );
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const generatedAt = new Date().toISOString();

  const summary = {
    ok: true,
    hours: windowHours,
    since,
    generatedAt,
    turns: 0,
    ackTurns: 0,
    ackRate: null,
    avgMs: null,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    truncated: false,
    error: null
  };

  try {
    const supabase = getSupabase(providedSupabase);
    const latencies = [];
    let ackTurns = 0;
    let fetched = 0;
    let exhausted = false;

    while (fetched < TURN_LATENCY_MAX_ROWS) {
      const pageSize = Math.min(TURN_LATENCY_PAGE_SIZE, TURN_LATENCY_MAX_ROWS - fetched);
      const { data, error } = await supabase
        .from(TURN_LATENCY_TABLE)
        .select('id,turn_ms,ack_sent')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(fetched, fetched + pageSize - 1);

      if (error) throw new Error(error.message || 'latency query failed');

      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        if (Number.isFinite(row.turn_ms)) latencies.push(row.turn_ms);
        if (row.ack_sent === true) ackTurns += 1;
      }

      fetched += rows.length;
      if (rows.length < pageSize) {
        exhausted = true;
        break;
      }
    }

    summary.turns = latencies.length;
    summary.ackTurns = ackTurns;
    summary.ackRate = latencies.length ? ackTurns / latencies.length : null;
    summary.avgMs = latencies.length
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null;
    summary.p50Ms = percentile(latencies, 50);
    summary.p95Ms = percentile(latencies, 95);
    summary.p99Ms = percentile(latencies, 99);
    summary.truncated = !exhausted;

    return summary;
  } catch (err) {
    return { ...summary, ok: false, error: err.message || 'latency query failed' };
  }
}

export default {
  TURN_LATENCY_TABLE,
  ensureTurnLatencyTable,
  isTurnLatencyLoggingEnabled,
  logTurnLatency,
  trimTurnLatencyLogs,
  getTurnLatencySummary,
  percentile
};
