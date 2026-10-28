import OpenAI from 'openai';

/**
 * Saka Fleet — Centralised LLM Client (DeepSeek via OpenAI-compatible API).
 *
 * DeepSeek exposes an OpenAI-compatible /v1/chat/completions surface, so the
 * official `openai` SDK is used with a custom baseURL. This module is the ONLY
 * place in the codebase that talks to an LLM provider — every service
 * (sakaAi, superadmin, sentinel worker) imports from here.
 */

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat'; // DeepSeek-V3

let client = null;
let clientKey = null;

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

/** Primary model first, then optional env/env-override fallbacks. */
export function getModelCandidates() {
  return Array.from(new Set([
    process.env.DEEPSEEK_MODEL,
    DEFAULT_DEEPSEEK_MODEL,
    'deepseek-chat'
  ].filter(Boolean)));
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
 */
export async function chatCompletion({
  system = '',
  messages = [],
  jsonMode = false,
  maxTokens = 2048,
  temperature = 0.4,
  model = null
} = {}) {
  let lastError = null;

  const candidateModels = model ? [model] : getModelCandidates();
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 12000);

  for (const candidate of candidateModels) {
    try {
      const ai = getAIClient();

      const payloadMessages = [];
      if (system && system.trim()) {
        payloadMessages.push({ role: 'system', content: system });
      }
      payloadMessages.push(...messages);

      // DeepSeek's json_object mode requires the word "json" somewhere in the
      // conversation, otherwise the request is rejected.
      if (jsonMode) {
        const hasJsonKeyword = payloadMessages.some((m) =>
          typeof m.content === 'string' && /json/i.test(m.content)
        );
        if (!hasJsonKeyword) {
          payloadMessages.push({ role: 'user', content: 'Respond with valid JSON only.' });
        }
      }

      const request = {
        model: candidate,
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
      const text = response?.choices?.[0]?.message?.content || '';

      if (text && text.trim()) {
        return { ok: true, text: text.trim(), model: candidate, error: null };
      }
      lastError = new Error('Empty completion returned by DeepSeek');
    } catch (err) {
      lastError = err;
      console.warn(`[aiClient] DeepSeek call failed for model '${candidate}':`, err?.message || err);
    }
  }

  return { ok: false, text: '', model: null, error: lastError };
}

/** Convenience: single-turn prompt, returns text or null. */
export async function generateText({ system = '', prompt, jsonMode = false, maxTokens = 2048, temperature = 0.4 }) {
  const result = await chatCompletion({
    system,
    messages: [{ role: 'user', content: prompt }],
    jsonMode,
    maxTokens,
    temperature
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
