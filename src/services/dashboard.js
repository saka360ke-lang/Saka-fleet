/**
 * Saka Fleet — Dashboard service (v1.74.0, Phase 13; vehicle pages in v1.75.0)
 * --------------------------------------------------------------------------
 * The web dashboard is the PRIMARY data surface; the PDF stays an export.
 * Phase 13 ships the auth foundation + the overview page; Phase 14A adds the
 * vehicle list and one page per vehicle:
 *
 *   1. WhatsApp "dashboard"  -> requestDashboardAccess() emails ONE message
 *      carrying a magic link (15-min TTL) AND a 6-digit code (10-min TTL).
 *      The code NEVER rides WhatsApp — the two-channel split is the point.
 *   2. GET /d/<token>        -> the OTP entry page.
 *   3. POST /d/verify        -> verifyDashboardOtp() issues a raw session token
 *      that lives ONLY in an HttpOnly cookie; the database stores its sha256.
 *   4. GET /d                -> getSessionByToken() renders the overview card.
 *   5. GET /d/vehicles      -> buildVehiclesIndex() (Phase 14A fleet list).
 *   6. GET /d/vehicles/:id  -> buildVehiclePage() (owner-scoped vehicle page).
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
import { buildFleetReport, upcomingExpiryItems, buildVehicleDirectory, buildVehicleDetail } from './fleetReports.js';
import { buildGlobalContext, formatMoney, formatDate, formatNumber } from './globalization.js';
import { expenseToLedgerRow, earningToLedgerRow, buildLedgerGroups } from './reportLedger.js';
import { buildProReportPdf } from './pdfEngine.js';
import { receiptStoragePaths, RECEIPTS_BUCKET } from './receipts.js';
import { EXPENSE_TYPES } from './expenseCatalog.js';

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
/* 5. Overview card (Phase 13C) — the one page Phase 13 renders        */
/* ------------------------------------------------------------------ */

/**
 * KPIs + six upcoming expiries + five recent activities. Reuses the fleet
 * status builder (the same data the WhatsApp report uses) and the D3 expiry
 * helper. Both dependencies are injectable so suites prove the shaping without
 * a database; production always uses the real builders.
 */
export async function buildOverviewCard({
  supabase,
  ownerId,
  profile = null,
  countryInfo = null,
  now = new Date(),
  buildReport = buildFleetReport,
  loadUpcoming = upcomingExpiryItems
} = {}) {
  if (!supabase || !ownerId) return { ok: false };
  try {
    const ctx = buildGlobalContext(countryInfo, profile);
    const report = await buildReport({ supabase, type: 'fleet', ownerId, countryInfo, profile, now });
    if (!report?.ok) return { ok: false };
    const data = report.data || {};
    const upcoming = await loadUpcoming(supabase, ownerId, 6);
    return {
      ok: true,
      generatedAt: data.generatedAt || now.toISOString(),
      currency: data.currency || ctx.currency,
      locale: ctx.locale,
      timeZone: data.timeZone || ctx.timeZone,
      kpis: {
        spend: Number(data.financial?.expenses?.total || 0),
        earnings: Number(data.financial?.earnings || 0),
        net: Number(data.financial?.net || 0),
        activeVehicles: Number(data.overview?.activeVehicles || 0),
        totalVehicles: Number(data.overview?.totalVehicles || 0)
      },
      upcoming: Array.isArray(upcoming) ? upcoming.slice(0, 6) : [],
      recent: Array.isArray(data.recentActivity) ? data.recentActivity.slice(0, 5) : []
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildOverviewCard', err);
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* 6. Vehicle pages (Phase 14A) — the index and one page per vehicle    */
/* ------------------------------------------------------------------ */

/**
 * Page model for `/d/vehicles`. Thin by design: the fleet-report service owns
 * the data and the shaping; this wrapper only makes the dependency injectable
 * for suites and guarantees a `{ ok:false }` answer instead of a throw.
 */
export async function buildVehiclesIndex({
  supabase,
  ownerId,
  profile = null,
  countryInfo = null,
  now = new Date(),
  loadDirectory = buildVehicleDirectory
} = {}) {
  if (!supabase || !ownerId) return { ok: false };
  try {
    const result = await loadDirectory({ supabase, ownerId, countryInfo, profile, now });
    return result?.ok ? result : { ok: false };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildVehiclesIndex', err);
    return { ok: false };
  }
}

/**
 * Page model for `/d/vehicles/:id`. `not_found` keeps its meaning all the way
 * to the route (404 page), every other failure is a `db_error` (503).
 */
export async function buildVehiclePage({
  supabase,
  ownerId,
  vehicleId,
  profile = null,
  countryInfo = null,
  now = new Date(),
  loadDetail = buildVehicleDetail
} = {}) {
  if (!supabase || !ownerId || !vehicleId) return { ok: false, reason: 'not_found' };
  try {
    const result = await loadDetail({ supabase, ownerId, vehicleId, countryInfo, profile, now });
    if (result?.ok) return result;
    return { ok: false, reason: result?.reason === 'not_found' ? 'not_found' : 'db_error' };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildVehiclePage', err);
    return { ok: false, reason: 'db_error' };
  }
}

/* ------------------------------------------------------------------ */
/* 7. Records surface (Phase 14B) — filters, owner-scoped query,       */
/*    receipt matching, CSV + PDF exports                             */
/* ------------------------------------------------------------------ */

export const RECORDS_PAGE_SIZE = 20;
export const RECORDS_MAX_PAGE = 250;
export const RECORDS_MAX_RANGE_DAYS = 366;
export const RECORDS_DEFAULT_DAYS = 30;
export const RECORDS_MAX_TYPES = 12;
export const RECORDS_MAX_QUERY_CHARS = 40;
export const RECORDS_EXPORT_MAX_ROWS = 2000;
export const RECEIPT_SIGNED_URL_TTL_SECONDS = 300;

const NAIROBI_OFFSET = '+03:00';

/** Today's calendar date in Africa/Nairobi (rule 36 — canonical day). */
export function nairobiDateOf(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(safe);
  } catch {
    return safe.toISOString().slice(0, 10);
  }
}

function addDaysIso(isoDate, days) {
  const base = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return isoDate;
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base.toISOString().slice(0, 10);
}

function nairobiDayStartIso(isoDate) {
  return `${isoDate}T00:00:00${NAIROBI_OFFSET}`;
}

function nairobiNextDayStartIso(isoDate) {
  return new Date(`${addDaysIso(isoDate, 1)}T00:00:00${NAIROBI_OFFSET}`).toISOString();
}

function daysBetweenIso(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** Search terms never carry wildcard/operator characters (PostgREST-safe). */
export function cleanRecordsTerm(value, max = RECORDS_MAX_QUERY_CHARS) {
  return String(value ?? '')
    .replace(/[%,()*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an HTTP query object into the ONE filter spec behind the records
 * table, its CSV export and its PDF export (rule 55 — no way to bypass the
 * filter engine). Defaults: last 30 Nairobi days, all types, every owner
 * vehicle, page 0, 20 rows per page. Never throws.
 */
export function parseRecordsFilters(query = {}, { vehicleIds = [], now = new Date() } = {}) {
  const raw = query && typeof query === 'object' ? query : {};
  const pick = (value) => (Array.isArray(value) ? value[0] : value);

  const toRaw = String(pick(raw.to) || '').trim();
  let to = nairobiDateOf(now);
  if (toRaw) {
    if (!ISO_DATE_RE.test(toRaw) || Number.isNaN(new Date(`${toRaw}T00:00:00Z`).getTime())) {
      return { ok: false, reason: 'bad_to', error: 'That end date does not look right — use YYYY-MM-DD.' };
    }
    to = toRaw;
  }

  const fromRaw = String(pick(raw.from) || '').trim();
  let from = addDaysIso(to, -(RECORDS_DEFAULT_DAYS - 1));
  if (fromRaw) {
    if (!ISO_DATE_RE.test(fromRaw) || Number.isNaN(new Date(`${fromRaw}T00:00:00Z`).getTime())) {
      return { ok: false, reason: 'bad_from', error: 'That start date does not look right — use YYYY-MM-DD.' };
    }
    from = fromRaw;
  }

  if (from > to) return { ok: false, reason: 'bad_range', error: 'The start date is after the end date — swap them and try again.' };
  if (daysBetweenIso(from, to) + 1 > RECORDS_MAX_RANGE_DAYS) {
    return { ok: false, reason: 'range_too_wide', error: `That range is wider than ${RECORDS_MAX_RANGE_DAYS} days — pick a shorter window.` };
  }

  const typeRaw = pick(raw.type) ?? pick(raw.types);
  const types = String(typeRaw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (types.length > RECORDS_MAX_TYPES) {
    return { ok: false, reason: 'too_many_types', error: `That is too many types at once — pick up to ${RECORDS_MAX_TYPES}.` };
  }

  const vehicleRaw = String(pick(raw.vehicle) || '').trim();
  let vehicleId = null;
  if (vehicleRaw) {
    if (!vehicleIds.includes(vehicleRaw)) return { ok: false, reason: 'unknown_vehicle', error: 'That vehicle is not on your fleet.' };
    vehicleId = vehicleRaw;
  }

  const rawLabel = String(pick(raw.label) || '').trim();
  if (rawLabel.length > RECORDS_MAX_QUERY_CHARS) {
    return { ok: false, reason: 'label_too_long', error: `Labels are up to ${RECORDS_MAX_QUERY_CHARS} characters — shorten that one.` };
  }
  const rawKeyword = String(pick(raw.keyword) ?? pick(raw.q) ?? '').trim();
  if (rawKeyword.length > RECORDS_MAX_QUERY_CHARS) {
    return { ok: false, reason: 'keyword_too_long', error: `Search terms are up to ${RECORDS_MAX_QUERY_CHARS} characters — shorten that one.` };
  }

  const pageRaw = Number(pick(raw.page));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 0;
  if (page > RECORDS_MAX_PAGE) {
    return { ok: false, reason: 'page_too_far', error: 'That page is too far back — narrow the dates or search instead.' };
  }

  return {
    ok: true,
    filters: {
      from,
      to,
      types: [...new Set(types)],
      vehicleId,
      label: cleanRecordsTerm(rawLabel),
      keyword: cleanRecordsTerm(rawKeyword),
      page,
      pageSize: RECORDS_PAGE_SIZE
    }
  };
}

/** The owner's live vehicles (id + plate), bounded and fail-soft (rule 50). */
export async function loadOwnerVehicles(supabase, ownerId) {
  if (!supabase || !ownerId) return [];
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('id, plate_number, make_model, status, deleted_at')
      .eq('owner_id', ownerId)
      .is('deleted_at', null)
      .limit(500);
    if (error) {
      logWriteFailure(supabase, 'dashboard.loadOwnerVehicles', error);
      return [];
    }
    return data || [];
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.loadOwnerVehicles', err);
    return [];
  }
}

/** The table's business date: expenses are filed by created_at, earnings by logged_at. */
function recordTimeColumn(table) {
  return table === 'expense_logs' ? 'created_at' : 'logged_at';
}

function applyRecordFilters(query, { table, filters = {}, vehicleIds = [] }) {
  const timeColumn = recordTimeColumn(table);
  let scoped = query
    .gte(timeColumn, nairobiDayStartIso(filters.from))
    .lt(timeColumn, nairobiNextDayStartIso(filters.to));
  if (filters.vehicleId) scoped = scoped.eq('vehicle_id', filters.vehicleId);
  else scoped = scoped.in('vehicle_id', vehicleIds);
  if (table === 'expense_logs' && filters.types?.length) scoped = scoped.in('expense_type', filters.types);
  if (filters.label) scoped = scoped.ilike('label', `%${filters.label}%`);
  if (filters.keyword) scoped = scoped.or(`label.ilike.%${filters.keyword}%,notes.ilike.%${filters.keyword}%`);
  return scoped;
}

/**
 * v1.75.1 (Phase 14B, FIX-1) — the OWNER's records, scoped by VEHICLE.
 *
 * `queryRecordLedger()` (recordQuery.js) filters `driver_id = ownerId`, i.e. it
 * only sees rows the owner personally logged — correct for the per-caller
 * WhatsApp lane, wrong for a fleet owner. This query scopes
 * `vehicle_id IN (owned vehicles)` so owner-logged AND driver-logged rows both
 * appear, and merges the two tables through the canonical ledger row mappers.
 * `recordQuery.js` is deliberately untouched.
 *
 * Pagination: each table is fetched up to `offset + pageSize + 1` rows (via
 * `.range`, D4) and the merged list is sliced — paging each table independently
 * would produce wrong pages because the tables interleave by date (the
 * `listLedgerEntries` precedent).
 */
export async function queryOwnerRecords({
  supabase,
  ownerId = null,
  vehicleIds = [],
  vehicles = [],
  filters = {},
  countryInfo = null,
  profile = null,
  pageSize = RECORDS_PAGE_SIZE,
  offset = null
} = {}) {
  const empty = { ok: false, rows: [], total: 0, hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE, truncated: false };
  if (!supabase) return empty;
  const ids = (vehicleIds || []).filter(Boolean);
  if (!ownerId || ids.length === 0) return { ...empty, ok: true };

  // A type filter only ever names expense types, so earnings leave the set.
  const includeEarnings = !(filters.types?.length > 0);
  const size = Math.max(1, Math.min(RECORDS_EXPORT_MAX_ROWS, Number(pageSize) || RECORDS_PAGE_SIZE));
  // `Number(null) === 0` would silently pin every page to offset 0 — the export
  // offset must be an explicit, finite number to override the page.
  const hasOffset = offset !== null && offset !== undefined && Number.isFinite(Number(offset));
  const start = hasOffset
    ? Math.max(0, Number(offset))
    : Math.max(0, Number(filters.page) || 0) * RECORDS_PAGE_SIZE;
  const perTable = start + size + 1;
  const ctx = buildGlobalContext(countryInfo, profile);
  const plateOf = (vehicleId) => (vehicles || []).find((vehicle) => vehicle.id === vehicleId)?.plate_number || null;

  try {
    const expenseQuery = applyRecordFilters(
      supabase.from('expense_logs').select('*'),
      { table: 'expense_logs', filters, vehicleIds: ids }
    ).order('created_at', { ascending: false }).range(0, perTable - 1);

    const earningQuery = includeEarnings
      ? applyRecordFilters(
          supabase.from('private_earnings').select('*'),
          { table: 'private_earnings', filters, vehicleIds: ids }
        ).order('logged_at', { ascending: false }).range(0, perTable - 1)
      : null;

    const [expenseResult, earningResult] = await Promise.all([
      expenseQuery,
      earningQuery || Promise.resolve({ data: [], error: null })
    ]);
    if (expenseResult.error || earningResult.error) {
      logWriteFailure(supabase, 'dashboard.queryOwnerRecords', expenseResult.error || earningResult.error);
      return { ...empty, page: Math.floor(start / RECORDS_PAGE_SIZE), pageSize: size };
    }

    const counts = await Promise.all([
      applyRecordFilters(
        supabase.from('expense_logs').select('id', { count: 'exact', head: true }),
        { table: 'expense_logs', filters, vehicleIds: ids }
      ),
      includeEarnings
        ? applyRecordFilters(
            supabase.from('private_earnings').select('id', { count: 'exact', head: true }),
            { table: 'private_earnings', filters, vehicleIds: ids }
          )
        : Promise.resolve({ count: 0 })
    ]);
    const total = Number(counts[0]?.count || 0) + Number(counts[1]?.count || 0);

    const normalize = (raw, kind) => {
      const base = kind === 'earning'
        ? earningToLedgerRow(raw, { ctx, vehiclePlate: plateOf(raw.vehicle_id) })
        : expenseToLedgerRow(raw, { ctx, vehiclePlate: plateOf(raw.vehicle_id) });
      return {
        ...base,
        id: raw.id,
        sourceId: raw.id,
        kind,
        vehicleId: raw.vehicle_id || null,
        typeLabel: kind === 'earning' ? (raw.earning_type || 'Earning') : (raw.expense_type || 'Expense'),
        notes: raw.notes || null,
        label: raw.label || null,
        raw
      };
    };

    const merged = [
      ...(expenseResult.data || []).map((row) => normalize(row, 'expense')),
      ...(earningResult.data || []).map((row) => normalize(row, 'earning'))
    ].filter((row) => row.at).sort((a, b) => new Date(b.at) - new Date(a.at));

    const rows = merged.slice(start, start + size);
    return {
      ok: true,
      rows,
      total,
      hasMore: merged.length > start + size,
      page: Math.floor(start / RECORDS_PAGE_SIZE),
      pageSize: size,
      truncated: size >= RECORDS_EXPORT_MAX_ROWS && merged.length > start + size
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.queryOwnerRecords', err);
    return { ...empty, page: Math.floor(start / RECORDS_PAGE_SIZE), pageSize: size };
  }
}

/**
 * D2 — heuristic receipt matching (Phase 14B). A receipt has no FK to the
 * expense that came from the same photo, so the only honest match is: same
 * vehicle + same Nairobi calendar day + equal amount, and it must be UNIQUE.
 * Two or more candidates answer `ambiguous` (the page says so, never guesses).
 * `cache` (a Map) dedupes the query per vehicle+day+amount across a page.
 */
export async function matchReceiptForExpense({ supabase, vehicleId = null, amount = null, day = null, cache = null } = {}) {
  const none = { status: 'none', receipt: null, count: 0 };
  if (!supabase || !vehicleId || !day) return none;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return none;
  const key = `${vehicleId}|${day}|${numeric}`;
  if (cache && cache.has(key)) return cache.get(key);
  try {
    const { data, error } = await supabase
      .from('receipts')
      .select('id, vehicle_id, amount, image_url, media_id, vendor, created_at')
      .eq('vehicle_id', vehicleId)
      .eq('amount', numeric)
      .gte('created_at', nairobiDayStartIso(day))
      .lt('created_at', nairobiNextDayStartIso(day))
      .limit(10);
    if (error) {
      logWriteFailure(supabase, 'dashboard.matchReceiptForExpense', error);
      return none;
    }
    const matches = data || [];
    const result = matches.length === 1
      ? { status: 'unique', receipt: matches[0], count: 1 }
      : matches.length > 1
        ? { status: 'ambiguous', receipt: null, count: matches.length }
        : none;
    if (cache) cache.set(key, result);
    return result;
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.matchReceiptForExpense', err);
    return none;
  }
}

/** Attach a receipt status to every expense row of one page (shared cache). */
export async function attachReceiptMatches({ supabase, rows = [] } = {}) {
  const cache = new Map();
  const out = [];
  for (const row of rows || []) {
    if (row.kind !== 'expense' || !row.vehicleId || !row.at) {
      out.push({ ...row, receiptStatus: 'none', receiptId: null });
      continue;
    }
    const match = await matchReceiptForExpense({
      supabase,
      vehicleId: row.vehicleId,
      amount: row.amount,
      day: nairobiDateOf(row.at),
      cache
    });
    out.push({ ...row, receiptStatus: match.status, receiptId: match.receipt?.id || null });
  }
  return out;
}

/**
 * D1 — a short-lived storage link, minted per request and scoped to a row the
 * caller already proved they own. 300 s by contract; the object path comes from
 * `receiptStoragePaths()` (media_id first), so a signed URL never depends on the
 * stored public URL — which stops working once the bucket is private.
 */
export async function signReceiptUrl(supabase, receipt = {}, { ttlSeconds = RECEIPT_SIGNED_URL_TTL_SECONDS } = {}) {
  if (!supabase || !receipt) return { ok: false, reason: 'not_found' };
  const paths = receiptStoragePaths(receipt);
  if (!paths.length) return { ok: false, reason: 'no_image' };
  try {
    const storage = supabase.storage?.from?.(RECEIPTS_BUCKET);
    if (!storage?.createSignedUrl) return { ok: false, reason: 'no_storage' };
    const { data, error } = await storage.createSignedUrl(paths[0], ttlSeconds);
    if (error || !data?.signedUrl) return { ok: false, reason: 'sign_failed' };
    return { ok: true, url: data.signedUrl, ttlSeconds };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.signReceiptUrl', err);
    return { ok: false, reason: 'sign_failed' };
  }
}

export const RECORDS_CSV_COLUMNS = Object.freeze([
  'Date', 'Kind', 'Plate', 'Type', 'Description', 'Odometer', 'Unit Cost', 'Amount', 'Currency', 'Label'
]);

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

/**
 * CSV export of the filtered set (Phase 14B). The only serializer in the repo,
 * so it stays pure and dependency-free: BOM (Excel-safe), CRLF rows, RFC-4180
 * quoting, ISO-8601 dates (canonical storage, rule 36) and the owner currency.
 */
export function serializeRecordsCsv(rows = [], { currency = 'USD' } = {}) {
  const lines = [RECORDS_CSV_COLUMNS.join(',')];
  for (const row of rows || []) {
    lines.push([
      csvCell(row.at ? new Date(row.at).toISOString() : ''),
      csvCell(row.kind === 'earning' ? 'earning' : 'expense'),
      csvCell(row.vehicle || ''),
      csvCell(row.typeLabel || ''),
      csvCell(row.description || ''),
      csvCell(csvNumber(row.odometer)),
      csvCell(csvNumber(row.unitCost)),
      csvCell(csvNumber(row.amount)),
      csvCell(currency),
      csvCell(row.label || '')
    ].join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * PDF export of the filtered set: the SAME merged rows the table shows, fed
 * through the canonical ledger builder and the Apex engine. Returns a Buffer —
 * no Storage upload and no email (the route streams it, D-export).
 */
export async function buildRecordsPdf(rows = [], filters = {}, {
  profile = null,
  countryInfo = null,
  vehicles = [],
  truncated = false,
  useStandardFonts = false
} = {}) {
  const ctx = buildGlobalContext(countryInfo, profile);
  const list = rows || [];
  const expenses = list.filter((row) => row.kind !== 'earning').map((row) => row.raw).filter(Boolean);
  const earnings = list.filter((row) => row.kind === 'earning').map((row) => row.raw).filter(Boolean);
  const period = `${filters.from || ''} – ${filters.to || ''}`.trim();
  const ledger = buildLedgerGroups({
    expenses,
    earnings,
    vehicles,
    ctx,
    includeEarnings: true,
    includeVehicle: vehicles.length > 1,
    title: 'Records',
    subtitle: period || null,
    footnote: truncated
      ? `Showing the newest ${list.length} records — narrow the dates for a complete export.`
      : `All ${list.length} record(s) in this filter are shown — nothing hidden.`
  });
  const money = (value) => formatMoney(value, ctx.currency, ctx.locale);
  const spend = ledger.totals.expenseTotal;
  const earned = ledger.totals.earningTotal;
  const net = ledger.totals.net;
  return buildProReportPdf({
    title: 'Records & Ledger',
    subtitle: `${period} · ${list.length} record(s)`,
    reportType: 'financial',
    periodLabel: period || 'Selected period',
    // Same fonts as every report (branded); suites opt into standard fonts to
    // read the drawn text back, exactly like test_pdf_engine.
    useStandardFonts,
    generatedAt: new Date().toLocaleString('en-GB', { timeZone: ctx.timeZone }),
    owner: profile
      ? {
          name: profile.full_name || 'Fleet owner',
          email: profile.email || '',
          phone: profile.phone_number || '',
          language: profile.preferred_language || 'English',
          plan: profile.plan || null
        }
      : null,
    drivers: [],
    kpis: [
      { label: 'Total spend', value: money(spend), hint: 'in this filter', tone: 'negative' },
      { label: 'Earnings', value: money(earned), hint: earned > 0 ? 'in this filter' : 'none recorded', ...(earned > 0 ? { tone: 'positive' } : {}) },
      { label: 'Net', value: money(net), hint: 'earnings - spend', ...(net > 0 ? { tone: 'positive' } : (net < 0 ? { tone: 'negative' } : {})) },
      { label: 'Records', value: String(list.length), hint: truncated ? 'newest shown' : 'all in this filter' }
    ],
    ledgers: [ledger],
    notes: ['Figures are engine-calculated from your own ledger — nothing is estimated.']
  });
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
main a { color:var(--accent); text-decoration:none; }
main a:hover { text-decoration:underline; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:14px 0; }
h2 { font-size:16px; margin:22px 0 8px; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; }
.kpi .label { color:var(--muted); font-size:13px; }
.kpi .value { font-size:20px; font-weight:700; margin-top:2px; word-break:break-word; }
.chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
.chip.due { color:var(--accent); border-color:var(--accent); }
.chip.ok { color:#3FB950; border-color:#2E6B39; }
input[type=text] { width:100%; padding:14px; font-size:22px; letter-spacing:8px; text-align:center; background:#0F0F11; color:var(--ink); border:1px solid var(--line); border-radius:10px; }
button { width:100%; margin-top:12px; padding:14px; font-size:16px; font-weight:600; color:#0A0A0C; background:var(--accent); border:0; border-radius:10px; cursor:pointer; }
.error { color:var(--bad); font-size:14px; margin-top:10px; }
ul.plain { list-style:none; margin:0; padding:0; }
ul.plain li { padding:10px 0; border-bottom:1px solid var(--line); }
ul.plain li:last-child { border-bottom:0; }
/* Phase 14B — the records filters + table. Placed after the OTP input rule so a
   filter text box is a normal box, never the giant one-time-code field. */
.filters { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; align-items:end; }
.filters label { color:var(--muted); font-size:13px; display:flex; flex-direction:column; gap:4px; }
.filters input, .filters select { width:100%; padding:9px 10px; font-size:14px; letter-spacing:normal; text-align:left; background:#0F0F11; color:var(--ink); border:1px solid var(--line); border-radius:8px; }
.filters button { width:auto; margin-top:0; padding:10px 16px; font-size:14px; }
.filters-actions { display:flex; align-items:center; gap:12px; }
.table-wrap { overflow-x:auto; padding:0; }
table.rec { width:100%; border-collapse:collapse; font-size:13px; }
table.rec th { text-align:left; color:var(--muted); font-weight:600; font-size:12px; padding:10px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
table.rec td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
table.rec tr:last-child td { border-bottom:0; }
table.rec td.num, table.rec th.num { text-align:right; white-space:nowrap; }
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

/* ------------------------------------------------------------------ */
/* Page renderers (Phase 13C) — inline HTML, no static server (D1)     */
/* ------------------------------------------------------------------ */

export function renderOtpPage({ token, emailMasked, error = null }) {
  const otpMinutes = Math.max(1, Math.round(DASHBOARD_OTP_TTL_MS / 60000));
  const body = `
<h1>Check your email</h1>
<p class="muted">I emailed a 6-digit code to <strong>${escapeHtml(emailMasked)}</strong>. Enter it below to open your dashboard.</p>
<div class="card">
  <form method="POST" action="/d/verify" autocomplete="off">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input type="text" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" aria-label="6-digit code" required>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <button type="submit">Open my dashboard</button>
  </form>
  <p class="muted" style="font-size:13px;margin-top:12px;">The code works for ${otpMinutes} minutes. Never share it with anyone — Saka will never ask you for it in WhatsApp.</p>
</div>`;
  return renderPageShell('Verify your email', body);
}

const EXPIRY_LABELS = {
  insurance: 'Insurance',
  inspection: 'Inspection',
  licensing: 'Road licence',
  permit: 'Permit',
  driver_license: 'Driver licence',
  maintenance: 'Maintenance',
  deadline: 'Deadline',
  other: 'Document'
};

function daysLabel(daysLeft) {
  if (daysLeft === 0) return 'today';
  return `in ${daysLeft} d`;
}

/** The four destinations every signed-in page offers (Phase 14B adds Records). */
function dashboardNav() {
  return '<a href="/d">Overview</a> · <a href="/d/vehicles">Vehicles</a> · <a href="/d/records">Records</a> · <a href="/d/logout">Log out</a>';
}

/** Active / paused / inactive — a chip, never a raw database enum. */
function vehicleStatusChip(vehicle) {
  if (vehicle?.active) return '<span class="chip ok">Active</span>';
  const raw = String(vehicle?.status || '').toLowerCase();
  const label = raw === 'paused' ? 'Paused' : raw === 'deleted' ? 'Deleted' : 'Inactive';
  return `<span class="chip">${escapeHtml(label)}</span>`;
}

/** "in 3 d" / "today" / "expired 2 d ago" — the document chip. */
function dueChip(doc) {
  const days = doc?.daysLeft;
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return '';
  const numeric = Number(days);
  const text = numeric < 0 ? `expired ${Math.abs(numeric)} d ago` : daysLabel(numeric);
  return `<span class="chip${numeric <= 7 ? ' due' : ''}">${escapeHtml(text)}</span>`;
}

/** The one Phase 13 page: KPIs, six upcoming expiries, five recent rows. */
export function renderOverviewPage({ data, emailMasked }) {
  if (!data?.ok) {
    return renderErrorPage(503, 'Your overview could not be loaded just now. Please try again in a moment.').html;
  }
  const money = (value) => formatMoney(value, data.currency, data.locale);
  const when = formatDate(data.generatedAt, data.locale, { timeZone: data.timeZone });
  const kpis = `
  <div class="kpis card">
    <div class="kpi"><div class="label">Spend</div><div class="value">${escapeHtml(money(data.kpis.spend))}</div></div>
    <div class="kpi"><div class="label">Earnings</div><div class="value">${escapeHtml(money(data.kpis.earnings))}</div></div>
    <div class="kpi"><div class="label">Net</div><div class="value">${escapeHtml(money(data.kpis.net))}</div></div>
    <div class="kpi"><div class="label">Active vehicles</div><div class="value">${data.kpis.activeVehicles} of ${data.kpis.totalVehicles}</div></div>
  </div>`;

  const upcoming = data.upcoming.length
    ? `<ul class="plain">${data.upcoming.map((item) => `
      <li>${escapeHtml(item.plate)} • ${escapeHtml(EXPIRY_LABELS[item.category] || item.category)} • ${escapeHtml(formatDate(item.dueDate, data.locale, { timeZone: data.timeZone }))}
        <span class="chip${item.daysLeft <= 7 ? ' due' : ''}">${escapeHtml(daysLabel(item.daysLeft))}</span></li>`).join('')}
    </ul>`
    : '<p class="muted">Nothing due in the coming weeks — nicely kept.</p>';

  const recent = data.recent.length
    ? `<ul class="plain">${data.recent.map((item) => `
      <li>${escapeHtml(item.label)} <span class="chip">${escapeHtml(formatDate(item.at, data.locale, { timeZone: data.timeZone }))}</span></li>`).join('')}
    </ul>`
    : '<p class="muted">No activity yet — log your first entry in WhatsApp and it appears here.</p>';

  const body = `
<h1>Your fleet at a glance</h1>
<p class="muted">Signed in as ${escapeHtml(emailMasked)} • updated ${escapeHtml(when)}</p>
${kpis}
<p class="muted"><a href="/d/vehicles">See your vehicles →</a></p>
<h2>Coming up</h2>
<div class="card">${upcoming}</div>
<h2>Recent activity</h2>
<div class="card">${recent}</div>
<p class="muted" style="font-size:13px;">Your PDF reports are still one message away in WhatsApp.</p>`;
  return renderPageShell('Your dashboard', body, {
    headerRight: dashboardNav()
  });
}

/**
 * `/d/vehicles` (Phase 14A) — one row per vehicle: plate + model, status,
 * odometer, driver, this month's spend and the soonest document due.
 */
export function renderVehiclesPage({ data, emailMasked }) {
  if (!data?.ok) {
    return renderErrorPage(503, 'Your vehicles could not be loaded just now. Please try again in a moment.').html;
  }
  const money = (value) => formatMoney(value, data.currency, data.locale);
  const when = formatDate(data.generatedAt, data.locale, { timeZone: data.timeZone });
  const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
  const rows = vehicles.length
    ? `<ul class="plain">${vehicles.map((vehicle) => {
        const facts = [
          `${formatNumber(vehicle.odometer, data.locale)} ${vehicle.distanceUnit}`,
          vehicle.driverName ? `Driver: ${vehicle.driverName}` : 'No driver assigned',
          `${money(vehicle.monthSpend)} this month`
        ];
        return `
      <li>
        <a href="/d/vehicles/${encodeURIComponent(vehicle.id)}"><strong>${escapeHtml(vehicle.plate)}</strong></a>${vehicle.makeModel ? `<span class="muted"> · ${escapeHtml(vehicle.makeModel)}</span>` : ''}
        <div class="muted" style="font-size:13px;margin-top:4px;">
          ${vehicleStatusChip(vehicle)}
          ${escapeHtml(facts.join(' • '))}
          ${vehicle.overdueCount ? `<span class="chip due">${escapeHtml(`${vehicle.overdueCount} overdue`)}</span>` : ''}
          ${vehicle.soonest ? dueChip(vehicle.soonest) : ''}
        </div>
      </li>`;
      }).join('')}</ul>`
    : '<p class="muted">No vehicles yet — register your first one in WhatsApp and it appears here.</p>';

  const body = `
<h1>Your vehicles</h1>
<p class="muted">${vehicles.length} ${vehicles.length === 1 ? 'vehicle' : 'vehicles'} • signed in as ${escapeHtml(emailMasked)} • updated ${escapeHtml(when)}</p>
<div class="card">${rows}</div>
<p class="muted" style="font-size:13px;">Tap a vehicle for its documents and recent records.</p>`;
  return renderPageShell('Your vehicles', body, { headerRight: dashboardNav() });
}

/**
 * `/d/vehicles/:id` (Phase 14A) — identity + this month's money, every document
 * tracked for the vehicle, then its most recent ledger rows.
 */
export function renderVehiclePage({ data, emailMasked }) {
  if (!data?.ok || !data.vehicle) {
    return renderErrorPage(503, 'This vehicle could not be loaded just now. Please try again in a moment.').html;
  }
  const money = (value) => formatMoney(value, data.currency, data.locale);
  const when = formatDate(data.generatedAt, data.locale, { timeZone: data.timeZone });
  const vehicle = data.vehicle;
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const records = Array.isArray(data.records) ? data.records : [];

  const identity = `
  <div class="kpis card">
    <div class="kpi"><div class="label">Odometer</div><div class="value">${escapeHtml(`${formatNumber(vehicle.odometer, data.locale)} ${vehicle.distanceUnit}`)}</div></div>
    <div class="kpi"><div class="label">Spend this month</div><div class="value">${escapeHtml(money(vehicle.monthSpend))}</div></div>
    <div class="kpi"><div class="label">Earnings this month</div><div class="value">${escapeHtml(money(vehicle.monthEarnings))}</div></div>
  </div>`;

  const documentList = documents.length
    ? `<ul class="plain">${documents.map((doc) => `
      <li>${escapeHtml(doc.label)}
        <span class="chip">${escapeHtml(formatDate(doc.dueDate, data.locale, { timeZone: data.timeZone }))}</span>
        ${dueChip(doc)}</li>`).join('')}
    </ul>`
    : '<p class="muted">No documents on file yet — tell me an expiry in WhatsApp and I will track it.</p>';

  const recordList = records.length
    ? `<ul class="plain">${records.map((row) => `
      <li>${escapeHtml(row.description)} <strong>${escapeHtml(money(row.amount))}</strong>
        <span class="chip">${escapeHtml(formatDate(row.at, data.locale, { timeZone: data.timeZone }))}</span></li>`).join('')}
    </ul>`
    : '<p class="muted">No records in this vehicle yet — log fuel, a repair or an earning in WhatsApp.</p>';

  const subtitle = [
    vehicle.makeModel || null,
    vehicle.driverName ? `Driver: ${vehicle.driverName}` : 'No driver assigned',
    `updated ${when}`
  ].filter(Boolean).map((part) => escapeHtml(part)).join(' • ');

  const body = `
<p class="muted"><a href="/d/vehicles">← All vehicles</a></p>
<h1>${escapeHtml(vehicle.plate)} ${vehicleStatusChip(vehicle)}</h1>
<p class="muted">${subtitle}</p>
${identity}
<h2>Documents</h2>
<div class="card">${documentList}</div>
<h2>Recent records</h2>
<div class="card">${recordList}</div>
<p class="muted" style="font-size:13px;">Your PDF reports are still one message away in WhatsApp.</p>`;
  return renderPageShell(`${vehicle.plate} — your vehicle`, body, { headerRight: dashboardNav() });
}

/** Serialise the filter spec back into a shareable query string. */
export function recordsQueryString(filters = {}, overrides = {}) {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (merged.from) params.set('from', merged.from);
  if (merged.to) params.set('to', merged.to);
  if (merged.types?.length) params.set('type', merged.types.join(','));
  if (merged.vehicleId) params.set('vehicle', merged.vehicleId);
  if (merged.label) params.set('label', merged.label);
  if (merged.keyword) params.set('keyword', merged.keyword);
  if (merged.page) params.set('page', String(merged.page));
  return params.toString();
}

/**
 * `/d/records` (Phase 14B) — the filterable ledger table. Every filter lives in
 * the URL (shareable, back-button safe) and is re-sent by the pagination and
 * export links, so the table, the CSV and the PDF can never diverge.
 */
export function renderRecordsPage({ data, filters = {}, vehicles = [], emailMasked = '', error = null }) {
  if (!data?.ok) {
    return renderErrorPage(503, 'Your records could not be loaded just now. Please try again in a moment.').html;
  }
  const money = (value) => formatMoney(value, data.currency || 'USD', data.locale);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const total = Number(data.total || 0);
  const page = Number(data.page || 0);
  const pageSize = Number(data.pageSize || RECORDS_PAGE_SIZE);
  const firstRow = rows.length ? page * RECORDS_PAGE_SIZE + 1 : 0;
  const lastRow = rows.length ? page * RECORDS_PAGE_SIZE + rows.length : 0;

  const typeOptions = EXPENSE_TYPES.map((type) => type.value)
    .filter((value, index, list) => value && list.indexOf(value) === index)
    .map((value) => `<option value="${escapeHtml(value)}"${filters.types?.includes(value) ? ' selected' : ''}>${escapeHtml(value)}</option>`)
    .join('');
  const vehicleOptions = (vehicles || [])
    .map((vehicle) => `<option value="${escapeHtml(vehicle.id)}"${filters.vehicleId === vehicle.id ? ' selected' : ''}>${escapeHtml(vehicle.plate_number || 'Fleet vehicle')}</option>`)
    .join('');

  const form = `
<form method="GET" action="/d/records" class="filters card">
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <label>From<input type="date" name="from" value="${escapeHtml(filters.from || '')}"></label>
  <label>To<input type="date" name="to" value="${escapeHtml(filters.to || '')}"></label>
  <label>Type<select name="type"><option value="">All types</option>${typeOptions}</select></label>
  <label>Vehicle<select name="vehicle"><option value="">All vehicles</option>${vehicleOptions}</select></label>
  <label>Label<input type="text" name="label" maxlength="${RECORDS_MAX_QUERY_CHARS}" value="${escapeHtml(filters.label || '')}" placeholder="karen run"></label>
  <label>Search<input type="text" name="keyword" maxlength="${RECORDS_MAX_QUERY_CHARS}" value="${escapeHtml(filters.keyword || '')}" placeholder="notes or vendor"></label>
  <div class="filters-actions">
    <button type="submit">Apply filters</button>
    <a href="/d/records">Clear</a>
  </div>
</form>`;

  const tableRows = rows.map((row) => {
    const receipt = row.receiptStatus === 'unique'
      ? `<a href="/d/receipt/${encodeURIComponent(row.receiptId)}">View</a>`
      : row.receiptStatus === 'ambiguous'
        ? '<span class="muted">Multiple match</span>'
        : '<span class="muted">—</span>';
    return `
      <tr>
        <td>${escapeHtml(formatDate(row.at, data.locale, { timeZone: data.timeZone }))}</td>
        <td><span class="chip">${escapeHtml(row.kindLabel || row.kind || '')}</span></td>
        <td>${escapeHtml(row.vehicle || '—')}</td>
        <td>${escapeHtml(row.description || '')}</td>
        <td class="num">${escapeHtml(money(row.amount))}</td>
        <td>${receipt}</td>
      </tr>`;
  }).join('');

  const table = rows.length
    ? `<div class="card table-wrap">
        <table class="rec">
          <thead><tr><th>Date</th><th>Kind</th><th>Vehicle</th><th>Description</th><th class="num">Amount</th><th>Receipt</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`
    : '<div class="card"><p class="muted">Nothing in these filters — widen the dates or clear the search.</p></div>';

  const base = recordsQueryString(filters, { page: 0 });
  const exports = `
<p class="muted" style="font-size:13px;">
  Export this filter:
  <a href="/d/records.csv?${escapeHtml(base)}">CSV</a> ·
  <a href="/d/records.pdf?${escapeHtml(base)}">PDF</a>
</p>`;

  const pager = [];
  if (page > 0) pager.push(`<a href="/d/records?${escapeHtml(recordsQueryString(filters, { page: page - 1 }))}">← Newer</a>`);
  if (data.hasMore) pager.push(`<a href="/d/records?${escapeHtml(recordsQueryString(filters, { page: page + 1 }))}">Older →</a>`);

  const body = `
<h1>Records</h1>
<p class="muted">${total} record${total === 1 ? '' : 's'} · signed in as ${escapeHtml(emailMasked)} · ${rows.length ? `showing ${firstRow}–${lastRow}` : 'nothing to show'}</p>
${form}
${table}
${rows.length ? `<p class="muted" style="font-size:13px;">Page ${page + 1}${data.hasMore ? '' : ' (last page)'} · ${pageSize} per page</p>` : ''}
${pager.length ? `<p class="muted">${pager.join(' · ')}</p>` : ''}
${exports}`;
  return renderPageShell('Records', body, { headerRight: dashboardNav() });
}

/** `/d/receipt/:id` answers with a short-lived redirect to the stored image. */
export function renderReceiptPage({ signedUrl } = {}) {
  if (!signedUrl) return renderErrorPage(404, 'That receipt has no stored image.');
  return { status: 302, location: signedUrl };
}

export function renderLogoutPage() {
  const body = `
<h1>You're logged out</h1>
<p class="muted">This browser no longer has access. Reply <strong>dashboard</strong> on WhatsApp any time for a fresh link.</p>`;
  return renderPageShell('Logged out', body);
}

const ERROR_TITLES = {
  400: 'Link not available',
  401: 'Open your dashboard from WhatsApp',
  404: 'Not found',
  410: 'Link expired',
  500: 'Something went wrong',
  503: 'Please try again shortly'
};

export function renderErrorPage(status = 400, message = 'Please try again.') {
  const title = ERROR_TITLES[status] || 'Link not available';
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
  escapeHtml,
  renderOtpPage,
  renderOverviewPage,
  renderVehiclesPage,
  renderVehiclePage,
  renderRecordsPage,
  renderReceiptPage,
  renderLogoutPage,
  renderErrorPage,
  buildOverviewCard,
  buildVehiclesIndex,
  buildVehiclePage,
  parseRecordsFilters,
  cleanRecordsTerm,
  nairobiDateOf,
  loadOwnerVehicles,
  queryOwnerRecords,
  matchReceiptForExpense,
  attachReceiptMatches,
  signReceiptUrl,
  serializeRecordsCsv,
  buildRecordsPdf,
  recordsQueryString
};
