import { resolveUserTimezone } from './globalization.js';

/**
 * Saka Fleet — First-contact greetings (v1.18.1)
 * ---------------------------------------------
 * One warm, deterministic introduction for a brand-new WhatsApp number. No AI
 * tokens, no hallucination risk, and fully country-aware: India gets "Namaste",
 * East Africa "Habari", the Gulf "Marhaba", and everywhere else a time-of-day
 * greeting in the user's own timezone.
 */

const LOCAL_GREETINGS = Object.freeze({
  IN: { word: 'Namaste', emoji: '🙏' },
  KE: { word: 'Habari', emoji: '👋' },
  TZ: { word: 'Habari', emoji: '👋' },
  UG: { word: 'Habari', emoji: '👋' },
  RW: { word: 'Muraho', emoji: '👋' },
  AE: { word: 'Marhaba', emoji: '👋' },
  SA: { word: 'Marhaba', emoji: '👋' },
  QA: { word: 'Marhaba', emoji: '👋' },
  EG: { word: 'Marhaba', emoji: '👋' },
  FR: { word: 'Bonjour', emoji: '👋' },
  BE: { word: 'Bonjour', emoji: '👋' },
  ES: { word: 'Hola', emoji: '👋' },
  MX: { word: 'Hola', emoji: '👋' },
  AR: { word: 'Hola', emoji: '👋' },
  CO: { word: 'Hola', emoji: '👋' },
  BR: { word: 'Olá', emoji: '👋' },
  PT: { word: 'Olá', emoji: '👋' },
  DE: { word: 'Hallo', emoji: '👋' },
  IT: { word: 'Ciao', emoji: '👋' },
  NL: { word: 'Hallo', emoji: '👋' },
  ZA: { word: 'Sawubona', emoji: '👋' }
});

const DAYPART_EMOJI = Object.freeze({
  morning: '🌅',
  afternoon: '☀️',
  evening: '🌙',
  night: '🌙'
});

/** Resolve morning/afternoon/evening/night in the user's timezone. */
export function resolveDaypart(now = new Date(), timeZone = 'Africa/Nairobi') {
  let hour = now.getUTCHours();
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(now);
    const parsed = Number(String(formatted).slice(0, 2));
    if (Number.isFinite(parsed)) hour = parsed;
  } catch { /* fall back to UTC */ }
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** Country-aware opener: "Namaste! 🙏", "Habari! 👋", "Good evening! 🌙". */
export function greetingFor({ countryInfo = null, now = new Date(), timeZone = null } = {}) {
  const code = String(countryInfo?.country_code || '').toUpperCase();
  const local = LOCAL_GREETINGS[code];
  const zone = timeZone || resolveUserTimezone({ countryInfo, profile: null });
  const daypart = resolveDaypart(now, zone);
  if (local) {
    return { text: `${local.word}! ${local.emoji}`, daypart, local: local.word };
  }
  const label = daypart.charAt(0).toUpperCase() + daypart.slice(1);
  return { text: `Good ${daypart}! ${DAYPART_EMOJI[daypart]}`, daypart, local: null };
}

/** v1.25.2 — one-shot pause confirmation (anti-spam opt-out). */
export const PAUSE_REPLY = '🔇 *Paused.* I\'ll stay quiet — message me anytime and I\'ll pick up where we left off.';

/**
 * v1.25.2 — recognise an explicit stop/pause request WITHOUT stealing real
 * business intents: "cancel my subscription" and a bare "cancel" (quiz exit)
 * stay with their own flows; "stop at the petrol station" is not an opt-out.
 */
export function isStopRequest(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^(?:please\s+)?(?:stop|pause|unsubscribe)\s*[.!]*$/i.test(value)) return true;
  return /\b(?:stop (?:with )?(?:the )?(?:many )?(?:replies|messages|messaging|replying|spamming|sending)|too many (?:replies|messages)|leave me alone|shut up)\b/i.test(value);
}

/**
 * Warm, sales-crafted first-contact introduction (v1.25.0).
 * Ends with exactly ONE next step, keeps the welcome emoji ceiling (≤4 total),
 * and always offers the one-line paragraph shortcut that shows off the product.
 */
export function sakaIntroText({ countryInfo = null, now = new Date(), profile = null, plateExample = null, nextStep = null } = {}) {
  const { text: greeting } = greetingFor({ countryInfo, now });
  const example = plateExample || countryInfo?.plate_example || 'ABC 1234';
  const name = String(profile?.full_name || '').trim().split(/\s+/)[0];
  const helloName = name ? ` ${name}` : '';
  const step = nextStep === null
    ? `Send your vehicle's number plate (e.g. *${example}*) and I'll ask one quick question at a time — or type one line like *"Toyota Fielder 2016, diesel, 120,000 km, ${example}"* and I'll pick out every detail myself.`
    : nextStep;
  return `${greeting}${helloName} I'm *Saka* — your machine's memory, money-saver and paperwork wizard, right here on WhatsApp.` +
    '\n\n⛽ Every litre and every shilling, remembered for you' +
    '\n💰 What each kilometre really costs, so you can trim the waste' +
    '\n🔔 Service, insurance and inspection reminders — before they bite' +
    (step ? `\n\n${step}` : '');
}

/** True only for a genuinely fresh conversation (no persisted history, no vehicle). */
export function isFirstContact({ session = null, dbHistory = [], profile = null, hasVehicleRegistered = false, now = Date.now(), newProfileWindowMs = 120000 } = {}) {
  if (hasVehicleRegistered) return false;
  // v1.24.3 — a profile created moments ago is a brand-new account, full stop.
  // This check runs BEFORE the history check because the turn's own user row can
  // land in chat_history before the history read on a slow database, which used
  // to make a first-time user look like a returning one ("no need to start
  // over" instead of the welcome).
  const createdAt = profile?.created_at ? Date.parse(profile.created_at) : NaN;
  if (Number.isFinite(createdAt) && now - createdAt <= newProfileWindowMs) return true;
  // v1.21.3 — wipe-aware: with NO persisted history there is no real
  // conversation to preserve, so stale in-memory flags (e.g. a warm Cloud Run
  // instance that survived a database slate wipe) must never suppress the
  // welcome. Every real turn is persisted, so a genuine warm session always
  // has DB history.
  if (Array.isArray(dbHistory) && dbHistory.length > 0) return false;
  return true;
}

/**
 * v1.24.4 — should an intro-looking reply be replaced with the "still here"
 * recovery line?
 *
 * Only for conversations that are PAST onboarding. The v1.19.2 guard was meant
 * to stop re-introducing Saka mid-onboarding; on 2026-10-31 it left a real
 * first-time user looping on "I'm still here with you" because every message
 * ("Hi", "Restart") produced intro copy. A zero-vehicle user who has not started
 * onboarding must always receive the welcome + REGISTER call to action.
 */
export function shouldReplaceIntroCopy({
  firstContact = false,
  historyLength = 0,
  hasQuiz = false,
  hasVehicle = false,
  isIntro = false,
  wantsIntro = false
} = {}) {
  if (firstContact || hasQuiz) return false;
  if (hasVehicle !== true) return false;
  if (!historyLength || wantsIntro) return false;
  return isIntro === true;
}

/** v1.24.4 — a byte-identical repeat outside a quiz gets a next-step nudge. */
export function isRepeatedReply({ quizActive = false, reply = '', lastPrompt = '' } = {}) {
  if (quizActive) return false;
  const current = String(reply || '').trim();
  const previous = String(lastPrompt || '').trim();
  return Boolean(current && previous && current === previous);
}

const PLATE_ASK_RE = /\b(?:what(?:'s| is) (?:your|the) (?:vehicle'?s? )?(?:registration |number )?plate|send (?:me )?(?:your|the) (?:vehicle'?s? )?(?:registration |number )?plate|share (?:your|the) (?:vehicle'?s? )?(?:registration )?plate|plate number of (?:the|your) vehicle)\b/i;

/**
 * v1.21.3 — detect a reply that asks a zero-vehicle user for a plate directly.
 * That bypasses the Country Bucket onboarding (asset kind first); the route
 * replaces it with a REGISTER invitation.
 */
export function asksForPlateDirectly(text = '') {
  return PLATE_ASK_RE.test(String(text || ''));
}

const INTRO_COPY_RE = /\b(i'?m saka|i am saka|karibu (?:to|kwenye) saka|welcome to saka(?: fleet)?|your (?:fleet|vehicle)(?:'s)? (?:co-pilot|assistant) on whatsapp)\b/i;
const INTRO_REQUEST_RE = /\b(who are you|what are you|introduce yourself|introduction|what can you do|how do (?:you|things) work|what is saka|about saka)\b/i;

/**
 * v1.19.2 — detect a fresh-welcome reply so it is never repeated to a user who
 * already has conversation history. Live evidence (2026-10-30): 20 of 25
 * intent-classification calls failed, and the prose fallback answered a
 * mid-onboarding user with a brand-new "Karibu to Saka Fleet" intro.
 */
export function isIntroCopy(text = '') {
  return INTRO_COPY_RE.test(String(text || ''));
}

/** True when the user genuinely asked who Saka is — then an intro is correct. */
export function wantsIntroduction(text = '') {
  return INTRO_REQUEST_RE.test(String(text || ''));
}

export default {
  resolveDaypart,
  greetingFor,
  sakaIntroText,
  isFirstContact,
  isIntroCopy,
  wantsIntroduction,
  asksForPlateDirectly
};
