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
  renderRecordsPage,
  renderReceiptPage,
  renderLogoutPage,
  renderErrorPage,
  buildOverviewCard,
  buildVehiclesIndex,
  buildVehiclePage,
  parseRecordsFilters,
  queryOwnerRecords,
  loadOwnerVehicles,
  attachReceiptMatches,
  signReceiptUrl,
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
  renderAdminFleetPage
} from '../services/dashboard.js';
import { logAdminAudit } from '../services/superadmin.js';
import { detectCountryFromPhone, buildGlobalContext } from '../services/globalization.js';
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
  const phone = profile?.phone_number;
  return phone ? detectCountryFromPhone(phone) : null;
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
  const actualRole = DASHBOARD_ROLES.includes(session.role) ? session.role : 'owner';
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


export async function registerDashboardRoutes(fastify, { supabase } = {}) {
  await fastify.register(async (scope) => {
    await scope.register(formbody);

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
        const session = await requireRoleSession(request, reply, supabase, 'owner');
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
        const session = await requireRoleSession(request, reply, supabase, 'owner');
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
          ? await queryOwnerRecords({ supabase, ownerId: session.ownerId, vehicleIds, vehicles, filters, countryInfo, profile })
          : { ok: true, rows: [], total: 0, hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE };
        const rows = parsed.ok ? await attachReceiptMatches({ supabase, rows: result.rows }) : [];
        const data = { ...result, rows, currency: ctx.currency, locale: ctx.locale, timeZone: ctx.timeZone };
        return sendHtml(reply, data.ok ? 200 : 503, renderRecordsPage({
          data,
          filters,
          vehicles,
          emailMasked: maskEmail(session.email || profile?.email),
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
            emailMasked: maskEmail(session.email || profile?.email),
            error: parsed.error
          });
          return sendHtml(reply, 400, page);
        }
        const result = await queryOwnerRecords({
          supabase,
          ownerId: session.ownerId,
          vehicleIds,
          vehicles,
          filters: parsed.filters,
          countryInfo,
          profile,
          pageSize: RECORDS_EXPORT_MAX_ROWS,
          offset: 0
        });
        if (!result.ok) {
          // A failed query must never look like an empty export (rule 50 honesty).
          await logSystemError(supabase, new Error('records query failed'), '/d/records/csv');
          const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        const csv = serializeRecordsCsv(result.rows, { currency: ctx.currency });
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
        if (!parsed.ok) {
          const filters = parseRecordsFilters({}, { vehicleIds }).filters;
          const page = renderRecordsPage({
            data: { ok: true, rows: [], total: 0, hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE },
            filters,
            vehicles,
            emailMasked: maskEmail(session.email || profile?.email),
            error: parsed.error
          });
          return sendHtml(reply, 400, page);
        }
        const result = await queryOwnerRecords({
          supabase,
          ownerId: session.ownerId,
          vehicleIds,
          vehicles,
          filters: parsed.filters,
          countryInfo,
          profile,
          pageSize: RECORDS_EXPORT_MAX_ROWS,
          offset: 0
        });
        if (!result.ok) {
          await logSystemError(supabase, new Error('records query failed'), '/d/records/pdf');
          const page = renderErrorPage(500, 'That export could not be built — please try again in a moment.');
          return sendHtml(reply, page.status, page.html);
        }
        const buffer = await buildRecordsPdf(result.rows, parsed.filters, {
          profile,
          countryInfo,
          vehicles,
          truncated: result.truncated
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
          emailMasked: maskEmail(session.email || profile?.email),
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
        return sendHtml(reply, page.ok ? 200 : 503, renderDriverPage({ page, emailMasked: maskEmail(session.email || profile?.email) }));
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
            emailMasked: maskEmail(session.email || profile?.email),
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
        const buffer = await buildProReportPdf(report.data);
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
        if (String(body.action || '') !== 'save_weekly') {
          const settings = await buildSettingsPage({ supabase, ownerId: session.ownerId, profile, countryInfo: countryForProfile(profile), sessionExpiresAt: session.sessionExpiresAt });
          return sendHtml(reply, 400, renderSettingsPage({ settings, error: 'Nothing to save — nothing changed.' }));
        }
        const weeklyReportOn = String(body.weekly_report || '').toLowerCase() === 'on';
        const result = await saveSettings({ supabase, ownerId: session.ownerId, weeklyReportOn });
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
          emailMasked: maskEmail(session.email || profile?.email)
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
        const data = await buildAdminOwnersList({ supabase, search });
        // Rule 51(iii) — EVERY admin view is audited (fail-soft inside).
        await logAdminAudit(supabase, profile?.phone_number || session.email || 'DASHBOARD_ADMIN', 'ADMIN_DASHBOARD_VIEW', {
          page: 'owners',
          params: { q: search || null }
        });
        return sendHtml(reply, data.ok ? 200 : 503, renderAdminOwnersPage({ data, search }));
      } catch (err) {
        await logSystemError(supabase, err, '/d/admin');
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
