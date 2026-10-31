import { detectCountryFromPhone } from './globalization.js';

/**
 * Saka Fleet — Country communication styles (v1.28.8)
 * ---------------------------------------------------
 * Saka serves a global audience: greetings, formality, reply length and emoji
 * use differ by country. Sentinel derives a compact, deterministic style profile
 * from real transcripts (no AI, no guessing) and stores one row per country.
 *
 * The per-turn prompt injection is cached, so a conversation costs at most one
 * read per country per TTL window.
 */

export const COMM_STYLE_CACHE_MS = Number(process.env.COMM_STYLE_CACHE_MS || 10 * 60 * 1000);
export const COUNTRY_COMM_STYLES_TABLE = 'country_comm_styles';

export const COUNTRY_COMM_STYLES_SQL = `
  CREATE TABLE IF NOT EXISTS public.country_comm_styles (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    country_code text NOT NULL UNIQUE,
    message_count integer DEFAULT 0,
    top_greeting text,
    emoji_rate numeric DEFAULT 0,
    short_reply_rate numeric DEFAULT 0,
    formal_rate numeric DEFAULT 0,
    notes text,
    updated_at timestamp with time zone DEFAULT now()
  );
`;

const styleCache = new Map();

const GREETING_RE = /^(hi|hello|hey|habari|jambo|mambo|hujambo|namaste|salam|marhaba|bonjour|hola|ola|olá|hallo|ciao|sawubona)\b/i;
const FORMAL_RE = /\b(please|kindly|sir|madam|tafadhali|ndio|asante|shukran|merci|gracias|danke)\b/i;

function rate(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100) / 100;
}

/**
 * Derive per-country style rows from raw transcripts. Pure and deterministic:
 * greeting vocabulary, emoji usage, brevity and formality markers.
 */
export function deriveCountryCommStyles(transcripts = []) {
  const buckets = new Map();
  for (const row of Array.isArray(transcripts) ? transcripts : []) {
    const countryCode = detectCountryFromPhone(row?.phone_number)?.country_code || null;
    if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) continue;
    const text = String(row?.message_text || '').trim();
    if (!text) continue;
    const bucket = buckets.get(countryCode) || {
      messages: 0, greetings: {}, emoji: 0, short: 0, formal: 0
    };
    bucket.messages += 1;
    if (GREETING_RE.test(text)) {
      const word = (text.match(GREETING_RE) || [])[0]?.toLowerCase();
      if (word) bucket.greetings[word] = (bucket.greetings[word] || 0) + 1;
    }
    if (/\p{Extended_Pictographic}/u.test(text)) bucket.emoji += 1;
    if (text.split(/\s+/).length <= 3) bucket.short += 1;
    if (FORMAL_RE.test(text)) bucket.formal += 1;
    buckets.set(countryCode, bucket);
  }

  return [...buckets.entries()].map(([countryCode, bucket]) => {
    const topGreeting = Object.entries(bucket.greetings)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const emojiRate = rate(bucket.emoji, bucket.messages);
    const shortReplyRate = rate(bucket.short, bucket.messages);
    const formalRate = rate(bucket.formal, bucket.messages);
    const notes = [
      topGreeting ? `opens with "${topGreeting}"` : null,
      shortReplyRate >= 0.5 ? 'prefers very short replies' : null,
      formalRate >= 0.3 ? 'responds well to please/kindly phrasing' : null,
      emojiRate >= 0.3 ? 'emoji-friendly' : null
    ].filter(Boolean).join('; ');
    return {
      country_code: countryCode,
      message_count: bucket.messages,
      top_greeting: topGreeting,
      emoji_rate: emojiRate,
      short_reply_rate: shortReplyRate,
      formal_rate: formalRate,
      notes: notes || null
    };
  });
}

/** Upsert derived style rows (fail-soft, never throws). */
export async function upsertCountryCommStyles({ supabase, styles } = {}) {
  if (!supabase || !Array.isArray(styles) || !styles.length) return { ok: false, updated: 0 };
  let updated = 0;
  for (const style of styles) {
    if (!style?.country_code) continue;
    try {
      const { error } = await supabase.from(COUNTRY_COMM_STYLES_TABLE).upsert({
        ...style,
        updated_at: new Date().toISOString()
      }, { onConflict: 'country_code' });
      if (!error) updated += 1;
    } catch { /* fail-soft */ }
  }
  if (updated) styleCache.clear();
  return { ok: updated > 0, updated };
}

/** Per-turn prompt line for the user's country (cached, fail-soft). */
export async function getCountryCommStyleLine({ supabase, countryCode } = {}) {
  const code = String(countryCode || '').toUpperCase();
  if (!supabase || !/^[A-Z]{2}$/.test(code)) return '';
  const cached = styleCache.get(code);
  if (cached && cached.expiresAt > Date.now()) return cached.line;
  try {
    const { data } = await supabase
      .from(COUNTRY_COMM_STYLES_TABLE)
      .select('country_code, top_greeting, emoji_rate, short_reply_rate, formal_rate, notes, message_count')
      .eq('country_code', code)
      .maybeSingle();
    const line = data?.notes
      ? `COUNTRY COMMUNICATION STYLE (${code}, from ${Number(data.message_count || 0)} observed messages): ${data.notes}.`
      : '';
    styleCache.set(code, { line, expiresAt: Date.now() + COMM_STYLE_CACHE_MS });
    return line;
  } catch {
    styleCache.set(code, { line: '', expiresAt: Date.now() + COMM_STYLE_CACHE_MS });
    return '';
  }
}

export default {
  deriveCountryCommStyles,
  upsertCountryCommStyles,
  getCountryCommStyleLine,
  COUNTRY_COMM_STYLES_TABLE,
  COUNTRY_COMM_STYLES_SQL
};
