import assert from 'assert';
import {
  prepareRoutingText,
  normalizeForRouting,
  editDistance,
  nearestRoutingWord,
  stripDiacritics
} from './src/services/textNormalizer.js';
import { matchProductQa } from './src/services/productQa.js';
import { isStopRequest } from './src/services/greetings.js';

/**
 * Saka Fleet — routing text normalizer (v1.28.0). Stateless.
 *
 * Humans mistype; the deterministic routers must not. These tests prove that
 * typos, transpositions, missing spaces, punctuation and emoji are tolerated
 * for ROUTING while plates, VINs and amounts are never rewritten.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — TEXT NORMALIZER TESTS (v1.28.0) ===\n');

console.log('--- Test 1: normalization basics ---');
check(normalizeForRouting('  Héllo,   WÖRLD!!  ') === 'hello world', 'diacritics, punctuation and extra spaces are stripped');
check(stripDiacritics('Olá Namaste') === 'Ola Namaste', 'diacritics are removed without lowercasing');
check(normalizeForRouting('Hi 👋 there 🚗') === 'hi there', 'emoji are stripped');
check(normalizeForRouting('') === '', 'empty input is safe');

console.log('\n--- Test 2: edit distance & nearest word ---');
check(editDistance('pricing', 'pricing') === 0, 'identical words have distance 0');
check(editDistance('pricimg', 'pricing') === 1, 'one substitution is distance 1');
check(nearestRoutingWord('pricimg') === 'pricing', 'substitution typo snaps to the keyword');
check(nearestRoutingWord('abuot') === 'about', 'transposition snaps to the keyword');
check(nearestRoutingWord('sotp') === 'stop', 'transposed opt-out snaps to stop');

console.log('\n--- Test 3: merged words and punctuation ---');
check(prepareRoutingText('Howmuch is the pricimg?') === 'how much is the pricing', 'missing space + typo are repaired');
check(prepareRoutingText('Habbari, tell me abuot saka') === 'habari tell me about saka', 'greeting + transposition are repaired');
check(prepareRoutingText('!!!') === '', 'punctuation-only input becomes empty');

console.log('\n--- Test 4: stored values are never rewritten ---');
check(prepareRoutingText('KDA 123A') === 'kda 123a', 'a plate is only lowercased for routing (digits + letters preserved)');
check(prepareRoutingText('SAKATESTORACLE0001') === 'sakatestoracle0001', 'a VIN is only lowercased for routing');
check(prepareRoutingText('50350 km') === '50350 km', 'numbers and units are untouched');
check(prepareRoutingText('I paid 5000 for fuel') === 'i paid 5000 for fuel', 'a normal statement is untouched');

console.log('\n--- Test 5: typo-tolerant product routing ---');
check(matchProductQa('Howmuch is the pricimg?')?.id === 'pricing', 'a typo pricing question still reaches pricing');
check(matchProductQa('Is ther a free trial?')?.id === 'pricing', 'a missing word still reaches the pricing/trial facts');
check(matchProductQa('Tell me abuot saka fleet')?.id === 'what_is_saka', 'a transposed "about" still reaches the intro');
check(matchProductQa('I pad 5000 for fuel') === null, 'a statement is still never treated as a product question');

console.log('\n--- Test 6: typo-tolerant opt-out ---');
check(isStopRequest('sotp') === true, 'a transposed STOP still pauses');
check(isStopRequest('pls pase') === true, 'a typo "please pause" still pauses');
check(isStopRequest('stop at the petrol station') === false, 'a business sentence is still not an opt-out');
check(isStopRequest('cancel my subscription') === false, 'subscription cancellation stays with its flow');

console.log(`\n🎉 ${passed} text-normalizer assertions passed.`);
