import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ANTHROPIC_TIER2_MODEL } from '../src/services/aiClient.js';

/**
 * Saka Fleet — Anthropic connectivity smoke test (v1.18.0).
 * Verifies ANTHROPIC_API_KEY + the Tier-2 conversational model with a tiny
 * Messages API call. Run: node scripts/test_anthropic_connection.js
 */

export async function testAnthropicConnection({ model = process.env.AI_MODEL_TIER_2 || DEFAULT_ANTHROPIC_TIER2_MODEL } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY is not set' };
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: SAKA OK' }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, model, status: response.status, error: payload?.error?.message || 'Anthropic call failed' };
    }
    return {
      ok: true,
      model,
      status: response.status,
      reply: String(payload?.content?.[0]?.text || '').trim(),
      usage: payload?.usage || null
    };
  } catch (err) {
    return { ok: false, model, error: err.message };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  testAnthropicConnection()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('Anthropic test error:', err);
      process.exit(1);
    });
}