import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import {
  handleWhatsAppWebhook,
  isMessageProcessed,
  markMessageProcessed,
  checkAndRecordWamid,
  processedWebhooksCache,
  chatSessions,
  onboardingStore
} from './src/routes/whatsapp.js';
import { createClient } from '@supabase/supabase-js';

async function runReliabilityTests() {
  console.log('=== STARTING SAKA FLEET RELIABILITY & CIRCUIT BREAKER TESTS ===\n');

  let supabase = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }

  const mockFastify = {
    log: {
      info: () => {},
      warn: (msg) => console.log('   [FASTIFY WARN]:', msg),
      error: console.error
    }
  };

  const testPhone = '+254799000111';

  function createMockMetaWebhook({ messageBody, wamid, fromPhone = testPhone }) {
    const rawBodyObj = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            messages: [{
              id: wamid,
              from: fromPhone,
              text: { body: messageBody }
            }]
          }
        }]
      }]
    };
    const rawBodyStr = JSON.stringify(rawBodyObj);
    const signature = process.env.META_APP_SECRET
      ? 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBodyStr).digest('hex')
      : undefined;

    const req = {
      headers: signature ? { 'x-hub-signature-256': signature } : {},
      body: rawBodyObj,
      rawBody: rawBodyStr
    };

    let responseCode = null;
    let responseData = null;

    const reply = {
      sent: false,
      status: (code) => {
        responseCode = code;
        return {
          send: (data) => {
            reply.sent = true;
            responseData = data;
            reply.data = data;
            reply.statusCode = responseCode;
            return reply;
          }
        };
      }
    };

    return { req, reply, getResponse: () => ({ code: responseCode, data: responseData }) };
  }

  // Test 1: Message ID Deduplication (Idempotency Cache)
  console.log('--- Test 1: Message ID Deduplication (Idempotency Cache) ---');
  const testWamid = `wamid.HBgL${Date.now()}_test1`;
  if (isMessageProcessed(testWamid)) throw new Error('Expected new wamid to not be in cache');

  const turn1 = createMockMetaWebhook({ messageBody: 'Habari', wamid: testWamid });
  await handleWhatsAppWebhook(turn1.req, turn1.reply, mockFastify);
  console.log('Turn 1 Status:', turn1.reply.data?.status);
  if (turn1.reply.data?.status !== 'success') throw new Error('Expected 200 success on first attempt');
  if (turn1.reply.data?.deduplicated) throw new Error('First attempt should not be flagged as duplicate');

  const turn1Retry = createMockMetaWebhook({ messageBody: 'Habari', wamid: testWamid });
  await handleWhatsAppWebhook(turn1Retry.req, turn1Retry.reply, mockFastify);
  console.log('Turn 1 Retry Status:', turn1Retry.reply.data?.status, 'Deduplicated:', turn1Retry.reply.data?.deduplicated);
  if (turn1Retry.reply.data?.status !== 'success' || !turn1Retry.reply.data?.deduplicated) {
    throw new Error('Expected duplicate wamid to immediately return 200 OK with deduplicated: true');
  }
  console.log('✅ Safeguard 1 Verified: Duplicate wamid was blocked and aborted instantly.\n');

  // Test 2: Immediate Fastify 200 OK Response
  console.log('--- Test 2: Immediate Fastify 200 OK Response ---');
  const testWamid2 = `wamid.HBgL${Date.now()}_test2`;
  const turn2 = createMockMetaWebhook({ messageBody: 'What can I do?', wamid: testWamid2 });
  const webhookPromise = handleWhatsAppWebhook(turn2.req, turn2.reply, mockFastify);
  if (!turn2.reply.sent || turn2.reply.data?.status !== 'success') {
    throw new Error('Expected Fastify reply sent with 200 OK synchronously');
  }
  await webhookPromise;
  console.log('✅ Safeguard 2 Verified: Fastify 200 OK sent immediately to Meta.\n');
  // Test 3: Idle / Unregistered User Conversational Handling
  console.log('--- Test 3: Idle / Unregistered User Conversational Handling ---');
  const idlePhone = '+254711223344';
  chatSessions.delete(idlePhone);
  onboardingStore.delete(idlePhone);

  const stopTurn = createMockMetaWebhook({ messageBody: 'Stop', wamid: `wamid_${Date.now()}_stop`, fromPhone: idlePhone });
  await handleWhatsAppWebhook(stopTurn.req, stopTurn.reply, mockFastify);
  const sessionAfterStop = chatSessions.get(idlePhone);
  const stopReplyText = sessionAfterStop?.history?.slice(-1)[0]?.parts[0]?.text || '';
  console.log('Reply to idle "Stop":', stopReplyText);
  if (!/pause|paused|whenever|anytime|ready/i.test(stopReplyText)) {
    throw new Error(`Expected graceful pause acknowledgement, got: "${stopReplyText}"`);
  }
  if (stopReplyText.includes("Welcome to Saka Fleet!")) {
    throw new Error('Should NOT send welcome onboarding message when user says "Stop"');
  }
  console.log('✅ 3a Verified: Idle user saying "Stop" received graceful pause without canned welcome loop.');

  const frustrationTurn = createMockMetaWebhook({ messageBody: 'Stop with the many replies', wamid: `wamid_${Date.now()}_frust`, fromPhone: idlePhone });
  await handleWhatsAppWebhook(frustrationTurn.req, frustrationTurn.reply, mockFastify);
  const sessionAfterFrust = chatSessions.get(idlePhone);
  const frustReplyText = sessionAfterFrust?.history?.slice(-1)[0]?.parts[0]?.text || '';
  console.log('Reply to frustration input:', frustReplyText);
  if (!/apolog|sorry|support|overload|paused/i.test(frustReplyText)) {
    throw new Error(`Expected empathetic friction response, got: "${frustReplyText}"`);
  }
  console.log('✅ 3b Verified: Conversational friction detected, logged, and handled empathetically.\n');

  // Test 4: State Machine Circuit Breaker
  console.log('--- Test 4: State Machine Circuit Breaker (3-Strike Rule) ---');
  // v1.25.2 — the strike detector needs DETERMINISTIC replies. With live provider
  // keys the assistant varies its wording and the loop never repeats; clear the
  // keys so the deterministic fallback exercises the 3-strike ladder.
  const savedAiKeys = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const circuitPhone = '+254788334455';
  chatSessions.delete(circuitPhone);
  onboardingStore.delete(circuitPhone);

  if (supabase) {
    await supabase.from('vehicles').delete().eq('owner_phone', circuitPhone);
    await supabase.from('profiles').delete().eq('phone_number', circuitPhone);
  }

  const strike1 = createMockMetaWebhook({ messageBody: 'Huh?', wamid: `wamid_${Date.now()}_s1`, fromPhone: circuitPhone });
  await handleWhatsAppWebhook(strike1.req, strike1.reply, mockFastify);
  let circuitSession = chatSessions.get(circuitPhone);
  console.log('Strike 1 prompt count:', circuitSession.consecutivePromptCount);

  const strike2 = createMockMetaWebhook({ messageBody: 'What?', wamid: `wamid_${Date.now()}_s2`, fromPhone: circuitPhone });
  await handleWhatsAppWebhook(strike2.req, strike2.reply, mockFastify);
  circuitSession = chatSessions.get(circuitPhone);
  console.log('Strike 2 prompt count:', circuitSession.consecutivePromptCount);

  const strike3 = createMockMetaWebhook({ messageBody: 'Still confused', wamid: `wamid_${Date.now()}_s3`, fromPhone: circuitPhone });
  await handleWhatsAppWebhook(strike3.req, strike3.reply, mockFastify);
  circuitSession = chatSessions.get(circuitPhone);
  console.log('Strike 3 prompt count:', circuitSession.consecutivePromptCount, 'Stage:', circuitSession.circuitBreakerStage);
  if (circuitSession.circuitBreakerStage !== 'SOFT_TRIP') {
    throw new Error('Expected circuitBreakerStage = SOFT_TRIP after 3 identical prompts!');
  }

  const softReply = circuitSession.history.slice(-1)[0].parts[0].text;
  console.log('Soft Trip Reply:', softReply);
  if (!softReply || softReply.length < 5) {
    throw new Error(`Expected a soft-trip retry message, got: "${softReply}"`);
  }

  // Strike 4: Hard Trip -> support escalation with pending-fix message
  const strike4 = createMockMetaWebhook({ messageBody: 'Still confused', wamid: `wamid_${Date.now()}_s4`, fromPhone: circuitPhone });
  await handleWhatsAppWebhook(strike4.req, strike4.reply, mockFastify);
  circuitSession = chatSessions.get(circuitPhone);
  console.log('Strike 4 Stage:', circuitSession.circuitBreakerStage);
  if (circuitSession.circuitBreakerStage !== 'HARD_TRIP') {
    throw new Error('Expected circuitBreakerStage = HARD_TRIP after 4 identical prompts!');
  }

  const circuitReply = circuitSession.history.slice(-1)[0].parts[0].text;
  console.log('Hard Trip Reply:', circuitReply);
  if (!/support|escalat|restart|paused/i.test(circuitReply)) {
    throw new Error(`Expected hard trip escalation message, got: "${circuitReply}"`);
  }

  // Strike 5: Subsequent input while hard-tripped bypasses processing
  const strike5 = createMockMetaWebhook({ messageBody: 'Still confused', wamid: `wamid_${Date.now()}_s5`, fromPhone: circuitPhone });
  await handleWhatsAppWebhook(strike5.req, strike5.reply, mockFastify);
  circuitSession = chatSessions.get(circuitPhone);
  if (circuitSession.circuitBreakerStage !== 'HARD_TRIP') {
    throw new Error('Expected HARD_TRIP to persist for non-navigation input');
  }

  // Navigation Freedom: A valid numbered menu input must reset the breaker
  const resetTurn = createMockMetaWebhook({ messageBody: '1', wamid: `wamid_${Date.now()}_reset`, fromPhone: circuitPhone });
  await handleWhatsAppWebhook(resetTurn.req, resetTurn.reply, mockFastify);
  circuitSession = chatSessions.get(circuitPhone);
  if (circuitSession.circuitBreakerStage) {
    throw new Error('Expected circuit breaker stage to clear when user navigates via valid menu input');
  }
  console.log('✅ Safeguard 3 Verified: 2-stage self-healing breaker (SOFT_TRIP grace retry -> HARD_TRIP support escalation -> auto-free on navigation).\n');

  console.log('🎉 ALL RELIABILITY & CIRCUIT BREAKER TESTS PASSED SUCCESSFULLY!');
}

runReliabilityTests()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Reliability Test Failed:', err);
    process.exit(1);
  });

