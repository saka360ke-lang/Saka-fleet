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
import { isSuperadminPhone } from './superadminIdentity.js';
import { buildFleetReport, upcomingExpiryItems, buildVehicleDirectory, buildVehicleDetail } from './fleetReports.js';
import { buildComplianceReport, expiryStatus, summarizeCategory } from './fleetReports.js';
import { buildGlobalContext, formatMoney, formatDate, formatNumber, detectCountryFromPhone } from './globalization.js';
import { buildDriverComplianceCard, buildDriverDaybook } from './driverReports.js';
import { expenseToLedgerRow, earningToLedgerRow, buildLedgerGroups } from './reportLedger.js';
import { buildProReportPdf } from './pdfEngine.js';
import { complianceReportToPdf } from './reportDelivery.js';
import { buildCustomReport, dateRangeBounds, CUSTOM_METRICS, CUSTOM_METRIC_CATEGORIES, metricsForAccess } from './reportMetrics.js';
import { getTierLabel } from './subscriptionTiers.js';
import { receiptStoragePaths, RECEIPTS_BUCKET } from './receipts.js';
import { EXPENSE_TYPES } from './expenseCatalog.js';
import { driverComplianceLabel } from './driverComplianceCatalog.js';
import { daysUntilDue } from './maintenanceReminders.js';
import { buildTyreWearRows, buildCostPerKmTrend, buildCostPerKmChart, getTyreLifespanKm } from './vehicleAnalytics.js';

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
-- v1.76.0 (Phase 15) — one additive column carries the session's role. Old rows
-- default to 'owner', so nothing existing needs a backfill (rule 56).
ALTER TABLE public.${DASHBOARD_SESSIONS_TABLE} ADD COLUMN IF NOT EXISTS session_role text NOT NULL DEFAULT 'owner';
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_owner ON public.${DASHBOARD_SESSIONS_TABLE} (owner_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_link_expires ON public.${DASHBOARD_SESSIONS_TABLE} (link_expires_at DESC);
ALTER TABLE public.${DASHBOARD_SESSIONS_TABLE} ENABLE ROW LEVEL SECURITY;
`;

/** The three dashboard lanes (Phase 15). One session belongs to exactly one. */
export const DASHBOARD_ROLES = Object.freeze(['owner', 'driver', 'admin']);

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

/** A live assignment is the driver's eligibility (D1). null = database error. */
async function hasLiveDriverAssignment(supabase, driverId) {
  if (!supabase || typeof supabase.from !== 'function' || !driverId) return false;
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('id')
      .eq('assigned_driver_id', driverId)
      .is('deleted_at', null)
      .limit(1);
    if (error) return null;
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.hasLiveDriverAssignment', err);
    return null;
  }
}

/**
 * Phase 15 — which dashboard lane is this caller? `admin > owner > driver`,
 * mirroring `resolveReportAccess`, so a dual-role profile lands in the OWNER
 * lane. Never throws; a database failure degrades to the owner lane (which is
 * still gated by its own plan check).
 */
export async function resolveDashboardRole({ supabase, profile = null } = {}) {
  const isAdmin = isSuperadminPhone(profile?.phone_number);
  if (!supabase || typeof supabase.from !== 'function' || !profile?.id) {
    return { role: isAdmin ? 'admin' : 'owner', isOwner: false, isDriver: false, isAdmin };
  }
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('id, owner_id, assigned_driver_id')
      .or(`owner_id.eq.${profile.id},assigned_driver_id.eq.${profile.id}`)
      .is('deleted_at', null)
      .limit(50);
    if (error) {
      logWriteFailure(supabase, 'dashboard.resolveDashboardRole', error);
      return { role: isAdmin ? 'admin' : 'owner', isOwner: false, isDriver: false, isAdmin, dbError: true };
    }
    const rows = data || [];
    const isOwner = rows.some((vehicle) => vehicle.owner_id === profile.id);
    const isDriver = rows.some((vehicle) => vehicle.assigned_driver_id === profile.id);
    const role = isAdmin ? 'admin' : (isOwner ? 'owner' : (isDriver ? 'driver' : 'owner'));
    return { role, isOwner, isDriver, isAdmin };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.resolveDashboardRole', err);
    return { role: isAdmin ? 'admin' : 'owner', isOwner: false, isDriver: false, isAdmin, dbError: true };
  }
}

/**
 * Eligibility: a verified email plus, per role, an OWNER's live trial/paid plan,
 * a DRIVER's live assignment, or the env superadmin identity. Never throws.
 */
export async function requestDashboardAccess({
  supabase,
  ownerId,
  profile = null,
  entitlements = null,
  countryInfo = null,
  role = 'owner',
  sendEmail = sendDashboardMagicLinkEmail,
  now = new Date()
} = {}) {
  if (!isDashboardEnabled()) return { ok: false, reason: 'flag_off' };
  if (!supabase || !ownerId) return { ok: false, reason: 'db_error' };
  if (!DASHBOARD_ROLES.includes(role)) return { ok: false, reason: 'bad_role' };

  const email = String(profile?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };
  if (profile?.email_verified !== true) return { ok: false, reason: 'email_unverified' };
  // Phase 15 — the plan gate is an OWNER gate. A driver is an employee (D1: a
  // live assignment is the eligibility), and an admin is the env identity.
  if (role === 'owner' && (!entitlements || (!entitlements.isTrial && !entitlements.isPaid))) {
    return { ok: false, reason: 'not_entitled' };
  }
  if (role === 'admin' && !isSuperadminPhone(profile?.phone_number)) {
    return { ok: false, reason: 'not_admin' };
  }
  if (role === 'driver') {
    const assignment = await hasLiveDriverAssignment(supabase, ownerId);
    if (assignment === null) return { ok: false, reason: 'db_error' };
    if (!assignment) return { ok: false, reason: 'no_assignment' };
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
      session_role: role,
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

    await writeAudit(supabase, 'DASHBOARD_ACCESS_REQUESTED', { ownerId, email, role, linkExpiresAt: linkExpiresAt.toISOString() });
    return { ok: true, role, link, email, linkExpiresAt: linkExpiresAt.toISOString(), otpExpiresAt: otpExpiresAt.toISOString() };
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

    // v1.76.0 (Phase 15) — re-check the role claim at verify time: a token
    // minted as admin/driver is only honoured while the identity/assignment
    // still holds. Nothing is stamped until both checks pass.
    const sessionRole = DASHBOARD_ROLES.includes(row.session_role) ? row.session_role : 'owner';
    if (sessionRole === 'admin' || sessionRole === 'driver') {
      const { data: profileRow } = await supabase
        .from('profiles')
        .select('id, phone_number')
        .eq('id', row.owner_id)
        .maybeSingle();
      if (!profileRow) return { ok: false, reason: 'db_error' };
      if (sessionRole === 'admin' && !isSuperadminPhone(profileRow.phone_number)) {
        return { ok: false, reason: 'not_admin' };
      }
      if (sessionRole === 'driver') {
        const assignment = await hasLiveDriverAssignment(supabase, row.owner_id);
        if (assignment === null) return { ok: false, reason: 'db_error' };
        if (!assignment) return { ok: false, reason: 'no_assignment' };
      }
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

    await writeAudit(supabase, 'DASHBOARD_SESSION_CREATED', { ownerId: row.owner_id, role: sessionRole, sessionExpiresAt: sessionExpiresAt.toISOString() });
    return { ok: true, sessionToken, ownerId: row.owner_id, email: row.email, role: sessionRole, sessionExpiresAt: sessionExpiresAt.toISOString() };
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
    // Old rows (pre-1.76.0) have no session_role → the owner lane (rule 56).
    const role = DASHBOARD_ROLES.includes(row.session_role) ? row.session_role : 'owner';
    return { ok: true, ownerId: row.owner_id, email: row.email, role, session: row, sessionExpiresAt: row.session_expires_at };
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
      .select('id, plate_number, make_model, status, deleted_at, assigned_driver_id')
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
/* 8. Compliance surface (Phase 14C) — board, driver page, filtered PDF */
/* ------------------------------------------------------------------ */

export const COMPLIANCE_VIEWS = Object.freeze(['all', 'due', 'expired']);
export const COMPLIANCE_DUE_DAYS = 30;

const COMPLIANCE_VIEW_ALIASES = Object.freeze({
  all: 'all',
  due: 'due',
  due_soon: 'due',
  'due-soon': 'due',
  soon: 'due',
  expired: 'expired',
  overdue: 'expired'
});

/** `?view=all|due|expired` (default all). Never throws. */
export function parseComplianceFilters(query = {}) {
  const raw = query && typeof query === 'object' ? query : {};
  const value = String(Array.isArray(raw.view) ? raw.view[0] : raw.view || '').trim().toLowerCase();
  if (!value) return { ok: true, filters: { view: 'all' } };
  const view = COMPLIANCE_VIEW_ALIASES[value];
  if (!view) {
    return { ok: false, reason: 'bad_view', error: 'That filter is not one I know — choose All, Due soon or Expired.' };
  }
  return { ok: true, filters: { view } };
}

/**
 * The ONE view predicate — used by the filtered report (HTML + PDF) and by the
 * driver rollup, so a chip and an export can never disagree (rule 55).
 */
export function complianceInView(daysLeft, view = 'all') {
  const days = daysLeft === null || daysLeft === undefined || daysLeft === '' ? null : Number(daysLeft);
  if (view === 'expired') return days !== null && Number.isFinite(days) && days < 0;
  if (view === 'due') return days !== null && Number.isFinite(days) && days >= 0 && days <= COMPLIANCE_DUE_DAYS;
  return true;
}

/** `lifetime` first, then the canonical expiryStatus buckets (fleetReports). */
export function complianceStatusOf(daysLeft, lifetime = false) {
  if (lifetime === true) return 'lifetime';
  return expiryStatus(daysLeft);
}

/**
 * D3/rule-51(iii) — the ONLY compliance chip. expired → red, any due bucket →
 * orange, active/lifetime → green, unknown → grey.
 */
export function complianceChipHtml(item = {}) {
  const status = String(item.status || '').toLowerCase();
  const days = item.daysLeft === null || item.daysLeft === undefined || item.daysLeft === '' ? null : Number(item.daysLeft);
  if (item.lifetime === true || status === 'lifetime') return '<span class="chip ok">Valid for life</span>';
  if (status === 'expired' || (Number.isFinite(days) && days < 0)) {
    const overdue = Number.isFinite(days) ? Math.abs(days) : 0;
    return `<span class="chip bad">${escapeHtml(`expired ${overdue} d ago`)}</span>`;
  }
  if (Number.isFinite(days) && days === 0) return '<span class="chip due">today</span>';
  if (Number.isFinite(days) && days > 0 && days <= COMPLIANCE_DUE_DAYS) return `<span class="chip due">${escapeHtml(`in ${days} d`)}</span>`;
  if (status === 'active' || (Number.isFinite(days) && days > COMPLIANCE_DUE_DAYS)) return '<span class="chip ok">Valid</span>';
  return '<span class="chip">No date</span>';
}

/**
 * Pure view filter over the compliance report data. Re-derives the totals AND
 * the category summaries with the report's own bucket math, so a filtered PDF
 * can never print a KPI that contradicts its own table.
 */
export function filterComplianceReport(reportData = {}, view = 'all') {
  const data = reportData && typeof reportData === 'object' ? reportData : {};
  const items = Array.isArray(data.expiryItems) ? data.expiryItems : [];
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const keep = (row) => complianceInView(row?.daysLeft, view);
  const expiryItems = items.filter(keep)
    .sort((a, b) => (Number.isFinite(Number(a.daysLeft)) ? Number(a.daysLeft) : 99999) - (Number.isFinite(Number(b.daysLeft)) ? Number(b.daysLeft) : 99999));
  const filteredDocuments = documents.filter(keep);
  const totals = {
    monitored: expiryItems.length,
    active: expiryItems.filter((item) => item.status === 'active').length,
    expiring30Days: expiryItems.filter((item) => item.status === 'due_30d' || item.status === 'due_14d' || item.status === 'due_7d').length,
    expiring7Days: expiryItems.filter((item) => item.status === 'due_7d').length,
    expired: expiryItems.filter((item) => item.status === 'expired').length
  };
  return {
    ...data,
    expiryItems,
    overdueItems: expiryItems.filter((item) => Number(item.daysLeft) < 0),
    documents: filteredDocuments,
    insuranceStatusMatrix: summarizeCategory(expiryItems, 'insurance'),
    inspectionAndPermits: {
      inspections: summarizeCategory(expiryItems, 'inspection'),
      permits: summarizeCategory(expiryItems, 'permit'),
      licensing: summarizeCategory(expiryItems, 'licensing')
    },
    driverLicenses: summarizeCategory(expiryItems, 'driver_license'),
    totals
  };
}

/** One driver ledger row → the dashboard's document shape (unmasked, D1). */
function complianceDriverDocument(row = {}, now = new Date()) {
  const expiry = row.expiry ? String(row.expiry).slice(0, 10) : null;
  const lifetime = row.lifetime === true;
  const daysLeft = expiry && !lifetime ? daysUntilDue(expiry, now) : null;
  return {
    type: row.type || null,
    label: row.label || (row.type ? driverComplianceLabel(row.type) : 'Document'),
    number: row.number || null,
    expiry,
    lifetime,
    daysLeft,
    status: complianceStatusOf(daysLeft, lifetime)
  };
}

/** Most urgent row (most overdue, else nearest); null when nothing is dated. */
function soonestComplianceItem(rows = []) {
  const dated = (rows || []).filter((row) => Number.isFinite(Number(row.daysLeft)));
  if (!dated.length) return null;
  const first = [...dated].sort((a, b) => Number(a.daysLeft) - Number(b.daysLeft))[0];
  return {
    label: first.categoryLabel || first.label || first.item || 'Document',
    dueDate: first.dueDate || first.expiry || null,
    daysLeft: Number(first.daysLeft),
    status: first.status || complianceStatusOf(Number(first.daysLeft))
  };
}

function sortBySoonest(a, b) {
  const aDays = a?.soonest ? Number(a.soonest.daysLeft) : 99999;
  const bDays = b?.soonest ? Number(b.soonest.daysLeft) : 99999;
  if (aDays !== bDays) return aDays - bDays;
  return String(a?.plate || a?.name || '').localeCompare(String(b?.plate || b?.name || ''));
}

/**
 * The compliance board (Phase 14C): the owner's vehicles and assigned drivers
 * with a tracking rollup, read through the SAME compliance report engine the
 * WhatsApp/PDF report uses, then narrowed by the current view.
 *
 * Vehicle items are attributed by plate (the engine's own display key); driver
 * documents come from `driver_compliances` scoped to the owner's assigned
 * driver ids — so nothing outside this fleet can appear.
 */
export async function buildComplianceBoard({
  supabase,
  ownerId = null,
  countryInfo = null,
  profile = null,
  now = new Date(),
  view = 'all',
  loadReport = buildComplianceReport,
  loadVehicles = loadOwnerVehicles
} = {}) {
  if (!supabase || !ownerId) return { ok: false };
  try {
    const ctx = buildGlobalContext(countryInfo, profile);
    const [report, vehicles] = await Promise.all([
      loadReport({ supabase, ownerId, countryInfo, profile, now }),
      loadVehicles(supabase, ownerId)
    ]);
    if (!report?.ok) return { ok: false };
    const raw = report.data || {};
    const filtered = filterComplianceReport(raw, view);
    const items = filtered.expiryItems;

    const vehicleRows = (vehicles || [])
      .filter((vehicle) => String(vehicle.status || 'ACTIVE').toUpperCase() !== 'DELETED')
      .map((vehicle) => {
        const scoped = items.filter((item) => item.subjectType !== 'driver' && item.plate === vehicle.plate_number);
        return {
          id: vehicle.id,
          plate: vehicle.plate_number || 'Fleet vehicle',
          makeModel: vehicle.make_model || null,
          active: String(vehicle.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
          monitored: scoped.length,
          expiredCount: scoped.filter((item) => Number(item.daysLeft) < 0).length,
          dueCount: scoped.filter((item) => complianceInView(item.daysLeft, 'due')).length,
          soonest: soonestComplianceItem(scoped)
        };
      })
      .filter((row) => view === 'all' || row.monitored > 0)
      .sort(sortBySoonest);

    const driverIds = [...new Set((vehicles || []).map((vehicle) => vehicle.assigned_driver_id).filter(Boolean))];
    let driverProfiles = [];
    let driverDocs = [];
    if (driverIds.length) {
      try {
        const { data } = await supabase.from('profiles').select('id, full_name, phone_number').in('id', driverIds).limit(driverIds.length);
        driverProfiles = data || [];
      } catch (err) {
        logWriteFailure(supabase, 'dashboard.buildComplianceBoard.profiles', err);
      }
      try {
        const { data } = await supabase.from('driver_compliances').select('*').in('driver_id', driverIds).limit(300);
        driverDocs = data || [];
      } catch (err) {
        logWriteFailure(supabase, 'dashboard.buildComplianceBoard.driverDocs', err);
      }
    }

    const drivers = driverIds
      .map((driverId) => {
        const person = driverProfiles.find((row) => row.id === driverId);
        const allDocs = driverDocs.filter((row) => row.driver_id === driverId).map((row) => complianceDriverDocument(row, now));
        const scoped = allDocs.filter((doc) => complianceInView(doc.daysLeft, view));
        return {
          id: driverId,
          name: person?.full_name || 'Driver',
          phone: person?.phone_number || null,
          plates: (vehicles || []).filter((vehicle) => vehicle.assigned_driver_id === driverId).map((vehicle) => vehicle.plate_number).filter(Boolean),
          documentCount: allDocs.length,
          matched: scoped.length,
          expiredCount: scoped.filter((doc) => Number(doc.daysLeft) < 0).length,
          dueCount: scoped.filter((doc) => complianceInView(doc.daysLeft, 'due')).length,
          soonest: soonestComplianceItem(scoped)
        };
      })
      .filter((row) => view === 'all' || row.matched > 0)
      .sort(sortBySoonest);

    return {
      ok: true,
      view,
      generatedAt: filtered.generatedAt || raw.generatedAt || now.toISOString(),
      currency: filtered.currency || ctx.currency,
      locale: ctx.locale,
      timeZone: filtered.timeZone || ctx.timeZone,
      totals: filtered.totals,
      vehicles: vehicleRows,
      drivers,
      items,
      reportData: filtered,
      rawReportData: raw
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildComplianceBoard', err);
    return { ok: false };
  }
}

/**
 * `/d/drivers/:id` (Phase 14C) — one assigned driver + their document ledger.
 *
 * Ownership is STRUCTURAL (rule 51(i)): the driver must be the
 * `assigned_driver_id` of one of the owner's live vehicles, otherwise
 * `{ ok:false, reason:'not_found' }` — the route answers 404 and renders no
 * profile, phone or document number on that path (rule 51(iv)).
 * D1: numbers are UNMASKED for the owner (their fleet); the driver's own card
 * keeps the mask.
 */
export async function buildDriverCompliancePage({
  supabase,
  ownerId = null,
  driverId = null,
  countryInfo = null,
  profile = null,
  now = new Date(),
  loadVehicles = loadOwnerVehicles
} = {}) {
  if (!supabase || !ownerId || !driverId) return { ok: false, reason: 'not_found' };
  try {
    const vehicles = await loadVehicles(supabase, ownerId);
    const assigned = (vehicles || []).filter((vehicle) => vehicle.assigned_driver_id === driverId);
    if (!assigned.length) return { ok: false, reason: 'not_found' };

    const { data: person, error: personError } = await supabase
      .from('profiles')
      .select('id, full_name, phone_number, country_code')
      .eq('id', driverId)
      .maybeSingle();
    if (personError || !person) return { ok: false, reason: 'not_found' };

    const { data: rows } = await supabase.from('driver_compliances').select('*').eq('driver_id', driverId).limit(100);
    const documents = (rows || [])
      .map((row) => complianceDriverDocument(row, now))
      .sort((a, b) => (Number.isFinite(Number(a.daysLeft)) ? Number(a.daysLeft) : 99999) - (Number.isFinite(Number(b.daysLeft)) ? Number(b.daysLeft) : 99999));
    const ctx = buildGlobalContext(countryInfo, profile);

    return {
      ok: true,
      generatedAt: now.toISOString(),
      currency: ctx.currency,
      locale: ctx.locale,
      timeZone: ctx.timeZone,
      driver: {
        id: person.id,
        name: person.full_name || 'Driver',
        phone: person.phone_number || null,
        plates: assigned.map((vehicle) => vehicle.plate_number).filter(Boolean),
        vehicles: assigned.map((vehicle) => ({ id: vehicle.id, plate: vehicle.plate_number || 'Fleet vehicle' }))
      },
      documents,
      soonest: soonestComplianceItem(documents)
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildDriverCompliancePage', err);
    return { ok: false, reason: 'db_error' };
  }
}

/**
 * Filtered compliance PDF (Phase 14C): the SAME filtered report data the page
 * renders goes through the existing compliance transformer, then the Apex
 * engine — a Buffer with no Storage upload and no email.
 */
export async function buildCompliancePdf(reportData = {}, {
  profile = null,
  countryInfo = null,
  useStandardFonts = false
} = {}) {
  const data = reportData && typeof reportData === 'object' ? reportData : {};
  const report = { ok: true, type: 'compliance', data };
  const pdfData = complianceReportToPdf(report, 'compliance');
  return buildProReportPdf({
    ...pdfData,
    useStandardFonts,
    owner: profile
      ? {
          name: profile.full_name || 'Fleet owner',
          email: profile.email || '',
          phone: profile.phone_number || '',
          language: profile.preferred_language || 'English',
          plan: profile.plan || null
        }
      : null,
    countryInfo: countryInfo || null
  });
}

/* ------------------------------------------------------------------ */
/* 9. Reports builder + settings (Phase 14D)                           */
/* ------------------------------------------------------------------ */

export const REPORT_RANGES = Object.freeze(['this_month', 'last_30_days', 'this_year', 'custom']);
export const REPORT_MAX_METRICS = 8;
export const EXPORT_SECTION_CAP = 2000;

const REPORT_RANGE_ALIASES = Object.freeze({
  this_month: 'this_month',
  month: 'this_month',
  last_30_days: 'last_30_days',
  'last-30-days': 'last_30_days',
  last_30: 'last_30_days',
  this_year: 'this_year',
  year: 'this_year',
  custom: 'custom'
});

function pickList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function maskPhone(phone) {
  const raw = String(phone || '').replace(/\s+/g, '');
  if (!raw) return '—';
  if (raw.length <= 4) return '•••';
  return `${'•'.repeat(Math.max(0, raw.length - 4))}${raw.slice(-4)}`;
}

/**
 * Validate a reports-builder submission into ONE spec that feeds both the form
 * state and the PDF (rule 51(ii) — the export can never describe something the
 * form did not select). Never throws.
 */
export function parseReportSpec(query = {}, { vehicleIds = [], now = new Date() } = {}) {
  const raw = query && typeof query === 'object' ? query : {};
  const rangeValue = String(Array.isArray(raw.range) ? raw.range[0] : raw.range || '').trim().toLowerCase();
  const range = rangeValue ? REPORT_RANGE_ALIASES[rangeValue] : 'this_month';
  if (!range) return { ok: false, reason: 'bad_range', error: 'That date range is not one I know — pick a preset or Custom.' };

  const requestedVehicles = [...new Set(pickList(raw.vehicles ?? raw.vehicle))];
  const unknownVehicle = requestedVehicles.find((vehicleId) => !vehicleIds.includes(vehicleId));
  if (unknownVehicle) return { ok: false, reason: 'unknown_vehicle', error: 'That vehicle is not on your fleet.' };

  const requestedMetrics = [...new Set(pickList(raw.metrics ?? raw.metric))];
  const knownMetrics = new Set(CUSTOM_METRICS.map((metric) => metric.id));
  const unknownMetric = requestedMetrics.find((metricId) => !knownMetrics.has(metricId));
  if (unknownMetric) return { ok: false, reason: 'unknown_metric', error: `"${unknownMetric}" is not a metric I can report on.` };
  if (requestedMetrics.length > REPORT_MAX_METRICS) {
    return { ok: false, reason: 'too_many_metrics', error: `Pick up to ${REPORT_MAX_METRICS} metrics — that is all one report can show clearly.` };
  }
  const metricIds = requestedMetrics.length
    ? requestedMetrics
    : metricsForAccess({ lane: 'owner' }).map((metric) => metric.id).slice(0, 5);

  let from;
  let to;
  let label;
  if (range === 'custom') {
    const fromRaw = String(Array.isArray(raw.from) ? raw.from[0] : raw.from || '').trim();
    const toRaw = String(Array.isArray(raw.to) ? raw.to[0] : raw.to || '').trim();
    if (!ISO_DATE_RE.test(fromRaw) || Number.isNaN(new Date(`${fromRaw}T00:00:00Z`).getTime())) {
      return { ok: false, reason: 'bad_from', error: 'That start date does not look right — use YYYY-MM-DD.' };
    }
    if (!ISO_DATE_RE.test(toRaw) || Number.isNaN(new Date(`${toRaw}T00:00:00Z`).getTime())) {
      return { ok: false, reason: 'bad_to', error: 'That end date does not look right — use YYYY-MM-DD.' };
    }
    if (fromRaw > toRaw) return { ok: false, reason: 'bad_range_dates', error: 'The start date is after the end date — swap them and try again.' };
    if (daysBetweenIso(fromRaw, toRaw) + 1 > RECORDS_MAX_RANGE_DAYS) {
      return { ok: false, reason: 'range_too_wide', error: `That range is wider than ${RECORDS_MAX_RANGE_DAYS} days — pick a shorter window.` };
    }
    from = nairobiDayStartIso(fromRaw);
    // Inclusive end: buildCustomReport compares with `.lte('created_at', to)`.
    to = `${toRaw}T23:59:59.999${NAIROBI_OFFSET}`;
    label = `${fromRaw} – ${toRaw}`;
  } else {
    const bounds = dateRangeBounds(range, now);
    from = bounds.from;
    to = bounds.to;
    label = bounds.label;
  }

  return { ok: true, spec: { range, from, to, label, vehicleIds: requestedVehicles, metricIds } };
}

/**
 * The dashboard's report builder (Phase 14D): the SAME `buildCustomReport`
 * engine the WhatsApp custom-report lane uses, with the owner lane and the
 * resolved window passed through. Dashboards reports never touch
 * `usage_counters` — the builder has no quota path at all.
 */
export async function buildDashboardCustomReport({
  supabase,
  ownerId = null,
  spec = {},
  countryInfo = null,
  profile = null,
  now = new Date()
} = {}) {
  if (!supabase || !ownerId) return { ok: false, error: 'Database unavailable.' };
  try {
    const report = await buildCustomReport({
      supabase,
      ownerId,
      vehicleIds: spec.vehicleIds || [],
      metricIds: spec.metricIds || [],
      range: spec.range || 'this_month',
      bounds: { from: spec.from, to: spec.to, label: spec.label },
      countryInfo,
      profile,
      access: { lane: 'owner' },
      now
    });
    if (!report?.ok) return { ok: false, error: report?.error || 'That report could not be built.' };
    return { ok: true, data: report.data, text: report.text };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildDashboardCustomReport', err);
    return { ok: false, error: 'That report could not be built.' };
  }
}

/**
 * `/d/settings` (Phase 14D; v1.77.0 adds the monthly opt-in) — the owner's
 * preferences. `weekly_report_opt_in` and `monthly_report_opt_in` are editable
 * here (the SAME columns the WhatsApp toggles and the sweeps use — one source of
 * truth). Everything else is shown read-only; email/units stay in WhatsApp.
 */
export async function buildSettingsPage({
  supabase,
  ownerId = null,
  countryInfo = null,
  profile = null,
  sessionExpiresAt = null
} = {}) {
  if (!supabase || !ownerId) return { ok: false };
  const ctx = buildGlobalContext(countryInfo, profile);
  let weeklyReportOn = false;
  let weeklyReportKnown = true;
  let monthlyReportOn = false;
  let monthlyReportKnown = true;
  let planLabel = 'Free';
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('weekly_report_opt_in, monthly_report_opt_in, subscription_tier, subscription_status')
      .eq('id', ownerId)
      .maybeSingle();
    if (error) {
      // Rule 50 — an un-migrated column never fakes a preference.
      const monthlyMissing = /monthly_report_opt_in/i.test(error.message || '');
      weeklyReportKnown = false;
      monthlyReportKnown = !monthlyMissing;
      logWriteFailure(supabase, 'dashboard.buildSettingsPage', error);
    } else if (data) {
      weeklyReportOn = data.weekly_report_opt_in === true;
      monthlyReportOn = data.monthly_report_opt_in === true;
      planLabel = getTierLabel(data.subscription_tier || 'free');
    }
  } catch (err) {
    weeklyReportKnown = false;
    monthlyReportKnown = false;
    logWriteFailure(supabase, 'dashboard.buildSettingsPage', err);
  }
  return {
    ok: true,
    weeklyReportOn,
    weeklyReportKnown,
    monthlyReportOn,
    monthlyReportKnown,
    planLabel,
    emailMasked: maskEmail(profile?.email),
    phoneMasked: maskPhone(profile?.phone_number),
    language: profile?.preferred_language || 'English',
    unitSystem: String(profile?.unit_system || '').toLowerCase() === 'imperial' ? 'Imperial (miles)' : 'Metric (km)',
    countryLabel: profile?.country || ctx.country || '—',
    currency: ctx.currency,
    locale: ctx.locale,
    timeZone: ctx.timeZone,
    sessionExpiresAt: sessionExpiresAt || null
  };
}

/**
 * The writable preferences. A failed write never claims success (rule 50).
 * Each toggle saves INDEPENDENTLY: a stray or partial POST can never silently
 * flip the other one.
 */
export async function saveSettings({ supabase, ownerId = null, weeklyReportOn = null, monthlyReportOn = null } = {}) {
  if (!supabase || !ownerId) return { ok: false, error: 'Your session is not valid — reply *dashboard* on WhatsApp for a fresh link.' };
  const patch = {};
  if (typeof weeklyReportOn === 'boolean') patch.weekly_report_opt_in = weeklyReportOn;
  if (typeof monthlyReportOn === 'boolean') patch.monthly_report_opt_in = monthlyReportOn;
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to save — nothing changed.' };
  try {
    const { error } = await supabase.from('profiles').update(patch).eq('id', ownerId);
    if (error) {
      logWriteFailure(supabase, 'dashboard.saveSettings', error);
      return { ok: false, error: 'I could not save that setting — nothing changed. Please try again.' };
    }
    return { ok: true, weeklyReportOn, monthlyReportOn };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.saveSettings', err);
    return { ok: false, error: 'I could not save that setting — nothing changed. Please try again.' };
  }
}

/* ------------------------------------------------------------------ */
/* Data export (Phase 14D) — ONE CSV, record_type first, # section rows */
/* ------------------------------------------------------------------ */

export const EXPORT_COLUMNS = Object.freeze({
  expenses: ['record_type', 'id', 'date', 'vehicle_id', 'plate', 'expense_type', 'amount', 'currency', 'fuel_liters', 'fill_type', 'odometer_reading', 'label', 'notes'],
  earnings: ['record_type', 'id', 'date', 'vehicle_id', 'plate', 'earning_type', 'amount', 'currency', 'label', 'notes'],
  reminders: ['record_type', 'id', 'vehicle_id', 'plate', 'subject_type', 'category', 'reminder_type', 'due_date', 'status', 'notes'],
  vehicle_compliances: ['record_type', 'id', 'vehicle_id', 'plate', 'type', 'label', 'number', 'expiry', 'lifetime'],
  driver_compliances: ['record_type', 'id', 'driver_id', 'type', 'label', 'number', 'expiry', 'lifetime'],
  receipts: ['record_type', 'id', 'date', 'vehicle_id', 'plate', 'document_kind', 'status', 'vendor', 'amount', 'currency', 'media_id']
});

async function exportFetch(supabase, table, { vehicleIds = [], driverIds = [], order = 'created_at' } = {}) {
  const cap = EXPORT_SECTION_CAP;
  const limit = cap + 1;
  try {
    if (table === 'driver_compliances') {
      if (!driverIds.length) return { rows: [], truncated: false };
      const { data, error } = await supabase.from(table).select('*').in('driver_id', driverIds).order(order, { ascending: false }).limit(limit);
      if (error) return { rows: [], truncated: false, error: error.message };
      return { rows: (data || []).slice(0, cap), truncated: (data || []).length > cap };
    }
    if (!vehicleIds.length) return { rows: [], truncated: false };
    const { data, error } = await supabase.from(table).select('*').in('vehicle_id', vehicleIds).order(order, { ascending: false }).limit(limit);
    if (error) return { rows: [], truncated: false, error: error.message };
    return { rows: (data || []).slice(0, cap), truncated: (data || []).length > cap };
  } catch (err) {
    return { rows: [], truncated: false, error: err.message };
  }
}

/**
 * "Download all data" (Phase 14D, D3 + A1 + A2): ONE CSV, `record_type` as the
 * first column, a `# section` comment row before each block, a `[CAP]` row when
 * a table hit the 2000-row limit, and an `[ERROR]` row when a table could not be
 * read (never a silent empty section). Owner-fleet scoped by construction.
 */
export async function serializeAllDataCsv({ supabase, ownerId = null, currency = 'USD' } = {}) {
  const lines = [];
  if (!supabase || !ownerId) {
    lines.push('# export');
    lines.push(csvCell('[ERROR] No account context.'));
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }
  const vehicles = await loadOwnerVehicles(supabase, ownerId);
  const vehicleIds = (vehicles || []).map((vehicle) => vehicle.id).filter(Boolean);
  const driverIds = [...new Set((vehicles || []).map((vehicle) => vehicle.assigned_driver_id).filter(Boolean))];
  const plateOf = (vehicleId) => (vehicles || []).find((vehicle) => vehicle.id === vehicleId)?.plate_number || '';

  const pushSection = (name, rows, { truncated = false, error = null } = {}) => {
    lines.push(`# ${name}`);
    if (error) {
      lines.push(csvCell(`[ERROR] Could not read ${name} just now.`));
      return;
    }
    lines.push(EXPORT_COLUMNS[name].join(','));
    for (const row of rows) lines.push(row.map((value) => csvCell(value)).join(','));
    if (truncated) {
      lines.push(csvCell(`[CAP] Reached ${EXPORT_SECTION_CAP}-row limit for ${name}. Older rows may exist in your account.`));
    }
  };

  const expenses = await exportFetch(supabase, 'expense_logs', { vehicleIds });
  pushSection('expenses', expenses.rows.map((row) => [
    'expense', row.id, row.created_at || row.logged_at || '', row.vehicle_id || '', plateOf(row.vehicle_id),
    row.expense_type || '', row.amount ?? '', row.currency || currency, row.fuel_liters ?? '', row.fill_type || '',
    row.odometer_reading ?? '', row.label || '', row.notes || ''
  ]), expenses);

  const earnings = await exportFetch(supabase, 'private_earnings', { vehicleIds, order: 'logged_at' });
  pushSection('earnings', earnings.rows.map((row) => [
    'earning', row.id, row.logged_at || row.created_at || '', row.vehicle_id || '', plateOf(row.vehicle_id),
    row.earning_type || '', row.revenue_amount ?? row.amount ?? '', row.currency || currency, row.label || '', row.notes || ''
  ]), earnings);

  const reminders = await exportFetch(supabase, 'reminders', { vehicleIds, order: 'due_date' });
  pushSection('reminders', reminders.rows.map((row) => [
    'reminder', row.id, row.vehicle_id || '', plateOf(row.vehicle_id), row.subject_type || 'vehicle',
    row.category || '', row.reminder_type || '', row.due_date || '', row.status || '', row.notes || ''
  ]), reminders);

  const vehicleDocs = await exportFetch(supabase, 'vehicle_compliances', { vehicleIds });
  pushSection('vehicle_compliances', vehicleDocs.rows.map((row) => [
    'vehicle_compliance', row.id, row.vehicle_id || '', plateOf(row.vehicle_id), row.type || '',
    row.label || '', row.number || '', row.expiry ? String(row.expiry).slice(0, 10) : '', row.lifetime === true
  ]), vehicleDocs);

  const driverDocs = await exportFetch(supabase, 'driver_compliances', { driverIds });
  pushSection('driver_compliances', driverDocs.rows.map((row) => [
    'driver_compliance', row.id, row.driver_id || '', row.type || '', row.label || '', row.number || '',
    row.expiry ? String(row.expiry).slice(0, 10) : '', row.lifetime === true
  ]), driverDocs);

  // Receipts: fleet receipts (vehicle scope) + the owner's own scans, deduped.
  let receiptRows = [];
  let receiptsTruncated = false;
  let receiptsError = null;
  try {
    const byVehicle = vehicleIds.length
      ? await supabase.from('receipts').select('*').in('vehicle_id', vehicleIds).order('created_at', { ascending: false }).limit(EXPORT_SECTION_CAP + 1)
      : { data: [], error: null };
    const byOwner = await supabase.from('receipts').select('*').eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(EXPORT_SECTION_CAP + 1);
    if (byVehicle.error || byOwner.error) {
      receiptsError = (byVehicle.error || byOwner.error).message;
    } else {
      const seen = new Map();
      for (const row of [...(byVehicle.data || []), ...(byOwner.data || [])]) {
        if (row?.id && !seen.has(row.id)) seen.set(row.id, row);
      }
      const merged = [...seen.values()].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      receiptsTruncated = merged.length > EXPORT_SECTION_CAP;
      receiptRows = merged.slice(0, EXPORT_SECTION_CAP);
    }
  } catch (err) {
    receiptsError = err.message;
  }
  pushSection('receipts', receiptRows.map((row) => [
    'receipt', row.id, row.created_at || '', row.vehicle_id || '', plateOf(row.vehicle_id), row.document_kind || '',
    row.status || '', row.vendor || '', row.amount ?? '', row.currency || currency, row.media_id || ''
  ]), { truncated: receiptsTruncated, error: receiptsError });

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ */
/* 10. Driver + superadmin views (Phase 15)                            */
/* ------------------------------------------------------------------ */

/** The caller's assigned live vehicle (or null). Driver lane only. */
async function loadAssignedVehicle(supabase, driverId) {
  if (!supabase || !driverId) return null;
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('id, plate_number, make_model, status')
      .eq('assigned_driver_id', driverId)
      .is('deleted_at', null)
      .limit(1);
    if (error) return null;
    return (data || [])[0] || null;
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.loadAssignedVehicle', err);
    return null;
  }
}

/**
 * `/d/driver` (Phase 15) — the driver's own home: the assigned vehicle, the
 * compliance summary of their OWN documents (unmasked, D3) and their last
 * seven days. Every input is scoped by `driverId` = the session's profile id.
 */
export async function buildDriverHome({
  supabase,
  driverId = null,
  countryInfo = null,
  profile = null,
  now = new Date()
} = {}) {
  if (!supabase || !driverId) return { ok: false };
  try {
    const ctx = buildGlobalContext(countryInfo, profile);
    const [vehicle, card, daybook] = await Promise.all([
      loadAssignedVehicle(supabase, driverId),
      buildDriverComplianceCard({ supabase, driverId, countryInfo, now, mask: false }),
      buildDriverDaybook({ supabase, driverId, days: 7, countryInfo, profile, now })
    ]);
    return {
      ok: true,
      generatedAt: now.toISOString(),
      currency: ctx.currency,
      locale: ctx.locale,
      timeZone: ctx.timeZone,
      vehicle: vehicle
        ? {
            id: vehicle.id,
            plate: vehicle.plate_number || 'Assigned vehicle',
            makeModel: vehicle.make_model || null,
            status: String(vehicle.status || 'ACTIVE').toUpperCase()
          }
        : null,
      compliance: card?.ok
        ? { kpis: card.data.kpis || [], documents: card.data.tables?.[0]?.rows || [] }
        : { kpis: [], documents: [] },
      week: daybook?.ok
        ? { kpis: daybook.data.kpis || [], ledger: daybook.data.ledgers?.[0] || null }
        : { kpis: [], ledger: null }
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildDriverHome', err);
    return { ok: false };
  }
}

/** `/d/driver/daybook` — the full daybook (charts + ledger), driver-scoped. */
export async function buildDriverDaybookPageData({
  supabase,
  driverId = null,
  days = 14,
  countryInfo = null,
  profile = null,
  now = new Date()
} = {}) {
  if (!supabase || !driverId) return { ok: false };
  const report = await buildDriverDaybook({ supabase, driverId, days, countryInfo, profile, now });
  if (!report?.ok) return { ok: false, error: report?.error || 'That daybook could not be loaded.' };
  const ctx = buildGlobalContext(countryInfo, profile);
  return {
    ok: true,
    data: report.data,
    currency: ctx.currency,
    locale: ctx.locale,
    timeZone: ctx.timeZone
  };
}

/** `/d/driver/compliance` — their own documents, UNMASKED (D3). */
export async function buildDriverSelfCompliancePage({
  supabase,
  driverId = null,
  countryInfo = null,
  profile = null,
  now = new Date()
} = {}) {
  if (!supabase || !driverId) return { ok: false };
  const card = await buildDriverComplianceCard({ supabase, driverId, countryInfo, now, mask: false });
  if (!card?.ok) return { ok: false, error: card?.error || 'Your documents could not be loaded.' };
  const ctx = buildGlobalContext(countryInfo, profile);
  const vehicle = await loadAssignedVehicle(supabase, driverId);
  return {
    ok: true,
    generatedAt: now.toISOString(),
    currency: ctx.currency,
    locale: ctx.locale,
    timeZone: ctx.timeZone,
    vehicle: vehicle ? { id: vehicle.id, plate: vehicle.plate_number || 'Assigned vehicle' } : null,
    kpis: card.data.kpis || [],
    documents: card.data.tables?.[0]?.rows || []
  };
}

/**
 * `/d/admin` (Phase 15) — every owner with at least one live vehicle, read-only.
 * Phones are masked; the search covers the name and the visible digits.
 */
export async function buildAdminOwnersList({ supabase, search = '', limit = 50 } = {}) {
  if (!supabase) return { ok: false };
  try {
    const { data: vehicleRows, error: vehicleError } = await supabase
      .from('vehicles')
      .select('id, owner_id, status, deleted_at')
      .is('deleted_at', null)
      .limit(2000);
    if (vehicleError) {
      logWriteFailure(supabase, 'dashboard.buildAdminOwnersList.vehicles', vehicleError);
      return { ok: false };
    }
    const byOwner = new Map();
    for (const row of vehicleRows || []) {
      if (!row.owner_id) continue;
      const entry = byOwner.get(row.owner_id) || { vehicleCount: 0, activeCount: 0 };
      entry.vehicleCount += 1;
      if (String(row.status || 'ACTIVE').toUpperCase() === 'ACTIVE') entry.activeCount += 1;
      byOwner.set(row.owner_id, entry);
    }
    const ownerIds = [...byOwner.keys()];
    let profiles = [];
    if (ownerIds.length) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone_number, country, created_at')
        .in('id', ownerIds)
        .limit(2000);
      if (error) {
        logWriteFailure(supabase, 'dashboard.buildAdminOwnersList.profiles', error);
        return { ok: false };
      }
      profiles = data || [];
    }
    const term = String(search || '').trim().toLowerCase();
    const owners = profiles
      .map((person) => {
        const fleet = byOwner.get(person.id) || { vehicleCount: 0, activeCount: 0 };
        return {
          id: person.id,
          name: person.full_name || 'Unnamed owner',
          phoneMasked: maskPhone(person.phone_number),
          country: person.country || '—',
          vehicleCount: fleet.vehicleCount,
          activeCount: fleet.activeCount,
          createdAt: person.created_at || null
        };
      })
      .filter((row) => (!term
        ? true
        : row.name.toLowerCase().includes(term) || row.phoneMasked.toLowerCase().includes(term)))
      .sort((a, b) => (b.activeCount - a.activeCount) || String(a.name).localeCompare(String(b.name)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
    return { ok: true, generatedAt: new Date().toISOString(), owners, totalOwners: profiles.length };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildAdminOwnersList', err);
    return { ok: false };
  }
}

/**
 * `/d/admin/owners/:id` (Phase 15) — one owner's fleet, read through the same
 * owner builders (read-only; no write path anywhere in this module).
 */
export async function buildAdminFleetView({ supabase, ownerId = null, now = new Date() } = {}) {
  if (!supabase || !ownerId) return { ok: false, reason: 'not_found' };
  try {
    const full = 'id, full_name, phone_number, email, country, country_code, preferred_language, unit_system';
    let { data: owner, error } = await supabase.from('profiles').select(full).eq('id', ownerId).maybeSingle();
    if (error) {
      ({ data: owner, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone_number, country_code')
        .eq('id', ownerId)
        .maybeSingle());
    }
    if (error || !owner) return { ok: false, reason: 'not_found' };
    const countryInfo = owner.phone_number ? detectCountryFromPhone(owner.phone_number) : null;
    const [card, directory, compliance] = await Promise.all([
      buildOverviewCard({ supabase, ownerId, profile: owner, countryInfo, now }),
      buildVehiclesIndex({ supabase, ownerId, profile: owner, countryInfo, now }),
      buildComplianceBoard({ supabase, ownerId, profile: owner, countryInfo, now, view: 'all' })
    ]);
    return {
      ok: true,
      generatedAt: now.toISOString(),
      owner: {
        id: owner.id,
        name: owner.full_name || 'Unnamed owner',
        phoneMasked: maskPhone(owner.phone_number),
        emailMasked: maskEmail(owner.email),
        country: owner.country || countryInfo?.country || '—'
      },
      card: card?.ok ? card : null,
      directory: directory?.ok ? directory : null,
      compliance: compliance?.ok ? compliance : null
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildAdminFleetView', err);
    return { ok: false, reason: 'db_error' };
  }
}

/* ------------------------------------------------------------------ */
/* 10. Care queue (Phase 19) — the superadmin's escalated-ticket view  */
/* ------------------------------------------------------------------ */

/**
 * Amina's hand-off queue for `/d/care`: every ESCALATED ticket with its full
 * thread (the investigation log lives in direction='internal', channel='ai'
 * messages), her best draft, plus the newest lessons the learning loop stored.
 *
 * Deliberately queried here rather than through `careConsole.js`: the console
 * imports the Sentinel worker graph, and the dashboard must never do that
 * (the Phase 15 superadminIdentity precedent). Read-only, never throws.
 */
export async function buildCareQueue({ supabase, limit = 50 } = {}) {
  if (!supabase) return { ok: false };
  try {
    const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .in('status', ['ESCALATED', 'OPEN', 'IN_PROGRESS'])
      .order('updated_at', { ascending: false })
      .limit(max);
    if (error) {
      logWriteFailure(supabase, 'dashboard.buildCareQueue.tickets', error);
      return { ok: false };
    }
    const tickets = data || [];
    const ids = tickets.map((ticket) => ticket.id).filter(Boolean);
    let messages = [];
    if (ids.length) {
      try {
        const res = await supabase
          .from('support_ticket_messages')
          .select('*')
          .in('ticket_id', ids)
          .order('created_at', { ascending: true })
          .limit(500);
        messages = (res && res.data) || [];
      } catch (err) {
        logWriteFailure(supabase, 'dashboard.buildCareQueue.messages', err);
      }
    }
    let learnings = [];
    try {
      const res = await supabase
        .from('care_learnings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);
      learnings = (res && res.data) || [];
    } catch (err) {
      logWriteFailure(supabase, 'dashboard.buildCareQueue.learnings', err);
    }
    const withThreads = tickets.map((ticket) => {
      const thread = messages.filter((message) => String(message.ticket_id) === String(ticket.id));
      return {
        ...ticket,
        thread,
        investigation: thread.filter((message) => message.direction === 'internal' && message.channel === 'ai')
      };
    });
    const statusOf = (ticket) => String(ticket.status || 'OPEN').toUpperCase();
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      tickets: withThreads,
      escalated: withThreads.filter((ticket) => statusOf(ticket) === 'ESCALATED'),
      counts: {
        escalated: withThreads.filter((ticket) => statusOf(ticket) === 'ESCALATED').length,
        open: withThreads.filter((ticket) => statusOf(ticket) === 'OPEN').length,
        inProgress: withThreads.filter((ticket) => statusOf(ticket) === 'IN_PROGRESS').length
      },
      learnings
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildCareQueue', err);
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* 11. Analytics page (Phase 19) — tyre wear + cost-per-km trend       */
/* ------------------------------------------------------------------ */

/**
 * Page model for `/d/analytics`: the owner's live vehicles, their latest Tyres
 * expense (odometer clock) and six monthly spend ÷ distance buckets. Reads the
 * SAME `distanceInWindow` engine as every report (rule 55). Never throws.
 */
export async function buildAnalyticsPage({
  supabase,
  ownerId = null,
  profile = null,
  countryInfo = null,
  now = new Date(),
  loadVehicles = loadOwnerVehicles
} = {}) {
  if (!supabase || !ownerId) return { ok: false };
  try {
    const ctx = buildGlobalContext(countryInfo, profile);
    const vehicles = await loadVehicles(supabase, ownerId);
    const ids = (vehicles || []).map((vehicle) => vehicle.id).filter(Boolean);
    let expenses = [];
    if (ids.length) {
      try {
        const { data, error } = await supabase
          .from('expense_logs')
          .select('*')
          .in('vehicle_id', ids)
          .limit(2000);
        if (!error) expenses = data || [];
      } catch (err) {
        logWriteFailure(supabase, 'dashboard.buildAnalyticsPage.expenses', err);
      }
    }
    const tyres = buildTyreWearRows({ vehicles, expenses, unitSystem: ctx.unitSystem });
    const trend = buildCostPerKmTrend({ expenses, now, months: 6, unitSystem: ctx.unitSystem });
    return {
      ok: true,
      generatedAt: now.toISOString(),
      currency: ctx.currency,
      locale: ctx.locale,
      timeZone: ctx.timeZone,
      distanceUnit: ctx.labels.distance,
      vehicleCount: ids.length,
      tyreLifespan: getTyreLifespanKm(),
      tyres,
      trend,
      chart: buildCostPerKmChart(trend)
    };
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.buildAnalyticsPage', err);
    return { ok: false };
  }
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
.chip.bad { color:#F85149; border-color:#F85149; }
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
/* Phase 14D — report builder + settings form controls. */
.radio, .check { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:14px; }
.radio input, .check input { width:auto; margin:0; }
.metrics { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; }
.metric-group { border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin:0; }
.metric-group legend { color:var(--muted); font-size:12px; padding:0 6px; }
/* Phase 19 — analytics progress bars + inline SVG trend + care blocks. */
.progress { height:10px; background:#1E1E22; border-radius:999px; overflow:hidden; margin:10px 0 4px; }
.progress span { display:block; height:100%; background:var(--accent); border-radius:999px; }
.progress.low span { background:#F85149; }
svg.trend { width:100%; height:auto; display:block; }
svg.trend line.grid { stroke:#2A2A30; stroke-width:1; }
svg.trend polyline.line { fill:none; stroke:var(--accent); stroke-width:2.5; stroke-linejoin:round; stroke-linecap:round; }
svg.trend circle.dot { fill:var(--accent); }
svg.trend text.xlabel { fill:var(--muted); font-size:11px; }
blockquote { margin:10px 0; padding:10px 14px; border-left:3px solid var(--accent); background:#0F0F11; border-radius:6px; color:var(--ink); white-space:pre-wrap; }
code { background:#0F0F11; border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:12px; }
ul.invest li { font-size:13px; color:var(--ink); }
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

/** The eight destinations every signed-in page offers (Phase 19 adds Analytics). */
function dashboardNav() {
  return '<a href="/d">Overview</a> · <a href="/d/vehicles">Vehicles</a> · <a href="/d/records">Records</a> · <a href="/d/compliance">Compliance</a> · <a href="/d/analytics">Analytics</a> · <a href="/d/reports">Reports</a> · <a href="/d/settings">Settings</a> · <a href="/d/logout">Log out</a>';
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

/**
 * `/d/compliance` (Phase 14C) — the vehicle + driver compliance board. Filters
 * live in the URL (`?view=all|due|expired`) so links are shareable and the
 * export button can never describe a different view than the table.
 */
export function renderCompliancePage({ board, filters = {}, emailMasked = '', error = null }) {
  if (!board?.ok) {
    return renderErrorPage(503, 'Your compliance view could not be loaded just now. Please try again in a moment.').html;
  }
  const view = filters.view || board.view || 'all';
  const totals = board.totals || {};
  const when = formatDate(board.generatedAt, board.locale, { timeZone: board.timeZone });
  const dueDate = (iso) => (iso ? formatDate(iso, board.locale, { timeZone: board.timeZone }) : '—');
  const filterLink = (id, label) => `<a class="chip${view === id ? ' due' : ''}" href="/d/compliance?view=${id}">${escapeHtml(label)}</a>`;

  const kpis = `
  <div class="kpis card">
    <div class="kpi"><div class="label">Monitored</div><div class="value">${Number(totals.monitored || 0)}</div></div>
    <div class="kpi"><div class="label">Valid</div><div class="value">${Number(totals.active || 0)}</div></div>
    <div class="kpi"><div class="label">Due in 30 days</div><div class="value">${Number(totals.expiring30Days || 0)}</div></div>
    <div class="kpi"><div class="label">Expired</div><div class="value">${Number(totals.expired || 0)}</div></div>
  </div>`;

  const vehicles = Array.isArray(board.vehicles) ? board.vehicles : [];
  const vehicleTable = vehicles.length
    ? `<div class="card table-wrap"><table class="rec">
        <thead><tr><th>Vehicle</th><th class="num">Tracked</th><th>Soonest</th><th>Status</th></tr></thead>
        <tbody>${vehicles.map((row) => `
          <tr>
            <td><a href="/d/vehicles/${encodeURIComponent(row.id)}">${escapeHtml(row.plate)}</a>${row.makeModel ? `<span class="muted"> · ${escapeHtml(row.makeModel)}</span>` : ''}${row.active ? '' : ' <span class="chip">Paused</span>'}</td>
            <td class="num">${Number(row.monitored)}</td>
            <td>${row.soonest ? `${escapeHtml(row.soonest.label)} <span class="muted">${escapeHtml(dueDate(row.soonest.dueDate))}</span>` : '<span class="muted">No dates on file</span>'}</td>
            <td>${row.soonest ? complianceChipHtml(row.soonest) : '<span class="chip">Not tracked</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
    : `<div class="card"><p class="muted">${view === 'all' ? 'No vehicles yet — register one in WhatsApp and its documents appear here.' : 'No vehicles match this view — try All.'}</p></div>`;

  const drivers = Array.isArray(board.drivers) ? board.drivers : [];
  const driverTable = drivers.length
    ? `<div class="card table-wrap"><table class="rec">
        <thead><tr><th>Driver</th><th>Plates</th><th class="num">Documents</th><th>Soonest</th><th>Status</th></tr></thead>
        <tbody>${drivers.map((row) => `
          <tr>
            <td><a href="/d/drivers/${encodeURIComponent(row.id)}">${escapeHtml(row.name)}</a></td>
            <td>${escapeHtml((row.plates || []).join(', ') || '—')}</td>
            <td class="num">${Number(row.documentCount)}</td>
            <td>${row.soonest ? `${escapeHtml(row.soonest.label)} <span class="muted">${escapeHtml(dueDate(row.soonest.dueDate))}</span>` : '<span class="muted">No documents on file</span>'}</td>
            <td>${row.soonest ? complianceChipHtml(row.soonest) : '<span class="chip">Not tracked</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
    : `<div class="card"><p class="muted">${view === 'all' ? 'No assigned drivers yet — assign one in WhatsApp and their documents appear here.' : 'No drivers match this view — try All.'}</p></div>`;

  const items = Array.isArray(board.items) ? board.items.slice(0, 30) : [];
  const itemTable = view !== 'all'
    ? (items.length
      ? `<div class="card table-wrap"><table class="rec">
          <thead><tr><th>Vehicle</th><th>Document</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>${items.map((item) => `
            <tr>
              <td>${escapeHtml(item.plate || 'Fleet')}</td>
              <td>${escapeHtml(item.categoryLabel || item.item || item.category || 'Document')}</td>
              <td>${escapeHtml(dueDate(item.dueDate))}</td>
              <td>${complianceChipHtml(item)}</td>
            </tr>`).join('')}</tbody>
        </table></div>`
      : `<div class="card"><p class="muted">${view === 'expired' ? 'Nothing expired — nicely kept.' : 'Nothing due in the next 30 days.'}</p></div>`)
    : '';

  const body = `
<h1>Compliance</h1>
<p class="muted">Signed in as ${escapeHtml(emailMasked)} • updated ${escapeHtml(when)}</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<p>${filterLink('all', 'All')} ${filterLink('due', 'Due soon (30 d)')} ${filterLink('expired', 'Expired')}</p>
${kpis}
<h2>Vehicles</h2>
${vehicleTable}
<h2>Drivers</h2>
${driverTable}
${view !== 'all' ? `<h2>Items in this view</h2>${itemTable}` : ''}
<p class="muted" style="font-size:13px;">Export this view: <a href="/d/compliance.pdf?view=${escapeHtml(view)}">PDF</a> · dates are engine-calculated from your saved documents.</p>`;
  return renderPageShell('Compliance', body, { headerRight: dashboardNav() });
}

/**
 * `/d/drivers/:id` (Phase 14C) — one assigned driver and their documents.
 * D1: numbers are shown in full to the owner; the driver's own card masks them.
 */
export function renderDriverPage({ page, emailMasked = '' }) {
  if (!page?.ok) {
    return renderErrorPage(503, 'That driver could not be loaded just now. Please try again in a moment.').html;
  }
  const driver = page.driver || {};
  const documents = Array.isArray(page.documents) ? page.documents : [];
  const dueDate = (iso) => (iso ? formatDate(iso, page.locale, { timeZone: page.timeZone }) : '—');
  const plateLinks = (driver.vehicles || [])
    .map((vehicle) => `<a href="/d/vehicles/${encodeURIComponent(vehicle.id)}">${escapeHtml(vehicle.plate)}</a>`)
    .join(', ');
  const rows = documents.map((doc) => `
          <tr>
            <td>${escapeHtml(doc.label || 'Document')}</td>
            <td>${escapeHtml(doc.lifetime ? 'Valid for life' : (doc.number || '—'))}</td>
            <td>${escapeHtml(doc.lifetime ? '—' : dueDate(doc.expiry))}</td>
            <td>${complianceChipHtml(doc)}</td>
          </tr>`).join('');
  const table = documents.length
    ? `<div class="card table-wrap"><table class="rec">
        <thead><tr><th>Document</th><th>Number</th><th>Expiry</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : '<div class="card"><p class="muted">No driver documents on file yet — the driver adds them in WhatsApp and they appear here.</p></div>';

  const body = `
<p class="muted"><a href="/d/compliance">← Compliance</a></p>
<h1>${escapeHtml(driver.name || 'Driver')}</h1>
<p class="muted">${escapeHtml(driver.phone || 'No phone on file')}${plateLinks ? ` · ${plateLinks}` : ''} · signed in as ${escapeHtml(emailMasked)}</p>
<h2>Documents</h2>
${table}
<p class="muted" style="font-size:13px;">Read-only here — reply in WhatsApp with a new date to update a document.</p>`;
  return renderPageShell(`${driver.name || 'Driver'} — compliance`, body, { headerRight: dashboardNav() });
}

/**
 * `/d/reports` (Phase 14D) — the reports builder form. A GET form to
 * `/d/reports.pdf`: the selection lives in the URL, so the result is
 * shareable, reloadable and back-button safe (the 14B/14C convention).
 */
export function renderReportsPage({ vehicles = [], metricsByCategory = null, spec = {}, error = null } = {}) {
  const range = spec.range || 'this_month';
  const selectedMetrics = new Set(spec.metricIds || []);
  const selectedVehicles = new Set(spec.vehicleIds || []);
  const fromDay = String(spec.from || '').slice(0, 10);
  const toDay = String(spec.to || '').slice(0, 10);
  const groups = metricsByCategory || CUSTOM_METRIC_CATEGORIES.map((category) => ({
    category,
    metrics: CUSTOM_METRICS.filter((metric) => metric.category === category)
  }));
  const rangeOption = (value, label) => `
      <label class="radio"><input type="radio" name="range" value="${value}"${range === value ? ' checked' : ''}> <span>${escapeHtml(label)}</span></label>`;
  const vehicleBoxes = (vehicles || []).map((vehicle) => `
      <label class="check"><input type="checkbox" name="vehicles" value="${escapeHtml(vehicle.id)}"${selectedVehicles.has(vehicle.id) ? ' checked' : ''}> <span>${escapeHtml(vehicle.plate_number || 'Fleet vehicle')}${vehicle.make_model ? `<span class="muted"> · ${escapeHtml(vehicle.make_model)}</span>` : ''}</span></label>`).join('');
  const metricBoxes = groups.map((group) => `
      <fieldset class="metric-group">
        <legend>${escapeHtml(group.category)}</legend>
        ${group.metrics.map((metric) => `<label class="check"><input type="checkbox" name="metrics" value="${escapeHtml(metric.id)}"${selectedMetrics.has(metric.id) ? ' checked' : ''}> <span>${escapeHtml(metric.label)}</span></label>`).join('')}
      </fieldset>`).join('');

  const body = `
<h1>Build a report</h1>
<p class="muted">Pick a period, the vehicles and the numbers you want — the PDF downloads straight away. It never uses your monthly report quota.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="GET" action="/d/reports.pdf">
  <h2>Period</h2>
  <div class="card">
    ${rangeOption('this_month', 'This month')}
    ${rangeOption('last_30_days', 'Last 30 days')}
    ${rangeOption('this_year', 'This year')}
    ${rangeOption('custom', 'Custom range')}
    <div class="filters" style="margin-top:10px;">
      <label>From<input type="date" name="from" value="${escapeHtml(fromDay)}"></label>
      <label>To<input type="date" name="to" value="${escapeHtml(toDay)}"></label>
    </div>
    <p class="muted" style="font-size:13px;">The two dates are used when you pick Custom range.</p>
  </div>
  <h2>Vehicles</h2>
  <div class="card">
    ${vehicleBoxes || '<p class="muted">No vehicles yet — your report covers the fleet once you add one.</p>'}
    <p class="muted" style="font-size:13px;">Leave every box unticked to report across the whole fleet.</p>
  </div>
  <h2>Metrics</h2>
  <div class="card metrics">${metricBoxes}</div>
  <p><button type="submit">Build my PDF</button></p>
</form>`;
  return renderPageShell('Build a report', body, { headerRight: dashboardNav() });
}

/**
 * `/d/settings` (Phase 14D) — one editable preference (weekly report), the data
 * export, the plan pointer and read-only account facts.
 */
export function renderSettingsPage({ settings, saved = false, error = null } = {}) {
  if (!settings?.ok) {
    return renderErrorPage(503, 'Your settings could not be loaded just now. Please try again in a moment.').html;
  }
  const when = settings.sessionExpiresAt
    ? formatDate(settings.sessionExpiresAt, settings.locale, { timeZone: settings.timeZone })
    : null;
  const body = `
<h1>Settings</h1>
<p class="muted">Signed in as ${escapeHtml(settings.emailMasked)} · ${escapeHtml(settings.phoneMasked)}</p>
${saved ? '<p><span class="chip ok">Saved</span></p>' : ''}
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<h2>Weekly report</h2>
<div class="card">
  <form method="POST" action="/d/settings">
    <label class="check"><input type="checkbox" name="weekly_report" value="on"${settings.weeklyReportOn ? ' checked' : ''}> <span>Send me a one-message fleet summary every Monday at 8:00 AM</span></label>
    <input type="hidden" name="action" value="save_weekly">
    <p class="muted" style="font-size:13px;">It never uses your monthly report quota.</p>
    ${settings.weeklyReportKnown === false ? '<p class="muted" style="font-size:13px;">I could not read this setting just now — saving will still work.</p>' : ''}
    <p><button type="submit">Save weekly report</button></p>
  </form>
</div>
<h2>Monthly PDF summary</h2>
<div class="card">
  <form method="POST" action="/d/settings">
    <label class="check"><input type="checkbox" name="monthly_report" value="on"${settings.monthlyReportOn ? ' checked' : ''}> <span>Email me my fleet's month as a PDF on the 1st of every month at 8:00 AM</span></label>
    <input type="hidden" name="action" value="save_monthly">
    <p class="muted" style="font-size:13px;">One email with the branded PDF attached — it never uses your monthly report quota, and it is separate from the Monday summary.</p>
    ${settings.monthlyReportKnown === false ? '<p class="muted" style="font-size:13px;">I could not read this setting just now — saving will still work.</p>' : ''}
    <p><button type="submit">Save monthly summary</button></p>
  </form>
</div>
<h2>Your data</h2>
<div class="card">
  <p><a href="/d/export.csv">Download all my data (CSV)</a></p>
  <p class="muted" style="font-size:13px;">Expenses, earnings, reminders, vehicle and driver documents, and receipt records in one file.</p>
</div>
<h2>Your plan</h2>
<div class="card">
  <p><strong>${escapeHtml(settings.planLabel)}</strong></p>
  <p class="muted" style="font-size:13px;">To upgrade, downgrade or change payment, reply <strong>subscription</strong> in WhatsApp — checkout stays in chat.</p>
</div>
<h2>Account</h2>
<div class="card">
  <p>Email: ${escapeHtml(settings.emailMasked)} <span class="muted">(change it in WhatsApp)</span></p>
  <p>Phone: ${escapeHtml(settings.phoneMasked)} · Language: ${escapeHtml(settings.language)} · Units: ${escapeHtml(settings.unitSystem)} · Country: ${escapeHtml(settings.countryLabel)}</p>
  ${when ? `<p class="muted" style="font-size:13px;">This browser stays signed in until ${escapeHtml(when)}.</p>` : ''}
  <p><a href="/d/logout">Log out of this browser</a></p>
</div>`;
  return renderPageShell('Settings', body, { headerRight: dashboardNav() });
}

/** Phase 15 navs — one per lane, never mixed. */
function driverNav() {
  return '<a href="/d/driver">Overview</a> · <a href="/d/driver/daybook">Daybook</a> · <a href="/d/driver/compliance">Compliance</a> · <a href="/d/logout">Log out</a>';
}

function adminNav() {
  return '<a href="/d/admin">Owners</a> · <a href="/d/care">Care</a> · <a href="/d/logout">Log out</a>';
}

function kpiStripHtml(kpis = []) {
  const rows = (kpis || []).slice(0, 6);
  if (!rows.length) return '';
  return `<div class="kpis card">${rows.map((kpi) => `
    <div class="kpi"><div class="label">${escapeHtml(kpi.label || '')}</div><div class="value">${escapeHtml(kpi.value ?? '—')}</div>${kpi.hint ? `<div class="muted" style="font-size:12px;">${escapeHtml(kpi.hint)}</div>` : ''}</div>`).join('')}
  </div>`;
}

function ledgerRowsHtml(ledger, locale, timeZone, limit = 12) {
  const groups = Array.isArray(ledger?.groups) ? ledger.groups : [];
  const rows = groups.flatMap((group) => group.rows || []).slice(0, limit);
  if (!rows.length) return '';
  return `<div class="card table-wrap"><table class="rec">
      <thead><tr><th>Date</th><th>Kind</th><th>Description</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td>${escapeHtml(String(row.date || row.at || ''))}</td>
          <td><span class="chip">${escapeHtml(row.kindLabel || row.kind || '')}</span></td>
          <td>${escapeHtml(row.description || '')}</td>
          <td class="num">${escapeHtml(formatMoney(row.amount, ledger.currency || 'USD', locale))}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

/** `/d/driver` (Phase 15) — assigned vehicle, own compliance, last 7 days. */
export function renderDriverHomePage({ data, emailMasked = '' }) {
  if (!data?.ok) {
    return renderErrorPage(503, 'Your driver dashboard could not be loaded just now. Please try again in a moment.').html;
  }
  const vehicleCard = data.vehicle
    ? `<div class="card">
        <h2 style="margin-top:0;">Your vehicle</h2>
        <p><strong>${escapeHtml(data.vehicle.plate)}</strong>${data.vehicle.makeModel ? `<span class="muted"> · ${escapeHtml(data.vehicle.makeModel)}</span>` : ''}
        <span class="chip${data.vehicle.status === 'ACTIVE' ? ' ok' : ''}">${escapeHtml(data.vehicle.status === 'ACTIVE' ? 'Active' : data.vehicle.status)}</span></p>
      </div>`
    : '<div class="card"><p class="muted">No vehicle assigned yet — ask your fleet owner to assign one and it appears here.</p></div>';

  const documents = data.compliance.documents || [];
  const docRows = documents.slice(0, 6).map((doc) => `
        <tr>
          <td>${escapeHtml(doc.label || 'Document')}</td>
          <td>${escapeHtml(doc.number || '—')}</td>
          <td>${escapeHtml(doc.expiry || '—')}</td>
          <td>${complianceChipHtml({ status: doc.status, daysLeft: doc.daysLeft })}</td>
        </tr>`).join('');

  const body = `
<h1>Your driver dashboard</h1>
<p class="muted">Signed in as ${escapeHtml(emailMasked)} · your own records only</p>
${vehicleCard}
<h2>My compliance</h2>
${kpiStripHtml(data.compliance.kpis)}
${documents.length ? `<div class="card table-wrap"><table class="rec">
    <thead><tr><th>Document</th><th>Number</th><th>Expiry</th><th>Status</th></tr></thead>
    <tbody>${docRows}</tbody></table></div>` : '<div class="card"><p class="muted">No documents on file yet — reply *driver profile* in WhatsApp to add your licence.</p></div>'}
<p class="muted" style="font-size:13px;"><a href="/d/driver/compliance">See all my documents →</a></p>
<h2>This week</h2>
${kpiStripHtml(data.week.kpis)}
${ledgerRowsHtml(data.week.ledger, data.locale, data.timeZone, 6)}
<p class="muted" style="font-size:13px;"><a href="/d/driver/daybook">Open my daybook →</a></p>`;
  return renderPageShell('Your driver dashboard', body, { headerRight: driverNav() });
}

/** `/d/driver/daybook` (Phase 15) — own activity, ledger table. */
export function renderDriverDaybookPage({ page }) {
  if (!page?.ok || !page.data) {
    return renderErrorPage(503, 'Your daybook could not be loaded just now. Please try again in a moment.').html;
  }
  const report = page.data;
  const body = `
<h1>${escapeHtml(report.title || 'My daybook')}</h1>
<p class="muted">${escapeHtml(report.subtitle || '')}</p>
${kpiStripHtml(report.kpis)}
<h2>Your activity ledger</h2>
${ledgerRowsHtml(report.ledgers?.[0], page.locale, page.timeZone, 40) || '<div class="card"><p class="muted">Nothing logged in this window yet — log fuel or an earning in WhatsApp and it appears here.</p></div>'}`;
  return renderPageShell('My daybook', body, { headerRight: driverNav() });
}

/** `/d/driver/compliance` (Phase 15) — own documents, numbers UNMASKED (D3). */
export function renderDriverSelfCompliancePage({ page }) {
  if (!page?.ok) {
    return renderErrorPage(503, 'Your documents could not be loaded just now. Please try again in a moment.').html;
  }
  const documents = Array.isArray(page.documents) ? page.documents : [];
  const rows = documents.map((doc) => `
        <tr>
          <td>${escapeHtml(doc.label || 'Document')}</td>
          <td>${escapeHtml(doc.number || '—')}</td>
          <td>${escapeHtml(doc.expiry || '—')}</td>
          <td>${complianceChipHtml({ status: doc.status, daysLeft: doc.daysLeft })}</td>
        </tr>`).join('');
  const table = documents.length
    ? `<div class="card table-wrap"><table class="rec">
        <thead><tr><th>Document</th><th>Number</th><th>Expiry</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : '<div class="card"><p class="muted">No documents on file yet — reply *driver profile* in WhatsApp to add your licence.</p></div>';
  const body = `
<p class="muted"><a href="/d/driver">← Overview</a></p>
<h1>My compliance</h1>
<p class="muted">${page.vehicle ? `Assigned vehicle: ${escapeHtml(page.vehicle.plate)}` : 'No vehicle assigned yet'} · your own documents</p>
${kpiStripHtml(page.kpis)}
<h2>My documents</h2>
${table}
<p class="muted" style="font-size:13px;">Read-only here — reply in WhatsApp with a new date to update a document.</p>`;
  return renderPageShell('My compliance', body, { headerRight: driverNav() });
}

/** `/d/admin` (Phase 15) — the cross-tenant owner list, read-only. */
export function renderAdminOwnersPage({ data, search = '' }) {
  if (!data?.ok) {
    return renderErrorPage(503, 'The owner list could not be loaded just now. Please try again in a moment.').html;
  }
  const owners = Array.isArray(data.owners) ? data.owners : [];
  const rows = owners.map((owner) => `
        <tr>
          <td><a href="/d/admin/owners/${encodeURIComponent(owner.id)}">${escapeHtml(owner.name)}</a></td>
          <td>${escapeHtml(owner.phoneMasked)}</td>
          <td>${escapeHtml(owner.country)}</td>
          <td class="num">${Number(owner.vehicleCount)}</td>
          <td class="num">${Number(owner.activeCount)}</td>
        </tr>`).join('');
  const table = owners.length
    ? `<div class="card table-wrap"><table class="rec">
        <thead><tr><th>Owner</th><th>Phone</th><th>Country</th><th class="num">Vehicles</th><th class="num">Active</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : `<div class="card"><p class="muted">${search ? 'No owner matches that search.' : 'No owner has a vehicle on file yet.'}</p></div>`;
  const body = `
<h1>Owners</h1>
<p class="muted">${Number(data.totalOwners || 0)} owner${Number(data.totalOwners || 0) === 1 ? '' : 's'} with a fleet · read-only · every visit is audited</p>
<form method="GET" action="/d/admin" class="filters card">
  <label>Search by name or visible digits<input type="text" name="q" maxlength="40" value="${escapeHtml(search)}"></label>
  <div class="filters-actions"><button type="submit">Search</button><a href="/d/admin">Clear</a></div>
</form>
${table}`;
  return renderPageShell('Owners', body, { headerRight: adminNav() });
}

/** `/d/admin/owners/:id` (Phase 15) — one owner's fleet, read-only + audited. */
export function renderAdminFleetPage({ fleet }) {
  if (!fleet?.ok) {
    return renderErrorPage(503, 'That fleet could not be loaded just now. Please try again in a moment.').html;
  }
  const owner = fleet.owner || {};
  const vehicles = fleet.directory?.vehicles || [];
  const vehicleRows = vehicles.map((vehicle) => `
        <tr>
          <td>${escapeHtml(vehicle.plate)}${vehicle.makeModel ? `<span class="muted"> · ${escapeHtml(vehicle.makeModel)}</span>` : ''}</td>
          <td><span class="chip${vehicle.active ? ' ok' : ''}">${escapeHtml(vehicle.active ? 'Active' : String(vehicle.status || 'Inactive'))}</span></td>
          <td>${escapeHtml(vehicle.driverName || 'No driver')}</td>
          <td class="num">${escapeHtml(`${formatNumber(vehicle.odometer, fleet.card?.locale || 'en-US')} ${vehicle.distanceUnit || ''}`.trim())}</td>
          <td>${vehicle.soonest ? `${escapeHtml(vehicle.soonest.label)} ${complianceChipHtml(vehicle.soonest)}` : '<span class="muted">—</span>'}</td>
        </tr>`).join('');
  const vehicleTable = vehicles.length
    ? `<div class="card table-wrap"><table class="rec">
        <thead><tr><th>Vehicle</th><th>Status</th><th>Driver</th><th class="num">Odometer</th><th>Soonest</th></tr></thead>
        <tbody>${vehicleRows}</tbody></table></div>`
    : '<div class="card"><p class="muted">This owner has no live vehicles.</p></div>';
  const totals = fleet.compliance?.totals || null;
  const body = `
<p class="muted"><a href="/d/admin">← Owners</a></p>
<h1>${escapeHtml(owner.name || 'Owner')}</h1>
<p class="muted">${escapeHtml(owner.phoneMasked || '—')} · ${escapeHtml(owner.emailMasked || '—')} · ${escapeHtml(owner.country || '—')} · read-only</p>
${fleet.card ? kpiStripHtml([
    { label: 'Spend', value: fleet.card.kpis?.spend ?? 0, hint: 'all time' },
    { label: 'Earnings', value: fleet.card.kpis?.earnings ?? 0, hint: 'all time' },
    { label: 'Active vehicles', value: `${fleet.card.kpis?.activeVehicles ?? 0} of ${fleet.card.kpis?.totalVehicles ?? 0}`, hint: 'in service' }
  ].map((kpi) => (typeof kpi.value === 'number' ? { ...kpi, value: formatMoney(kpi.value, fleet.card.currency, fleet.card.locale) } : kpi))) : ''}
<h2>Vehicles</h2>
${vehicleTable}
<h2>Compliance</h2>
<div class="card"><p class="muted">Monitored ${Number(totals?.monitored || 0)} · due in 30 days ${Number(totals?.expiring30Days || 0)} · expired ${Number(totals?.expired || 0)}</p></div>`;
  return renderPageShell(`${owner.name || 'Owner'} — fleet`, body, { headerRight: adminNav() });
}

/** `/d/care` (Phase 19) — Amina's escalated queue + investigation + lessons. */
export function renderCareQueuePage({ data } = {}) {
  if (!data?.ok) {
    return renderErrorPage(503, 'The care queue could not be loaded just now. Please try again in a moment.').html;
  }
  const counts = data.counts || {};
  const kpis = kpiStripHtml([
    { label: 'Escalated', value: Number(counts.escalated || 0), hint: 'waiting for a human' },
    { label: 'Open', value: Number(counts.open || 0), hint: 'not yet escalated' },
    { label: 'In progress', value: Number(counts.inProgress || 0), hint: 'a human is on it' },
    { label: 'Lessons', value: (data.learnings || []).length, hint: 'learned from human replies' }
  ]);
  const ticketCards = (data.escalated || []).map((ticket) => {
    const investigation = (ticket.investigation || []).slice(-10);
    const steps = investigation.length
      ? `<ul class="plain invest">${investigation.map((message) => `<li>🔎 ${escapeHtml(String(message.message_body || '').slice(0, 300))}</li>`).join('')}</ul>`
      : '<p class="muted">No investigation steps were recorded (the engine pre-gate sent this straight to a human).</p>';
    const draft = ticket.ai_draft
      ? `<h3>🤖 Amina\'s draft (not sent)</h3><blockquote>${escapeHtml(String(ticket.ai_draft).slice(0, 1200))}</blockquote>`
      : '<p class="muted">No draft was prepared.</p>';
    return `<div class="card">
      <p><strong>${escapeHtml(ticket.subject || ticket.message_body || 'Support ticket')}</strong>
      <span class="chip bad">ESCALATED</span><span class="chip">${escapeHtml(ticket.issue_category || 'other')}</span></p>
      <p class="muted">${escapeHtml(ticket.sender_email || ticket.whatsapp_number || 'unknown sender')} · ticket ${escapeHtml(String(ticket.id || '').slice(0, 8))}</p>
      <h3>🔎 Investigation log</h3>
      ${steps}
      ${draft}
      <p class="muted" style="font-size:13px;">Reply from the console: <code>care reply ${escapeHtml(String(ticket.id || '').slice(0, 8))} &lt;text&gt;</code></p>
    </div>`;
  }).join('');
  const escalations = (data.escalated || []).length
    ? ticketCards
    : '<div class="card"><p class="muted">No escalated tickets — Amina is handling the inbox. 🎉</p></div>';
  const lessons = (data.learnings || []).length
    ? `<div class="card"><ul class="plain">${(data.learnings || []).slice(0, 10).map((row) => `<li>💡 ${escapeHtml(String(row.lesson || ''))}${row.trigger_context ? `<span class="muted"> · ${escapeHtml(String(row.trigger_context).slice(0, 120))}</span>` : ''}</li>`).join('')}</ul></div>`
    : '<div class="card"><p class="muted">No lessons learned yet — every human reply to an escalation teaches Amina one rule.</p></div>';
  const body = `
<h1>Care queue</h1>
<p class="muted">Amina triages support email first; anything she cannot resolve lands here. Read-only · every visit is audited.</p>
${kpis}
<h2>Escalated tickets</h2>
${escalations}
<h2>Lessons learned</h2>
${lessons}`;
  return renderPageShell('Care queue', body, { headerRight: adminNav() });
}

/** `/d/analytics` (Phase 19) — tyre wear + six-month cost-per-km trend (SVG). */
export function renderAnalyticsPage({ data } = {}) {
  if (!data?.ok) {
    return renderErrorPage(503, 'Your analytics could not be loaded just now. Please try again in a moment.').html;
  }
  const unit = data.distanceUnit || data.trend?.months?.[0]?.distanceUnit || 'km';
  const locale = data.locale || 'en-US';
  const kpis = kpiStripHtml([
    { label: 'Spend (6 months)', value: formatMoney(data.trend?.totalSpend || 0, data.currency, locale), hint: 'all expense types' },
    { label: `Distance (6 months)`, value: `${formatNumber(data.trend?.totalDistance || 0, locale)} ${unit}`, hint: 'logged odometer movement' },
    { label: `Average cost / ${unit}`, value: data.trend?.averageCostPerKm !== null && data.trend?.averageCostPerKm !== undefined ? formatMoney(data.trend.averageCostPerKm, data.currency, locale) : '—', hint: 'spend ÷ distance' },
    { label: `Peak cost / ${unit}`, value: data.trend?.peakCostPerKm !== null && data.trend?.peakCostPerKm !== undefined ? formatMoney(data.trend.peakCostPerKm, data.currency, locale) : '—', hint: 'highest month' }
  ]);

  const tyres = data.tyres || [];
  const tyreCards = tyres.length
    ? tyres.map((row) => {
        if (row.status === 'no_data') {
          return `<div class="card">
            <p><strong>${escapeHtml(row.plate)}</strong>${row.makeModel ? `<span class="muted"> · ${escapeHtml(row.makeModel)}</span>` : ''} <span class="chip">No tyre data</span></p>
            <p class="muted">Log a Tyres expense with the odometer reading in WhatsApp and the wear clock starts.</p>
          </div>`;
        }
        const pct = Math.max(0, Math.min(100, Number(row.remainingPct) || 0));
        const low = row.replaceSoon || pct <= 20;
        return `<div class="card">
          <p><strong>${escapeHtml(row.plate)}</strong>${row.makeModel ? `<span class="muted"> · ${escapeHtml(row.makeModel)}</span>` : ''}
          ${row.replaceSoon ? '<span class="chip bad">Replace soon</span>' : '<span class="chip ok">OK</span>'}</p>
          <p>${formatNumber(row.kmSince || 0, locale)} ${escapeHtml(unit)} since the last tyre change · ~${pct}% life remaining
          <span class="muted">(assuming ${formatNumber(row.lifespan || 0, locale)} ${escapeHtml(unit)} lifespan)</span></p>
          <div class="progress${low ? ' low' : ''}"><span style="width:${pct}%"></span></div>
          ${row.note ? `<p class="muted" style="font-size:13px;">${escapeHtml(row.note)}</p>` : ''}
        </div>`;
      }).join('')
    : '<div class="card"><p class="muted">No live vehicles yet — register your first vehicle in WhatsApp and its tyre clock appears here.</p></div>';

  const chart = data.chart || { points: [], polyline: '', width: 640, height: 200, padding: 34, maxValue: 0 };
  const months = data.trend?.months || [];
  const gridY = [0, 1, 2, 3].map((i) => chart.padding + ((chart.height - chart.padding * 2) * i) / 3);
  const svg = chart.points.length
    ? `<div class="card"><svg class="trend" viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="Cost per ${escapeHtml(unit)} over the last six months">
        ${gridY.map((y) => `<line x1="${chart.padding}" y1="${y}" x2="${chart.width - chart.padding}" y2="${y}" class="grid"/>`).join('')}
        <polyline points="${chart.polyline}" class="line"/>
        ${chart.points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4" class="dot"><title>${escapeHtml(point.month.label)}: ${formatMoney(point.value, data.currency, locale)}/${escapeHtml(unit)} · spend ${formatMoney(point.month.spend, data.currency, locale)} · ${formatNumber(point.month.distance || 0, locale)} ${escapeHtml(unit)}</title></circle>`).join('')}
        ${months.map((month, index) => {
          const x = chart.padding + (months.length > 1 ? ((chart.width - chart.padding * 2) * index) / (months.length - 1) : 0);
          return `<text x="${x}" y="${chart.height - 10}" text-anchor="middle" class="xlabel">${escapeHtml(month.label)}</text>`;
        }).join('')}
      </svg>
      <p class="muted" style="font-size:13px;">${formatNumber(data.trend?.totalSpend || 0, locale) ? formatMoney(data.trend?.totalSpend || 0, data.currency, locale) : formatMoney(0, data.currency, locale)} spent over ${formatNumber(data.trend?.totalDistance || 0, locale)} ${escapeHtml(unit)} in six months. A month with no odometer movement shows no point.</p></div>`
    : '<div class="card"><p class="muted">No distance recorded in the last six months yet — log two odometer readings in a month and the trend appears here.</p></div>';

  const body = `
<h1>Analytics</h1>
<p class="muted">Tyre wear and cost per ${escapeHtml(unit)} · read-only, engine-calculated</p>
${kpis}
<h2>Tyre wear</h2>
${tyreCards}
<h2>Cost per ${escapeHtml(unit)} trend</h2>
${svg}`;
  return renderPageShell('Analytics', body, { headerRight: dashboardNav() });
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
  // v1.80.0 (Phase 19) — Amina's care queue + the owner analytics page.
  buildCareQueue,
  renderCareQueuePage,
  buildAnalyticsPage,
  renderAnalyticsPage,
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
  recordsQueryString,
  COMPLIANCE_VIEWS,
  COMPLIANCE_DUE_DAYS,
  parseComplianceFilters,
  complianceInView,
  complianceStatusOf,
  complianceChipHtml,
  filterComplianceReport,
  buildComplianceBoard,
  buildDriverCompliancePage,
  buildCompliancePdf,
  renderCompliancePage,
  renderDriverPage,
  REPORT_RANGES,
  REPORT_MAX_METRICS,
  EXPORT_SECTION_CAP,
  EXPORT_COLUMNS,
  parseReportSpec,
  buildDashboardCustomReport,
  buildSettingsPage,
  saveSettings,
  serializeAllDataCsv,
  renderReportsPage,
  renderSettingsPage,
  DASHBOARD_ROLES,
  resolveDashboardRole,
  buildDriverHome,
  buildDriverDaybookPageData,
  buildDriverSelfCompliancePage,
  buildAdminOwnersList,
  buildAdminFleetView,
  renderDriverHomePage,
  renderDriverDaybookPage,
  renderDriverSelfCompliancePage,
  renderAdminOwnersPage,
  renderAdminFleetPage
};
