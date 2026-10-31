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

/**
 * Polite first-contact introduction. Ends with exactly ONE next step.
 */
export function sakaIntroText({ countryInfo = null, now = new Date(), profile = null, plateExample = null, nextStep = null } = {}) {
  const { text: greeting } = greetingFor({ countryInfo, now });
  const example = plateExample || countryInfo?.plate_example || 'ABC 1234';
  const name = String(profile?.full_name || '').trim().split(/\s+/)[0];
  const helloName = name ? ` ${name}` : '';
  const step = nextStep === null ? `To begin, send your vehicle's number plate (e.g. *${example}*).` : nextStep;
  return `${greeting}${helloName ? ` ${helloName}` : ''} I'm *Saka* — your vehicle's co-pilot on WhatsApp.\n\n` +
    'I keep your fuel ⛽, costs 💰 and service reminders 🔔 in one calm place, so you can focus on the road.' +
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
