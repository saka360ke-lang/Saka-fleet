import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { handleSuperadminFlow } from '../services/superadmin.js';
import { processSakaMessage } from '../../sakaAi.js';
import { logChatTranscript } from '../workers/sentinel.js';
import { SUBSCRIPTION_TIERS, initializePaystackCheckout } from '../services/paystack.js';

let supabaseClient = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export const onboardingStore = new Map();
export const chatSessions = new Map();

export function detectCountryFromPhone(phone) {
  if (!phone) return { country: 'International', country_code: 'GLOBAL', plate_example: 'KDA 123A', default_units: 'metric', currency: 'USD' };
  const clean = phone.replace(/[^\d+]/g, '');
  const full = clean.startsWith('+') ? clean : `+${clean}`;

  if (full.startsWith('+254')) return { country: 'Kenya', country_code: 'KE', plate_example: 'KDA 123A', default_units: 'metric', currency: 'KES' };
  if (full.startsWith('+1')) return { country: 'United States', country_code: 'US', plate_example: '7ABC123', default_units: 'imperial', currency: 'USD' };
  if (full.startsWith('+44')) return { country: 'United Kingdom', country_code: 'GB', plate_example: 'AB12 CDE', default_units: 'imperial', currency: 'GBP' };
  if (full.startsWith('+27')) return { country: 'South Africa', country_code: 'ZA', plate_example: 'CA 123-456', default_units: 'metric', currency: 'ZAR' };
  if (full.startsWith('+234')) return { country: 'Nigeria', country_code: 'NG', plate_example: 'ABC-123XY', default_units: 'metric', currency: 'NGN' };

  return { country: 'International', country_code: 'GLOBAL', plate_example: 'KDA 123A', default_units: 'metric', currency: 'USD' };
}

export function checkIsConversationalFeedback(text = '', step = 1) {
  const clean = text.trim().toLowerCase();

  if (/^(cancel|exit|stop|reset|start over)$/i.test(clean)) return false;

  const feedbackKeywords = [
    'looping', 'loop', 'stuck', 'again', 'broken', 'bug', 'error', 'wrong',
    'why are you', 'why do you', 'what is going on', 'not working', 'confused',
    'what?', 'huh', 'dont know', "don't know", 'no idea', 'this is stupid',
    'repeating', 'stop asking', 'already gave', 'already told', 'help me'
  ];

  for (const kw of feedbackKeywords) {
    if (clean.includes(kw)) return true;
  }

  if (step === 2) {
    if (/\b(you are|i am|why is|what is|this is|can you|where is|how do|it is)\b/i.test(clean)) {
      const carBrands = ['toyota', 'nissan', 'honda', 'mazda', 'isuzu', 'subaru', 'mitsubishi', 'mercedes', 'bmw', 'vw', 'volkswagen', 'audi', 'ford', 'hyundai', 'kia', 'peugeot', 'suzuki', 'volvo', 'byd', 'land rover', 'rover', 'lexus', 'porsche'];
      const hasBrand = carBrands.some(brand => clean.includes(brand));
      if (!hasBrand) return true;
    }
  }

  return false;
}

export function extractNumberFromText(text = '') {
  if (!text) return null;
  const match = text.match(/(?:kes|usd|gbp|eur|zar|ngn|ugx|tzs|rwf|amount|\b)?\s*([\d,]+(?:\.\d+)?)/i);
  if (match && match[1]) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

export function extractOdometerFromText(text = '') {
  if (!text) return null;
  const match = text.match(/(?:odometer|mileage|km|miles|reading|clocked|\b)\s*([\d,]+)/i);
  if (match && match[1]) {
    const num = parseInt(match[1].replace(/,/g, ''), 10);
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

export function matchVehicle(vehicles = [], plateCandidate = null) {
  if (!vehicles || vehicles.length === 0) return null;
  if (plateCandidate) {
    const cleanPlate = plateCandidate.replace(/\s+/g, '').toUpperCase();
    const found = vehicles.find(v => v.plate_number.replace(/\s+/g, '').toUpperCase() === cleanPlate);
    if (found) return found;
  }
  return vehicles[0];
}

// Helper function to dispatch WhatsApp message via Meta Cloud API
async function sendWhatsAppReply(toPhone, messageBody) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) return;

  try {
    const cleanPhone = toPhone.startsWith('+') ? toPhone.slice(1) : toPhone;
    await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: messageBody }
      })
    });
  } catch (err) {
    console.error('[WhatsApp Service Error]:', err.message);
  }
}

export async function handleWhatsAppWebhook(request, reply, fastify) {
  // Meta WhatsApp Webhook HMAC SHA-256 Signature Verification
  const metaAppSecret = process.env.META_APP_SECRET;
  if (metaAppSecret) {
    const signatureHeader = request.headers ? request.headers['x-hub-signature-256'] : null;
    if (!signatureHeader) {
      if (fastify?.log) fastify.log.warn('Meta WhatsApp webhook signature missing.');
      return reply.status(403).send({ error: 'Forbidden: Missing signature header' });
    }

      const rawBody = request.rawBody || (typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {}));
      const expectedHash = crypto.createHmac('sha256', metaAppSecret).update(rawBody).digest('hex');
      const providedHash = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;

      let isValid = false;
      try {
        if (expectedHash.length === providedHash.length) {
          isValid = crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(providedHash, 'hex'));
        }
      } catch {
        isValid = false;
      }

      if (!isValid) {
        fastify.log.warn('Meta WhatsApp webhook signature verification failed.');
        return reply.status(403).send({ error: 'Forbidden: Invalid x-hub-signature-256' });
      }
    }

    const body = request.body || {};

    if (body.object === 'whatsapp_business_account') {
      try {
        const entry = body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const messageObj = value?.messages?.[0];

        if (!messageObj) {
          return reply.status(200).send({ status: 'ignored_non_message_event' });
        }

        const senderPhone = messageObj.from;
        let messageText = messageObj.text?.body || '';

        if (fastify?.log) fastify.log.info(`Incoming WhatsApp message from ${senderPhone}: "${messageText}"`);
        if (supabaseClient) logChatTranscript(supabaseClient, senderPhone, 'user', messageText);

        // Superadmin Intercept Middleware
        if (supabaseClient) {
          const superadminRes = await handleSuperadminFlow(supabaseClient, senderPhone, messageText);
          if (superadminRes.isSuperadmin) {
            if (superadminRes.reply) {
              await sendWhatsAppReply(senderPhone, superadminRes.reply);
              logChatTranscript(supabaseClient, senderPhone, 'assistant', superadminRes.reply);
            }
            return reply.status(200).send({ status: 'superadmin_handled' });
          }
        }

        let session = chatSessions.get(senderPhone) || { history: [], lastActive: Date.now() };
        session.lastActive = Date.now();

        const formattedPhone = senderPhone.startsWith('+') ? senderPhone : `+${senderPhone}`;
        const countryInfo = detectCountryFromPhone(formattedPhone);

        let profileData = null;
        if (supabaseClient) {
          const { data: pData } = await supabaseClient
            .from('profiles')
            .select('*')
            .eq('phone_number', formattedPhone)
            .maybeSingle();

          if (!pData) {
            const { data: newProfile } = await supabaseClient
              .from('profiles')
              .insert([{
                phone_number: formattedPhone,
                full_name: 'WhatsApp User',
                country: countryInfo.country,
                country_code: countryInfo.country_code,
                unit_system: countryInfo.default_units,
                preferred_language: 'English',
                is_active: true
              }])
              .select()
              .maybeSingle();
            profileData = newProfile;
          } else {
            profileData = pData;
          }
        }

        let existingVehicles = [];
        if (supabaseClient && profileData) {
          const { data: vData } = await supabaseClient
            .from('vehicles')
            .select('*')
            .is('deleted_at', null)
            .or(`owner_id.eq.${profileData.id},assigned_driver_id.eq.${profileData.id}`);
          existingVehicles = vData || [];
        }

        const hasVehicleRegistered = existingVehicles.length > 0;
        const targetLang = profileData?.preferred_language || 'English';

        // Session state determination:
        const isCurrentlyOnboarding = onboardingStore.has(senderPhone);
        if (!isCurrentlyOnboarding && hasVehicleRegistered) {
          session.state = 'ACTIVE';
          session.onboardingStep = null;
        } else if (isCurrentlyOnboarding) {
          session.state = 'ONBOARDING';
          session.onboardingStep = onboardingStore.get(senderPhone)?.step || 1;
        }

        // Pass message through Gemini Intent Classifier (sakaAi.js)
        const aiResult = await processSakaMessage(targetLang, messageText, session.history, [], supabaseClient);
        let intent = aiResult.intent;
        let customReply = aiResult.reply_message;

        // --- BRANCH A: ONBOARDING FLOW ---
        if (
          isCurrentlyOnboarding ||
          (!hasVehicleRegistered && (intent === 'REGISTER_VEHICLE' || /^\s*(register|onboard|add car|add vehicle)\b/i.test(messageText)))
        ) {
          session.state = 'ONBOARDING';
          const userTierKey = profileData?.subscription_tier || 'free';
          const currentTier = SUBSCRIPTION_TIERS[userTierKey] || SUBSCRIPTION_TIERS.free;
          const currentVehicleCount = existingVehicles.length;
          const isNewRegistrationStart = !onboardingStore.has(senderPhone);

          const cleanText = messageText.trim().toLowerCase();

          if (/^(cancel|exit|stop)$/i.test(cleanText)) {
            onboardingStore.delete(senderPhone);
            session.state = hasVehicleRegistered ? 'ACTIVE' : 'IDLE';
            session.onboardingStep = null;
            customReply = `Vehicle onboarding cancelled. ${hasVehicleRegistered ? "You are back in active menu mode." : "Type **'Register'** or reply with a plate number whenever you're ready!"}`;
          } else if (/^(reset|start over)$/i.test(cleanText)) {
            onboardingStore.set(senderPhone, { step: 1, plate_number: null, make_model: null, role: 'Owner' });
            session.onboardingStep = 1;
            customReply = `🔄 *Onboarding Reset*\n\nPlease reply with your vehicle's registration plate number (e.g. *KDA 123A* or *KBC 456X*).`;
          } else if (isNewRegistrationStart && currentVehicleCount >= currentTier.vehicleLimit) {
            const checkout = await initializePaystackCheckout({
              supabase: supabaseClient,
              userPhone: senderPhone,
              targetTierKey: 'solo_pro',
              billingInterval: 'monthly',
              userEmail: profileData?.email,
              userId: profileData?.id,
              currency: countryInfo.currency
            });
            customReply = `⚠️ *Vehicle Capacity Limit Reached*\n\nYour current plan (*${currentTier.name}*) allows a maximum of ${currentTier.vehicleLimit} vehicle(s).\n\nTo add more vehicles, please upgrade to the **Solo Pro** plan.\n👉 *Upgrade Link:* ${checkout.checkoutUrl}`;
            onboardingStore.delete(senderPhone);
            session.state = hasVehicleRegistered ? 'ACTIVE' : 'IDLE';
            session.onboardingStep = null;
          } else {
            let obState = onboardingStore.get(senderPhone) || {
              step: 1,
              plate_number: null,
              make_model: null,
              role: 'Owner'
            };
            onboardingStore.set(senderPhone, obState);

            const isFeedbackOrUnrelated = checkIsConversationalFeedback(messageText, obState.step);

            if (isFeedbackOrUnrelated) {
              if (obState.step === 1) {
                customReply = `I noticed your message. If you want to cancel, reply **'cancel'**.\n\nOtherwise, please reply with your vehicle's registration plate number (e.g. *KDA 123A*).`;
              } else {
                customReply = `I noticed your message ("${messageText.trim()}").\n\nIf you want to restart or cancel onboarding, reply **'reset'** or **'cancel'**.\nOtherwise, please reply with your vehicle's make and model (e.g. *Toyota Fielder - Owner*).`;
              }
            } else {
              if (obState.step === 1) {
                const ext = aiResult.extracted_data || {};
                const plateMatch = messageText.match(/\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}|\d[A-Z]{3}\d{3})\b/i);
                let candidatePlate = ext.plate_number || (plateMatch ? plateMatch[0] : null);

                if (!candidatePlate && !/^(register|onboard|add car|add vehicle|new vehicle|help|cancel|exit|stop|reset|start over)$/i.test(messageText.trim())) {
                  if (messageText.trim().length >= 3 && messageText.trim().length <= 12) {
                    candidatePlate = messageText.trim();
                  }
                }

                if (candidatePlate && candidatePlate.length >= 3 && candidatePlate.length <= 12) {
                  obState.plate_number = candidatePlate.toUpperCase();
                  obState.step = 2;
                  onboardingStore.set(senderPhone, obState);
                  session.onboardingStep = 2;
                  customReply = `🚘 *Step 2 of 2: Vehicle Details & Role* 📝\n\nGot registration plate *${obState.plate_number}*!\n\nWhat is the **make and model** of your vehicle, and are you the **Owner** or **Driver**? (e.g. *"Toyota Fielder - Owner"* or *"Nissan Note Driver"*).`;
                } else {
                  customReply = `🚘 *Step 1 of 2: Vehicle Registration Plate*\n\nPlease reply with your vehicle's registration plate number (e.g. *KDA 123A* or *KBC 456X*).`;
                }
              }

            // Step 2: Prompt for make/model & role -> Save vehicle to Supabase & Transition to ACTIVE
            else if (obState.step === 2) {
              if (/driver/i.test(messageText)) obState.role = 'Driver';
              else if (/owner/i.test(messageText)) obState.role = 'Owner';

              let modelCandidate = obState.make_model;
              if (!modelCandidate) {
                const cleanedModel = messageText.replace(/owner|driver/gi, '').replace(/[-–,]/g, ' ').trim();
                modelCandidate = cleanedModel.length >= 2 ? cleanedModel : messageText.trim();
              }

              if (!modelCandidate || modelCandidate.length < 2) {
                customReply = `Please specify the make and model of your vehicle (e.g., *Toyota Fielder - Owner*).`;
              } else {
                obState.make_model = modelCandidate;

                try {
                  const token = `SK-PASSBOOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                  let newVeh = null;

                  if (supabaseClient && profileData) {
                    const { data: vCreated } = await supabaseClient.from('vehicles').insert([{
                      owner_id: profileData.id,
                      plate_number: obState.plate_number.toUpperCase(),
                      make_model: obState.make_model,
                      year_of_manufacture: new Date().getFullYear(),
                      asset_type: 'ICE',
                      unit_system: profileData.unit_system || countryInfo.default_units || 'metric',
                      odometer_reading: 0,
                      operating_hours: 0,
                      qr_passbook_token: token,
                      metadata: { role: obState.role }
                    }]).select().single();
                    newVeh = vCreated;

                    await supabaseClient.from('profiles').update({
                      updated_at: new Date().toISOString()
                    }).eq('id', profileData.id);
                  }

                  // STATE TRANSITION AFTER ONBOARDING (Fix 1)
                  onboardingStore.delete(senderPhone);
                  session.state = 'ACTIVE';
                  session.onboardingStep = null;
                  chatSessions.set(senderPhone, session);

                  const finalPlate = newVeh?.plate_number || obState.plate_number;
                  const finalModel = newVeh?.make_model || obState.make_model;

                  customReply = `🎉 *Vehicle Registered Successfully!* 🚀\n\n🚘 *Vehicle Details:*\n• *Plate Number:* ${finalPlate}\n• *Make & Model:* ${finalModel}\n• *Role:* ${obState.role}\n• *Passbook Token:* \`${token}\`\n\n📋 *What would you like to do next?*\n1️⃣ *Log Expense / Fuel* (e.g. "Logged fuel KES 3000")\n2️⃣ *Update Mileage* (e.g. "Odometer 45000 km")\n3️⃣ *Set Service Reminder* (e.g. "Remind oil change in 5000 km")\n4️⃣ *Log Earnings* (e.g. "Earned KES 5000 today")\n5️⃣ *View Reports & Summary*\n\nReply with a number or type what you want to do!`;
                } catch (regErr) {
                  onboardingStore.delete(senderPhone);
                  session.state = hasVehicleRegistered ? 'ACTIVE' : 'IDLE';
                  session.onboardingStep = null;
                  customReply = `Failed to complete registration. Please try typing **'Register'** again.`;
                }
              }
            }
          }
        }
      }

        // --- BRANCH B: ACTIVE USER FLOW (POST-ONBOARDING INPUT ROUTING - Fix 2) ---
        else if (hasVehicleRegistered || session.state === 'ACTIVE') {
          session.state = 'ACTIVE';

          const cleanTrimmed = messageText.trim();
          const numericMatch = cleanTrimmed.match(/^(1|1️⃣|2|2️⃣|3|3️⃣|4|4️⃣|5|5️⃣)$/);

          let activeIntent = intent;
          if (numericMatch) {
            const choice = numericMatch[1].replace('️⃣', '');
            if (choice === '1') activeIntent = 'LOG_EXPENSE';
            else if (choice === '2') activeIntent = 'UPDATE_MILEAGE';
            else if (choice === '3') activeIntent = 'SET_REMINDER';
            else if (choice === '4') activeIntent = 'LOG_EARNINGS';
            else if (choice === '5') activeIntent = 'REQUEST_REPORT';
          }

          if (activeIntent === 'REGISTER_VEHICLE') {
            const explicitRegPattern = /^\s*(register|onboard|add car|add vehicle|new vehicle)\b/i;
            if (!explicitRegPattern.test(messageText)) {
              if (/odometer|km|mileage/i.test(messageText)) {
                activeIntent = 'UPDATE_MILEAGE';
              } else if (/fuel|kes|usd|spent|cost|paid|expense|liters/i.test(messageText)) {
                activeIntent = 'LOG_EXPENSE';
              } else if (/earned|revenue|earnings|income|fare/i.test(messageText)) {
                activeIntent = 'LOG_EARNINGS';
              } else {
                activeIntent = 'GENERAL_CHAT';
              }
            } else {
              onboardingStore.set(senderPhone, { step: 1, plate_number: null, make_model: null, role: 'Owner' });
              session.state = 'ONBOARDING';
              session.onboardingStep = 1;
              customReply = `🚘 *Step 1 of 2: Vehicle Registration Plate*\n\nPlease reply with the registration plate number for your new vehicle (e.g. *KDA 123A* or *KBC 456X*).`;
            }
          }

          if (session.state === 'ACTIVE') {
            if (activeIntent === 'GREETING') {
              customReply = `Hello! 👋 Welcome back to Saka Fleet.\n\nYou have ${existingVehicles.length} vehicle(s) registered. What would you like to do today?\n1️⃣ Log Expense / Fuel\n2️⃣ Update Odometer\n3️⃣ Set Service Reminder\n4️⃣ Log Earnings\n5️⃣ View Reports & Summary`;
            }
            else if (activeIntent === 'LOG_EXPENSE') {
              const extAmount = aiResult.extracted_data?.amount || extractNumberFromText(messageText);
              if (extAmount && extAmount > 0) {
                const targetVeh = matchVehicle(existingVehicles, aiResult.extracted_data?.plate_number) || existingVehicles[0];
                if (supabaseClient && targetVeh) {
                  await supabaseClient.from('expenses').insert([{
                    plate: targetVeh.plate_number,
                    expense_type: 'Fuel',
                    amount: extAmount,
                    liters: aiResult.extracted_data?.liters || 0
                  }]);
                }
                customReply = `⛽ *Expense Logged Successfully!* 📝\n\n• *Vehicle:* ${targetVeh?.plate_number || 'Fleet'}\n• *Amount:* ${countryInfo.currency} ${Number(extAmount).toLocaleString()}\n\nExpense recorded! What would you like to do next?`;
              } else {
                customReply = `⛽ *Log Expense / Fuel*\n\nPlease reply with your expense details. For example:\n• *"Logged fuel KES 3000"* or *"Oil change KES 5000"*`;
              }
            }
            else if (activeIntent === 'UPDATE_MILEAGE') {
              const extOdometer = aiResult.extracted_data?.odometer || extractOdometerFromText(messageText);
              if (extOdometer && extOdometer > 0) {
                const targetVeh = matchVehicle(existingVehicles, aiResult.extracted_data?.plate_number) || existingVehicles[0];
                if (supabaseClient && targetVeh) {
                  await supabaseClient.from('vehicles').update({
                    odometer_reading: extOdometer,
                    updated_at: new Date().toISOString()
                  }).eq('id', targetVeh.id);
                }
                customReply = `📈 *Odometer Updated!* 🚗\n\n• *Vehicle:* ${targetVeh?.plate_number || 'Fleet'}\n• *New Odometer:* ${Number(extOdometer).toLocaleString()} ${targetVeh?.unit_system === 'imperial' ? 'mi' : 'km'}\n\nOdometer reading updated successfully!`;
              } else {
                customReply = `📈 *Update Mileage / Odometer*\n\nPlease reply with your updated odometer reading. For example:\n• *"Odometer 45000 km"* or *"Mileage 120000 km"*`;
              }
            }
            else if (activeIntent === 'LOG_EARNINGS') {
              const extAmount = aiResult.extracted_data?.amount || extractNumberFromText(messageText);
              if (extAmount && extAmount > 0) {
                const targetVeh = matchVehicle(existingVehicles, aiResult.extracted_data?.plate_number) || existingVehicles[0];
                if (supabaseClient && targetVeh) {
                  await supabaseClient.from('private_earnings').insert([{
                    vehicle_id: targetVeh.id,
                    revenue_amount: extAmount,
                    currency: countryInfo.currency,
                    logged_at: new Date().toISOString()
                  }]);
                }
                customReply = `💰 *Earnings Logged!* 🎉\n\n• *Vehicle:* ${targetVeh?.plate_number || 'Fleet'}\n• *Revenue:* ${countryInfo.currency} ${Number(extAmount).toLocaleString()}\n\nEarnings recorded successfully!`;
              } else {
                customReply = `💰 *Log Earnings*\n\nPlease reply with your revenue details. For example:\n• *"Earned KES 5000 today"* or *"Trip revenue KES 3500"*`;
              }
            }
            else if (activeIntent === 'SET_REMINDER') {
              customReply = `🔔 *Set Service Reminder*\n\nPlease reply with your service reminder details. For example:\n• *"Remind oil change in 5000 km"* or *"Service due next Monday"*`;
            }
            else if (activeIntent === 'REQUEST_REPORT') {
              customReply = `📊 *Fleet Reports & Summary*\n\nYou have ${existingVehicles.length} active vehicle(s).\n\nType *"Send monthly report"* or *"View summary"* for a detailed statement.`;
            }
            else if (activeIntent === 'MANAGE_VEHICLE' || activeIntent === 'LIST_VEHICLES') {
              const vehicleList = existingVehicles.map((v, i) => `${i + 1}️⃣ *${v.plate_number}* (${v.make_model || 'Vehicle'})`).join('\n');
              customReply = `⚙️ *Your Registered Vehicles:*\n\n${vehicleList}\n\nReply with a menu option to log expenses or update mileage!`;
            }
            else if (activeIntent === 'APP_HELP') {
              customReply = `🚗 *Saka Fleet Assistant Capabilities:*\n\n• *Fuel & Expenses:* Log fuel pump receipts and repairs.\n• *Odometer & Reminders:* Track mileage and set automated service alerts.\n• *Earnings & PDF Reports:* Record trip revenue and generate monthly fleet statements.`;
            }
            else {
              customReply = `Hello! 👋 How can I help manage your fleet today?\n\n1️⃣ *Log Expense / Fuel*\n2️⃣ *Update Mileage*\n3️⃣ *Set Service Reminder*\n4️⃣ *Log Earnings*\n5️⃣ *View Reports & Summary*\n\nReply with a number or type what you'd like to do!`;
            }
          }
        }

        // --- BRANCH C: UNREGISTERED / IDLE USER DEFAULT ---
        else {
          customReply = `👋 *Welcome to Saka Fleet!* 🚗\n\nSaka Fleet tracks vehicle processes, compliance, expenses, and maintenance directly on WhatsApp.\n\n🚀 *Get Started:* To start onboarding, reply with your vehicle's registration number (e.g. *KDA 123A*) or type **'Register'**.`;
        }

        const sanitizedReply = customReply.trim();

        session.history.push({ role: 'user', parts: [{ text: messageText }] });
        session.history.push({ role: 'model', parts: [{ text: sanitizedReply }] });
        if (session.history.length > 20) session.history = session.history.slice(-20);
        chatSessions.set(senderPhone, session);

        await sendWhatsAppReply(senderPhone, sanitizedReply);
        if (supabaseClient) logChatTranscript(supabaseClient, senderPhone, 'assistant', sanitizedReply);

        return reply.status(200).send({ status: 'success' });
      } catch (err) {
        if (fastify?.log) fastify.log.error(err);
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    }

  return reply.status(404).send({ error: 'Not Found' });
}

export default async function whatsappRoutes(fastify, options) {
  const verifyWebhook = async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === expectedToken) {
      if (fastify?.log) fastify.log.info('WhatsApp webhook verified successfully!');
      return reply.status(200).send(challenge);
    } else {
      return reply.status(403).send('Forbidden');
    }
  };

  // 1. Webhook Verification Handshake (GET)
  fastify.get('/webhook', verifyWebhook);
  fastify.get('/webhook/whatsapp', verifyWebhook);
  fastify.get('/api/whatsapp/webhook', verifyWebhook);

  // 2. Incoming Messages & Event Listener (POST)
  const webhookHandler = (request, reply) => handleWhatsAppWebhook(request, reply, fastify);
  fastify.post('/webhook', webhookHandler);
  fastify.post('/webhook/whatsapp', webhookHandler);
  fastify.post('/api/whatsapp/webhook', webhookHandler);
}
