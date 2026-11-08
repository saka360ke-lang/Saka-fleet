/**
 * Saka Fleet — Dashboard routes (v1.74.0, Phase 13; + Phase 14A in v1.75.0)
 * -----------------------------------------------------------------------
 * GET  /d/:token        -> OTP entry page (magic-link landing)
 * POST /d/verify        -> OTP check -> HttpOnly session cookie -> 303 /d
 * GET  /d               -> overview (session cookie required)
 * GET  /d/vehicles      -> fleet list (v1.75.0, session required)
 * GET  /d/vehicles/:id  -> one vehicle (v1.75.0, session required, owner-scoped)
 * GET  /d/logout        -> clears the session + cookie
 *
 * A1: while DASHBOARD_ENABLED is off every route answers exactly like an
 * unregistered Fastify route (generic 404 JSON) — the dashboard's existence is
 * never revealed. The form parser is registered inside this module's own
 * encapsulated scope, so the rest of the app keeps its JSON/text parsers.
 */

import formbody from '@fastify/formbody';
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
  renderOtpPage,
  renderOverviewPage,
  renderVehiclesPage,
  renderVehiclePage,
  renderLogoutPage,
  renderErrorPage,
  buildOverviewCard,
  buildVehiclesIndex,
  buildVehiclePage
} from '../services/dashboard.js';
import { detectCountryFromPhone } from '../services/globalization.js';
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

function sendHtml(reply, status, html) {
  return reply.code(status).type('text/html; charset=utf-8').send(html);
}

function linkReasonCopy(reason) {
  if (reason === 'link_expired') return 'This link has expired. Reply *dashboard* on WhatsApp and I will email a fresh one.';
  if (reason === 'otp_expired') return 'The code for this link has expired. Reply *dashboard* on WhatsApp and I will email a fresh link and code.';
  if (reason === 'already_used') return 'This link has already been used. Reply *dashboard* on WhatsApp for a fresh one.';
  if (reason === 'db_error') return 'Something went wrong on our side. Please try again in a moment.';
  return 'This link is not valid. Reply *dashboard* on WhatsApp and I will email a fresh one.';
}

function linkReasonStatus(reason) {
  if (reason === 'db_error') return 503;
  if (reason === 'invalid_link') return 400;
  return 410;
}

/** Rule 50 — optional profile context degrades to the slim set. */
async function loadDashboardProfile(supabase, ownerId) {
  if (!supabase || !ownerId) return null;
  const full = 'id, phone_number, email, full_name, country, country_code, preferred_language, currency, locale';
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
  const phone = profile?.phone_number;
  return phone ? detectCountryFromPhone(phone) : null;
}

/**
 * The one session gate every signed-in page shares. Sends the 401 page (and
 * clears a dead cookie) itself and returns null, so a caller can simply
 * `if (!session) return reply;`.
 */
async function requireOwnerSession(request, reply, supabase) {
  const sessionToken = readDashboardCookie(request.headers);
  if (!sessionToken) {
    const page = renderErrorPage(401, 'Reply *dashboard* in the WhatsApp chat and I will email you a fresh link.');
    sendHtml(reply, page.status, page.html);
    return null;
  }
  const session = await getSessionByToken({ supabase, sessionToken });
  if (!session.ok) {
    reply.header('set-cookie', dashboardClearCookieHeader({ secure: isSecureRequest(request) }));
    const page = renderErrorPage(401, 'Your session has ended. Reply *dashboard* in the WhatsApp chat and I will email you a fresh link.');
    sendHtml(reply, page.status, page.html);
    return null;
  }
  return session;
}


export async function registerDashboardRoutes(fastify, { supabase } = {}) {
  await fastify.register(async (scope) => {
    await scope.register(formbody);

    /* -------------------------------------------------------------- */
    /* GET /d — the signed-in overview (session cookie required)       */
    /* -------------------------------------------------------------- */
    scope.get('/d', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      try {
        const session = await requireOwnerSession(request, reply, supabase);
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const card = await buildOverviewCard({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, 200, renderOverviewPage({ data: card, emailMasked: maskEmail(session.email || profile?.email) }));
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
        const session = await requireOwnerSession(request, reply, supabase);
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildVehiclesIndex({
          supabase,
          ownerId: session.ownerId,
          profile,
          countryInfo: countryForProfile(profile)
        });
        return sendHtml(reply, 200, renderVehiclesPage({ data, emailMasked: maskEmail(session.email || profile?.email) }));
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
        const session = await requireOwnerSession(request, reply, supabase);
        if (!session) return reply;
        const profile = await loadDashboardProfile(supabase, session.ownerId);
        const data = await buildVehiclePage({
          supabase,
          ownerId: session.ownerId,
          vehicleId: String(request.params?.id || ''),
          profile,
          countryInfo: countryForProfile(profile)
        });
        if (!data.ok && data.reason === 'not_found') {
          const page = renderErrorPage(404, 'That vehicle is not on your fleet. Reply *dashboard* on WhatsApp if you think it should be.');
          return sendHtml(reply, page.status, page.html);
        }
        return sendHtml(reply, 200, renderVehiclePage({ data, emailMasked: maskEmail(session.email || profile?.email) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/vehicles/:id');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });

    /* -------------------------------------------------------------- */
    /* GET /d/logout — clear the session then the cookie               */
    /* -------------------------------------------------------------- */
    scope.get('/d/logout', async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
      const secure = isSecureRequest(request);
      try {
        const sessionToken = readDashboardCookie(request.headers);
        if (sessionToken) await clearDashboardSession({ supabase, sessionToken });
      } catch (err) {
        await logSystemError(supabase, err, '/d/logout');
      }
      reply.header('set-cookie', dashboardClearCookieHeader({ secure }));
      return sendHtml(reply, 200, renderLogoutPage());
    });

    /* -------------------------------------------------------------- */
    /* POST /d/verify — OTP -> session cookie -> 303 /d                */
    /* -------------------------------------------------------------- */
    scope.post('/d/verify', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
      if (!isDashboardEnabled()) return answerAsNotFound(request, reply);
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
            emailMasked: maskEmail(state.email),
            error: dashboardOtpReasonCopy(result.reason)
          });
          return sendHtml(reply, 401, page);
        }
        reply.header('set-cookie', dashboardCookieHeader(result.sessionToken, { secure: isSecureRequest(request) }));
        return reply.code(303).header('location', '/d').send();
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
        return sendHtml(reply, 200, renderOtpPage({ token, emailMasked: maskEmail(state.email) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/:token');
        const page = renderErrorPage(500, 'Please try again in a moment.');
        return sendHtml(reply, page.status, page.html);
      }
    });
  });
}

export default { registerDashboardRoutes };
