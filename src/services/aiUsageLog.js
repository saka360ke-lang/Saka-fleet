import { createClient } from '@supabase/supabase-js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { setAiUsageSink, setBudgetGuard } from './aiClient.js';

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

// Analytics window bounds for getAiUsageSummary() (v1.13.0).
export const AI_USAGE_DEFAULT_WINDOW_HOURS = 24;
export const AI_USAGE_MAX_WINDOW_HOURS = 168;
// PostgREST pages the table at most 1000 rows per request by default.
export const AI_USAGE_PAGE_SIZE = Math.max(100, Math.min(1000, Number(process.env.AI_USAGE_PAGE_SIZE || 1000)));

/**
 * Approximate public list prices (USD per 1M tokens) used ONLY by the
 * Superadmin cost-performance digest. Informational, never billing — update
 * when a provider changes pricing. `match: null` is the provider default.
 */
export const AI_USAGE_COST_RULES = Object.freeze([
  { provider: 'deepseek', match: /reasoner/i, input: 0.55, output: 2.19 },
  { provider: 'deepseek', match: null, input: 0.27, output: 1.10 },
  { provider: 'anthropic', match: /opus/i, input: 15, output: 75 },
  { provider: 'anthropic', match: /sonnet/i, input: 3, output: 15 },
  { provider: 'anthropic', match: /haiku/i, input: 1, output: 5 },
  { provider: 'anthropic', match: null, input: 3, output: 15 },
  { provider: 'openai', match: null, input: 2.5, output: 10 }
]);

const FALSY = new Set(['off', 'false', '0']);

/** Resolve the approximate price rule for a provider/model pair (or null). */
function resolveCostRule(provider, model) {
  const providerKey = String(provider || '').toLowerCase();
  const modelKey = String(model || '').toLowerCase();
  for (const rule of AI_USAGE_COST_RULES) {
    if (rule.provider !== providerKey) continue;
    if (!rule.match || rule.match.test(modelKey)) return rule;
  }
  return null;
}

/** Estimate the USD cost of one call. Returns null when pricing is unknown. */
export function estimateAiUsageCostUsd(provider, model, promptTokens = 0, completionTokens = 0) {
  const rule = resolveCostRule(provider, model);
  if (!rule) return null;
  const prompt = Number.isFinite(promptTokens) ? promptTokens : 0;
  const completion = Number.isFinite(completionTokens) ? completionTokens : 0;
  return (prompt / 1e6) * rule.input + (completion / 1e6) * rule.output;
}

/* ------------------------------------------------------------------ */
/* Daily budget guardrail (Phase 3, v1.14.0)                            */
/* ------------------------------------------------------------------ */

// Read dynamically so env changes/tests never require a module reload.
export function getAiDailyBudgetUsd() {
  const value = Number(process.env.AI_DAILY_BUDGET_USD || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function getAiBudgetAlertPct() {
  return Math.min(100, Math.max(1, Number(process.env.AI_BUDGET_ALERT_PCT || 80)));
}

// Budget checks are cached as a promise so concurrent turns share one query.
export const AI_BUDGET_CACHE_TTL_MS = 60000;
let budgetCache = { promise: null, checkedAt: 0 };

export function resetAiBudgetGuardCache() {
  budgetCache = { promise: null, checkedAt: 0 };
}

/** Pure budget status derived from an existing summary (no extra query). */
export function computeAiBudgetStatus(summary = {}) {
  const budgetUsd = getAiDailyBudgetUsd();
  const alertPct = getAiBudgetAlertPct();
  const spentUsd = Number.isFinite(summary.approxCostUsd) ? summary.approxCostUsd : 0;
  if (!budgetUsd) {
    return {
      enabled: false,
      budgetUsd: 0,
      spentUsd,
      pct: null,
      alertPct,
      overBudget: false,
      unpricedTokens: summary.unpricedTokens || 0
    };
  }
  return {
    enabled: true,
    budgetUsd,
    spentUsd,
    pct: spentUsd / budgetUsd,
    alertPct,
    overBudget: spentUsd >= budgetUsd,
    unpricedTokens: summary.unpricedTokens || 0
  };
}

/** Rolling 24 h budget check. Fail-soft: never throws. */
export async function checkAiDailyBudget(providedSupabase, now = new Date()) {
  if (!getAiDailyBudgetUsd()) {
    return { ...computeAiBudgetStatus({}), windowHours: 24, error: null };
  }
  try {
    const summary = await getAiUsageSummary(providedSupabase, 24);
    if (summary.ok !== true) {
      // Fail-open: a telemetry outage must never block premium routing.
      return {
        ...computeAiBudgetStatus({}),
        windowHours: 24,
        error: summary.error || 'telemetry unavailable'
      };
    }
    return { ...computeAiBudgetStatus(summary), windowHours: 24, summary, error: null };
  } catch (err) {
    return {
      ...computeAiBudgetStatus({}),
      windowHours: 24,
      error: err.message || 'budget check failed'
    };
  }
}

/** Wire the aiClient budget seam (called once at boot; harmless twice). */
export function installAiBudgetGuard(providedSupabase) {
  setBudgetGuard(async () => {
    if (!getAiDailyBudgetUsd()) return false;
    const now = Date.now();
    if (budgetCache.promise && now - budgetCache.checkedAt < AI_BUDGET_CACHE_TTL_MS) {
      return budgetCache.promise;
    }
    budgetCache.checkedAt = now;
    budgetCache.promise = checkAiDailyBudget(providedSupabase)
      .then((status) => (status.error ? false : status.overBudget === true))
      .catch(() => false);
    return budgetCache.promise;
  });
  return true;
}

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
    attempts jsonb,
    created_at timestamp with time zone DEFAULT now()
);
ALTER TABLE public.ai_usage_logs ADD COLUMN IF NOT EXISTS attempts jsonb;
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

  if (hasSqlAccess()) {
    try {
      // Legacy tables predate the Phase 3 `attempts` column: detect + migrate it.
      const { error: columnError } = await supabase.from(AI_USAGE_TABLE).select('attempts').limit(1);
      const columnMissing = Boolean(columnError && /attempts/i.test(columnError.message || ''));
      if (missing || columnMissing) {
        const result = await runSql(AI_USAGE_TABLE_SQL, { label: 'ensureAiUsageLogsTable' });
        if (result.ok && missing) statusMap[AI_USAGE_TABLE] = 'created';
      }
    } catch (err) {
      console.warn('[AiUsageLog] Table provisioning notice:', err.message);
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

function toAttempts(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.slice(0, 8).map((entry = {}) => ({
    provider: entry.provider ? String(entry.provider).slice(0, 32) : null,
    model: entry.model ? String(entry.model).slice(0, 64) : null,
    outcome: entry.outcome ? String(entry.outcome).slice(0, 32) : 'unknown',
    latency_ms: Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : null,
    error: entry.error ? String(entry.error).slice(0, 200) : null
  }));
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
    attempts: toAttempts(record.attempts),
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

function newUsageBucket() {
  return {
    requests: 0,
    ok: 0,
    errors: 0,
    fallbacks: 0,
    promptTokens: 0,
    completionTokens: 0,
    approxCostUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    latencies: []
  };
}

function addUsageRow(bucket, row = {}) {
  const promptTokens = Number.isFinite(row.prompt_tokens) ? row.prompt_tokens : 0;
  const completionTokens = Number.isFinite(row.completion_tokens) ? row.completion_tokens : 0;

  bucket.requests += 1;
  if (row.ok === true) bucket.ok += 1;
  else bucket.errors += 1;

  // Every leg after the first is a failover/skip transition.
  bucket.fallbacks += Math.max(0, (Array.isArray(row.attempts) ? row.attempts.length : 0) - 1);

  bucket.promptTokens += promptTokens;
  bucket.completionTokens += completionTokens;
  if (Number.isFinite(row.latency_ms)) bucket.latencies.push(row.latency_ms);

  const rowTokens = promptTokens + completionTokens;
  if (rowTokens > 0) {
    const cost = estimateAiUsageCostUsd(row.provider, row.model, promptTokens, completionTokens);
    if (cost === null) {
      bucket.unpricedTokens += rowTokens;
    } else {
      bucket.approxCostUsd += cost;
      bucket.pricedTokens += rowTokens;
    }
  }
}

function finalizeUsageBucket(bucket) {
  const latencies = bucket.latencies.slice().sort((a, b) => a - b);
  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : null;
  // Lower median keeps the figure stable for even-sized samples.
  const p50LatencyMs = latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null;

  return {
    requests: bucket.requests,
    ok: bucket.ok,
    errors: bucket.errors,
    fallbacks: bucket.fallbacks,
    successRate: bucket.requests ? bucket.ok / bucket.requests : null,
    errorRate: bucket.requests ? bucket.errors / bucket.requests : null,
    avgLatencyMs,
    p50LatencyMs,
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    totalTokens: bucket.promptTokens + bucket.completionTokens,
    approxCostUsd: bucket.pricedTokens > 0
      ? Number(bucket.approxCostUsd.toFixed(6))
      : (bucket.unpricedTokens > 0 ? null : 0),
    unpricedTokens: bucket.unpricedTokens
  };
}

/**
 * Aggregate ai_usage_logs for the Superadmin telemetry digest (v1.13.0).
 *
 * Fail-soft by contract: a transport/query failure returns `{ ok: false,
 * error }` with zeroed totals instead of throwing, so an admin command can
 * never brick the WhatsApp turn. Reads are paged (PostgREST caps at 1000 rows
 * per request) up to AI_USAGE_LOG_MAX_ROWS — the same retention cap that
 * bounds the table.
 */
export async function getAiUsageSummary(providedSupabase, hours = AI_USAGE_DEFAULT_WINDOW_HOURS) {
  const requestedHours = Number(hours);
  const windowHours = Math.min(
    AI_USAGE_MAX_WINDOW_HOURS,
    Math.max(1, Math.round(Number.isFinite(requestedHours) && requestedHours > 0 ? requestedHours : AI_USAGE_DEFAULT_WINDOW_HOURS))
  );
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const generatedAt = new Date().toISOString();

  const summary = {
    ok: true,
    hours: windowHours,
    since,
    generatedAt,
    totalRequests: 0,
    okRequests: 0,
    errorRequests: 0,
    fallbacks: 0,
    successRate: null,
    errorRate: null,
    avgLatencyMs: null,
    p50LatencyMs: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    approxCostUsd: 0,
    unpricedTokens: 0,
    truncated: false,
    byTier: {},
    byProvider: {},
    byPurpose: {},
    error: null
  };

  try {
    const supabase = getSupabase(providedSupabase);
    const totals = newUsageBucket();
    const byTier = new Map();
    const byProvider = new Map();
    const byPurpose = new Map();
    let fetched = 0;
    let exhausted = false;

    while (fetched < AI_USAGE_LOG_MAX_ROWS) {
      const pageSize = Math.min(AI_USAGE_PAGE_SIZE, AI_USAGE_LOG_MAX_ROWS - fetched);
      const { data, error } = await supabase
        .from(AI_USAGE_TABLE)
        .select('id,tier,provider,model,purpose,latency_ms,ok,prompt_tokens,completion_tokens,attempts')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(fetched, fetched + pageSize - 1);

      if (error) throw new Error(error.message || 'telemetry query failed');

      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        addUsageRow(totals, row);

        const tierKey = Number.isInteger(row.tier) ? String(row.tier) : 'unknown';
        const providerKey = row.provider || 'unknown';
        const purposeKey = row.purpose || 'unknown';

        if (!byTier.has(tierKey)) byTier.set(tierKey, newUsageBucket());
        if (!byProvider.has(providerKey)) byProvider.set(providerKey, newUsageBucket());
        if (!byPurpose.has(purposeKey)) byPurpose.set(purposeKey, newUsageBucket());

        addUsageRow(byTier.get(tierKey), row);
        addUsageRow(byProvider.get(providerKey), row);
        addUsageRow(byPurpose.get(purposeKey), row);
      }

      fetched += rows.length;
      if (rows.length < pageSize) {
        exhausted = true;
        break;
      }
    }

    const total = finalizeUsageBucket(totals);
    summary.totalRequests = total.requests;
    summary.okRequests = total.ok;
    summary.errorRequests = total.errors;
    summary.fallbacks = total.fallbacks;
    summary.successRate = total.successRate;
    summary.errorRate = total.errorRate;
    summary.avgLatencyMs = total.avgLatencyMs;
    summary.p50LatencyMs = total.p50LatencyMs;
    summary.promptTokens = total.promptTokens;
    summary.completionTokens = total.completionTokens;
    summary.totalTokens = total.totalTokens;
    summary.approxCostUsd = total.approxCostUsd;
    summary.unpricedTokens = total.unpricedTokens;
    summary.truncated = !exhausted;
    summary.byTier = Object.fromEntries([...byTier].map(([key, bucket]) => [key, finalizeUsageBucket(bucket)]));
    summary.byProvider = Object.fromEntries([...byProvider].map(([key, bucket]) => [key, finalizeUsageBucket(bucket)]));
    summary.byPurpose = Object.fromEntries([...byPurpose].map(([key, bucket]) => [key, finalizeUsageBucket(bucket)]));

    return summary;
  } catch (err) {
    return { ...summary, ok: false, error: err.message || 'telemetry query failed' };
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
  isAiUsageLoggingEnabled,
  getAiUsageSummary,
  estimateAiUsageCostUsd,
  computeAiBudgetStatus,
  checkAiDailyBudget,
  installAiBudgetGuard,
  getAiDailyBudgetUsd
};
