import { createClient } from '@supabase/supabase-js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { setAiUsageSink } from './aiClient.js';

/**
 * Saka Fleet — AI Usage Telemetry (v1.12.0, Phase 0)
 * -------------------------------------------------
 * Every chatCompletion() outcome is emitted to the sink installed here and
 * written to `public.ai_usage_logs` FIRE-AND-FORGET: a slow or failing insert
 * can never block a WhatsApp turn or a Sentinel scan.
 *
 * Telemetry is operational (not a governance ledger): retention is bounded by
 * AI_USAGE_LOG_MAX_ROWS, trimmed every AI_USAGE_TRIM_EVERY writes.
 */

export const AI_USAGE_TABLE = 'ai_usage_logs';
export const AI_USAGE_LOG_MAX_ROWS = Math.max(100, Number(process.env.AI_USAGE_LOG_MAX_ROWS || 10000));
export const AI_USAGE_TRIM_EVERY = Math.max(1, Number(process.env.AI_USAGE_TRIM_EVERY || 250));

const FALSY = new Set(['off', 'false', '0']);

/** Kill switch for telemetry writes (AI_USAGE_LOGGING_ENABLED, default on). */
export function isAiUsageLoggingEnabled() {
  return !FALSY.has(String(process.env.AI_USAGE_LOGGING_ENABLED || 'on').toLowerCase());
}

const AI_USAGE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    purpose text,
    tier integer,
    provider text,
    model text,
    latency_ms integer,
    ok boolean,
    error text,
    input_chars integer,
    prompt_tokens integer,
    completion_tokens integer,
    created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created ON public.ai_usage_logs(created_at DESC);
NOTIFY pgrst, 'reload schema';
`;

function getSupabase(providedSupabase) {
  if (providedSupabase) return providedSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials missing in environment');
  return createClient(url, key);
}

/** Ensure the telemetry table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureAiUsageLogsTable(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  const statusMap = {};

  const { error } = await supabase.from(AI_USAGE_TABLE).select('id').limit(1);
  const missing = error && error.message && error.message.includes('Could not find the table');
  statusMap[AI_USAGE_TABLE] = missing ? 'missing' : 'exists';

  if (missing && hasSqlAccess()) {
    try {
      const result = await runSql(AI_USAGE_TABLE_SQL, { label: 'ensureAiUsageLogsTable' });
      if (result.ok) statusMap[AI_USAGE_TABLE] = 'created';
    } catch (err) {
      console.warn('[AiUsageLog] Table creation notice:', err.message);
    }
  }

  return statusMap;
}

let writesSinceTrim = 0;
let trimInFlight = false;

/** Delete rows beyond AI_USAGE_LOG_MAX_ROWS (fire-and-forget, fail-soft). */
export async function trimAiUsageLogs(providedSupabase) {
  try {
    const supabase = getSupabase(providedSupabase);
    const { data, error } = await supabase
      .from(AI_USAGE_TABLE)
      .select('id')
      .order('created_at', { ascending: false })
      .range(AI_USAGE_LOG_MAX_ROWS, AI_USAGE_LOG_MAX_ROWS + 499);
    if (error || !data || data.length === 0) return 0;
    const ids = data.map((row) => row.id);
    const { error: deleteError } = await supabase.from(AI_USAGE_TABLE).delete().in('id', ids);
    if (deleteError) return 0;
    return ids.length;
  } catch {
    return 0;
  }
}

function toRow(record = {}) {
  return {
    purpose: record.purpose ? String(record.purpose).slice(0, 64) : 'unknown',
    tier: Number.isInteger(record.tier) ? record.tier : null,
    provider: record.provider ? String(record.provider).slice(0, 32) : null,
    model: record.model ? String(record.model).slice(0, 64) : null,
    latency_ms: Number.isFinite(record.latencyMs) ? Math.round(record.latencyMs) : null,
    ok: record.ok === true,
    error: record.error ? String(record.error).slice(0, 500) : null,
    input_chars: Number.isFinite(record.inputChars) ? Math.round(record.inputChars) : null,
    prompt_tokens: Number.isFinite(record.promptTokens) ? Math.round(record.promptTokens) : null,
    completion_tokens: Number.isFinite(record.completionTokens) ? Math.round(record.completionTokens) : null,
    created_at: new Date().toISOString()
  };
}

/** Persist one usage record. Never throws; warns and returns false on failure. */
export async function logAiUsage(providedSupabase, record = {}) {
  try {
    const supabase = getSupabase(providedSupabase);
    const { error } = await supabase.from(AI_USAGE_TABLE).insert([toRow(record)]);
    if (error) {
      console.warn('[AiUsageLog] insert skipped:', error.message);
      return false;
    }
    writesSinceTrim += 1;
    if (writesSinceTrim >= AI_USAGE_TRIM_EVERY && !trimInFlight) {
      writesSinceTrim = 0;
      trimInFlight = true;
      void trimAiUsageLogs(supabase)
        .catch(() => {})
        .finally(() => { trimInFlight = false; });
    }
    return true;
  } catch (err) {
    console.warn('[AiUsageLog] logging skipped:', err.message);
    return false;
  }
}

/**
 * Wire aiClient's telemetry sink to Supabase. Called once at boot; harmless to
 * call twice. The returned promise from the sink is intentionally not awaited.
 */
export function installAiUsageSink(providedSupabase) {
  setAiUsageSink((record) => {
    if (!isAiUsageLoggingEnabled()) return undefined;
    return logAiUsage(providedSupabase, record);
  });
  return true;
}

export default {
  ensureAiUsageLogsTable,
  logAiUsage,
  installAiUsageSink,
  trimAiUsageLogs,
  isAiUsageLoggingEnabled
};
