import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { handleSuperadminFlow, isSuperadminPhone } from '../services/superadmin.js';
import { processSakaMessage, extractVehicleAttributes } from '../../sakaAi.js';
import { logChatTranscript } from '../workers/sentinel.js';
import { SUBSCRIPTION_TIERS, initializePaystackCheckout } from '../services/paystack.js';
import {
  ensureVehicleTableColumns,
  canAssignDriverToVehicle,
  assignDriverToVehicle,
  unassignDriverFromVehicle,
  checkOwnerVehicleTierLimit,
  getActiveVehicle,
  setActiveVehicle,
  findVehicleByCandidate
} from '../services/vehicles.js';
import { calculateFuelConsumption, getVehicleSummaryReport } from '../services/analytics.js';
import { handleStage1CoreCapture, handleStage2OptionalWeaving } from '../services/onboarding.js';
import { saveChatMessage, getRecentChatHistory } from '../services/chatHistory.js';
import { sendEmailOtp, sendSupportEscalationEmail } from '../services/mailer.js';
import {
  initiatePassbookTransfer,
  setBuyerDetailsAndSendReleaseOtp,
  verifyOwnerReleaseOtpAndNotifyBuyer,
  handleBuyerAcceptance,
  completePassbookTransfer
} from '../services/transfers.js';
import { applyTrialExtensionCoupon } from '../services/coupons.js';

let supabaseClient = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export const onboardingStore = new Map();
export const chatSessions = new Map();

// Idempotency cache: Meta message ID (wamid) -> timestamp (10-minute TTL)
export const processedWebhooksCache = new Map();
export const DEDUPLICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isMessageProcessed(wamid) {
  if (!wamid) return false;
  const now = Date.now();
  for (const [id, timestamp] of processedWebhooksCache.entries()) {
    if (now - timestamp > DEDUPLICATION_TTL_MS) {
      processedWebhooksCache.delete(id);
    }
  }
  return processedWebhooksCache.has(wamid);
}

export function markMessageProcessed(wamid) {
  if (!wamid) return;
  processedWebhooksCache.set(wamid, Date.now());
}

export async function checkAndRecordWamid(supabase, wamid, senderPhone) {
  if (!wamid) return false;

  // 1. Fast in-memory check (<0.1ms)
  if (isMessageProcessed(wamid)) {
    return true; // Already processed!
  }
  markMessageProcessed(wamid);

  // 2. Distributed Supabase cache check & sync
  if (supabase) {
    try {
      const tenMinutesAgo = new Date(Date.now() - DEDUPLICATION_TTL_MS).toISOString();
      const { data, error } = await supabase
        .from('processed_webhooks')
        .select('wamid')
        .eq('wamid', wamid)
        .gte('processed_at', tenMinutesAgo)
        .maybeSingle();

      if (!error && data) {
        return true;
      }

      // Record in Supabase asynchronously
      await supabase
        .from('processed_webhooks')
        .upsert([{ wamid, phone_number: senderPhone, processed_at: new Date().toISOString() }], { onConflict: 'wamid' });
    } catch {
      // In-memory cache continues seamlessly if database has transient issue
    }
  }

  return false;
}

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
    'repeating', 'stop asking', 'already gave', 'already told', 'help me',
    'lot of responses', 'many responses', 'many replies', 'frustrating',
    'frustrated', 'too many messages', 'too many', 'stop replying', 'stop sending',
    'stop with the many replies', 'too many replies'
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
/**
 * First-time / unregistered user progressive onboarding guide.
 * Shared by role discovery and the idle greeting so every brand-new user
 * receives one consistent, numbered, step-by-step path.
 */
export function buildFirstTimeWelcome({ swahili = false } = {}) {
  const opener = swahili
    ? '👋 *Habari! Karibu Saka Fleet!* 🚗'
    : '👋 *Welcome to Saka Fleet!* 🚗';
  return `${opener}\n\n` +
    `Saka tracks your vehicles, fuel, expenses, compliance & maintenance right here on WhatsApp.\n\n` +
    `🚀 *Your First-Time Setup (about 2 minutes):*\n` +
    `1️⃣ Reply with your plate number (e.g. *KDA 123A*) — or type *Register*.\n` +
    `2️⃣ Send Make & Model, Year, Fuel Type and current mileage.\n` +
    `3️⃣ Verify your email with the 6-digit code we send you.\n` +
    `4️⃣ Receive your VIN-locked digital passbook instantly. 🎉\n\n` +
    `💡 *Anytime:* type *Help* or *What can I do?* to see your menu.\n` +
    `🔄 *Mistake?* type *Restart* or *Cancel*.\n` +
    `🤝 *Buying a vehicle with a passbook?* Reply *ACCEPT* once the seller starts the transfer.`;
}


/**
 * Conversational Action Discovery (Driver, Owner, Superadmin)
 */
export function generateRoleBasedActionDiscovery({ profileData, vehicles = [], senderPhone, targetVeh }) {
  const isAdmin = isSuperadminPhone(senderPhone);
  const ownedVehicles = vehicles.filter(v => v.owner_id === profileData?.id);
  const assignedVehicles = vehicles.filter(v => v.assigned_driver_id === profileData?.id);
  const isOwner = ownedVehicles.length > 0;
  const isDriver = assignedVehicles.length > 0;
  const activePlate = targetVeh?.plate_number || (ownedVehicles[0] || assignedVehicles[0])?.plate_number || 'Fleet';

  if (isAdmin) {
    return `🛡️ *Saka Fleet — Superadmin Command Hub*\n` +
      `Verified Superadmin: ${senderPhone}\n\n` +
      `👑 *Superadmin Operations:*\n` +
      `• \`admin report\` — Executive fleet digest\n` +
      `• \`admin audit [Plate or VIN]\` — Deep vehicle passbook audit\n` +
      `• \`admin alerts\` — System warnings & friction logs\n` +
      `• \`adminrules reset\` — Dynamic micro-rules management\n` +
      `• \`adminstop\` — Terminate admin session\n\n` +
      `💡 *Fleet Management:* You also have full access to owner and driver tools for personal vehicles.`;
  }

  if (isOwner && isDriver) {
    return `👑 *Saka Fleet — Owner & Driver Command Center*\n` +
      `Active Vehicle: *${activePlate}*\n\n` +
      `🚗 *Fleet & Passbook (Owner):*\n` +
      `• \`my vehicles\` — View all registered vehicles\n` +
      `• \`switch to [plate]\` — Change active vehicle\n` +
      `• \`register\` — Add a new vehicle slot\n` +
      `• \`transfer passbook [plate]\` — Securely hand over passbook to buyer\n` +
      `• \`assign driver [phone] to [plate]\` — Assign driver (Strict 1-to-1)\n\n` +
      `🚙 *Driver Duties (Assigned Driver):*\n` +
      `• \`Odometer [km]\` — Update vehicle mileage\n` +
      `• \`Logged [L] fuel for [amount]\` — Record fuel expenses\n` +
      `• \`Earned [amount] today\` — Log revenue\n\n` +
      `📊 *Audits & Analytics:*\n` +
      `• \`What is my fuel consumption in km/l?\` — Instant efficiency report\n` +
      `• \`Send monthly report\` — PDF audit report via email`;
  }

  if (isOwner) {
    return `👑 *Saka Fleet — Owner Command Center*\n` +
      `Active Vehicle: *${activePlate}*\n\n` +
      `🚗 *Fleet & Passbook:*\n` +
      `• \`my vehicles\` — View all registered vehicles\n` +
      `• \`switch to [plate]\` — Change active vehicle\n` +
      `• \`register\` — Add a new vehicle to your fleet\n` +
      `• \`transfer passbook [plate]\` — Transfer vehicle passbook to a buyer\n\n` +
      `👥 *Driver Management:*\n` +
      `• \`assign driver [phone] to [plate]\` — Assign driver (Strict 1-to-1)\n` +
      `• \`unassign driver from [plate]\` — Release assigned driver\n\n` +
      `⛽ *Daily Operations:*\n` +
      `• \`Logged 40L fuel for KES 8500 at 368000 km\` — Log fuel & odometer\n` +
      `• \`Earned KES 6000 today\` — Record daily trip revenue\n` +
      `• \`Remind oil change at 375000 km\` — Set service reminder\n\n` +
      `📊 *Audits & Analytics:*\n` +
      `• \`What is my fuel consumption in km/l?\` — Instant efficiency report\n` +
      `• \`Send monthly report\` — PDF audit statement via email\n` +
      `• \`upgrade plan\` — View subscription tiers & slot expansion`;
  }

  if (isDriver) {
    return `🚙 *Saka Fleet — Driver Hub*\n` +
      `Assigned Vehicle: *${activePlate}*\n\n` +
      `📝 *Your Daily Tools:*\n` +
      `• \`Odometer 368000 km\` — Update mileage reading\n` +
      `• \`Logged 30L petrol KES 6000\` — Submit fuel expense\n` +
      `• \`Earned KES 4500 today\` — Submit daily trip income\n` +
      `• \`Oil change needed\` — Notify fleet owner of service issue\n` +
      `• \`passbook details\` — View compliance & insurance dates\n\n` +
      `💡 *Note:* Driver submissions automatically update fleet records and notify your owner.`;
  }

  return buildFirstTimeWelcome();
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
      if (fastify?.log) fastify.log.warn('Meta WhatsApp webhook signature verification failed.');
      return reply.status(403).send({ error: 'Forbidden: Invalid x-hub-signature-256' });
    }
  }

  const body = request.body || {};

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messageObj = value?.messages?.[0];

    if (!messageObj) {
      return reply.status(200).send({ status: 'ignored_non_message_event' });
    }

    const wamid = messageObj.id;
    const senderPhone = messageObj.from;

    // 1. Message ID Deduplication (Idempotency Cache - 10 min TTL)
    if (wamid) {
      if (isMessageProcessed(wamid)) {
        if (fastify?.log) fastify.log.warn(`[Deduplication] Message ${wamid} already processed within last 10m. Aborting Meta retry.`);
        return reply.status(200).send({ status: 'success', deduplicated: true });
      }
      markMessageProcessed(wamid);
    }

    // 2. Immediate Fastify 200 OK Response (Eliminates Meta Webhook Timeout & Retries)
    if (reply && typeof reply.status === 'function') {
      reply.status(200).send({ status: 'success' });
    }

    // 3. Asynchronous Background Execution (DeepSeek AI, State Machine, Database)
    return processIncomingWhatsAppMessage({ messageObj, fastify, supabaseClient });
  }

  return reply.status(404).send({ error: 'Not Found' });
}

export async function processIncomingWhatsAppMessage({ messageObj, fastify, supabaseClient }) {
  try {
    const senderPhone = messageObj.from;
    const wamid = messageObj.id;
    let messageText = messageObj.text?.body || '';

    // Record wamid in Supabase processed_webhooks table for cluster persistence
    if (wamid && supabaseClient) {
      try {
        await supabaseClient
          .from('processed_webhooks')
          .upsert([{ wamid, phone_number: senderPhone, processed_at: new Date().toISOString() }], { onConflict: 'wamid' });
      } catch {}
    }

    if (fastify?.log) fastify.log.info(`Incoming WhatsApp message from ${senderPhone}: "${messageText}"`);
    if (supabaseClient) {
      await logChatTranscript(supabaseClient, senderPhone, 'user', messageText);
      await saveChatMessage(supabaseClient, senderPhone, 'user', messageText);
    }

    // Superadmin Intercept Middleware
    if (supabaseClient) {
      const superadminRes = await handleSuperadminFlow(supabaseClient, senderPhone, messageText);
      if (superadminRes.isSuperadmin) {
        if (superadminRes.reply) {
          await sendWhatsAppReply(senderPhone, superadminRes.reply);
          await logChatTranscript(supabaseClient, senderPhone, 'assistant', superadminRes.reply);
          await saveChatMessage(supabaseClient, senderPhone, 'assistant', superadminRes.reply);
        }
        return { status: 'superadmin_handled' };
      }
    }

    let session = chatSessions.get(senderPhone) || { history: [], lastActive: Date.now() };
    session.lastActive = Date.now();

    // Circuit Breaker State Check & Reset on user reset/cancel commands
    const cleanCmd = messageText.trim().toLowerCase();
    if (/^(cancel|exit|stop|reset|start over|1|2|3|4|5)$/i.test(cleanCmd) || /^(log|update|set|request|help)/i.test(cleanCmd)) {
      session.circuitBreakerStage = null;
      session.consecutivePromptCount = 0;
      session.lastAssistantPrompt = null;
      session.loopSignature = null;
    } else if (session.circuitBreakerStage === 'HARD_TRIP') {
      // Circuit breaker is in hard trip: bypass DeepSeek and send clean fallback message
      const fallbackReply = "I've hit a temporary snag processing this step. I have notified our support team at support@sakafleet.com, and we will update you right here on WhatsApp once this is resolved!";
      await sendWhatsAppReply(senderPhone, fallbackReply);
      if (supabaseClient) {
        try {
          await supabaseClient.from('chat_transcripts').insert([{ phone_number: senderPhone, sender: 'assistant', message_text: fallbackReply }]);
          await supabaseClient.from('chat_history').insert([{ user_phone: senderPhone, role: 'assistant', message: fallbackReply }]);
        } catch {}
      }
      return { status: 'circuit_breaker_active' };
    }

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
                id: crypto.randomUUID(),
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

        let currentActiveVehicle = null;
        if (hasVehicleRegistered) {
          currentActiveVehicle = getActiveVehicle({ senderPhone, vehicles: existingVehicles, chatSessions });
          if (!session.active_vehicle_id && currentActiveVehicle) {
            session.active_vehicle_id = currentActiveVehicle.id;
          }
        }

        // Session state determination:
        const isCurrentlyOnboarding = onboardingStore.has(senderPhone);
        if (!isCurrentlyOnboarding && hasVehicleRegistered) {
          session.state = 'ACTIVE';
          session.onboardingStep = null;
        } else if (isCurrentlyOnboarding) {
          session.state = 'ONBOARDING';
          session.onboardingStep = onboardingStore.get(senderPhone)?.step || 1;
        }

        let conversationHistory = session.history || [];
        if (supabaseClient) {
          const dbHistory = await getRecentChatHistory(supabaseClient, senderPhone, 10);
          if (dbHistory && dbHistory.length > 0) {
            conversationHistory = dbHistory;
          }
        }

        // Pass message through DeepSeek Intent Classifier (sakaAi.js) with Active Fleet Context
        const activeVehicleContext = hasVehicleRegistered ? {
          activeVehicle: currentActiveVehicle,
          allVehicles: existingVehicles
        } : null;

        const aiResult = await processSakaMessage(targetLang, messageText, conversationHistory, [], supabaseClient, activeVehicleContext);
        let intent = aiResult.intent;
        let customReply = aiResult.reply_message;

        // Extract and merge structured vehicle attributes
        const regexAttrs = extractVehicleAttributes(messageText);
        const mergedExt = {
          ...regexAttrs,
          ...(aiResult.extracted_data || {})
        };

        const isRegisterCommand = /^\s*(register|onboard|add car|add vehicle|new vehicle)\b/i.test(messageText);
        const hasVehicleAttributes = !!(mergedExt.plate_number || (mergedExt.yom && (mergedExt.fuel_type || mergedExt.make_model)) || (mergedExt.fuel_type && mergedExt.current_mileage) || mergedExt.vin);

        let isSupportFlow = false;
        // --- SUPPORT ESCALATION FLOW (support@sakafleet.com) ---
        if (session.pendingSupportEscalation) {
          isSupportFlow = true;
          const cleanText = messageText.trim().toLowerCase();
          if (/^(cancel|exit|stop)$/i.test(cleanText)) {
            session.pendingSupportEscalation = false;
            customReply = `Support escalation cancelled. ${hasVehicleRegistered ? "You are back in active menu mode." : "How can I assist you today?"}`;
          } else {
            await sendSupportEscalationEmail({
              userPhone: senderPhone,
              userEmail: profileData?.email,
              userName: profileData?.full_name,
              subscriptionTier: profileData?.subscription_tier,
              issueParagraph: messageText.trim(),
              vehiclesList: existingVehicles
            });
            session.pendingSupportEscalation = false;
            customReply = "I've forwarded your message to our support team at support@sakafleet.com. They will reach out to you shortly!";
          }
        } else if (
          intent === 'CONTACT_SUPPORT' ||
          /\b(support|human|agent|representative|talk to a person|admin intervention|file a complaint|escalat(e|ion)|dispute|help from human|talk to support|contact support|human help|customer care)\b/i.test(messageText)
        ) {
          isSupportFlow = true;
          session.pendingSupportEscalation = true;
          customReply = "Please write out a description of your issue in a single paragraph so our support team can assist you.";
        }

        if (!isSupportFlow) {

        let isSpecialFlowHandled = false;

        // 1. In-flight Passbook Transfer Handler (Current Owner Steps 2 & 3)
        if (session.transferFlow) {
          isSpecialFlowHandled = true;
          const cleanText = messageText.trim().toLowerCase();
          if (/^(cancel|exit|stop|cancel transfer)$/i.test(cleanText)) {
            if (session.transferFlow.transferId && supabaseClient) {
              await supabaseClient.from('passbook_transfers').update({ status: 'CANCELLED' }).eq('id', session.transferFlow.transferId);
            }
            session.transferFlow = null;
            customReply = `Passbook transfer cancelled. You are back in main menu mode.`;
          } else if (session.transferFlow.step === 2) {
            const phoneMatch = messageText.match(/\+?[0-9]{9,15}/);
            const emailMatch = messageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

            if (phoneMatch && emailMatch) {
              const res = await setBuyerDetailsAndSendReleaseOtp({
                transferId: session.transferFlow.transferId,
                buyerPhone: phoneMatch[0],
                buyerEmail: emailMatch[0],
                supabase: supabaseClient
              });

              if (res.success) {
                session.transferFlow.step = 3;
                session.transferFlow.buyerPhone = res.buyerPhone;
                session.transferFlow.ownerEmail = res.ownerEmail;
                customReply = `🔒 *Step 3 of 5: Security Authorization*\n\nWe dispatched a 6-digit release PIN to your email (*${res.ownerEmail}*).\n\nPlease reply with the 6-digit code to authorize releasing ownership of *${session.transferFlow.vehicle.plate_number}* to ${res.buyerPhone}.\n\n_(Reply 'cancel' to abort)_`;
              } else {
                customReply = `⚠️ ${res.error}\n\nPlease reply with both the buyer's WhatsApp number and email address, or reply 'cancel'.`;
              }
            } else {
              customReply = `👉 *Step 2 of 5: Buyer Details*\n\nPlease provide both the buyer's WhatsApp phone number and email address (e.g. \`+254712345678 buyer@example.com\`).\n\n_(Reply 'cancel' to abort)_`;
            }
          } else if (session.transferFlow.step === 3) {
            const pinCandidate = messageText.trim();
            const res = await verifyOwnerReleaseOtpAndNotifyBuyer({
              transferId: session.transferFlow.transferId,
              providedOtp: pinCandidate,
              supabase: supabaseClient,
              sendWhatsAppFn: sendWhatsAppReply
            });

            if (res.success) {
              const plate = session.transferFlow.vehicle.plate_number;
              session.transferFlow = null;
              customReply = `✅ *Asset Release Authorized!*\n\nWe have notified the buyer on WhatsApp at *${res.buyerPhone}*.\n\nAwaiting the buyer's reply to claim ownership of *${plate}*.`;
            } else {
              customReply = `❌ ${res.error}\n\nPlease enter the correct 6-digit release code sent to your email, or reply 'cancel' to abort.`;
            }
          }
        }
        // 2. Buyer Acceptance ("ACCEPT")
        else if (/^\s*(accept|claim passbook|claim ownership)\b/i.test(messageText)) {
          if (supabaseClient) {
            const acceptRes = await handleBuyerAcceptance({
              buyerPhone: senderPhone,
              supabase: supabaseClient,
              sendWhatsAppFn: sendWhatsAppReply
            });
            if (acceptRes) {
              isSpecialFlowHandled = true;
              if (acceptRes.status === 'OTP_SENT') {
                session.pendingTransferBuyerOtp = { transferId: acceptRes.transferId };
              }
              customReply = acceptRes.replyMessage;
            }
          }
        }
        // 3. Buyer Email OTP Verification (Step 5)
        else if (session.pendingTransferBuyerOtp || (messageText.trim().match(/^\d{6}$/) && !isCurrentlyOnboarding && !session.pendingEmailUpdate && !onboardingStore.has(senderPhone))) {
          if (supabaseClient) {
            const transferCompleteRes = await completePassbookTransfer({
              buyerPhone: senderPhone,
              providedOtp: messageText.trim(),
              supabase: supabaseClient,
              sendWhatsAppFn: sendWhatsAppReply
            });
            if (transferCompleteRes.success) {
              isSpecialFlowHandled = true;
              session.pendingTransferBuyerOtp = null;
              session.state = 'ACTIVE';
              customReply = `🎉 *Congratulations!* You are now the official registered owner of *${transferCompleteRes.plateNumber}* on Saka Fleet! 🚗\n\n• *VIN:* \`${transferCompleteRes.vin}\`\n• *Passbook Token:* \`${transferCompleteRes.newToken}\`\n\nYour official digital passbook has been sent to *${transferCompleteRes.buyerEmail}*.\nType *"What can I do?"* to explore your owner tools!`;
            }
          }
        }
        // 4. Trial Extension Coupon ("Yes" or coupon code)
        else if (intent === 'APPLY_COUPON' || /^(yes|yes please|apply coupon|extend trial|extend)$/i.test(messageText.trim()) || /^EXT30-[A-Z0-9]+$/i.test(messageText.trim())) {
          if (supabaseClient) {
            const extRes = await applyTrialExtensionCoupon({
              phone: senderPhone,
              couponCode: mergedExt.coupon_code || (messageText.trim().startsWith('EXT30-') ? messageText.trim() : null),
              supabase: supabaseClient
            });
            if (extRes.success) {
              isSpecialFlowHandled = true;
              customReply = `🎉 *Trial Extension Applied!* 🚗💨\n\n• *Vehicle:* *${extRes.plateNumber}* (VIN: \`${extRes.vin}\`)\n• *Coupon Code:* *${extRes.couponCode}*\n• *Days Added:* +${extRes.daysAdded} Days\n• *New Trial Expiration:* ${new Date(extRes.newTrialEndAt).toLocaleDateString()}\n\nYour 30-day free trial has been successfully extended. Type *"What can I do?"* to explore your fleet tools!`;
            }
          }
        }
        // 5. Action Discovery & Role Help
        else if (intent === 'ACTION_DISCOVERY' || intent === 'APP_HELP' || /\b(?:what\s+can\s+i\s+do|show\s+my\s+actions|my\s+actions|show\s+actions|what\s+are\s+my\s+commands|available\s+commands)\b/i.test(messageText.trim())) {
          isSpecialFlowHandled = true;
          customReply = generateRoleBasedActionDiscovery({
            profileData,
            vehicles: existingVehicles,
            senderPhone,
            targetVeh: currentActiveVehicle
          });
        }

        if (!isSpecialFlowHandled) {


        // --- BRANCH A: TWO-STAGE PROGRESSIVE ONBOARDING FLOW ---
        if (
          isCurrentlyOnboarding ||
          (!hasVehicleRegistered && (intent === 'REGISTER_VEHICLE' || intent === 'ONBOARDING_INPUT' || intent === 'VERIFY_OTP' || isRegisterCommand || hasVehicleAttributes))
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
            session.onboardingStage = null;
            customReply = `Vehicle onboarding cancelled. ${hasVehicleRegistered ? "You are back in active menu mode." : "Type **'Register'** whenever you're ready!"}`;
          } else if (/^(reset|restart|start over)$/i.test(cleanText)) {
            onboardingStore.set(senderPhone, {
              stage: 1,
              step: 1,
              core: { plate_number: null, make_model: null, yom: null, owner_email: profileData?.email || null, fuel_type: null, current_mileage: null, vin: null, email_verified: false },
              optional: { engine_number: null, color: null, transmission: null, tire_size: null, insurance_policy: null, insurance_expiry: null, inspection_expiry: null, purchase_cost: null, custom_attributes: {} },
              registered_plate: null,
              token: null,
              role: 'Owner',
              plate_number: null,
              make_model: null
            });
            session.onboardingStep = 1;
            session.onboardingStage = 1;
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
              stage: 1,
              step: 1,
              core: {
                plate_number: null,
                make_model: null,
                yom: null,
                owner_email: profileData?.email || null,
                fuel_type: null,
                current_mileage: null,
                vin: null,
                email_verified: false
              },
              optional: {
                engine_number: null,
                color: null,
                transmission: null,
                tire_size: null,
                insurance_policy: null,
                insurance_expiry: null,
                inspection_expiry: null,
                purchase_cost: null,
                custom_attributes: {}
              },
              registered_plate: null,
              token: null,
              role: 'Owner',
              plate_number: null,
              make_model: null
            };
            onboardingStore.set(senderPhone, obState);

            const isFeedbackOrUnrelated = checkIsConversationalFeedback(messageText, obState.step);

            if (isFeedbackOrUnrelated) {
              if (obState.stage === 2) {
                customReply = `I noticed your message ("${messageText.trim()}").\n\nYou can optionally share specs like insurance expiry, VIN, transmission, or simply reply **'Skip'** or **'Done'** to finish.`;
              } else if (!obState.core.plate_number) {
                customReply = `I noticed your message. If you want to cancel, reply **'cancel'**.\n\nOtherwise, please reply with your vehicle's registration plate number (e.g. *KDA 123A*).`;
              } else {
                customReply = `I noticed your message ("${messageText.trim()}").\n\nIf you want to restart or cancel onboarding, reply **'reset'** or **'cancel'**.\nOtherwise, please share your vehicle's details (e.g. *"1991 diesel 80 series, mileage 366700, email user@mail.com"*).`;
              }
            } else if (obState.stage === 2) {
              customReply = await handleStage2OptionalWeaving({
                obState,
                mergedExt,
                messageText,
                senderPhone,
                session,
                countryInfo,
                supabaseClient
              });
            } else {
              customReply = await handleStage1CoreCapture({
                obState,
                mergedExt,
                messageText,
                senderPhone,
                session,
                profileData,
                countryInfo,
                supabaseClient,
                formattedPhone
              });
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
              if (/\b(?:fuel\s+consumption|fuel\s+efficiency|km\/l|km\s*per\s*liter|consumption|mpg)\b/i.test(messageText)) {
                activeIntent = 'QUERY_FUEL_EFFICIENCY';
              } else if (/^(?:switch|manage|select)\s+/i.test(messageText)) {
                activeIntent = 'SWITCH_VEHICLE';
              } else if (/odometer|km|mileage/i.test(messageText)) {
                activeIntent = 'UPDATE_MILEAGE';
              } else if (/fuel|kes|usd|spent|cost|paid|expense|liters/i.test(messageText)) {
                activeIntent = 'LOG_EXPENSE';
              } else if (/earned|revenue|earnings|income|fare/i.test(messageText)) {
                activeIntent = 'LOG_EARNINGS';
              } else {
                activeIntent = 'GENERAL_CHAT';
              }
            } else {
              const userTierKey = profileData?.subscription_tier || 'free';
              const currentTier = SUBSCRIPTION_TIERS[userTierKey] || SUBSCRIPTION_TIERS.free;
              const ownedVehicles = existingVehicles.filter(v => v.owner_id === profileData?.id);
              if (ownedVehicles.length >= currentTier.vehicleLimit) {
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
              } else {
                const initPlate = mergedExt.plate_number ? mergedExt.plate_number.toUpperCase().trim() : null;
                onboardingStore.set(senderPhone, {
                  stage: 1,
                  step: initPlate ? 2 : 1,
                  core: {
                    plate_number: initPlate,
                    make_model: null,
                    yom: null,
                    owner_email: profileData?.email || null,
                    fuel_type: null,
                    current_mileage: null,
                    vin: null,
                    email_verified: false
                  },
                  optional: {
                    engine_number: null,
                    color: null,
                    transmission: null,
                    tire_size: null,
                    insurance_policy: null,
                    insurance_expiry: null,
                    inspection_expiry: null,
                    purchase_cost: null,
                    custom_attributes: {}
                  },
                  registered_plate: null,
                  token: null,
                  role: 'Owner',
                  plate_number: initPlate,
                  make_model: null
                });
                session.state = 'ONBOARDING';
                session.onboardingStep = initPlate ? 2 : 1;
                session.onboardingStage = 1;
                if (initPlate) {
                  customReply = `🚘 *Stage 1 of 2 · Step 2 of 4: Vehicle Core Details* 📝\n\nGot registration plate *${initPlate}*!\n\nCould you share the **Make & Model**, **Year of Manufacture (YOM)**, **Fuel Type (Diesel/Petrol/Hybrid/EV)**, **Current Mileage**, and your **Email**?\n\n💡 *Tip:* Send them all together in one message (e.g. "1991 diesel 80 series, mileage 366700, email user@mail.com").\n\n_(Type *Cancel* to stop, or *Restart* to begin again.)_`;
                } else {
                  customReply = `🚘 *Stage 1 of 2 · Step 1 of 4: Vehicle Registration Plate*\n\nPlease reply with the registration plate number for your new vehicle (e.g. *KDA 123A* or *KBC 456X*).\n\n_(Type *Cancel* to stop.)_`;
                }
              }
            }
          }

          if (session.state === 'ACTIVE') {
            // Resolve active or target vehicle
            let targetVeh = null;
            if (mergedExt.plate_number) {
              targetVeh = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
            }
            if (!targetVeh && mergedExt.target_vehicle) {
              targetVeh = findVehicleByCandidate(existingVehicles, mergedExt.target_vehicle);
            }
            if (!targetVeh) {
              targetVeh = getActiveVehicle({ senderPhone, vehicles: existingVehicles, chatSessions }) || existingVehicles[0];
            }

            if (activeIntent === 'ASSIGN_DRIVER' || session.pendingDriverAssignment || /^(?:assign\s+driver|assign)\b/i.test(messageText)) {
              let assignTarget = targetVeh;
              if (mergedExt.plate_number) {
                const found = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
                if (found) assignTarget = found;
              } else if (session.pendingDriverAssignment) {
                const found = existingVehicles.find(v => v.id === session.pendingDriverAssignment.vehicleId);
                if (found) assignTarget = found;
              }

              if (!assignTarget) {
                customReply = `⚠️ I could not find that vehicle in your registered fleet.`;
                session.pendingDriverAssignment = null;
              } else {
                let driverPhone = mergedExt.driver_phone;
                const manualPhoneMatch = messageText.match(/(?:\+?254|0)[17]\d{8}|\+?\d{9,15}/);
                if (!driverPhone && manualPhoneMatch) {
                  driverPhone = manualPhoneMatch[0];
                }

                if (!driverPhone) {
                  session.pendingDriverAssignment = { vehicleId: assignTarget.id, plateNumber: assignTarget.plate_number };
                  customReply = `🚗 *Assign Driver to Vehicle*\n\n• Target Vehicle: *${assignTarget.plate_number}*\n\nPlease reply with the driver's WhatsApp phone number (e.g. *+254712345678*).\n\n_(Reply 'cancel' to abort)_`;
                } else {
                  session.pendingDriverAssignment = null;
                  const cleanDrvPhone = driverPhone.startsWith('+') ? driverPhone : `+${driverPhone.replace(/[^\d]/g, '')}`;
                  
                  let { data: drvProfile } = await supabaseClient
                    .from('profiles')
                    .select('*')
                    .eq('phone_number', cleanDrvPhone)
                    .maybeSingle();

                  if (!drvProfile) {
                    const { data: newDrv } = await supabaseClient
                      .from('profiles')
                      .insert([{
                        id: crypto.randomUUID(),
                        phone_number: cleanDrvPhone,
                        full_name: 'Fleet Driver',
                        is_active: true
                      }])
                      .select()
                      .single();
                    drvProfile = newDrv;
                  }

                  const assignRes = await assignDriverToVehicle({
                    vehicleId: assignTarget.id,
                    driverId: drvProfile.id,
                    supabase: supabaseClient
                  });

                  if (!assignRes.success) {
                    customReply = `❌ *Driver Assignment Blocked (Strict 1-to-1 Rule)*\n\n${assignRes.error}`;
                  } else {
                    customReply = `✅ *Driver Assigned Successfully!*\n\n• *Driver:* ${drvProfile.full_name || cleanDrvPhone} (${cleanDrvPhone})\n• *Vehicle:* ${assignTarget.plate_number}\n\n🔒 *Strict 1-to-1 Constraint:* This driver cannot be assigned to another vehicle while this assignment is active.`;
                  }
                }
              }
            }
            else if (activeIntent === 'UNASSIGN_DRIVER' || /^unassign\s+driver/i.test(messageText.trim()) || /^remove\s+driver/i.test(messageText.trim())) {
              let unassignTarget = targetVeh;
              if (mergedExt.plate_number) {
                const found = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
                if (found) unassignTarget = found;
              }

              if (!unassignTarget) {
                customReply = `⚠️ Could not identify the vehicle to unassign the driver from.`;
              } else {
                await unassignDriverFromVehicle({ vehicleId: unassignTarget.id, supabase: supabaseClient });
                customReply = `✅ Driver unassigned from vehicle *${unassignTarget.plate_number}*. Vehicle is now available for a new driver.`;
              }
            }
            else if (activeIntent === 'SWITCH_VEHICLE') {
              const candidate = mergedExt.target_vehicle || mergedExt.plate_number || messageText.replace(/^(?:switch(?:\s+to)?|manage|select)\s+(?:car|vehicle)?\s*/i, '').trim();
              const found = findVehicleByCandidate(existingVehicles, candidate);
              if (found) {
                setActiveVehicle({ senderPhone, vehicleId: found.id, chatSessions });
                targetVeh = found;
                customReply = `🔄 *Switched Active Vehicle!*\n\n` +
                  `Now managing: *${found.plate_number}* (${found.make_model || 'Vehicle'})\n` +
                  `• Fuel Type: ${found.fuel_type || 'Fuel'}\n` +
                  `• Current Odometer: ${(found.current_mileage || found.odometer_reading || 0).toLocaleString()} ${found.unit_system === 'imperial' ? 'mi' : 'km'}\n\n` +
                  `All subsequent fuel logs, mileage updates, and queries will automatically apply to this vehicle.`;
              } else {
                const vList = existingVehicles.map((v, i) => `${i + 1}️⃣ *${v.plate_number}* (${v.make_model || 'Vehicle'})`).join('\n');
                customReply = `⚠️ Could not find "${candidate}" in your fleet.\n\nYour registered vehicles:\n${vList}\n\nReply with a number or plate (e.g. *"switch to 1"* or *"switch to ${existingVehicles[0]?.plate_number}"*) to select.`;
              }
            }
            else if (activeIntent === 'QUERY_FUEL_EFFICIENCY') {
              const fuelAnalysis = await calculateFuelConsumption({
                supabase: supabaseClient,
                vehicleId: targetVeh?.id,
                plateNumber: mergedExt.plate_number || targetVeh?.plate_number,
                targetUnit: targetVeh?.unit_system || countryInfo.default_units
              });

              if (fuelAnalysis && fuelAnalysis.explanation) {
                customReply = fuelAnalysis.explanation;
                if (existingVehicles.length > 1) {
                  customReply += `\n\n📌 *(Vehicle: ${targetVeh.plate_number}. Type "switch to [plate]" to analyze another)*`;
                }
              } else {
                customReply = `Could not calculate fuel consumption for ${targetVeh?.plate_number || 'vehicle'}.`;
              }
            }
            else if (activeIntent === 'QUERY_FLEET_SUMMARY') {
              const summaryReport = await getVehicleSummaryReport({
                supabase: supabaseClient,
                vehicleId: targetVeh?.id,
                plateNumber: mergedExt.plate_number || targetVeh?.plate_number
              });
              if (summaryReport && summaryReport.explanation) {
                customReply = summaryReport.explanation;
              } else {
                customReply = `Could not retrieve summary for ${targetVeh?.plate_number}.`;
              }
            }
            else if (activeIntent === 'GREETING') {
              customReply = `Hello! 👋 Welcome back to Saka Fleet.\n\n` +
                `Currently managing: *${targetVeh?.plate_number || 'Fleet'}* (${targetVeh?.make_model || 'Vehicle'})\n\n` +
                `What would you like to do today?\n` +
                `1️⃣ Log Expense / Fuel\n` +
                `2️⃣ Update Odometer\n` +
                `3️⃣ Set Service Reminder\n` +
                `4️⃣ Log Earnings\n` +
                `5️⃣ View Reports & Summary`;
              if (existingVehicles.length > 1) {
                customReply += `\n\n*(You have ${existingVehicles.length} vehicles registered. Reply "switch to [plate]" to change car)*`;
              }
            }
            else if (activeIntent === 'LOG_EXPENSE') {
              const extAmount = mergedExt.amount || extractNumberFromText(messageText);
              const extLiters = mergedExt.fuel_liters || mergedExt.liters || null;
              const extOdo = mergedExt.odometer || mergedExt.current_mileage || extractOdometerFromText(messageText);
              const expType = mergedExt.expense_type || (/fuel|petrol|diesel|gas/i.test(messageText) ? 'Fuel' : 'Expense');

              if ((extAmount && extAmount > 0) || (extLiters && extLiters > 0)) {
                if (supabaseClient && targetVeh) {
                  await supabaseClient.from('expense_logs').insert([{
                    vehicle_id: targetVeh.id,
                    driver_id: profileData?.id,
                    expense_type: expType,
                    amount: extAmount || 0,
                    fuel_liters: extLiters || 0,
                    odometer_reading: extOdo || null,
                    notes: messageText.trim()
                  }]);

                  await supabaseClient.from('expenses').insert([{
                    plate: targetVeh.plate_number,
                    expense_type: expType,
                    amount: extAmount || 0,
                    liters: extLiters || 0,
                    odometer_reading: extOdo || null
                  }]).select().maybeSingle();

                  if (extOdo && extOdo > (targetVeh.current_mileage || 0)) {
                    await supabaseClient.from('vehicles').update({
                      current_mileage: extOdo,
                      odometer_reading: extOdo,
                      updated_at: new Date().toISOString()
                    }).eq('id', targetVeh.id);
                    targetVeh.current_mileage = extOdo;
                  }
                }

                customReply = `⛽ *Expense Logged Successfully!* 📝\n\n` +
                  `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})\n` +
                  `• *Category:* ${expType}\n` +
                  (extAmount ? `• *Amount:* ${countryInfo.currency} ${Number(extAmount).toLocaleString()}\n` : '') +
                  (extLiters ? `• *Volume:* ${extLiters} Liters\n` : '') +
                  (extOdo ? `• *Odometer:* ${Number(extOdo).toLocaleString()} km\n` : '') +
                  `\n✅ Saved to database under *${targetVeh.plate_number}*.`;
                if (existingVehicles.length > 1) {
                  customReply += `\n*(Active vehicle: ${targetVeh.plate_number}. Type "switch to [car]" to change)*`;
                }
              } else {
                customReply = `⛽ *Log Expense / Fuel for ${targetVeh.plate_number}*\n\nPlease reply with expense details. For example:\n• *"Logged 45L fuel at 368000 km for KES 8500"*\n• *"Oil change KES 5000"*`;
              }
            }
            else if (activeIntent === 'UPDATE_MILEAGE') {
              const extOdometer = mergedExt.odometer || mergedExt.current_mileage || extractOdometerFromText(messageText);
              if (extOdometer && extOdometer > 0) {
                if (supabaseClient && targetVeh) {
                  await supabaseClient.from('vehicles').update({
                    odometer_reading: extOdometer,
                    current_mileage: extOdometer,
                    updated_at: new Date().toISOString()
                  }).eq('id', targetVeh.id);
                  targetVeh.current_mileage = extOdometer;
                }
                customReply = `📈 *Odometer Updated!* 🚗\n\n` +
                  `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})\n` +
                  `• *New Odometer:* ${Number(extOdometer).toLocaleString()} ${targetVeh?.unit_system === 'imperial' ? 'mi' : 'km'}\n\n` +
                  `✅ Saved to database under *${targetVeh.plate_number}*!`;
                if (existingVehicles.length > 1) {
                  customReply += `\n*(Active vehicle: ${targetVeh.plate_number})*`;
                }
              } else {
                customReply = `📈 *Update Mileage / Odometer*\n\nPlease reply with your updated odometer reading (e.g. *"Odometer 45000 km"*).`;
              }
            }
            else if (activeIntent === 'LOG_EARNINGS') {
              const extAmount = mergedExt.amount || extractNumberFromText(messageText);
              if (extAmount && extAmount > 0) {
                if (supabaseClient && targetVeh) {
                  await supabaseClient.from('private_earnings').insert([{
                    vehicle_id: targetVeh.id,
                    revenue_amount: extAmount,
                    currency: countryInfo.currency,
                    logged_at: new Date().toISOString()
                  }]);
                }
                customReply = `💰 *Earnings Logged!* 🎉\n\n• *Vehicle:* *${targetVeh?.plate_number || 'Fleet'}*\n• *Revenue:* ${countryInfo.currency} ${Number(extAmount).toLocaleString()}\n\n✅ Recorded under *${targetVeh.plate_number}*!`;
                if (existingVehicles.length > 1) {
                  customReply += `\n*(Active vehicle: ${targetVeh.plate_number})*`;
                }
              } else {
                customReply = `💰 *Log Earnings*\n\nPlease reply with your revenue details (e.g. *"Earned KES 5000 today"*).`;
              }
            }
            else if (activeIntent === 'SET_REMINDER') {
              customReply = `🔔 *Set Service Reminder for ${targetVeh.plate_number}*\n\nPlease reply with your service reminder details. For example:\n• *"Remind oil change in 5000 km"* or *"Service due next Monday"*`;
            }
            else if (activeIntent === 'REQUEST_REPORT') {
              const summaryReport = await getVehicleSummaryReport({
                supabase: supabaseClient,
                vehicleId: targetVeh?.id,
                plateNumber: targetVeh?.plate_number
              });
              if (summaryReport && summaryReport.explanation) {
                customReply = summaryReport.explanation;
              } else {
                customReply = `📊 *Fleet Reports & Summary*\n\nYou have ${existingVehicles.length} active vehicle(s).\n\nType *"Send monthly report"* or *"View summary"* for a detailed statement.`;
              }
            }
            else if (activeIntent === 'MANAGE_VEHICLE' || activeIntent === 'LIST_VEHICLES') {
              const vehicleList = existingVehicles.map((v, i) => {
                const isActive = v.id === targetVeh?.id;
                return `${i + 1}️⃣ *${v.plate_number}* - ${v.make_model || 'Vehicle'} (${v.fuel_type || 'Fuel'}, ${(v.current_mileage || v.odometer_reading || 0).toLocaleString()} km)${isActive ? ' 👉 *(ACTIVE)*' : ''}`;
              }).join('\n');
              customReply = `🚗 *Your Registered Fleet:*\n\n${vehicleList}\n\n💡 *To switch active vehicle:* Reply *"switch to [plate]"* or *"switch to [number]"*!`;
            }
            else if (session.pendingEmailUpdate) {
              const cleanTrimmed = messageText.trim();
              const providedOtp = mergedExt.otp_code || (cleanTrimmed.match(/^\d{6}$/) ? cleanTrimmed : null);
              if (providedOtp && session.pendingEmailUpdate.code === providedOtp && Date.now() <= session.pendingEmailUpdate.expiresAt) {
                const newEmail = session.pendingEmailUpdate.newEmail;
                if (supabaseClient && profileData) {
                  await supabaseClient.from('profiles').update({
                    email: newEmail,
                    email_verified: true,
                    updated_at: new Date().toISOString()
                  }).eq('id', profileData.id);
                  await supabaseClient.from('vehicles').update({
                    owner_email: newEmail
                  }).eq('owner_id', profileData.id);
                }
                session.pendingEmailUpdate = null;
                customReply = `✅ *Email Successfully Verified & Updated!* 📧\n\nYour account and vehicle passbooks are now linked to **${newEmail}**.`;
              } else if (/^(cancel|exit|stop)$/i.test(cleanTrimmed)) {
                session.pendingEmailUpdate = null;
                customReply = `Email update cancelled. You are back in main menu mode.`;
              } else {
                customReply = `❌ *Invalid or Expired Verification Code*\n\nPlease check your inbox for **${session.pendingEmailUpdate.newEmail}** and reply with the 6-digit code, or reply **'cancel'** to abort.`;
              }
            }
            else if (activeIntent === 'UPDATE_EMAIL' || /^(update|change)\s+email\b/i.test(messageText.trim())) {
              const emailCandidate = mergedExt.owner_email || (messageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) ? messageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)[0] : null);
              if (emailCandidate) {
                const targetEmail = emailCandidate.toLowerCase().trim();
                const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
                session.pendingEmailUpdate = {
                  newEmail: targetEmail,
                  code: otpCode,
                  expiresAt: Date.now() + 10 * 60 * 1000
                };
                await sendEmailOtp(targetEmail, otpCode);
                customReply = `📧 *Email Verification Required*\n\nWe dispatched a 6-digit verification code to **${targetEmail}**.\n\nPlease reply with the 6-digit code to confirm and finalize updating your registered email.`;
              } else {
                customReply = `📧 *Update Email Address*\n\nPlease reply with your new email address (e.g. *"update email to user@example.com"*).`;
              }
            }
            else if (activeIntent === 'TRANSFER_PASSBOOK' || /^transfer\s+passbook\b/i.test(messageText.trim())) {
              if (supabaseClient) {
                const candidate = mergedExt.target_vehicle || mergedExt.plate_number || targetVeh?.plate_number;
                const initRes = await initiatePassbookTransfer({
                  fromPhone: senderPhone,
                  vehicleCandidate: candidate,
                  supabase: supabaseClient
                });

                if (initRes.success) {
                  session.transferFlow = { step: 2, transferId: initRes.transferId, vehicle: initRes.vehicle };
                  customReply = `🚗 *Passbook Transfer Initiation — ${initRes.vehicle.plate_number}* (${initRes.vehicle.make_model || 'Vehicle'})\n` +
                    `• VIN: \`${initRes.vehicle.vin}\`\n` +
                    `• Transfer Quota: ${initRes.isFreeTransfer ? "✅ Free Transfer (1 per calendar year)" : "💳 Transfer Fee: USD 3.00 equivalent"}\n\n` +
                    `👉 *Step 2 of 5: Buyer Details*\n` +
                    `Please reply with the new owner's:\n` +
                    `1. International WhatsApp Number (e.g. \`+254712345678\`)\n` +
                    `2. Email Address\n\n` +
                    `*(You can reply with both together: e.g. "+254712345678 buyer@gmail.com")*\n\n` +
                    `_(Reply 'cancel' at any time to abort)_`;
                } else {
                  customReply = `⚠️ ${initRes.error}`;
                }
              }
            }
            else if (activeIntent === 'APP_HELP' || activeIntent === 'ACTION_DISCOVERY') {
              customReply = generateRoleBasedActionDiscovery({
                profileData,
                vehicles: existingVehicles,
                senderPhone,
                targetVeh
              });
            }
            else {
              if (aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle')) {
                customReply = aiResult.reply_message;
              } else {
                customReply = `Hello! 👋 How can I help manage your fleet today?\n\n` +
                  `Currently managing: *${targetVeh?.plate_number || 'Fleet'}*\n\n` +
                  `1️⃣ *Log Expense / Fuel*\n` +
                  `2️⃣ *Update Mileage*\n` +
                  `3️⃣ *Set Service Reminder*\n` +
                  `4️⃣ *Log Earnings*\n` +
                  `5️⃣ *View Reports & Summary*\n\n` +
                  `Or ask me anything: *"What is my fuel consumption in km/l for ${targetVeh?.plate_number || 'my vehicle'}?"*`;
              }
            }
          }
        }

        // --- BRANCH C: UNREGISTERED / IDLE USER DEFAULT ---
        else {
          const clean = messageText.trim().toLowerCase();

          // 1. User asks to pause / stop
          if (/^(stop|pause|halt|quiet|exit|cancel)$/i.test(clean)) {
            customReply = `Understood! I'll pause here. Whenever you're ready or have questions about Saka Fleet, simply text me anytime! 👋`;
          }
          // 2. Conversational feedback / frustration / message looping detected
          else if (checkIsConversationalFeedback(messageText, 1) || /\b(many replies|lot of responses|too many messages|repeating|looping|frustrat|bot broken|why so many)\b/i.test(clean)) {
            if (supabaseClient) {
              try {
                await supabaseClient.from('chat_friction_logs').insert([{
                  user_phone: senderPhone,
                  session_id: senderPhone,
                  friction_type: 'LOOPING_PROMPTS',
                  transcript_snippet: `User reported loop/friction in idle state: "${messageText}"`
                }]);
              } catch {}
            }
            customReply = `I sincerely apologize for the message overload! Our system experienced a temporary messaging sync delay. I've paused the messages. If you need any assistance, text **'Support'** to reach our team at support@sakafleet.com, or send your vehicle registration plate (e.g. *KDA 123A*) whenever you're ready to onboard.`;
          }
          // 3. Swahili Greetings — first-time guide in Swahili tone
          else if (/^(habari|mambo|jambo|hujambo|salama)\b/i.test(clean)) {
            customReply = buildFirstTimeWelcome({ swahili: true });
          }
          // 4. English Greetings — first-time progressive guide
          else if (intent === 'GREETING') {
            customReply = buildFirstTimeWelcome();
          }
          // 5. General informational questions answered via DeepSeek
          else if (aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle')) {
            customReply = aiResult.reply_message;
          }
          // 6. Default Welcome Prompt
          else {
            customReply = buildFirstTimeWelcome();
          }
        }
        }
        }

        const sanitizedReply = customReply.trim();

        // State Machine Circuit Breaker Check: Track consecutive identical assistant prompts
        const normalizedReply = sanitizedReply.toLowerCase().replace(/\s+/g, ' ');
        const loopSig = (session.loopSignature || '').toLowerCase().replace(/\s+/g, ' ');

        if (loopSig && loopSig === normalizedReply) {
          // Same prompt again -> advance the strike counter
          session.consecutivePromptCount = (session.consecutivePromptCount || 1) + 1;
        } else {
          // A genuinely different prompt -> new loop signature
          session.loopSignature = sanitizedReply;
          session.lastAssistantPrompt = sanitizedReply;
          session.consecutivePromptCount = 1;
          if (session.circuitBreakerStage !== 'HARD_TRIP') session.circuitBreakerStage = null;
        }

        let finalReply = sanitizedReply;

        // Stage 1 (Soft Trip): Prompt repeated 3 times. Grace retry.
        if (session.consecutivePromptCount === 3) {
          session.circuitBreakerStage = 'SOFT_TRIP';
          finalReply = "I've hit a temporary snag processing this step. Kindly try again!";
          session.lastAssistantPrompt = finalReply;
          if (fastify?.log) fastify.log.warn(`[Circuit Breaker] SOFT TRIP for ${senderPhone}! Same assistant prompt repeated 3 times.`);
          if (supabaseClient) {
            try {
              await supabaseClient.from('chat_friction_logs').insert([{
                user_phone: senderPhone,
                session_id: senderPhone,
                friction_type: 'LOOPING_PROMPTS',
                transcript_snippet: `Circuit Breaker Soft Trip (Strike 3) for prompt: "${sanitizedReply}"`
              }]);
            } catch {}
          }
        } 
        // Stage 2 (Hard Trip): Prompt repeated 4 times. Support escalation.
        else if (session.consecutivePromptCount >= 4) {
          session.circuitBreakerStage = 'HARD_TRIP';
          if (fastify?.log) fastify.log.warn(`[Circuit Breaker] HARD TRIP for ${senderPhone}! Escalating to support.`);

          try {
            await sendSupportEscalationEmail({
              userPhone: senderPhone,
              userEmail: profileData?.email,
              userName: profileData?.full_name,
              subscriptionTier: profileData?.subscription_tier,
              issueParagraph: `[AUTOMATIC CIRCUIT BREAKER TRIPPED - HARD TRIP]\n\nThe assistant generated the exact same prompt 4 consecutive times without user state progression.\n\nRepeated Prompt:\n${sanitizedReply}\n\nLast User Input:\n${messageText}`,
              vehiclesList: existingVehicles
            });
            if (supabaseClient) {
              await supabaseClient.from('chat_friction_logs').insert([{
                user_phone: senderPhone,
                session_id: senderPhone,
                friction_type: 'SYSTEM_ERROR',
                transcript_snippet: `Circuit Breaker Hard Trip (Strike 4). Escalated to support. User input: "${messageText}"`
              }]);
            }
          } catch (escErr) {
            if (fastify?.log) fastify.log.error('Failed to dispatch circuit breaker escalation email:', escErr?.message);
          }

          finalReply = "I've hit a temporary snag processing this step. I have notified our support team at support@sakafleet.com, and we will update you right here on WhatsApp once this is resolved!";
          session.lastAssistantPrompt = finalReply;
        }

        session.history.push({ role: 'user', parts: [{ text: messageText }] });
        session.history.push({ role: 'model', parts: [{ text: finalReply }] });
        if (session.history.length > 20) session.history = session.history.slice(-20);
        chatSessions.set(senderPhone, session);

        await sendWhatsAppReply(senderPhone, finalReply);
        if (supabaseClient) {
          await logChatTranscript(supabaseClient, senderPhone, 'assistant', finalReply);
          await saveChatMessage(supabaseClient, senderPhone, 'assistant', finalReply);
        }

        return { status: 'success' };
      } catch (err) {
        if (fastify?.log) fastify.log.error(err);
        return { status: 'error', error: err?.message };
      }
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
