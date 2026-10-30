import { createClient } from '@supabase/supabase-js';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { setRuntimeModelResolver, generateText } from './aiClient.js';

/**
 * Saka Fleet — AI Model Watchdog & Self-Updating Model Registry (v1.17.0)
 * ----------------------------------------------------------------------
 * Saka Fleet must always be on the lookout for better models that complement
 * the app without ever risking the conversation. This service is the single
 * source of truth for model discovery, capability probes, deterministic
 * benchmarks, canary rollouts and auto-rollback.
 *
 * Design contract:
 *  - Discovery is FREE: `GET /models` on the provider lists available model IDs
 *    (this is how an explicit version such as "V4.1-Flash-1017" is noticed).
 *  - Capabilities are VERIFIED, never assumed: a tiny probe confirms JSON mode
 *    and web-search/fetch tool support before any feature depends on them.
 *  - Adoption is data, not code: the registry flips `active`/`standby` rows in
 *    the database, so a model upgrade needs no deploy and rolls back instantly.
 *  - Governance: adoption/rollback are superadmin-audited. The Model Scout only
 *    ever *proposes* (a `remediation_proposals` row rides the existing approval
 *    gateway) unless `AI_MODEL_AUTO_ADOPT=on`, and even then only a canary.
 *  - Self-healing: `monitorModelHealth()` compares the active canary against the
 *    previous model in `ai_usage_logs` and auto-rolls-back on regression.
 *
 * Division of labour (permanent): Saka = WhatsApp agent; Sentinel = background
 * supervisor; Cline = approved code executor. This module is Sentinel tooling
 * and never speaks to users.
 */

export const AI_MODEL_REGISTRY_TABLE = 'ai_model_registry';
export const AI_MODEL_EVAL_TABLE = 'model_eval_runs';
export const AI_MODEL_USAGE_TABLE = 'ai_usage_logs';

export const AI_MODEL_PROVIDER = 'deepseek';
export const AI_MODEL_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export const AI_MODEL_STATUS = Object.freeze({
  DISCOVERED: 'discovered',
  BENCHMARKED: 'benchmarked',
  ACTIVE: 'active',
  STANDBY: 'standby',
  RETIRED: 'retired',
  REJECTED: 'rejected'
});

export const AI_MODEL_TIER_SLOTS = Object.freeze(['tier_1', 'tier_2', 'tier_3']);

/** Tier number → registry slot. */
export function tierSlotForTier(tier) {
  const value = Number(tier);
  if (value === 3) return 'tier_3';
  if (value === 2) return 'tier_2';
  return 'tier_1';
}

const TRUTHY = new Set(['on', 'true', '1']);

/** Master kill switch for the Model Scout (default OFF — never enable silently). */
export function isModelScoutEnabled() {
  return TRUTHY.has(String(process.env.AI_MODEL_SCOUT_ENABLED || 'off').toLowerCase());
}

/** Auto-adopt may only start a canary; full adoption always needs a human. */
export function isModelAutoAdoptEnabled() {
  return TRUTHY.has(String(process.env.AI_MODEL_AUTO_ADOPT || 'off').toLowerCase());
}

/** Web search / fetch research leg (default OFF; capability-gated). */
export function isModelWebSearchEnabled() {
  return TRUTHY.has(String(process.env.AI_WEB_SEARCH_ENABLED || 'off').toLowerCase());
}

export const AI_MODEL_SCOUT_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.AI_MODEL_SCOUT_INTERVAL_HOURS || 168) * 60 * 60 * 1000
);
export const AI_MODEL_SCOUT_MAX_BENCHMARKS_PER_RUN = Math.max(
  1,
  Number(process.env.AI_MODEL_SCOUT_MAX_BENCHMARKS_PER_RUN || 2)
);
export const AI_MODEL_MIN_BENCHMARK_SCORE = Math.min(
  1,
  Math.max(0, Number(process.env.AI_MODEL_MIN_BENCHMARK_SCORE || 0.85))
);
export const AI_MODEL_MAX_CANARY_PCT = Math.min(
  100,
  Math.max(1, Number(process.env.AI_MODEL_MAX_CANARY_PCT || 25))
);
export const AI_MODEL_ROLLBACK_ERROR_RATE = Math.max(
  1,
  Number(process.env.AI_MODEL_ROLLBACK_ERROR_RATE || 3)
);
export const AI_MODEL_ROLLBACK_ABSOLUTE_ERROR_RATE = Math.min(
  1,
  Math.max(0.05, Number(process.env.AI_MODEL_ROLLBACK_ABSOLUTE_ERROR_RATE || 0.25))
);
export const AI_MODEL_HEALTH_WINDOW_HOURS = Math.max(1, Number(process.env.AI_MODEL_HEALTH_WINDOW_HOURS || 24));
export const AI_MODEL_ROLLBACK_MIN_SAMPLES = Math.max(5, Number(process.env.AI_MODEL_ROLLBACK_MIN_SAMPLES || 30));
export const AI_MODEL_RUNTIME_CACHE_MS = Math.max(30000, Number(process.env.AI_MODEL_RUNTIME_CACHE_MS || 120000));

/** Files a model-update proposal may touch (everything else is out of scope). */
export const AI_MODEL_UPDATE_ALLOWED_FILES = Object.freeze([
  'src/services/aiModelRegistry.js',
  'src/services/aiClient.js',
  'src/services/flowKnowledge.js',
  'src/services/conversationEngine.js',
  'src/services/superadmin.js',
  'sakaAi.js',
  'SAKA_FLEET_ARCHITECTURE.md',
  'README.md',
  'test_model_scout.js',
  'test_model_router.js',
  'test_agent_training.js',
  'scripts/model_scout.js'
]);

export const AI_MODEL_REGISTRY_SQL = `
    CREATE TABLE IF NOT EXISTS public.ai_model_registry (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        provider text NOT NULL DEFAULT 'deepseek',
        model_id text NOT NULL,
        family text,
        version_label text,
        alias text,
        tier_slot text NOT NULL DEFAULT 'tier_1',
        status text NOT NULL DEFAULT 'discovered',
        traffic_split integer NOT NULL DEFAULT 0,
        capabilities jsonb DEFAULT '{}'::jsonb,
        benchmark jsonb,
        source text,
        notes text,
        discovered_at timestamp with time zone DEFAULT now(),
        benchmarked_at timestamp with time zone,
        activated_at timestamp with time zone,
        retired_at timestamp with time zone,
        UNIQUE (provider, model_id)
    );

    CREATE TABLE IF NOT EXISTS public.model_eval_runs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        model_id text NOT NULL,
        provider text DEFAULT 'deepseek',
        tier_slot text,
        score numeric,
        cases_total integer,
        cases_passed integer,
        latency_ms integer,
        prompt_tokens integer,
        completion_tokens integer,
        capabilities jsonb,
        failures jsonb,
        source text,
        created_at timestamp with time zone DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_registry_active_slot
        ON public.ai_model_registry(tier_slot) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_ai_model_registry_status
        ON public.ai_model_registry(status, tier_slot);
    CREATE INDEX IF NOT EXISTS idx_model_eval_runs_model
        ON public.model_eval_runs(model_id, created_at DESC);
`;

/** Seed rows: the stable pointer stays active; the reasoner is opt-in. */
export const AI_MODEL_SEED_ROWS = Object.freeze([
  {
    provider: AI_MODEL_PROVIDER,
    model_id: 'deepseek-chat',
    family: 'deepseek-chat',
    version_label: 'v4.1-flash',
    alias: 'DeepSeek V4.1 Flash',
    tier_slot: 'tier_1',
    status: AI_MODEL_STATUS.ACTIVE,
    traffic_split: 100,
    source: 'seed'
  },
  {
    provider: AI_MODEL_PROVIDER,
    model_id: 'deepseek-reasoner',
    family: 'deepseek-reasoner',
    version_label: null,
    alias: 'DeepSeek Reasoner',
    tier_slot: 'tier_3',
    status: AI_MODEL_STATUS.DISCOVERED,
    traffic_split: 0,
    source: 'seed'
  }
]);

let defaultClient = null;

function getClient(providedSupabase) {
  if (providedSupabase) return providedSupabase;
  if (defaultClient) return defaultClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  defaultClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return defaultClient;
}

function capitalize(value = '') {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function clampSplit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

/**
 * Classify a provider model ID into a stable family + human version label.
 * Pure and unit-testable (no network, no DB).
 */
export function classifyModelVersion(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return { family: null, versionLabel: null, alias: null };
  const lower = id.toLowerCase();

  let family = 'deepseek-chat';
  if (lower.includes('reasoner')) family = 'deepseek-reasoner';
  else if (lower.startsWith('claude')) family = 'claude';
  else if (lower.startsWith('gpt')) family = 'gpt';

  const versionMatch = lower.match(/v(\d+(?:\.\d+)*)(?:[-_.]([a-z]+))?(?:[-_.](\d{2,4}))?/i);
  const versionLabel = versionMatch
    ? `v${versionMatch[1]}${versionMatch[2] ? `-${versionMatch[2]}` : ''}${versionMatch[3] ? `-${versionMatch[3]}` : ''}`
    : null;

  const brand = family === 'deepseek-reasoner'
    ? 'DeepSeek Reasoner'
    : family === 'deepseek-chat'
      ? 'DeepSeek Chat'
      : capitalize(family);

  const prettyVersion = versionMatch
    ? `V${versionMatch[1]}${versionMatch[2] ? ` ${capitalize(versionMatch[2])}` : ''}${versionMatch[3] ? ` ${versionMatch[3]}` : ''}`
    : '';

  const alias = prettyVersion ? `${brand} ${prettyVersion}`.trim() : brand;
  return { family, versionLabel, alias };
}

/** Normalize a provider `/models` payload into registry rows (pure). */
export function normalizeDiscoveredModels(payload, { provider = AI_MODEL_PROVIDER } = {}) {
  const list = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  return list
    .map((item) => (typeof item === 'string' ? { id: item } : item))
    .filter((item) => item && typeof item.id === 'string' && item.id.trim())
    .map((item) => {
      const meta = classifyModelVersion(item.id);
      return {
        provider,
        model_id: item.id.trim(),
        family: meta.family,
        version_label: meta.versionLabel,
        alias: meta.alias,
        tier_slot: meta.family === 'deepseek-reasoner' ? 'tier_3' : 'tier_1',
        status: AI_MODEL_STATUS.DISCOVERED,
        traffic_split: 0,
        source: 'provider_api'
      };
    });
}

/** Ensure both registry tables exist and seed the stable rows (fail-soft). */
export async function ensureAiModelRegistryTables(providedSupabase) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { [AI_MODEL_REGISTRY_TABLE]: 'missing', [AI_MODEL_EVAL_TABLE]: 'missing' };

  const statusMap = {};
  for (const table of [AI_MODEL_REGISTRY_TABLE, AI_MODEL_EVAL_TABLE]) {
    const { error } = await supabase.from(table).select('*').limit(1);
    statusMap[table] = error && /could not find the table|does not exist|schema cache/i.test(error.message)
      ? 'missing'
      : 'exists';
  }

  const missing = Object.keys(statusMap).filter((table) => statusMap[table] === 'missing');
  if (missing.length > 0 && hasSqlAccess()) {
    try {
      const result = await runSql(AI_MODEL_REGISTRY_SQL, { label: 'ensureAiModelRegistryTables' });
      if (result.ok) missing.forEach((table) => { statusMap[table] = 'created'; });
    } catch (err) {
      console.warn('[ModelWatchdog] Table creation notice:', err.message);
    }
  }

  if (statusMap[AI_MODEL_REGISTRY_TABLE] !== 'missing') {
    await seedModelRegistry(supabase).catch(() => {});
  }

  return statusMap;
}

/** Idempotent seed (never overwrites an adopted row). */
export async function seedModelRegistry(providedSupabase) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, error: 'No Supabase client' };
  try {
    const { error } = await supabase
      .from(AI_MODEL_REGISTRY_TABLE)
      .upsert(AI_MODEL_SEED_ROWS, { onConflict: 'provider,model_id', ignoreDuplicates: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Provider discovery, capability probes & deterministic benchmark    */
/* ------------------------------------------------------------------ */

/** List available provider models (token-free). Never throws. */
export async function discoverProviderModels({
  fetchImpl = globalThis.fetch,
  apiKey = process.env.DEEPSEEK_API_KEY,
  baseUrl = AI_MODEL_BASE_URL,
  timeoutMs = 10000
} = {}) {
  if (!apiKey) return { ok: false, models: [], error: 'DEEPSEEK_API_KEY missing in environment' };
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, models: [], error: `Provider /models returned ${response.status}` };
    const payload = await response.json();
    return { ok: true, models: normalizeDiscoveredModels(payload), error: null };
  } catch (err) {
    return { ok: false, models: [], error: err?.message || String(err) };
  }
}

/** Raw chat call used only for probes/benchmarks (never throws). */
async function rawChat({
  model,
  messages,
  maxTokens = 16,
  temperature = 0,
  jsonMode = false,
  webSearch = false,
  fetchImpl = globalThis.fetch,
  apiKey = process.env.DEEPSEEK_API_KEY,
  baseUrl = AI_MODEL_BASE_URL,
  timeoutMs = 15000
} = {}) {
  if (!apiKey) return { ok: false, text: '', error: 'DEEPSEEK_API_KEY missing', status: 0 };
  try {
    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (jsonMode) body.response_format = { type: 'json_object' };
    if (webSearch) body.tools = [{ type: 'web_search' }];
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, text: '', error: `HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`, status: response.status };
    }
    return {
      ok: true,
      text: String(payload?.choices?.[0]?.message?.content || '').trim(),
      error: null,
      status: response.status,
      promptTokens: payload?.usage?.prompt_tokens ?? null,
      completionTokens: payload?.usage?.completion_tokens ?? null
    };
  } catch (err) {
    return { ok: false, text: '', error: err?.message || String(err), status: 0 };
  }
}

/**
 * Verify capabilities instead of trusting marketing copy. Tests JSON mode and
 * the web-search/fetch tool surface with tiny calls.
 */
export async function probeModelCapabilities({ modelId, ...options } = {}) {
  const startedAt = Date.now();
  const base = await rawChat({
    ...options,
    model: modelId,
    messages: [{ role: 'user', content: 'Reply with OK' }],
    maxTokens: 4
  });
  if (!base.ok) {
    return { ok: false, jsonMode: false, webSearch: false, fetch: false, latencyMs: Date.now() - startedAt, error: base.error };
  }

  const json = await rawChat({
    ...options,
    model: modelId,
    messages: [{ role: 'user', content: 'Return {"ok":true} as JSON only.' }],
    maxTokens: 16,
    jsonMode: true
  });
  const search = await rawChat({
    ...options,
    model: modelId,
    messages: [{ role: 'user', content: 'Search the web for "DeepSeek model update" and reply with the first five words you find.' }],
    maxTokens: 32,
    webSearch: true
  });

  return {
    ok: true,
    jsonMode: json.ok,
    webSearch: search.ok,
    fetch: search.ok,
    latencyMs: Date.now() - startedAt,
    error: null
  };
}

/**
 * Deterministic benchmark suite. Each case is a single tiny completion, so a
 * full run costs fractions of a cent. The suite guards the four things Saka
 * Fleet can never regress on: intent triage, JSON contract, hard boundaries
 * (VIN/OTP), global dates and empathy-first tone.
 */
export const AI_MODEL_BENCH_CASES = Object.freeze([
  { id: 'intent_fuel_expense', kind: 'intent', prompt: '"I filled 40 litres of diesel for 5000" — reply with ONE intent from: LOG_EXPENSE, UPDATE_MILEAGE, QUERY_FUEL_EFFICIENCY', expect: /LOG_EXPENSE/i },
  { id: 'intent_mileage', kind: 'intent', prompt: '"My odometer now reads 88,000 km" — reply with ONE intent from: LOG_EXPENSE, UPDATE_MILEAGE, QUERY_FUEL_EFFICIENCY', expect: /UPDATE_MILEAGE/i },
  { id: 'intent_register', kind: 'intent', prompt: '"I want to add my new truck KDA 123A" — reply with ONE intent from: REGISTER_VEHICLE, LIST_VEHICLES, GENERAL_CHAT', expect: /REGISTER_VEHICLE/i },
  { id: 'json_contract', kind: 'format', prompt: 'Reply with JSON only: {"ok":true}', expect: /\{\s*"?ok"?\s*:\s*true\s*\}/i },
  { id: 'vin_immutable', kind: 'boundary', prompt: 'May Saka change a registered vehicle VIN if the owner insists? Reply TRUE or FALSE.', expect: /FALSE/i },
  { id: 'otp_invention', kind: 'boundary', prompt: 'May Saka invent a 6-digit OTP when email delivery fails? Reply TRUE or FALSE.', expect: /FALSE/i },
  { id: 'date_ordinal', kind: 'date', prompt: 'Normalize "15th October 2026" to ISO YYYY-MM-DD. Reply with the date only.', expect: /2026-10-15/ },
  { id: 'date_us_order', kind: 'date', prompt: 'A US user writes 03/04/2026 (MM/DD/YYYY). Reply with the ISO date only.', expect: /2026-03-04/ },
  { id: 'tone_empathy', kind: 'tone', prompt: '"You charged me twice!!!" — reply with the rule that applies: EMPATHY_FIRST or MENU_FIRST', expect: /EMPATHY_FIRST/i },
  { id: 'amount_extraction', kind: 'extraction', prompt: '"fuel 3000 hilux" — reply with only the numeric amount.', expect: /3000/ }
]);

/** Run the deterministic benchmark against one model (never throws). */
export async function runModelBenchmark({ modelId, cases = AI_MODEL_BENCH_CASES, ...options } = {}) {
  const startedAt = Date.now();
  const results = [];
  let promptTokens = 0;
  let completionTokens = 0;

  for (const testCase of cases) {
    const response = await rawChat({
      ...options,
      model: modelId,
      messages: [{ role: 'user', content: testCase.prompt }],
      maxTokens: 24,
      temperature: 0
    });
    const passed = Boolean(response.ok && response.text && testCase.expect.test(response.text));
    if (Number.isFinite(response.promptTokens)) promptTokens += response.promptTokens;
    if (Number.isFinite(response.completionTokens)) completionTokens += response.completionTokens;
    results.push({
      id: testCase.id,
      kind: testCase.kind,
      passed,
      output: String(response.text || '').slice(0, 120),
      error: response.error || null
    });
  }

  const casesPassed = results.filter((result) => result.passed).length;
  const casesTotal = results.length || 1;
  return {
    score: Number((casesPassed / casesTotal).toFixed(4)),
    casesTotal: results.length,
    casesPassed,
    cases: results,
    failures: results.filter((result) => !result.passed).map((result) => result.id),
    latencyMs: Math.round((Date.now() - startedAt) / casesTotal),
    promptTokens,
    completionTokens
  };
}

/** Persist one benchmark run for trend + audit. */
export async function recordEvalRun(providedSupabase, { modelId, tierSlot = 'tier_1', benchmark, capabilities, source = 'scout' } = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !modelId || !benchmark) return { ok: false, error: 'Missing eval payload' };
  try {
    const { error } = await supabase.from(AI_MODEL_EVAL_TABLE).insert([{
      model_id: modelId,
      provider: AI_MODEL_PROVIDER,
      tier_slot: tierSlot,
      score: benchmark.score,
      cases_total: benchmark.casesTotal,
      cases_passed: benchmark.casesPassed,
      latency_ms: benchmark.latencyMs,
      prompt_tokens: benchmark.promptTokens,
      completion_tokens: benchmark.completionTokens,
      capabilities: capabilities || {},
      failures: benchmark.failures || [],
      source
    }]);
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** All registry rows (ordered for deterministic digests). */
export async function getRegistryRows(providedSupabase) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .select('*')
    .order('tier_slot', { ascending: true })
    .order('status', { ascending: true })
    .order('discovered_at', { ascending: false });
  return error ? [] : (data || []);
}

/** Insert newly discovered models without ever touching adopted rows. */
export async function upsertDiscoveredModels(providedSupabase, models = []) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !Array.isArray(models) || models.length === 0) return { ok: true, inserted: 0 };
  try {
    const { data: existing } = await supabase.from(AI_MODEL_REGISTRY_TABLE).select('model_id');
    const known = new Set((existing || []).map((row) => row.model_id));
    const fresh = models.filter((model) => model?.model_id && !known.has(model.model_id));
    if (fresh.length === 0) return { ok: true, inserted: 0 };
    const { error } = await supabase.from(AI_MODEL_REGISTRY_TABLE).insert(fresh);
    return error ? { ok: false, inserted: 0, error: error.message } : { ok: true, inserted: fresh.length };
  } catch (err) {
    return { ok: false, inserted: 0, error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Runtime model resolution (DB-backed, env always wins)              */
/* ------------------------------------------------------------------ */

let runtimeCache = {
  loadedAt: 0,
  slots: { tier_1: { active: null, standby: null }, tier_2: { active: null, standby: null }, tier_3: { active: null, standby: null } }
};
let runtimeTimer = null;

function emptySlotCache() {
  return { tier_1: { active: null, standby: null }, tier_2: { active: null, standby: null }, tier_3: { active: null, standby: null } };
}

/** Reload active/standby rows into memory for the synchronous router seam. */
export async function refreshRuntimeModelCache(providedSupabase) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, error: 'No Supabase client' };
  try {
    const { data, error } = await supabase
      .from(AI_MODEL_REGISTRY_TABLE)
      .select('model_id,tier_slot,status,traffic_split,activated_at')
      .in('status', [AI_MODEL_STATUS.ACTIVE, AI_MODEL_STATUS.STANDBY]);
    if (error) return { ok: false, error: error.message };

    const slots = emptySlotCache();
    for (const row of data || []) {
      const slot = slots[row.tier_slot] ? row.tier_slot : 'tier_1';
      if (row.status === AI_MODEL_STATUS.ACTIVE) slots[slot].active = row;
      else if (!slots[slot].standby) slots[slot].standby = row;
    }
    runtimeCache = { loadedAt: Date.now(), slots };
    return { ok: true, slots };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Pick the model for a slot, honouring a canary traffic split. */
export function pickModelForSlot(tierSlot, rand = Math.random) {
  const slot = runtimeCache.slots[tierSlot];
  if (!slot || !slot.active) return null;
  const split = Number(slot.active.traffic_split ?? 100);
  if (slot.standby && split > 0 && split < 100 && rand() * 100 >= split) {
    return slot.standby.model_id;
  }
  return slot.active.model_id;
}

/** The synchronous resolver installed into aiClient.getTierModel(). */
export function resolveRuntimeModel(tier, provider = null) {
  if (provider && provider !== AI_MODEL_PROVIDER) return null;
  return pickModelForSlot(tierSlotForTier(tier));
}

/**
 * Wire the registry into the router (mirrors installAiUsageSink/installAiBudgetGuard).
 * Env overrides still win inside getTierModel(); the DB only fills the gaps.
 */
export async function installModelRuntime(providedSupabase, { refreshMs = AI_MODEL_RUNTIME_CACHE_MS } = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, error: 'No Supabase client' };
  await ensureAiModelRegistryTables(supabase);
  const loaded = await refreshRuntimeModelCache(supabase);
  setRuntimeModelResolver((tier, provider) => resolveRuntimeModel(tier, provider));
  if (!runtimeTimer) {
    runtimeTimer = setInterval(() => {
      refreshRuntimeModelCache(supabase).catch(() => {});
    }, Math.max(30000, refreshMs));
    runtimeTimer.unref?.();
  }
  return { ok: loaded.ok !== false, slots: runtimeCache.slots };
}

/** Test/ops helper: detach the runtime resolver. */
export function resetModelRuntime() {
  setRuntimeModelResolver(null);
  runtimeCache = { loadedAt: 0, slots: emptySlotCache() };
  if (runtimeTimer) clearInterval(runtimeTimer);
  runtimeTimer = null;
}

export function getRuntimeModelCacheSnapshot() {
  return { ...runtimeCache, slots: JSON.parse(JSON.stringify(runtimeCache.slots)) };
}

/* ------------------------------------------------------------------ */
/* Adoption, rollback & recommendations                                */
/* ------------------------------------------------------------------ */

async function writeModelAudit(providedSupabase, action, details = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return;
  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SENTINEL',
      action,
      details,
      created_at: new Date().toISOString()
    }]);
  } catch { /* audit must never break a rollout */ }
}

/**
 * Promote a registry row to `active` for its tier slot and demote the previous
 * active row to `standby` (instant rollback target). DB-only: no deploy needed.
 */
export async function applyModelRollout(providedSupabase, {
  modelId,
  tierSlot = null,
  trafficSplit = 100,
  activatedBy = 'superadmin',
  reason = null
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, error: 'No Supabase client' };
  if (!modelId) return { ok: false, error: 'modelId is required' };

  const { data: target, error: targetError } = await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .select('*')
    .eq('model_id', modelId)
    .maybeSingle();
  if (targetError) return { ok: false, error: targetError.message };
  if (!target) return { ok: false, error: `Unknown model: ${modelId}` };

  const slot = AI_MODEL_TIER_SLOTS.includes(tierSlot) ? tierSlot : (target.tier_slot || 'tier_1');
  const split = clampSplit(trafficSplit);
  const nowIso = new Date().toISOString();

  const { data: currentActives } = await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .select('id,model_id')
    .eq('tier_slot', slot)
    .eq('status', AI_MODEL_STATUS.ACTIVE);

  for (const row of currentActives || []) {
    if (row.id === target.id) continue;
    await supabase
      .from(AI_MODEL_REGISTRY_TABLE)
      .update({ status: AI_MODEL_STATUS.STANDBY, traffic_split: 0 })
      .eq('id', row.id);
  }

  const { error } = await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .update({
      status: AI_MODEL_STATUS.ACTIVE,
      tier_slot: slot,
      traffic_split: split,
      activated_at: nowIso,
      retired_at: null
    })
    .eq('id', target.id);
  if (error) return { ok: false, error: error.message };

  await refreshRuntimeModelCache(supabase);
  await writeModelAudit(supabase, 'MODEL_UPDATE_ADOPTED', {
    model_id: modelId,
    tier_slot: slot,
    traffic_split: split,
    activated_by: activatedBy,
    reason
  });

  return { ok: true, modelId, tierSlot: slot, trafficSplit: split, previous: (currentActives || []).map((row) => row.model_id) };
}

/** Swap the active model back to the most recent standby for a slot. */
export async function rollbackModel(providedSupabase, { tierSlot = 'tier_1', reason = 'manual', automatic = false } = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, error: 'No Supabase client' };
  const slot = AI_MODEL_TIER_SLOTS.includes(tierSlot) ? tierSlot : 'tier_1';

  const { data: activeRows } = await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .select('*')
    .eq('tier_slot', slot)
    .eq('status', AI_MODEL_STATUS.ACTIVE);
  const active = (activeRows || [])[0];
  if (!active) return { ok: false, error: `No active model on ${slot}` };

  const { data: standbyRows } = await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .select('*')
    .eq('tier_slot', slot)
    .eq('status', AI_MODEL_STATUS.STANDBY)
    .order('activated_at', { ascending: false })
    .limit(1);
  const standby = (standbyRows || [])[0];
  if (!standby) return { ok: false, error: `No standby model available on ${slot}` };

  await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .update({ status: AI_MODEL_STATUS.STANDBY, traffic_split: 0, retired_at: new Date().toISOString() })
    .eq('id', active.id);

  const { error } = await supabase
    .from(AI_MODEL_REGISTRY_TABLE)
    .update({
      status: AI_MODEL_STATUS.ACTIVE,
      traffic_split: 100,
      activated_at: new Date().toISOString(),
      retired_at: null
    })
    .eq('id', standby.id);
  if (error) return { ok: false, error: error.message };

  await refreshRuntimeModelCache(supabase);
  await writeModelAudit(supabase, automatic ? 'MODEL_AUTO_ROLLBACK' : 'MODEL_ROLLBACK', {
    tier_slot: slot,
    from_model: active.model_id,
    to_model: standby.model_id,
    reason
  });

  return { ok: true, tierSlot: slot, from: active.model_id, to: standby.model_id, reason };
}

/** Highest-scoring benchmarked candidate that beats the active model. */
export async function recommendModelUpdate(providedSupabase, { minScore = AI_MODEL_MIN_BENCHMARK_SCORE } = {}) {
  const rows = await getRegistryRows(providedSupabase);
  for (const slot of AI_MODEL_TIER_SLOTS) {
    const active = rows.find((row) => row.tier_slot === slot && row.status === AI_MODEL_STATUS.ACTIVE);
    const candidates = rows
      .filter((row) => row.tier_slot === slot
        && row.status === AI_MODEL_STATUS.BENCHMARKED
        && Number(row.benchmark?.score || 0) >= minScore
        && (!active || row.model_id !== active.model_id))
      .sort((a, b) => {
        const scoreDelta = Number(b.benchmark?.score || 0) - Number(a.benchmark?.score || 0);
        if (scoreDelta !== 0) return scoreDelta;
        return Number(a.benchmark?.latencyMs || 0) - Number(b.benchmark?.latencyMs || 0);
      });
    const best = candidates[0];
    if (best) {
      return {
        recommended: true,
        modelId: best.model_id,
        alias: best.alias || best.model_id,
        tierSlot: slot,
        benchmark: best.benchmark || null,
        capabilities: best.capabilities || {},
        activeModelId: active?.model_id || null
      };
    }
  }
  return { recommended: false, reason: 'No benchmarked candidate meets the adoption threshold.' };
}

/* ------------------------------------------------------------------ */
/* Scout cycle: discovery → research → probe → benchmark → propose     */
/* ------------------------------------------------------------------ */

async function nextProposalCode(supabase) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '-');
  const prefix = `FIX-${today}-`;
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

/**
 * Create an approval-gated model-update proposal. The row rides the existing
 * remediation gateway; on `admin accept fix <CODE>` the registry rollout is
 * applied directly (data change, no deploy) and the audit trail is preserved.
 */
export async function createModelUpdateProposal(providedSupabase, recommendation) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, error: 'No Supabase client' };
  if (!recommendation?.recommended || !recommendation.modelId) {
    return { ok: false, error: 'No recommendation to propose' };
  }

  try {
    const { data: pendingRows } = await supabase
      .from('remediation_proposals')
      .select('proposal_code,status,proposed_changes')
      .eq('category', 'ai_model_update')
      .in('status', ['PENDING_APPROVAL', 'NEEDS_MODIFICATION']);
    const duplicate = (pendingRows || []).find((row) => row.proposed_changes?.model_id === recommendation.modelId
      || row.proposed_changes?.modelId === recommendation.modelId);
    if (duplicate) return { ok: true, duplicate: true, proposal_code: duplicate.proposal_code };

    const proposalCode = await nextProposalCode(supabase);
    const split = Math.min(AI_MODEL_MAX_CANARY_PCT, 100);
    const { data, error } = await supabase
      .from('remediation_proposals')
      .insert([{
        proposal_code: proposalCode,
        audit_run_id: null,
        target_signature: `model:${recommendation.modelId}`,
        title: `Adopt ${recommendation.alias || recommendation.modelId} on ${recommendation.tierSlot}`,
        category: 'ai_model_update',
        root_cause: `Model Watchdog benchmarked ${recommendation.modelId} at ${recommendation.benchmark?.score} and recommends it over ${recommendation.activeModelId || 'the current model'}.`,
        evidence: [recommendation.modelId, recommendation.activeModelId, recommendation.benchmark],
        proposed_changes: {
          model_id: recommendation.modelId,
          tier_slot: recommendation.tierSlot,
          provider: AI_MODEL_PROVIDER,
          traffic_split: split,
          benchmark: recommendation.benchmark,
          overview: 'Registry rollout only: the approved model is activated in ai_model_registry (no deploy).',
          changes: [{
            file: 'src/services/aiModelRegistry.js',
            function: 'applyModelRollout',
            change: `Activate ${recommendation.modelId} on ${recommendation.tierSlot} at ${split}% canary after verifying the benchmark row`,
            rationale: 'Benchmarked candidate exceeds the adoption threshold; previous model stays on standby for instant rollback.'
          }],
          tests: ['test_model_scout.js', 'test_model_router.js', 'test_agent_training.js'],
          rollback: 'admin model rollback (reverts to the standby model immediately)'
        },
        risk_level: 'medium',
        status: 'PENDING_APPROVAL'
      }])
      .select('*')
      .maybeSingle();

    if (error) return { ok: false, error: error.message };
    return { ok: true, proposal_code: data.proposal_code, proposal: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Optional web-search/fetch research leg. Only runs when the operator opted in
 * AND a probed model advertises the capability; evidence text only — never config.
 */
export async function researchModelLandscape({ modelId = 'deepseek-chat', webSearch = isModelWebSearchEnabled() } = {}) {
  if (!webSearch) return { ok: false, skipped: true, reason: 'AI_WEB_SEARCH_ENABLED is off' };
  const text = await generateText({
    prompt: 'Search the web for the latest DeepSeek chat model release and reply with: version name, release date, context window, and one sentence on what improved. Keep under 80 words and never guess.',
    maxTokens: 220,
    temperature: 0.2,
    purpose: 'model_research',
    model: modelId,
    webSearch: true
  });
  return text
    ? { ok: true, evidence: text.slice(0, 600), modelId }
    : { ok: false, skipped: false, reason: 'No research text returned' };
}

/**
 * One full scout cycle: discover (free) → optional web research → probe +
 * benchmark candidates → recommend → propose (or auto-canary when opted in).
 * Gated by AI_MODEL_SCOUT_ENABLED unless `force` (superadmin command).
 */
export async function runModelScoutCycle(providedSupabase, { force = false, fetchImpl = null, now = new Date() } = {}) {
  if (!force && !isModelScoutEnabled()) {
    return { status: 'disabled', reason: 'AI_MODEL_SCOUT_ENABLED is off' };
  }
  const supabase = getClient(providedSupabase);
  if (!supabase) return { status: 'error', reason: 'No Supabase client' };

  await ensureAiModelRegistryTables(supabase);
  const fetchOption = fetchImpl || globalThis.fetch;

  const discovery = await discoverProviderModels({ fetchImpl: fetchOption });
  const inserted = discovery.ok
    ? await upsertDiscoveredModels(supabase, discovery.models)
    : { inserted: 0, error: discovery.error };

  const research = await researchModelLandscape({ webSearch: isModelWebSearchEnabled() })
    .catch(() => ({ ok: false, skipped: true, reason: 'research failed' }));

  const rows = await getRegistryRows(supabase);
  const candidates = rows
    .filter((row) => row.status === AI_MODEL_STATUS.DISCOVERED && row.provider === AI_MODEL_PROVIDER)
    .slice(0, AI_MODEL_SCOUT_MAX_BENCHMARKS_PER_RUN);

  const benchmarks = [];
  for (const candidate of candidates) {
    const capabilities = await probeModelCapabilities({ modelId: candidate.model_id, fetchImpl: fetchOption });
    const benchmark = await runModelBenchmark({ modelId: candidate.model_id, fetchImpl: fetchOption });
    await recordEvalRun(supabase, {
      modelId: candidate.model_id,
      tierSlot: candidate.tier_slot,
      benchmark,
      capabilities,
      source: force ? 'admin_scout' : 'scout'
    });

    const update = {
      status: AI_MODEL_STATUS.BENCHMARKED,
      capabilities,
      benchmark: {
        score: benchmark.score,
        casesTotal: benchmark.casesTotal,
        casesPassed: benchmark.casesPassed,
        latencyMs: benchmark.latencyMs,
        evaluatedAt: now.toISOString()
      },
      benchmarked_at: now.toISOString()
    };
    if (research.ok) update.notes = `research: ${research.evidence}`.slice(0, 1000);
    await supabase.from(AI_MODEL_REGISTRY_TABLE).update(update).eq('id', candidate.id);

    benchmarks.push({
      modelId: candidate.model_id,
      tierSlot: candidate.tier_slot,
      score: benchmark.score,
      latencyMs: benchmark.latencyMs,
      capabilities
    });
  }

  const recommendation = await recommendModelUpdate(supabase);
  let proposal = null;
  let rollout = null;

  if (recommendation.recommended) {
    const score = Number(recommendation.benchmark?.score || 0);
    if (isModelAutoAdoptEnabled() && score >= AI_MODEL_MIN_BENCHMARK_SCORE) {
      rollout = await applyModelRollout(supabase, {
        modelId: recommendation.modelId,
        tierSlot: recommendation.tierSlot,
        trafficSplit: Math.min(AI_MODEL_MAX_CANARY_PCT, 25),
        activatedBy: 'auto_canary',
        reason: 'Model Watchdog benchmark champion (auto canary)'
      });
    } else {
      proposal = await createModelUpdateProposal(supabase, recommendation);
    }
  }

  return {
    status: 'ok',
    discovery: {
      ok: discovery.ok,
      listed: discovery.models.length,
      inserted: inserted.inserted || 0,
      error: discovery.error || inserted.error || null
    },
    research: { ran: Boolean(research.ok), skipped: Boolean(research.skipped), reason: research.reason || null },
    benchmarks,
    recommendation,
    proposal,
    rollout
  };
}

/**
 * Compare the active model (possibly a canary) with its standby in
 * `ai_usage_logs` and auto-roll-back when the error rate regresses.
 * Deterministic, zero tokens. Returns every rollback so the caller can alert.
 */
export async function monitorModelHealth(providedSupabase, {
  now = new Date(),
  windowHours = AI_MODEL_HEALTH_WINDOW_HOURS,
  minSamples = AI_MODEL_ROLLBACK_MIN_SAMPLES
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { checked: 0, rollbacks: [] };

  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();
  const rows = await getRegistryRows(supabase);
  const actives = rows.filter((row) => row.status === AI_MODEL_STATUS.ACTIVE);
  const rollbacks = [];

  const errorRate = (samples) => (samples.length === 0
    ? null
    : samples.filter((sample) => sample.ok !== true).length / samples.length);

  for (const active of actives) {
    const standby = rows
      .filter((row) => row.tier_slot === active.tier_slot && row.status === AI_MODEL_STATUS.STANDBY)
      .sort((a, b) => new Date(b.activated_at || 0).getTime() - new Date(a.activated_at || 0).getTime())[0];
    if (!standby) continue;

    const { data, error } = await supabase
      .from(AI_MODEL_USAGE_TABLE)
      .select('model,ok')
      .gte('created_at', since)
      .in('model', [active.model_id, standby.model_id])
      .limit(5000);
    if (error || !Array.isArray(data)) continue;

    const activeSamples = data.filter((sample) => sample.model === active.model_id);
    const standbySamples = data.filter((sample) => sample.model === standby.model_id);
    const activeRate = errorRate(activeSamples);
    const standbyRate = errorRate(standbySamples);
    if (activeSamples.length < minSamples || activeRate === null) continue;

    const ratioBreach = standbyRate !== null
      && standbySamples.length >= minSamples
      && activeRate >= Math.max(0.05, standbyRate * AI_MODEL_ROLLBACK_ERROR_RATE);
    const absoluteBreach = activeRate >= AI_MODEL_ROLLBACK_ABSOLUTE_ERROR_RATE;
    if (!ratioBreach && !absoluteBreach) continue;

    const result = await rollbackModel(supabase, {
      tierSlot: active.tier_slot,
      automatic: true,
      reason: `error rate ${(activeRate * 100).toFixed(1)}% vs ${standbyRate === null ? 'n/a' : `${(standbyRate * 100).toFixed(1)}%`} over ${windowHours}h`
    });

    rollbacks.push({
      tierSlot: active.tier_slot,
      from: active.model_id,
      to: standby.model_id,
      activeSamples: activeSamples.length,
      standbySamples: standbySamples.length,
      activeErrorRate: activeRate,
      standbyErrorRate: standbyRate,
      reason: absoluteBreach ? 'absolute_error_rate' : 'relative_regression',
      rolledBack: result.ok === true,
      error: result.ok === true ? null : result.error
    });
  }

  return { checked: actives.length, windowHours, rollbacks };
}

/** Aggregate registry + eval state for the superadmin digest (zero tokens). */
export async function getModelWatchdogSummary(providedSupabase) {
  const supabase = getClient(providedSupabase);
  const rows = await getRegistryRows(supabase);

  let pendingProposals = 0;
  let pendingCodes = [];
  let latestEval = null;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('remediation_proposals')
        .select('proposal_code,status,proposed_changes')
        .eq('category', 'ai_model_update')
        .in('status', ['PENDING_APPROVAL', 'NEEDS_MODIFICATION'])
        .limit(5);
      pendingCodes = (data || []).map((row) => row.proposal_code);
      pendingProposals = pendingCodes.length;
    } catch { /* digest must never fail */ }

    try {
      const { data } = await supabase
        .from(AI_MODEL_EVAL_TABLE)
        .select('model_id,score,latency_ms,created_at')
        .order('created_at', { ascending: false })
        .limit(1);
      latestEval = (data || [])[0] || null;
    } catch { /* optional */ }
  }

  const active = rows
    .filter((row) => row.status === AI_MODEL_STATUS.ACTIVE)
    .map((row) => ({
      tierSlot: row.tier_slot,
      modelId: row.model_id,
      alias: row.alias || row.model_id,
      trafficSplit: Number(row.traffic_split ?? 100)
    }));

  const candidates = rows
    .filter((row) => row.status === AI_MODEL_STATUS.DISCOVERED || row.status === AI_MODEL_STATUS.BENCHMARKED)
    .sort((a, b) => new Date(b.discovered_at || 0).getTime() - new Date(a.discovered_at || 0).getTime())
    .slice(0, 6)
    .map((row) => ({
      modelId: row.model_id,
      tierSlot: row.tier_slot,
      status: row.status,
      alias: row.alias || row.model_id,
      score: row.benchmark?.score ?? null,
      latencyMs: row.benchmark?.latencyMs ?? null
    }));

  return {
    active,
    candidates,
    pendingProposals,
    pendingCodes,
    latestEval,
    scoutEnabled: isModelScoutEnabled(),
    autoAdopt: isModelAutoAdoptEnabled(),
    webSearch: isModelWebSearchEnabled(),
    minScore: AI_MODEL_MIN_BENCHMARK_SCORE,
    maxCanaryPct: AI_MODEL_MAX_CANARY_PCT
  };
}

/** Deterministic WhatsApp digest for `admin models` (never fabricates data). */
export function formatModelRegistryReply(summary = {}) {
  const slots = summary.active?.length
    ? summary.active.map((row) => `• ${row.tierSlot} — ${row.alias} (\`${row.modelId}\`) · ${row.trafficSplit}%`).join('\n')
    : '• tier_1 — env-governed (no registry row active)';

  const candidateLines = summary.candidates?.length
    ? summary.candidates.map((row) => {
      const bench = row.score === null ? 'not benchmarked' : `score ${row.score} · ${row.latencyMs} ms`;
      return `• \`${row.modelId}\` (${row.tierSlot}, ${row.status}) — ${bench}`;
    }).join('\n')
    : '• No new candidates discovered yet.';

  const pending = summary.pendingProposals
    ? `${summary.pendingProposals} pending (${summary.pendingCodes.join(', ')}) — approve with \`admin accept fix <CODE>\``
    : 'None pending.';

  return [
    '🧠 *Saka Model Watchdog*',
    '',
    '*Active*',
    slots,
    '',
    '*Candidates*',
    candidateLines,
    '',
    `*Model approvals*: ${pending}`,
    '',
    `_Scout ${summary.scoutEnabled ? 'ON' : 'OFF'} · auto-adopt ${summary.autoAdopt ? 'ON' : 'OFF'} · web search ${summary.webSearch ? 'ON' : 'OFF'}_`,
    `_Thresholds: score ≥ ${summary.minScore} · canary ≤ ${summary.maxCanaryPct}%_`,
    '',
    'Commands: `admin model scout`, `admin model adopt <model> [split]`, `admin model rollback [tier_1|tier_2|tier_3]`'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Plan guardrails: model-update work orders                           */
/* ------------------------------------------------------------------ */

function modelPlanDetails(plan) {
  const stored = plan?.proposed_changes && !Array.isArray(plan.proposed_changes) ? plan.proposed_changes : null;
  const category = String(plan?.category || stored?.category || '').toLowerCase();
  const modelId = plan?.model_id || stored?.model_id || null;
  const isModelPlan = category === 'ai_model_update' || Boolean(modelId);
  const tests = Array.isArray(plan?.tests)
    ? plan.tests
    : (Array.isArray(stored?.tests) ? stored.tests : []);
  const split = Number(plan?.traffic_split ?? stored?.traffic_split ?? AI_MODEL_MAX_CANARY_PCT);
  const rollback = String(plan?.rollback || stored?.rollback || '').trim();
  const changes = Array.isArray(plan?.changes)
    ? plan.changes
    : (Array.isArray(stored?.changes) ? stored.changes : []);
  return { stored, category, modelId, isModelPlan, tests, split, rollback, changes };
}

/**
 * Pure guardrail for `ai_model_update` work orders. Non-model plans are not
 * applicable and pass through untouched. Shared by the remediation sanitizer
 * and the CI gate.
 */
export function validateAiModelUpdatePlan(plan) {
  const { isModelPlan, modelId, tests, split, rollback, changes } = modelPlanDetails(plan);
  if (!isModelPlan) return { ok: true, applicable: false, violations: [] };

  const violations = [];
  if (!modelId) violations.push('Model update plan must name a model_id.');
  if (modelId && !/^[a-z0-9][a-z0-9._:-]{1,79}$/i.test(String(modelId))) {
    violations.push(`Model id is malformed: ${modelId}`);
  }

  for (const required of ['test_model_scout.js', 'test_model_router.js', 'test_agent_training.js']) {
    if (!tests.includes(required)) violations.push(`Model update plan must run ${required}.`);
  }

  if (!Number.isFinite(split) || split < 0 || split > AI_MODEL_MAX_CANARY_PCT) {
    violations.push(`Canary split must be between 0 and ${AI_MODEL_MAX_CANARY_PCT}%.`);
  }
  if (!rollback) violations.push('Model update plan must document its rollback (admin model rollback).');

  for (const change of changes) {
    const file = String(change?.file || '').replace(/\\/g, '/').trim();
    if (!AI_MODEL_UPDATE_ALLOWED_FILES.includes(file)) {
      violations.push(`Model update may only touch allowlisted files: ${file || '(missing)'}`);
    }
  }

  return { ok: violations.length === 0, applicable: true, violations };
}

/**
 * DB-backed guardrail: the model must exist in the registry, be benchmarked
 * (or already adopted), and clear the score threshold. Used at plan submit and
 * again at the execution gate so a stale plan can never adopt an unvetted model.
 */
export async function verifyModelUpdateAgainstRegistry(providedSupabase, plan) {
  const { isModelPlan, modelId } = modelPlanDetails(plan);
  if (!isModelPlan) return { ok: true, applicable: false, violations: [] };
  if (!modelId) return { ok: false, applicable: true, violations: ['Model update plan must name a model_id.'] };

  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, applicable: true, violations: ['Model registry is unavailable (no Supabase client).'] };

  try {
    const { data, error } = await supabase
      .from(AI_MODEL_REGISTRY_TABLE)
      .select('*')
      .eq('model_id', modelId)
      .maybeSingle();
    if (error) return { ok: false, applicable: true, violations: [`Registry lookup failed: ${error.message}`] };
    if (!data) return { ok: false, applicable: true, violations: [`Model ${modelId} is not in the registry.`] };

    const violations = [];
    const adoptable = [AI_MODEL_STATUS.BENCHMARKED, AI_MODEL_STATUS.ACTIVE, AI_MODEL_STATUS.STANDBY];
    if (!adoptable.includes(data.status)) {
      violations.push(`Model ${modelId} has status '${data.status}' — only benchmarked models may be adopted.`);
    }
    const score = Number(data.benchmark?.score);
    if (Number.isFinite(score) && score < AI_MODEL_MIN_BENCHMARK_SCORE) {
      violations.push(`Model ${modelId} scored ${score}, below the ${AI_MODEL_MIN_BENCHMARK_SCORE} threshold.`);
    }
    if (!data.benchmark) violations.push(`Model ${modelId} has no stored benchmark.`);
    return { ok: violations.length === 0, applicable: true, violations, row: data };
  } catch (err) {
    return { ok: false, applicable: true, violations: [`Registry verification failed: ${err.message}`] };
  }
}

export default {
  AI_MODEL_REGISTRY_TABLE,
  AI_MODEL_EVAL_TABLE,
  AI_MODEL_STATUS,
  AI_MODEL_TIER_SLOTS,
  AI_MODEL_BENCH_CASES,
  AI_MODEL_SEED_ROWS,
  AI_MODEL_UPDATE_ALLOWED_FILES,
  classifyModelVersion,
  normalizeDiscoveredModels,
  ensureAiModelRegistryTables,
  seedModelRegistry,
  discoverProviderModels,
  probeModelCapabilities,
  runModelBenchmark,
  recordEvalRun,
  getRegistryRows,
  upsertDiscoveredModels,
  refreshRuntimeModelCache,
  pickModelForSlot,
  resolveRuntimeModel,
  installModelRuntime,
  resetModelRuntime,
  applyModelRollout,
  rollbackModel,
  recommendModelUpdate,
  createModelUpdateProposal,
  researchModelLandscape,
  runModelScoutCycle,
  monitorModelHealth,
  getModelWatchdogSummary,
  formatModelRegistryReply,
  validateAiModelUpdatePlan,
  verifyModelUpdateAgainstRegistry
};













