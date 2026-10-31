import { SLOW_ACK_LINES, SLOW_ACK_DEFAULT_MS, SLOW_ACK_MIN_GAP_MS, resolveSlowAckMs, pickSlowAckLine, shouldSendSlowAck } from './src/services/turnAck.js';

/**
 * Saka Fleet — slow-turn ack tests (v1.25.1). Stateless: copy + gating only.
 * The ack must feel like a human touch, never a metronome on every reply.
 */

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — SLOW-TURN ACK TESTS (v1.25.1) ===\n');

console.log('--- Test 1: threshold ---');
check(SLOW_ACK_DEFAULT_MS === 8000, 'the default threshold is 8 seconds');
check(resolveSlowAckMs({}) === 8000, 'missing env falls back to the default');
check(resolveSlowAckMs({ SLOW_ACK_MS: '5000' }) === 5000, 'the env override applies');
check(resolveSlowAckMs({ SLOW_ACK_MS: '0' }) === 0, 'zero disables the ack');
check(resolveSlowAckMs({ SLOW_ACK_MS: 'nonsense' }) === 8000, 'invalid values fall back safely');

console.log('\n--- Test 2: rotating copy ---');
check(SLOW_ACK_LINES.length >= 4, 'at least four variants exist');
check(new Set(SLOW_ACK_LINES).size === SLOW_ACK_LINES.length, 'variants are unique');
check(pickSlowAckLine(0) === SLOW_ACK_LINES[0], 'the first turn uses the first line');
check(pickSlowAckLine(3) === SLOW_ACK_LINES[3], 'the fourth turn uses the fourth line');
check(pickSlowAckLine(4) === SLOW_ACK_LINES[0], 'the rotation wraps around');
check(pickSlowAckLine(-1) === SLOW_ACK_LINES[(SLOW_ACK_LINES.length - 1) % SLOW_ACK_LINES.length], 'negative seeds stay in range');
for (const line of SLOW_ACK_LINES) {
  check(/[\p{Extended_Pictographic}]/u.test(line), `"${line.slice(0, 24)}…" carries an emoji anchor`);
  check(line.length <= 60, `"${line.slice(0, 24)}…" stays short`);
}

console.log('\n--- Test 3: anti-spam floor ---');
const now = 1_000_000;
check(shouldSendSlowAck({ turnFinalized: false, now, lastAckAt: 0 }) === true, 'the first silent turn acknowledges');
check(shouldSendSlowAck({ turnFinalized: true, now, lastAckAt: 0 }) === false, 'a finished turn never acknowledges');
check(shouldSendSlowAck({ turnFinalized: false, now, lastAckAt: now - 10_000 }) === false, 'two acks within 60s are suppressed');
check(shouldSendSlowAck({ turnFinalized: false, now, lastAckAt: now - SLOW_ACK_MIN_GAP_MS - 1 }) === true, 'the floor expires after 60s');

console.log(`\n🎉 ${passed} slow-ack assertions passed.`);
