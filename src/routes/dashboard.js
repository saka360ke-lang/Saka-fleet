/**
 * Saka Fleet — Dashboard routes (v1.74.0, Phase 13)
 * -------------------------------------------------
 * GET  /d/:token   -> OTP entry page (magic-link landing)
 * POST /d/verify   -> OTP check -> HttpOnly session cookie -> 303 /d
 * GET  /d          -> overview (session cookie required)
 * GET  /d/logout   -> clears the session + cookie
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
  renderPageShell,
  renderMessagePage,
  escapeHtml,
  DASHBOARD_OTP_TTL_MS
} from '../services/dashboard.js';
import { logSystemError } from '../services/systemErrors.js';

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

/** 13A placeholder — Phase 13C replaces this with the overview card. */
export function renderSignedInPage({ emailMasked }) {
  const body = `
<h1>You're in</h1>
<p class="muted">Signed in as ${escapeHtml(emailMasked)}.</p>
<div class="card"><p class="muted">Your overview is almost ready.</p></div>`;
  return renderPageShell('Dashboard', body, {
    headerRight: '<a href="/d/logout">Log out</a>'
  });
}

export function renderLogoutPage() {
  const body = `
<h1>You're logged out</h1>
<p class="muted">This browser no longer has access. Reply <strong>dashboard</strong> on WhatsApp any time for a fresh link.</p>`;
  return renderPageShell('Logged out', body);
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
        const sessionToken = readDashboardCookie(request.headers);
        if (!sessionToken) {
          const page = renderMessagePage(
            'Open your dashboard from WhatsApp',
            'Reply *dashboard* in the WhatsApp chat and I will email you a fresh link.',
            { status: 401 }
          );
          return sendHtml(reply, page.status, page.html);
        }
        const session = await getSessionByToken({ supabase, sessionToken });
        if (!session.ok) {
          reply.header('set-cookie', dashboardClearCookieHeader({ secure: isSecureRequest(request) }));
          const page = renderMessagePage(
            'Open your dashboard from WhatsApp',
            'Your session has ended. Reply *dashboard* in the WhatsApp chat and I will email you a fresh link.',
            { status: 401 }
          );
          return sendHtml(reply, page.status, page.html);
        }
        return sendHtml(reply, 200, renderSignedInPage({ emailMasked: maskEmail(session.email) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d');
        const page = renderMessagePage('Something went wrong', 'Please try again in a moment.', { status: 500 });
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
            const page = renderMessagePage('Link not available', linkReasonCopy(state.reason), { status: linkReasonStatus(state.reason) });
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
        const page = renderMessagePage('Something went wrong', 'Please try again in a moment.', { status: 500 });
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
          const page = renderMessagePage('Link not available', linkReasonCopy(state.reason), { status: linkReasonStatus(state.reason) });
          return sendHtml(reply, page.status, page.html);
        }
        return sendHtml(reply, 200, renderOtpPage({ token, emailMasked: maskEmail(state.email) }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/:token');
        const page = renderMessagePage('Something went wrong', 'Please try again in a moment.', { status: 500 });
        return sendHtml(reply, page.status, page.html);
      }
    });
  });
}

export default { registerDashboardRoutes };
