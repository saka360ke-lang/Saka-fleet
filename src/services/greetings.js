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

/** True only for a genuinely fresh conversation (no history, no intro yet). */
export function isFirstContact({ session = null, dbHistory = [], profile = null, hasVehicleRegistered = false } = {}) {
  if (session?.sakaIntroduced) return false;
  if (hasVehicleRegistered) return false;
  if (Array.isArray(dbHistory) && dbHistory.length > 0) return false;
  if (Array.isArray(session?.history) && session.history.length > 0) return false;
  return true;
}

export default {
  resolveDaypart,
  greetingFor,
  sakaIntroText,
  isFirstContact
};
