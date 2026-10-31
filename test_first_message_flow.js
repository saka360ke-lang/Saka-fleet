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

async function say(messageBody) {
  await handleWhatsAppWebhook(requestFor(messageBody), replySink, mockFastify);
  const session = chatSessions.get(phone) || {};
  return session.history?.slice(-1)[0]?.parts?.[0]?.text || '';
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
    check(/REGISTER|number plate/i.test(hi), 'the welcome ends with a next step');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(hi), 'the welcome is NOT replaced by a nudge');
    check(!/WhatsApp I'm/.test(hi), 'the placeholder name "WhatsApp User" is never used as a greeting');

    console.log('\n--- Test 2: pricing answers with the pricing card ---');
    const pricing = await say('How much does it cost?');
    check(/free to start/i.test(pricing), 'pricing question returns the pricing card');
    check(/Solo Pro/i.test(pricing) && /\$\d/.test(pricing), 'the card lists live tier prices');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(pricing), 'pricing is NOT replaced by a nudge');

    console.log('\n--- Test 3: trial answers with the trial card ---');
    const trial = await say("What's the trial period?");
    check(/30 days? (?:are )?on us|30-day/i.test(trial), 'trial question returns the trial card');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(trial), 'trial is NOT replaced by a nudge');

    console.log('\n--- Test 4: "Tell me more about saka fleet" returns the intro card ---');
    const intro = await say('Tell me more about saka fleet');
    check(/machine's memory/i.test(intro), 'the FAQ intro card is returned');
    check(!/keep moving|Happy to help you begin|Let's get you started/i.test(intro), 'the intro is NOT replaced by a nudge');

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
