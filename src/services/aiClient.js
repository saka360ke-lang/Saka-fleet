import OpenAI from 'openai';

/**
 * Saka Fleet — Centralised LLM Client & Purpose Router (v1.12.0, Phase 0).
 *
 * This module is the ONLY place in the codebase that talks to an LLM provider.
 * Every service (sakaAi, superadmin, sentinel worker, remediation worker) routes
 * through `chatCompletion()` / `generateText()`.
 *
 * Phase 0 adds a purpose → tier router on top of the existing DeepSeek client:
 *   Tier 0 — deterministic (no model; callers skip AI entirely)
 *   Tier 1 — router/utility tasks (deepseek-chat)
 *   Tier 2 — conversational nuance (deepseek-chat until PREMIUM_MODEL_ENABLED=on)
 *   Tier 3 — reasoning/synthesis (deepseek-chat; AI_MODEL_TIER_3=deepseek-reasoner opt-in)
 *
 * All tiers resolve to DeepSeek by default, so Phase 0 is behaviour-identical to
 * the legacy client. `PREMIUM_MODEL_ENABLED` is the master kill switch for the
 * conversational tier (default off, mirroring REMEDIATION_AUTONOMY).
 */

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat'; // DeepSeek-V3
export const DEFAULT_DEEPSEEK_REASONER = 'deepseek-reasoner'; // Tier-3 opt-in
export const DEFAULT_ANTHROPIC_TIER2_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_OPENAI_TIER2_MODEL = 'gpt-4o';

export const AI_PROVIDERS = Object.freeze({
  DEEPSEEK: 'deepseek',
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai'
});

export const AI_TIERS = Object.freeze({
  DETERMINISTIC: 0,
  ROUTER: 1,
  CONVERSATIONAL: 2,
  REASONING: 3
});

const TRUTHY = new Set(['on', 'true', '1']);

/** Purposes that get one extra attempt when a provider returns an empty body. */
export const EMPTY_RETRY_PURPOSES = new Set(['intent_classify', 'question_render', 'prose_render']);

/** v1.22.0 — a slow empty answer must not spend a second full timeout. */
export const EMPTY_RETRY_MAX_FIRST_MS = (() => {
  const raw = Number(process.env.EMPTY_RETRY_MAX_FIRST_MS || 5000);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
})();

/** Faster ceiling for quiz question rendering (deterministic fallback follows). */
export function getQuestionTimeoutMs() {
  const raw = Number(process.env.AI_TIMEOUT_MS_QUESTION || 10000);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30000) : 10000;
}

/** Purpose/provider/latency gate for the single empty-completion retry. */
export function shouldRetryEmpty({ purpose = null, provider = null, firstAttemptMs = 0 } = {}) {
  if (!EMPTY_RETRY_PURPOSES.has(String(purpose || ''))) return false;
  if (provider === AI_PROVIDERS.ANTHROPIC) return false;
  return Number(firstAttemptMs) <= EMPTY_RETRY_MAX_FIRST_MS;
}

/** Master kill switch for premium conversational routing (default: off). */
export function isPremiumModelEnabled() {
  return TRUTHY.has(String(process.env.PREMIUM_MODEL_ENABLED || 'off').toLowerCase());
}

/** REMEDIATION_AUTONOMY kill switch (default off; mirrors githubDispatch). */
export function isRemediationAutonomyOn() {
  return TRUTHY.has(String(process.env.REMEDIATION_AUTONOMY || 'off').toLowerCase());
}

/**
 * Runtime model resolver seam (v1.17.0). The Model Watchdog installs a resolver
 * that returns the DB-adopted model for a tier. Env overrides ALWAYS win, so an
 * operator-set AI_MODEL_TIER_* can never be overridden by the registry.
 */
let runtimeModelResolver = null;

export function setRuntimeModelResolver(resolver) {
  runtimeModelResolver = typeof resolver === 'function' ? resolver : null;
}

export function getRuntimeModelResolver() {
  return runtimeModelResolver;
}

function resolveRuntimeModel(tier, provider) {
  if (!runtimeModelResolver) return null;
  try {
    const model = runtimeModelResolver(tier, provider);
    return typeof model === 'string' && model.trim() ? model.trim() : null;
  } catch {
    // A registry outage must never break routing: fall back to env/default.
    return null;
  }
}

/**
 * Resolve the model configured for a tier. Precedence: explicit env override →
 * DB-adopted model (Model Watchdog) → provider default. Premium tiers are
 * provider-aware: an unset AI_MODEL_TIER_2 resolves to the provider's default
 * rather than a DeepSeek model name that the provider would reject. Tier 3 opts
 * into the reasoning model only when REMEDIATION_AUTONOMY=on (explicit opt-in).
 */
export function getTierModel(tier, providerOverride = null) {
  if (tier === AI_TIERS.CONVERSATIONAL) {
    if (process.env.AI_MODEL_TIER_2) return process.env.AI_MODEL_TIER_2;
    const runtime = resolveRuntimeModel(tier, providerOverride);
    if (runtime) return runtime;
    if (providerOverride === AI_PROVIDERS.ANTHROPIC) return DEFAULT_ANTHROPIC_TIER2_MODEL;
    if (providerOverride === AI_PROVIDERS.OPENAI) {
      return process.env.AI_MODEL_TIER_2_OPENAI || DEFAULT_OPENAI_TIER2_MODEL;
    }
    return DEFAULT_DEEPSEEK_MODEL;
  }
  if (tier === AI_TIERS.REASONING) {
    if (process.env.AI_MODEL_TIER_3) return process.env.AI_MODEL_TIER_3;
    const runtime = resolveRuntimeModel(tier, providerOverride);
    if (runtime) return runtime;
    return isRemediationAutonomyOn() ? DEFAULT_DEEPSEEK_REASONER : DEFAULT_DEEPSEEK_MODEL;
  }
  if (process.env.AI_MODEL_TIER_1 || process.env.DEEPSEEK_MODEL) {
    return process.env.AI_MODEL_TIER_1 || process.env.DEEPSEEK_MODEL;
  }
  const runtime = resolveRuntimeModel(tier, providerOverride);
  if (runtime) return runtime;
  return DEFAULT_DEEPSEEK_MODEL;
}

/** Provider for the conversational tier (Phase 1 flips this to anthropic/openai). */
export function getConversationalProvider() {
  return String(process.env.CONVERSATIONAL_PROVIDER || AI_PROVIDERS.DEEPSEEK).toLowerCase();
}

/** Provider for reasoning/synthesis calls (Phase 3, default DeepSeek). */
export function getReasoningProvider() {
  return String(process.env.AI_REASONING_PROVIDER || AI_PROVIDERS.DEEPSEEK).toLowerCase();
}

export function getPremiumTimeoutMs() {
  return Number(process.env.AI_TIMEOUT_MS_PREMIUM || 15000);
}

/** Reasoning calls are background-only, so they get a longer fail-fast budget. */
export function getReasoningTimeoutMs() {
  return Math.max(1000, Number(process.env.AI_TIMEOUT_MS_REASONING || 45000));
}

export function getPremiumMaxConcurrency() {
  return Math.max(1, Number(process.env.AI_PREMIUM_MAX_CONCURRENCY || 2));
}

/**
 * Purpose registry — the single source of truth for tier/parameter defaults.
 * Phase 0 callers keep passing their explicit maxTokens/temperature, so tagging
 * a call with a purpose never changes the request payload.
 */
export const AI_PURPOSES = Object.freeze({
  intent_classify: { tier: AI_TIERS.CONVERSATIONAL, jsonMode: true, maxTokens: 800, temperature: 0.3 },
  extraction: { tier: AI_TIERS.ROUTER, jsonMode: true, maxTokens: 600, temperature: 0.1 },
  question_render: { tier: AI_TIERS.ROUTER, maxTokens: 420, temperature: 0.4 },
  prose_render: { tier: AI_TIERS.CONVERSATIONAL, maxTokens: 520, temperature: 0.4 },
  stall_nudge: { tier: AI_TIERS.ROUTER, maxTokens: 420, temperature: 0.4 },
  small_talk: { tier: AI_TIERS.ROUTER, maxTokens: 320, temperature: 0.6 },
  admin_parse: { tier: AI_TIERS.ROUTER, jsonMode: true, maxTokens: 512, temperature: 0.2 },
  health_synthesis: { tier: AI_TIERS.REASONING, maxTokens: 900, temperature: 0.5 },
  sentinel_diagnosis: { tier: AI_TIERS.REASONING, maxTokens: 900, temperature: 0.3 },
  prompt_refinement: { tier: AI_TIERS.REASONING, jsonMode: true, maxTokens: 4096, temperature: 0.4 },
  friction_patch: { tier: AI_TIERS.REASONING, jsonMode: true, maxTokens: 600, temperature: 0.4 },
  horizon_synthesis: { tier: AI_TIERS.REASONING, jsonMode: true, maxTokens: 1200, temperature: 0.5 },
  remediation_synthesis: { tier: AI_TIERS.REASONING, jsonMode: true, maxTokens: 1200, temperature: 0.2 },
  model_benchmark: { tier: AI_TIERS.ROUTER, jsonMode: true, maxTokens: 120, temperature: 0 },
  model_research: { tier: AI_TIERS.ROUTER, maxTokens: 500, temperature: 0.2 },
  default: { tier: AI_TIERS.ROUTER }
});

/**
 * Resolve a purpose to `{ tier, provider, model }`.
 * Tier 2 downgrades to Tier 1 while PREMIUM_MODEL_ENABLED is off; Tier 0 means
 * "no model call" and returns null provider/model.
 */
export function resolveTier(purpose = 'default', { tier: forcedTier, maxTier = null } = {}) {
  const def = AI_PURPOSES[purpose] || AI_PURPOSES.default;
  let tier = forcedTier ?? def.tier;

  // Entitlement clamp (v1.15.0): Free plans resolve to Tier 1 regardless of
  // premium routing. System/background purposes simply omit `maxTier`.
  if (maxTier !== null && maxTier !== undefined && Number.isFinite(Number(maxTier))) {
    const cap = Math.min(AI_TIERS.REASONING, Math.max(AI_TIERS.DETERMINISTIC, Number(maxTier)));
    tier = Math.min(tier, cap);
  }

  if (tier === AI_TIERS.DETERMINISTIC) {
    return { tier, provider: null, model: null };
  }
  if (tier === AI_TIERS.CONVERSATIONAL && !isPremiumModelEnabled()) {
    tier = AI_TIERS.ROUTER;
  }

  const provider = tier === AI_TIERS.CONVERSATIONAL
    ? getConversationalProvider()
    : (tier === AI_TIERS.REASONING ? getReasoningProvider() : AI_PROVIDERS.DEEPSEEK);

  return { tier, provider, model: getTierModel(tier, provider) };
}

/**
 * Full routing result for a purpose: tier/provider/model plus the ordered
 * candidate list (purpose model first, DeepSeek fallbacks last).
 */
export function routeModelForPurpose(purpose = 'default', ctx = {}) {
  const { tier: forcedTier, maxTier = null } = ctx || {};
  const resolved = resolveTier(purpose, { tier: forcedTier, maxTier });
  if (!resolved.model) return { ...resolved, candidates: [] };

  const candidates = [resolved.model];
  if (resolved.provider === AI_PROVIDERS.DEEPSEEK) {
    for (const candidate of getModelCandidates()) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return { ...resolved, candidates };
}

let client = null;
let clientKey = null;
const providerClients = new Map();

/**
 * Lazily initialise (and cache) the DeepSeek client.
 * Throws only when the key is genuinely missing so callers can degrade gracefully.
 */
export function getAIClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY missing in environment');
  }
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({ baseURL: DEEPSEEK_BASE_URL, apiKey });
    clientKey = apiKey;
  }
  return client;
}

/**
 * Lazily initialise a provider client. Phase 0 fully supports DeepSeek and
 * OpenAI (same SDK, default base URL). Anthropic arrives in Phase 1 — until
 * then it returns null and `chatCompletion()` falls back to DeepSeek so the
 * premium toggle can never brick a conversation.
 */
export function getProviderClient(provider = AI_PROVIDERS.DEEPSEEK) {
  const normalized = String(provider || AI_PROVIDERS.DEEPSEEK).toLowerCase();

  if (normalized === AI_PROVIDERS.DEEPSEEK) {
    return getAIClient();
  }

  if (normalized === AI_PROVIDERS.OPENAI) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY missing in environment');
    const cacheKey = `${normalized}:${apiKey.slice(-8)}`;
    if (!providerClients.has(cacheKey)) {
      providerClients.set(cacheKey, new OpenAI({ apiKey }));
    }
    return providerClients.get(cacheKey);
  }

  if (normalized === AI_PROVIDERS.ANTHROPIC) {
    // Anthropic is invoked through runAnthropicAttempt() (fetch-based, no SDK).
    return null;
  }

  console.warn(`[aiClient] Provider '${normalized}' is not available yet — falling back to DeepSeek.`);
  return null;
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages API adapter (fetch-based, no SDK dependency)     */
/* ------------------------------------------------------------------ */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Translate the OpenAI-shaped payload into Anthropic Messages format.
 * - system entries are hoisted into the top-level `system` string
 * - roles collapse to user/assistant and consecutive same-role turns merge
 * - leading assistant turns are dropped (Anthropic expects a user first)
 * - jsonMode appends the JSON instruction when absent
 */
export function toAnthropicMessages(system = '', messages = [], jsonMode = false) {
  const systemParts = [];
  if (system && system.trim()) systemParts.push(system.trim());

  const translated = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.content !== 'string' || !message.content.trim()) continue;
    const content = message.content.trim();
    if (message.role === 'system') {
      systemParts.push(content);
      continue;
    }
    const role = message.role === 'assistant' || message.role === 'model' ? 'assistant' : 'user';
    const last = translated[translated.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${content}`;
    else translated.push({ role, content });
  }
  while (translated.length && translated[0].role === 'assistant') translated.shift();

  if (jsonMode && !systemParts.some((part) => /json/i.test(part))) {
    systemParts.push('Respond with valid JSON only.');
  }

  return { system: systemParts.join('\n\n'), messages: translated };
}

/** Normalize an Anthropic Messages response into text + token usage. */
export function normalizeAnthropicResponse(payload = {}) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return {
    text,
    promptTokens: Number.isFinite(payload?.usage?.input_tokens) ? payload.usage.input_tokens : null,
    completionTokens: Number.isFinite(payload?.usage?.output_tokens) ? payload.usage.output_tokens : null
  };
}

/**
 * Call Anthropic's Messages API. Throws on a missing key, non-2xx status,
 * timeout (AbortSignal) or network failure — chatCompletion() then falls back
 * to DeepSeek, preserving the never-throws contract for callers.
 */
export async function runAnthropicAttempt({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model,
  system = '',
  messages = [],
  jsonMode = false,
  maxTokens = 2048,
  temperature = 0.4,
  timeoutMs = getPremiumTimeoutMs()
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing in environment');

  const translated = toAnthropicMessages(system, messages, jsonMode);
  const payload = {
    model,
    system: translated.system || undefined,
    messages: translated.messages,
    max_tokens: maxTokens
  };
  // Newer Claude models (Sonnet 5.5+) mark `temperature` as deprecated and
  // return HTTP 400 when it is sent. Omit it by default; legacy deployments
  // that still need it can opt in explicitly.
  if (TRUTHY.has(String(process.env.ANTHROPIC_TEMPERATURE_SUPPORTED || 'off').toLowerCase())) {
    payload.temperature = temperature;
  }
  const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 200)}`);
  }

  return normalizeAnthropicResponse(await response.json());
}

/* ------------------------------------------------------------------ */
/* Premium concurrency guard (in-process, overflow → DeepSeek)         */
/* ------------------------------------------------------------------ */

let premiumInFlight = 0;

function tryAcquirePremiumSlot() {
  if (premiumInFlight >= getPremiumMaxConcurrency()) return false;
  premiumInFlight += 1;
  return true;
}

function releasePremiumSlot() {
  premiumInFlight = Math.max(0, premiumInFlight - 1);
}

/** Primary model first, then optional env/env-override fallbacks. */
export function getModelCandidates() {
  return Array.from(new Set([
    process.env.DEEPSEEK_MODEL,
    DEFAULT_DEEPSEEK_MODEL,
    'deepseek-chat'
  ].filter(Boolean)));
}

/* ------------------------------------------------------------------ */
/* Circuit breakers (in-memory, per provider; DeepSeek is exempt)       */
/* ------------------------------------------------------------------ */

export const AI_BREAKER_DEFAULTS = Object.freeze({ failureThreshold: 3, windowMs: 60000, openMs: 30000 });

function getBreakerConfig() {
  return {
    failureThreshold: Math.max(1, Number(process.env.AI_CB_FAILURE_THRESHOLD || AI_BREAKER_DEFAULTS.failureThreshold)),
    windowMs: Math.max(1000, Number(process.env.AI_CB_WINDOW_MS || AI_BREAKER_DEFAULTS.windowMs)),
    openMs: Math.max(1000, Number(process.env.AI_CB_OPEN_MS || AI_BREAKER_DEFAULTS.openMs))
  };
}

const providerBreakers = new Map();

function getBreaker(provider) {
  if (!providerBreakers.has(provider)) providerBreakers.set(provider, { failures: [], openedUntil: 0 });
  return providerBreakers.get(provider);
}

export function isProviderCircuitOpen(provider, now = Date.now()) {
  if (!provider || provider === AI_PROVIDERS.DEEPSEEK) return false;
  const breaker = providerBreakers.get(provider);
  if (!breaker) return false;
  if (breaker.openedUntil && breaker.openedUntil > now) return true;
  if (breaker.openedUntil) {
    // Cooldown elapsed: allow the provider again with a clean slate.
    breaker.openedUntil = 0;
    breaker.failures = [];
  }
  return false;
}

/** Record one provider outcome; opens the breaker after N failures in-window. */
export function recordProviderOutcome(provider, ok, now = Date.now()) {
  if (!provider || provider === AI_PROVIDERS.DEEPSEEK) return;
  const breaker = getBreaker(provider);
  if (ok) {
    breaker.failures = [];
    breaker.openedUntil = 0;
    return;
  }
  const { failureThreshold, windowMs, openMs } = getBreakerConfig();
  breaker.failures = breaker.failures.filter((timestamp) => now - timestamp <= windowMs);
  breaker.failures.push(now);
  if (breaker.failures.length >= failureThreshold) {
    breaker.openedUntil = now + openMs;
    breaker.failures = [];
    console.warn(`[aiClient] Circuit breaker OPEN for '${provider}' for ${openMs}ms after ${failureThreshold} failures.`);
  }
}

/** Test/ops helper: clear every breaker state. */
export function resetProviderBreakers() {
  providerBreakers.clear();
}

/* ------------------------------------------------------------------ */
/* Budget guard seam (wired by aiUsageLog.installAiBudgetGuard)         */
/* ------------------------------------------------------------------ */

let budgetGuard = null;

export function setBudgetGuard(guard) {
  budgetGuard = typeof guard === 'function' ? guard : null;
}

export function getBudgetGuard() {
  return budgetGuard;
}

async function isBudgetExceeded(routing) {
  if (routing.tier !== AI_TIERS.CONVERSATIONAL || !budgetGuard) return false;
  try {
    return (await budgetGuard()) === true;
  } catch {
    // Fail-open: a budget lookup outage must never block a conversation.
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Provider failover chain (Phase 3)                                    */
/* ------------------------------------------------------------------ */

/** True when a provider has credentials configured. */
export function hasProviderKey(provider) {
  if (provider === AI_PROVIDERS.DEEPSEEK) return Boolean(process.env.DEEPSEEK_API_KEY);
  if (provider === AI_PROVIDERS.ANTHROPIC) return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === AI_PROVIDERS.OPENAI) return Boolean(process.env.OPENAI_API_KEY);
  return false;
}

/** Default model used when a premium provider is a secondary fallback leg. */
function getPremiumFallbackModel(provider) {
  if (provider === AI_PROVIDERS.OPENAI) return process.env.AI_MODEL_TIER_2_OPENAI || DEFAULT_OPENAI_TIER2_MODEL;
  if (provider === AI_PROVIDERS.ANTHROPIC) return DEFAULT_ANTHROPIC_TIER2_MODEL;
  return DEFAULT_DEEPSEEK_MODEL;
}

/**
 * Build the ordered provider chain for a routing decision.
 *
 * Premium legs are skipped (and logged as `steps[].skipReason`) when their API
 * key is missing, their circuit breaker is open, or the daily budget guard is
 * exceeded. DeepSeek is ALWAYS appended last and is never skipped or
 * breaker-blocked — the never-throws fallback contract depends on it.
 */
export function buildProviderChain(routing = {}, { budgetExceeded = false, now = Date.now() } = {}) {
  const steps = [];
  const chain = [];
  const seen = new Set();

  const push = (provider, model, skipReason = null) => {
    if (!provider) return;
    steps.push({ provider, model: model || null, skipReason });
    if (skipReason || !model) return;
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ provider, model });
  };

  const premiumOrder = [];
  if (routing.explicit && routing.provider && routing.provider !== AI_PROVIDERS.DEEPSEEK) {
    premiumOrder.push(routing.provider);
  } else if (routing.tier === AI_TIERS.CONVERSATIONAL) {
    if (routing.provider && routing.provider !== AI_PROVIDERS.DEEPSEEK) premiumOrder.push(routing.provider);
    for (const provider of [AI_PROVIDERS.OPENAI, AI_PROVIDERS.ANTHROPIC]) {
      if (provider !== routing.provider) premiumOrder.push(provider);
    }
  } else if (routing.tier === AI_TIERS.REASONING) {
    if (routing.provider && routing.provider !== AI_PROVIDERS.DEEPSEEK) premiumOrder.push(routing.provider);
  }

  for (const provider of premiumOrder) {
    const model = provider === routing.provider ? routing.model : getPremiumFallbackModel(provider);
    let skipReason = null;
    if (!hasProviderKey(provider)) skipReason = 'skipped_missing_key';
    else if (isProviderCircuitOpen(provider, now)) skipReason = 'skipped_circuit_open';
    else if (budgetExceeded) skipReason = 'skipped_budget';
    push(provider, model, skipReason);
  }

  const deepseekModels = routing.provider && routing.provider !== AI_PROVIDERS.DEEPSEEK
    ? getModelCandidates()
    : (routing.candidates || getModelCandidates());
  for (const model of deepseekModels) push(AI_PROVIDERS.DEEPSEEK, model);

  return { steps, chain };
}

/* ------------------------------------------------------------------ */
/* Usage telemetry sink (fire-and-forget; wired by aiUsageLog.js)      */
/* ------------------------------------------------------------------ */

let aiUsageSink = null;

export function setAiUsageSink(sink) {
  aiUsageSink = typeof sink === 'function' ? sink : null;
}

export function getAiUsageSink() {
  return aiUsageSink;
}

function emitAiUsage(record) {
  const sink = aiUsageSink;
  if (!sink) return;
  try {
    const maybePromise = sink(record);
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => {});
    }
  } catch {
    // Telemetry must never break a conversation turn.
  }
}

function measureInputChars(system, messages) {
  let chars = typeof system === 'string' ? system.length : 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message && typeof message.content === 'string') chars += message.content.length;
  }
  return chars;
}

/**
 * Normalise Saka's internal chat-history shape
 * (`{ role: 'user'|'model', parts: [{ text }] }`) into OpenAI messages.
 */
export function normalizeHistory(history = []) {
  const messages = [];
  if (!Array.isArray(history)) return messages;
  for (const item of history) {
    if (!item || !item.role) continue;
    let text = '';
    if (Array.isArray(item.parts)) {
      text = item.parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
    } else if (typeof item.content === 'string') {
      text = item.content;
    }
    if (!text.trim()) continue;
    const role = item.role === 'model' || item.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: text });
  }
  return messages;
}

/**
 * Low-level chat completion. Returns `{ ok, text, model, error }` — never throws,
 * so both the WhatsApp pipeline and Sentinel can fall back deterministically.
 *
 * Phase 0 additions (all optional, backward-compatible):
 *   - `purpose`  routes the call through the tier registry (see AI_PURPOSES)
 *   - `provider` overrides the provider (legacy calls default to DeepSeek)
 *   - every outcome emits a usage record to the installed telemetry sink
 */
export async function chatCompletion({
  system = '',
  messages = [],
  jsonMode = false,
  maxTokens = 2048,
  temperature = 0.4,
  model = null,
  provider = null,
  purpose = null,
  tier = null,
  maxTier = null,
  ownerId = null,
  webSearch = false
} = {}) {
  let lastError = null;
  const startedAt = Date.now();
  const inputChars = measureInputChars(system, messages);

  // Explicit `model` keeps the legacy contract (single provider, DeepSeek).
  // Otherwise a purpose (optionally with a canary tier override) routes.
  // `maxTier` is the subscription entitlement clamp (Free = 1, paid = 3).
  const routing = model
    ? { tier: null, provider: provider || AI_PROVIDERS.DEEPSEEK, candidates: [model], model, explicit: true }
    : (purpose
      ? routeModelForPurpose(purpose, { tier, maxTier })
      : { tier: null, provider: provider || AI_PROVIDERS.DEEPSEEK, candidates: getModelCandidates(), explicit: true });

  const budgetExceeded = await isBudgetExceeded(routing);
  const { steps, chain } = buildProviderChain(routing, { budgetExceeded });
  const attempts = chain;
  const attemptLog = steps
    .filter((step) => step.skipReason)
    .map((step) => ({
      provider: step.provider,
      model: step.model || null,
      outcome: step.skipReason,
      latencyMs: 0,
      error: null
    }));

  const baseTimeoutMs = routing.tier === AI_TIERS.CONVERSATIONAL
    ? getPremiumTimeoutMs()
    : (routing.tier === AI_TIERS.REASONING ? getReasoningTimeoutMs() : Number(process.env.AI_TIMEOUT_MS || 12000));
  // v1.22.0 — quiz questions render from the deterministic template if the
  // provider is slow; never let a question block the turn for 19 s.
  const timeoutMs = String(purpose || '') === 'question_render' && routing.tier === AI_TIERS.ROUTER
    ? Math.min(baseTimeoutMs, getQuestionTimeoutMs())
    : baseTimeoutMs;

  let lastProvider = routing.provider;
  let lastModel = attempts[0]?.model || null;

  for (const attempt of attempts) {
    let premiumSlotHeld = false;
    const attemptStartedAt = Date.now();
    try {
      let text = '';
      let promptTokens = null;
      let completionTokens = null;

      if (attempt.provider === AI_PROVIDERS.ANTHROPIC) {
        // Premium concurrency cap: overflow straight to the DeepSeek fallback.
        if (!tryAcquirePremiumSlot()) {
          lastError = new Error('Premium concurrency cap reached — overflowing to DeepSeek.');
          lastProvider = attempt.provider;
          lastModel = attempt.model;
          attemptLog.push({
            provider: attempt.provider,
            model: attempt.model,
            outcome: 'skipped_concurrency',
            latencyMs: 0,
            error: lastError.message
          });
          continue;
        }
        premiumSlotHeld = true;
        const anthropicResult = await runAnthropicAttempt({
          model: attempt.model,
          system,
          messages,
          jsonMode,
          maxTokens,
          temperature,
          timeoutMs
        });
        text = anthropicResult.text;
        promptTokens = anthropicResult.promptTokens;
        completionTokens = anthropicResult.completionTokens;
      } else {
        const ai = getProviderClient(attempt.provider);
        if (!ai) throw new Error(`Provider '${attempt.provider}' is not configured`);

        const payloadMessages = [];
        if (system && system.trim()) {
          payloadMessages.push({ role: 'system', content: system });
        }
        payloadMessages.push(...messages);

        // DeepSeek/OpenAI json_object mode requires the word "json" somewhere.
        if (jsonMode) {
          const hasJsonKeyword = payloadMessages.some((m) =>
            typeof m.content === 'string' && /json/i.test(m.content)
          );
          if (!hasJsonKeyword) {
            payloadMessages.push({ role: 'user', content: 'Respond with valid JSON only.' });
          }
        }

        const request = {
          model: attempt.model,
          messages: payloadMessages,
          max_tokens: maxTokens,
          temperature
        };
        if (jsonMode) {
          request.response_format = { type: 'json_object' };
        }

        // Capability-gated web search/fetch (v1.17.0): only DeepSeek exposes the
        // tool surface today, and only callers that explicitly opted in use it.
        // If the deployment rejects the tool, degrade to a plain completion so a
        // research leg can never break the scout cycle.
        const supportsWebSearch = Boolean(webSearch) && attempt.provider === AI_PROVIDERS.DEEPSEEK;
        if (supportsWebSearch) request.tools = [{ type: 'web_search' }];

        let response;
        try {
          response = await ai.chat.completions.create(request, {
            timeout: timeoutMs,
            // Fail fast to the deterministic fallback instead of SDK retries.
            maxRetries: 0
          });
        } catch (toolErr) {
          if (!supportsWebSearch) throw toolErr;
          delete request.tools;
          attemptLog.push({
            provider: attempt.provider,
            model: attempt.model,
            outcome: 'web_search_unsupported',
            latencyMs: Date.now() - attemptStartedAt,
            error: toolErr?.message || String(toolErr)
          });
          response = await ai.chat.completions.create(request, {
            timeout: timeoutMs,
            maxRetries: 0
          });
        }
        text = response?.choices?.[0]?.message?.content || '';
        promptTokens = response?.usage?.prompt_tokens ?? null;
        completionTokens = response?.usage?.completion_tokens ?? null;
      }

      // v1.19.1 — one purpose-scoped retry on empty completions. DeepSeek
      // occasionally returns an empty body for intent_classify; a single cheap
      // retry recovers the turn instead of falling straight to the regex path.
      if ((!text || !text.trim()) && shouldRetryEmpty({
        purpose,
        provider: attempt.provider,
        firstAttemptMs: Date.now() - attemptStartedAt
      })) {
        try {
          const ai = getProviderClient(attempt.provider);
          const retryMessages = [];
          if (system && system.trim()) retryMessages.push({ role: 'system', content: system });
          retryMessages.push(...messages);
          if (jsonMode) retryMessages.push({ role: 'user', content: 'Respond with valid JSON only.' });
          const retryRequest = {
            model: attempt.model,
            messages: retryMessages,
            max_tokens: maxTokens,
            temperature: Math.min(0.9, Math.max(0, temperature + 0.05))
          };
          if (jsonMode) retryRequest.response_format = { type: 'json_object' };
          const retryResponse = await ai.chat.completions.create(retryRequest, {
            timeout: timeoutMs,
            maxRetries: 0
          });
          const retryText = retryResponse?.choices?.[0]?.message?.content || '';
          if (retryText && retryText.trim()) {
            text = retryText;
            promptTokens = (promptTokens || 0) + (retryResponse?.usage?.prompt_tokens || 0);
            completionTokens = (completionTokens || 0) + (retryResponse?.usage?.completion_tokens || 0);
            attemptLog.push({
              provider: attempt.provider,
              model: attempt.model,
              outcome: 'empty_retry_ok',
              latencyMs: Date.now() - attemptStartedAt,
              error: null
            });
          } else {
            attemptLog.push({
              provider: attempt.provider,
              model: attempt.model,
              outcome: 'empty_retry_failed',
              latencyMs: Date.now() - attemptStartedAt,
              error: 'Empty completion returned by provider'
            });
          }
        } catch (retryErr) {
          attemptLog.push({
            provider: attempt.provider,
            model: attempt.model,
            outcome: 'empty_retry_failed',
            latencyMs: Date.now() - attemptStartedAt,
            error: retryErr?.message || String(retryErr)
          });
        }
      }

      if (text && text.trim()) {
        recordProviderOutcome(attempt.provider, true);
        emitAiUsage({
          purpose,
          ownerId,
          tier: routing.tier,
          provider: attempt.provider,
          model: attempt.model,
          latencyMs: Date.now() - startedAt,
          ok: true,
          error: null,
          inputChars,
          promptTokens,
          completionTokens,
          attempts: [...attemptLog, {
            provider: attempt.provider,
            model: attempt.model,
            outcome: 'ok',
            latencyMs: Date.now() - attemptStartedAt,
            error: null
          }]
        });
        return { ok: true, text: text.trim(), model: attempt.model, error: null };
      }
      lastError = new Error('Empty completion returned by provider');
      recordProviderOutcome(attempt.provider, false);
      attemptLog.push({
        provider: attempt.provider,
        model: attempt.model,
        outcome: 'failed',
        latencyMs: Date.now() - attemptStartedAt,
        error: lastError.message
      });
      lastProvider = attempt.provider;
      lastModel = attempt.model;
    } catch (err) {
      lastError = err;
      recordProviderOutcome(attempt.provider, false);
      attemptLog.push({
        provider: attempt.provider,
        model: attempt.model,
        outcome: 'failed',
        latencyMs: Date.now() - attemptStartedAt,
        error: err?.message || String(err)
      });
      lastProvider = attempt.provider;
      lastModel = attempt.model;
      console.warn(`[aiClient] ${attempt.provider} call failed for model '${attempt.model}':`, err?.message || err);
    } finally {
      if (premiumSlotHeld) releasePremiumSlot();
    }
  }

  emitAiUsage({
    purpose,
    ownerId,
    tier: routing.tier,
    provider: lastProvider,
    model: lastModel,
    latencyMs: Date.now() - startedAt,
    ok: false,
    error: lastError?.message || 'unknown error',
    inputChars,
    promptTokens: null,
    completionTokens: null,
    attempts: attemptLog
  });

  return { ok: false, text: '', model: null, error: lastError };
}

/** Convenience: single-turn prompt, returns text or null. */
export async function generateText({
  system = '',
  prompt,
  jsonMode = false,
  maxTokens = 2048,
  temperature = 0.4,
  provider = null,
  purpose = null,
  tier = null,
  maxTier = null,
  ownerId = null,
  model = null,
  webSearch = false
}) {
  const result = await chatCompletion({
    system,
    messages: [{ role: 'user', content: prompt }],
    jsonMode,
    maxTokens,
    temperature,
    provider,
    purpose,
    tier,
    maxTier,
    ownerId,
    model,
    webSearch
  });
  return result.ok ? result.text : null;
}

/** Strip markdown fences and parse JSON safely. Returns null on failure. */
export function parseJsonSafely(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
