/**
 * Saka Fleet — Dashboard routes (v1.74.0, Phase 13; + Phase 14A in v1.75.0)
 * -----------------------------------------------------------------------
 * GET  /d/login         -> static phone-entry page (v1.82.0 WhatsApp OTP)
 * POST /d/login         -> mint + send a WhatsApp OTP, render the code step
 * GET  /d/admin/login   -> superadmin door (D4)
 * POST /d/admin/login   -> admin OTP (SUPERADMIN_PHONE only)
 * GET  /d/assets/:file  -> allowlisted fonts/logo (v1.83.0, immutable cache)
 * GET  /d/transfer      -> passbook handover (v1.83.0, owner)
 * POST /d/transfer/start|verify|cancel -> steps 1-3 of the transfers.js machine
 * GET  /d/subscription  -> plan, capacity, add-ons, payment history (v1.83.0)
 * POST /d/subscription/checkout|addon -> engine checkout -> Paystack
 * GET  /d/:token        -> OTP entry page (pre-1.82.0 links still land here)
 * POST /d/verify        -> OTP check -> HttpOnly session cookie -> role home
 * GET  /d               -> overview (session cookie required)
 * GET  /d/vehicles      -> fleet list (v1.75.0, session required)
 * GET  /d/vehicles/:id  -> one vehicle (v1.75.0, session required, owner-scoped)
 * GET  /d/admin/command -> the business command center (v1.86.0, admin only)
 * GET  /d/logout        -> clears the session + cookie, then 303 to the door
 *
 * A1: while DASHBOARD_ENABLED is off every route answers exactly like an
 * unregistered Fastify route (generic 404 JSON) — the dashboard's existence is
 * never revealed. The form parser is registered inside this module's own
 * encapsulated scope, so the rest of the app keeps its JSON/text parsers.
 */

import { buildCommandCenterMetrics } from '../services/commandCenter.js';
import formbody from '@fastify/formbody';
import fs from 'node:fs';
import path from 'node:path';
import {
  isDashboardEnabled,
  getLinkState,
  verifyDashboardOtp,
  getSessionByToken,
  clearDashboardSession,
  readDashboardCookie,
  dashboardCookieHeader,
  dashboardClearCookieHeader,
  isSecureRequest,
  dashboardOtpReasonCopy,
  maskEmail,
  maskPhone,
  requestDashboardOtp,
  renderLoginPage,
  renderOtpPage,
  DASHBOARD_LOGIN_PATH,
  DASHBOARD_ADMIN_LOGIN_PATH,
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
  queryOwnerRecords,
  // v1.92.0 (Phase 29) — the seller's archived-earnings history (?history=1).
  queryArchivedEarnings,
  loadOwnerVehicles,
  attachReceiptMatches,
  signReceiptUrl,
  signDocumentUrl,
  serializeRecordsCsv,
  buildRecordsPdf,
  RECORDS_PAGE_SIZE,
  RECORDS_EXPORT_MAX_ROWS,
  parseComplianceFilters,
  buildComplianceBoard,
  buildDriverCompliancePage,
  buildCompliancePdf,
  renderCompliancePage,
  renderDriverPage,
  parseReportSpec,
  buildDashboardCustomReport,
  buildSettingsPage,
  saveSettings,
  serializeAllDataCsv,
  renderReportsPage,
  renderSettingsPage,
  // v1.81.0 (Phase 20) — CSV bulk import page.
  renderImportPage,
  DASHBOARD_ROLES,
  buildDriverHome,
  buildDriverDaybookPageData,
  buildDriverSelfCompliancePage,
  buildAdminOwnersList,
  buildAdminFleetView,
  renderDriverHomePage,
  renderDriverDaybookPage,
  renderDriverSelfCompliancePage,
  renderAdminOwnersPage,
  renderAdminCommandPage,
  renderAdminFleetPage,
  // v1.80.0 (Phase 19) — Amina's care queue + the analytics page.
  buildCareQueue,
  renderCareQueuePage,
  buildAnalyticsPage,
  renderAnalyticsPage,
  // v1.85.0 (Phase 24) — kind-aware record meters (Odometer vs Engine hours).
  attachMeterReadings,
  recordsMeterLabel,
  // v1.83.0 (Phase 22) — passbook transfer + subscription pages.
  buildTransferPage,
  renderTransferPage,
  TRANSFER_OPEN_STATUSES,
  buildSubscriptionPage,
  renderSubscriptionPage,
  dashboardBaseUrl,
  // v1.91.0 (Phase 28A) — the admin impersonation store + write-action renderers.
  impersonationCookieHeader,
  impersonationClearCookieHeader,
  readImpersonationCookie,
  resolveImpersonation,
  mintImpersonation,
  clearImpersonationByToken
} from '../services/dashboard.js';
// v1.84.0 (Phase 23) — deleting one stored document reuses the vault service
// (ownership check + bucket remove + VEHICLE_DOCUMENT_DELETED audit).
import { deleteVehicleDocument } from '../services/vehicleDocuments.js';
import { logAdminAudit } from '../services/superadmin.js';
// v1.83.0 (Phase 22) — the transfer machine (reused verbatim) + the billing
// engine + the WhatsApp sender the buyer notification needs.
import {
  initiatePassbookTransfer,
  setBuyerDetailsAndSendReleaseOtp,
  verifyOwnerReleaseOtpAndNotifyBuyer
} from '../services/transfers.js';
import { checkoutForTier, checkoutForAddon, getEntitlements } from '../services/subscriptions.js';
import { recordLabeledReading } from '../services/labelsEverywhere.js';
import { sendWhatsAppText } from '../services/metaMessenger.js';
// v1.91.0 (Phase 28A) — superadmin write actions reuse the engines verbatim.
import { wipeProfileForSignup } from '../services/profileWipe.js';
import { extendAccountTrial } from '../services/trialEngine.js';
import { sendResendEmail } from '../services/mailer.js';
import { isSuperadminPhone } from '../services/superadminIdentity.js';
import { adminActionKeyGenerator } from '../services/rateLimitIdentity.js';
import {
  ADMIN_ACTION_WORDS,
  renderConfirmActionPage,
  renderAdminPassbookPage,
  renderAdminTransferPage,
  renderAdminEmailDraftPage,
  renderAdminEmailPreviewPage,
  withImpersonationBanner,
  loadAdminPassbook,
  buildAdminTransferView,
  emailHtmlFromText
} from '../services/dashboardAdmin.js';
// v1.81.0 (Phase 20) — CSV bulk import engine (parser + validator + writes).
import {
  parseCsv,
  validateImportRows,
  summarizeImport,
  loadRecentExpensesForImport,
  bulkInsertImportRows,
  CSV_IMPORT_MAX_BYTES
} from '../services/csvImport.js';
import { detectCountryFromPhone, buildGlobalContext, regionForCountryCode } from '../services/globalization.js';
import { isHoursLedKind } from '../services/expenseCatalog.js';
import { applyOperatingHours } from '../services/maintenanceReminders.js';
import { buildProReportPdf } from '../services/pdfEngine.js';
import { logSystemError, logWriteFailure } from '../services/systemErrors.js';

/** A1 — identical to Fastify's own "route not found" payload. */
function answerAsNotFound(request, reply) {
  const url = String(request.raw?.url || request.url || '').split('?')[0];
  return reply.code(404).send({
    message: `Route ${request.method}:${url} not found`,
    error: 'Not Found',
    statusCode: 404
  });
}

/**
 * v1.83.0 (Phase 22) — the dashboard's static assets (D1: no static server, no
 * new dependency). A STRICT filename allowlist is the only path input: the
 * filesystem path is built from this table, never from the request, so
 * traversal is impossible by construction. Served immutable; the shell stamps
 * every URL with DASHBOARD_ASSET_VERSION.
 */
const DASHBOARD_ASSET_ALLOWLIST = Object.freeze({
  'Sora-600.woff2': { file: path.join('landing', 'assets', 'fonts', 'Sora-600.woff2'), type: 'font/woff2' },
  'Sora-700.woff2': { file: path.join('landing', 'assets', 'fonts', 'Sora-700.woff2'), type: 'font/woff2' },
  'Manrope-400.woff2': { file: path.join('landing', 'assets', 'fonts', 'Manrope-400.woff2'), type: 'font/woff2' },
  'Manrope-500.woff2': { file: path.join('landing', 'assets', 'fonts', 'Manrope-500.woff2'), type: 'font/woff2' },
  'Manrope-700.woff2': { file: path.join('landing', 'assets', 'fonts', 'Manrope-700.woff2'), type: 'font/woff2' },
  'logo-lockup.png': { file: path.join('landing', 'assets', 'img', 'logo-lockup.png'), type: 'image/png' },
  'favicon.svg': { file: path.join('landing', 'assets', 'img', 'favicon.svg'), type: 'image/svg+xml' },
  'favicon-32.png': { file: path.join('landing', 'assets', 'img', 'favicon-32.png'), type: 'image/png' }
});

function sendHtml(reply, status, html) {
  return reply.code(status).type('text/html; charset=utf-8').send(html);
}

/** v1.83.0 — form bodies are objects (fastify formbody); never assume one. */
function formBody(request) {
  return request.body && typeof request.body === 'object' ? request.body : {};
}

function linkReasonCopy(reason) {
  if (reason === 'link_expired') return 'This sign-in page has expired. Reply *dashboard* on WhatsApp and open the fresh link.';
  if (reason === 'otp_expired') return 'The code for this sign-in has expired. Reply *dashboard* on WhatsApp and start again.';
  if (reason === 'already_used') return 'This sign-in page has already been used. Reply *dashboard* on WhatsApp for a fresh one.';
  if (reason === 'db_error') return 'Something went wrong on our side. Please try again in a moment.';
  return 'This sign-in page is not valid. Reply *dashboard* on WhatsApp and open the fresh link.';
}

function linkReasonStatus(reason) {
  if (reason === 'db_error') return 503;
  if (reason === 'invalid_link') return 400;
  return 410;
}

/** Rule 50 — optional profile context degrades to the slim set. */
async function loadDashboardProfile(supabase, ownerId) {
  if (!supabase || !ownerId) return null;
  const full = 'id, phone_number, email, full_name, country, country_code, preferred_language, currency, locale, unit_system';
  const slim = 'id, phone_number, email, full_name, country_code';
  try {
    let { data, error } = await supabase.from('profiles').select(full).eq('id', ownerId).maybeSingle();
    if (error) {
      ({ data, error } = await supabase.from('profiles').select(slim).eq('id', ownerId).maybeSingle());
    }
    return error ? null : data || null;
  } catch (err) {
    logWriteFailure(supabase, 'dashboard.loadProfile', err);
    return null;
  }
}

// Page renderers live in src/services/dashboard.js (D1 shared shell) and are
// imported above: renderOtpPage / renderOverviewPage / renderVehiclesPage /
// renderVehiclePage / renderLogoutPage / renderErrorPage.

/**
 * Rule 7 — the phone's country code is the primary determinant of a profile's
 * country, so money, units, locale and dates on every dashboard page resolve
 * from the WhatsApp number (v1.75.0 fixes 13C, which passed no countryInfo and
 * silently fell back to USD/en-US for every owner).
 */
function countryForProfile(profile) {
  // v1.85.0 (Phase 24) — an explicit country choice (profiles.country_code,
  // country_source='user' or the phone lock) always wins over phone detection;
  // Canada (+1, no unique prefix) is only reachable this way.
  const storedCode = String(profile?.country_code || '').toUpperCase();
  if (storedCode && storedCode !== 'GLOBAL') {
    const region = regionForCountryCode(storedCode);
    if (region && region.country_code === storedCode) return region;
  }
  const phone = profile?.phone_number;
  return phone ? detectCountryFromPhone(phone) : null;
}

/**
 * v1.82.0 — the signed-in label. Email is nullable now (WhatsApp sign-in), so a
 * page names the masked WhatsApp number instead of a non-existent address.
 */
function accountLabel(profile, session) {
  const email = session?.email || profile?.email;
  if (email) return maskEmail(email);
  return profile?.phone_number ? maskPhone(profile.phone_number) : 'your account';
}

/**
 * D2 (Phase 14D) — CSRF defence-in-depth. The session cookie is HttpOnly +
 * SameSite=Strict and `/d` is never CORS-listed, so a cross-site POST cannot
 * carry the cookie at all; this Origin guard refuses the write outright when a
 * browser tells us it came from another host. A missing Origin (older browsers)
 * falls back to the SameSite=Strict guarantee.
 */
function isCrossOriginWrite(request) {
  const origin = request.headers?.origin;
  if (!origin) return false;
  try {
    return new URL(String(origin)).host !== String(request.headers?.host || '');
  } catch {
    return true;
  }
}

/**
 * The one session gate every signed-in page shares (Phase 15: role-aware).
 * Sends the 401 page (and clears a dead cookie) itself and returns null, so a
 * caller can simply `if (!session) return reply;`.
 *
 * Isolation rules (D2): a session may only open ITS OWN lane.
 * - `owner` pages refuse driver/admin sessions with a warm 403;
 * - `driver` pages refuse anyone else with a 403;
 * - `admin` pages answer **404** to non-admins (the surface's existence is
 *   never confirmed — the A1 philosophy).
 */
async function requireRoleSession(request, reply, supabase, role = 'owner') {
  const sessionToken = readDashboardCookie(request.headers);
  if (!sessionToken) {
    // v1.94.0 (Phase 31) — a signed-out visitor's brand click goes to the site.
    const page = renderErrorPage(401, 'Reply *dashboard* in the WhatsApp chat and open the sign-in link.', { brandHref: 'https://sakafleet.com' });
    sendHtml(reply, page.status, page.html);
    return null;
  }
  const session = await getSessionByToken({ supabase, sessionToken });
  if (!session.ok) {
    reply.header('set-cookie', dashboardClearCookieHeader({ secure: isSecureRequest(request) }));
    const page = renderErrorPage(401, 'Your session has ended. Reply *dashboard* in the WhatsApp chat and sign in again.', { brandHref: 'https://sakafleet.com' });
    sendHtml(reply, page.status, page.html);
    return null;
  }
  const actualRole = DASHBOARD_ROLES.includes(session.role) ? session.role : 'owner';

  // v1.91.0 (Phase 28A) — the impersonation lane (READ-ONLY, D1). A live admin
  // session plus a valid `saka_dash_as` cookie opens the TARGET owner's lane.
  // Owner-lane writes are refused: impersonation never changes data.
  const impersonationToken = readImpersonationCookie(request.headers);
  if (impersonationToken) {
    const impersonation = await resolveImpersonation({
      supabase,
      token: impersonationToken,
      adminOwnerId: actualRole === 'admin' ? session.ownerId : null
    });
    if (impersonation.ok && actualRole === 'admin' && role === 'owner') {
      const method = String(request.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const blocked = renderErrorPage(403, 'Exit impersonation to make changes — this session is read-only.');
        sendHtml(reply, blocked.status, blocked.html);
        return null;
      }
      request.sakaImpersonation = {
        targetName: impersonation.targetName,
        targetId: impersonation.targetProfileId,
        expiresAt: impersonation.expiresAt
      };
      return {
        ...session,
        role: 'owner',
        ownerId: impersonation.targetProfileId,
        impersonated: true,
        adminOwnerId: session.ownerId,
        impersonationExpiresAt: impersonation.expiresAt
      };
    }
    // An expired or foreign cookie is cleared so it can never linger.
    if (!impersonation.ok) {
      reply.header('set-cookie', impersonationClearCookieHeader({ secure: isSecureRequest(request) }));
    }
  }

  if (actualRole === role) return { ...session, role: actualRole };

  if (role === 'admin') {
    const page = renderErrorPage(404, 'That page does not exist.');
    sendHtml(reply, page.status, page.html);
    return null;
  }
  const copy = role === 'driver'
    ? 'That area is for drivers — open your own driver dashboard from WhatsApp.'
    : `That area is for fleet owners${actualRole === 'admin' ? '' : ' — you are signed in as a driver'}.`;
  const page = renderErrorPage(403, copy);
  sendHtml(reply, page.status, page.html);
  return null;
}


/**
 * v1.83.0 (Phase 22) — `transferNotifier` and `checkoutEngine` are injectable
 * seams so suites stay offline: production uses the real email/WhatsApp senders
 * and the real billing engine; a test passes fakes with the same contract.
 */
/**
 * v1.93.0 (Phase 30, Task 1) — which PDF layout this request wants.
 * The explicit `?variant=mobile|a4` wins (unknown values fall back to A4);
 * otherwise a phone User-Agent defaults to the A5 mobile layout, and every
 * other client keeps the unchanged A4 export.
 */
export function pdfVariantFor(request) {
  const requested = String(request?.query?.variant || '').trim().toLowerCase();
  if (requested === 'mobile') return 'mobile';
  if (requested === 'a4' || requested === 'standard' || requested === 'desktop') return 'a4';
  const userAgent = String(request?.headers?.['user-agent'] || '');
  return /Android|iPhone|iPod|iPad|Mobile|Windows Phone/i.test(userAgent) ? 'mobile' : 'a4';
}

export async function registerDashboardRoutes(fastify, {
  supabase,
  requestOtp = requestDashboardOtp,
  transferNotifier = {
    sendReleaseOtp: setBuyerDetailsAndSendReleaseOtp,
    verifyReleaseOtp: verifyOwnerReleaseOtpAndNotifyBuyer
  },
  checkoutEngine = { tier: checkoutForTier, addon: checkoutForAddon },
  // v1.91.0 (Phase 28A) — injectable seams so the admin suite stays offline.
  adminEmailSender = (payload) => sendResendEmail(payload),
  adminTransferEngine = {
    initiate: initiatePassbookTransfer,
    setBuyer: setBuyerDetailsAndSendReleaseOtp,
    verifyRelease: verifyOwnerReleaseOtpAndNotifyBuyer
  }
} = {}) {
  await fastify.register(async (scope) => {
    // v1.81.0 (Phase 20) — the CSV import re-posts the file text through this
    // parser, so give it the CSV ceiling plus headroom (urlencoding overhead).
    await scope.register(formbody, { bodyLimit: CSV_IMPORT_MAX_BYTES + 65536 });
    // A raw text/csv body is accepted too: the page's FileReader path and any
    // scripted upload reach the SAME engine (no multipart, no new dependency).
    scope.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: CSV_IMPORT_MAX_BYTES + 65536 }, (_request, body, done) => done(null, String(body || '')));

    // v1.91.0 (Phase 28A, D1) — every HTML page rendered during an impersonation
    // session carries the sticky yellow banner (injected after the shell header).
    scope.addHook('onSend', async (request, reply, payload) => {
      const ctx = request.sakaImpersonation;
      if (!ctx || typeof payload !== 'string') return payload;
      const contentType = String(reply.getHeader('content-type') || '');
      if (!contentType.includes('text/html')) return payload;
      return withImpersonationBanner(payload, ctx);
    });

    /* -------------------------------------------------------------- */
    /* GET /d/assets/:file — self-hosted fonts + brand (v1.83.0)        */
    /* Allowlisted filenames only; immutable cache; flag-gated 404.     */
    /* -------------------------------------------------------------- */
    scope.get('/d/assets/:file', { config: { rateLimit: { max: 240, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      const wanted = String(request.params?.file || '');
      const asset = DASHBOARD_ASSET_ALLOWLIST[wanted];
      if (!asset) {
        const page = renderErrorPage(404, 'That file is not available.');
        return sendHtml(reply, page.status, page.html);
      }
      try {
        const buffer = await fs.promises.readFile(path.join(process.cwd(), asset.file));
        return reply
          .code(200)
          .type(asset.type)
          .header('cache-control', 'public, max-age=31536000, immutable')
          .header('x-content-type-options', 'nosniff')
          .send(buffer);
      } catch {
        const page = renderErrorPage(404, 'That file is not available.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* The static sign-in doors (v1.82.0, Phase 21)                    */
    /* /d/login       -> owner/driver phone entry                      */
    /* /d/admin/login -> superadmin door (D4: never minted at /d/login)*/
    /* -------------------------------------------------------------- */

    /**
     * The role's home page — one place, so /d/verify, /d/login and /d/logout agree.
     * v1.86.0 (Phase 25).
     */
    const dashboardHomeFor = (role) => {
      if (role === 'admin') return '/d/admin';
      if (role === 'driver') return '/d/driver';
      return '/d';
    };

    /**
     * v1.86.0 (Phase 25) — a visitor who already holds a live session is sent to
     * their home instead of being shown a sign-in form (a bookmark never lies).
     * A dead cookie is cleared first (same contract as /d).
     */
    const redirectSignedInVisitor = async (request, reply) => {
      const sessionToken = readDashboardCookie(request.headers);
      if (!sessionToken) return false;
      const session = await getSessionByToken({ supabase, sessionToken });
      if (!session.ok) {
        reply.header('set-cookie', dashboardClearCookieHeader({ secure: isSecureRequest(request) }));
        return false;
      }
      const role = DASHBOARD_ROLES.includes(session.role) ? session.role : 'owner';
      reply.code(303).header('location', dashboardHomeFor(role)).send();
      return true;
    };

    const renderLoginDoor = (admin) => async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (await redirectSignedInVisitor(request, reply)) return reply;
      const notice = String(request.query?.logged_out || '') === '1'
        ? 'You have been logged out. Sign in again with your WhatsApp number — it takes one code.'
        : null;
      return sendHtml(reply, 200, renderLoginPage({ admin, notice }));
    };
    scope.get('/d/login', renderLoginDoor(false));
    scope.get('/d/admin/login', renderLoginDoor(true));

    /**
     * A successful POST renders the OTP step IN PLACE (the raw flow token stays
     * in a hidden field); a refusal re-renders the phone form with the honest
     * reason (D3 — no account found means sign up first). Rate-limited like the
     * verify route; cross-origin writes are refused (the SameSite=Strict cookie
     * defence-in-depth, same as the settings/import writes).
     */
    const handleLoginPost = (admin) => async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(400, 'Please open the sign-in page again.');
        return sendHtml(reply, page.status, page.html);
      }
      const phone = String(request.body?.phone || '').trim();
      try {
        const result = await requestOtp({
          supabase,
          phone,
          role: admin ? 'admin' : 'auto'
        });
        if (!result.ok) {
          return sendHtml(reply, 200, renderLoginPage({ admin, error: dashboardOtpReasonCopy(result.reason) }));
        }
        return sendHtml(reply, 200, renderOtpPage({ token: result.token, destinationMasked: result.phoneMasked }));
      } catch (err) {
        await logSystemError(supabase, err, admin ? '/d/admin/login' : '/d/login');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    };
    scope.post('/d/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, handleLoginPost(false));
    scope.post('/d/admin/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, handleLoginPost(true));

    /* -------------------------------------------------------------- */
    /* GET /d — the signed-in overview (session cookie required)       */
    /* -------------------------------------------------------------- */
    scope.get('/d', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const card = await buildOverviewCard({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, 200, renderOverviewPage({ data: card, emailMasked: accountLabel(profile, session) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/vehicles — the fleet list (Phase 14A)                    */
    /* -------------------------------------------------------------- */
    scope.get('/d/vehicles', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildVehiclesIndex({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, 200, renderVehiclesPage({ data, emailMasked: accountLabel(profile, session) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/vehicles');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/vehicles/:id — one vehicle (Phase 14A)                   */
    /* -------------------------------------------------------------- */
    scope.get('/d/vehicles/:id', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildVehiclePage({
          supabase,
          ownerId: session.ownerId,
          vehicleId: String(request.params?.id || ''),
          profile,
          countryInfo: countryForProfile(profile),
          // v1.86.0 (Phase 25) — `?docs=all` reveals the replaced-file history.
          includeReplacedDocuments: String(request.query?.docs || '') === 'all'
        });
        if (!data.ok && data.reason === 'not_found') {
          const page = renderErrorPage(404, 'That vehicle is not on your fleet. Reply *dashboard* on WhatsApp if you think it should be.');
          return sendHtml(reply, page.status, page.html);
        }
        return sendHtml(reply, 200, renderVehiclePage({ data, emailMasked: accountLabel(profile, session) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/vehicles/:id');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/records — the filterable ledger (Phase 14B)              */
    /* -------------------------------------------------------------- */
    scope.get('/d/records', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const countryInfo = countryForProfile(profile);
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const vehicleIds = vehicles.map((vehicle) => vehicle.id);
        const ctx = buildGlobalContext(countryInfo, profile);
        const parsed = parseRecordsFilters(request.query || {}, { vehicleIds });
        const filters = parsed.ok ? parsed.filters : parseRecordsFilters({}, { vehicleIds }).filters;
        const result = parsed.ok
          ? (parsed.filters.history
            ? await queryArchivedEarnings({ supabase, ownerId: session.ownerId, filters, countryInfo, profile })
            : await queryOwnerRecords({ supabase, ownerId: session.ownerId, vehicleIds, vehicles, filters, countryInfo, profile }))
          : { ok: true, rows: [], total: 0, hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE };
        const rows = parsed.ok ? await attachReceiptMatches({ supabase, rows: result.rows }) : [];
        const data = { ...result, rows, currency: ctx.currency, locale: ctx.locale, timeZone: ctx.timeZone };
        return sendHtml(reply, data.ok ? 200 : 503, renderRecordsPage({
          data,
          filters,
          vehicles,
          emailMasked: accountLabel(profile, session),
          error: parsed.ok ? null : parsed.error
        }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/records');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/records.csv — the SAME filter as the table (no bypass)   */
    /* -------------------------------------------------------------- */
    scope.get('/d/records.csv', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const countryInfo = countryForProfile(profile);
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const vehicleIds = vehicles.map((vehicle) => vehicle.id);
        const ctx = buildGlobalContext(countryInfo, profile);
        const parsed = parseRecordsFilters(request.query || {}, { vehicleIds });
        if (!parsed.ok) {
          const filters = parseRecordsFilters({}, { vehicleIds }).filters;
          const page = renderRecordsPage({
            data: { ok: true, rows: [], total: 0, hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE },
            filters,
            vehicles,
            emailMasked: accountLabel(profile, session),
            error: parsed.error
          });
          return sendHtml(reply, 400, page);
        }
        const result = await (parsed.filters.history
          ? queryArchivedEarnings({
            supabase,
            ownerId: session.ownerId,
            filters: parsed.filters,
            countryInfo,
            profile,
            pageSize: RECORDS_EXPORT_MAX_ROWS,
            offset: 0
          })
          : queryOwnerRecords({
            supabase,
            ownerId: session.ownerId,
            vehicleIds,
            vehicles,
            filters: parsed.filters,
            countryInfo,
            profile,
            pageSize: RECORDS_EXPORT_MAX_ROWS,
            offset: 0
          }));
        if (!result.ok) {
          // A failed query must never look like an empty export (rule 50 honesty).
          await logSystemError(supabase, new Error('records query failed'), '/d/records/csv');
          const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        const metered = attachMeterReadings(result.rows, vehicles);
        const csv = serializeRecordsCsv(metered.rows, { currency: ctx.currency, meterLabel: metered.meterLabel });
        reply.header('content-disposition', `attachment; filename="saka-records-${parsed.filters.from}-to-${parsed.filters.to}.csv"`);
        reply.header('cache-control', 'no-store');
        return reply.code(200).type('text/csv; charset=utf-8').send(csv);
      } catch (err) {
        // Rule 51(iii): the route name is logged, never a row, note, label or amount.
        await logSystemError(supabase, err, '/d/records/csv');
        const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/records.pdf — the SAME filter, streamed (no Storage)      */
    /* -------------------------------------------------------------- */
    scope.get('/d/records.pdf', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const countryInfo = countryForProfile(profile);
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const vehicleIds = vehicles.map((vehicle) => vehicle.id);
        const parsed = parseRecordsFilters(request.query || {}, { vehicleIds });
        const variant = pdfVariantFor(request);
        if (!parsed.ok) {
          const filters = parseRecordsFilters({}, { vehicleIds }).filters;
          const page = renderRecordsPage({
            data: { ok: true, rows: [], total: 0, hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE },
            filters,
            vehicles,
            emailMasked: accountLabel(profile, session),
            error: parsed.error
          });
          return sendHtml(reply, 400, page);
        }
        const result = await (parsed.filters.history
          ? queryArchivedEarnings({
            supabase,
            ownerId: session.ownerId,
            filters: parsed.filters,
            countryInfo,
            profile,
            pageSize: RECORDS_EXPORT_MAX_ROWS,
            offset: 0
          })
          : queryOwnerRecords({
            supabase,
            ownerId: session.ownerId,
            vehicleIds,
            vehicles,
            filters: parsed.filters,
            countryInfo,
            profile,
            pageSize: RECORDS_EXPORT_MAX_ROWS,
            offset: 0
          }));
        if (!result.ok) {
          await logSystemError(supabase, new Error('records query failed'), '/d/records/pdf');
          const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        const buffer = await buildRecordsPdf(result.rows, parsed.filters, {
          profile,
          countryInfo,
          vehicles,
          truncated: result.truncated,
          variant
        });
        reply.header('content-disposition', `attachment; filename="saka-records-${parsed.filters.from}-to-${parsed.filters.to}.pdf"`);
        reply.header('cache-control', 'no-store');
        return reply.code(200).type('application/pdf').send(buffer);
      } catch (err) {
        await logSystemError(supabase, err, '/d/records/pdf');
        const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/receipt/:id — a 5-minute signed link (Phase 14B)          */
    /* -------------------------------------------------------------- */
    scope.get('/d/receipt/:id', { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      const answerNotFound = () => {
        const page = renderErrorPage(404, 'That receipt is not available.');
        return sendHtml(reply, page.status, page.html);
      };
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const receiptId = String(request.params?.id || '');
        if (!receiptId) return answerNotFound();
        const { data: receipt, error } = await supabase.from('receipts').select('*').eq('id', receiptId).maybeSingle();
        if (error || !receipt) return answerNotFound();
        // OWN DATA only: the receipt's vehicle must be on the owner's fleet (or
        // the owner scanned it). A miss answers 404, never 403 — existence is
        // never confirmed (same pattern as the vehicle page).
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const onFleet = Boolean(receipt.vehicle_id) && vehicles.some((vehicle) => vehicle.id === receipt.vehicle_id);
        const mine = onFleet || (Boolean(receipt.owner_id) && receipt.owner_id === session.ownerId);
        if (!mine) return answerNotFound();
        const signed = await signReceiptUrl(supabase, receipt);
        if (!signed.ok) return answerNotFound();
        const page = renderReceiptPage({ signedUrl: signed.url });
        reply.header('cache-control', 'no-store');
        return reply.code(page.status).header('location', page.location).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/receipt/:id');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/documents/:id — a stored document (Phase 23)             */
    /* -------------------------------------------------------------- */
    scope.get('/d/documents/:id', { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      const answerNotFound = () => {
        const page = renderErrorPage(404, 'That document is not available.');
        return sendHtml(reply, page.status, page.html);
      };
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const documentId = String(request.params?.id || '');
        if (!documentId) return answerNotFound();
        const { data: document, error } = await supabase.from('vehicle_documents').select('*').eq('id', documentId).maybeSingle();
        if (error || !document) return answerNotFound();
        // OWN DATA only: the document's vehicle must be on the owner's fleet.
        // A miss answers 404, never 403 — existence is never confirmed.
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const onFleet = Boolean(document.vehicle_id) && vehicles.some((vehicle) => vehicle.id === document.vehicle_id);
        if (!onFleet) return answerNotFound();
        const signed = await signDocumentUrl(supabase, document);
        if (!signed.ok) return answerNotFound();
        const page = renderReceiptPage({ signedUrl: signed.url });
        reply.header('cache-control', 'no-store');
        return reply.code(page.status).header('location', page.location).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/documents/:id');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* POST /d/documents/:id/delete — delete one stored file (Phase 23) */
    /* -------------------------------------------------------------- */
    scope.post('/d/documents/:id/delete', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      // Same defence-in-depth as /d/settings: no cross-site write, ever.
      if (isCrossOriginWrite(request)) {
        const denied = renderErrorPage(403, 'That request came from another site — nothing was deleted.');
        return sendHtml(reply, 403, denied.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const documentId = String(request.params?.id || '');
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const vehicleIds = vehicles.map((vehicle) => vehicle.id);
        const del = await deleteVehicleDocument({
          supabase,
          documentId,
          ownerId: session.ownerId,
          vehicleIds,
          senderPhone: 'DASHBOARD'
        });
        if (!del.ok) {
          const missing = del.error === 'not-found' || del.error === 'forbidden';
          const failed = renderErrorPage(missing ? 404 : 400, 'That document could not be deleted (it may already be gone).');
          return sendHtml(reply, failed.status, failed.html);
        }
        const back = del.document?.vehicle_id ? `/d/vehicles/${encodeURIComponent(del.document.vehicle_id)}` : '/d/vehicles';
        return reply.code(303).header('location', back).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/documents/:id/delete');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/compliance — vehicle + driver compliance (Phase 14C)     */
    /* -------------------------------------------------------------- */
    scope.get('/d/compliance', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const countryInfo = countryForProfile(profile);
        const parsed = parseComplianceFilters(request.query || {});
        const view = parsed.ok ? parsed.filters.view : 'all';
        const board = await buildComplianceBoard({ supabase, ownerId: session.ownerId, profile, countryInfo, view });
        const html = renderCompliancePage({
          board,
          filters: { view },
          emailMasked: accountLabel(profile, session),
          error: parsed.ok ? null : parsed.error
        });
        return sendHtml(reply, parsed.ok ? (board.ok ? 200 : 503) : 400, html);
      } catch (err) {
        await logSystemError(supabase, err, '/d/compliance');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/drivers/:id — one assigned driver (Phase 14C)            */
    /* -------------------------------------------------------------- */
    scope.get('/d/drivers/:id', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const page = await buildDriverCompliancePage({
          supabase,
          ownerId: session.ownerId,
          driverId: String(request.params?.id || ''),
          profile,
          countryInfo: countryForProfile(profile)
        });
        if (!page.ok && page.reason === 'not_found') {
          // 404 (never 403) and no profile/phone/number is rendered on this path.
          const missing = renderErrorPage(404, 'That driver is not on your fleet. Reply *dashboard* on WhatsApp if you think it should be.');
          return sendHtml(reply, missing.status, missing.html);
        }
        return sendHtml(reply, page.ok ? 200 : 503, renderDriverPage({ page, emailMasked: accountLabel(profile, session) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/drivers/:id');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/compliance.pdf — the SAME view as the page (Phase 14C)    */
    /* -------------------------------------------------------------- */
    scope.get('/d/compliance.pdf', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const countryInfo = countryForProfile(profile);
        const parsed = parseComplianceFilters(request.query || {});
        if (!parsed.ok) {
          const board = await buildComplianceBoard({ supabase, ownerId: session.ownerId, profile, countryInfo, view: 'all' });
          const html = renderCompliancePage({
            board,
            filters: { view: 'all' },
            emailMasked: accountLabel(profile, session),
            error: parsed.error
          });
          return sendHtml(reply, 400, html);
        }
        const board = await buildComplianceBoard({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo,
          view: parsed.filters.view
        });
        if (!board.ok) {
          await logSystemError(supabase, new Error('compliance query failed'), '/d/compliance/pdf');
          const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        const buffer = await buildCompliancePdf(board.reportData, { profile, countryInfo });
        const day = String(board.generatedAt || new Date().toISOString()).slice(0, 10);
        reply.header('content-disposition', `attachment; filename="saka-compliance-${parsed.filters.view}-${day}.pdf"`);
        reply.header('cache-control', 'no-store');
        return reply.code(200).type('application/pdf').send(buffer);
      } catch (err) {
        await logSystemError(supabase, err, '/d/compliance/pdf');
        const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/reports — the reports builder (Phase 14D)                */
    /* -------------------------------------------------------------- */
    scope.get('/d/reports', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const vehicleIds = vehicles.map((vehicle) => vehicle.id);
        const parsed = parseReportSpec(request.query || {}, { vehicleIds });
        const spec = parsed.ok ? parsed.spec : parseReportSpec({}, { vehicleIds }).spec;
        return sendHtml(reply, parsed.ok ? 200 : 400, renderReportsPage({
          vehicles,
          spec,
          error: parsed.ok ? null : parsed.error
        }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/reports');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/reports.pdf — the SAME spec as the form (Phase 14D)      */
    /* -------------------------------------------------------------- */
    scope.get('/d/reports.pdf', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const countryInfo = countryForProfile(profile);
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const vehicleIds = vehicles.map((vehicle) => vehicle.id);
        const parsed = parseReportSpec(request.query || {}, { vehicleIds });
        if (!parsed.ok) {
          const spec = parseReportSpec({}, { vehicleIds }).spec;
          return sendHtml(reply, 400, renderReportsPage({ vehicles, spec, error: parsed.error }));
        }
        const report = await buildDashboardCustomReport({
          supabase,
          ownerId: session.ownerId,
          spec: parsed.spec,
          countryInfo,
          profile
        });
        if (!report.ok) {
          await logSystemError(supabase, new Error(report.error || 'custom report failed'), '/d/reports/pdf');
          const page = renderErrorPage(500, 'That report could not be built — please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        const buffer = await buildProReportPdf({ ...report.data, variant: pdfVariantFor(request) });
        const day = new Date().toISOString().slice(0, 10);
        reply.header('content-disposition', `attachment; filename="saka-report-${parsed.spec.range}-${day}.pdf"`);
        reply.header('cache-control', 'no-store');
        return reply.code(200).type('application/pdf').send(buffer);
      } catch (err) {
        await logSystemError(supabase, err, '/d/reports/pdf');
        const page = renderErrorPage(500, 'That report could not be built — please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/settings — preferences + data export (Phase 14D)         */
    /* -------------------------------------------------------------- */
    scope.get('/d/settings', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const settings = await buildSettingsPage({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile),
          sessionExpiresAt: session.sessionExpiresAt
        });
        const saved = String(request.query?.saved || '') === '1';
        return sendHtml(reply, settings.ok ? 200 : 503, renderSettingsPage({ settings, saved }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/settings');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* POST /d/settings — ONE writable preference (Phase 14D, D2)      */
    /* -------------------------------------------------------------- */
    scope.post('/d/settings', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      // D2: refuse a cross-origin write BEFORE anything else (defence in depth
      // on top of the HttpOnly + SameSite=Strict cookie and no /d CORS).
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(403, 'That request came from another site — nothing was changed. Open Settings from your dashboard and try again.');
        return sendHtml(reply, 403, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        const action = String(body.action || '');
        if (action !== 'save_weekly' && action !== 'save_monthly') {
          const settings = await buildSettingsPage({ supabase, ownerId: session.ownerId, profile, countryInfo: countryForProfile(profile), sessionExpiresAt: session.sessionExpiresAt });
          return sendHtml(reply, 400, renderSettingsPage({ settings, error: 'Nothing to save — nothing changed.' }));
        }
        // Each toggle writes ONLY its own column (a stray POST can never flip the
        // other preference).
        const patch = action === 'save_weekly'
          ? { weeklyReportOn: String(body.weekly_report || '').toLowerCase() === 'on' }
          : { monthlyReportOn: String(body.monthly_report || '').toLowerCase() === 'on' };
        const result = await saveSettings({ supabase, ownerId: session.ownerId, ...patch });
        if (!result.ok) {
          const settings = await buildSettingsPage({ supabase, ownerId: session.ownerId, profile, countryInfo: countryForProfile(profile), sessionExpiresAt: session.sessionExpiresAt });
          return sendHtml(reply, 200, renderSettingsPage({ settings, error: result.error }));
        }
        return reply.code(303).header('location', '/d/settings?saved=1').send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/settings');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/import — CSV bulk import form (Phase 20)                 */
    /* -------------------------------------------------------------- */

    /** Extract the CSV text from either a text/csv body or a `csv` form field. */
    const readImportCsv = (request) => {
      const body = request.body;
      if (typeof body === 'string') return body;
      if (body && typeof body === 'object' && typeof body.csv === 'string') return body.csv;
      return '';
    };

    /**
     * Phase A of the two-phase import: parse + validate with ONE vehicle read
     * and ONE dedupe read. The confirm step re-runs this exact function, so a
     * tampered hidden field can never smuggle a row past validation.
     */
    const runImportPreview = async ({ ownerId, profile, csvText }) => {
      const parsed = parseCsv(csvText);
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      const vehicles = await loadOwnerVehicles(supabase, ownerId);
      if (!vehicles.length) {
        return { ok: false, status: 409, error: 'No active vehicles yet — register one in WhatsApp first, then import.' };
      }
      const recent = await loadRecentExpensesForImport(supabase, { vehicleIds: vehicles.map((vehicle) => vehicle.id) });
      const validation = validateImportRows({
        rows: parsed.rows,
        vehicles,
        countryCode: countryForProfile(profile)?.country_code || 'GLOBAL',
        recentExpenses: recent.rows,
        now: new Date()
      });
      return { ok: true, validation, preview: summarizeImport(validation), csvText, vehicles };
    };

    scope.get('/d/import', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const ctx = buildGlobalContext(countryForProfile(profile), profile);
        const importVehicles = await loadOwnerVehicles(supabase, session.ownerId).catch(() => []);
        const importedRaw = request.query?.imported;
        const imported = importedRaw === undefined ? null : Math.max(0, Number(importedRaw) || 0);
        return sendHtml(reply, 200, renderImportPage({
          imported,
          emailMasked: accountLabel(profile, session),
          currency: ctx.currency,
          locale: ctx.locale,
          readingLabel: recordsMeterLabel(importVehicles)
        }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/import');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    scope.post('/d/import', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(403, 'That request came from another site — nothing was imported. Open Import from your dashboard and try again.');
        return sendHtml(reply, 403, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const ctx = buildGlobalContext(countryForProfile(profile), profile);
        const csvText = readImportCsv(request);
        const result = await runImportPreview({ ownerId: session.ownerId, profile, csvText });
        const page = renderImportPage({
          preview: result.ok ? result.preview : null,
          csvText,
          error: result.ok ? null : result.error,
          emailMasked: accountLabel(profile, session),
          currency: ctx.currency,
          locale: ctx.locale,
          readingLabel: recordsMeterLabel(result.ok ? result.vehicles : [])
        });
        return sendHtml(reply, result.ok ? 200 : (result.status || 400), page);
      } catch (err) {
        await logSystemError(supabase, err, '/d/import');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* POST /d/import/confirm — re-validate then ONE chunked insert      */
    /* -------------------------------------------------------------- */
    scope.post('/d/import/confirm', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(403, 'That request came from another site — nothing was imported. Open Import from your dashboard and try again.');
        return sendHtml(reply, 403, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const ctx = buildGlobalContext(countryForProfile(profile), profile);
        const emailMasked = accountLabel(profile, session);
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        const confirmVehicles = await loadOwnerVehicles(supabase, session.ownerId).catch(() => []);
        const confirmReadingLabel = recordsMeterLabel(confirmVehicles);
        if (String(body.action || '') !== 'confirm') {
          return sendHtml(reply, 400, renderImportPage({ error: 'Nothing to import — nothing changed.', emailMasked, currency: ctx.currency, locale: ctx.locale, readingLabel: confirmReadingLabel }));
        }
        const csvText = readImportCsv(request);
        const result = await runImportPreview({ ownerId: session.ownerId, profile, csvText });
        if (!result.ok) {
          return sendHtml(reply, result.status || 400, renderImportPage({ csvText, error: result.error, emailMasked, currency: ctx.currency, locale: ctx.locale, readingLabel: confirmReadingLabel }));
        }
        if (!result.preview.counts.valid) {
          return sendHtml(reply, 400, renderImportPage({
            preview: result.preview,
            csvText,
            error: 'No rows are ready to import — fix the highlighted rows first.',
            emailMasked,
            currency: ctx.currency,
            locale: ctx.locale,
            readingLabel: confirmReadingLabel
          }));
        }
        const insert = await bulkInsertImportRows({
          supabase,
          ownerId: session.ownerId,
          validRows: result.validation.valid,
          vehicles: result.vehicles
        });
        if (!insert.ok) {
          return sendHtml(reply, 502, renderImportPage({
            preview: result.preview,
            csvText,
            error: insert.error,
            emailMasked,
            currency: ctx.currency,
            locale: ctx.locale
          }));
        }
        return reply.code(303).header('location', `/d/import?imported=${insert.inserted}`).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/import/confirm');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/export.csv — every record in one CSV (Phase 14D, D3)     */
    /* -------------------------------------------------------------- */
    scope.get('/d/export.csv', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const ctx = buildGlobalContext(countryForProfile(profile), profile);
        const csv = await serializeAllDataCsv({ supabase, ownerId: session.ownerId, currency: ctx.currency });
        const day = new Date().toISOString().slice(0, 10);
        reply.header('content-disposition', `attachment; filename="saka-export-${day}.csv"`);
        reply.header('cache-control', 'no-store');
        return reply.code(200).type('text/csv; charset=utf-8').send(csv);
      } catch (err) {
        await logSystemError(supabase, err, '/d/export/csv');
        const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/driver — the driver's own home (Phase 15)                */
    /* -------------------------------------------------------------- */
    scope.get('/d/driver', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'driver');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildDriverHome({
          supabase,
          driverId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, data.ok ? 200 : 503, renderDriverHomePage({
          data,
          emailMasked: accountLabel(profile, session)
        }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/driver');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/driver/daybook — own activity (Phase 15)                 */
    /* -------------------------------------------------------------- */
    scope.get('/d/driver/daybook', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'driver');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const pageData = await buildDriverDaybookPageData({
          supabase,
          driverId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, pageData.ok ? 200 : 503, renderDriverDaybookPage({ page: pageData }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/driver/daybook');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/driver/compliance — own documents, unmasked (D3)         */
    /* -------------------------------------------------------------- */
    scope.get('/d/driver/compliance', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'driver');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const pageData = await buildDriverSelfCompliancePage({
          supabase,
          driverId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, pageData.ok ? 200 : 503, renderDriverSelfCompliancePage({ page: pageData }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/driver/compliance');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/admin — cross-tenant owner list (Phase 15, audited)      */
    /* -------------------------------------------------------------- */
    scope.get('/d/admin', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const search = String(request.query?.q || '').slice(0, 40);
        const done = String(request.query?.done || '');
        const added = Number(request.query?.added || 0);
        const capped = String(request.query?.capped || '') === '1';
        const notices = {
          'as-exited': 'Impersonation ended — you are still signed in as the superadmin.',
          reset: 'Profile reset — the account and its fleet were erased; the person can sign up fresh.',
          'trial-extended': added > 0
            ? `Trial extended by ${added} day${added === 1 ? '' : 's'}${capped ? ' (the engine cap was reached)' : ''}.`
            : 'Trial extension saved.',
          email: 'Email sent from Saka Fleet.'
        };
        const notice = notices[done] || null;
        const data = await buildAdminOwnersList({ supabase, search });
        // Rule 51(iii) — EVERY admin view is audited (fail-soft inside).
        await logAdminAudit(supabase, profile?.phone_number || session.email || 'DASHBOARD_ADMIN', 'ADMIN_DASHBOARD_VIEW', {
          page: 'owners',
          params: { q: search || null },
          done: done || null
        });
        return sendHtml(reply, data.ok ? 200 : 503, renderAdminOwnersPage({ data, search, notice }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/admin/command — the business command center (v1.86.0)    */
    /* -------------------------------------------------------------- */
    scope.get('/d/admin/command', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const metrics = await buildCommandCenterMetrics({ supabase });
        await logAdminAudit(supabase, profile?.phone_number || session.email || 'DASHBOARD_ADMIN', 'ADMIN_DASHBOARD_VIEW', {
          page: 'command',
          found: metrics.ok === true
        });
        return sendHtml(reply, metrics.ok ? 200 : 503, renderAdminCommandPage({ data: metrics }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/command');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/admin/owners/:id — one fleet, read-only (audited)        */
    /* -------------------------------------------------------------- */
    scope.get('/d/admin/owners/:id', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const ownerId = String(request.params?.id || '');
        const fleet = await buildAdminFleetView({ supabase, ownerId });
        await logAdminAudit(supabase, profile?.phone_number || session.email || 'DASHBOARD_ADMIN', 'ADMIN_DASHBOARD_VIEW', {
          page: 'fleet',
          ownerViewed: ownerId,
          found: fleet.ok === true
        });
        if (!fleet.ok && fleet.reason === 'not_found') {
          const missing = renderErrorPage(404, 'That owner does not exist.');
          return sendHtml(reply, missing.status, missing.html);
        }
        return sendHtml(reply, fleet.ok ? 200 : 503, renderAdminFleetPage({ fleet }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/owners/:id');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* ============================================================== */
    /* v1.91.0 (Phase 28A) — superadmin write actions (D1-D6)          */
    /* Every action: flag gate → Origin → admin session → 5/5-min      */
    /* composite rate limit → typed confirmation → reason → audit →    */
    /* 303 /d/admin?done=<verb>.                                        */
    /* ============================================================== */
    const ADMIN_WRITE_RATE = { rateLimit: { max: 5, timeWindow: '5 minutes', keyGenerator: adminActionKeyGenerator } };
    const adminReason = (body) => String(body?.reason || '').trim().slice(0, 300);
    const adminReasonOk = (reason) => reason.length >= 3;
    const typedExactly = (body, word) => String(body?.confirm || '').trim() === word;
    const adminActor = (profile, session) => profile?.phone_number || session?.email || 'DASHBOARD_ADMIN';
    const adminErrorPage = (reply, status, message) => sendHtml(reply, status, renderErrorPage(status, message).html);

    /* A — impersonate: GET renders the typed confirmation, POST mints the cookie. */
    const impersonatePage = (target, error = null) => renderConfirmActionPage({
      title: 'Impersonate an owner',
      heading: `Impersonate ${target.full_name || target.phone_number || 'this account'}?`,
      targetLabel: `${target.full_name || 'Owner'} · ${maskPhone(target.phone_number)}`,
      description: 'You will see their owner dashboard READ-ONLY for 30 minutes. Every page is audited, nothing can be changed, and Exit returns you to the admin console without signing you out.',
      word: ADMIN_ACTION_WORDS.impersonate,
      reasonRequired: true,
      formAction: `/d/admin/as-user/${encodeURIComponent(target.id)}`,
      submitLabel: 'Start read-only session',
      warning: 'Writes are disabled while impersonating. The session ends by itself after 30 minutes.',
      error
    });

    scope.get('/d/admin/as-user/:id', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const target = await loadDashboardProfile(supabase, String(request.params?.id || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        if (target.id === session.ownerId) return adminErrorPage(reply, 400, 'You are already signed in as this account.');
        return sendHtml(reply, 200, impersonatePage(target));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/as-user/:id');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    scope.post('/d/admin/as-user/:id', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing changed.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const target = await loadDashboardProfile(supabase, String(request.params?.id || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        if (target.id === session.ownerId) return adminErrorPage(reply, 400, 'You cannot impersonate your own account.');
        if (isSuperadminPhone(target.phone_number)) return adminErrorPage(reply, 400, 'That is the superadmin account — impersonation is reserved for customer accounts.');
        const body = formBody(request);
        const reason = adminReason(body);
        if (!typedExactly(body, ADMIN_ACTION_WORDS.impersonate)) return sendHtml(reply, 200, impersonatePage(target, 'Type IMPERSONATE exactly to continue.'));
        if (!adminReasonOk(reason)) return sendHtml(reply, 200, impersonatePage(target, 'Add a short reason (at least 3 characters) — it is stored in the audit log.'));
        const minted = await mintImpersonation({ supabase, adminProfileId: session.ownerId, targetProfileId: target.id });
        if (!minted.ok) return adminErrorPage(reply, 500, 'The read-only session could not start just now — please try again.');
        reply.header('set-cookie', impersonationCookieHeader(minted.token, { secure: isSecureRequest(request) }));
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_IMPERSONATE', {
          reason,
          targetId: target.id,
          targetPhoneMasked: maskPhone(target.phone_number),
          before: { impersonation: 'none' },
          after: { impersonation: target.id, expiresAt: minted.expiresAt }
        });
        return reply.code(303).header('location', '/d').send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/as-user/:id');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* B — exit: clears ONLY saka_dash_as; the admin session is untouched (D1). */
    scope.get('/d/admin/exit-as', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const token = readImpersonationCookie(request.headers);
        const ended = token ? await clearImpersonationByToken({ supabase, token }) : { ok: false };
        reply.header('set-cookie', impersonationClearCookieHeader({ secure: isSecureRequest(request) }));
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_IMPERSONATE_END', {
          reason: 'exit',
          targetId: ended?.targetProfileId || null,
          before: { impersonation: ended?.targetProfileId || null },
          after: { impersonation: 'none' }
        });
        return reply.code(303).header('location', '/d/admin?done=as-exited').send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/exit-as');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* C — reset a profile (reuses wipeProfileForSignup; typed RESET + reason). */
    const resetPage = (target, error = null) => renderConfirmActionPage({
      title: 'Reset a profile',
      heading: `Reset ${target.full_name || target.phone_number || 'this account'}?`,
      targetLabel: `${target.full_name || 'Owner'} · ${maskPhone(target.phone_number)}`,
      description: 'This permanently erases the account, its fleet, ledger, receipts, documents, trials, subscriptions and chat history so the person can sign up fresh.',
      word: ADMIN_ACTION_WORDS.reset,
      reasonRequired: true,
      formAction: `/d/admin/reset/${encodeURIComponent(target.id)}`,
      submitLabel: 'Reset this profile',
      warning: 'This cannot be undone. The full wipe is audited with per-table counts.',
      error
    });

    scope.get('/d/admin/reset/:id', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const target = await loadDashboardProfile(supabase, String(request.params?.id || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        if (target.id === session.ownerId) return adminErrorPage(reply, 400, 'You cannot reset your own account.');
        if (isSuperadminPhone(target.phone_number)) return adminErrorPage(reply, 400, 'The superadmin account can never be reset from the dashboard.');
        return sendHtml(reply, 200, resetPage(target));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/reset/:id');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    scope.post('/d/admin/reset/:id', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing changed.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const target = await loadDashboardProfile(supabase, String(request.params?.id || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        if (target.id === session.ownerId) return adminErrorPage(reply, 400, 'You cannot reset your own account.');
        if (isSuperadminPhone(target.phone_number)) return adminErrorPage(reply, 400, 'The superadmin account can never be reset from the dashboard.');
        const body = formBody(request);
        const reason = adminReason(body);
        if (!typedExactly(body, ADMIN_ACTION_WORDS.reset)) return sendHtml(reply, 200, resetPage(target, 'Type RESET exactly to continue.'));
        if (!adminReasonOk(reason)) return sendHtml(reply, 200, resetPage(target, 'Add a short reason (at least 3 characters) — it is stored in the audit log.'));
        const wipe = await wipeProfileForSignup(supabase, target.phone_number);
        if (!wipe.ok) return adminErrorPage(reply, 400, `The reset was refused: ${wipe.reason || 'unknown reason'}. Nothing was erased.`);
        const sessionsClear = await supabase.from('dashboard_sessions').delete().eq('owner_id', target.id);
        const impersonationsAsTarget = await supabase.from('admin_impersonations').delete().eq('target_profile_id', target.id);
        const impersonationsAsAdmin = await supabase.from('admin_impersonations').delete().eq('admin_profile_id', target.id);
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_PROFILE_RESET', {
          reason,
          targetId: target.id,
          targetPhoneMasked: maskPhone(target.phone_number),
          before: { profiles: 1, phoneMasked: maskPhone(target.phone_number) },
          after: {
            counts: wipe.counts,
            profiles: wipe.profiles,
            vehicles: wipe.vehicles,
            dashboardSessions: sessionsClear?.error ? `error: ${sessionsClear.error.message}` : 'cleared',
            impersonations: impersonationsAsTarget?.error || impersonationsAsAdmin?.error ? 'error' : 'cleared'
          }
        });
        return reply.code(303).header('location', '/d/admin?done=reset').send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/reset/:id');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* D — extend a trial (engine-owned clamp; typed EXTEND + reason + days). */
    const extendTrialPage = (target, error = null) => renderConfirmActionPage({
      title: 'Extend a trial',
      heading: `Extend ${target.full_name || target.phone_number || 'this account'}'s trial`,
      targetLabel: `${target.full_name || 'Owner'} · ${maskPhone(target.phone_number)}`,
      description: 'The engine adds the days to the ACTIVE account trial and re-arms its nudge ladder. The standard cumulative cap (45 days) always applies — the launch-award exception is never reachable from here.',
      word: ADMIN_ACTION_WORDS.extendTrial,
      reasonRequired: true,
      formAction: `/d/admin/extend-trial/${encodeURIComponent(target.id)}`,
      submitLabel: 'Extend the trial',
      fields: [{ type: 'number', name: 'days', label: 'Days to add (1-365)', min: 1, max: 365, value: 15 }],
      error
    });

    scope.get('/d/admin/extend-trial/:id', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const target = await loadDashboardProfile(supabase, String(request.params?.id || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        return sendHtml(reply, 200, extendTrialPage(target));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/extend-trial/:id');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    scope.post('/d/admin/extend-trial/:id', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing changed.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const target = await loadDashboardProfile(supabase, String(request.params?.id || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        const body = formBody(request);
        const reason = adminReason(body);
        const requested = Math.floor(Number(body?.days));
        if (!typedExactly(body, ADMIN_ACTION_WORDS.extendTrial)) return sendHtml(reply, 200, extendTrialPage(target, 'Type EXTEND exactly to continue.'));
        if (!adminReasonOk(reason)) return sendHtml(reply, 200, extendTrialPage(target, 'Add a short reason (at least 3 characters) — it is stored in the audit log.'));
        if (!Number.isFinite(requested) || requested < 1 || requested > 365) return sendHtml(reply, 200, extendTrialPage(target, 'Enter a number of days between 1 and 365.'));
        let beforeEndsAt = null;
        try {
          const { data: beforeTrial } = await supabase
            .from('trial_sessions')
            .select('id, ends_at, status')
            .eq('owner_id', target.id)
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          beforeEndsAt = beforeTrial?.ends_at || null;
        } catch { beforeEndsAt = null; }
        const result = await extendAccountTrial({ supabase, ownerId: target.id, days: requested });
        if (!result.ok) return adminErrorPage(reply, 400, result.error || 'That trial could not be extended just now.');
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_TRIAL_EXTENDED', {
          reason,
          targetId: target.id,
          requestedDays: requested,
          before: { endsAt: beforeEndsAt },
          after: { endsAt: result.endsAt, daysAdded: result.daysAdded, totalDays: result.totalDays, capped: result.capped, capDays: result.capDays }
        });
        const location = `/d/admin?done=trial-extended&added=${Number(result.daysAdded) || 0}${result.capped ? '&capped=1' : ''}`;
        return reply.code(303).header('location', location).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/extend-trial/:id');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* E — passbook view (read-only: plate, masked VIN/token, transfer history). */
    scope.get('/d/admin/passbook/:vehicleId', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const view = await loadAdminPassbook({ supabase, vehicleId: String(request.params?.vehicleId || '') });
        if (!view.ok) return adminErrorPage(reply, 404, 'That vehicle does not exist.');
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_PASSBOOK_VIEW', {
          vehicleId: view.vehicle.id,
          plate: view.vehicle.plate_number || null
        });
        return sendHtml(reply, 200, renderAdminPassbookPage(view));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/passbook/:vehicleId');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* F — facilitate a transfer: steps 1-3 on the web, 4-5 stay on WhatsApp. */
    const transferRedirect = (reply, vehicleId, params = {}) => {
      const query = new URLSearchParams(params).toString();
      return reply.code(303).header('location', `/d/admin/transfer/${encodeURIComponent(vehicleId)}?${query}`).send();
    };
    const transferFlash = (request) => {
      const error = String(request.query?.error || '');
      if (error) return { notice: null, error: `The step was refused: ${error}` };
      if (String(request.query?.ok || '') !== '1') return { notice: null, error: null };
      const step = String(request.query?.step || '');
      const labels = {
        1: 'Handover started — add the buyer details next.',
        2: 'Buyer details saved — the release PIN was emailed to the owner. Ask them for it in WhatsApp.',
        3: 'Release authorised — the buyer was messaged on WhatsApp. Waiting for their ACCEPT.',
        cancel: 'Handover cancelled — nothing moved.'
      };
      return { notice: labels[step] || 'Saved.', error: null };
    };

    scope.get('/d/admin/transfer/:vehicleId', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const vehicleId = String(request.params?.vehicleId || '');
        const view = await buildAdminTransferView({ supabase, vehicleId });
        if (!view.ok) return adminErrorPage(reply, 404, 'That vehicle does not exist.');
        const flash = transferFlash(request);
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_TRANSFER_VIEW', {
          vehicleId,
          plate: view.vehicle.plate_number || null,
          status: view.openTransfer?.status || null
        });
        return sendHtml(reply, 200, renderAdminTransferPage({
          ...view,
          vehicleId,
          notice: flash.notice,
          error: flash.error
        }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/transfer/:vehicleId');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* F1 — initiate (engine step 1). */
    scope.post('/d/admin/transfer/:vehicleId/step1', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing changed.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const vehicleId = String(request.params?.vehicleId || '');
        const view = await buildAdminTransferView({ supabase, vehicleId });
        if (!view.ok) return adminErrorPage(reply, 404, 'That vehicle does not exist.');
        if (view.openTransfer) return transferRedirect(reply, vehicleId, { error: 'a handover is already in flight' });
        if (!view.owner?.phone_number) return transferRedirect(reply, vehicleId, { error: 'the owner has no WhatsApp number on file' });
        const result = await adminTransferEngine.initiate({
          fromPhone: view.owner.phone_number,
          vehicleCandidate: view.vehicle.plate_number,
          supabase
        });
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_TRANSFER_INITIATE', {
          vehicleId,
          ok: result?.success === true,
          error: result?.success ? null : (result?.error || 'refused'),
          before: { status: null },
          after: result?.success ? { status: 'PENDING_TARGET_DETAILS', transferId: result.transferId, isFreeTransfer: result.isFreeTransfer, feeAmount: result.feeAmount } : null
        });
        if (!result?.success) return transferRedirect(reply, vehicleId, { error: result?.error || 'the engine refused the handover' });
        return transferRedirect(reply, vehicleId, { ok: '1', step: '1' });
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/transfer/:vehicleId/step1');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* F2 — buyer details (engine step 2; the PIN is emailed to the OWNER only). */
    scope.post('/d/admin/transfer/:vehicleId/step2', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing changed.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const vehicleId = String(request.params?.vehicleId || '');
        const body = formBody(request);
        const transferId = String(body.transfer_id || '');
        const buyerPhone = String(body.buyer_phone || '').trim();
        const buyerEmail = String(body.buyer_email || '').trim();
        const view = await buildAdminTransferView({ supabase, vehicleId });
        if (!view.ok) return adminErrorPage(reply, 404, 'That vehicle does not exist.');
        if (!view.openTransfer || String(view.openTransfer.id) !== transferId) {
          return transferRedirect(reply, vehicleId, { error: 'that handover is not in flight for this vehicle' });
        }
        if (!/^\+?[0-9\s().-]{9,20}$/.test(buyerPhone)) return transferRedirect(reply, vehicleId, { error: 'the buyer number looks incomplete' });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(buyerEmail)) return transferRedirect(reply, vehicleId, { error: 'the buyer email looks incomplete' });
        const result = await adminTransferEngine.setBuyer({ transferId, buyerPhone, buyerEmail, supabase });
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_TRANSFER_DETAILS', {
          vehicleId,
          ok: result?.success === true,
          error: result?.success ? null : (result?.error || 'refused'),
          before: { status: view.openTransfer.status },
          after: result?.success ? { status: 'PENDING_OWNER_RELEASE_OTP', buyerMasked: maskPhone(buyerPhone) } : null
        });
        if (!result?.success) return transferRedirect(reply, vehicleId, { error: result?.error || 'the engine refused the buyer details' });
        return transferRedirect(reply, vehicleId, { ok: '1', step: '2' });
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/transfer/:vehicleId/step2');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* F3 — release PIN relayed by the owner (engine step 3). */
    scope.post('/d/admin/transfer/:vehicleId/step3', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing changed.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const vehicleId = String(request.params?.vehicleId || '');
        const body = formBody(request);
        const transferId = String(body.transfer_id || '');
        const releasePin = String(body.release_pin || '').trim();
        const view = await buildAdminTransferView({ supabase, vehicleId });
        if (!view.ok) return adminErrorPage(reply, 404, 'That vehicle does not exist.');
        if (!view.openTransfer || String(view.openTransfer.id) !== transferId || view.openTransfer.status !== 'PENDING_OWNER_RELEASE_OTP') {
          return transferRedirect(reply, vehicleId, { error: 'that handover is not waiting for the release PIN' });
        }
        if (!/^\d{6}$/.test(releasePin)) return transferRedirect(reply, vehicleId, { error: 'the release PIN must be 6 digits' });
        const result = await adminTransferEngine.verifyRelease({
          transferId,
          providedOtp: releasePin,
          supabase,
          sendWhatsAppFn: sendWhatsAppText
        });
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_TRANSFER_RELEASE', {
          vehicleId,
          ok: result?.success === true,
          error: result?.success ? null : (result?.error || 'refused'),
          before: { status: 'PENDING_OWNER_RELEASE_OTP' },
          after: result?.success ? { status: 'PENDING_BUYER_ACCEPTANCE' } : { status: 'PENDING_OWNER_RELEASE_OTP' }
        });
        if (!result?.success) return transferRedirect(reply, vehicleId, { error: result?.error || 'the release was refused' });
        return transferRedirect(reply, vehicleId, { ok: '1', step: '3' });
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/transfer/:vehicleId/step3');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* F4 — cancel an open handover (honest: a refused write never reports success). */
    scope.post('/d/admin/transfer/:vehicleId/cancel', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing changed.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const vehicleId = String(request.params?.vehicleId || '');
        const body = formBody(request);
        const transferId = String(body.transfer_id || '');
        const view = await buildAdminTransferView({ supabase, vehicleId });
        if (!view.ok) return adminErrorPage(reply, 404, 'That vehicle does not exist.');
        const row = (view.transfers || []).find((transfer) => String(transfer.id) === transferId);
        if (!row) return transferRedirect(reply, vehicleId, { error: 'that handover does not exist for this vehicle' });
        if (!TRANSFER_OPEN_STATUSES.includes(row.status)) return transferRedirect(reply, vehicleId, { error: 'that handover is not open' });
        const { error: cancelError } = await supabase.from('passbook_transfers').update({ status: 'CANCELLED' }).eq('id', transferId);
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_TRANSFER_CANCEL', {
          vehicleId,
          ok: !cancelError,
          error: cancelError ? cancelError.message : null,
          before: { status: row.status },
          after: cancelError ? { status: row.status } : { status: 'CANCELLED' }
        });
        if (cancelError) return adminErrorPage(reply, 500, 'That handover could not be cancelled just now — please try again.');
        return transferRedirect(reply, vehicleId, { ok: '1', step: 'cancel' });
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/transfer/:vehicleId/cancel');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* G — email as Saka: draft → escaped preview → typed SEND + reason. */
    scope.get('/d/admin/email/:profileId', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const target = await loadDashboardProfile(supabase, String(request.params?.profileId || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        const formAction = `/d/admin/email/${encodeURIComponent(target.id)}`;
        if (!target.email) {
          return sendHtml(reply, 400, renderAdminEmailDraftPage({ profile: target, formAction, error: 'This account has no email on file — nothing can be sent.' }));
        }
        return sendHtml(reply, 200, renderAdminEmailDraftPage({ profile: target, formAction }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/email/:profileId');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    scope.post('/d/admin/email/:profileId', { config: ADMIN_WRITE_RATE }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) return adminErrorPage(reply, 403, 'That request came from another site — nothing was sent.');
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const target = await loadDashboardProfile(supabase, String(request.params?.profileId || ''));
        if (!target) return adminErrorPage(reply, 404, 'That account does not exist.');
        if (!target.email) return adminErrorPage(reply, 400, 'This account has no email on file — nothing can be sent.');
        const body = formBody(request);
        const action = String(body.action || 'preview');
        const subject = String(body.subject || '').trim().slice(0, 200);
        const message = String(body.body || '').trim().slice(0, 5000);
        const formAction = `/d/admin/email/${encodeURIComponent(target.id)}`;
        if (action === 'preview') {
          if (!subject || !message) {
            return sendHtml(reply, 200, renderAdminEmailDraftPage({ profile: target, subject, body: message, formAction, error: 'Add a subject and a message before previewing.' }));
          }
          return sendHtml(reply, 200, renderAdminEmailPreviewPage({ profile: target, subject, body: message, formAction }));
        }
        if (action !== 'send') return adminErrorPage(reply, 400, 'Nothing was sent — open the draft again.');
        const reason = adminReason(body);
        if (!typedExactly(body, ADMIN_ACTION_WORDS.email)) {
          return sendHtml(reply, 200, renderAdminEmailPreviewPage({ profile: target, subject, body: message, formAction, error: 'Type SEND exactly to send this email.' }));
        }
        if (!adminReasonOk(reason)) {
          return sendHtml(reply, 200, renderAdminEmailPreviewPage({ profile: target, subject, body: message, formAction, error: 'Add a short reason (at least 3 characters) — it is stored in the audit log.' }));
        }
        if (!subject || !message) {
          return sendHtml(reply, 200, renderAdminEmailDraftPage({ profile: target, subject, body: message, formAction, error: 'Add a subject and a message before sending.' }));
        }
        let sent = false;
        let sendError = null;
        try {
          const result = await adminEmailSender({
            from: 'Saka Fleet <reports@reports.sakafleet.com>',
            to: [target.email],
            subject,
            text: message,
            html: emailHtmlFromText(message)
          });
          sent = !result?.error;
          sendError = result?.error?.message || null;
        } catch (sendErr) {
          sent = false;
          sendError = sendErr?.message || 'send_failed';
        }
        await logAdminAudit(supabase, adminActor(profile, session), 'ADMIN_ACTION_EMAIL_SENT', {
          ok: sent,
          error: sent ? null : sendError,
          reason,
          targetId: target.id,
          to: maskEmail(target.email),
          subject,
          chars: message.length
        });
        if (!sent) return adminErrorPage(reply, 502, 'The email was refused by the sender — nothing was delivered. Please try again later.');
        return reply.code(303).header('location', '/d/admin?done=email').send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin/email/:profileId');
        return adminErrorPage(reply, 500, 'Please try again in a moment.');
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/analytics — tyre wear + cost-per-km trend (Phase 19)     */
    /* -------------------------------------------------------------- */
    scope.get('/d/analytics', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildAnalyticsPage({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, data.ok ? 200 : 503, renderAnalyticsPage({ data }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/analytics');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/care — Amina's escalated queue (Phase 19, admin, audited) */
    /* -------------------------------------------------------------- */
    scope.get('/d/care', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'admin');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildCareQueue({ supabase });
        // Rule 51(iii) — EVERY admin view is audited (fail-soft inside).
        await logAdminAudit(supabase, profile?.phone_number || session.email || 'DASHBOARD_ADMIN', 'ADMIN_DASHBOARD_VIEW', {
          page: 'care',
          escalated: data.ok ? data.counts?.escalated ?? null : null
        });
        return sendHtml(reply, data.ok ? 200 : 503, renderCareQueuePage({ data }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/care');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* Phase 22 (v1.83.0) — passbook transfer (owner, steps 1-3)       */
    /* The buyer's ACCEPT + email code stay on WhatsApp (steps 4-5).   */
    /* -------------------------------------------------------------- */
    const renderTransferReply = async (reply, { session, profile, status = 200, error = null, notice = null, pinTransfer = null }) => {
      const data = await buildTransferPage({
        supabase,
        ownerId: session.ownerId,
        profile,
        countryInfo: countryForProfile(profile)
      });
      if (!data.ok) {
        const page = renderErrorPage(503, 'Your transfer page could not be loaded just now. Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
      return sendHtml(reply, status, renderTransferPage({
        data,
        emailMasked: accountLabel(profile, session),
        error,
        notice,
        pinTransfer
      }));
    };

    scope.get('/d/transfer', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildTransferPage({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        if (!data.ok) {
          const page = renderErrorPage(503, 'Your transfer page could not be loaded just now. Please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        const query = request.query || {};
        const notice = String(query.verified || '') === '1'
          ? 'Release authorised — the buyer was messaged on WhatsApp. The handover completes when they reply ACCEPT and enter the 6-digit code I email them.'
          : String(query.cancelled || '') === '1'
            ? 'Transfer cancelled — nothing moved.'
            : String(query.started || '') === '1'
              ? 'Release PIN sent — check your email and enter it below to authorise the handover.'
              : null;
        const pinId = String(query.pin || '');
        const pinRow = pinId
          ? (data.transfers || []).find((row) => row.id === pinId && row.status === 'PENDING_OWNER_RELEASE_OTP')
          : null;
        return sendHtml(reply, 200, renderTransferPage({
          data,
          emailMasked: accountLabel(profile, session),
          notice,
          pinTransfer: pinRow ? { id: pinRow.id, plate: pinRow.plate } : null
        }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/transfer');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    scope.post('/d/transfer/start', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(400, 'Please open the transfer page again.');
        return sendHtml(reply, page.status, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const body = formBody(request);
        if (!profile?.phone_number) {
          return renderTransferReply(reply, { session, profile, status: 400, error: 'Your account needs its WhatsApp number before a handover can start — reply *dashboard* in chat and sign in again.' });
        }
        const vehicles = await loadOwnerVehicles(supabase, session.ownerId);
        const vehicle = vehicles.find((row) => row.id === String(body.vehicle_id || ''));
        if (!vehicle) {
          return renderTransferReply(reply, { session, profile, status: 400, error: 'Pick one of your live vehicles to hand over.' });
        }
        const buyerPhone = String(body.buyer_phone || '').trim();
        const buyerEmail = String(body.buyer_email || '').trim();
        if (!/^\+?[0-9\s().-]{9,20}$/.test(buyerPhone)) {
          return renderTransferReply(reply, { session, profile, status: 400, error: "That buyer number looks incomplete — include the country code (e.g. +254 712 345 678)." });
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(buyerEmail)) {
          return renderTransferReply(reply, { session, profile, status: 400, error: 'That buyer email does not look complete — check it and try again.' });
        }
        // The release PIN is EMAILED by the machine — never start a handover
        // that cannot deliver it (rule 50 honesty).
        const gate = await buildTransferPage({ supabase, ownerId: session.ownerId, profile, countryInfo: countryForProfile(profile) });
        if (!gate.ok) {
          const page = renderErrorPage(503, 'Please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        if (!gate.ownerEmailAvailable) {
          return renderTransferReply(reply, {
            session, profile, status: 400,
            error: 'Add an email first — the release PIN is emailed to you. Reply *change my email* on WhatsApp, then come back.'
          });
        }
        const initiated = await initiatePassbookTransfer({
          fromPhone: profile.phone_number,
          vehicleCandidate: vehicle.plate_number,
          supabase
        });
        if (!initiated.success) {
          return renderTransferReply(reply, {
            session, profile, status: initiated.isExistingPending ? 409 : 400,
            error: initiated.error || 'That handover could not start just now.'
          });
        }
        const details = await transferNotifier.sendReleaseOtp({
          transferId: initiated.transferId,
          buyerPhone,
          buyerEmail,
          supabase
        });
        if (!details.success) {
          return renderTransferReply(reply, {
            session, profile, status: 400,
            pinTransfer: { id: initiated.transferId, plate: vehicle.plate_number },
            error: details.error || 'The release PIN could not be sent just now.'
          });
        }
        // Optional handover reading: a real ledger entry for road assets, the
        // engine-hours meter for hours-led assets (v1.85.0, never a mileage).
        const reading = Number(String(body.odometer || '').replace(/[^0-9.]/g, ''));
        if (Number.isFinite(reading) && reading > 0 && reading <= 10000000) {
          const hoursLed = isHoursLedKind(vehicle.asset_kind || vehicle.asset_type || 'vehicle');
          if (hoursLed) {
            await applyOperatingHours({ supabase, vehicle, hours: reading }).catch(() => null);
          } else {
            await recordLabeledReading(supabase, {
              vehicleId: vehicle.id,
              profileId: session.ownerId,
              reading,
              label: 'handover'
            }).catch(() => null);
          }
        }
        return reply.code(303).header('location', `/d/transfer?started=1&pin=${encodeURIComponent(initiated.transferId)}`).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/transfer/start');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    scope.post('/d/transfer/verify', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(400, 'Please open the transfer page again.');
        return sendHtml(reply, page.status, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const body = formBody(request);
        const transferId = String(body.transfer_id || '');
        const otp = String(body.otp || '').trim();
        if (!transferId) {
          return renderTransferReply(reply, { session, profile, status: 400, error: 'Open the transfer page and start a handover first.' });
        }
        // Ownership first: a transfer that is not this owner's answers 404 —
        // its existence is never confirmed (same pattern as the vehicle page).
        let transferRow = null;
        try {
          const { data } = await supabase
            .from('passbook_transfers')
            .select('id, from_owner_id, status, vehicle_id')
            .eq('id', transferId)
            .maybeSingle();
          transferRow = data || null;
        } catch { transferRow = null; }
        if (!transferRow || transferRow.from_owner_id !== session.ownerId) {
          const page = renderErrorPage(404, 'That handover does not exist.');
          return sendHtml(reply, page.status, page.html);
        }
        const plate = (await loadOwnerVehicles(supabase, session.ownerId))
          .find((row) => row.id === transferRow.vehicle_id)?.plate_number || 'your vehicle';
        if (!/^\d{6}$/.test(otp)) {
          return renderTransferReply(reply, {
            session, profile, status: 400,
            pinTransfer: { id: transferId, plate },
            error: 'Enter the 6-digit release PIN from your email.'
          });
        }
        const result = await transferNotifier.verifyReleaseOtp({
          transferId,
          providedOtp: otp,
          supabase,
          sendWhatsAppFn: sendWhatsAppText
        });
        if (!result.success) {
          return renderTransferReply(reply, {
            session, profile, status: 400,
            pinTransfer: { id: transferId, plate },
            error: result.error || 'That release PIN did not match. Check your latest email and try again.'
          });
        }
        return reply.code(303).header('location', '/d/transfer?verified=1').send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/transfer/verify');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    scope.post('/d/transfer/cancel', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(400, 'Please open the transfer page again.');
        return sendHtml(reply, page.status, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const body = formBody(request);
        const transferId = String(body.transfer_id || '');
        let transferRow = null;
        try {
          const { data } = await supabase
            .from('passbook_transfers')
            .select('id, from_owner_id, status')
            .eq('id', transferId)
            .maybeSingle();
          transferRow = data || null;
        } catch { transferRow = null; }
        if (!transferRow || transferRow.from_owner_id !== session.ownerId) {
          const page = renderErrorPage(404, 'That handover does not exist.');
          return sendHtml(reply, page.status, page.html);
        }
        if (TRANSFER_OPEN_STATUSES.includes(transferRow.status)) {
          // v1.87.5 — the write names ONLY columns that exist. The old payload set
          // `updated_at`, which passbook_transfers never had, so PostgREST refused
          // the update while the route still redirected with ?cancelled=1 — a fake
          // success: the handover stayed in-flight and blocked every new transfer.
          const { error: cancelError } = await supabase
            .from('passbook_transfers')
            .update({ status: 'CANCELLED' })
            .eq('id', transferId);
          if (cancelError) {
            await logSystemError(supabase, new Error(`transfer cancel refused: ${cancelError.message}`), '/d/transfer/cancel');
            return renderTransferReply(reply, {
              session,
              profile: await loadDashboardProfile(supabase, session.ownerId),
              status: 500,
              error: 'That handover could not be cancelled just now — please try again.'
            });
          }
        }
        return reply.code(303).header('location', '/d/transfer?cancelled=1').send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/transfer/cancel');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* Phase 22 (v1.83.0) — subscription page + engine checkouts        */
    /* -------------------------------------------------------------- */
    const renderSubscriptionReply = async (reply, { session, profile, status = 200, error = null, notice = null }) => {
      const data = await buildSubscriptionPage({
        supabase,
        ownerId: session.ownerId,
        profile,
        countryInfo: countryForProfile(profile)
      });
      if (!data.ok) {
        const page = renderErrorPage(503, 'Your subscription could not be loaded just now. Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
      return sendHtml(reply, status, renderSubscriptionPage({
        data,
        emailMasked: accountLabel(profile, session),
        error,
        notice
      }));
    };

    scope.get('/d/subscription', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildSubscriptionPage({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        if (!data.ok) {
          const page = renderErrorPage(503, 'Your subscription could not be loaded just now. Please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        // Paystack appends reference + trxref to the callback URL. We NEVER
        // claim the payment landed — the webhook owns that truth (rule 28).
        const query = request.query || {};
        const reference = String(query.reference || query.trxref || query.ref || '').trim().slice(0, 64);
        const notice = reference
          ? `We're back from checkout (reference ${reference}). Paystack confirms payments in the background — this page reflects your plan the moment it updates.`
          : null;
        return sendHtml(reply, 200, renderSubscriptionPage({
          data,
          emailMasked: accountLabel(profile, session),
          notice
        }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/subscription');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    scope.post('/d/subscription/checkout', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(400, 'Please open the subscription page again.');
        return sendHtml(reply, page.status, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const body = formBody(request);
        const tier = String(body.tier || '').trim().toLowerCase().slice(0, 40);
        const interval = String(body.interval || 'monthly').toLowerCase() === 'annual' ? 'annual' : 'monthly';
        if (!tier) {
          return renderSubscriptionReply(reply, { session, profile, status: 400, error: 'Pick a plan to upgrade to.' });
        }
        const countryInfo = countryForProfile(profile);
        const currency = buildGlobalContext(countryInfo, profile).currency;
        const result = await checkoutEngine.tier({
          supabase,
          owner: {
            id: session.ownerId,
            phone_number: profile?.phone_number || null,
            email: profile?.email || null
          },
          targetTierKey: tier,
          interval,
          currency,
          callbackUrl: `${dashboardBaseUrl()}/subscription`
        });
        if (!result?.ok || !result.checkoutUrl) {
          return renderSubscriptionReply(reply, {
            session, profile, status: 400,
            error: result?.error || 'That plan could not be opened just now — reply *subscription* in WhatsApp and I will send a link.'
          });
        }
        // The engine returns a Paystack URL; anything else is refused outright
        // (never an open redirect).
        if (!/^https:\/\//i.test(String(result.checkoutUrl))) {
          return renderSubscriptionReply(reply, { session, profile, status: 502, error: 'The payment page could not be opened — please try again in a moment.' });
        }
        return reply.code(303).header('location', result.checkoutUrl).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/subscription/checkout');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    scope.post('/d/subscription/addon', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(400, 'Please open the subscription page again.');
        return sendHtml(reply, page.status, page.html);
      }
      try {
        const session = await requireRoleSession(request, reply, supabase, 'owner');
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const body = formBody(request);
        const quantity = Math.min(10, Math.max(1, Math.floor(Number(body.quantity) || 1)));
        const ent = await getEntitlements({ supabase, ownerId: session.ownerId, profile });
        if (!ent.addonEligible) {
          return renderSubscriptionReply(reply, {
            session, profile, status: 400,
            error: 'Extra vehicle slots are a Fleet Command add-on — upgrade to Fleet Command first.'
          });
        }
        const countryInfo = countryForProfile(profile);
        const currency = buildGlobalContext(countryInfo, profile).currency;
        const result = await checkoutEngine.addon({
          supabase,
          owner: {
            id: session.ownerId,
            phone_number: profile?.phone_number || null,
            email: profile?.email || null
          },
          addonQuantity: quantity,
          interval: ent.billingInterval || 'monthly',
          currency,
          callbackUrl: `${dashboardBaseUrl()}/subscription`
        });
        if (!result?.ok || !result.checkoutUrl) {
          return renderSubscriptionReply(reply, {
            session, profile, status: 400,
            error: result?.error || 'Those slots could not be opened just now — reply *add-on* in WhatsApp and I will send a link.'
          });
        }
        if (!/^https:\/\//i.test(String(result.checkoutUrl))) {
          return renderSubscriptionReply(reply, { session, profile, status: 502, error: 'The payment page could not be opened — please try again in a moment.' });
        }
        return reply.code(303).header('location', result.checkoutUrl).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/subscription/addon');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/logout — clear the session, then land on the sign-in door */
    /* v1.86.0 (Phase 25): 303 -> /d/login?logged_out=1 (banner), or    */
    /* the admin door when an admin session was cleared.                */
    /* -------------------------------------------------------------- */
    scope.get('/d/logout', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      const secure = isSecureRequest(request);
      let wasAdmin = false;
      try {
        const sessionToken = readDashboardCookie(request.headers);
        if (sessionToken) {
          const session = await getSessionByToken({ supabase, sessionToken });
          wasAdmin = session.ok && session.role === 'admin';
          await clearDashboardSession({ supabase, sessionToken });
        }
      } catch (err) {
        await logSystemError(supabase, err, '/d/logout');
      }
      reply.header('set-cookie', dashboardClearCookieHeader({ secure }));
      const target = wasAdmin ? `${DASHBOARD_ADMIN_LOGIN_PATH}?logged_out=1` : `${DASHBOARD_LOGIN_PATH}?logged_out=1`;
      return reply.code(303).header('location', target).send();
    });

    /* -------------------------------------------------------------- */
    /* POST /d/verify — OTP -> session cookie -> 303 /d                */
    /* -------------------------------------------------------------- */
    scope.post('/d/verify', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      // v1.90.0 (Phase 28B) — the ONE /d POST that lacked the Origin guard
      // (CHECK 4: every other write already carries it). Refuse BEFORE any OTP
      // work, so a cross-site attempt can never burn an attempt or mint a session.
      if (isCrossOriginWrite(request)) {
        const page = renderErrorPage(400, 'Please open the sign-in page again.');
        return sendHtml(reply, page.status, page.html);
      }
      const token = String(request.body?.token || '');
      const otp = String(request.body?.otp || '').trim();
      try {
        const result = await verifyDashboardOtp({ supabase, rawToken: token, otp });
        if (!result.ok) {
          const state = await getLinkState({ supabase, rawToken: token });
          if (!state.ok) {
            const page = renderErrorPage(linkReasonStatus(state.reason), linkReasonCopy(state.reason));
            return sendHtml(reply, page.status, page.html);
          }
          const page = renderOtpPage({
            token,
            destinationMasked: state.phoneMasked || maskEmail(state.email),
            error: dashboardOtpReasonCopy(result.reason)
          });
          return sendHtml(reply, 401, page);
        }
        reply.header('set-cookie', dashboardCookieHeader(result.sessionToken, { secure: isSecureRequest(request) }));
        // v1.82.0 — land each role on ITS home (an admin session on /d was 403).
        const home = result.role === 'admin' ? '/d/admin' : result.role === 'driver' ? '/d/driver' : '/d';
        return reply.code(303).header('location', home).send();
      } catch (err) {
        await logSystemError(supabase, err, '/d/verify');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/:token — the magic-link landing page                     */
    /* -------------------------------------------------------------- */
    scope.get('/d/:token', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      const token = String(request.params?.token || '');
      try {
        const state = await getLinkState({ supabase, rawToken: token });
        if (!state.ok) {
          const page = renderErrorPage(linkReasonStatus(state.reason), linkReasonCopy(state.reason));
          return sendHtml(reply, page.status, page.html);
        }
        return sendHtml(reply, 200, renderOtpPage({ token, destinationMasked: state.phoneMasked || maskEmail(state.email) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/:token');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });
  });
}

export default { registerDashboardRoutes };
