import assert from 'assert';
import {
  buildAnthropicPayload,
  normalizeAnthropicResponse,
  isTruncatedStop
} from './src/services/aiClient.js';

/**
 * Saka Fleet — Anthropic payload & truncation guard (v1.28.2). Stateless.
 *
 * Live bug (2026-10-31 19:09): claude-sonnet-5-5 spent its whole 420-token
 * output budget on hidden thinking blocks and the visible WhatsApp reply was
 * cut mid-word ("…before insur"). These tests lock the fix: thinking is off by
 * default and a max_tokens stop is never shipped as a complete answer.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const savedThinking = process.env.ANTHROPIC_THINKING_ENABLED;
const savedTemperature = process.env.ANTHROPIC_TEMPERATURE_SUPPORTED;
delete process.env.ANTHROPIC_THINKING_ENABLED;
delete process.env.ANTHROPIC_TEMPERATURE_SUPPORTED;

console.log('=== SAKA FLEET — ANTHROPIC PAYLOAD TESTS (v1.28.2) ===\n');

console.log('--- Test 1: thinking is off by default (gateway mode) ---');
const base = buildAnthropicPayload({
  model: 'claude-sonnet-5-5',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 420
});
check(base.thinking?.type === 'between_tools', 'thinking is off with the gateway-supported between_tools mode');
check(base.max_tokens === 420, 'max_tokens is forwarded unchanged');
check(base.temperature === undefined, 'temperature is omitted by default (Sonnet 5.5 rejects it)');
check(base.system === 'sys' && base.messages.length === 1, 'system + messages are translated');

console.log('\n--- Test 2: explicit opt-ins ---');
process.env.ANTHROPIC_THINKING_ENABLED = 'on';
const thinkingOn = buildAnthropicPayload({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
check(thinkingOn.thinking === undefined, 'ANTHROPIC_THINKING_ENABLED=on leaves thinking to the provider');
delete process.env.ANTHROPIC_THINKING_ENABLED;
process.env.ANTHROPIC_THINKING_MODE = 'disabled';
const customMode = buildAnthropicPayload({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
check(customMode.thinking?.type === 'disabled', 'ANTHROPIC_THINKING_MODE can override the off mode');
delete process.env.ANTHROPIC_THINKING_MODE;
process.env.ANTHROPIC_TEMPERATURE_SUPPORTED = 'on';
const withTemp = buildAnthropicPayload({ model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.4 });
check(withTemp.temperature === 0.4, 'temperature is sent only when explicitly supported');
delete process.env.ANTHROPIC_TEMPERATURE_SUPPORTED;

console.log('\n--- Test 3: truncation is detected, never shipped ---');
const truncated = normalizeAnthropicResponse({
  content: [{ type: 'text', text: '…before insur' }],
  stop_reason: 'max_tokens',
  usage: { input_tokens: 3853, output_tokens: 420 }
});
check(truncated.stopReason === 'max_tokens', 'stop_reason is surfaced');
check(isTruncatedStop(truncated.stopReason) === true, 'a max_tokens stop is treated as truncation');
check(isTruncatedStop('end_turn') === false, 'a normal end_turn is complete');
check(isTruncatedStop('stop_sequence') === false, 'a stop_sequence is complete');
const normal = normalizeAnthropicResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
check(normal.stopReason === 'end_turn' && normal.text === 'ok', 'normal responses pass through');

console.log('\n--- Test 4: JSON mode ---');
const jsonPayload = buildAnthropicPayload({ model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true });
check(/json/i.test(jsonPayload.system || ''), 'json mode injects the JSON instruction');

if (savedThinking === undefined) delete process.env.ANTHROPIC_THINKING_ENABLED;
else process.env.ANTHROPIC_THINKING_ENABLED = savedThinking;
if (savedTemperature === undefined) delete process.env.ANTHROPIC_TEMPERATURE_SUPPORTED;
else process.env.ANTHROPIC_TEMPERATURE_SUPPORTED = savedTemperature;

console.log(`\n🎉 ${passed} Anthropic payload assertions passed.`);
