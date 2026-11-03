import { detectCountryFromPhone } from './globalization.js';
import { deriveCountryCommStyles } from './countryCommStyles.js';

export const COUNTRY_LEARNINGS_CACHE_MS = Number(process.env.COUNTRY_LEARNINGS_CACHE_MS || 10 * 60 * 1000);
export const COUNTRY_LEARNINGS_TABLE = "country_learnings";

export const COUNTRY_LEARNINGS_SQL = `
  CREATE TABLE IF NOT EXISTS public.country_learnings (
    country_code text PRIMARY KEY,
    learnings text,
    tone_notes text,
    message_count integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now()
  );
`;

const cache = new Map();

export function countryCodeForPhone(phone) {
  const code = detectCountryFromPhone(phone)?.country_code || "GLOBAL";
  return /^[A-Z]{2}$/.test(code) ? code : "GLOBAL";
}

export async function ensureCountryBucket(supabase, { phone = null, countryCode = null } = {}) {
  const code = String(countryCode || countryCodeForPhone(phone) || "GLOBAL").toUpperCase();
  if (!supabase || !/^[A-Z]{2}$/.test(code)) return { ok: false, created: [] };
  const created = [];
  try {
    const { error } = await supabase.from(COUNTRY_LEARNINGS_TABLE).upsert({ country_code: code, updated_at: new Date().toISOString() }, { onConflict: "country_code", ignoreDuplicates: true });
    if (!error) created.push(COUNTRY_LEARNINGS_TABLE);
  } catch { }
  try {
    const { error } = await supabase.from("country_comm_styles").upsert({ country_code: code, updated_at: new Date().toISOString() }, { onConflict: "country_code", ignoreDuplicates: true });
    if (!error) created.push("country_comm_styles");
  } catch { }
  return { ok: created.length > 0, code, created };
}

export function deriveCountryLearnings(transcripts = []) {
  const styles = deriveCountryCommStyles(transcripts);
  return styles.map((s) => {
    const bullets = [];
    if (s.top_greeting) bullets.push("Greets with " + s.top_greeting);
    if (s.short_reply_rate >= 0.5) bullets.push("Prefers very short replies.");
    if (s.formal_rate >= 0.3) bullets.push("Responds well to please/kindly phrasing.");
    if (s.emoji_rate >= 0.3) bullets.push("Emoji-friendly tone.");
    return { country_code: s.country_code, message_count: s.message_count, tone_notes: s.notes, learnings: bullets.join(" ") };
  }).filter((row) => row.learnings);
}
export async function upsertCountryLearnings({ supabase, rows } = {}) {
  if (!supabase || !Array.isArray(rows) || !rows.length) return { ok: false, updated: 0 };
  let updated = 0;
  for (const row of rows) {
    if (!row || !row.country_code) continue;
    try {
      const { error } = await supabase.from(COUNTRY_LEARNINGS_TABLE).upsert({
        country_code: row.country_code,
        learnings: String(row.learnings || "").slice(0, 2000),
        tone_notes: row.tone_notes || null,
        message_count: Number(row.message_count || 0),
        updated_at: new Date().toISOString()
      }, { onConflict: "country_code" });
      if (!error) updated += 1;
    } catch { }
  }
  if (updated) cache.clear();
  return { ok: updated > 0, updated };
}

export async function getCountryLearningsLine({ supabase, countryCode } = {}) {
  const code = String(countryCode || "").toUpperCase();
  if (!supabase || !/^[A-Z]{2}$/.test(code)) return "";
  const hit = cache.get(code);
  if (hit && hit.expiresAt > Date.now()) return hit.line;
  try {
    const { data } = await supabase.from(COUNTRY_LEARNINGS_TABLE).select("learnings,message_count").eq("country_code", code).maybeSingle();
    const line = data && data.learnings ? ("COUNTRY LEARNINGS (" + code + ", from " + Number(data.message_count || 0) + " messages): " + data.learnings) : "";
    cache.set(code, { line, expiresAt: Date.now() + COUNTRY_LEARNINGS_CACHE_MS });
    return line;
  } catch {
    cache.set(code, { line: "", expiresAt: Date.now() + COUNTRY_LEARNINGS_CACHE_MS });
    return "";
  }
}

export default { COUNTRY_LEARNINGS_TABLE, COUNTRY_LEARNINGS_SQL, COUNTRY_LEARNINGS_CACHE_MS, countryCodeForPhone, ensureCountryBucket, deriveCountryLearnings, upsertCountryLearnings, getCountryLearningsLine };
