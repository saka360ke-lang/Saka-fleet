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

/** Master kill switch for premium conversational routing (default: off). */
export function isPremiumModelEnabled() {
  return TRUTHY.has(String(process.env.PREMIUM_MODEL_ENABLED || 'off').toLowerCase());
}

/** Resolve the model configured for a tier (all DeepSeek by default). */
export function getTierModel(tier) {
  if (tier === AI_TIERS.CONVERSATIONAL) {
    return process.env.AI_MODEL_TIER_2 || DEFAULT_DEEPSEEK_MODEL;
  }
  if (tier === AI_TIERS.REASONING) {
    return process.env.AI_MODEL_TIER_3 || DEFAULT_DEEPSEEK_MODEL;
  }
  return process.env.AI_MODEL_TIER_1 || process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
}

/** Provider for the conversational tier (Phase 1 flips this to anthropic/openai). */
export function getConversationalProvider() {
  return String(process.env.CONVERSATIONAL_PROVIDER || AI_PROVIDERS.DEEPSEEK).toLowerCase();
}

export function getPremiumTimeoutMs() {
  return Number(process.env.AI_TIMEOUT_MS_PREMIUM || 15000);
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
  default: { tier: AI_TIERS.ROUTER }
});

/**
 * Resolve a purpose to `{ tier, provider, model }`.
 * Tier 2 downgrades to Tier 1 while PREMIUM_MODEL_ENABLED is off; Tier 0 means
 * "no model call" and returns null provider/model.
 */
export function resolveTier(purpose = 'default', { tier: forcedTier } = {}) {
  const def = AI_PURPOSES[purpose] || AI_PURPOSES.default;
  let tier = forcedTier ?? def.tier;

  if (tier === AI_TIERS.DETERMINISTIC) {
    return { tier, provider: null, model: null };
  }
  if (tier === AI_TIERS.CONVERSATIONAL && !isPremiumModelEnabled()) {
    tier = AI_TIERS.ROUTER;
  }

  const provider = tier === AI_TIERS.CONVERSATIONAL
    ? getConversationalProvider()
    : AI_PROVIDERS.DEEPSEEK;

  return { tier, provider, model: getTierModel(tier) };
}

/**
 * Full routing result for a purpose: tier/provider/model plus the ordered
 * candidate list (purpose model first, DeepSeek fallbacks last).
 */
export function routeModelForPurpose(purpose = 'default', ctx = {}) {
  const { tier: forcedTier } = ctx || {};
  const resolved = resolveTier(purpose, { tier: forcedTier });
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
  const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      system: translated.system || undefined,
      messages: translated.messages,
      max_tokens: maxTokens,
      temperature
    }),
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
  tier = null
} = {}) {
  let lastError = null;
  const startedAt = Date.now();
  const inputChars = measureInputChars(system, messages);

  // Explicit `model` keeps the legacy contract (single candidate, DeepSeek).
  // Otherwise a purpose (optionally with a canary tier override) routes.
  const routing = model
    ? { tier: null, provider: provider || AI_PROVIDERS.DEEPSEEK, candidates: [model] }
    : (purpose
      ? routeModelForPurpose(purpose, { tier })
      : { tier: null, provider: provider || AI_PROVIDERS.DEEPSEEK, candidates: getModelCandidates() });

  const timeoutMs = routing.tier === AI_TIERS.CONVERSATIONAL
    ? getPremiumTimeoutMs()
    : Number(process.env.AI_TIMEOUT_MS || 12000);

  // Always keep DeepSeek as the last-resort attempt so the never-throws contract
  // survives a premium provider outage, rate limit or misconfiguration.
  const attempts = routing.candidates.map((candidate) => ({ provider: routing.provider, model: candidate }));
  if (routing.provider && routing.provider !== AI_PROVIDERS.DEEPSEEK) {
    for (const candidate of getModelCandidates()) {
      if (!attempts.some((attempt) => attempt.provider === AI_PROVIDERS.DEEPSEEK && attempt.model === candidate)) {
        attempts.push({ provider: AI_PROVIDERS.DEEPSEEK, model: candidate });
      }
    }
  }

  let lastProvider = routing.provider;
  let lastModel = attempts[0]?.model || null;

  for (const attempt of attempts) {
    let premiumSlotHeld = false;
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

        const response = await ai.chat.completions.create(request, {
          timeout: timeoutMs,
          // Fail fast to the deterministic fallback instead of SDK retries.
          maxRetries: 0
        });
        text = response?.choices?.[0]?.message?.content || '';
        promptTokens = response?.usage?.prompt_tokens ?? null;
        completionTokens = response?.usage?.completion_tokens ?? null;
      }

      if (text && text.trim()) {
        emitAiUsage({
          purpose,
          tier: routing.tier,
          provider: attempt.provider,
          model: attempt.model,
          latencyMs: Date.now() - startedAt,
          ok: true,
          error: null,
          inputChars,
          promptTokens,
          completionTokens
        });
        return { ok: true, text: text.trim(), model: attempt.model, error: null };
      }
      lastError = new Error('Empty completion returned by provider');
      lastProvider = attempt.provider;
      lastModel = attempt.model;
    } catch (err) {
      lastError = err;
      lastProvider = attempt.provider;
      lastModel = attempt.model;
      console.warn(`[aiClient] ${attempt.provider} call failed for model '${attempt.model}':`, err?.message || err);
    } finally {
      if (premiumSlotHeld) releasePremiumSlot();
    }
  }

  emitAiUsage({
    purpose,
    tier: routing.tier,
    provider: lastProvider,
    model: lastModel,
    latencyMs: Date.now() - startedAt,
    ok: false,
    error: lastError?.message || 'unknown error',
    inputChars,
    promptTokens: null,
    completionTokens: null
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
  tier = null
}) {
  const result = await chatCompletion({
    system,
    messages: [{ role: 'user', content: prompt }],
    jsonMode,
    maxTokens,
    temperature,
    provider,
    purpose,
    tier
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
