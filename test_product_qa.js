import {
  PRODUCT_QA,
  matchProductQa,
  buildProductQaReply,
  buildProductQaContext,
  buildProductFactsContext,
  buildLocalPricingFacts,
  stripUsdFigures,
  hasLocalFigure,
  recommendTierForFleet,
  sanitizeSakaReply
} from './src/services/productQa.js';
import { TIER_MATRIX, getTierPriceUSD, getAddonPriceUSD } from './src/services/subscriptionTiers.js';
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

console.log('\n--- Test 5: v1.27.0 — every live question routes and the facts are complete ---');
check(matchProductQa('What are features of saka fleet?')?.id === 'features', '"features of saka fleet" returns the features facts');
check(matchProductQa('Give me details of each package')?.id === 'packages', '"details of each package" returns the package facts');
check(matchProductQa('What annual subscriptions are available!!???')?.id === 'pricing', '"annual subscriptions available" returns pricing (never the country facts)');
check(matchProductQa('Annual subscriptions available please?')?.id === 'pricing', '"annual subscriptions available please" returns pricing');
check(matchProductQa('Tell me more about the Team fleet tier')?.id === 'tier_details', '"tell me more about the Team fleet tier" returns plan details');
check(pricingReply.includes(`$${getTierPriceUSD('solo_pro', 'annual').toFixed(2)}`), 'pricing includes the annual price from the registry');
check(!/·\s*vehicles?\b/i.test(pricingReply), 'pricing never renders an empty "· vehicles" placeholder');
check(!/I don'?t have/i.test(pricingReply), 'pricing never hedges');

console.log('\n--- Test 6: capacity math is computed in code ---');
const eight = recommendTierForFleet(8);
check(eight.tierKey === 'fleet_command' && eight.addons === 3, '8 vehicles -> Fleet Command + 3 extra slots');
check(eight.lines.join(' ').includes(`$${(getTierPriceUSD('fleet_command', 'monthly') + 3 * getAddonPriceUSD('fleet_command', 'monthly')).toFixed(2)}/month`), 'the 8-vehicle monthly total is computed exactly');
check(recommendTierForFleet(2).tierKey === 'team_fleet', '2 vehicles -> Team Fleet');
check(recommendTierForFleet(4).tierKey === 'growth', '4 vehicles -> Growth');
check(recommendTierForFleet(1).tierKey === 'free', '1 vehicle -> Free');

console.log('\n--- Test 7: the reply linter blocks hedging and broken placeholders ---');
check(sanitizeSakaReply('I don\'t have any annual details to confirm.', 'FACTS') === 'FACTS', 'a hedge is replaced by the fact fallback');
check(sanitizeSakaReply('Solo Pro — $9.99/month · vehicles.', 'FACTS') === 'FACTS', 'an empty capacity placeholder is replaced');
check(sanitizeSakaReply('Solo Pro is $9.99/month for one vehicle.', 'FACTS') === 'Solo Pro is $9.99/month for one vehicle.', 'a clean answer passes untouched');
check(sanitizeSakaReply('Price: undefined', 'FACTS') === 'FACTS', 'an unfilled token is replaced');

console.log('\n--- Test 8: the universal fact context carries annual prices and features ---');
const factsContext = buildProductFactsContext();
check(factsContext.includes(`$${getTierPriceUSD('growth', 'annual').toFixed(2)}/year`), 'the fact context includes annual pricing');
check(/features:/.test(factsContext), 'the fact context includes the feature list');

console.log('\n--- Test 9: payment answers use the user currency (v1.28.0) ---');
const kesFacts = await buildLocalPricingFacts({ supabase: null, currency: 'KES', locale: 'en-KE' });
check(Array.isArray(kesFacts) && kesFacts.length >= 3, 'KES produces the local fact lines');
check(/Free/.test(kesFacts.join(' ')), 'the free tier is stated without any dollar figure');
check(kesFacts.join(' ').includes('KES'), 'the local facts name the checkout currency');
check(/Solo Pro/.test(kesFacts.join(' ')) && /1,299/.test(kesFacts.join(' ')), 'Solo Pro converts with the KES fallback rate');
check(/approximate/i.test(kesFacts.join(' ')), 'conversions are labelled approximate');
check(/extra vehicle/i.test(kesFacts.join(' ')), 'the add-on price is converted too');
const usdFacts = await buildLocalPricingFacts({ supabase: null, currency: 'USD' });
check(usdFacts === null, 'USD needs no extra conversion facts');

console.log('\n--- Test 10: local currency is exclusive — no dollar figures (v1.28.1) ---');
const localNoFleet = await buildLocalPricingFacts({ supabase: null, currency: 'KES', locale: 'en-KE' });
check(localNoFleet.join(' ').includes('KES'), 'local facts quote KES');
check(!/\$|\bUSD\b/.test(localNoFleet.join(' ')), 'local facts contain no dollar sign and no USD');
const localFleet = await buildLocalPricingFacts({ supabase: null, currency: 'KES', locale: 'en-KE', fleetCount: 7 });
check(/For 7 vehicles/.test(localFleet.join(' ')), 'a 7-vehicle question gets a computed local total');
check(/4,676/.test(localFleet.join(' ')), 'the 7-vehicle total is 4,676 KES at the fallback rate');
check(!/\$|\bUSD\b/.test(localFleet.join(' ')), 'the 7-vehicle local total carries no dollar figure');
const scrubbed = stripUsdFigures('Solo Pro: KES 10,901/year ($83.92), 1 vehicle', { currency: 'KES' });
check(!/\$|\bUSD\b/.test(scrubbed) && scrubbed.includes('KES 10,901/year'), 'a bracketed dollar value is removed from a local answer');
const scrubbedPlain = stripUsdFigures('5 vehicles at $27.99/month and 2 slots at $3.99/month', { currency: 'KES' });
check(!/\$\d/.test(scrubbedPlain), 'bare dollar amounts are removed');
check(matchProductQa('Cool. First tell me a little about Saka')?.id === 'what_is_saka', '"tell me a little about Saka" returns the intro');
check(hasLocalFigure('Solo Pro is KES 1,298/month', 'KES') === true, 'a local answer with a figure is accepted');
check(hasLocalFigure('Plans are billed in KES at checkout', 'KES') === false, 'merely naming the currency is not a figure');
check(hasLocalFigure('KES\n1,298 per month', 'KES') === true, 'a figure on the next line still counts');
check(hasLocalFigure('$9.99/month', 'KES') === false, 'a dollar amount is never a local figure');

console.log(`\n🎉 ${passed} product Q&A assertions passed.`);
