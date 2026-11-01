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

/* ------------------------------------------------------------------ */
/* v1.32.4 — self-verifying probe route                                */
/* ------------------------------------------------------------------ */

/**
 * The live 2026-11-01 incident proved a flag alone is not evidence: the domain
 * answered, but `/r/<code>` landed on a marketing page instead of the backend.
 * The app therefore hosts a tiny probe route and asks ITSELF whether short
 * links actually resolve on the branded base before it dares to send one.
 */
export const SHORT_LINK_PROBE_PATH = '/r/__saka_probe__';
export const SHORT_LINK_PROBE_TAG = 'saka-shortlink';

export function shortLinkProbeUrl() {
  return `${shortLinkBase()}${SHORT_LINK_PROBE_PATH}`;
}

function probeCacheTtlMs() {
  const raw = Number(process.env.SHORT_LINK_PROBE_CACHE_MS || 600000);
  return Number.isFinite(raw) && raw >= 60000 ? Math.min(raw, 3600000) : 600000;
}

function probeTimeoutMs() {
  const raw = Number(process.env.SHORT_LINK_PROBE_TIMEOUT_MS || 3000);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 15000) : 3000;
}

/** Last probe outcome (sync; used by the status probe — never blocks). */
let lastProbe = null;

/** Explicit operator signal: no probe needed to trust the base. */
export function hasExplicitShortLinkSignal() {
  return isShortLinkDomainReady();
}

/**
 * v1.32.4 — probe kill switch. `SHORT_LINK_PROBE=off` trusts an explicit
 * operator signal without a network round-trip (used by offline suites and by
 * operators who front the route with their own monitoring).
 */
export function shortLinkProbeEnabled() {
  const raw = String(process.env.SHORT_LINK_PROBE ?? 'on').toLowerCase();
  return !['off', 'false', '0', 'disabled'].includes(raw);
}

/**
 * Fetch the branded probe route and cache the verdict.
 * Fail-soft: any error means "not ready" and the caller keeps the long URL.
 */
export async function verifyShortLinkRoute({ force = false } = {}) {
  const base = shortLinkBase();
  const now = Date.now();
  if (!force && lastProbe && lastProbe.base === base && now - lastProbe.checkedAtMs < probeCacheTtlMs()) {
    return lastProbe;
  }
  const settle = (ready, reason, status = null) => {
    lastProbe = { ready, base, status, reason, checkedAtMs: now, checkedAt: new Date(now).toISOString() };
    return lastProbe;
  };
  if (!isShortLinkDomainReady()) return settle(false, 'flag-off');
  if (!shortLinkProbeEnabled()) return settle(true, 'probe-disabled');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), probeTimeoutMs()) : null;
  try {
    const response = await fetch(shortLinkProbeUrl(), {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {})
    });
    const tag = response?.headers?.get?.('x-saka-shortlink') || null;
    const ready = response?.status === 200 && tag === SHORT_LINK_PROBE_TAG;
    return settle(ready, ready ? 'verified' : 'probe-mismatch', response?.status ?? null);
  } catch (err) {
    return settle(false, `probe-error: ${err.message}`, null);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Authoritative gate used before any short link is generated.
 * Explicit operator signal wins immediately; otherwise the probe decides.
 */
export async function shortLinkReady({ force = false } = {}) {
  if (!hasExplicitShortLinkSignal()) {
    return { ready: false, base: shortLinkBase(), reason: 'flag-off', status: null, checkedAt: new Date().toISOString() };
  }
  if (!shortLinkProbeEnabled()) {
    return { ready: true, base: shortLinkBase(), reason: 'probe-disabled', status: null, checkedAt: new Date().toISOString() };
  }
  return verifyShortLinkRoute({ force });
}

/** Sync snapshot for `/internal/status` (no network, no secrets). */
export function shortLinkStatus() {
  const base = shortLinkBase();
  if (lastProbe && lastProbe.base === base) {
    return { ready: Boolean(lastProbe.ready), base, reason: lastProbe.reason, checkedAt: lastProbe.checkedAt };
  }
  return {
    ready: false,
    base,
    reason: isShortLinkDomainReady() ? 'unchecked' : 'flag-off',
    checkedAt: null
  };
}

/** Plain HTML for an unknown/expired code — never a silent marketing bounce. */
export function shortLinkNotFoundHtml({ pricingUrl = null } = {}) {
  const target = pricingUrl || process.env.PUBLIC_PRICING_URL || 'https://sakafleet.com';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired — Saka Fleet</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0F172A;color:#E2E8F0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.5rem;margin:0 0 .75rem}
p{color:#94A3B8;line-height:1.6;margin:0 0 1.5rem}
a{display:inline-block;background:#0EA5E9;color:#062033;text-decoration:none;
font-weight:700;padding:.75rem 1.25rem;border-radius:.75rem}
</style></head>
<body><main>
<h1>This link has expired or does not exist</h1>
<p>Report links stay valid for 90 days. Ask Saka on WhatsApp for a fresh copy —
just say "send me the report".</p>
<a href="${target}">Open Saka Fleet</a>
</main></body></html>`;
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
    // v1.32.4 — "verified" now means the branded base actually answers the probe
    // route, not merely that a flag was flipped.
    if (!isShortLinkDomainReady()) return original;
    const readiness = await shortLinkReady();
    if (!readiness.ready) return original;

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
  SHORT_LINK_PROBE_PATH,
  SHORT_LINK_PROBE_TAG,
  shortLinkBase,
  shortLinkProbeUrl,
  isShortLink,
  isShortLinkDomainReady,
  hasExplicitShortLinkSignal,
  shortLinkProbeEnabled,
  verifyShortLinkRoute,
  shortLinkReady,
  shortLinkStatus,
  shortLinkNotFoundHtml,
  generateShortCode,
  ensureShortLinksTable,
  shortenUrl,
  resolveShortCode
};
