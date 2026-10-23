import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { processSakaMessage, classifyIntentWithRegex } from './sakaAi.js';
import { handleWhatsAppWebhook, onboardingStore } from './src/routes/whatsapp.js';

async function runTests() {
  console.log('=== STARTING WHATSAPP CONVERSATIONAL FLOW TESTS ===\n');

  // Test 1: Dynamic Intent Classifier
  console.log('--- Test 1: Dynamic Intent Classifier ---');
  const greetingTest = classifyIntentWithRegex('Hi');
  console.log('Input "Hi" -> Intent:', greetingTest.intent);
  if (greetingTest.intent !== 'GREETING') throw new Error('Expected GREETING intent');

  const registerTest = classifyIntentWithRegex('Can I register my vehicle?');
  console.log('Input "Can I register my vehicle?" -> Intent:', registerTest.intent);
  if (registerTest.intent !== 'REGISTER_VEHICLE') throw new Error('Expected REGISTER_VEHICLE intent');

  const helpTest = classifyIntentWithRegex('What do you do?');
  console.log('Input "What do you do?" -> Intent:', helpTest.intent);
  if (helpTest.intent !== 'APP_HELP') throw new Error('Expected APP_HELP intent');

  const generalTest = classifyIntentWithRegex('What is the weather today in Nairobi?');
  console.log('Input "What is the weather..." -> Intent:', generalTest.intent);
  if (generalTest.intent !== 'GENERAL_CHAT') throw new Error('Expected GENERAL_CHAT intent (no canned greeting loop)');

  const plateDirectTest = classifyIntentWithRegex('KDA 123A');
  console.log('Input "KDA 123A" -> Intent:', plateDirectTest.intent, 'Plate:', plateDirectTest.extracted_data.plate_number);
  if (plateDirectTest.intent !== 'REGISTER_VEHICLE' || plateDirectTest.extracted_data.plate_number !== 'KDA 123A') {
    throw new Error('Expected REGISTER_VEHICLE with plate KDA 123A');
  }

  // Test 2: WhatsApp Webhook Handler & Onboarding State Machine
  console.log('\n--- Test 2: WhatsApp Webhook Handler & Onboarding State Machine ---');
  
  const testPhone = '254700112233';
  let lastReply = '';

  const mockFastify = {
    log: {
      info: () => {},
      error: console.error,
      warn: console.warn
    }
  };

  function createMockReqReply(messageBody) {
    const rawBodyObj = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: testPhone,
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

    const reply = {
      status: (code) => reply,
      send: (data) => {
        reply.data = data;
        return reply;
      }
    };

    return { req, reply };
  }

  // Turn 1: User says "Hi" -> GREETING / Intro Flow
  console.log('Turn 1: User sends "Hi"');
  onboardingStore.delete(testPhone);
  const turn1 = createMockReqReply('Hi');
  await handleWhatsAppWebhook(turn1.req, turn1.reply, mockFastify);
  console.log('Turn 1 Status:', turn1.reply.data?.status);

  // Turn 2: User says "Register" -> Step 1 prompt for vehicle registration plate
  console.log('Turn 2: User sends "Register"');
  const turn2 = createMockReqReply('Register');
  await handleWhatsAppWebhook(turn2.req, turn2.reply, mockFastify);
  const stateTurn2 = onboardingStore.get(testPhone);
  console.log('State after Turn 2:', stateTurn2);
  if (!stateTurn2 || stateTurn2.step !== 1) throw new Error('Expected state step 1 after "Register"');

  // Turn 3: User sends plate "KDA 999Z" -> Step 2 prompt for make/model & role
  console.log('Turn 3: User sends plate "KDA 999Z"');
  const turn3 = createMockReqReply('KDA 999Z');
  await handleWhatsAppWebhook(turn3.req, turn3.reply, mockFastify);
  const stateTurn3 = onboardingStore.get(testPhone);
  console.log('State after Turn 3:', stateTurn3);
  if (!stateTurn3 || stateTurn3.step !== 2 || stateTurn3.plate_number !== 'KDA 999Z') {
    throw new Error('Expected state step 2 with plate KDA 999Z');
  }

  // Turn 4: User sends "Toyota Fielder - Owner" -> Step 3 completion & summary menu
  console.log('Turn 4: User sends "Toyota Fielder - Owner"');
  const turn4 = createMockReqReply('Toyota Fielder - Owner');
  await handleWhatsAppWebhook(turn4.req, turn4.reply, mockFastify);
  const stateTurn4 = onboardingStore.get(testPhone);
  console.log('State after Turn 4:', stateTurn4);
  if (stateTurn4 !== undefined) throw new Error('Expected onboarding state to be cleared after Step 3');

  // Direct Onboarding Flow Test: Starting directly with plate "KBC 456X"
  console.log('\nDirect Onboarding Flow: User starts directly with "KBC 456X"');
  onboardingStore.delete(testPhone);
  const directTurn1 = createMockReqReply('KBC 456X');
  await handleWhatsAppWebhook(directTurn1.req, directTurn1.reply, mockFastify);
  const directState1 = onboardingStore.get(testPhone);
  console.log('State after direct plate input:', directState1);
  if (!directState1 || directState1.step !== 2 || directState1.plate_number !== 'KBC 456X') {
    throw new Error('Expected direct plate input to jump directly to Step 2 with plate KBC 456X');
  }

  console.log('\n=== ALL CONVERSATIONAL FLOW TESTS PASSED SUCCESSFULLY ===');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});