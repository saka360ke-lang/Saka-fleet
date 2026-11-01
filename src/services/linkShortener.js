import crypto from 'node:crypto';
import { hasSqlAccess, runSql } from '../db/sqlRunner.js';

/**
 * Saka Fleet — Link Shortener (v1.32.0)
 * ------------------------------------
 * Every long link Saka sends (Supabase report PDFs, Paystack checkouts) is
 * presented as a short, branded URL: https://sakafleet.com/r/<8-char-code>.
 * Self-hosted, deterministic and fail-soft: if the table or database is
 * unavailable the ORIGINAL url is returned so a message is never lost.
 */

export const SHORT_CODE_LENGTH = 8;
export const SHORT_LINK_TTL_DAYS = 90;
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Public base for short links (PUBLIC_APP_URL overrides the default). */
export const SHORT_LINK_DEFAULT_BASE = 'https://app.sakafleet.com';

/**
 * v1.32.2 — short links only go out when the branded domain is verified.
 * The live 2026-11-01 incident: sakafleet.com was a parked marketing domain,
 * so every https://sakafleet.com/r/<code> link 404'd while the PDFs were fine.
 * `SHORT_LINK_DOMAIN_READY=off` (default) keeps sending the original working
 * URL; set it to `on` once app.sakafleet.com serves HTTPS. An explicit
 * PUBLIC_APP_URL implies the operator already chose a ready base.
 */
export function isShortLinkDomainReady() {
  const flag = String(process.env.SHORT_LINK_DOMAIN_READY || '').toLowerCase();
  if (['on', 'true', '1'].includes(flag)) return true;
  return Boolean(String(process.env.PUBLIC_APP_URL || '').trim());
}

export function shortLinkBase() {
  return String(process.env.PUBLIC_APP_URL || SHORT_LINK_DEFAULT_BASE).replace(/\/+$/, '');
}

export function isShortLink(url) {
  return typeof url === 'string' && url.startsWith(`${shortLinkBase()}/r/`);
}

export function generateShortCode(length = SHORT_CODE_LENGTH) {
  const size = Number.isFinite(Number(length)) && Number(length) > 0 ? Math.min(Number(length), 32) : SHORT_CODE_LENGTH;
  const bytes = crypto.randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export const SHORT_LINKS_SQL = `
    CREATE TABLE IF NOT EXISTS public.short_links (
        code text PRIMARY KEY,
        url text NOT NULL,
        created_at timestamp with time zone DEFAULT now(),
        expires_at timestamp with time zone DEFAULT (now() + interval '90 days')
    );
    CREATE INDEX IF NOT EXISTS idx_short_links_url ON public.short_links(url);
`;

/** Ensure the short_links table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureShortLinksTable(providedSupabase) {
  if (!providedSupabase) return { ok: false, status: 'no-client' };
  try {
    const { error } = await providedSupabase.from('short_links').select('code').limit(1);
    if (!error) return { ok: true, status: 'exists' };
    if (!/short_links|relation|table|column/i.test(error.message || '')) {
      return { ok: false, status: 'error', error: error.message };
    }
    if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
    const result = await runSql(SHORT_LINKS_SQL, { label: 'ensureShortLinksTable' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

/**
 * Shorten a user-facing URL. Returns the original string when the link is
 * already short, is not http(s), or anything fails (never throws).
 */
export async function shortenUrl(supabase, url, { ttlDays = SHORT_LINK_TTL_DAYS } = {}) {
  const original = typeof url === 'string' ? url.trim() : url;
  try {
    if (typeof original !== 'string' || !original) return original;
    if (!/^https?:\/\//i.test(original)) return original;
    if (original.length <= 80 || isShortLink(original)) return original;
    if (!supabase) return original;
    // v1.32.2 — never send a link on an unverified domain (see isShortLinkDomainReady).
    if (!isShortLinkDomainReady()) return original;

    // Reuse a live code for the same target (keeps the table tidy).
    try {
      const { data: existing } = await supabase
        .from('short_links')
        .select('code, expires_at')
        .eq('url', original)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing?.code && (!existing.expires_at || new Date(existing.expires_at).getTime() > Date.now())) {
        return `${shortLinkBase()}/r/${existing.code}`;
      }
    } catch { /* fall through to insert */ }

    // Opportunistic TTL purge (best effort).
    try {
      await supabase.from('short_links').delete().lt('expires_at', new Date().toISOString());
    } catch { /* best effort */ }

    const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlDays) || SHORT_LINK_TTL_DAYS) * 86400000).toISOString();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const code = generateShortCode();
      const { error } = await supabase.from('short_links').insert([{ code, url: original, expires_at: expiresAt }]);
      if (!error) return `${shortLinkBase()}/r/${code}`;
      if (!/duplicate|unique|already exists/i.test(error.message || '')) break;
    }
    return original;
  } catch {
    return original;
  }
}

/** Resolve a short code to its target URL (null when missing/expired). */
export async function resolveShortCode(supabase, code) {
  try {
    if (!supabase || !code) return null;
    const { data } = await supabase
      .from('short_links')
      .select('url, expires_at')
      .eq('code', String(code))
      .maybeSingle();
    if (!data?.url) return null;
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.url;
  } catch {
    return null;
  }
}

export default {
  SHORT_CODE_LENGTH,
  SHORT_LINK_TTL_DAYS,
  SHORT_LINKS_SQL,
  shortLinkBase,
  isShortLink,
  generateShortCode,
  ensureShortLinksTable,
  shortenUrl,
  resolveShortCode
};
