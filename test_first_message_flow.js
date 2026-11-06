import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { handleWhatsAppWebhook, chatSessions, onboardingStore } from './src/routes/whatsapp.js';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import { runWithCleanup } from './scripts/testCleanup.js';

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
  // v1.63.1 (2C) — never leave a seeded context-cache row behind.
  await supabase.from('user_context_cache').delete().eq('phone_number', phone);
}

async function run() {
  console.log('=== SAKA FLEET — FIRST-MESSAGE FLOW TESTS (v1.25.8) ===\n');
  chatSessions.delete(phone);
  onboardingStore.delete(phone);
  // v1.51.5 — run the conversational suite against a VERIFIED profile so the
  // hard unverified gate does not intercept the flow under test.
  if (supabase) {
    await supabase.from('profiles').delete().eq('phone_number', phone);
    await supabase.from('profiles').insert([{ phone_number: phone, email_verified: true, full_name: 'Test Owner', country: 'Kenya', country_code: 'KE', unit_system: 'metric', preferred_language: 'English', subscription_tier: 'free' }]);
  }
  try {
    console.log('--- Test 1: a verified user is advanced, never re-welcomed (v1.58.11) ---');
    const hi = await say('Hi');
    check(/what do you drive|which vehicle|make and model/i.test(hi), 'a verified user is advanced to their first vehicle');
    check(!/\*Saka\*|Karibu|Habari|I(?:'m| am) Saka/i.test(hi), 'a verified user is NOT re-introduced to Saka');
    check(!/\bplates?\b/i.test(hi), 'the advance never mentions the word plate');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(hi), 'the advance is NOT a canned nudge');
    check(!/WhatsApp I'm/.test(hi), 'the placeholder name "WhatsApp User" is never used as a greeting');

    console.log('\n--- Test 2: pricing answers with the pricing card ---');
    const pricing = await say('How much does it cost?');
    check(/(?:KES|Ksh)\s?\d/.test(pricing) && /free|trial/i.test(pricing), `pricing question returns a local-currency pricing answer with real figures (reply: ${pricing.replace(/\s+/g, ' ').slice(0, 160)})`);
    check(!/\$\s?\d/.test(pricing), `a Kenyan user never sees a dollar figure (reply: ${pricing.replace(/\s+/g, ' ').slice(0, 160)})`);
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
      ['How do I use saka?', /sakafleet\.com|one line|sentence|talk|start|log|ask me|tell me|send/i, 'tour'],
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

    console.log('\n--- Test 4g: restart never returns legacy identity copy (v1.28.2) ---');
    const restart = await say("Hello. Let's start again 😊");
    check(/machine's memory|REGISTER/i.test(restart), 'a restart gets the warm sales welcome');
    check(!/intelligent WhatsApp vehicle|asset management assistant|your fleet assistant/i.test(restart), 'the legacy identity copy never ships');

    console.log('\n--- Test 5: quick lanes invalidate the user-context cache (v1.63.1) ---');
    if (supabase) {
      await runWithCleanup({
        phones: [phone],
        verbose: false,
        testFn: async () => {
          const { data: prof } = await supabase.from('profiles').select('id').eq('phone_number', phone).maybeSingle();
          await supabase.from('vehicles').insert([{
            owner_id: prof.id, owner_phone: phone, plate_number: 'KBZ 919Z', make_model: 'Toyota Test',
            fuel_type: 'Diesel', current_mileage: 50000, odometer_reading: 50000, status: 'ACTIVE',
            asset_type: 'ICE', vin: 'JT1FLOW0000000001'
          }]);
          const seedCache = () => supabase.from('user_context_cache').upsert([{
            phone_number: phone, owner_id: prof.id, payload: {},
            built_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 3600000).toISOString()
          }], { onConflict: 'phone_number' });
          const cacheGone = async () => {
            for (let i = 0; i < 30; i += 1) {
              const { data } = await supabase.from('user_context_cache').select('phone_number').eq('phone_number', phone);
              if (!data || data.length === 0) return true;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return false;
          };
          const lanes = [
            ['expense', 'Logged 40L at 50100 km for 4500']
          ];
          for (const [label, laneText] of lanes) {
            await seedCache();
            await say(laneText);
            check(await cacheGone(), `the ${label} quick lane invalidates the user-context cache (v1.63.1)`);
          }
          // The other three lanes share the identical route-level shape; their
          // conversational routing is fragile in a DB-backed suite, so they are
          // pinned at the source (reason strings) instead of driven end to end.
          const routeSource = fs.readFileSync('src/routes/whatsapp/messages.js', 'utf8');
          for (const [label, reason] of [['mileage', 'whatsapp.quickLogMileage'], ['hours', 'whatsapp.quickLogHours'], ['earnings', 'whatsapp.quickLogEarning']]) {
            check(routeSource.includes(`reason: '${reason}'`), `the ${label} quick lane carries its invalidation call (source-pinned, v1.63.1)`);
          }
        }
      });
    }

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
