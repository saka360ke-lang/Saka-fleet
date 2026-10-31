import {
  PRODUCT_QA,
  matchProductQa,
  buildProductQaReply,
  buildProductQaContext
} from './src/services/productQa.js';
import { TIER_MATRIX, getTierPriceUSD } from './src/services/subscriptionTiers.js';
import { TRIAL_DAYS } from './src/services/trialEngine.js';

/**
 * Saka Fleet — Product Q&A tests (v1.25.0). Stateless: registry + copy only.
 * Guarantees that the pricing answer is built from the tier matrix (never a
 * hardcoded figure) and that no backend detail can leak into user copy.
 */

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — PRODUCT Q&A TESTS (v1.25.0) ===\n');

console.log('--- Test 1: pricing is engine-owned ---');
const pricing = PRODUCT_QA.find((entry) => entry.id === 'pricing');
const pricingReply = buildProductQaReply(pricing);
check(pricingReply.includes('free to start'), 'pricing opens with the free tier');
check(pricingReply.includes(`$${getTierPriceUSD('solo_pro', 'monthly').toFixed(2)}`), 'solo_pro price comes from the tier matrix');
check(pricingReply.includes(TIER_MATRIX.growth.label || 'Growth'), 'paid tier labels come from the matrix');
check(pricingReply.includes(`${TRIAL_DAYS}-day free trial`) || pricingReply.includes(`${TRIAL_DAYS}-day`), 'the trial length comes from trialEngine');

console.log('\n--- Test 2: no backend detail can leak ---');
const forbidden = /ANTHROPIC|OPENAI|DEEPSEEK|Supabase|environment variable|API key|admin|remediation|Sentinel|database|server|provider/i;
for (const entry of PRODUCT_QA) {
  check(!forbidden.test(buildProductQaReply(entry)), `${entry.id} answer is user-safe`);
}
check(/BACKEND GATE/.test(buildProductQaContext()), 'the AI context carries the backend gate');
check(/under the hood/.test(buildProductQaContext()), 'the gate supplies a graceful deflection line');

console.log('\n--- Test 3: routing (questions only) ---');
check(matchProductQa('What is cost of this service?')?.id === 'pricing', 'the exact live question routes to pricing');
check(matchProductQa('how much is the subscription')?.id === 'pricing', 'subscription questions route to pricing');
check(matchProductQa('Is my data safe?')?.id === 'privacy', 'privacy questions route to privacy');
check(matchProductQa('How many cars can I add?')?.id === 'limits', 'vehicle limits route to limits');
check(matchProductQa('Can I sell my car with the passbook?')?.id === 'resale', 'resale questions route to the passbook answer');
check(matchProductQa('Who are you?')?.id === 'what_is_saka', 'identity questions route to the intro');
check(matchProductQa('Tell me about sakafleet')?.id === 'what_is_saka', 'the live "Tell me about sakafleet" phrasing routes to the intro');
check(matchProductQa('Tell me more about saka fleet')?.id === 'what_is_saka', '"tell me MORE about saka fleet" routes to the intro');
check(matchProductQa('Nice. Tell me more about Saka')?.id === 'what_is_saka', 'small talk before the question does not hide it');
check(matchProductQa('tell me more about you')?.id === 'what_is_saka', '"tell me more about you" routes to the intro');
check(matchProductQa('What is Saka fleet?')?.id === 'what_is_saka', '"Saka fleet" is recognised as a single phrase');
// v1.26.0 — anticipated-question matrix (from the live 14:36-14:40 conversation).
check(matchProductQa('What are the costs of using Saka?')?.id === 'pricing', '"costs of using Saka" returns the pricing card');
check(matchProductQa('How do I use saka?')?.id === 'how_to_use', '"how do I use Saka" returns the tour');
check(matchProductQa('What are the details of Solo Pro?')?.id === 'tier_details', '"details of Solo Pro" returns the plan details');
check(matchProductQa('How do the add ons work?')?.id === 'addons', '"how do the add ons work" returns the add-ons answer');
check(matchProductQa('How do I subscribe to growth fleet?')?.id === 'how_to_subscribe', '"how do I subscribe to growth fleet" returns the subscribe steps');
check(matchProductQa('Why do you need my VIN?')?.id === 'why_details', '"why do you need my VIN" returns the trust answer');
check(matchProductQa('Can I skip this?')?.id === 'progress', '"can I skip" returns the progress answer');
check(matchProductQa('Is there an app?')?.id === 'technical', '"is there an app" returns the WhatsApp-only answer');
check(matchProductQa('Can I delete my data?')?.id === 'data_control', '"can I delete my data" returns the data-control answer');
check(matchProductQa('Nice. Is this a free service?')?.id === 'pricing', '"is this a free service" (with small talk) returns pricing');
check(matchProductQa('Is it free to use saka?')?.id === 'pricing', '"is it free to use saka" returns pricing');
check(/ANSWER-FIRST RULE/.test(buildProductQaContext()), 'the answer-first rule is injected into the AI context');
check(/never reply with the registration/i.test(buildProductQaContext()), 'the plate-script default is explicitly forbidden');
check(matchProductQa('I paid 5000 for fuel') === null, 'a fuel statement never triggers the pricing card');
check(matchProductQa('Logged 40L at 50350 km for KES 5500') === null, 'a log line never triggers product Q&A');
check(matchProductQa('') === null, 'empty text matches nothing');

console.log('\n--- Test 4: every answer is short, warm and closes ---');
for (const entry of PRODUCT_QA) {
  const answer = buildProductQaReply(entry);
  const lines = answer.split('\n').filter((line) => line.trim().length > 0);
  check(lines.length <= 10, `${entry.id} stays under 10 lines (${lines.length})`);
  check(/[\p{Extended_Pictographic}]/u.test(answer), `${entry.id} uses at least one emoji anchor`);
  check(answer.length <= 700, `${entry.id} is concise (${answer.length} chars)`);
}

console.log(`\n🎉 ${passed} product Q&A assertions passed.`);
