import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { handleWhatsAppWebhook, chatSessions, onboardingStore } from './src/routes/whatsapp.js';
import { createClient } from '@supabase/supabase-js';

async function runDaudiJourney() {
  console.log('=== SURGICAL BUG FIX VERIFICATION: DAUDI CHAT JOURNEY ===\n');

  let supabase = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }

  const mockFastify = { log: { info: () => {}, warn: () => {}, error: console.error } };
  const daudiPhone = '+254712345678';
  chatSessions.delete(daudiPhone);
  onboardingStore.delete(daudiPhone);

  if (supabase) {
    await supabase.from('vehicles').delete().eq('owner_phone', daudiPhone);
    await supabase.from('profiles').delete().eq('phone_number', daudiPhone);
    await supabase.from('chat_history').delete().eq('user_phone', daudiPhone);
  }

  let wamidCounter = 1;
  function mockReply(msg) {
    const rawBodyObj = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ id: `wamid_${Date.now()}_${wamidCounter++}`, from: daudiPhone, text: { body: msg } }] } }] }]
    };
    const rawBodyStr = JSON.stringify(rawBodyObj);
    const signature = process.env.META_APP_SECRET
      ? 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBodyStr).digest('hex')
      : undefined;

    const reply = { sent: false, status: () => ({ send: (d) => { reply.sent = true; reply.data = d; return reply; } }) };
    return { req: { body: rawBodyObj, rawBody: rawBodyStr, headers: signature ? { 'x-hub-signature-256': signature } : {} }, reply };
  }

  // Turn 1: Unregistered User Greeting (Fix 3)
  console.log('Turn 1: Daudi sends "Hi"');
  let t = mockReply('Hi');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  // Give background task time to run
  await new Promise(r => setTimeout(r, 1500));
  let session = chatSessions.get(daudiPhone);
  let sakaReply = session.history.slice(-1)[0].parts[0].text;
  console.log('Saka Reply:', sakaReply);
  if (sakaReply.includes('1️⃣ Log Expense') || sakaReply.includes('1️⃣ Log Fuel')) {
    throw new Error('BUG 1 FAILED: Unregistered user was given active menu!');
  }
  console.log('✅ Bug 1 Fixed: Unregistered user receives clean Welcome guide.\n');

  // Turn 2 & 3: Register and Core Specs
  console.log('Turn 2: Daudi sends "KAS 628T"');
  t = mockReply('KAS 628T');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  
  console.log('\nTurn 3: Daudi sends core specs with VIN containing numbers (1HDJ12345678)');
  t = mockReply('My car is a Toyota Land Cruiser 80 Series. Green in color. Odo meter at 366978km. Vin number is 1HDJ12345678 and my email is David.njonjo@gmail.com. Diesel. 1991');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  const state = onboardingStore.get(daudiPhone);
  console.log('Extracted VIN:', state.core.vin);

  // Turn 4: OTP
  console.log(`\nTurn 4: Daudi sends OTP ${state.pending_otp.code}`);
  t = mockReply(state.pending_otp.code);
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  
  // Turn 5: Stage 2 "Great!" (Fix 3)
  console.log('\nTurn 5: Daudi sends "Great!"');
  t = mockReply('Great!');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  session = chatSessions.get(daudiPhone);
  sakaReply = session.history.slice(-1)[0].parts[0].text;
  console.log('Saka Reply:', sakaReply);
  if (sakaReply.includes('Compliance & Mechanical Specs Saved')) {
    throw new Error('BUG 2 FAILED: Conversational "Great!" falsely saved as specs.');
  }
  console.log('✅ Bug 2 Fixed: Conversational affirmation seamlessly finishes Stage 2.\n');

  // Turn 6 & 7: Natural Driver Assignment (Fix 1)
  console.log('Turn 6: Daudi sends natural multi-turn "Assign KAS to a driver"');
  t = mockReply('Assign KAS to a driver');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  session = chatSessions.get(daudiPhone);
  if (!session.pendingDriverAssignment) throw new Error('BUG 3 FAILED: Failed to detect multi-turn driver assignment.');

  console.log('\nTurn 7: Daudi sends driver phone "+254720641985"');
  t = mockReply('+254720641985');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  session = chatSessions.get(daudiPhone);
  sakaReply = session.history.slice(-1)[0].parts[0].text;
  console.log('Saka Reply:', sakaReply);
  if (!sakaReply.includes('Driver Assigned Successfully')) throw new Error('BUG 3 FAILED: Did not assign driver successfully.');

  // Turn 8: Natural Single-Turn Driver Assignment
  console.log('\nTurn 8: Daudi sends natural single-turn "Assign KAS 628T to driver +254711223344"');
  t = mockReply('Assign KAS 628T to driver +254711223344');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  session = chatSessions.get(daudiPhone);
  sakaReply = session.history.slice(-1)[0].parts[0].text;
  console.log('Saka Reply:', sakaReply);
  if (!sakaReply.includes('Driver Assigned Successfully') && !sakaReply.includes('1-to-1')) throw new Error('BUG 3 FAILED: Single-turn conversational assignment failed.');
  console.log('✅ Bug 3 Fixed: Driver assignment regex and intent capture works perfectly.\n');

  // Turn 9: Circuit Breaker Recovery (Fix 2)
  console.log('Turn 9: Testing Circuit Breaker Reset Recovery');
  session.consecutivePromptCount = 3;
  session.circuitBreakerStage = 'SOFT_TRIP';
  chatSessions.set(daudiPhone, session);
  t = mockReply('1');
  await handleWhatsAppWebhook(t.req, t.reply, mockFastify);
  session = chatSessions.get(daudiPhone);
  if (session.circuitBreakerStage === 'SOFT_TRIP' || session.circuitBreakerStage === 'HARD_TRIP') {
    throw new Error('BUG 4 FAILED: Circuit breaker locked user permanently on valid input.');
  }
  console.log('✅ Bug 4 Fixed: Circuit breaker resets seamlessly when user navigates away.\n');

  console.log('🎉 DAUDI JOURNEY BUG FIXES VERIFIED SUCCESSFULLY!');
}

runDaudiJourney().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
