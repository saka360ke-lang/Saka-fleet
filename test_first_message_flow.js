import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { handleWhatsAppWebhook, chatSessions, onboardingStore } from './src/routes/whatsapp.js';
import { createClient } from '@supabase/supabase-js';

/**
 * Saka Fleet — first-message conversational flow (v1.25.8). DB-backed, self-cleaning.
 *
 * Regression for the v1.25.4-v1.25.7 self-comparison bug: the repeat guard read
 * `session.lastAssistantPrompt` AFTER it had been overwritten with the current
 * reply, so every genuine answer (welcome, pricing card, trial card, FAQ card)
 * was replaced by a "nudge". These turns must return real answers.
 */

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

// v1.27.0 — the slow-turn ack must never be mistaken for the answer in tests.
process.env.SLOW_ACK_MS = '0';

const phone = '+254799000512';
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const mockFastify = { log: { info: function () {}, warn: function () {}, error: function () {} } };

function requestFor(messageBody) {
  const rawBodyObj = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{
      id: `wamid_flow_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      from: phone,
      text: { body: messageBody }
    }] } }] }]
  };
  const rawBodyStr = JSON.stringify(rawBodyObj);
  const signature = process.env.META_APP_SECRET
    ? `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBodyStr).digest('hex')}`
    : undefined;
  return { headers: signature ? { 'x-hub-signature-256': signature } : {}, body: rawBodyObj, rawBody: rawBodyStr };
}
const replySink = { code: function () { return replySink; }, send: function () { return replySink; } };

function lastAssistantText() {
  const history = chatSessions.get(phone)?.history || [];
  return history.slice(-1)[0]?.parts?.[0]?.text || '';
}

async function say(messageBody) {
  const previous = lastAssistantText();
  await handleWhatsAppWebhook(requestFor(messageBody), replySink, mockFastify);
  // v1.27.0 — the history is capped, so length comparisons are not reliable.
  // Wait for a NEW final turn (different from the pre-turn text) that stays stable.
  let current = '';
  let stable = 0;
  for (let i = 0; i < 400; i += 1) {
    const latest = lastAssistantText();
    if (latest && latest !== previous && latest === current) {
      stable += 1;
      if (stable >= 12) return current;
    } else {
      current = latest !== previous ? latest : '';
      stable = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return current;
}

async function cleanup() {
  if (!supabase) return;
  await supabase.from('chat_history').delete().eq('user_phone', phone);
  await supabase.from('chat_transcripts').delete().eq('phone_number', phone);
  await supabase.from('chat_sessions').delete().eq('phone_number', phone);
  await supabase.from('processed_webhooks').delete().eq('phone_number', phone);
  await supabase.from('profiles').delete().eq('phone_number', phone);
  await supabase.from('vehicles').delete().eq('owner_phone', phone);
}

async function run() {
  console.log('=== SAKA FLEET — FIRST-MESSAGE FLOW TESTS (v1.25.8) ===\n');
  chatSessions.delete(phone);
  onboardingStore.delete(phone);
  try {
    console.log('--- Test 1: "Hi" receives the sales welcome ---');
    const hi = await say('Hi');
    check(/\*Saka\*/.test(hi), 'the welcome introduces Saka');
    check(hi.includes('⛽') && hi.includes('💰') && hi.includes('🔔'), 'the welcome carries the three value anchors');
    check(/REGISTER/i.test(hi), 'the welcome ends with a next step');
    check(!/send your vehicle'?s? (?:number |registration )?plate/i.test(hi), 'the welcome never asks for a plate');
    check(!/\bplates?\b/i.test(hi), 'the welcome never mentions the word plate');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(hi), 'the welcome is NOT replaced by a nudge');
    check(!/WhatsApp I'm/.test(hi), 'the placeholder name "WhatsApp User" is never used as a greeting');

    console.log('\n--- Test 2: pricing answers with the pricing card ---');
    const pricing = await say('How much does it cost?');
    check(/(?:KES|Ksh)\s?\d/.test(pricing) && /free|trial/i.test(pricing), 'pricing question returns a local-currency pricing answer with real figures');
    check(!/\$\s?\d/.test(pricing), 'a Kenyan user never sees a dollar figure');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(pricing), 'pricing is NOT a canned nudge');
    check(!/registration plate/i.test(pricing), 'pricing never asks for a plate');
    check(!/\bplates?\b/i.test(pricing), 'pricing never mentions the word plate');

    console.log('\n--- Test 3: trial answers with the trial card ---');
    const trial = await say("What's the trial period?");
    check(/30[-\s]?day|30 days|free trial/i.test(trial), 'trial question returns the trial answer');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(trial), 'trial is NOT a canned nudge');

    console.log('\n--- Test 4: "Tell me more about saka fleet" returns the intro answer ---');
    const intro = await say('Nice. Tell me more about Saka');
    check(/Saka/i.test(intro) && /(machine|vehicle|passbook|fuel)/i.test(intro), 'the intro answer describes what Saka does');
    check(!/registration plate/i.test(intro), 'the intro never asks for a plate');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(intro), 'the intro is not a canned nudge');
    check(!/\bplates?\b/i.test(intro), 'the intro never mentions the word plate');

    console.log('\n--- Test 4b: the anticipated-question matrix (v1.26.0) ---');
    const matrix = [
      ['What are the costs of using Saka?', /(?:KES|Ksh)\s?\d|free|trial/i, 'pricing'],
      ['How do I use saka?', /REGISTER|one line|sentence|talk|start|log|ask me|tell me|send/i, 'tour'],
      ['What are the details of Solo Pro?', /Solo Pro|plan|vehicle/i, 'plan details'],
      ['How do the add ons work?', /add.?ons?/i, 'add-ons'],
      ['How do I subscribe to growth fleet?', /UPGRADE|subscribe|plan|pay|checkout|link/i, 'subscribe steps'],
      ['Why do you need my VIN?', /VIN|passbook|private|safe|identity|protect|prove/i, 'trust'],
      ['Is there an app?', /app|whatsapp|chat|download|install|browser/i, 'whatsapp-only'],
      ['Can I delete my data?', /delete|export|data|remove|erase/i, 'data control']
    ];
    for (const [question, expected, label] of matrix) {
      const answer = await say(question);
      check(expected.test(answer), `"${question}" answers the ${label} question`);
      check(!/\bplates?\b/i.test(answer), `"${question}" never mentions the word plate`);
    }

    console.log('\n--- Test 4c: free-service questions (v1.26.2) ---');
    for (const question of ['Nice. Is this a free service?', 'Is it free to use saka?']) {
      const answer = await say(question);
      check(/(?:KES|Ksh)\s?\d|free|trial/i.test(answer), `"${question}" is answered with pricing facts`);
      check(!/\bplates?\b/i.test(answer), `"${question}" never mentions the word plate`);
    }

    console.log('\n--- Test 4d: features, package details and the vehicle-count math (v1.27.0) ---');
    const featuresAnswer = await say('What are features of saka fleet?');
    check(/fuel|remind|report|passbook|driver|log|fleet/i.test(featuresAnswer), '"features of saka fleet" lists real features');
    check(!/\bplates?\b/i.test(featuresAnswer), '"features" never mentions the word plate');
    const packagesAnswer = await say('Give me details of each package');
    check(/Solo Pro|Team Fleet|Growth|Fleet Command/i.test(packagesAnswer), '"details of each package" lists the plans');
    check(!/\bplates?\b/i.test(packagesAnswer), '"package details" never mentions the word plate');
    const eightCarsAnswer = await say('I have 8 cars. Which subscription is best?');
    check(/Fleet Command/i.test(eightCarsAnswer), '8 cars recommends Fleet Command');
    check(/add.?ons?|extra/i.test(eightCarsAnswer), '8 cars mentions the extra vehicle slots');
    const annualAnswer = await say('What annual subscriptions are available?');
    check(/annual|year|\/year/i.test(annualAnswer), 'annual questions get an annual answer');

    console.log('\n--- Test 4e: a goodbye is a goodbye (v1.27.0) ---');
    const byeAnswer = await say('Ok. Bye');
    check(!/I(?:'m| am) Saka|Karibu|what do you drive/i.test(byeAnswer), 'a goodbye never re-introduces Saka or asks what they drive');
    check(byeAnswer.length <= 220, 'a goodbye is one short line');

    console.log('\n--- Test 4f: local-currency only + complaint recovery (v1.28.1) ---');
    const annualPlans = await say('Any annual plans?');
    check(/(?:KES|Ksh)\s?\d/.test(annualPlans), 'annual plans are quoted in local currency');
    check(!/\$\s?\d/.test(annualPlans), 'annual plans never mix in dollar figures');
    const sevenVehicles = await say('What if I have 7 vehicles?');
    check(/(?:KES|Ksh)\s?\d/.test(sevenVehicles), 'a 7-vehicle question is answered in local currency');
    check(!/\$\s?\d/.test(sevenVehicles), 'the 7-vehicle answer has no dollar figure');
    const complaint = await say('Your last reply was incomplete');
    check(!/Karibu|I(?:'m| am) Saka|what do you drive/i.test(complaint), 'a complaint is never answered with the welcome');
    check(/sorry|apolog|cut short|redo|again|full answer|complete/i.test(complaint), 'a complaint gets an acknowledgement and a recovery step');

    console.log(`\n🎉 ${passed} first-message flow assertions passed.`);
  } finally {
    await cleanup();
    console.log('🧹 flow-test rows removed.');
  }
}

run().catch(async (err) => {
  await cleanup().catch(function () {});
  console.error('\n❌ FIRST-MESSAGE FLOW TESTS FAILED:', err.message);
  process.exit(1);
});
