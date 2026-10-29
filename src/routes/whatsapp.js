import crypto from 'crypto';
import { handleSuperadminFlow, isSuperadminPhone } from '../services/superadmin.js';
import { processSakaMessage, extractVehicleAttributes, classifyIntentWithRegex } from '../../sakaAi.js';
import { logChatTranscript, logSystemError } from '../workers/sentinel.js';
import { SUBSCRIPTION_TIERS, initializePaystackCheckout } from '../services/paystack.js';
import {
  ensureVehicleTableColumns,
  unassignDriverFromVehicle,
  checkOwnerVehicleTierLimit,
  getActiveVehicle,
  setActiveVehicle,
  findVehicleByCandidate,
  updateVehicleDetails,
  deleteVehicle,
  sanitizeVehicleUpdates
} from '../services/vehicles.js';
import { calculateFuelConsumption } from '../services/analytics.js';
import { buildFleetReport, resolveReportType } from '../services/fleetReports.js';
import {
  createDriverAssignment,
  verifyOwnerAssignmentOtp,
  cancelPendingAssignment,
  handleDriverResponse,
  canManageVehicle,
  getDriverComplianceStatus,
  getActiveAssignment,
  submitDriverCompliance,
  notifyOwnerComplianceCleared
} from '../services/driverAssignments.js';
import { resolveBundledCatalog, parseComplianceItem } from '../services/complianceCatalog.js';
import { handleStage1CoreCapture, handleStage2OptionalWeaving } from '../services/onboarding.js';
import { saveChatMessage, getRecentChatHistory } from '../services/chatHistory.js';
import { sendEmailOtp, sendSupportEscalationEmail, sendMfaEmail } from '../services/mailer.js';
import {
  initiatePassbookTransfer,
  setBuyerDetailsAndSendReleaseOtp,
  verifyOwnerReleaseOtpAndNotifyBuyer,
  handleBuyerAcceptance,
  completePassbookTransfer
} from '../services/transfers.js';
import { applyTrialExtensionCoupon } from '../services/coupons.js';
import { detectCountryFromPhone as detectCountryGlobal, resolveUserTimezone } from '../services/globalization.js';
import { applyOdometerReading, applyOperatingHours } from '../services/maintenanceReminders.js';
import { handleQuizTurn, detectQuizStart, shouldPauseQuizForChat, getCurrentQuizField, detectFlowSwitch, getFlowDefinition } from '../services/quizEngine.js';
import { renderActionDiscovery, composeMessage } from '../services/conversationEngine.js';
import { enqueueUserMessage } from '../services/messageQueue.js';
import { loadSessionSnapshot, persistSessionSnapshot } from '../services/sessionStore.js';
import { createResilientClient } from '../services/supabaseClient.js';
import { ocrWhatsAppMedia, extractReceiptHints } from '../services/ocrService.js';

let supabaseClient = createResilientClient();

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
  // Single source of truth: src/services/globalization.js
  return detectCountryGlobal(phone);
}

export function detectMessageLanguage(text = '') {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return 'English';
  const score = (kwList) => kwList.reduce((n, kw) => n + (t.includes(kw) ? 1 : 0), 0);

  const swahili = score(['habari', 'mambo', 'jambo', 'hujambo', 'salama', 'nataka', 'tafadhali', 'asante', 'magari', 'gari', 'mafuta', 'karibu', 'sawa', 'niko', 'wewe', 'nini', 'vipi']);
  const french = score(['bonjour', 'salut', 'merci', 'voiture', 'véhicule', 'carburant', 'kilométrage', 'kilometrage', 'oui', 'besoin', 'comment', 'pouvez', 'svp', 'combien']);
  const spanish = score(['hola', 'gracias', 'por favor', 'coche', 'vehículo', 'vehiculo', 'combustible', 'kilometraje', 'necesito', 'cómo', 'como', 'quiero', 'cuánto', 'cuanto']);
  const german = score(['hallo', 'danke', 'bitte', 'auto', 'fahrzeug', 'kraftstoff', 'kilometerstand', 'brauche', 'wie', 'was', 'möchte', 'mochte']);
  const arabic = score(['مرحبا', 'شكرا', 'سيارة', 'وقود', 'أريد', 'كم', 'مسافة']);

  const best = Object.entries({ Swahili: swahili, French: french, Spanish: spanish, German: german, Arabic: arabic })
    .sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : 'English';
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
/**
 * Role-aware command index consumed by the AI action-discovery renderer.
 * The AI writes the prose; this function owns the permissions.
 */
export function buildRoleContext(profileData, vehicles = [], senderPhone = '') {
  const roles = [];
  if (isSuperadminPhone(senderPhone)) roles.push('Superadmin');
  if (profileData?.id && vehicles.some((v) => v.owner_id === profileData.id)) roles.push('Owner');
  if (profileData?.id && vehicles.some((v) => v.assigned_driver_id === profileData.id)) roles.push('Driver');
  if (roles.length === 0) roles.push('Unregistered');

  const commands = [];
  if (roles.includes('Superadmin')) {
    commands.push('admin report', 'admin audit <plate or VIN>', 'admin alerts', 'adminrules', 'admin sentinel diagnose', 'adminstart / adminstop');
  }
  if (roles.includes('Owner')) {
    commands.push('register vehicle', 'my vehicles', 'switch vehicle', 'log expense', 'log earnings', 'update odometer',
      'assign driver', 'unassign driver', 'transfer passbook', 'set reminder', 'request report', 'edit vehicle', 'delete vehicle');
  }
  if (roles.includes('Driver')) {
    commands.push('update odometer', 'log expense', 'log earnings', 'set reminder', 'passbook details');
  }
  if (roles.includes('Unregistered')) {
    commands.push('register vehicle', 'accept passbook transfer', 'help');
  }

  return { roles, commands };
}

export async function renderRoleActions({ profileData, vehicles, senderPhone, language, countryInfo }) {
  const { roles, commands } = buildRoleContext(profileData, vehicles, senderPhone);
  return renderActionDiscovery({
    roles,
    commands,
    vehicles,
    language,
    countryInfo,
    profile: profileData
  });
}

export function buildFirstTimeWelcome({ swahili = false, countryInfo = null, senderPhone = null } = {}) {
  const region = countryInfo || (senderPhone ? detectCountryFromPhone(senderPhone) : null) || detectCountryFromPhone(null);
  const plateExample = region.plate_example || 'ABC 1234';
  const isImperial = (region.default_units || 'metric') === 'imperial';
  const mileageHint = isImperial ? 'current mileage in miles' : 'current mileage in km';
  const unitLabel = isImperial ? 'miles/gallons' : 'km/liters';

  const opener = swahili
    ? '👋 *Habari! Karibu Saka Fleet!* 🚗'
    : '👋 *Welcome to Saka Fleet!* 🚗';
  return `${opener}\n\n` +
    `Saka tracks your vehicles, fuel, expenses, compliance & maintenance right here on WhatsApp.\n\n` +
    `🚀 *Your First-Time Setup (about 2 minutes):*\n` +
    `1️⃣ Reply with your plate number (e.g. *${plateExample}*) — or type *Register*.\n` +
    `2️⃣ Send Make & Model, Year, Fuel Type and ${mileageHint}.\n` +
    `3️⃣ Verify your email with the 6-digit code we send you.\n` +
    `4️⃣ Receive your VIN-locked digital passbook instantly. 🎉\n\n` +
    `🌍 *Region:* ${region.country} (${region.country_code}) · ${unitLabel} · ${region.currency}\n\n` +
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
      `💡 *Fleet Management:* You also have full access to owner and driver tools for personal vehicles.` +
      (isOwner ? `\n\n👑 *Your Owner Tools (${activePlate}):* my vehicles · switch to [plate] · register · assign driver [phone] to [plate]` : '') +
      (isDriver ? `\n\n🚙 *Your Driver Tools (${activePlate}):* Odometer [km] · Logged [L] fuel · Earned [amount] today` : '');
  }

  if (isOwner && isDriver) {
    return `👑 *Saka Fleet — Owner & Driver Command Center*\n` +
      `Active Vehicle: *${activePlate}*\n\n` +
      `🚗 *Fleet & Passbook (Owner):*\n` +
      `• \`my vehicles\` — View all registered vehicles\n` +
      `• \`switch to [plate]\` — Change active vehicle\n` +
      `• \`register\` — Add a new vehicle slot\n` +
      `• \`transfer passbook [plate]\` — Securely hand over passbook to buyer\n` +
      `• \`assign driver [phone] to [plate]\` — Assign driver (Strict 1-to-1)\n` +
      `• \`edit vehicle [plate]\` — Update details (VIN stays locked)\n` +
      `• \`delete vehicle [plate]\` — Remove vehicle (logs preserved)\n` +
      `• \`edit profile\` — Update your name, language & units\n\n` +
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
      `🛠️ *Edits & Deletion:*\n` +
      `• \`edit vehicle [plate]\` — Update vehicle details (VIN stays permanently locked)\n` +
      `• \`delete vehicle [plate]\` — Remove vehicle (logs preserved, driver unassigned)\n` +
      `• \`edit profile\` — Update your name, language & units\n` +
      `• \`delete my account\` — Deactivate your account\n\n` +
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
      `• \`passbook details\` — View compliance & insurance dates\n` +
      `• \`edit profile\` — Update your name, language & units\n\n` +
      `💡 *Note:* Driver submissions automatically update fleet records and notify your owner.`;
  }

  return buildFirstTimeWelcome({ senderPhone });
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

    // 1. Fast in-memory idempotency check (sub-millisecond). The distributed
    //    Supabase claim now runs in the background queue, so the 200 OK is
    //    never blocked on database I/O.
    if (wamid && isMessageProcessed(wamid)) {
      if (fastify?.log) fastify.log.warn(`[Deduplication] Message ${wamid} already processed (memory). Aborting Meta retry.`);
      return reply.status(200).send({ status: 'success', deduplicated: true });
    }

    // 2. Immediate Fastify 200 OK Response (Eliminates Meta Webhook Timeout & Retries)
    if (reply && typeof reply.status === 'function') {
      reply.status(200).send({ status: 'success' });
    }

    // 3. Per-phone serial queue + global concurrency cap + retry/backoff.
    //    The wamid is claimed once inside the queued task (cross-instance
    //    dedup); retries re-run processing without re-claiming.
    let claimed = false;
    return enqueueUserMessage(senderPhone, async () => {
      if (!claimed) {
        const alreadyProcessed = await checkAndRecordWamid(supabaseClient, wamid, senderPhone);
        if (alreadyProcessed) {
          if (fastify?.log) fastify.log.warn(`[Deduplication] Message ${wamid} already processed. Aborting Meta retry.`);
          return { status: 'success', deduplicated: true };
        }
        claimed = true;
      }
      return processIncomingWhatsAppMessage({ messageObj, fastify, supabaseClient });
    })
      .catch(async (err) => {
        if (fastify?.log) fastify.log.error({ err }, 'WhatsApp background processing failed');
        await logSystemError(supabaseClient, err, '/webhook/whatsapp').catch(() => {});
        return { status: 'error', error: err?.message };
      });
  }

  return reply.status(404).send({ error: 'Not Found' });
}

export async function processIncomingWhatsAppMessage({ messageObj, fastify, supabaseClient }) {
  const sessionPhone = messageObj?.from || '';
  const formattedPhoneForSession = sessionPhone.startsWith('+') ? sessionPhone : `+${sessionPhone.replace(/[^\d]/g, '')}`;
  const persistSnap = async () => {
    if (!supabaseClient || !sessionPhone) return;
    try {
      await persistSessionSnapshot(supabaseClient, formattedPhoneForSession, {
        session: chatSessions.get(sessionPhone) || null,
        onboarding: onboardingStore.get(sessionPhone) || null
      });
    } catch {}
  };
  // Overlaps the two user-log writes with AI processing; awaited before the
  // assistant log so transcript ordering stays correct.
  let userLogPromise = Promise.resolve();

  try {
    const senderPhone = messageObj.from;

    // --- MEDIA / OCR INGESTION (parallel with durable session hydration) ------
    // WhatsApp photos and documents carry no `.text`. Download them from Meta,
    // OCR with Google Cloud Vision, and treat the extracted text as the turn.
    const imageObj = messageObj.image || null;
    const documentObj = messageObj.document || null;
    const mediaObj = imageObj || documentObj;
    const mediaCaption = (imageObj?.caption || documentObj?.caption || '').trim();
    const mediaMimeType = imageObj?.mime_type || documentObj?.mime_type || null;

    // OCR and session hydration are independent and side-effect free: run them
    // together so media turns do not pay two serial round trips.
    const ocrPromise = mediaObj?.id
      ? ocrWhatsAppMedia({
          mediaId: mediaObj.id,
          mimeType: mediaMimeType,
          token: process.env.META_WHATSAPP_TOKEN
        }).catch((err) => ({ text: '', error: err?.message || 'ocr_failed' }))
      : Promise.resolve({ text: '', error: null });

    // Durable session hydration — restores quiz/onboarding/OTP state from
    // Supabase so any Cloud Run instance can continue the conversation.
    const hydrationPromise = supabaseClient
      ? loadSessionSnapshot(supabaseClient, formattedPhoneForSession).catch(() => null)
      : Promise.resolve(null);

    const [ocrResult, snapshot] = await Promise.all([ocrPromise, hydrationPromise]);
    const ocrText = (ocrResult?.text || '').trim();
    const ocrError = ocrResult?.error || null;
    if (ocrError) console.warn('[OCR] Media could not be read:', ocrError);

    const baseText = messageObj.text?.body || mediaCaption || '';
    let messageText = baseText;
    if (ocrText) {
      messageText = `${baseText ? `${baseText}\n\n` : ''}${ocrText}`.slice(0, 4000);
    } else if (mediaObj && !baseText) {
      messageText = '[Saka system note: the user sent an image/document that could not be read by OCR. Apologize briefly in their language, do not claim anything was saved, and ask them to resend a clearer photo or type the details.]';
    }

    const receiptHints = ocrText ? extractReceiptHints(ocrText) : {};

    if (snapshot) {
      if (snapshot.session && !chatSessions.has(senderPhone)) chatSessions.set(senderPhone, snapshot.session);
      if (snapshot.onboarding && !onboardingStore.has(senderPhone)) onboardingStore.set(senderPhone, snapshot.onboarding);
    }

    if (fastify?.log) fastify.log.info(`Incoming WhatsApp message from ${senderPhone}: "${messageText}"`);
    if (supabaseClient) {
      userLogPromise = Promise.all([
        logChatTranscript(supabaseClient, senderPhone, 'user', messageText),
        saveChatMessage(supabaseClient, senderPhone, 'user', messageText)
      ]).catch(() => {});
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
        await userLogPromise;
        await persistSnap();
        return { status: 'superadmin_handled' };
      }
    }

    let session = chatSessions.get(senderPhone) || { history: [], lastActive: Date.now() };
    session.lastActive = Date.now();

    // Circuit Breaker State Check & Reset on user navigation commands
    const cleanCmd = messageText.trim().toLowerCase();
    if (/^(cancel|exit|stop|reset|restart|start over|start again|1|2|3|4|5)$/i.test(cleanCmd) || /^(log|update|set|request|help)/i.test(cleanCmd)) {
      session.circuitBreakerStage = null;
      session.consecutivePromptCount = 0;
      session.lastAssistantPrompt = null;
      session.loopSignature = null;
    } else if (session.circuitBreakerStage === 'HARD_TRIP') {
      // Circuit breaker is in hard trip: bypass DeepSeek and send a short,
      // AI-rendered recovery message (deterministic fallback if AI is down).
      const fallbackReply = "⚠️ I've paused automated replies for this step. Type Restart to begin again, or contact support@sakafleet.com — we will update you here once resolved.";
      const recoveryReply = await composeMessage({
        purpose: 'circuit_breaker_recovery',
        facts: {
          reason: 'Repeated identical assistant prompt detected',
          nextSteps: ['Type Restart to begin again', 'Type Cancel to exit', 'Email support@sakafleet.com'],
          supportEmail: 'support@sakafleet.com'
        },
        fallbackText: fallbackReply
      });
      await sendWhatsAppReply(senderPhone, recoveryReply);
      if (supabaseClient) {
        try {
          await supabaseClient.from('chat_transcripts').insert([{ phone_number: senderPhone, sender: 'assistant', message_text: recoveryReply }]);
          await supabaseClient.from('chat_history').insert([{ user_phone: senderPhone, role: 'assistant', message: recoveryReply }]);
        } catch {}
      }
      await userLogPromise;
      await persistSnap();
      return { status: 'circuit_breaker_active' };
    }

        const formattedPhone = formattedPhoneForSession;
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
        let dbHistory = [];
        if (supabaseClient && profileData) {
          // Parallel reads + skip the history query entirely on warm sessions.
          const needHistory = !session.history || session.history.length === 0;
          const [vehiclesRes, historyRes] = await Promise.all([
            supabaseClient
              .from('vehicles')
              .select('*')
              .is('deleted_at', null)
              .or(`owner_id.eq.${profileData.id},assigned_driver_id.eq.${profileData.id}`),
            needHistory ? getRecentChatHistory(supabaseClient, senderPhone, 10) : Promise.resolve([])
          ]);
          existingVehicles = vehiclesRes?.data || [];
          dbHistory = historyRes || [];
        }

        const hasVehicleRegistered = existingVehicles.length > 0;
        const messageLang = detectMessageLanguage(messageText);
        const targetLang = messageLang !== 'English' ? messageLang : (profileData?.preferred_language || 'English');
        if (messageLang !== 'English' && profileData && messageLang !== profileData.preferred_language && supabaseClient) {
          try {
            await supabaseClient.from('profiles').update({ preferred_language: messageLang }).eq('id', profileData.id);
            profileData.preferred_language = messageLang;
          } catch {}
        }

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
        if (conversationHistory.length === 0 && dbHistory.length > 0) {
          conversationHistory = dbHistory;
        }

        // Pass message through DeepSeek Intent Classifier (sakaAi.js) with Active Fleet Context
        const activeVehicleContext = hasVehicleRegistered ? {
          activeVehicle: currentActiveVehicle,
          allVehicles: existingVehicles
        } : null;

        // Speed fast-path: an active quiz already owns the conversation state.
        // Skip the DeepSeek intent call — regex classification is instant and
        // the quiz's deterministic parsers handle the answer. This removes the
        // duplicate AI call that previously ran on every quiz turn.
        const quizForFastPath = session.quiz || null;
        const quizPhaseLocked = !!quizForFastPath && (quizForFastPath.phase === 'pin' || quizForFastPath.phase === 'account_otp');
        const fastQuizTurn = !!quizForFastPath && !quizPhaseLocked;

        let aiResult;
        if (fastQuizTurn) {
          const quick = classifyIntentWithRegex(messageText);
          aiResult = { intent: quick.intent, extracted_data: {}, reply_message: null };
        } else {
          aiResult = await processSakaMessage(targetLang, messageText, conversationHistory, [], supabaseClient, activeVehicleContext);
        }
        let intent = aiResult.intent;
        let customReply = aiResult.reply_message;

        // Extract and merge structured vehicle attributes
        const regexAttrs = extractVehicleAttributes(messageText);
        const mergedExt = {
          ...regexAttrs,
          ...(aiResult.extracted_data || {})
        };

        // OCR receipt hints prefill the quiz when AI/regex did not capture them
        for (const [hintKey, hintValue] of Object.entries(receiptHints)) {
          if (hintValue === null || hintValue === undefined || hintValue === '') continue;
          if (mergedExt[hintKey] === null || mergedExt[hintKey] === undefined || mergedExt[hintKey] === '') {
            mergedExt[hintKey] = hintValue;
          }
        }

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
          /\b(support|human|agent|representative|talk to a person|admin intervention|file a complaint|escalat(e|ion)|dispute|help from human|talk to support|contact support|human help|customer care)\b/i.test(messageText)
        ) {
          isSupportFlow = true;
          session.pendingSupportEscalation = true;
          customReply = await composeMessage({
            purpose: 'support_intake',
            facts: {
              instruction: 'Ask the user to describe the issue in one message so it can be forwarded to support.',
              supportEmail: 'support@sakafleet.com'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: 'Please describe your issue in one message and I will forward it to support@sakafleet.com.'
          });
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
        // 2. Buyer Acceptance ("ACCEPT") / Driver Assignment Response
        else if (/^\s*(accept|decline|reject|claim passbook|claim ownership)\b/i.test(messageText)) {
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
            } else if (/^\s*(accept|decline|reject)\b/i.test(messageText.trim())) {
              const driverRes = await handleDriverResponse({
                driverPhone: senderPhone,
                response: /^\s*accept/i.test(messageText.trim()) ? 'ACCEPT' : 'DECLINE',
                supabase: supabaseClient,
                sendWhatsAppFn: sendWhatsAppReply,
                countryInfo
              });
              if (driverRes) {
                isSpecialFlowHandled = true;
                if (driverRes.status === 'ACCEPTED') {
                  session.driverOnboarding = !driverRes.compliance?.canManage;
                  session.active_vehicle_id = driverRes.vehicle?.id || session.active_vehicle_id;
                }
                customReply = driverRes.replyMessage;
              }
            }
          }
        }
        // 2b. Owner driver-assignment OTP (legacy command path)
        else if (session.pendingAssignmentOtp && (
          /^\d{6}$/.test(messageText.trim()) ||
          /^(resend|resend code|new code|send again)$/i.test(messageText.trim()) ||
          /^(cancel|exit|stop)$/i.test(messageText.trim())
        )) {
          if (supabaseClient) {
            const clean = messageText.trim();
            if (/^(cancel|exit|stop)$/i.test(clean)) {
              await cancelPendingAssignment({
                supabase: supabaseClient,
                assignmentId: session.pendingAssignmentOtp.assignmentId,
                ownerId: profileData?.id
              });
              session.pendingAssignmentOtp = null;
              isSpecialFlowHandled = true;
              customReply = 'Driver assignment cancelled. No driver was notified.';
            } else if (/^(resend|resend code|new code|send again)$/i.test(clean)) {
              const vehicle = existingVehicles.find((v) => v.id === session.pendingAssignmentOtp.vehicleId) || targetVeh;
              const resent = await createDriverAssignment({
                supabase: supabaseClient,
                ownerProfile: profileData,
                vehicle,
                driverPhone: session.pendingAssignmentOtp.driverPhone,
                handoverOdometer: Number(vehicle?.current_mileage || vehicle?.odometer_reading || 0) || null,
                countryInfo,
                sendWhatsApp: sendWhatsAppReply
              });
              isSpecialFlowHandled = true;
              if (resent.ok) {
                session.pendingAssignmentOtp = {
                  assignmentId: resent.assignment.id,
                  vehicleId: resent.assignment.vehicle_id,
                  driverPhone: resent.driverPhone,
                  expiresAt: resent.expiresAt
                };
                customReply = '🔐 A fresh 6-digit code has been sent to your WhatsApp. Reply with it to continue.';
              } else {
                customReply = `❌ ${resent.error}`;
              }
            } else {
              const verified = await verifyOwnerAssignmentOtp({
                supabase: supabaseClient,
                assignmentId: session.pendingAssignmentOtp.assignmentId,
                ownerId: profileData?.id,
                code: clean,
                sendWhatsApp: sendWhatsAppReply
              });
              isSpecialFlowHandled = true;
              if (verified.ok) {
                session.pendingAssignmentOtp = null;
                customReply = `✅ *Assignment Verified*\n\nWe notified *${verified.driverPhone}* about *${verified.plate}*. They must reply *ACCEPT* to take over the vehicle.\n\nOnce they accept, Saka will guide them through email verification and their ${verified.vehicle?.asset_type ? 'compliance details' : 'driving licence'} before they can manage it.`;
              } else {
                if (verified.cancelled || verified.expired) session.pendingAssignmentOtp = null;
                customReply = `❌ ${verified.error}`;
              }
            }
          }
        }
        // 3. Buyer Email OTP Verification (Step 5)
        else if (session.pendingTransferBuyerOtp || (messageText.trim().match(/^\d{6}$/) && !session.quiz && !isCurrentlyOnboarding && !session.pendingEmailUpdate && !session.pendingDeleteVehicle && !session.pendingAccountDeletion && !onboardingStore.has(senderPhone))) {
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
        else if (!session.quiz && !session.pendingDeleteVehicle && !session.pendingAccountDeletion && (intent === 'APPLY_COUPON' || /^(yes|yes please|apply coupon|extend trial|extend)$/i.test(messageText.trim()) || /^EXT30-[A-Z0-9]+$/i.test(messageText.trim()))) {
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
        // 5. Action Discovery & Role Help (AI-rendered from the role index)
        else if (!session.quiz && (intent === 'ACTION_DISCOVERY' || intent === 'APP_HELP' || /\b(?:what\s+can\s+i\s+do|show\s+my\s+actions|my\s+actions|show\s+actions|what\s+are\s+my\s+commands|available\s+commands)\b/i.test(messageText.trim()))) {
          isSpecialFlowHandled = true;
          customReply = await renderRoleActions({
            profileData,
            vehicles: existingVehicles,
            senderPhone,
            language: targetLang,
            countryInfo
          });
        }

        // A driver can add or refresh any compliance item from chat at any
        // time ("PSV badge 445566 expires 15 Dec 2028"). This is how Saka keeps
        // collecting optional extras after the gate has opened.
        if (!isSpecialFlowHandled && !session.quiz && supabaseClient && profileData?.id
          && /\b(licen[cs]e|psv|cpc|cdl|pdp|permit|operator|card|badge|dl|compliance)\b/i.test(messageText)
          && /\d/.test(messageText)) {
          const assignedVehicle = existingVehicles.find((v) => v.assigned_driver_id === profileData.id) || null;
          if (assignedVehicle) {
            const assetType = assignedVehicle.asset_type || assignedVehicle.metadata?.asset_type || null;
            const catalog = resolveBundledCatalog({ countryCode: countryInfo?.country_code, assetType });
            const lower = messageText.toLowerCase();
            const item = [catalog.minimal, ...(catalog.additional || [])].find((entry) =>
              lower.includes(entry.type.replace(/_/g, ' ')) ||
              (entry.aliases || []).some((alias) => lower.includes(alias)) ||
              lower.includes(entry.label.toLowerCase())
            );
            if (item) {
              const timeZone = resolveUserTimezone({ countryInfo, profile: profileData });
              const parsed = parseComplianceItem(messageText, {
                countryCode: countryInfo?.country_code || 'GLOBAL',
                locale: countryInfo?.locale || 'en-US',
                timeZone,
                catalogItem: item
              });
              if (parsed?.ok) {
                const isMinimal = item.type === catalog.minimal.type;
                const result = await submitDriverCompliance({
                  supabase: supabaseClient,
                  driverId: profileData.id,
                  item,
                  parsed,
                  isMinimal,
                  countryCode: countryInfo?.country_code || 'GLOBAL',
                  assetType,
                  timeZone
                });
                isSpecialFlowHandled = true;
                if (result.ok) {
                  if (isMinimal) {
                    const status = await getDriverComplianceStatus({ supabase: supabaseClient, driverId: profileData.id, assetType });
                    const assignment = await getActiveAssignment({ supabase: supabaseClient, driverId: profileData.id, vehicleId: assignedVehicle.id });
                    if (status.canManage && assignment) {
                      await notifyOwnerComplianceCleared({ supabase: supabaseClient, assignment, status });
                    }
                  }
                  customReply = `✅ *Compliance Saved*\n\n• ${item.label}: ${parsed.number} — ${parsed.lifetime ? 'valid for life' : `expires ${parsed.expiry}`}\n\nWe'll remind you before it expires.`;
                } else {
                  customReply = `❌ ${result.error}`;
                }
              }
            }
          }
        }

        if (!isSpecialFlowHandled) {

        // --- SAKA QUIZ ENGINE: one-piece-at-a-time flows + confirmation ---
        // Driver compliance gate: accepted drivers must verify their email and
        // submit a valid minimal compliance item before managing the vehicle.
        let driverGate = null;
        if (supabaseClient && profileData?.id && currentActiveVehicle?.assigned_driver_id === profileData.id) {
          try {
            driverGate = await canManageVehicle({ supabase: supabaseClient, profile: profileData, vehicle: currentActiveVehicle });
          } catch {
            driverGate = null;
          }
        }
        const VEHICLE_BOUND_INTENTS = new Set([
          'LOG_EXPENSE', 'LOG_EARNINGS', 'UPDATE_MILEAGE', 'LOG_OPERATING_HOURS',
          'SET_REMINDER', 'COMPLETE_REMINDER', 'EDIT_VEHICLE', 'DELETE_VEHICLE',
          'TRANSFER_PASSBOOK', 'QUERY_FLEET_SUMMARY', 'REQUEST_REPORT',
          'QUERY_FUEL_EFFICIENCY', 'MANAGE_VEHICLE', 'LIST_VEHICLES'
        ]);
        const gateRedirect = Boolean(driverGate?.gated) && VEHICLE_BOUND_INTENTS.has(intent);

        const quizStartFlow = detectQuizStart({
          intent,
          messageText,
          hasVehicleRegistered,
          isRegisterCommand,
          hasVehicleAttributes,
          driverOnboardingPending: session.driverOnboarding === true || gateRedirect
        });

        const quizCtx = {
          supabase: supabaseClient,
          profile: profileData,
          vehicles: existingVehicles,
          activeVehicle: currentActiveVehicle,
          countryInfo,
          senderPhone,
          formattedPhone,
          language: targetLang,
          intent,
          aiExtracted: mergedExt,
          messageText,
          fastQuiz: fastQuizTurn,
          driverGate,
          sendWhatsApp: sendWhatsAppReply
        };

        // Quiz ↔ Conversation arbitration — a greeting/question mid-quiz is
        // answered conversationally and the quiz resumes where it paused.
        const activeQuiz = session.quiz || null;
        const pauseQuizForChat = activeQuiz && shouldPauseQuizForChat({ messageText, intent, quiz: activeQuiz });
        const switchQuizFlow = activeQuiz && !pauseQuizForChat
          ? detectFlowSwitch({ quiz: activeQuiz, messageText, intent })
          : null;

        const buildPausedQuizReply = async (quizState) => {
          const isHelp = intent === 'ACTION_DISCOVERY' || intent === 'APP_HELP' ||
            /^(help|hint|what can i do|what do i do next|guide me)$/i.test(messageText.trim());

          const field = getCurrentQuizField(quizState, quizCtx);

          if (isHelp) {
            const discovery = await renderRoleActions({
              profileData,
              vehicles: existingVehicles,
              senderPhone,
              language: targetLang,
              countryInfo
            });
            if (!field) return discovery;
            const nudge = await composeMessage({
              purpose: 'quiz_resume_nudge',
              facts: {
                currentQuestion: field.label,
                questionHint: field.hint,
                instruction: 'In ONE short sentence, invite the user back to the pending question.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: `When you're ready: ${field.label} — ${field.hint}`
            });
            return `${discovery}\n\n${nudge}`;
          }

          // Single AI call: answer the interruption, then end with the pending
          // question exactly once (no duplicate questions).
          return composeMessage({
            purpose: 'quiz_pause_conversation',
            facts: {
              userMessage: messageText,
              quizFlow: quizState?.flow,
              collectedSoFar: quizState?.answers || {},
              pendingQuestion: field ? { label: field.label, hint: field.hint } : null,
              instruction: field
                ? 'Answer the user conversationally and helpfully, then end with EXACTLY ONE short sentence asking the pending question. Ask nothing else. Do not claim anything was saved.'
                : 'Answer the user conversationally and helpfully. Do not claim anything was saved.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: field
              ? `Happy to help.\n\nWhen you're ready: ${field.label} — ${field.hint}`
              : 'Happy to help — ask me anything about Saka Fleet.'
          });
        };

        let quizTurn = { handled: false };
        if (pauseQuizForChat) {
          isSpecialFlowHandled = true;
          customReply = await buildPausedQuizReply(activeQuiz);
        } else if (switchQuizFlow) {
          // The user explicitly asked for a different task mid-quiz. Discard the
          // current draft and start the requested flow (audit fix: "Set reminder"
          // must never be trapped inside the expense quiz).
          const previousLabel = getFlowDefinition(activeQuiz.flow, quizCtx)?.label || activeQuiz.flow;
          session.quiz = null;
          quizTurn = await handleQuizTurn({
            session,
            messageText,
            aiExtracted: mergedExt,
            startFlow: switchQuizFlow,
            ctx: quizCtx
          });

          if (quizTurn.handled) {
            const switchNote = await composeMessage({
              purpose: 'flow_switch',
              facts: {
                previousFlow: previousLabel,
                newFlow: switchQuizFlow,
                instruction: 'In ONE short sentence, tell the user the previous draft was discarded and the new task is starting.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: `Switched to ${switchQuizFlow}. Your previous draft was discarded.`
            });
            quizTurn.reply = `${switchNote}\n\n${quizTurn.reply}`;
          }
        } else {
          quizTurn = await handleQuizTurn({
            session,
            messageText,
            aiExtracted: mergedExt,
            startFlow: quizStartFlow,
            ctx: quizCtx
          });
        }

        if (quizTurn.pausedForChat) {
          isSpecialFlowHandled = true;
          customReply = await buildPausedQuizReply(session.quiz);
        } else if (quizTurn.handled) {
          isSpecialFlowHandled = true;
          const gateNotice = gateRedirect && !activeQuiz
            ? `🔒 *Finish your driver profile first*\n\nSaka needs to verify your email and your ${driverGate?.status?.catalog?.minimal?.label || 'driving licence'} so it can remind you before it expires. This protects you and the vehicle owner.\n\n`
            : '';
          customReply = `${gateNotice}${quizTurn.reply}`;

          if (quizTurn.flow === 'driver_onboarding' && quizTurn.completed) {
            session.driverOnboarding = false;
          }

          if (quizTurn.flow === 'vehicle_registration') {
            onboardingStore.delete(senderPhone);
            session.state = quizTurn.completed ? 'ACTIVE' : 'ONBOARDING';
            if (quizTurn.completed) session.onboardingStep = null;
          }

          if (quizTurn.completed && quizTurn.flow === 'delete_account') {
            session.state = 'IDLE';
            session.active_vehicle_id = null;
            session.history = [];
          }
        }

        // --- BRANCH A: TWO-STAGE PROGRESSIVE ONBOARDING FLOW (legacy fallback) ---
        if (!isSpecialFlowHandled && (
          isCurrentlyOnboarding ||
          (!hasVehicleRegistered && (intent === 'REGISTER_VEHICLE' || intent === 'ONBOARDING_INPUT' || intent === 'VERIFY_OTP' || isRegisterCommand || hasVehicleAttributes))
        )) {
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
              if (/^(?:delete|remove|discard|scrap|decommission)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText)) {
                activeIntent = 'DELETE_VEHICLE';
              } else if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText) ||
                         /^(?:edit|update|change|modify)\s+(?:the\s+)?(?:make|model|year|yom|fuel|color|colour|transmission|engine|tire|tyre|insurance|inspection|plate)\b/i.test(messageText)) {
                activeIntent = 'EDIT_VEHICLE';
              } else if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:profile|details|name|language|units?|unit\s+system|settings|contact)\b/i.test(messageText)) {
                activeIntent = 'EDIT_PROFILE';
              } else if (/^(?:delete|deactivate|close|remove)\s+(?:my\s+)?account\b/i.test(messageText)) {
                activeIntent = 'DELETE_ACCOUNT';
              } else if (/\b(?:fuel\s+consumption|fuel\s+efficiency|km\/l|km\s*per\s*liter|consumption|mpg)\b/i.test(messageText)) {
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

          if (!isSpecialFlowHandled && session.state === 'ACTIVE') {
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

            // Owner vehicle-deletion confirmation gate (must run before other intents)
            if (session.pendingDeleteVehicle) {
              const cleanConfirmation = messageText.trim().toLowerCase();
              const pendingDeletion = session.pendingDeleteVehicle;

              if (/^(yes|y|confirm|delete|proceed)$/i.test(cleanConfirmation)) {
                const deletionResult = await deleteVehicle({
                  vehicleId: pendingDeletion.vehicleId,
                  requesterId: profileData?.id,
                  supabase: supabaseClient
                });
                session.pendingDeleteVehicle = null;

                if (deletionResult.success) {
                  if (session.active_vehicle_id === pendingDeletion.vehicleId) {
                    session.active_vehicle_id = null;
                  }
                  const remaining = existingVehicles.filter(v => v.id !== pendingDeletion.vehicleId);
                  customReply = `🗑️ *Vehicle Deleted Successfully*\n\n` +
                    `• *Vehicle:* ${pendingDeletion.plateNumber}\n` +
                    `• *Driver:* ${deletionResult.cleanup?.driverUnassigned ? 'unassigned ✅' : 'none assigned'}\n` +
                    `• *Pending transfers:* ${deletionResult.cleanup?.transfersCancelled || 0} cancelled\n` +
                    `• *Historical logs:* preserved for audit 🔒\n` +
                    `• *VIN ledger:* retained (one trial per VIN forever) 🔒\n\n` +
                    (remaining.length > 0
                      ? `Remaining active vehicles: ${remaining.map(v => v.plate_number).join(', ')}`
                      : `You have no active vehicles left. Type *Register* to add a new vehicle.`);
                } else {
                  customReply = `❌ *Vehicle Deletion Failed*\n\n${deletionResult.error}`;
                }
              } else if (/^(cancel|exit|stop|no|abort)$/i.test(cleanConfirmation)) {
                session.pendingDeleteVehicle = null;
                customReply = `Deletion cancelled. *${pendingDeletion.plateNumber}* remains in your fleet.`;
              } else {
                customReply = `⚠️ Please reply *YES* to confirm deletion of *${pendingDeletion.plateNumber}*, or *Cancel* to abort.`;
              }
            }
            else if (activeIntent === 'ASSIGN_DRIVER' || session.pendingDriverAssignment || /^(?:assign\s+driver|assign)\b/i.test(messageText)) {
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
                  const created = await createDriverAssignment({
                    supabase: supabaseClient,
                    ownerProfile: profileData,
                    vehicle: assignTarget,
                    driverPhone,
                    handoverOdometer: Number(mergedExt.odometer || mergedExt.current_mileage || assignTarget.current_mileage || assignTarget.odometer_reading || 0) || null,
                    countryInfo,
                    sendWhatsApp: sendWhatsAppReply
                  });

                  if (!created.ok) {
                    customReply = `❌ *Driver Assignment Blocked*\n\n${created.error}`;
                  } else {
                    session.pendingAssignmentOtp = {
                      assignmentId: created.assignment.id,
                      vehicleId: created.assignment.vehicle_id,
                      driverPhone: created.driverPhone,
                      expiresAt: created.expiresAt
                    };
                    customReply = `🔐 *Verify Driver Assignment*\n\nWe sent a 6-digit code to your WhatsApp. Reply with the code to assign *${created.driverPhone}* to *${assignTarget.plate_number}*.\n\n_(Reply *Resend* for a new code or *Cancel* to abort.)_`;
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
            else if (activeIntent === 'EDIT_VEHICLE' || /^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText.trim())) {
              const editTarget = mergedExt.plate_number
                ? (findVehicleByCandidate(existingVehicles, mergedExt.plate_number) || targetVeh)
                : targetVeh;

              if (!editTarget) {
                customReply = `⚠️ I could not find that vehicle in your registered fleet.`;
              } else {
                const fieldAliasMap = {
                  make: 'make_model', model: 'make_model', make_model: 'make_model', make_and_model: 'make_model',
                  year: 'yom', yom: 'yom',
                  fuel: 'fuel_type', fuel_type: 'fuel_type',
                  color: 'color', colour: 'color',
                  transmission: 'transmission',
                  engine: 'engine_number', engine_number: 'engine_number',
                  tire: 'tire_size', tyre: 'tire_size', tire_size: 'tire_size',
                  insurance: 'insurance_expiry', insurance_expiry: 'insurance_expiry',
                  inspection: 'inspection_expiry', inspection_expiry: 'inspection_expiry',
                  plate: 'plate_number', plate_number: 'plate_number',
                  mileage: 'current_mileage', odometer: 'current_mileage', current_mileage: 'current_mileage',
                  email: 'owner_email', owner_email: 'owner_email',
                  phone: 'owner_phone', owner_phone: 'owner_phone',
                  vin: 'vin'
                };

                const candidateUpdates = {};
                // Note: plate_number is excluded from auto-merge so that mentioning
                // the target plate never accidentally renames the vehicle.
                const attrKeys = ['make_model', 'yom', 'year_of_manufacture', 'fuel_type', 'current_mileage', 'color', 'transmission', 'engine_number', 'tire_size', 'insurance_expiry', 'insurance_policy', 'inspection_expiry', 'purchase_cost', 'custom_attributes', 'owner_email', 'owner_phone'];
                for (const key of attrKeys) {
                  const value = mergedExt[key];
                  if (value !== undefined && value !== null && value !== '') candidateUpdates[key] = value;
                }

                // Flexible "<field> to <value>" parser (tolerates plates/digits in the middle).
                const explicitFieldMatch = messageText.match(/\b(make(?:\s*(?:&|and|\/)\s*model)?|model|year|yom|fuel(?:\s*type)?|mileage|odometer|color|colour|transmission|engine(?:\s*number)?|tire|tyre|insurance(?:\s*expiry)?|inspection(?:\s*expiry)?|plate(?:\s*number)?|email|owner\s*email|phone|owner\s*phone)\b\s*(?:to|as|=)\s*(.+)$/i);
                if (explicitFieldMatch) {
                  const rawFieldName = explicitFieldMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                  const rawFieldValue = explicitFieldMatch[2].trim().replace(/^["']|["']$/g, '');
                  const mappedField = fieldAliasMap[rawFieldName] || rawFieldName;
                  const numericFields = ['current_mileage', 'odometer_reading', 'yom', 'year_of_manufacture', 'purchase_cost'];
                  if (numericFields.includes(mappedField)) {
                    const numericValue = Number(rawFieldValue.replace(/[^\d.]/g, ''));
                    if (!Number.isNaN(numericValue)) candidateUpdates[mappedField] = numericValue;
                  } else {
                    candidateUpdates[mappedField] = rawFieldValue;
                  }
                }

                // Honour explicit field/value pairs supplied by the AI classifier.
                if (mergedExt.edit_field && mergedExt.edit_value) {
                  const aiField = String(mergedExt.edit_field).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                  candidateUpdates[fieldAliasMap[aiField] || aiField] = mergedExt.edit_value;
                }

                // VIN is immutable — always reject an attempted VIN change.
                if (mergedExt.vin || candidateUpdates.vin) {
                  delete candidateUpdates.vin;
                  customReply = `🔒 *VIN Is Permanently Locked*\n\nYour VIN / chassis number is permanently tied to your passbook and can never be edited. All other vehicle details can still be updated.`;
                } else if (Object.keys(candidateUpdates).length === 0) {
                  const currentList = `• Plate: ${editTarget.plate_number}\n• Make/Model: ${editTarget.make_model || '-'}\n• Year: ${editTarget.yom || editTarget.year_of_manufacture || '-'}\n• Fuel: ${editTarget.fuel_type || '-'}\n• Odometer: ${(editTarget.current_mileage || editTarget.odometer_reading || 0).toLocaleString()} km\n• VIN: ${editTarget.vin || '-'} 🔒`;
                  customReply = `🛠️ *Edit Vehicle — ${editTarget.plate_number}*\n\n${currentList}\n\nReply with the change, e.g. *"update vehicle ${editTarget.plate_number} color to White"* or *"change fuel for ${editTarget.plate_number} to Diesel"*.\n\n🔒 *Note:* The VIN is permanently immutable.`;
                } else {
                  const editRes = await updateVehicleDetails({
                    vehicleId: editTarget.id,
                    requesterId: profileData?.id,
                    updates: candidateUpdates,
                    supabase: supabaseClient
                  });

                  if (!editRes.success) {
                    customReply = `❌ *Vehicle Update Failed*\n\n${editRes.error}`;
                  } else {
                    const appliedLines = Object.entries(editRes.applied || {})
                      .filter(([k]) => k !== 'updated_at')
                      .map(([k, v]) => `• *${k}:* ${v}`)
                      .join('\n');
                    customReply = `✅ *Vehicle Details Updated!* 🚗\n\n• *Vehicle:* *${editRes.vehicle?.plate_number || editTarget.plate_number}*\n${appliedLines ? appliedLines + '\n' : ''}${editRes.rejected?.length ? '\n🔒 VIN / passbook token remain permanently locked and unchanged.' : ''}`;
                  }
                }
              }
            }
            else if (activeIntent === 'DELETE_VEHICLE' || /^(?:delete|remove|discard|scrap|decommission)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText.trim())) {
              const deleteTarget = mergedExt.plate_number
                ? (findVehicleByCandidate(existingVehicles, mergedExt.plate_number) || targetVeh)
                : targetVeh;

              if (!deleteTarget) {
                customReply = `⚠️ I could not identify the vehicle to delete. Please reply with the plate number, e.g. *"delete vehicle KDA 123A"*.`;
              } else if (deleteTarget.owner_id !== profileData?.id) {
                customReply = `🔒 *Owner Authorization Required*\n\nOnly the registered owner of *${deleteTarget.plate_number}* can delete this vehicle.`;
              } else {
                session.pendingDeleteVehicle = { vehicleId: deleteTarget.id, plateNumber: deleteTarget.plate_number };
                customReply = `⚠️ *Confirm Vehicle Deletion*\n\nYou are about to delete *${deleteTarget.plate_number}* (${deleteTarget.make_model || 'Vehicle'}) from your active fleet.\n\n• Assigned driver will be unassigned\n• Pending passbook transfers will be cancelled\n• Historical expense / earnings / reminder logs will be preserved for audit\n• The VIN trial ledger entry is permanent and cannot be removed\n\nReply *YES* to confirm, or *Cancel* to abort.`;
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
              const fleetReport = await buildFleetReport({
                supabase: supabaseClient,
                type: 'fleet',
                ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
                driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
                countryInfo,
                profile: profileData
              });
              customReply = fleetReport?.ok && fleetReport.text
                ? fleetReport.text
                : `Could not retrieve the fleet summary right now.`;
            }
            else if (activeIntent === 'GREETING') {
              customReply = aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant')
                ? aiResult.reply_message
                : await composeMessage({
                    purpose: 'greeting',
                    facts: {
                      activeVehicle: targetVeh?.plate_number || null,
                      makeModel: targetVeh?.make_model || null,
                      fleetSize: existingVehicles.length,
                      nextSteps: ['log expense/fuel', 'update odometer', 'set a reminder', 'log earnings', 'view summary']
                    },
                    language: targetLang,
                    countryInfo,
                    profile: profileData,
                    fallbackText: `👋 ${targetVeh?.plate_number || 'Fleet'} — what would you like to do today?`
                  });
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
                const inputUnit = targetVeh?.unit_system === 'imperial' ? 'mi' : 'km';
                let odometerSaveError = null;
                if (supabaseClient && targetVeh) {
                  const recorded = await applyOdometerReading({
                    supabase: supabaseClient,
                    vehicle: targetVeh,
                    reading: extOdometer,
                    inputUnit,
                    sendFn: (phone, text) => sendWhatsAppReply(phone, text),
                    canDeliver: (phone) => String(phone || '').replace(/[^\d]/g, '') !== String(senderPhone || '').replace(/[^\d]/g, '')
                  });
                  if (recorded?.ok === false) odometerSaveError = recorded.error;
                  if (recorded?.canonicalKm) targetVeh.current_mileage = recorded.canonicalKm;
                }
                if (odometerSaveError) {
                  customReply = `⚠️ Could not update the odometer for *${targetVeh.plate_number}*: ${odometerSaveError}`;
                } else {
                  customReply = `📈 *Odometer Updated!* 🚗

` +
                    `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})
` +
                    `• *New Odometer:* ${Number(extOdometer).toLocaleString()} ${inputUnit}

` +
                    `✅ Saved to database under *${targetVeh.plate_number}*!`;
                  if (existingVehicles.length > 1) {
                    customReply += `
*(Active vehicle: ${targetVeh.plate_number})*`;
                  }
                }
              } else {
                customReply = `📈 *Update Mileage / Odometer*

Please reply with your updated odometer reading (e.g. *"Odometer 45000 km"*).`;
              }
            }
            else if (activeIntent === 'LOG_OPERATING_HOURS') {
              const extHours = mergedExt.operating_hours !== undefined && mergedExt.operating_hours !== null
                ? Number(mergedExt.operating_hours)
                : extractNumberFromText(messageText);
              if (supabaseClient && targetVeh && extHours !== null && Number.isFinite(extHours) && extHours >= 0) {
                const recorded = await applyOperatingHours({
                  supabase: supabaseClient,
                  vehicle: targetVeh,
                  hours: extHours,
                  sendFn: (phone, text) => sendWhatsAppReply(phone, text),
                  canDeliver: (phone) => String(phone || '').replace(/[^\d]/g, '') !== String(senderPhone || '').replace(/[^\d]/g, '')
                });
                if (!recorded.ok) {
                  customReply = `⚠️ Could not update operating hours for *${targetVeh.plate_number}*: ${recorded.error}`;
                } else {
                  targetVeh.operating_hours = extHours;
                  customReply = `⏱️ *Operating Hours Updated!*

` +
                    `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})
` +
                    `• *New Hour Meter:* ${Number(extHours).toLocaleString()} operating hours

` +
                    `✅ Saved to database under *${targetVeh.plate_number}*!`;
                  if (existingVehicles.length > 1) {
                    customReply += `
*(Active vehicle: ${targetVeh.plate_number})*`;
                  }
                }
              } else {
                customReply = `⏱️ *Log Operating Hours*

Please reply with the current hour-meter reading (e.g. *"1250 engine hours"*).`;
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
              customReply = `🔔 *Set Reminder for ${targetVeh.plate_number}*\n\nReply with the item and its date, distance or operating hours. Examples:\n• *"Insurance expires on 15th Dec 2026"*, *"Inspection due next month"*, *"License renewal in 14 days"*\n• *"Road license expires 2027-03-31"* or *"Permit due in 30 days"*\n• *"Oil change in 5000 km"*, *"Brake pads in 3000 miles"* or *"Spare part change in 36 operating hours"*`;
            }
            else if (activeIntent === 'REQUEST_REPORT') {
              const reportType = resolveReportType(mergedExt.report_type || messageText, 'fleet');
              const fleetReport = await buildFleetReport({
                supabase: supabaseClient,
                type: reportType,
                ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
                driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
                countryInfo,
                profile: profileData
              });
              customReply = fleetReport?.ok && fleetReport.text
                ? fleetReport.text
                : `📊 *Fleet Reports & Summary*\n\nYou have ${existingVehicles.length} active vehicle(s).\n\nAsk for *fleet status*, *compliance report*, *maintenance report* or *financial report*.`;
            }
            else if (activeIntent === 'MANAGE_VEHICLE' || activeIntent === 'LIST_VEHICLES') {
              const vehicleList = existingVehicles.map((v, i) => {
                const isActive = v.id === targetVeh?.id;
                return `${i + 1}️⃣ *${v.plate_number}* - ${v.make_model || 'Vehicle'} (${v.fuel_type || 'Fuel'}, ${(v.current_mileage || v.odometer_reading || 0).toLocaleString()} km)${isActive ? ' 👉 *(ACTIVE)*' : ''}`;
              }).join('\n');
              customReply = `🚗 *Your Registered Fleet:*\n\n${vehicleList}\n\n💡 *To switch active vehicle:* Reply *"switch to [plate]"* or *"switch to [number]"*!`;
            }
            else if (session.pendingAccountDeletion) {
              const cleanTrimmed = messageText.trim();
              const providedOtp = mergedExt.otp_code || (cleanTrimmed.match(/^\d{6}$/) ? cleanTrimmed : null);
              if (/^(cancel|exit|stop)$/i.test(cleanTrimmed)) {
                session.pendingAccountDeletion = null;
                customReply = `Account deletion cancelled. Your account remains active.`;
              } else if (providedOtp && session.pendingAccountDeletion.code === providedOtp && Date.now() <= session.pendingAccountDeletion.expiresAt) {
                session.pendingAccountDeletion = null;
                if (supabaseClient && profileData) {
                  const nowIso = new Date().toISOString();
                  await supabaseClient
                    .from('vehicles')
                    .update({ deleted_at: nowIso, status: 'DELETED', assigned_driver_id: null, updated_at: nowIso })
                    .eq('owner_id', profileData.id)
                    .is('deleted_at', null);
                  await supabaseClient
                    .from('profiles')
                    .update({ is_active: false, deleted_at: nowIso, updated_at: nowIso })
                    .eq('id', profileData.id);
                  await supabaseClient.from('chat_history').delete().eq('user_phone', senderPhone);
                  await supabaseClient.from('chat_transcripts').delete().eq('phone_number', senderPhone);
                  await supabaseClient.from('processed_webhooks').delete().eq('phone_number', senderPhone);
                }
                onboardingStore.delete(senderPhone);
                session.state = 'IDLE';
                session.active_vehicle_id = null;
                session.history = [];
                customReply = `🗑️ *Account Deleted*\n\nYour Saka Fleet account has been soft-deleted, your vehicles released, and active sessions cleared. Historical audit logs are retained for compliance.\n\nYou can register again anytime by typing *Register*.`;
              } else {
                customReply = `❌ *Invalid or Expired Code*\n\nPlease reply with the 6-digit code sent to **${profileData?.email}**, or reply *Cancel* to abort.`;
              }
            }
            else if (activeIntent === 'DELETE_ACCOUNT' || /^(?:delete|deactivate|close|remove)\s+(?:my\s+)?account\b/i.test(messageText.trim())) {
              if (!profileData?.email) {
                customReply = `🔒 *Email Required*\n\nPlease add a verified email first (reply *"update email to your@email.com"*) so we can send the account-deletion verification code.`;
              } else {
                const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
                session.pendingAccountDeletion = { code: otpCode, expiresAt: Date.now() + 10 * 60 * 1000 };
                try {
                  await sendMfaEmail(profileData.email, otpCode);
                  customReply = `🔒 *Confirm Account Deletion*\n\nWe dispatched a 6-digit verification code to **${profileData.email}**.\n\nReply with the code to soft-delete your account. Your vehicles will be released, active sessions cleared, and historical logs retained for audit.\n\nReply *Cancel* to abort.`;
                } catch (mailErr) {
                  session.pendingAccountDeletion = null;
                  customReply = `⚠️ Could not dispatch the verification code: ${mailErr.message}`;
                }
              }
            }
            else if (activeIntent === 'EDIT_PROFILE' || /^(?:edit|update|change|modify)\s+(?:my\s+)?(?:profile|details|name|language|units?|unit\s+system|settings|contact)\b/i.test(messageText.trim())) {
              const profileUpdates = {};
              const nameMatch = messageText.match(/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:full\s+)?name\s+(?:to|as|=)\s+(.+)$/i);
              const langMatch = messageText.match(/\b(english|swahili|french|spanish|german|arabic)\b/i);
              const unitMatch = messageText.match(/\b(metric|imperial)\b/i);

              if (nameMatch) profileUpdates.full_name = nameMatch[1].trim();
              if (mergedExt.full_name) profileUpdates.full_name = mergedExt.full_name;
              if (langMatch) profileUpdates.preferred_language = langMatch[1][0].toUpperCase() + langMatch[1].slice(1).toLowerCase();
              if (mergedExt.preferred_language) profileUpdates.preferred_language = mergedExt.preferred_language;
              if (unitMatch) profileUpdates.unit_system = unitMatch[1].toLowerCase();
              if (mergedExt.unit_system) profileUpdates.unit_system = mergedExt.unit_system;

              if (Object.keys(profileUpdates).length === 0) {
                customReply = `⚙️ *Profile & Settings*\n\n• Name: ${profileData?.full_name || '-'}\n• Email: ${profileData?.email || '-'}\n• Language: ${profileData?.preferred_language || 'English'}\n• Units: ${profileData?.unit_system || 'metric'}\n\nReply with a change, e.g. *"update my name to Jane Doe"*, *"change my language to Swahili"*, or *"change my units to imperial"*.\n\n_(Use "update email to ..." to change your email with OTP verification.)_`;
              } else if (supabaseClient && profileData) {
                profileUpdates.updated_at = new Date().toISOString();
                const { error: profileErr } = await supabaseClient.from('profiles').update(profileUpdates).eq('id', profileData.id);
                if (profileErr) {
                  customReply = `❌ *Profile Update Failed*\n\n${profileErr.message}`;
                } else {
                  Object.assign(profileData, profileUpdates);
                  const changed = Object.entries(profileUpdates)
                    .filter(([k]) => k !== 'updated_at')
                    .map(([k, v]) => `• *${k}:* ${v}`)
                    .join('\n');
                  customReply = `✅ *Profile Updated!* ⚙️\n\n${changed}\n\nThese settings now apply across your whole fleet.`;
                }
              }
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
              customReply = await renderRoleActions({
                profileData,
                vehicles: existingVehicles,
                senderPhone,
                language: targetLang,
                countryInfo
              });
            }
            else {
              if (aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle')) {
                customReply = aiResult.reply_message;
              } else {
                customReply = await composeMessage({
                  purpose: 'active_user_default',
                  facts: {
                    activeVehicle: targetVeh?.plate_number || null,
                    makeModel: targetVeh?.make_model || null,
                    fleetSize: existingVehicles.length
                  },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: `How can I help with ${targetVeh?.plate_number || 'your fleet'} today?`
                });
              }
            }
          }
        }

        // --- BRANCH C: UNREGISTERED / IDLE USER DEFAULT ---
        else if (!isSpecialFlowHandled) {
          const clean = messageText.trim().toLowerCase();

          // 1. User asks to pause / stop
          if (/^(stop|pause|halt|quiet|exit|cancel)$/i.test(clean)) {
            customReply = await composeMessage({
              purpose: 'pause_acknowledgement',
              facts: { state: 'paused', note: 'Acknowledge the pause warmly and say they can return anytime.' },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: 'Paused — message me anytime to continue.'
            });
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
            customReply = await composeMessage({
              purpose: 'friction_apology',
              facts: {
                issue: 'The user reported too many or repeating messages',
                actionTaken: 'Automated prompts paused for this chat',
                nextSteps: ['Type Support to reach support@sakafleet.com', 'Send a vehicle plate when ready to onboard']
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: 'Apologies for the message overload — I have paused automated prompts. Type Support for help, or send your plate when ready.'
            });
          }
          // 3. Greetings — AI-rendered first-time introduction
          else if (/^(habari|mambo|jambo|hujambo|salama)\b/i.test(clean) || intent === 'GREETING') {
            customReply = aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant')
              ? aiResult.reply_message
              : await composeMessage({
                  purpose: 'first_time_welcome',
                  facts: {
                    prompt: 'Introduce Saka Fleet in one short paragraph, then ask exactly ONE question: the vehicle registration plate (or invite them to type REGISTER).',
                    region: countryInfo,
                    plateExample: countryInfo.plate_example,
                    setupSteps: ['plate number', 'make/model, year, fuel, odometer', 'email OTP', 'VIN-locked passbook'],
                    helpHint: 'Type Help anytime, Restart or Cancel to recover.'
                  },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: `Welcome to Saka Fleet 🚗 What is your vehicle's registration plate? (e.g. ${countryInfo.plate_example})`
                });
          }
          // 4. General informational questions answered by Saka AI
          else if (aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle')) {
            customReply = aiResult.reply_message;
          }
          // 5. Default: AI-rendered single next step
          else {
            customReply = await composeMessage({
              purpose: 'first_time_default',
              facts: {
                prompt: 'Give exactly ONE next step: ask for the vehicle registration plate (or invite REGISTER). Optionally mention ACCEPT for a transferred passbook.',
                plateExample: countryInfo.plate_example,
                region: countryInfo
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: `Send your vehicle registration plate (e.g. ${countryInfo.plate_example}) — or type REGISTER — to get started.`
            });
          }
        }
        }
        }

        // Fast-path safety: if no flow produced a reply, render a minimal one.
        if (!customReply) {
          customReply = await composeMessage({
            purpose: 'fallback_reply',
            facts: { userMessage: messageText },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: 'How can I help with your fleet today?'
          });
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
          finalReply = await composeMessage({
            purpose: 'soft_trip_retry',
            facts: {
              issue: 'The same prompt repeated without progress',
              instruction: 'Invite the user to resend that one answer in a slightly different way. Keep it to one short question.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: "Let's try that once more — please resend your last answer."
          });
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

          finalReply = await composeMessage({
            purpose: 'hard_trip_support_escalation',
            facts: {
              issue: 'Repeated identical prompt; support has been emailed automatically',
              supportEmail: 'support@sakafleet.com',
              nextSteps: ['Type Restart to begin again', 'Type Cancel to exit', 'Wait for a WhatsApp update from support']
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: "I've escalated this step to support@sakafleet.com. Type Restart to begin again, or Cancel to exit."
          });
          session.lastAssistantPrompt = finalReply;
        }

        session.history.push({ role: 'user', parts: [{ text: messageText }] });
        session.history.push({ role: 'model', parts: [{ text: finalReply }] });
        if (session.history.length > 20) session.history = session.history.slice(-20);
        chatSessions.set(senderPhone, session);

        await sendWhatsAppReply(senderPhone, finalReply);
        await userLogPromise;
        if (supabaseClient) {
          await Promise.all([
            logChatTranscript(supabaseClient, senderPhone, 'assistant', finalReply),
            saveChatMessage(supabaseClient, senderPhone, 'assistant', finalReply),
            persistSnap()
          ]);
        } else {
          await persistSnap();
        }

        return { status: 'success' };
      } catch (err) {
        if (fastify?.log) fastify.log.error(err);
        await userLogPromise;
        await persistSnap();
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
