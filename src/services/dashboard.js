/**
 * Saka Fleet — Dashboard service (v1.74.0, Phase 13)
 * -------------------------------------------------
 * The web dashboard is the PRIMARY data surface; the PDF stays an export.
 * Phase 13 ships the auth foundation + a single overview page:
 *
 *   1. WhatsApp "dashboard"  -> requestDashboardAccess() emails ONE message
 *      carrying a magic link (15-min TTL) AND a 6-digit code (10-min TTL).
 *      The code NEVER rides WhatsApp — the two-channel split is the point.
 *   2. GET /d/<token>        -> the OTP entry page.
 *   3. POST /d/verify        -> verifyDashboardOtp() issues a raw session token
 *      that lives ONLY in an HttpOnly cookie; the database stores its sha256.
 *   4. GET /d                -> getSessionByToken() renders the overview card.
 *
 * Security contract (Phase 13, A3):
 *   - The magic-link token, the OTP and the session token are all stored as
 *     sha256 hashes. The raw values exist only in the email and the cookie.
 *   - OTP comparison is constant-time (crypto.timingSafeEqual), length-checked
 *     first so an invalid input can never throw through an error-path leak.
 *   - A link is single-use: verification stamps `verified`, nulls the OTP hash
 *     and issues exactly one session.
 *   - Every failure degrades to a reason code (rule 50: a missing table or a
 *     failed email never throws into the conversation).
 */

import crypto from 'node:crypto';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { shortLinkBase } from './linkShortener.js';
import { sendDashboardMagicLinkEmail } from './mailer.js';
import { logWriteFailure } from './systemErrors.js';

export const DASHBOARD_SESSIONS_TABLE = 'dashboard_sessions';
export const DASHBOARD_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const DASHBOARD_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DASHBOARD_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DASHBOARD_MAX_ATTEMPTS = 5;
export const DASHBOARD_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const DASHBOARD_COOKIE_NAME = 'saka_dash';
export const DASHBOARD_AUDIT_ACTOR = 'DASHBOARD';

/**
 * Idempotent DDL (rule 50). `token_hash` is the magic-link token; a null
 * `session_token_hash` means "still awaiting the OTP". Both hashes are unique,
 * so a collision can never grant anyone else's session. No FK to profiles on
 * purpose: the wipe order stays simple and matches chat_sessions/web_onboard_otps.
 */
export const DASHBOARD_SQL = `
CREATE TABLE IF NOT EXISTS public.${DASHBOARD_SESSIONS_TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text UNIQUE NOT NULL,
    session_token_hash text UNIQUE,
    owner_id uuid NOT NULL,
    email text,
    otp_hash text,
    attempts integer NOT NULL DEFAULT 0,
    verified boolean NOT NULL DEFAULT false,
    link_expires_at timestamp with time zone NOT NULL,
    otp_expires_at timestamp with time zone,
    session_expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_owner ON public.${DASHBOARD_SESSIONS_TABLE} (owner_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_link_expires ON public.${DASHBOARD_SESSIONS_TABLE} (link_expires_at DESC);
ALTER TABLE public.${DASHBOARD_SESSIONS_TABLE} ENABLE ROW LEVEL SECURITY;
`;

let tableReady = false;

/** Ensure the table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureDashboardTable(providedSupabase) {
  if (!providedSupabase) return { status: 'no_client' };
  try {
    const { error } = await providedSupabase.from(DASHBOARD_SESSIONS_TABLE).select('id').limit(1);
    if (!error) {
      tableReady = true;
      return { status: 'exists' };
    }
  } catch (err) {
    console.warn('[Dashboard] table probe failed (falling through to DDL):', err.message);
  }
  if (hasSqlAccess()) {
    const result = await runSql(DASHBOARD_SQL, { label: 'ensureDashboardTable' });
    if (result.ok) {
      tableReady = true;
      return { status: 'created' };
    }
  }
  return { status: 'missing' };
}

export function isDashboardTableReady() {
  return tableReady;
}

/* ------------------------------------------------------------------ */
/* Feature flag (default OFF until the whole program is proven)        */
/* ------------------------------------------------------------------ */

export function isDashboardEnabled() {
  return ['on', 'true', '1'].includes(String(process.env.DASHBOARD_ENABLED || '').toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Crypto primitives (A3)                                              */
/* ------------------------------------------------------------------ */

/** sha256 hex digest — the only form any token/code ever takes at rest. */
export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw ?? '')).digest('hex');
}

/**
 * Constant-time comparison for two hash strings. The length check runs FIRST so
 * a malformed input never reaches timingSafeEqual (which throws on length
 * mismatch) — the failure path carries no timing signal of its own.
 */
export function safeCompareHex(expectedHex, providedHex) {
  const expected = Buffer.from(String(expectedHex || ''), 'utf8');
  const provided = Buffer.from(String(providedHex || ''), 'utf8');
  if (expected.length === 0 || provided.length === 0) return false;
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/** Six digits from a CSPRNG (never Math.random for an auth code). */
export function mintOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

/** 32 random bytes as hex — used for the link token and the session token. */
export function mintToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/* ------------------------------------------------------------------ */
/* Links & copy helpers                                                */
/* ------------------------------------------------------------------ */

export function dashboardBaseUrl() {
  return `${shortLinkBase()}/d`;
}

export function dashboardLinkFor(rawToken) {
  return `${dashboardBaseUrl()}/${String(rawToken || '')}`;
}

/** d***d@example.com — enough to recognise, not enough to leak. */
export function maskEmail(email) {
  const raw = String(email || '').trim();
  const at = raw.indexOf('@');
  if (at <= 0) return 'your email';
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : '';
  return `${head}***${tail}@${domain}`;
}

async function writeAudit(supabase, action, details = {}) {
  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: DASHBOARD_AUDIT_ACTOR,
      action,
      details
    }]);
  } catch (err) {
    // Audit is best-effort: a failed audit row must never break the auth turn,
    // but the failure itself is never swallowed (v1.61.12 ratchet).
    console.warn('[Dashboard] audit write failed:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Request access (WhatsApp lane calls this)                        */
/* ------------------------------------------------------------------ */

/**
 * Eligibility: a verified email + a live trial or paid plan. The welcome trial
 * counts (isTrial covers ACTIVE/EXTENDED/GRACE), so a trial user never meets a
 * paywall in Phase 13. Never throws.
 */
export async function requestDashboardAccess({
  supabase,
  ownerId,
  profile = null,
  entitlements = null,
  countryInfo = null,
  sendEmail = sendDashboardMagicLinkEmail,
  now = new Date()
} = {}) {
  if (!isDashboardEnabled()) return { ok: false, reason: 'flag_off' };
  if (!supabase || !ownerId) return { ok: false, reason: 'db_error' };

  const email = String(profile?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };
  if (profile?.email_verified !== true) return { ok: false, reason: 'email_unverified' };
  if (!entitlements || (!entitlements.isTrial && !entitlements.isPaid)) {
    return { ok: false, reason: 'not_entitled' };
  }

  try {
    // 60-second resend cooldown (mirrors the web-onboarding resend gate). We
    // cannot re-send the old code — only its hash exists — so the lane answers
    // "I just sent it" and the user checks the inbox.
    const cooldownStart = new Date(now.getTime() - DASHBOARD_RESEND_COOLDOWN_MS).toISOString();
    const { data: recent } = await supabase
      .from(DASHBOARD_SESSIONS_TABLE)
      .select('id')
      .eq('owner_id', ownerId)
      .eq('verified', false)
      .gte('created_at', cooldownStart)
      .limit(1);
    if (Array.isArray(recent) && recent.length > 0) return { ok: false, reason: 'cooldown' };

    const rawToken = mintToken(32);
    const otp = mintOtp();
    const linkExpiresAt = new Date(now.getTime() + DASHBOARD_LINK_TTL_MS);
    const otpExpiresAt = new Date(now.getTime() + DASHBOARD_OTP_TTL_MS);

    const { error } = await supabase.from(DASHBOARD_SESSIONS_TABLE).insert([{
      token_hash: hashToken(rawToken),
      owner_id: ownerId,
      email,
      otp_hash: hashToken(otp),
      attempts: 0,
      verified: false,
      link_expires_at: linkExpiresAt.toISOString(),
      otp_expires_at: otpExpiresAt.toISOString()
    }]);
    if (error) {
      logWriteFailure(supabase, 'dashboard.requestDashboardAccess.insert', error);
      return { ok: false, reason: 'db_error' };
    }

    const link = dashboardLinkFor(rawToken);
    let emailed = false;
    try {
      emailed = (await sendEmail({
        to: email,
        link,
        otp,
        linkExpiresAt,
        otpExpiresAt,
        firstName: String(profile?.full_name || '').split(' ')[0] || '',
        countryInfo
      })) !== false;
    } catch { emailed = false; }

    if (!emailed) {
      // The user can never use a link they did not receive — remove the row so
      // no orphaned live token lingers (a fresh request starts clean).
      await supabase.from(DASHBOARD_SESSIONS_TABLE).delete().eq('token_hash', hashToken(rawToken));
      return { ok: false, reason: 'email_failed' };
    }

    await writeAudit(supabase, 'DASHBOARD_ACCESS_REQUESTED', { ownerId, email, linkExpiresAt: linkExpiresAt.toISOString() });
    return { ok: true, link, email, linkExpiresAt: linkExpiresAt.toISOString(), otpExpiresAt: otpExpiresAt.toISOString() };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.requestDashboardAccess', err);
    return { ok: false, reason: 'db_error' };
  }
}

/* ------------------------------------------------------------------ */
/* 2. Link state (the OTP page asks: is this link still good?)         */
/* ------------------------------------------------------------------ */

export async function getLinkState({ supabase, rawToken, now = new Date() } = {}) {
  if (!supabase || !rawToken) return { ok: false, reason: 'invalid_link' };
  try {
    const { data: row, error } = await supabase
      .from(DASHBOARD_SESSIONS_TABLE)
      .select('id, email, verified, link_expires_at, otp_expires_at')
      .eq('token_hash', hashToken(rawToken))
      .maybeSingle();
    if (error || !row) return { ok: false, reason: 'invalid_link' };
    if (row.verified) return { ok: false, reason: 'already_used' };
    if (new Date(row.link_expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'link_expired' };
    if (row.otp_expires_at && new Date(row.otp_expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'otp_expired' };
    return { ok: true, email: row.email, linkExpiresAt: row.link_expires_at, otpExpiresAt: row.otp_expires_at };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.getLinkState', err);
    return { ok: false, reason: 'db_error' };
  }
}

/* ------------------------------------------------------------------ */
/* 3. Verify the OTP -> issue the session                              */
/* ------------------------------------------------------------------ */

const OTP_REASONS = {
  invalid_link: 'This link is not valid. Reply *dashboard* on WhatsApp for a fresh one.',
  already_used: 'This link has already been used. Reply *dashboard* on WhatsApp for a fresh one.',
  link_expired: 'This link has expired. Reply *dashboard* on WhatsApp for a fresh one.',
  otp_expired: 'That code has expired. Reply *dashboard* on WhatsApp for a fresh link and code.',
  locked: 'Too many incorrect codes. Reply *dashboard* on WhatsApp for a fresh link and code.',
  otp_mismatch: 'That code did not match. Check the 6-digit code in your email and try again.'
};

export function dashboardOtpReasonCopy(reason) {
  return OTP_REASONS[reason] || 'Something went wrong. Please try again.';
}

export async function verifyDashboardOtp({ supabase, rawToken, otp, now = new Date() } = {}) {
  if (!supabase || !rawToken) return { ok: false, reason: 'invalid_link' };
  const provided = String(otp || '').trim();
  if (!/^\d{6}$/.test(provided)) return { ok: false, reason: 'otp_mismatch' };
  try {
    const { data: row, error } = await supabase
      .from(DASHBOARD_SESSIONS_TABLE)
      .select('*')
      .eq('token_hash', hashToken(rawToken))
      .maybeSingle();
    if (error || !row) return { ok: false, reason: 'invalid_link' };
    if (row.verified) return { ok: false, reason: 'already_used' };
    if (new Date(row.link_expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'link_expired' };
    if (row.otp_expires_at && new Date(row.otp_expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'otp_expired' };

    const attempts = Number(row.attempts || 0);
    if (attempts >= DASHBOARD_MAX_ATTEMPTS) return { ok: false, reason: 'locked' };

    const matches = safeCompareHex(row.otp_hash, hashToken(provided));
    if (!matches) {
      const nextAttempts = attempts + 1;
      try {
        await supabase.from(DASHBOARD_SESSIONS_TABLE).update({ attempts: nextAttempts }).eq('id', row.id);
      } catch (err) {
        logWriteFailure(supabase, 'dashboard.verifyDashboardOtp.attempts', err);
      }
      if (nextAttempts >= DASHBOARD_MAX_ATTEMPTS) {
        await writeAudit(supabase, 'DASHBOARD_OTP_LOCKED', { ownerId: row.owner_id });
        return { ok: false, reason: 'locked' };
      }
      return { ok: false, reason: 'otp_mismatch' };
    }

    // Single-use: stamp verified, burn the OTP hash, mint the session token.
    const sessionToken = mintToken(32);
    const sessionExpiresAt = new Date(now.getTime() + DASHBOARD_SESSION_TTL_MS);
    const { error: updateErr } = await supabase.from(DASHBOARD_SESSIONS_TABLE).update({
      verified: true,
      attempts: attempts + 1,
      otp_hash: null,
      session_token_hash: hashToken(sessionToken),
      session_expires_at: sessionExpiresAt.toISOString()
    }).eq('id', row.id);
    if (updateErr) {
      logWriteFailure(supabase, 'dashboard.verifyDashboardOtp.update', updateErr);
      return { ok: false, reason: 'db_error' };
    }

    await writeAudit(supabase, 'DASHBOARD_SESSION_CREATED', { ownerId: row.owner_id, sessionExpiresAt: sessionExpiresAt.toISOString() });
    return { ok: true, sessionToken, ownerId: row.owner_id, email: row.email, sessionExpiresAt: sessionExpiresAt.toISOString() };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.verifyDashboardOtp', err);
    return { ok: false, reason: 'db_error' };
  }
}

/* ------------------------------------------------------------------ */
/* 4. Session lookup / logout                                          */
/* ------------------------------------------------------------------ */

export async function getSessionByToken({ supabase, sessionToken, now = new Date() } = {}) {
  if (!supabase || !sessionToken) return { ok: false, reason: 'no_session' };
  try {
    const { data: row, error } = await supabase
      .from(DASHBOARD_SESSIONS_TABLE)
      .select('*')
      .eq('session_token_hash', hashToken(sessionToken))
      .maybeSingle();
    if (error || !row) return { ok: false, reason: 'no_session' };
    if (row.verified !== true) return { ok: false, reason: 'no_session' };
    if (!row.session_expires_at || new Date(row.session_expires_at).getTime() <= now.getTime()) {
      return { ok: false, reason: 'session_expired' };
    }
    return { ok: true, ownerId: row.owner_id, email: row.email, session: row, sessionExpiresAt: row.session_expires_at };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.getSessionByToken', err);
    return { ok: false, reason: 'db_error' };
  }
}

export async function clearDashboardSession({ supabase, sessionToken } = {}) {
  if (!supabase || !sessionToken) return { ok: false, reason: 'no_session' };
  try {
    const { error } = await supabase
      .from(DASHBOARD_SESSIONS_TABLE)
      .delete()
      .eq('session_token_hash', hashToken(sessionToken));
    if (error) {
      logWriteFailure(supabase, 'dashboard.clearDashboardSession', error);
      return { ok: false, reason: 'db_error' };
    }
    await writeAudit(supabase, 'DASHBOARD_LOGOUT', {});
    return { ok: true };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.clearDashboardSession', err);
    return { ok: false, reason: 'db_error' };
  }
}

/* ------------------------------------------------------------------ */
/* Housekeeping (boot + every 15 minutes)                              */
/* ------------------------------------------------------------------ */

export async function pruneExpiredDashboardSessions(supabase) {
  if (!supabase) return { ok: false };
  const nowIso = new Date().toISOString();
  const staleLinkCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let removed = 0;
  try {
    // Unverified rows die one day after their link expired; verified rows die
    // with their session. A live 30-day session is never removed by the sweep.
    const links = await supabase
      .from(DASHBOARD_SESSIONS_TABLE)
      .delete()
      .eq('verified', false)
      .lt('link_expires_at', staleLinkCutoff);
    if (!links.error) removed += Number(links.count || 0);
    const sessions = await supabase
      .from(DASHBOARD_SESSIONS_TABLE)
      .delete()
      .eq('verified', true)
      .lt('session_expires_at', nowIso);
    if (!sessions.error) removed += Number(sessions.count || 0);
    return { ok: !links.error && !sessions.error, removed };
  } catch {
    return { ok: false, removed };
  }
}

/* ------------------------------------------------------------------ */
/* Cookie contract (raw token in the cookie, sha256 in the database)   */
/* ------------------------------------------------------------------ */

export function dashboardSessionMaxAgeSeconds() {
  return Math.floor(DASHBOARD_SESSION_TTL_MS / 1000);
}

export function dashboardCookieHeader(rawToken, { secure = true, maxAgeSeconds = dashboardSessionMaxAgeSeconds() } = {}) {
  const parts = [
    `${DASHBOARD_COOKIE_NAME}=${rawToken}`,
    'Path=/d',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function dashboardClearCookieHeader({ secure = true } = {}) {
  const parts = [
    `${DASHBOARD_COOKIE_NAME}=`,
    'Path=/d',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readDashboardCookie(headers = {}) {
  const raw = String(headers?.cookie || '');
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === DASHBOARD_COOKIE_NAME) return rest.join('=') || null;
  }
  return null;
}

/** Cloud Run always terminates HTTPS; localhost (dev/tests) stays plain. */
export function isSecureRequest(request) {
  const host = String(request?.hostname || request?.headers?.host || '').toLowerCase();
  return !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/* ------------------------------------------------------------------ */
/* HTML shell (shared by every dashboard page, Phase 14 reuses it)     */
/* ------------------------------------------------------------------ */

export const DASHBOARD_CSS = `
:root { color-scheme: dark; --ink:#E8E9EB; --muted:#9AA0A6; --card:#141416; --line:#26262B; --accent:#FF7A00; --bad:#F85149; }
* { box-sizing: border-box; }
body { margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#0A0A0C; color:var(--ink); line-height:1.5; }
header.bar { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--line); }
header.bar .brand { font-weight:700; letter-spacing:.4px; }
header.bar a { color:var(--muted); text-decoration:none; font-size:14px; }
main { max-width:960px; margin:0 auto; padding:20px 16px 48px; }
h1 { font-size:22px; margin:8px 0 4px; }
p.muted { color:var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:14px 0; }
input[type=text] { width:100%; padding:14px; font-size:22px; letter-spacing:8px; text-align:center; background:#0F0F11; color:var(--ink); border:1px solid var(--line); border-radius:10px; }
button { width:100%; margin-top:12px; padding:14px; font-size:16px; font-weight:600; color:#0A0A0C; background:var(--accent); border:0; border-radius:10px; cursor:pointer; }
.error { color:var(--bad); font-size:14px; margin-top:10px; }
ul.plain { list-style:none; margin:0; padding:0; }
ul.plain li { padding:10px 0; border-bottom:1px solid var(--line); }
ul.plain li:last-child { border-bottom:0; }
`;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One shell for every dashboard page (D1 — Phase 14 reuses the CSS). */
export function renderPageShell(title, body, { headerRight = '', headerLeft = 'Saka Fleet' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<header class="bar"><span class="brand">🐾 ${escapeHtml(headerLeft)}</span><span>${headerRight}</span></header>
<main>
${body}
</main>
</body>
</html>`;
}

export function renderMessagePage(title, message, { status = 400 } = {}) {
  return {
    status,
    html: renderPageShell(title, `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p>`)
  };
}

export default {
  DASHBOARD_SESSIONS_TABLE,
  DASHBOARD_SQL,
  DASHBOARD_COOKIE_NAME,
  ensureDashboardTable,
  isDashboardTableReady,
  isDashboardEnabled,
  hashToken,
  safeCompareHex,
  mintOtp,
  mintToken,
  dashboardBaseUrl,
  dashboardLinkFor,
  maskEmail,
  requestDashboardAccess,
  getLinkState,
  verifyDashboardOtp,
  dashboardOtpReasonCopy,
  getSessionByToken,
  clearDashboardSession,
  pruneExpiredDashboardSessions,
  dashboardSessionMaxAgeSeconds,
  dashboardCookieHeader,
  dashboardClearCookieHeader,
  readDashboardCookie,
  isSecureRequest,
  renderPageShell,
  renderMessagePage,
  escapeHtml
};
