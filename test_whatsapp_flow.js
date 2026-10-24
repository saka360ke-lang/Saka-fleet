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

  // Turn 4: User sends core vehicle specs -> Stage 1 Core Capture completion
  console.log('Turn 4: User sends core specs: "Toyota Fielder 2018 petrol, mileage 45000, email fielder@test.com - Owner"');
  const turn4 = createMockReqReply('Toyota Fielder 2018 petrol, mileage 45000, email fielder@test.com - Owner');
  await handleWhatsAppWebhook(turn4.req, turn4.reply, mockFastify);
  const stateTurn4 = onboardingStore.get(testPhone);
  console.log('State after Turn 4:', stateTurn4);
  if (!stateTurn4 || stateTurn4.stage !== 2) throw new Error('Expected Stage 1 completion and transition to Stage 2');

  // Turn 5: User sends "Skip" -> Stage 2 optional weaving skipped, user transitions to ACTIVE
  console.log('Turn 5: User sends "Skip" to Stage 2');
  const turn5 = createMockReqReply('Skip');
  await handleWhatsAppWebhook(turn5.req, turn5.reply, mockFastify);
  const stateTurn5 = onboardingStore.get(testPhone);
  console.log('State after Turn 5:', stateTurn5);
  if (stateTurn5 !== undefined) throw new Error('Expected onboarding state to be cleared after Stage 2 Skip');

  // Direct Onboarding Flow Test: Starting directly with plate "KBC 456X" and unstructured input
  console.log('\n--- Direct Onboarding Flow with Natural Unstructured Input ---');
  onboardingStore.delete(testPhone);
  const directTurn1 = createMockReqReply('Register KBC 456X');
  await handleWhatsAppWebhook(directTurn1.req, directTurn1.reply, mockFastify);
  const directState1 = onboardingStore.get(testPhone);
  console.log('State after direct plate input:', directState1);
  if (!directState1 || directState1.step !== 2 || directState1.plate_number !== 'KBC 456X') {
    throw new Error('Expected direct plate input to jump directly to Step 2 with plate KBC 456X');
  }

  // Direct Turn 2: Unstructured natural input with 5 core attributes
  console.log('Direct Turn 2: User sends "It\'s a 1991 diesel 80 series, mileage 366700, email user@mail.com"');
  const directTurn2 = createMockReqReply("It's a 1991 diesel 80 series, mileage 366700, email user@mail.com");
  await handleWhatsAppWebhook(directTurn2.req, directTurn2.reply, mockFastify);
  const directState2 = onboardingStore.get(testPhone);
  console.log('State after unstructured input:', directState2);
  if (!directState2 || directState2.stage !== 2) {
    throw new Error('Expected unstructured multi-field input to complete Stage 1 and transition to Stage 2');
  }

  // Direct Turn 3: User shares optional compliance specs in Stage 2
  console.log('Direct Turn 3: User sends optional specs: "Insurance expires 2027-05-15, automatic, color White, VIN JT111UJ800012345"');
  const directTurn3 = createMockReqReply('Insurance expires 2027-05-15, automatic, color White, VIN JT111UJ800012345');
  await handleWhatsAppWebhook(directTurn3.req, directTurn3.reply, mockFastify);
  const directState3 = onboardingStore.get(testPhone);
  console.log('State after optional specs input:', directState3);
  if (directState3 !== undefined) {
    throw new Error('Expected onboarding state to be cleared after optional specs are saved in Stage 2');
  }

  // Test 3: Post-Onboarding Input Routing & Feedback Safeguards
  console.log('\n--- Test 3: Post-Onboarding Input Routing & Feedback Safeguards ---');

  // Complete onboarding for test user to transition state to 'ACTIVE'
  onboardingStore.set(testPhone, {
    stage: 1,
    step: 2,
    core: { plate_number: 'KDA 777X', make_model: null, yom: null, owner_email: null, fuel_type: null, current_mileage: null },
    optional: {},
    registered_plate: null,
    token: null,
    role: 'Owner',
    plate_number: 'KDA 777X',
    make_model: null
  });
  const completeTurn = createMockReqReply('Toyota Axio 2019 petrol, mileage 30000, email axio@test.com - Owner');
  await handleWhatsAppWebhook(completeTurn.req, completeTurn.reply, mockFastify);
  const skipTurn = createMockReqReply('Done');
  await handleWhatsAppWebhook(skipTurn.req, skipTurn.reply, mockFastify);
  console.log('Post-Onboarding State:', onboardingStore.get(testPhone));
  if (onboardingStore.get(testPhone) !== undefined) {
    throw new Error('State Transition Failed: Onboarding state was not cleared after vehicle registration');
  }

  // A. Numeric Choice "1" (Log Expense) Post-Onboarding
  console.log('Post-Onboarding Input: Numeric Choice "1"');
  const postTurn1 = createMockReqReply('1');
  await handleWhatsAppWebhook(postTurn1.req, postTurn1.reply, mockFastify);
  if (onboardingStore.get(testPhone) !== undefined) {
    throw new Error('Routing Failure: Numeric choice "1" triggered onboarding loop!');
  }

  // B. Natural Text "Odometer 366700km" Post-Onboarding
  console.log('Post-Onboarding Input: Natural Text "Odometer 366700km"');
  const postTurn2 = createMockReqReply('Odometer 366700km');
  await handleWhatsAppWebhook(postTurn2.req, postTurn2.reply, mockFastify);
  if (onboardingStore.get(testPhone) !== undefined) {
    throw new Error('Routing Failure: Natural text "Odometer 366700km" triggered onboarding loop!');
  }

  // C. Natural Text "Logged fuel KES 3000" Post-Onboarding
  console.log('Post-Onboarding Input: Natural Text "Logged fuel KES 3000"');
  const postTurn3 = createMockReqReply('Logged fuel KES 3000');
  await handleWhatsAppWebhook(postTurn3.req, postTurn3.reply, mockFastify);
  if (onboardingStore.get(testPhone) !== undefined) {
    throw new Error('Routing Failure: Natural text "Logged fuel KES 3000" triggered onboarding loop!');
  }

  // D. Safeguard Against Literal Feedback During Onboarding
  console.log('Onboarding Feedback Safeguard: User sends "You are looping" during Step 2');
  const feedbackPhone = '254711223344';
  onboardingStore.set(feedbackPhone, { step: 2, plate_number: 'KDA 888Y', make_model: null, role: 'Owner' });
  
  const rawBodyFeedback = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: feedbackPhone,
            text: { body: 'You are looping' }
          }]
        }
      }]
    }]
  };
  const feedbackReq = {
    headers: {},
    body: rawBodyFeedback,
    rawBody: JSON.stringify(rawBodyFeedback)
  };
  const feedbackReply = {
    status: (code) => feedbackReply,
    send: (data) => {
      feedbackReply.data = data;
      return feedbackReply;
    }
  };

  await handleWhatsAppWebhook(feedbackReq, feedbackReply, mockFastify);
  const feedbackState = onboardingStore.get(feedbackPhone);
  console.log('State after feedback input:', feedbackState);
  
  if (!feedbackState || feedbackState.step !== 2 || feedbackState.make_model === 'You are looping') {
    throw new Error('Safeguard Failure: Conversational feedback "You are looping" was saved as vehicle make/model!');
  }

  console.log('✅ Feedback safeguard verified: "You are looping" was not saved as vehicle make/model.');

  console.log('\n=== ALL CONVERSATIONAL FLOW TESTS PASSED SUCCESSFULLY ===');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});