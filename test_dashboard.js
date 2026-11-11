/**
 * Saka Fleet — Dashboard suite (v1.74.0, Phase 13)
 * ------------------------------------------------
 * 13A (foundation): feature-flag 404s, eligibility gates, link/OTP TTLs,
 * attempts cap, single-use links, 30-day sessions, cookie contract, sha256-only
 * storage, constant-time compare, email-failure cleanup, prune safety.
 *
 * Runs entirely on the in-memory Supabase mock — no real rows are created.
 */

import assert from 'assert';
import Fastify from 'fastify';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  DASHBOARD_SESSIONS_TABLE,
  DASHBOARD_LINK_TTL_MS,
  DASHBOARD_OTP_TTL_MS,
  DASHBOARD_SESSION_TTL_MS,
  DASHBOARD_MAX_ATTEMPTS,
  DASHBOARD_COOKIE_NAME,
  DASHBOARD_SQL,
  isDashboardEnabled,
  hashToken,
  safeCompareHex,
  mintOtp,
  mintToken,
  maskEmail,
  maskPhone,
  requestDashboardOtp,
  getLinkState,
  verifyDashboardOtp,
  getSessionByToken,
  clearDashboardSession,
  pruneExpiredDashboardSessions,
  dashboardCookieHeader,
  dashboardClearCookieHeader,
  readDashboardCookie,
  isSecureRequest,
  buildOverviewCard,
  buildVehiclesIndex,
  buildVehiclePage,
  renderRecordsPage,
  renderImportPage,
  renderAdminCommandPage,
  renderReceiptPage,
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
  RECORDS_PAGE_SIZE,
  RECORDS_MAX_RANGE_DAYS,
  RECORDS_EXPORT_MAX_ROWS,
  RECEIPT_SIGNED_URL_TTL_SECONDS,
  RECORDS_CSV_COLUMNS,
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
  renderAdminFleetPage,
  // v1.80.0 (Phase 19) — Amina's care queue + the analytics page.
  buildCareQueue,
  renderCareQueuePage,
  buildAnalyticsPage,
  renderAnalyticsPage,
  // v1.85.0 (Phase 24) — kind-aware record meters + CSV labels.
  attachMeterReadings,
  recordsMeterLabel,
  renderOverviewPage,
  renderVehiclesPage,
  renderVehiclePage,
  renderOtpPage,
  renderLoginPage,
  buildLoginPrefixMap,
  buildLoginLocalePrefixMap,
  renderErrorPage,
  // v1.83.0 (Phase 22) — branding, transfer + subscription surfaces.
  DASHBOARD_CSS,
  DASHBOARD_ASSET_VERSION,
  SAKA_WHATSAPP_NUMBER,
  sakaWhatsAppLink,
  renderPageShell,
  buildTransferPage,
  renderTransferPage,
  buildSubscriptionPage,
  renderSubscriptionPage
} from './src/services/dashboard.js';
import { SAKA_PDF_THEME } from './src/services/pdfEngine.js';
import { upcomingExpiryItems, buildVehicleDirectory, buildVehicleDetail } from './src/services/fleetReports.js';
import { vehicleDisplayLabel } from './src/services/vehicles.js';
import { dateRangeBounds, CUSTOM_METRICS } from './src/services/reportMetrics.js';
import { detectCountryFromPhone } from './src/services/globalization.js';
import { extractPdfText } from './src/services/pdfTextExtractor.js';
import { registerDashboardRoutes } from './src/routes/dashboard.js';
// v1.95.0 (Phase 32) — the impersonation banner ordering pin (D2).
import { withImpersonationBanner } from './src/services/dashboardAdmin.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const PROFILE = {
  id: 'p-dash-1',
  phone_number: '+254712345678',
  email: 'amina@example.com',
  email_verified: true,
  full_name: 'Amina Wanjiku'
};

function seedRow(over = {}) {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    token_hash: hashToken('seed-token'),
    session_token_hash: null,
    owner_id: PROFILE.id,
    email: PROFILE.email,
    otp_hash: hashToken('123456'),
    attempts: 0,
    verified: false,
    link_expires_at: new Date(Date.now() + DASHBOARD_LINK_TTL_MS).toISOString(),
    otp_expires_at: new Date(Date.now() + DASHBOARD_OTP_TTL_MS).toISOString(),
    session_expires_at: null,
    created_at: new Date().toISOString(),
    ...over
  };
}

async function run() {
  const previousFlag = process.env.DASHBOARD_ENABLED;
  const previousBase = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = 'https://app.sakafleet.test';

  console.log('\n--- Test 1: feature flag defaults OFF (A1) ---');
  delete process.env.DASHBOARD_ENABLED;
  check(isDashboardEnabled() === false, 'the dashboard is OFF with no env value');
  process.env.DASHBOARD_ENABLED = 'off';
  check(isDashboardEnabled() === false, '"off" keeps it OFF');
  process.env.DASHBOARD_ENABLED = 'on';
  check(isDashboardEnabled() === true, '"on" enables it');

  console.log('\n--- Test 2: flag OFF -> every route answers like an unregistered route (A1) ---');
  process.env.DASHBOARD_ENABLED = 'off';
  const offMock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] });
  const offApp = Fastify({ logger: false });
  await registerDashboardRoutes(offApp, { supabase: offMock.client });
  await offApp.ready();
  const offRequests = [
    { method: 'GET', url: '/d' },
    { method: 'GET', url: '/d/sometoken' },
    { method: 'GET', url: '/d/logout' },
    // v1.75.0 (Phase 14A) — the vehicle pages are flag-gated too.
    { method: 'GET', url: '/d/vehicles' },
    { method: 'GET', url: '/d/vehicles/some-vehicle-id' },
    // v1.75.1 (Phase 14B) — the records surface is flag-gated too.
    { method: 'GET', url: '/d/records' },
    { method: 'GET', url: '/d/records.csv' },
    { method: 'GET', url: '/d/records.pdf' },
    { method: 'GET', url: '/d/receipt/some-receipt-id' },
    // v1.75.2 (Phase 14C) — the compliance surface is flag-gated too.
    { method: 'GET', url: '/d/compliance' },
    { method: 'GET', url: '/d/compliance.pdf' },
    { method: 'GET', url: '/d/drivers/some-driver-id' },
    // v1.75.3 (Phase 14D) — reports + settings + export are flag-gated too.
    { method: 'GET', url: '/d/reports' },
    { method: 'GET', url: '/d/reports.pdf' },
    { method: 'GET', url: '/d/settings' },
    { method: 'POST', url: '/d/settings', payload: 'action=save_weekly&weekly_report=on', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'GET', url: '/d/export.csv' },
    // v1.76.0 (Phase 15) — the driver + admin lanes are flag-gated too.
    { method: 'GET', url: '/d/driver' },
    { method: 'GET', url: '/d/driver/daybook' },
    { method: 'GET', url: '/d/driver/compliance' },
    // v1.95.0 (Phase 32) — the dual-role toggle is flag-gated like every route.
    { method: 'POST', url: '/d/lane/switch', payload: 'lane=driver', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'GET', url: '/d/admin' },
    { method: 'GET', url: '/d/admin/command' },
    { method: 'GET', url: '/d/admin/owners/some-owner-id' },
    // v1.82.0 (Phase 21) — the static sign-in doors are flag-gated too.
    { method: 'GET', url: '/d/login' },
    { method: 'POST', url: '/d/login', payload: 'phone=%2B254712345678', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'GET', url: '/d/admin/login' },
    { method: 'POST', url: '/d/admin/login', payload: 'phone=%2B254712345678', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    // v1.80.0 (Phase 19) — analytics + the care queue are flag-gated too.
    { method: 'GET', url: '/d/analytics' },
    { method: 'GET', url: '/d/care' },
    // v1.83.0 (Phase 22) — assets, transfer + subscription are flag-gated too.
    { method: 'GET', url: '/d/assets/Sora-600.woff2' },
    { method: 'GET', url: '/d/assets/logo-lockup.png' },
    { method: 'GET', url: '/d/transfer' },
    { method: 'POST', url: '/d/transfer/start', payload: 'vehicle_id=v1', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'POST', url: '/d/transfer/verify', payload: 'transfer_id=t1&otp=123456', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'POST', url: '/d/transfer/cancel', payload: 'transfer_id=t1', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'GET', url: '/d/subscription' },
    { method: 'POST', url: '/d/subscription/checkout', payload: 'tier=growth&interval=monthly', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'POST', url: '/d/subscription/addon', payload: 'quantity=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { method: 'POST', url: '/d/verify', payload: 'token=x&otp=123456', headers: { 'content-type': 'application/x-www-form-urlencoded' } }
  ];
  for (const request of offRequests) {
    const response = await offApp.inject(request);
    check(response.statusCode === 404, `${request.method} ${request.url} is a generic 404 while OFF`);
    const body = response.body || '';
    check(body.includes('Not Found') && !/dashboard/i.test(body), `${request.method} ${request.url} never reveals the dashboard exists`);
  }
  await offApp.close();
  check(offMock.state.inserts.length === 0 && offMock.state.updates.length === 0, 'no database write happens while the flag is OFF');

  console.log('\n--- Test 3: eligibility gates (never throws, never leaks) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const emptyMock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [], vehicles: [] });
  const baseRequest = {
    supabase: emptyMock.client,
    phone: PROFILE.phone_number,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendOtp: async () => true
  };
  check((await requestDashboardOtp({ ...baseRequest, phone: '' })).reason === 'bad_phone', 'a missing phone is refused');
  check((await requestDashboardOtp({ ...baseRequest, phone: '123' })).reason === 'bad_phone', 'an unreadable phone is refused');
  check((await requestDashboardOtp({ ...baseRequest, profile: { ...PROFILE, email: null, full_name: null } })).reason === 'no_account', 'a shell profile (no email, no name) is refused — the ghost guard');
  check((await requestDashboardOtp({ ...baseRequest, entitlements: null, profile: { ...PROFILE, email: null } })).reason === 'not_entitled', 'missing entitlements are refused');
  check((await requestDashboardOtp({ ...baseRequest, entitlements: { isTrial: false, isPaid: false } })).reason === 'not_entitled', 'a free (or lapsed PAST_DUE) account is refused');
  check((await requestDashboardOtp({ ...baseRequest, role: 'wizard' })).reason === 'bad_role', 'an unknown role is refused');
  const previousAdminPhoneGate = process.env.SUPERADMIN_PHONE;
  process.env.SUPERADMIN_PHONE = '+254700000099';
  check((await requestDashboardOtp({ ...baseRequest, phone: '+254700000099', profile: { id: 'p-admin', phone_number: '+254700000099', full_name: 'Admin' }, role: 'auto' })).reason === 'use_admin_login', 'D4: the admin number never mints an owner session at /d/login');
  if (previousAdminPhoneGate === undefined) delete process.env.SUPERADMIN_PHONE;
  else process.env.SUPERADMIN_PHONE = previousAdminPhoneGate;
  check(emptyMock.state.inserts.length === 0, 'no auth row is created for a refused request');
  const paid = await requestDashboardOtp({ ...baseRequest, entitlements: { isTrial: false, isPaid: true } });
  check(paid.ok === true, 'a paid account passes the gate');

  console.log('\n--- Test 4: request mints a WhatsApp OTP, stores hashes only ---');
  const mock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [], vehicles: [] });
  let otpPayload = null;
  const access = await requestDashboardOtp({
    supabase: mock.client,
    phone: PROFILE.phone_number,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendOtp: async (to, text, options) => { otpPayload = { to, text, options }; return true; }
  });
  check(access.ok === true && access.role === 'owner', 'a trial owner receives a code');
  const rawToken = access.token;
  check(rawToken.length === 64, 'the raw flow token is 32 bytes of hex');
  check(access.phoneMasked === maskPhone(PROFILE.phone_number), 'the page names the masked WhatsApp number');
  check(otpPayload && otpPayload.to === PROFILE.phone_number, 'the code goes to the WhatsApp number signing in');
  const otpMatch = String(otpPayload.text).match(/\b\d{6}\b/);
  check(Boolean(otpMatch), 'the WhatsApp message carries a 6-digit code');
  const loginOtp = otpMatch ? otpMatch[0] : '000000';
  // v1.87.1 — the sender is told this is the Authentication-template OTP.
  check(otpPayload.options?.kind === 'auth_otp' && otpPayload.options?.templateVars?.code === loginOtp,
    'the OTP send carries the auth_otp kind + the code (v1.87.1)');
  check(!otpPayload.text.includes(rawToken), 'the flow token never travels over WhatsApp');
  check(access.link === undefined, 'no emailed magic link is minted any more');
  const row = mock.db[DASHBOARD_SESSIONS_TABLE][0];
  check(row.token_hash === hashToken(rawToken) && row.token_hash !== rawToken, 'the flow token is stored as sha256 (never raw)');
  check(row.otp_hash === hashToken(loginOtp) && row.otp_hash !== loginOtp, 'the OTP is stored as sha256 (never raw)');
  check(row.session_role === 'owner', 'the minted row carries the owner role');
  const serialized = JSON.stringify(mock.db[DASHBOARD_SESSIONS_TABLE]);
  check(!serialized.includes(rawToken) && !serialized.includes(loginOtp), 'no raw token or code exists anywhere in the database rows');
  check(mock.db.admin_audit_logs.some((a) => a.action === 'DASHBOARD_OTP_SENT' && a.details?.channel === 'whatsapp'), 'the WhatsApp OTP send is audited');
  const linkTtl = new Date(row.link_expires_at).getTime() - new Date(row.created_at).getTime();
  check(Math.abs(linkTtl - DASHBOARD_LINK_TTL_MS) < 5000, 'the flow window is 15 minutes');
  const otpTtl = new Date(row.otp_expires_at).getTime() - new Date(row.created_at).getTime();
  check(Math.abs(otpTtl - DASHBOARD_OTP_TTL_MS) < 5000, 'the OTP TTL is 10 minutes');

  console.log('\n--- Test 5: 60-second resend cooldown ---');
  const cooldown = await requestDashboardOtp({
    supabase: mock.client,
    phone: PROFILE.phone_number,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendOtp: async () => true
  });
  check(cooldown.ok === false && cooldown.reason === 'cooldown', 'a second request within 60 seconds answers cooldown');
  check(mock.db[DASHBOARD_SESSIONS_TABLE].length === 1, 'the cooldown never inserts a second row');

  console.log('\n--- Test 6: a failed WhatsApp send leaves no orphaned live token ---');
  const failMock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [], vehicles: [] });
  const failed = await requestDashboardOtp({
    supabase: failMock.client,
    phone: PROFILE.phone_number,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendOtp: async () => false
  });
  check(failed.ok === false && failed.reason === 'otp_send_failed', 'a failed WhatsApp send is reported, never thrown');
  check(failMock.db[DASHBOARD_SESSIONS_TABLE].length === 0, 'the auth row is removed when the code cannot be sent');

  console.log('\n--- Test 7: OTP verify -> single-use flow -> 15-minute session ---');
  const verified = await verifyDashboardOtp({ supabase: mock.client, rawToken, otp: loginOtp });
  check(verified.ok === true && typeof verified.sessionToken === 'string', 'the correct code issues a session token');
  check(verified.role === 'owner', 'verify returns the session role (route redirects by it)');
  check(verified.sessionToken.length === 64, 'the session token is 32 bytes of hex');
  const verifiedRow = mock.db[DASHBOARD_SESSIONS_TABLE][0];
  check(verifiedRow.verified === true, 'the row is stamped verified');
  check(verifiedRow.otp_hash === null, 'the OTP hash is burned after use');
  check(verifiedRow.session_token_hash === hashToken(verified.sessionToken), 'only the session token hash is stored');
  check(!JSON.stringify(verifiedRow).includes(verified.sessionToken), 'the raw session token never appears in the row');
  const sessionTtl = new Date(verifiedRow.session_expires_at).getTime() - Date.now();
  check(Math.abs(sessionTtl - DASHBOARD_SESSION_TTL_MS) < 10000, 'the session TTL is 15 minutes');
  const lookedUp = await getSessionByToken({ supabase: mock.client, sessionToken: verified.sessionToken });
  check(lookedUp.ok === true && lookedUp.ownerId === PROFILE.id, 'the session token resolves to its owner');
  const replayLink = await getLinkState({ supabase: mock.client, rawToken });
  check(replayLink.ok === false && replayLink.reason === 'already_used', 'a used link never opens again');
  const replayOtp = await verifyDashboardOtp({ supabase: mock.client, rawToken, otp: loginOtp });
  check(replayOtp.ok === false && replayOtp.reason === 'already_used', 'the same link + code cannot be re-verified');
  const cleared = await clearDashboardSession({ supabase: mock.client, sessionToken: verified.sessionToken });
  check(cleared.ok === true, 'logout clears the session row');
  const afterLogout = await getSessionByToken({ supabase: mock.client, sessionToken: verified.sessionToken });
  check(afterLogout.ok === false && afterLogout.reason === 'no_session', 'the cleared session no longer resolves');
  check(mock.db.admin_audit_logs.some((a) => a.action === 'DASHBOARD_OTP_SENT')
    && mock.db.admin_audit_logs.some((a) => a.action === 'DASHBOARD_SESSION_CREATED')
    && mock.db.admin_audit_logs.some((a) => a.action === 'DASHBOARD_LOGOUT'), 'every auth step is audited');

  console.log('\n--- Test 8: TTL enforcement ---');
  const expiredLinkMock = createMockSupabase({
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({
      token_hash: hashToken('expired-link'),
      link_expires_at: new Date(Date.now() - 60000).toISOString()
    })],
    admin_audit_logs: []
  });
  const expiredLink = await verifyDashboardOtp({ supabase: expiredLinkMock.client, rawToken: 'expired-link', otp: '123456' });
  check(expiredLink.ok === false && expiredLink.reason === 'link_expired', 'an expired link is refused');
  check((await getLinkState({ supabase: expiredLinkMock.client, rawToken: 'expired-link' })).reason === 'link_expired', 'the page also sees link_expired');
  const expiredOtpMock = createMockSupabase({
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({
      token_hash: hashToken('expired-otp'),
      otp_expires_at: new Date(Date.now() - 60000).toISOString()
    })],
    admin_audit_logs: []
  });
  const expiredOtp = await verifyDashboardOtp({ supabase: expiredOtpMock.client, rawToken: 'expired-otp', otp: '123456' });
  check(expiredOtp.ok === false && expiredOtp.reason === 'otp_expired', 'an expired code is refused');
  const unknown = await verifyDashboardOtp({ supabase: expiredOtpMock.client, rawToken: 'not-a-real-token', otp: '123456' });
  check(unknown.ok === false && unknown.reason === 'invalid_link', 'an unknown token is refused without a lookup leak');

  console.log('\n--- Test 9: attempts cap (5) + timing-safe compare ---');
  const attemptMock = createMockSupabase({
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({ token_hash: hashToken('attempt-token') })],
    admin_audit_logs: []
  });
  const reasons = [];
  for (let i = 0; i < DASHBOARD_MAX_ATTEMPTS; i += 1) {
    const result = await verifyDashboardOtp({ supabase: attemptMock.client, rawToken: 'attempt-token', otp: '000000' });
    reasons.push(result.reason);
  }
  check(reasons.slice(0, 4).every((reason) => reason === 'otp_mismatch'), 'the first four wrong codes answer otp_mismatch');
  check(reasons[4] === 'locked', 'the fifth wrong code locks the link');
  check(attemptMock.db[DASHBOARD_SESSIONS_TABLE][0].attempts === DASHBOARD_MAX_ATTEMPTS, 'attempts are counted on the row');
  check(attemptMock.db.admin_audit_logs.some((a) => a.action === 'DASHBOARD_OTP_LOCKED'), 'the lock is audited');
  const afterLock = await verifyDashboardOtp({ supabase: attemptMock.client, rawToken: 'attempt-token', otp: '123456' });
  check(afterLock.ok === false && afterLock.reason === 'locked', 'a locked link refuses even the correct code');
  const malformed = await verifyDashboardOtp({ supabase: attemptMock.client, rawToken: 'attempt-token', otp: 'abc' });
  check(malformed.ok === false && malformed.reason === 'otp_mismatch', 'a non-6-digit code is refused up front');
  check(safeCompareHex('a'.repeat(64), 'a'.repeat(64)) === true, 'equal hashes compare true');
  check(safeCompareHex('a'.repeat(64), 'b'.repeat(64)) === false, 'different hashes compare false');
  check(safeCompareHex('a'.repeat(64), 'a'.repeat(63)) === false, 'a length mismatch returns false (never throws)');
  check(safeCompareHex('', '') === false, 'an empty comparison returns false');
  check(/^\d{6}$/.test(mintOtp()) && Number(mintOtp()) >= 100000 && Number(mintOtp()) < 1000000, 'OTPs are six digits from the CSPRNG range');

  console.log('\n--- Test 10: cookie contract + session security pins ---');
  const cookie = dashboardCookieHeader('raw-session-token');
  check(cookie.startsWith(`${DASHBOARD_COOKIE_NAME}=raw-session-token`), 'the cookie carries the raw token');
  check(cookie.includes('Path=/d') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'), 'HttpOnly + SameSite=Strict + Path=/d');
  check(cookie.includes('Max-Age=900'), 'the cookie lives 15 minutes (Max-Age=900)');
  check(cookie.includes('Secure'), 'the cookie is Secure on a real host');
  check(!dashboardCookieHeader('t', { secure: false }).includes('Secure'), 'localhost development stays plain');
  const clear = dashboardClearCookieHeader();
  check(clear.includes('Max-Age=0') && clear.includes('HttpOnly') && clear.includes('Path=/d'), 'logout clears with Max-Age=0');
  check(readDashboardCookie({ cookie: 'other=1; saka_dash=abc123; more=2' }) === 'abc123', 'the cookie parser finds the session value');
  check(readDashboardCookie({}) === null, 'no cookie header means no session');
  check(isSecureRequest({ hostname: 'localhost:3000' }) === false && isSecureRequest({ hostname: '127.0.0.1' }) === false, 'localhost is never marked Secure');
  check(isSecureRequest({ hostname: 'app.sakafleet.com' }) === true, 'the production host is Secure');
  check(maskEmail('amina@example.com') === 'a***a@example.com', 'the page masks the email address');
  check(DASHBOARD_SQL.includes('ENABLE ROW LEVEL SECURITY') && DASHBOARD_SQL.includes('token_hash text UNIQUE NOT NULL') && DASHBOARD_SQL.includes('session_token_hash text UNIQUE'), 'the schema pins RLS + unique hashes');

  console.log('\n--- Test 11: prune removes dead rows, never live sessions ---');
  const pruneMock = createMockSupabase({
    [DASHBOARD_SESSIONS_TABLE]: [
      seedRow({ id: 'stale-link', token_hash: hashToken('stale-link'), link_expires_at: new Date(Date.now() - 2 * 86400000).toISOString() }),
      seedRow({ id: 'dead-session', verified: true, link_expires_at: new Date(Date.now() - 40 * 86400000).toISOString(), session_expires_at: new Date(Date.now() - 86400000).toISOString() }),
      seedRow({ id: 'live-session', verified: true, session_expires_at: new Date(Date.now() + 10 * 86400000).toISOString() })
    ],
    admin_audit_logs: []
  });
  const pruned = await pruneExpiredDashboardSessions(pruneMock.client);
  check(pruned.ok === true, 'the prune sweep completes');
  const remaining = pruneMock.db[DASHBOARD_SESSIONS_TABLE].map((r) => r.id);
  check(!remaining.includes('stale-link'), 'an unverified link older than a day past expiry is removed');
  check(!remaining.includes('dead-session'), 'a session past its 15-minute window is removed');
  check(remaining.includes('live-session'), 'a live session is never pruned');

  console.log('\n--- Test 12: WhatsApp lane (v1.82.0 static sign-in link) ---');
  const { resolveReadCommand } = await import('./src/services/readCommands.js');
  const laneProfile = { ...PROFILE };
  const laneCtx = (over = {}) => ({
    profile: laneProfile,
    supabaseClient: {},
    countryInfo: null,
    quizPhaseLocked: false,
    ...over
  });
  check(resolveReadCommand('dashboard', laneCtx())?.id === 'dashboard', 'the exact phrase "dashboard" is claimed by the lane');
  check(resolveReadCommand('open my dashboard', laneCtx())?.id === 'dashboard', '"open my dashboard" is claimed too');
  check(resolveReadCommand('records', laneCtx())?.id === 'dashboard', 'the "records" alias is claimed by the same lane');
  check(resolveReadCommand('my records', laneCtx())?.id === 'dashboard', '"my records" is claimed too');
  process.env.DASHBOARD_ENABLED = 'off';
  const laneOff = await resolveReadCommand('dashboard', laneCtx()).render(laneCtx());
  check(laneOff.reply_message === "That's not something I can do yet — reply *help* to see what I can do.", 'flag OFF -> the verbatim A2 line');
  check(!/dashboard/i.test(laneOff.reply_message), 'the A2 line never names the dashboard');
  process.env.DASHBOARD_ENABLED = 'on';
  const laneOn = await resolveReadCommand('dashboard', laneCtx()).render(laneCtx());
  check(laneOn.reply_message.includes('https://app.sakafleet.test/d/login'), 'the lane replies with the STATIC sign-in link');
  check(/1\.[\s\S]*WhatsApp number/.test(laneOn.reply_message)
    && /2\.[\s\S]*6-digit code/.test(laneOn.reply_message)
    && /3\.[\s\S]*15 minutes/.test(laneOn.reply_message), 'the 3-line tutorial teaches number -> code -> 15 minutes');
  check(!/\b\d{6}\b/.test(laneOn.reply_message), 'the reply never contains a 6-digit code');
  check(!/email/i.test(laneOn.reply_message), 'the reply never promises an email');
  const previousAdminPhoneLane = process.env.SUPERADMIN_PHONE;
  process.env.SUPERADMIN_PHONE = PROFILE.phone_number;
  const adminLane = resolveReadCommand('dashboard admin', laneCtx());
  check(adminLane?.id === 'dashboard', '"dashboard admin" is claimed by the dashboard lane');
  const adminRender = await adminLane.render(laneCtx());
  check(adminRender.reply_message.includes('https://app.sakafleet.test/d/admin/login'), 'the superadmin gets the admin door (D4)');
  process.env.SUPERADMIN_PHONE = '+254799999999';
  const spoofRender = await resolveReadCommand('dashboard admin', laneCtx()).render(laneCtx());
  check(spoofRender.reply_message === "That's not something I can do yet — reply *help* to see what I can do.", 'a stranger gets the generic line for the admin phrase');
  if (previousAdminPhoneLane === undefined) delete process.env.SUPERADMIN_PHONE;
  else process.env.SUPERADMIN_PHONE = previousAdminPhoneLane;

  console.log('\n--- Test 13: D3 upcomingExpiryItems ---');
  const dayIso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const expiryMock = createMockSupabase({
    vehicles: [
      { id: 'v1', owner_id: PROFILE.id, plate_number: 'KDA 123A', status: 'ACTIVE', insurance_expiry: dayIso(5), inspection_expiry: dayIso(40), road_license_expiry: dayIso(-3) },
      { id: 'v2', owner_id: PROFILE.id, plate_number: 'KDB 456B', status: 'ACTIVE', permit_expiry: dayIso(2) }
    ],
    reminders: []
  });
  const upcoming = await upcomingExpiryItems(expiryMock.client, PROFILE.id, 6);
  check(Array.isArray(upcoming) && upcoming.length >= 2, 'upcoming expiries are returned from vehicle columns');
  check(upcoming.every((item) => item.daysLeft >= 0), 'expired items are excluded from the upcoming strip');
  check(upcoming.every((item, index) => index === 0 || upcoming[index - 1].daysLeft <= item.daysLeft), 'items are sorted soonest-first');
  check(upcoming[0].plate === 'KDB 456B' && upcoming[0].category === 'permit', 'the soonest item leads (permit in ~2 days)');
  check(!upcoming.some((item) => item.category === 'licensing'), 'the expired road licence never appears');
  check(Object.keys(upcoming[0]).sort().join(',') === 'category,daysLeft,dueDate,plate,status', 'the shape is exactly { plate, category, dueDate, daysLeft, status }');
  const capped = await upcomingExpiryItems(expiryMock.client, PROFILE.id, 1);
  check(capped.length === 1, 'the limit caps the strip');
  check((await upcomingExpiryItems(expiryMock.client, 'someone-else', 6)).length === 0, 'another owner sees none of these items');

  console.log('\n--- Test 14: buildOverviewCard shaping ---');
  const fakeReport = {
    ok: true,
    data: {
      generatedAt: '2026-11-08T06:00:00Z',
      currency: 'KES',
      timeZone: 'Africa/Nairobi',
      financial: { expenses: { total: 500 }, earnings: 1500, net: 1000 },
      overview: { activeVehicles: 2, totalVehicles: 4 },
      recentActivity: Array.from({ length: 8 }, (_, i) => ({ type: 'expense_logged', label: `row ${i}`, at: '2026-11-08T00:00:00Z' }))
    }
  };
  const fakeUpcoming = Array.from({ length: 8 }, (_, i) => ({ plate: 'X', category: 'insurance', dueDate: dayIso(i + 1), daysLeft: i + 1, status: 'active' }));
  const card = await buildOverviewCard({
    supabase: {},
    ownerId: 'p1',
    buildReport: async () => fakeReport,
    loadUpcoming: async () => fakeUpcoming
  });
  check(card.ok === true, 'the overview card builds');
  check(card.kpis.spend === 500 && card.kpis.earnings === 1500 && card.kpis.net === 1000 && card.kpis.activeVehicles === 2 && card.kpis.totalVehicles === 4,
    'KPIs map from the fleet report (spend, earnings, net, active vehicles)');
  check(card.upcoming.length === 6, 'at most six upcoming expiries are carried');
  check(card.recent.length === 5, 'at most five recent activities are carried');
  check(card.currency === 'KES' && card.timeZone === 'Africa/Nairobi', 'currency and timezone ride the report');
  check((await buildOverviewCard({ supabase: {}, ownerId: 'p1', buildReport: async () => ({ ok: false }), loadUpcoming: async () => [] })).ok === false,
    'a failed fleet report fails the card honestly');

  console.log('\n--- Test 15: buildOverviewCard against the real builder (empty fleet) ---');
  const emptyFleet = createMockSupabase({ vehicles: [], profiles: [], reminders: [], expense_logs: [], private_earnings: [], passbook_transfers: [], expiry_notification_log: [], vehicle_compliances: [], driver_compliances: [], admin_audit_logs: [] });
  const realCard = await buildOverviewCard({ supabase: emptyFleet.client, ownerId: PROFILE.id, profile: PROFILE });
  check(realCard.ok === true, 'the real fleet builder produces a card for an empty fleet');
  check(realCard.kpis.spend === 0 && realCard.kpis.earnings === 0 && realCard.kpis.net === 0 && realCard.kpis.activeVehicles === 0,
    'an empty fleet reads as honest zeros (never invented figures)');
  check(realCard.upcoming.length === 0 && realCard.recent.length === 0, 'no expiries and no activity for an empty fleet');

  console.log('\n--- Test 16: the sign-in doors end-to-end (Fastify inject) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const pageMock = createMockSupabase({
    [DASHBOARD_SESSIONS_TABLE]: [],
    admin_audit_logs: [],
    profiles: [{ id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country_code: 'KE' }],
    vehicles: [],
    expense_logs: [], private_earnings: [], reminders: [], receipts: [],
    passbook_transfers: [], vehicle_compliances: [], driver_compliances: [],
    expiry_notification_log: [], subscriptions: [], trial_sessions: [], usage_counters: []
  });
  const pageToken = 'f'.repeat(64);
  const pageOtp = '123456';
  const fakeRequestOtp = async () => {
    pageMock.db[DASHBOARD_SESSIONS_TABLE].push(seedRow({ id: 'page-row', token_hash: hashToken(pageToken), owner_id: PROFILE.id, email: PROFILE.email, otp_hash: hashToken(pageOtp), session_role: 'owner' }));
    return { ok: true, token: pageToken, role: 'owner', phoneMasked: maskPhone(PROFILE.phone_number) };
  };
  const app = Fastify({ logger: false });
  await registerDashboardRoutes(app, { supabase: pageMock.client, requestOtp: fakeRequestOtp });
  await app.ready();

  const loginPage = await app.inject({ method: 'GET', url: '/d/login' });
  check(loginPage.statusCode === 200 && /Your dashboard/.test(loginPage.body), 'GET /d/login renders the static sign-in page');
  // v1.94.0 (Phase 31) — the signed-out brand click goes to the public site.
  check(loginPage.body.includes('class="brand" href="https://sakafleet.com"'), 'the signed-out login brand points at the public site (v1.94.0)');
  const anonHome = await app.inject({ method: 'GET', url: '/d' });
  check(anonHome.statusCode === 401 && anonHome.body.includes('class="brand" href="https://sakafleet.com"'), 'a signed-out 401 page points its brand at the public site (v1.94.0)');
  check(loginPage.body.includes('name="phone"') && /Send me a code/.test(loginPage.body), 'the page asks for the WhatsApp number');
  check(!/email/i.test(loginPage.body.replace(/<style>[\s\S]*?<\/style>/g, '')), 'the sign-in page never mentions email');

  console.log('\n--- v1.86.0: sign-in prefix comes from the registry, not +254 ---');
  const prefixMap = buildLoginPrefixMap();
  check(prefixMap['Africa/Nairobi'] === '+254' && prefixMap['Europe/London'] === '+44' && prefixMap['Europe/Brussels'] === '+32', 'the prefix map follows the REGIONS registry');
  check(prefixMap['America/Chicago'] === '+1' && prefixMap['Australia/Perth'] === '+61' && prefixMap['America/Toronto'] === '+1', 'multi-zone countries resolve their browser zones');
  check(prefixMap['Asia/Kolkata'] === '+91' && prefixMap['Asia/Dubai'] === '+971' && prefixMap['America/Sao_Paulo'] === '+55', 'every launch market resolves');
  check(Object.values(prefixMap).every((value) => /^\+\d{1,4}$/.test(value)), 'every mapped value is a real calling code');
  check(buildLoginLocalePrefixMap().KE === '+254' && buildLoginLocalePrefixMap().CA === '+1', 'the locale fallback map is complete');
  check(loginPage.body.includes('id="loginPhone"') && loginPage.body.includes('I filled your country code'), 'the phone field is auto-fill ready with an honest hint');
  check(loginPage.body.includes('var prefixes =') && loginPage.body.includes('"+254"'), 'the page carries the registry-derived prefix map');
  check(!/name="phone"[^>]*value="/.test(loginPage.body), 'the prefix is filled by the browser, never hardcoded server-side');

  const loginPost = await app.inject({
    method: 'POST',
    url: '/d/login',
    payload: `phone=${encodeURIComponent(PROFILE.phone_number)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  check(loginPost.statusCode === 200 && /Check your WhatsApp/.test(loginPost.body), 'a successful POST renders the OTP step in place');
  check(loginPost.body.includes(`value="${pageToken}"`) && loginPost.body.includes(maskPhone(PROFILE.phone_number)), 'the OTP form carries the token and the masked number');

  const legacyOtpPage = await app.inject({ method: 'GET', url: `/d/${pageToken}` });
  check(legacyOtpPage.statusCode === 200 && /Check your WhatsApp/.test(legacyOtpPage.body), 'GET /d/<token> still renders the OTP page for pre-1.82.0 links');
  check(legacyOtpPage.body.includes(maskPhone(PROFILE.phone_number)), 'the legacy page names the masked WhatsApp number');

  // v1.90.0 (Phase 28B) — /d/verify was the ONE /d POST without the Origin
  // guard. A cross-site post must be refused BEFORE any OTP work: no attempt
  // burned, no session minted, no cookie set (CHECK 4 / rule 51).
  const crossOriginVerify = await app.inject({
    method: 'POST',
    url: '/d/verify',
    payload: `token=${pageToken}&otp=${pageOtp}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://evil.example',
      host: 'app.sakafleet.test'
    }
  });
  check(crossOriginVerify.statusCode === 400 && /Please open the sign-in page again/.test(crossOriginVerify.body), 'a cross-origin POST /d/verify is refused with 400 (v1.90.0)');
  check(pageMock.db[DASHBOARD_SESSIONS_TABLE][0].attempts === 0 && pageMock.db[DASHBOARD_SESSIONS_TABLE][0].verified === false, 'the refused cross-origin verify burned no attempt and minted no session');
  check(!/Max-Age=900/.test(String(crossOriginVerify.headers['set-cookie'] || '')), 'the refused cross-origin verify sets no session cookie');

  const badOtp = await app.inject({
    method: 'POST',
    url: '/d/verify',
    payload: `token=${pageToken}&otp=000000`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  check(badOtp.statusCode === 401 && /did not match/.test(badOtp.body), 'a wrong code re-renders the OTP page with an error');
  check(pageMock.db[DASHBOARD_SESSIONS_TABLE][0].attempts === 1, 'a wrong code increments the attempt counter');
  check(!/saka_dash=[a-f0-9]{64}/.test(String(badOtp.headers['set-cookie'] || '')), 'a wrong code never issues a cookie');

  const goodOtp = await app.inject({
    method: 'POST',
    url: '/d/verify',
    payload: `token=${pageToken}&otp=${pageOtp}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  check(goodOtp.statusCode === 303 && goodOtp.headers.location === '/d', 'the correct code redirects 303 to /d');
  const cookieLine = String(Array.isArray(goodOtp.headers['set-cookie']) ? goodOtp.headers['set-cookie'][0] : goodOtp.headers['set-cookie'] || '');
  check(/saka_dash=[a-f0-9]{64}/.test(cookieLine), 'the session cookie carries a raw 64-hex token');
  check(cookieLine.includes('HttpOnly') && cookieLine.includes('SameSite=Strict') && cookieLine.includes('Path=/d') && cookieLine.includes('Max-Age=900'),
    'the cookie is HttpOnly, SameSite=Strict, Path=/d and lives 15 minutes');
  check(!cookieLine.includes('Secure'), 'localhost development omits Secure');
  const sessionCookie = cookieLine.match(/saka_dash=([a-f0-9]{64})/)[1];

  const overview = await app.inject({ method: 'GET', url: '/d', headers: { cookie: `saka_dash=${sessionCookie}` } });
  check(overview.statusCode === 200, 'GET /d with a valid cookie renders the overview');
  check(/Your fleet at a glance/.test(overview.body), 'the overview title renders');
  check(overview.body.includes('Spend') && overview.body.includes('Earnings') && overview.body.includes('Net') && overview.body.includes('Active vehicles'),
    'the KPI labels render (spend, earnings, net, active vehicles)');
  check(overview.body.includes('Coming up') && overview.body.includes('Recent activity'), 'the upcoming + recent sections render');
  check(overview.body.includes('href="/d/logout"') && /a\*\*\*a@example\.com/.test(overview.body), 'the page carries the logout link and the masked identity');

  const noCookie = await app.inject({ method: 'GET', url: '/d' });
  check(noCookie.statusCode === 401 && /Reply \*dashboard\*/.test(noCookie.body), 'GET /d without a cookie 401s with the WhatsApp instruction');
  const badCookie = await app.inject({ method: 'GET', url: '/d', headers: { cookie: 'saka_dash=deadbeef' } });
  check(badCookie.statusCode === 401, 'GET /d with an unknown cookie 401s');
  check(String(badCookie.headers['set-cookie'] || '').includes('Max-Age=0'), 'an invalid session cookie is cleared');

  const signedInDoor = await app.inject({ method: 'GET', url: '/d/login', headers: { cookie: `saka_dash=${sessionCookie}` } });
  check(signedInDoor.statusCode === 303 && String(signedInDoor.headers.location || '') === '/d', 'a signed-in owner opening /d/login is sent to /d');
  const signedInAdminDoor = await app.inject({ method: 'GET', url: '/d/admin/login', headers: { cookie: `saka_dash=${sessionCookie}` } });
  check(signedInAdminDoor.statusCode === 303 && String(signedInAdminDoor.headers.location || '') === '/d', 'an owner opening /d/admin/login lands on their OWN home (never a form or a 403)');
  const logout = await app.inject({ method: 'GET', url: '/d/logout', headers: { cookie: `saka_dash=${sessionCookie}` } });
  // v1.86.0 (Phase 25) — D4 behaviour change: logout now 303s to the sign-in
  // door carrying the banner flag (it used to render a dead-end 200 page).
  check(logout.statusCode === 303, 'GET /d/logout answers 303 (was a 200 dead-end page)');
  check(String(logout.headers.location || '') === '/d/login?logged_out=1', 'logout lands on the sign-in door with logged_out=1');
  const loggedOutDoor = await app.inject({ method: 'GET', url: '/d/login?logged_out=1' });
  check(loggedOutDoor.statusCode === 200 && /You have been logged out/i.test(loggedOutDoor.body), 'the sign-in door shows the logged-out banner');
  check(String(logout.headers['set-cookie'] || '').includes('Max-Age=0'), 'logout clears the cookie');
  check(pageMock.db[DASHBOARD_SESSIONS_TABLE].length === 0, 'logout deletes the session row');
  const afterPageLogout = await app.inject({ method: 'GET', url: '/d', headers: { cookie: `saka_dash=${sessionCookie}` } });
  check(afterPageLogout.statusCode === 401, 'the old cookie no longer opens the dashboard');
  await app.close();

  // v1.82.0 (D4) — the admin door mints an admin session and lands on /d/admin.
  const previousAdmin = process.env.SUPERADMIN_PHONE;
  process.env.SUPERADMIN_PHONE = '+254700000099';
  const adminMock = createMockSupabase({
    [DASHBOARD_SESSIONS_TABLE]: [],
    admin_audit_logs: [],
    profiles: [{ id: 'p-admin', phone_number: '+254700000099', email: null, full_name: 'Admin' }],
    vehicles: []
  });
  const adminToken = 'e'.repeat(64);
  const adminRequestOtp = async ({ role }) => {
    if (role !== 'admin') return { ok: false, reason: 'bad_role' };
    adminMock.db[DASHBOARD_SESSIONS_TABLE].push(seedRow({ id: 'admin-row', token_hash: hashToken(adminToken), owner_id: 'p-admin', email: null, otp_hash: hashToken('654321'), session_role: 'admin' }));
    return { ok: true, token: adminToken, role: 'admin', phoneMasked: '+2547****0099' };
  };
  const adminApp = Fastify({ logger: false });
  await registerDashboardRoutes(adminApp, { supabase: adminMock.client, requestOtp: adminRequestOtp });
  await adminApp.ready();
  const adminLoginPage = await adminApp.inject({ method: 'GET', url: '/d/admin/login' });
  check(adminLoginPage.statusCode === 200 && /Admin dashboard/.test(adminLoginPage.body), 'GET /d/admin/login renders the admin door');
  const adminPost = await adminApp.inject({
    method: 'POST',
    url: '/d/admin/login',
    payload: 'phone=%2B254700000099',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  check(adminPost.statusCode === 200 && /Check your WhatsApp/.test(adminPost.body), 'the admin door POST renders the OTP step');
  const adminVerified = await adminApp.inject({
    method: 'POST',
    url: '/d/verify',
    payload: `token=${adminToken}&otp=654321`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  check(adminVerified.statusCode === 303 && adminVerified.headers.location === '/d/admin', 'an admin code lands on /d/admin (never /d)');
  await adminApp.close();
  if (previousAdmin === undefined) delete process.env.SUPERADMIN_PHONE;
  else process.env.SUPERADMIN_PHONE = previousAdmin;

  console.log('\n--- Test 17: pure renderers ---');
  const synthetic = {
    ok: true,
    generatedAt: '2026-11-08T06:00:00Z',
    currency: 'KES',
    locale: 'en-KE',
    timeZone: 'Africa/Nairobi',
    kpis: { spend: 1200.5, earnings: 3000, net: 1799.5, activeVehicles: 2, totalVehicles: 3 },
    upcoming: [
      { plate: 'KDA 123A', category: 'insurance', dueDate: '2026-11-10', daysLeft: 2, status: 'due_7d' },
      { plate: 'KDB 456B', category: 'inspection', dueDate: '2026-11-25', daysLeft: 17, status: 'due_30d' }
    ],
    recent: [
      { type: 'expense_logged', label: 'KDA 123A fuel KES 5,500', at: '2026-11-08T05:00:00Z' },
      { type: 'vehicle_registered', label: 'KDB 456B registered', at: '2026-11-07T05:00:00Z' }
    ]
  };
  const html = renderOverviewPage({ data: synthetic, emailMasked: 'a***a@example.com' });
  check(html.includes('Your fleet at a glance') && html.includes('a***a@example.com'), 'the overview renders its title and identity');
  check(html.includes('KES') && /1,?200/.test(html), 'money renders in the owner currency');
  check(html.includes('KDA 123A') && html.includes('in 2 d') && html.includes('in 17 d'), 'upcoming expiries render with day chips');
  check(html.includes('KDA 123A fuel KES 5,500') && html.includes('KDB 456B registered'), 'recent activities render');
  check(html.includes('class="chip due"'), 'expiries inside 7 days carry the due chip');
  const emptyHtml = renderOverviewPage({
    data: { ...synthetic, upcoming: [], recent: [] },
    emailMasked: 'a***a@example.com'
  });
  check(emptyHtml.includes('Nothing due in the coming weeks') && emptyHtml.includes('No activity yet'),
    'empty sections show a warm, honest empty state (never a bare zero)');
  const errorPage = renderErrorPage(410, 'This link has expired.');
  check(errorPage.status === 410 && errorPage.html.includes('Link expired') && errorPage.html.includes('This link has expired.'), 'the error renderer maps 410 to a plain explanation');
  const renderedOtp = renderOtpPage({ token: 'abc123', emailMasked: 'a***a@example.com', error: 'That code did not match.' });
  check(renderedOtp.includes('value="abc123"') && renderedOtp.includes('That code did not match.') && renderedOtp.includes('Never share it'),
    'the OTP renderer carries the token, the error and the never-share warning');
  const failedCard = renderOverviewPage({ data: { ok: false }, emailMasked: 'a***a@example.com' });
  check(failedCard.includes('could not be loaded') && !failedCard.includes('undefined'), 'a failed card renders one honest explanation (no undefined leaks)');

  console.log('\n--- Test 18: buildVehicleDirectory (Phase 14A) ---');
  const nowDir = new Date();
  const monthStamp = (day, hour = 8) => new Date(Date.UTC(nowDir.getUTCFullYear(), nowDir.getUTCMonth(), day, hour, 0, 0)).toISOString();
  const lastMonthStamp = new Date(Date.UTC(nowDir.getUTCFullYear(), nowDir.getUTCMonth() - 1, 15, 8, 0, 0)).toISOString();
  const KE_INFO = detectCountryFromPhone(PROFILE.phone_number);
  const fleetSeed = () => ({
    vehicles: [
      { id: 'v-b', owner_id: PROFILE.id, plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE', current_mileage: 120000, assigned_driver_id: 'd-1', insurance_expiry: dayIso(5), road_license_expiry: dayIso(-2) },
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', make_model: 'Nissan Note', status: 'ACTIVE', current_mileage: 90000, permit_expiry: dayIso(20) },
      { id: 'v-c', owner_id: PROFILE.id, plate_number: 'KDC 789C', make_model: 'Isuzu NQR', status: 'PAUSED', current_mileage: 300000 }
    ],
    profiles: [{ id: 'd-1', full_name: 'Brian Otieno', phone_number: '+254799999999' }],
    reminders: [],
    expense_logs: [
      { id: 'e1', vehicle_id: 'v-b', amount: 4000, expense_type: 'Fuel', created_at: monthStamp(2) },
      { id: 'e2', vehicle_id: 'v-b', amount: 1000, expense_type: 'Fuel', created_at: lastMonthStamp },
      { id: 'e3', vehicle_id: 'v-a', amount: 2500, expense_type: 'Repair', created_at: monthStamp(3) }
    ],
    private_earnings: [
      { id: 'n1', vehicle_id: 'v-b', revenue_amount: 9000, earning_type: 'Trips', logged_at: monthStamp(4, 9) }
    ],
    passbook_transfers: [],
    expiry_notification_log: [],
    vehicle_compliances: [],
    driver_compliances: []
  });
  const fleetMock = createMockSupabase(fleetSeed());
  const directory = await buildVehicleDirectory({ supabase: fleetMock.client, ownerId: PROFILE.id, countryInfo: KE_INFO, now: nowDir });
  check(directory.ok === true && directory.vehicles.length === 3, 'the directory lists every vehicle of the owner');
  check(directory.currency === 'KES' && directory.timeZone === 'Africa/Nairobi' && directory.distanceUnit === 'km', 'money, units and dates resolve from the phone country (rule 7)');
  check(directory.vehicles.map((v) => v.plate).join(',') === 'KDA 123A,KDB 456B,KDC 789C', 'active vehicles lead (plate order), a paused one sorts last');
  const rowB = directory.vehicles.find((v) => v.id === 'v-b');
  check(rowB.monthSpend === 4000 && rowB.monthEarnings === 9000, 'this month money excludes last month (4000 spend, 9000 earnings)');
  check(rowB.driverName === 'Brian Otieno', 'the assigned driver resolves by name');
  check(rowB.overdueCount === 1 && rowB.dueCount === 1 && rowB.soonest.category === 'insurance', 'expired and upcoming documents are counted separately, soonest leads');
  check(rowB.odometer === 120000 && rowB.distanceUnit === 'km', 'the odometer rides in the display unit');
  const rowC = directory.vehicles.find((v) => v.id === 'v-c');
  check(rowC.active === false && rowC.status === 'paused' && rowC.soonest === null, 'a paused vehicle is honest: no documents claimed');
  const imperial = await buildVehicleDirectory({
    supabase: createMockSupabase(fleetSeed()).client,
    ownerId: PROFILE.id,
    countryInfo: KE_INFO,
    profile: { ...PROFILE, unit_system: 'imperial' },
    now: nowDir
  });
  const imperialB = imperial.vehicles.find((v) => v.id === 'v-b');
  check(imperial.distanceUnit === 'mi' && imperialB.odometer === 74565, 'an imperial profile reads miles (74565 mi), never kilometres');
  const otherOwner = await buildVehicleDirectory({ supabase: fleetMock.client, ownerId: 'someone-else', countryInfo: KE_INFO });
  check(otherOwner.ok === true && otherOwner.vehicles.length === 0, "another owner's directory is empty (owner-scoped)");
  check((await buildVehicleDirectory({ supabase: null, ownerId: PROFILE.id })).ok === false, 'no database answers ok:false (never throws)');

  console.log('\n--- Test 19: buildVehicleDetail (ownership + scoping) ---');
  const detailMock = createMockSupabase(fleetSeed());
  const detail = await buildVehicleDetail({ supabase: detailMock.client, ownerId: PROFILE.id, vehicleId: 'v-b', countryInfo: KE_INFO, now: nowDir });
  check(detail.ok === true && detail.vehicle.plate === 'KDB 456B', 'the owner opens their own vehicle');
  check(detail.documents.length === 2 && detail.documents[0].category === 'licensing' && detail.documents[0].daysLeft < 0 && detail.documents[1].category === 'insurance',
    'documents are scoped to this vehicle and sorted soonest-first (expired leads)');
  check(detail.documents.every((doc) => Boolean(doc.label)), 'every document carries a plain-language label');
  check(detail.records.length === 3 && detail.records[0].kind === 'earning' && detail.records[0].amount === 9000, 'records merge expenses + earnings, newest first');
  check(detail.records.every((row) => Boolean(row.description) && Number.isFinite(row.amount)), 'every record has a description and an amount');
  check(detail.currency === 'KES', 'the vehicle page money rides the owner currency');
  check(!('vin' in detail.vehicle), 'VIN is never rendered on the dashboard (rule 8)');
  const unknownVehicle = await buildVehicleDetail({ supabase: detailMock.client, ownerId: PROFILE.id, vehicleId: 'nope', countryInfo: KE_INFO });
  check(unknownVehicle.ok === false && unknownVehicle.reason === 'not_found', 'an unknown vehicle id answers not_found');
  const foreignVehicle = await buildVehicleDetail({ supabase: detailMock.client, ownerId: 'someone-else', vehicleId: 'v-b', countryInfo: KE_INFO });
  check(foreignVehicle.ok === false && foreignVehicle.reason === 'not_found', "another owner's vehicle id answers not_found (structural ownership)");
  check((await buildVehicleDetail({ supabase: detailMock.client, ownerId: null, vehicleId: 'v-b' })).reason === 'not_found', 'a missing owner answers not_found');
  const cappedDetail = await buildVehicleDetail({ supabase: createMockSupabase(fleetSeed()).client, ownerId: PROFILE.id, vehicleId: 'v-b', countryInfo: KE_INFO, now: nowDir, recordLimit: 1 });
  check(cappedDetail.records.length === 1, 'recordLimit caps the recent-records list');
  const quietDetail = await buildVehicleDetail({
    supabase: createMockSupabase({
      vehicles: [{ id: 'v-z', owner_id: PROFILE.id, plate_number: 'KDZ 000Z', make_model: 'Suzuki Alto', status: 'ACTIVE' }],
      reminders: [], expense_logs: [], private_earnings: [], passbook_transfers: [], profiles: [], vehicle_compliances: [], driver_compliances: [], expiry_notification_log: []
    }).client,
    ownerId: PROFILE.id,
    vehicleId: 'v-z',
    countryInfo: KE_INFO,
    now: nowDir
  });
  check(quietDetail.ok === true && quietDetail.documents.length === 0 && quietDetail.records.length === 0, 'a quiet vehicle renders honest empty lists');

  console.log('\n--- Test 20: the vehicle page renderers ---');
  const indexHtml = renderVehiclesPage({ data: directory, emailMasked: 'a***a@example.com' });
  check(indexHtml.includes('Your vehicles') && indexHtml.includes('KDB 456B') && indexHtml.includes('Toyota Hiace'), 'the list renders plate + model for every vehicle');
  check(indexHtml.includes('href="/d/vehicles/v-b"'), 'each row links to that vehicle page');
  check(indexHtml.includes('Driver: Brian Otieno') && indexHtml.includes('1 overdue'), 'driver and overdue count render');
  check(indexHtml.includes('href="/d"') && indexHtml.includes('href="/d/vehicles"') && indexHtml.includes('href="/d/logout"'), 'the shared nav offers overview, vehicles and logout');
  const emptyIndex = renderVehiclesPage({ data: { ...directory, vehicles: [] }, emailMasked: 'a***a@example.com' });
  check(emptyIndex.includes('No vehicles yet') && !emptyIndex.includes('undefined'), 'an empty fleet renders one warm next step (no undefined)');
  const failedIndex = renderVehiclesPage({ data: { ok: false }, emailMasked: 'a***a@example.com' });
  check(failedIndex.includes('could not be loaded') && !failedIndex.includes('undefined'), 'a failed directory renders one honest explanation');
  const detailHtml = renderVehiclePage({ data: detail, emailMasked: 'a***a@example.com' });
  check(detailHtml.includes('KDB 456B') && detailHtml.includes('Documents') && detailHtml.includes('Recent records'), 'the vehicle page renders identity, documents and records');
  check(detailHtml.includes('Road licence') && detailHtml.includes('Insurance') && /expired \d+ d ago/.test(detailHtml), 'expired and upcoming documents both render with their labels');
  check(detailHtml.includes('Fuel') && detailHtml.includes('Trips') && /(KES|Ksh)\s?9,000/.test(detailHtml), 'records and their money render in the owner currency');
  check(detailHtml.includes('href="/d/vehicles"'), 'the vehicle page links back to the fleet list');
  const quietHtml = renderVehiclePage({ data: quietDetail, emailMasked: 'a***a@example.com' });
  check(quietHtml.includes('No documents on file yet') && quietHtml.includes('No records in this vehicle yet'), 'a quiet vehicle renders two warm empty states');
  const hostile = { ...detail, vehicle: { ...detail.vehicle, plate: '<script>alert(1)</script>', displayLabel: undefined, makeModel: '<b>x</b>' } };
  const hostileHtml = renderVehiclePage({ data: hostile, emailMasked: 'a***a@example.com' });
  check(!hostileHtml.includes('<script>alert(1)</script>') && hostileHtml.includes('&lt;script&gt;'), 'plate and model are escaped (no HTML injection)');
  const hostileNick = { ...detail, vehicle: { ...detail.vehicle, displayLabel: '<script>alert(2)</script>', nickname: '<b>nick</b>' } };
  const hostileNickHtml = renderVehiclePage({ data: hostileNick, emailMasked: 'a***a@example.com' });
  check(!hostileNickHtml.includes('<script>alert(2)</script>'), 'a hostile display label is escaped too (v1.89.0)');
  const hostileIndex = renderVehiclesPage({ data: { ...directory, vehicles: [{ ...rowB, plate: '<img src=x onerror=1>' }] }, emailMasked: 'a***a@example.com' });
  check(!hostileIndex.includes('<img src=x') && hostileIndex.includes('&lt;img'), 'the list escapes a hostile plate too');

  // v1.89.0 (Phase 27C) — nicknames are the primary dashboard label.
  const nickIndexHtml = renderVehiclesPage({
    data: { ...directory, vehicles: [{ ...rowB, plate: 'KAS 628T', nickname: 'The Workhorse' }] },
    emailMasked: 'a***a@example.com'
  });
  check(nickIndexHtml.includes('The Workhorse') && nickIndexHtml.includes('KAS 628T'), 'the fleet list shows the nickname with the plate beside it (v1.89.0)');
  const nickDetailHtml = renderVehiclePage({
    data: { ...detail, vehicle: { ...detail.vehicle, plate: 'KAS 628T', nickname: 'The Workhorse', displayLabel: 'The Workhorse (KAS 628T)' } },
    emailMasked: 'a***a@example.com'
  });
  check(nickDetailHtml.includes('The Workhorse (KAS 628T)'), 'the vehicle page heading prefers the display label');
  check(vehicleDisplayLabel({ nickname: 'The Workhorse', plate_number: 'KAS 628T' }) === 'The Workhorse (KAS 628T)'
    && vehicleDisplayLabel({ plate_number: 'KAS 628T' }) === 'KAS 628T'
    && vehicleDisplayLabel({ nickname: 'The Workhorse' }) === 'The Workhorse'
    && vehicleDisplayLabel({}) === 'Fleet vehicle', 'one display label: nickname (plate), honest fallbacks');
  const failedDetail = renderVehiclePage({ data: { ok: false }, emailMasked: 'a***a@example.com' });
  check(failedDetail.includes('could not be loaded') && !failedDetail.includes('undefined'), 'a failed vehicle page renders one honest explanation');
  const overviewHtml = renderOverviewPage({ data: synthetic, emailMasked: 'a***a@example.com' });
  check(overviewHtml.includes('See your vehicles') && overviewHtml.includes('href="/d/vehicles"'), 'the overview links to the vehicle list (one next step)');

  console.log('\n--- Test 21: the vehicle pages end-to-end (Fastify inject) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const routeMock = createMockSupabase({
    ...fleetSeed(),
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({
      id: 'sess-route',
      token_hash: hashToken('route-link'),
      session_token_hash: hashToken('route-session'),
      verified: true,
      session_expires_at: new Date(Date.now() + 86400000).toISOString()
    })],
    admin_audit_logs: [],
    profiles: [
      { id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country_code: 'KE' },
      { id: 'd-1', full_name: 'Brian Otieno', phone_number: '+254799999999' }
    ]
  });
  const routeApp = Fastify({ logger: false });
  await registerDashboardRoutes(routeApp, { supabase: routeMock.client });
  await routeApp.ready();
  const authCookie = { cookie: 'saka_dash=route-session' };

  const vehiclesPage = await routeApp.inject({ method: 'GET', url: '/d/vehicles', headers: authCookie });
  check(vehiclesPage.statusCode === 200 && vehiclesPage.body.includes('Your vehicles'), 'GET /d/vehicles renders the fleet list for a signed-in owner');
  check(vehiclesPage.body.includes('KDB 456B') && vehiclesPage.body.includes('href="/d/vehicles/v-b"'), 'the list carries the plates and their links');
  check(/(KES|Ksh)/.test(vehiclesPage.body), 'the real route resolves the owner currency from the phone (KES)');
  const vehiclesAnon = await routeApp.inject({ method: 'GET', url: '/d/vehicles' });
  check(vehiclesAnon.statusCode === 401 && /Reply \*dashboard\*/.test(vehiclesAnon.body), '/d/vehicles without a cookie 401s with the WhatsApp instruction');
  const ownVehicle = await routeApp.inject({ method: 'GET', url: '/d/vehicles/v-b', headers: authCookie });
  check(ownVehicle.statusCode === 200 && ownVehicle.body.includes('KDB 456B') && ownVehicle.body.includes('Documents'), 'GET /d/vehicles/:id renders the owner vehicle page');
  const foreignVehiclePage = await routeApp.inject({ method: 'GET', url: '/d/vehicles/v-elsewhere', headers: authCookie });
  check(foreignVehiclePage.statusCode === 404 && /not on your fleet/.test(foreignVehiclePage.body), 'a vehicle id outside the owner fleet is a warm 404');
  const anonVehicle = await routeApp.inject({ method: 'GET', url: '/d/vehicles/v-b' });
  check(anonVehicle.statusCode === 401, 'the vehicle page never renders without a session');
  const overviewPage = await routeApp.inject({ method: 'GET', url: '/d', headers: authCookie });
  check(overviewPage.statusCode === 200 && overviewPage.body.includes('See your vehicles') && /(KES|Ksh)/.test(overviewPage.body), 'the overview links to the vehicles page and uses KES');
  await routeApp.close();

  console.log('\n--- Test 22: mock .or() / .range() / .ilike() (D4) ---');
  const opMock = createMockSupabase({
    expense_logs: [
      { id: 'x1', label: 'karen run', notes: null, created_at: '2026-11-01T08:00:00Z' },
      { id: 'x2', label: null, notes: 'KAREN school drop', created_at: '2026-11-02T08:00:00Z' },
      { id: 'x3', label: 'fuel', notes: 'town', created_at: '2026-11-03T08:00:00Z' }
    ]
  });
  const orResult = await opMock.client.from('expense_logs').select('*').or('label.ilike.%karen%,notes.ilike.%karen%').order('created_at', { ascending: false });
  check(orResult.data.length === 2 && orResult.data.map((row) => row.id).join(',') === 'x2,x1', '.or() matches either column, case-insensitively');
  const rangeResult = await opMock.client.from('expense_logs').select('*').order('created_at', { ascending: true }).range(1, 2);
  check(rangeResult.data.length === 2 && rangeResult.data[0].id === 'x2' && rangeResult.data[1].id === 'x3', '.range(1, 2) is an inclusive offset window');
  const ilikeResult = await opMock.client.from('expense_logs').select('*').ilike('label', '%REN%');
  check(ilikeResult.data.length === 1 && ilikeResult.data[0].id === 'x1', '.ilike() is a case-insensitive contains match');
  const andOrResult = await opMock.client.from('expense_logs').select('*').eq('id', 'x2').or('label.ilike.%karen%,notes.ilike.%karen%');
  check(andOrResult.data.length === 1, '.or() composes with AND filters');

  console.log('\n--- Test 23: parseRecordsFilters (validation + defaults) ---');
  const filterIds = ['v-a', 'v-b'];
  const recordsNow = new Date('2026-11-08T06:00:00Z'); // Nairobi 09:00 → 2026-11-08
  const defaults = parseRecordsFilters({}, { vehicleIds: filterIds, now: recordsNow });
  check(defaults.ok && defaults.filters.to === '2026-11-08' && defaults.filters.from === '2026-10-10', 'default window is the last 30 Nairobi days (inclusive)');
  check(defaults.filters.types.length === 0 && defaults.filters.vehicleId === null && defaults.filters.page === 0 && defaults.filters.pageSize === RECORDS_PAGE_SIZE,
    'defaults: all types, all vehicles, page 0, 20 per page');
  const full = parseRecordsFilters({ from: '2026-09-01', to: '2026-09-30', type: 'Fuel,Repairs', vehicle: 'v-b', label: 'karen', keyword: 'shell', page: '3' }, { vehicleIds: filterIds, now: recordsNow });
  check(full.ok && full.filters.from === '2026-09-01' && full.filters.to === '2026-09-30', 'an explicit date range is accepted');
  check(full.filters.types.join(',') === 'Fuel,Repairs' && full.filters.vehicleId === 'v-b', 'type (comma list) and vehicle filters are parsed');
  check(full.filters.label === 'karen' && full.filters.keyword === 'shell' && full.filters.page === 3, 'label, keyword and page are parsed');
  check(parseRecordsFilters({ from: 'not-a-date' }, { vehicleIds: filterIds }).reason === 'bad_from', 'a malformed start date is refused');
  check(parseRecordsFilters({ to: '2026-13-45' }, { vehicleIds: filterIds }).reason === 'bad_to', 'an impossible end date is refused');
  check(parseRecordsFilters({ from: '2026-11-02', to: '2026-11-01' }, { vehicleIds: filterIds }).reason === 'bad_range', 'a reversed range is refused');
  check(parseRecordsFilters({ from: '2024-01-01', to: '2026-11-01' }, { vehicleIds: filterIds }).reason === 'range_too_wide', `a range wider than ${RECORDS_MAX_RANGE_DAYS} days is refused`);
  check(parseRecordsFilters({ vehicle: 'v-other' }, { vehicleIds: filterIds }).reason === 'unknown_vehicle', "another owner's vehicle id is refused");
  check(parseRecordsFilters({ label: 'x'.repeat(41) }, { vehicleIds: filterIds }).reason === 'label_too_long', 'labels over 40 characters are refused');
  check(parseRecordsFilters({ keyword: 'x'.repeat(41) }, { vehicleIds: filterIds }).reason === 'keyword_too_long', 'search terms over 40 characters are refused');
  check(parseRecordsFilters({ page: '999' }, { vehicleIds: filterIds }).reason === 'page_too_far', 'a page beyond the cap is refused');
  check(parseRecordsFilters({ type: Array.from({ length: 13 }, (_, i) => `T${i}`).join(',') }, { vehicleIds: filterIds }).reason === 'too_many_types', 'more than 12 types is refused');
  const hostileFilters = parseRecordsFilters({ label: '%karen%,notes.ilike.boom', keyword: 'a%%,(b)' }, { vehicleIds: filterIds });
  check(hostileFilters.ok && !hostileFilters.filters.label.includes('%') && !hostileFilters.filters.label.includes(',') && !hostileFilters.filters.keyword.includes('%'),
    'wildcard/operator characters are stripped from search terms');
  check(cleanRecordsTerm('  karen   run  ') === 'karen run', 'search terms are whitespace-normalised');
  check(nairobiDateOf('2026-11-08T21:30:00Z') === '2026-11-09', 'the Nairobi calendar day (not UTC) decides the date (rule 36)');

  console.log('\n--- Test 24: queryOwnerRecords — owner-vehicle scope (FIX-1) ---');
  const recDay = (d, hour = 9) => new Date(`2026-11-${String(d).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+03:00`).toISOString();
  const recordsSeed = () => ({
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', make_model: 'Nissan Note', status: 'ACTIVE' },
      // v1.88.0 — v-b is ASSIGNED to a driver ('d-1') so the scope proof covers
      // the assigned-vehicle case too: assignment is a separate FK and must
      // never remove the owner's visibility of the vehicle's records.
      { id: 'v-b', owner_id: PROFILE.id, plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE', assigned_driver_id: 'd-1' },
      { id: 'v-x', owner_id: 'someone-else', plate_number: 'KDX 999X', status: 'ACTIVE' }
    ],
    expense_logs: [
      { id: 'e1', vehicle_id: 'v-a', driver_id: PROFILE.id, expense_type: 'Fuel', amount: 5000, fuel_liters: 40, odometer_reading: 100500, notes: 'Shell Karen', label: 'karen run', created_at: recDay(7) },
      { id: 'e2', vehicle_id: 'v-b', driver_id: 'd-1', expense_type: 'Repairs', amount: 3000, notes: 'Brake pads', created_at: recDay(6) },
      { id: 'e3', vehicle_id: 'v-a', driver_id: PROFILE.id, expense_type: 'Fuel', amount: 4500, notes: 'town', created_at: recDay(1) },
      { id: 'e4', vehicle_id: 'v-x', driver_id: 'stranger', expense_type: 'Fuel', amount: 9999, notes: 'not mine', created_at: recDay(7) }
    ],
    private_earnings: [
      { id: 'n1', vehicle_id: 'v-a', driver_id: PROFILE.id, revenue_amount: 12000, earning_type: 'Trips', notes: 'Uber week', logged_at: recDay(8, 8) }
    ]
  });
  const recMock = createMockSupabase(recordsSeed());
  const ownerVehicles = await loadOwnerVehicles(recMock.client, PROFILE.id);
  check(ownerVehicles.length === 2 && !ownerVehicles.some((v) => v.id === 'v-x'), "loadOwnerVehicles returns only the owner's live vehicles");
  const recCtx = { supabase: recMock.client, ownerId: PROFILE.id, vehicleIds: ownerVehicles.map((v) => v.id), vehicles: ownerVehicles, countryInfo: KE_INFO, filters: { from: '2026-10-10', to: '2026-11-08' } };
  const allRecords = await queryOwnerRecords(recCtx);
  check(allRecords.ok && allRecords.total === 4, 'the owner record set merges expenses + earnings (4 rows, other owners excluded)');
  check(allRecords.rows.map((r) => r.id).join(',') === 'n1,e1,e2,e3', 'rows are newest-first across both tables');
  check(allRecords.rows.some((r) => r.id === 'e2' && r.raw.driver_id === 'd-1'), 'FIX-1: a driver-logged row is visible to the owner (vehicle scope, not driver_id scope)');
  // v1.88.0 (Phase 27) — the ASSIGNED case: v-b carries assigned_driver_id='d-1'
  // and e2 was logged by that driver. Assignment is a separate FK, so the
  // owner-scoped query (vehicle_id IN owner's vehicles) must keep returning it.
  check(ownerVehicles.find((v) => v.id === 'v-b')?.assigned_driver_id === 'd-1', 'the owner vehicle list carries the live assignment FK');
  check(allRecords.rows.find((r) => r.id === 'e2')?.vehicle === 'KDB 456B', 'a record on an ASSIGNED vehicle still maps its plate for the owner');
  const assignedOnly = await queryOwnerRecords({ ...recCtx, filters: { from: '2026-10-10', to: '2026-11-08', vehicleId: 'v-b' } });
  check(assignedOnly.ok && assignedOnly.rows.length === 1 && assignedOnly.rows[0].id === 'e2' && assignedOnly.rows[0].raw.driver_id === 'd-1', 'the owner can filter an assigned vehicle and sees the driver-logged row (v1.88.0)');
  check(allRecords.rows.find((r) => r.id === 'e1')?.vehicle === 'KDA 123A', 'the plate is mapped from the owner vehicle list');
  check(!allRecords.rows.some((r) => r.id === 'e4'), "another owner's vehicle never contributes a row");
  const fuelOnly = await queryOwnerRecords({ ...recCtx, filters: { from: '2026-10-10', to: '2026-11-08', types: ['Fuel'] } });
  check(fuelOnly.ok && fuelOnly.rows.length === 2 && fuelOnly.rows.every((r) => r.raw.expense_type === 'Fuel'), 'a type filter keeps matching expenses and drops earnings');
  const vanOnly = await queryOwnerRecords({ ...recCtx, filters: { from: '2026-10-10', to: '2026-11-08', vehicleId: 'v-b' } });
  check(vanOnly.rows.length === 1 && vanOnly.rows[0].id === 'e2', 'the vehicle filter narrows to one vehicle');
  const keywordHit = await queryOwnerRecords({ ...recCtx, filters: { from: '2026-10-10', to: '2026-11-08', keyword: 'karen' } });
  check(keywordHit.rows.length === 1 && keywordHit.rows[0].id === 'e1', 'keyword search matches label/notes case-insensitively');
  const labelHit = await queryOwnerRecords({ ...recCtx, filters: { from: '2026-10-10', to: '2026-11-08', label: 'karen' } });
  check(labelHit.rows.length === 1 && labelHit.rows[0].id === 'e1', 'the label filter matches only the label column');
  const oneDay = await queryOwnerRecords({ ...recCtx, filters: { from: '2026-11-06', to: '2026-11-06' } });
  check(oneDay.rows.length === 1 && oneDay.rows[0].id === 'e2', 'the date range uses inclusive Nairobi calendar days');

  const pagedSeed = () => ({
    vehicles: [{ id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', status: 'ACTIVE' }],
    expense_logs: Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      vehicle_id: 'v-a',
      driver_id: PROFILE.id,
      expense_type: 'Fuel',
      amount: 1000 + i,
      created_at: new Date(Date.UTC(2026, 10, 5, 0, i, 0)).toISOString()
    })),
    private_earnings: []
  });
  const pagedMock = createMockSupabase(pagedSeed());
  const pagedCtx = {
    supabase: pagedMock.client,
    ownerId: PROFILE.id,
    vehicleIds: ['v-a'],
    vehicles: [{ id: 'v-a', plate_number: 'KDA 123A' }],
    countryInfo: KE_INFO,
    filters: { from: '2026-10-10', to: '2026-11-08', page: 0 }
  };
  const recordsPage0 = await queryOwnerRecords(pagedCtx);
  check(recordsPage0.rows.length === RECORDS_PAGE_SIZE && recordsPage0.hasMore === true && recordsPage0.total === 25, 'page 0 returns 20 rows, hasMore, and the exact total');
  const recordsPage1 = await queryOwnerRecords({ ...pagedCtx, filters: { ...pagedCtx.filters, page: 1 } });
  check(recordsPage1.rows.length === 5 && recordsPage1.hasMore === false, 'the last page returns the remaining 5 rows and stops');
  const recordsPage9 = await queryOwnerRecords({ ...pagedCtx, filters: { ...pagedCtx.filters, page: 9 } });
  check(recordsPage9.rows.length === 0 && recordsPage9.hasMore === false, 'a page beyond the end is empty, never an error');
  const exportAll = await queryOwnerRecords({ ...pagedCtx, pageSize: RECORDS_EXPORT_MAX_ROWS, offset: 0 });
  check(exportAll.rows.length === 25 && exportAll.truncated === false, 'an export fetches the whole filtered set (no page cap)');
  const noVehicles = await queryOwnerRecords({ ...pagedCtx, vehicleIds: [] });
  check(noVehicles.ok === true && noVehicles.rows.length === 0, 'an owner with no vehicles gets an honest empty set');

  console.log('\n--- Test 25: receipt matching (D2) + signed URLs (D1) ---');
  const receiptsSeed = {
    receipts: [
      { id: 'r1', media_id: 'm1', vehicle_id: 'v-a', owner_id: PROFILE.id, amount: 5000, image_url: 'https://x.supabase.co/storage/v1/object/public/receipts/m1.jpg', created_at: recDay(7, 10) },
      { id: 'r2', media_id: 'm2', vehicle_id: 'v-b', owner_id: PROFILE.id, amount: 3000, image_url: null, created_at: recDay(6, 10) },
      { id: 'r3', media_id: 'm3', vehicle_id: 'v-b', owner_id: PROFILE.id, amount: 3000, image_url: null, created_at: recDay(6, 11) },
      { id: 'r-nofile', media_id: null, vehicle_id: 'v-a', owner_id: PROFILE.id, amount: 777, image_url: null, created_at: recDay(2, 10) },
      { id: 'r-foreign', media_id: 'm4', vehicle_id: 'v-x', owner_id: 'someone-else', amount: 5000, image_url: null, created_at: recDay(7, 10) }
    ]
  };
  const matchMock = createMockSupabase({ ...recordsSeed(), ...receiptsSeed });
  const uniqueMatch = await matchReceiptForExpense({ supabase: matchMock.client, vehicleId: 'v-a', amount: 5000, day: '2026-11-07' });
  check(uniqueMatch.status === 'unique' && uniqueMatch.receipt?.id === 'r1', 'exactly one same-day same-amount receipt links the row');
  const ambiguousMatch = await matchReceiptForExpense({ supabase: matchMock.client, vehicleId: 'v-b', amount: 3000, day: '2026-11-06' });
  check(ambiguousMatch.status === 'ambiguous' && ambiguousMatch.receipt === null && ambiguousMatch.count === 2, 'two candidates are ambiguous — never a guess');
  const noMatch = await matchReceiptForExpense({ supabase: matchMock.client, vehicleId: 'v-a', amount: 4500, day: '2026-11-01' });
  check(noMatch.status === 'none' && noMatch.receipt === null, 'no candidate means no link');
  const dayMiss = await matchReceiptForExpense({ supabase: matchMock.client, vehicleId: 'v-a', amount: 5000, day: '2026-11-06' });
  check(dayMiss.status === 'none', 'the same amount on another day never matches');
  const matchCache = new Map();
  await matchReceiptForExpense({ supabase: matchMock.client, vehicleId: 'v-a', amount: 5000, day: '2026-11-07', cache: matchCache });
  await matchReceiptForExpense({ supabase: matchMock.client, vehicleId: 'v-a', amount: 5000, day: '2026-11-07', cache: matchCache });
  check(matchCache.size === 1, 'the page cache dedupes receipt lookups');
  const attached = await attachReceiptMatches({ supabase: matchMock.client, rows: allRecords.rows });
  const attachedById = Object.fromEntries(attached.map((row) => [row.id, row]));
  check(attachedById.e1.receiptStatus === 'unique' && attachedById.e1.receiptId === 'r1', 'the page attaches a View link only for a unique match');
  check(attachedById.e2.receiptStatus === 'ambiguous' && attachedById.e2.receiptId === null, 'an ambiguous row carries no receipt id');
  check(attachedById.e3.receiptStatus === 'none' && attachedById.n1.receiptStatus === 'none', 'no match and earnings never carry a receipt link');

  // v1.81.0 (Phase 20, PROP-2026-11-08-01) — the durable link wins when present;
  // legacy rows still fall back to the unique heuristic (D1).
  const linkedSeed = {
    ...recordsSeed(),
    receipts: [
      ...receiptsSeed.receipts,
      { id: 'r4', media_id: 'm4b', vehicle_id: 'v-a', owner_id: PROFILE.id, amount: 4500, image_url: null, created_at: recDay(7, 11) }
    ],
    expense_logs: [
      { id: 'e-linked', vehicle_id: 'v-a', driver_id: PROFILE.id, expense_type: 'Fuel', amount: 5000, receipt_id: 'r1', notes: 'durable', created_at: recDay(7) },
      { id: 'e-legacy', vehicle_id: 'v-a', driver_id: PROFILE.id, expense_type: 'Fuel', amount: 4500, notes: 'heuristic', created_at: recDay(7) }
    ]
  };
  const linkedMock = createMockSupabase(linkedSeed);
  const linkedRecords = await queryOwnerRecords({
    supabase: linkedMock.client,
    ownerId: PROFILE.id,
    vehicleIds: ['v-a'],
    vehicles: ownerVehicles,
    countryInfo: KE_INFO,
    filters: { from: '2026-11-01', to: '2026-11-08' }
  });
  const linkedAttached = await attachReceiptMatches({ supabase: linkedMock.client, rows: linkedRecords.rows });
  const linkedRow = linkedAttached.find((row) => row.id === 'e-linked');
  const legacyRow = linkedAttached.find((row) => row.id === 'e-legacy');
  check(linkedRow?.receiptStatus === 'linked' && linkedRow?.receiptId === 'r1', 'a row with expense_logs.receipt_id links exactly (never a guess)');
  check(legacyRow?.receiptStatus === 'unique' && legacyRow?.receiptId === 'r4', 'a legacy row without the FK keeps the unique-match fallback (D1)');
  const oneLinkedMock = createMockSupabase(linkedSeed);
  const oneLinked = await attachReceiptMatches({ supabase: oneLinkedMock.client, rows: [linkedRow] });
  check(oneLinked[0].receiptStatus === 'linked' && oneLinkedMock.state.calls === 1, 'a linked page costs ONE receipts query (the heuristic never runs)');

  const signedCalls = [];
  const signClient = {
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (path, ttl) => {
          signedCalls.push({ bucket, path, ttl });
          return { data: { signedUrl: `https://storage.test/${bucket}/${path}?token=t` }, error: null };
        }
      })
    }
  };
  const signed = await signReceiptUrl(signClient, { id: 'r1', media_id: 'm1', image_url: 'https://x.supabase.co/storage/v1/object/public/receipts/m1.jpg' });
  check(signed.ok && signed.url.includes('token=t') && signed.ttlSeconds === RECEIPT_SIGNED_URL_TTL_SECONDS, 'the signed URL is minted with a 300-second TTL');
  check(signedCalls[0].ttl === 300 && signedCalls[0].path === 'm1.jpg' && signedCalls[0].bucket === 'receipts', 'the object path comes from the media id (survives a private bucket)');
  const noImage = await signReceiptUrl(signClient, { id: 'r-nofile', media_id: null, image_url: null });
  check(noImage.ok === false && noImage.reason === 'no_image', 'a receipt with no stored image never yields a URL');
  const noStorage = await signReceiptUrl({}, { media_id: 'm1' });
  check(noStorage.ok === false && noStorage.reason === 'no_storage', 'a client without storage degrades honestly');
  const signError = await signReceiptUrl({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: 'Bucket not found' } }) }) } }, { media_id: 'm1' });
  check(signError.ok === false && signError.reason === 'sign_failed', 'a missing bucket / failed sign degrades to an honest 404 (the live state on 2026-11-08)');

  console.log('\n--- Test 26: serializeRecordsCsv ---');
  const csvRows = [
    { at: '2026-11-07T06:00:00Z', kind: 'expense', vehicle: 'KDA 123A', typeLabel: 'Fuel', description: 'Fuel - 40 L - Shell, "Karen"', odometer: 100500, unitCost: 125.5, amount: 5000, label: 'karen run' },
    { at: '2026-11-08T05:00:00.000Z', kind: 'earning', vehicle: 'KDA 123A', typeLabel: 'Trips', description: 'Trips', odometer: null, unitCost: null, amount: 12000, label: null }
  ];
  const csv = serializeRecordsCsv(csvRows, { currency: 'KES' });
  const csvLines = csv.split('\r\n').filter(Boolean);
  check(csv.charCodeAt(0) === 0xFEFF, 'the CSV starts with a UTF-8 BOM (Excel-safe)');
  check(csvLines[0].replace(/^\uFEFF/, '') === RECORDS_CSV_COLUMNS.join(','), 'the header row is the documented column set');
  check(csvLines.length === 3, 'one header + one line per record');
  check(csvLines[1].includes('"Fuel - 40 L - Shell, ""Karen"""'), 'commas and quotes are escaped (RFC 4180)');
  check(csvLines[1].includes('2026-11-07T06:00:00.000Z') && csvLines[1].includes(',125.50,5000,KES,karen run'), 'dates are ISO-8601 and money keeps the owner currency');
  check(csvLines[2].includes(',earning,'), 'earnings carry their kind');

  console.log('\n--- Test 27: buildRecordsPdf (Buffer, no Storage) ---');
  const pdfBuffer = await buildRecordsPdf(attached, { from: '2026-10-10', to: '2026-11-08' }, { profile: PROFILE, countryInfo: KE_INFO, vehicles: ownerVehicles });
  check(Buffer.isBuffer(pdfBuffer) && pdfBuffer.subarray(0, 5).toString() === '%PDF-', 'the records PDF is a real PDF buffer (no Storage, no email)');
  check(pdfBuffer.length > 1500, `the PDF has real content (${pdfBuffer.length} bytes)`);
  const readablePdf = await buildRecordsPdf(attached, { from: '2026-10-10', to: '2026-11-08' }, { profile: PROFILE, countryInfo: KE_INFO, vehicles: ownerVehicles, useStandardFonts: true });
  const pdfText = extractPdfText(readablePdf).text || '';
  check(/Records & Ledger/.test(pdfText) && /TOTAL SPEND/.test(pdfText), 'the PDF carries the title and the KPI labels');
  check(/(Ksh|KES)/.test(pdfText), 'the PDF money is in the owner currency');
  check(pdfText.includes('KDA 123A'), 'the filtered rows appear in the ledger');
  const truncatedPdf = await buildRecordsPdf(attached, { from: '2026-10-10', to: '2026-11-08' }, { profile: PROFILE, countryInfo: KE_INFO, vehicles: ownerVehicles, truncated: true, useStandardFonts: true });
  check(/narrow the dates/.test(extractPdfText(truncatedPdf).text || ''), 'a capped export says so in the PDF footnote');

  console.log('\n--- Test 28: renderRecordsPage + query string ---');
  const renderFilters = parseRecordsFilters(
    { from: '2026-10-10', to: '2026-11-08', type: 'Fuel', vehicle: 'v-a', label: 'karen', keyword: 'shell', page: '1' },
    { vehicleIds: ['v-a', 'v-b'] }
  ).filters;
  const pageData = { ok: true, rows: attached, total: 4, hasMore: true, page: 1, pageSize: 20, currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' };
  const recordsHtml = renderRecordsPage({ data: pageData, filters: renderFilters, vehicles: ownerVehicles, emailMasked: 'a***a@example.com' });
  check(recordsHtml.includes('Records') && recordsHtml.includes('action="/d/records"'), 'the records page renders its filter form');
  check(recordsHtml.includes('value="Fuel" selected'), 'the type filter is pre-selected from the URL');
  check(recordsHtml.includes('value="v-a" selected'), 'the vehicle filter is pre-selected from the URL');
  check(recordsHtml.includes('KDA 123A') && recordsHtml.includes('Brake pads'), 'the rows render with plate and description');
  check(recordsHtml.includes('href="/d/receipt/r1"'), 'a unique match renders a receipt link');
  check(recordsHtml.includes('Multiple match') && recordsHtml.includes('—'), 'ambiguous and empty matches render honestly');
  check(recordsHtml.includes('← Newer') && recordsHtml.includes('Older →'), 'pagination offers both directions when both exist');
  check(recordsHtml.includes('/d/records.csv?') && recordsHtml.includes('/d/records.pdf?'), 'the page links both exports');
  // v1.93.0 (Phase 30, Task 1) — both PDF layouts are offered on the page.
  check(recordsHtml.includes('variant=mobile') && recordsHtml.includes('PDF (phone)') && recordsHtml.includes('variant=a4') && recordsHtml.includes('PDF (A4)'), 'the page offers the phone (A5) and A4 PDF links (v1.93.0)');
  const exportQuery = recordsQueryString(renderFilters, { page: 0 });
  check(exportQuery.includes('type=Fuel') && exportQuery.includes('vehicle=v-a') && !exportQuery.includes('page='), 'export links carry the filter and never a page');
  const emptyRecordsHtml = renderRecordsPage({ data: { ...pageData, rows: [], total: 0, hasMore: false, page: 0 }, filters: defaults.filters, vehicles: ownerVehicles, emailMasked: 'a***a@example.com' });
  check(emptyRecordsHtml.includes('Nothing in these filters') && !emptyRecordsHtml.includes('undefined'), 'an empty filter renders a warm next step');
  const erroredRecordsHtml = renderRecordsPage({ data: { ...pageData, rows: [], total: 0, hasMore: false, page: 0 }, filters: defaults.filters, vehicles: ownerVehicles, error: 'That start date does not look right — use YYYY-MM-DD.' });
  check(erroredRecordsHtml.includes('does not look right'), 'a rejected filter renders its explanation above the form');
  const xssRecordsHtml = renderRecordsPage({ data: { ...pageData, rows: [{ ...attached[1], description: '<script>alert(1)</script>' }] }, filters: defaults.filters, vehicles: ownerVehicles });
  check(!xssRecordsHtml.includes('<script>alert(1)</script>') && xssRecordsHtml.includes('&lt;script&gt;'), 'row text is escaped');
  const failedRecordsHtml = renderRecordsPage({ data: { ok: false }, filters: defaults.filters });
  check(failedRecordsHtml.includes('could not be loaded') && !failedRecordsHtml.includes('undefined'), 'a failed query renders one honest explanation');
  const redirectPage = renderReceiptPage({ signedUrl: 'https://storage.test/x?token=t' });
  check(redirectPage.status === 302 && redirectPage.location === 'https://storage.test/x?token=t', 'the receipt renderer answers a 302 to the signed URL');
  check(renderReceiptPage({}).status === 404, 'no URL means a 404, never a broken redirect');

  // v1.81.0 (Phase 20) — the linked row renders View; the nav offers Import;
  // the import page renders the engine copy for invalid rows.
  const linkedHtml = renderRecordsPage({
    data: { ok: true, total: 1, rows: [linkedRow], hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE },
    filters: defaults.filters
  });
  check(linkedHtml.includes('href="/d/receipt/r1"'), 'the records table renders View for a linked receipt');
  // v1.96.5 — the exact live page (+254734852529 / KAS628T): a fuel row with NO
  // linked receipt renders the honest "—" (the operator's screenshot), while the
  // durable link renders View. The UI is never the bug — the missing row was.
  const unlinkedRow = { ...linkedRow, id: 'e-unlinked', receiptStatus: 'none', receiptId: null };
  const unlinkedHtml = renderRecordsPage({
    data: { ok: true, total: 1, rows: [unlinkedRow], hasMore: false, page: 0, pageSize: RECORDS_PAGE_SIZE },
    filters: defaults.filters
  });
  check(unlinkedHtml.includes('<span class="muted">—</span>') && !unlinkedHtml.includes('/d/receipt/e-unlinked'), 'an unlinked row renders "—" with no View link (v1.96.5)');
  check(linkedHtml.includes('<a href="/d/receipt/r1">View</a>'), 'a linked row renders the View link (v1.96.5)');
  check(linkedHtml.includes('href="/d/import"'), 'the nav offers Import on every signed-in page');
  const importHtml = renderImportPage({ emailMasked: 'a***@x.com', currency: 'KES', locale: 'en-KE' });
  check(importHtml.includes('action="/d/import"') && importHtml.includes('type="file"') && importHtml.includes('FileReader'), 'the import page carries a file picker with the FileReader path');
  check(importHtml.includes('Date, Vehicle Plate, Type, Amount, Odometer, Notes'), 'the page states the exact CSV columns');
  const importPreviewHtml = renderImportPage({
    preview: {
      counts: { total: 2, valid: 1, invalid: 1 },
      rows: [
        { line: 2, dateKey: '2026-11-01', plate: 'KDA 123A', expenseType: 'Fuel', amount: 5000, odometer: 100500, notes: 'Shell', errors: [] },
        { line: 3, dateKey: null, plate: 'KDX 999X', expenseType: null, amount: null, odometer: null, notes: null, errors: ['unknown_plate'] }
      ]
    },
    csvText: 'raw,csv',
    emailMasked: 'a***@x.com',
    currency: 'KES',
    locale: 'en-KE'
  });
  check(importPreviewHtml.includes('class="row-error"') && importPreviewHtml.includes('not in your fleet'), 'invalid rows are highlighted with warm engine copy');
  check(importPreviewHtml.includes('Import 1 expense'), 'the confirm button names the exact valid count');
  check(importPreviewHtml.includes('name="action" value="confirm"'), 'the confirm form carries its action marker');
  check(importPreviewHtml.includes('name="csv" hidden'), 'the confirm re-posts the exact text for server-side re-validation');

  console.log('\n--- Test 29: records routes end-to-end (Fastify inject) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const recRouteMock = createMockSupabase({
    ...recordsSeed(),
    ...receiptsSeed,
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({
      id: 'sess-rec',
      token_hash: hashToken('rec-link'),
      session_token_hash: hashToken('rec-session'),
      verified: true,
      session_expires_at: new Date(Date.now() + 86400000).toISOString()
    })],
    admin_audit_logs: [],
    error_logs: [],
    profiles: [{ id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country_code: 'KE' }]
  });
  const recSigned = [];
  recRouteMock.client.storage = {
    from: () => ({
      createSignedUrl: async (path, ttl) => {
        recSigned.push({ path, ttl });
        return { data: { signedUrl: `https://storage.test/receipts/${path}?token=t` }, error: null };
      }
    })
  };
  const recApp = Fastify({ logger: false });
  await registerDashboardRoutes(recApp, { supabase: recRouteMock.client });
  await recApp.ready();
  const recCookie = { cookie: 'saka_dash=rec-session' };

  const recordsRes = await recApp.inject({ method: 'GET', url: '/d/records?from=2026-10-10&to=2026-11-08', headers: recCookie });
  check(recordsRes.statusCode === 200 && recordsRes.body.includes('Records'), 'GET /d/records renders the table for a signed-in owner');
  check(recordsRes.body.includes('KDA 123A') && recordsRes.body.includes('Brake pads'), 'the table carries owner rows, including a driver-logged one');
  check(recordsRes.body.includes('href="/d/receipt/r1"') && recordsRes.body.includes('Multiple match'), 'receipt links honour uniqueness on the page');
  const fuelRes = await recApp.inject({ method: 'GET', url: '/d/records?from=2026-10-10&to=2026-11-08&type=Fuel', headers: recCookie });
  check(fuelRes.statusCode === 200 && !fuelRes.body.includes('Brake pads'), 'the type filter is applied by the route');
  const badFilterRes = await recApp.inject({ method: 'GET', url: '/d/records?from=nope', headers: recCookie });
  check(badFilterRes.statusCode === 200 && /does not look right/.test(badFilterRes.body), 'an invalid filter renders the explanation instead of failing');
  const anonRecords = await recApp.inject({ method: 'GET', url: '/d/records' });
  check(anonRecords.statusCode === 401, 'records never render without a session');

  const csvRes = await recApp.inject({ method: 'GET', url: '/d/records.csv?from=2026-10-10&to=2026-11-08', headers: recCookie });
  check(csvRes.statusCode === 200 && /text\/csv/.test(String(csvRes.headers['content-type'])), 'GET /d/records.csv answers text/csv');
  check(/attachment; filename="saka-records-2026-10-10-to-2026-11-08.csv"/.test(String(csvRes.headers['content-disposition'])), 'the CSV carries a dated download filename');
  check(csvRes.body.charCodeAt(0) === 0xFEFF && csvRes.body.includes('KDA 123A') && csvRes.body.includes('Brake pads'), 'the CSV holds the filtered rows');
  const csvFuel = await recApp.inject({ method: 'GET', url: '/d/records.csv?from=2026-10-10&to=2026-11-08&type=Fuel', headers: recCookie });
  check(!csvFuel.body.includes('Brake pads'), 'CSV export obeys the same filter (no bypass)');
  const csvBad = await recApp.inject({ method: 'GET', url: '/d/records.csv?from=nope', headers: recCookie });
  check(csvBad.statusCode === 400, 'an invalid filter refuses the export with a 400');

  const pdfRes = await recApp.inject({ method: 'GET', url: '/d/records.pdf?from=2026-10-10&to=2026-11-08', headers: recCookie });
  check(pdfRes.statusCode === 200 && String(pdfRes.headers['content-type']).includes('application/pdf'), 'GET /d/records.pdf answers application/pdf');
  check(pdfRes.rawPayload.subarray(0, 5).toString() === '%PDF-', 'the PDF export streams a real PDF (no Storage upload)');
  check(/attachment; filename="saka-records-2026-10-10-to-2026-11-08.pdf"/.test(String(pdfRes.headers['content-disposition'])), 'the PDF carries a dated download filename');
  // v1.93.0 (Phase 30, Task 1) — the phone variant and the UA default.
  const mobilePdf = await recApp.inject({ method: 'GET', url: '/d/records.pdf?from=2026-10-10&to=2026-11-08&variant=mobile', headers: recCookie });
  check(mobilePdf.statusCode === 200 && mobilePdf.rawPayload.subarray(0, 5).toString() === '%PDF-', 'GET /d/records.pdf?variant=mobile streams a real PDF (v1.93.0)');
  check(/\b419(\.0+)?\s+595(\.0+)?\b/.test(mobilePdf.rawPayload.toString('latin1')), 'the phone variant page is A5 (419 x 595)');
  check(/\b595(\.\d+)?\s+841(\.\d+)?\b/.test(pdfRes.rawPayload.toString('latin1')), 'the default records export stays A4');
  const uaMobilePdf = await recApp.inject({
    method: 'GET',
    url: '/d/records.pdf?from=2026-10-10&to=2026-11-08',
    headers: { ...recCookie, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' }
  });
  check(/\b419(\.0+)?\s+595(\.0+)?\b/.test(uaMobilePdf.rawPayload.toString('latin1')), 'an iPhone User-Agent defaults to the phone layout (v1.93.0)');
  const uaDesktopPdf = await recApp.inject({
    method: 'GET',
    url: '/d/records.pdf?from=2026-10-10&to=2026-11-08',
    headers: { ...recCookie, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  check(/\b595(\.\d+)?\s+841(\.\d+)?\b/.test(uaDesktopPdf.rawPayload.toString('latin1')), 'a desktop User-Agent keeps the A4 layout');
  const explicitA4 = await recApp.inject({
    method: 'GET',
    url: '/d/records.pdf?from=2026-10-10&to=2026-11-08&variant=a4',
    headers: { ...recCookie, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' }
  });
  check(/\b595(\.\d+)?\s+841(\.\d+)?\b/.test(explicitA4.rawPayload.toString('latin1')), 'an explicit ?variant=a4 beats the mobile User-Agent');
  const pdfFuel = await recApp.inject({ method: 'GET', url: '/d/records.pdf?from=2026-10-10&to=2026-11-08&type=Fuel', headers: recCookie });
  check(pdfFuel.statusCode === 200 && pdfFuel.rawPayload.subarray(0, 5).toString() === '%PDF-', 'the PDF route accepts the same filter spec');
  const pdfBad = await recApp.inject({ method: 'GET', url: '/d/records.pdf?from=nope', headers: recCookie });
  check(pdfBad.statusCode === 400, 'an invalid filter refuses the PDF export with a 400 (same filter engine)');

  const ownReceipt = await recApp.inject({ method: 'GET', url: '/d/receipt/r1', headers: recCookie });
  check(ownReceipt.statusCode === 302 && /token=t/.test(String(ownReceipt.headers.location)), 'the owner receipt redirects to a signed URL');
  check(recSigned.at(-1)?.ttl === 300 && recSigned.at(-1)?.path === 'm1.jpg', 'the signed URL is minted per request with a 300-second TTL');
  const foreignReceipt = await recApp.inject({ method: 'GET', url: '/d/receipt/r-foreign', headers: recCookie });
  check(foreignReceipt.statusCode === 404 && !/r-foreign/.test(foreignReceipt.body), "another owner's receipt answers 404 (never confirms existence)");
  const noImageReceipt = await recApp.inject({ method: 'GET', url: '/d/receipt/r-nofile', headers: recCookie });
  check(noImageReceipt.statusCode === 404, 'a receipt with no stored image answers 404');
  const unknownReceipt = await recApp.inject({ method: 'GET', url: '/d/receipt/nope', headers: recCookie });
  check(unknownReceipt.statusCode === 404, 'an unknown receipt id answers 404');
  const anonReceipt = await recApp.inject({ method: 'GET', url: '/d/receipt/r1' });
  check(anonReceipt.statusCode === 401, 'the receipt route never signs without a session');
  const signedBefore = recSigned.length;
  await recApp.inject({ method: 'GET', url: '/d/receipt/r-foreign', headers: recCookie });
  check(recSigned.length === signedBefore, 'no signed URL is ever minted for a foreign receipt');
  await recApp.close();

  console.log('\n--- Test 30: failed export can never masquerade as an empty file (rule 51 iii) ---');
  const brokenClient = {
    from: (table) => {
      if (table === 'expense_logs') throw new Error('boom: records query exploded');
      return recRouteMock.client.from(table);
    }
  };
  const brokenApp = Fastify({ logger: false });
  await registerDashboardRoutes(brokenApp, { supabase: brokenClient });
  await brokenApp.ready();
  const brokenCsv = await brokenApp.inject({ method: 'GET', url: '/d/records.csv', headers: recCookie });
  check(brokenCsv.statusCode === 500 && /could not be built/.test(brokenCsv.body), 'a failed query refuses the export instead of writing an empty file');
  const loggedCsvError = recRouteMock.db.error_logs.find((row) => row.route === '/d/records/csv');
  check(Boolean(loggedCsvError) && /records query failed/.test(String(loggedCsvError?.error_message || '')), 'the failure is logged under the CSV route');
  check(!/karen run|Brake pads|5000/.test(String(loggedCsvError?.error_message || '')), 'the error log carries no label, note or amount (rule 51 iii)');
  const brokenPdf = await brokenApp.inject({ method: 'GET', url: '/d/records.pdf', headers: recCookie });
  check(brokenPdf.statusCode === 500, 'a failed query refuses the PDF export too');
  await brokenApp.close();

  console.log('\n--- Test 30b: CSV import two-phase flow (Fastify inject, v1.81.0) ---');
  const impMock = createMockSupabase({
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', make_model: 'Nissan Note', status: 'ACTIVE', current_mileage: 100000 },
      { id: 'v-b', owner_id: PROFILE.id, plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE', current_mileage: 200000 }
    ],
    expense_logs: [],
    receipts: [],
    admin_audit_logs: [],
    error_logs: [],
    user_context_cache: [],
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({
      id: 'sess-imp',
      token_hash: hashToken('imp-link'),
      session_token_hash: hashToken('imp-session'),
      verified: true,
      session_expires_at: new Date(Date.now() + 86400000).toISOString()
    })],
    profiles: [{ id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country_code: 'KE' }]
  });
  const impApp = Fastify({ logger: false });
  await registerDashboardRoutes(impApp, { supabase: impMock.client });
  await impApp.ready();
  const impHeaders = { cookie: 'saka_dash=imp-session', 'content-type': 'application/x-www-form-urlencoded' };
  const goodCsv = 'Date,Vehicle Plate,Type,Amount,Odometer,Notes\n2026-11-01,KDA 123A,diesel,5000,100500,Shell\n2026-11-02,KDX 999X,Fuel,1000,,Ghost\n';

  const importForm = await impApp.inject({ method: 'GET', url: '/d/import', headers: { cookie: 'saka_dash=imp-session' } });
  check(importForm.statusCode === 200 && importForm.body.includes('Import expenses'), 'GET /d/import renders the upload form for a signed-in owner');
  const anonImport = await impApp.inject({ method: 'GET', url: '/d/import' });
  check(anonImport.statusCode === 401, 'the import page never renders without a session');

  const previewRes = await impApp.inject({ method: 'POST', url: '/d/import', payload: new URLSearchParams({ csv: goodCsv }).toString(), headers: impHeaders });
  check(previewRes.statusCode === 200 && previewRes.body.includes('Preview'), 'Phase A renders the preview (no write happens yet)');
  check(previewRes.body.includes('1 of 2 rows ready') || previewRes.body.includes('1 of 2 row ready'), 'the preview counts the valid rows exactly');
  check(previewRes.body.includes('class="row-error"') && previewRes.body.includes('not in your fleet'), 'the unknown plate is highlighted and explained');
  check(impMock.db.expense_logs.length === 0, 'a preview never writes a row');

  const rawPreview = await impApp.inject({ method: 'POST', url: '/d/import', payload: goodCsv, headers: { cookie: 'saka_dash=imp-session', 'content-type': 'text/csv' } });
  check(rawPreview.statusCode === 200 && rawPreview.body.includes('Preview'), 'a raw text/csv body reaches the same engine (no multipart)');

  const confirmRes = await impApp.inject({ method: 'POST', url: '/d/import/confirm', payload: new URLSearchParams({ action: 'confirm', csv: goodCsv }).toString(), headers: impHeaders });
  check(confirmRes.statusCode === 303 && confirmRes.headers.location === '/d/import?imported=1', 'Phase B re-validates and inserts exactly ONE row, then redirects');
  const importedRows = impMock.db.expense_logs;
  check(importedRows.length === 1 && importedRows[0].notes === 'Shell', 'only the valid row is written');
  check(importedRows[0].driver_id === PROFILE.id && importedRows[0].expense_type === 'Fuel' && importedRows[0].amount === 5000, 'the imported row is the owner-shaped Fuel expense');
  check(!importedRows.some((row) => row.notes === 'Ghost'), 'the invalid row is never written');
  check(impMock.db.admin_audit_logs.some((row) => row.action === 'CSV_IMPORT'), 'the import is audited as CSV_IMPORT');
  const afterImport = await impApp.inject({ method: 'GET', url: '/d/import?imported=1', headers: { cookie: 'saka_dash=imp-session' } });
  check(afterImport.body.includes('1 expense imported'), 'the redirect lands on an honest confirmation');

  const crossOrigin = await impApp.inject({
    method: 'POST',
    url: '/d/import/confirm',
    payload: new URLSearchParams({ action: 'confirm', csv: goodCsv }).toString(),
    headers: { ...impHeaders, host: 'app.sakafleet.test', origin: 'https://evil.test' }
  });
  check(crossOrigin.statusCode === 403 && impMock.db.expense_logs.length === 1, 'a cross-origin confirm is refused before any write');
  const noMarker = await impApp.inject({ method: 'POST', url: '/d/import/confirm', payload: new URLSearchParams({ csv: goodCsv }).toString(), headers: impHeaders });
  check(noMarker.statusCode === 400 && impMock.db.expense_logs.length === 1, 'a confirm without its action marker writes nothing');
  const badOnly = 'Date,Vehicle Plate,Type,Amount,Odometer,Notes\n2026-11-02,KDX 999X,Fuel,1000,,Ghost\n';
  const badConfirm = await impApp.inject({ method: 'POST', url: '/d/import/confirm', payload: new URLSearchParams({ action: 'confirm', csv: badOnly }).toString(), headers: impHeaders });
  check(badConfirm.statusCode === 400 && /No rows are ready/.test(badConfirm.body), 'a file with zero valid rows is refused (never an empty claim)');
  check(impMock.db.expense_logs.length === 1, 'refused confirms never write');
  await impApp.close();

  console.log('\n--- Test 31: parseComplianceFilters + the one chip vocabulary (14C) ---');
  check(parseComplianceFilters({}).filters.view === 'all', 'no filter means All');
  check(parseComplianceFilters({ view: 'due' }).filters.view === 'due' && parseComplianceFilters({ view: 'EXPIRED' }).filters.view === 'expired', 'due/expired parse case-insensitively');
  check(parseComplianceFilters({ view: 'due_soon' }).filters.view === 'due', 'due_soon is an accepted alias');
  const badView = parseComplianceFilters({ view: 'weird' });
  check(badView.ok === false && badView.reason === 'bad_view' && /not one I know/.test(badView.error), 'an unknown filter is refused with a plain explanation');
  check(COMPLIANCE_VIEWS.join(',') === 'all,due,expired' && COMPLIANCE_DUE_DAYS === 30, 'the view set and the 30-day window are pinned');
  check(complianceInView(10, 'due') && complianceInView(0, 'due') && complianceInView(30, 'due') && !complianceInView(31, 'due'), 'Due Soon is exactly 0-30 days');
  check(complianceInView(-1, 'expired') && !complianceInView(0, 'expired'), 'Expired is strictly below zero');
  check(complianceInView(null, 'due') === false && complianceInView(null, 'all') === true, 'an undated row only appears under All');
  check(complianceStatusOf(-2) === 'expired' && complianceStatusOf(5) === 'due_7d' && complianceStatusOf(12) === 'due_14d' && complianceStatusOf(29) === 'due_30d' && complianceStatusOf(60) === 'active' && complianceStatusOf(null) === 'unknown', 'status buckets reuse the report engine thresholds');
  check(complianceStatusOf(null, true) === 'lifetime', 'a lifetime document is its own bucket');
  check(complianceChipHtml({ status: 'expired', daysLeft: -3 }) === '<span class="chip bad">expired 3 d ago</span>', 'expired renders a red chip');
  check(complianceChipHtml({ status: 'due_30d', daysLeft: 20 }).includes('chip due')
    && complianceChipHtml({ status: 'due_14d', daysLeft: 12 }).includes('chip due')
    && complianceChipHtml({ status: 'due_7d', daysLeft: 5 }).includes('chip due'), 'every due bucket renders orange');
  check(complianceChipHtml({ status: 'due_7d', daysLeft: 0 }) === '<span class="chip due">today</span>', 'a document expiring today says today');
  check(complianceChipHtml({ status: 'active', daysLeft: 60 }).includes('chip ok'), 'an active document renders green');
  check(complianceChipHtml({ lifetime: true, status: 'lifetime', daysLeft: null }) === '<span class="chip ok">Valid for life</span>', 'a lifetime document renders green and says so');
  check(complianceChipHtml({ status: 'unknown', daysLeft: null }) === '<span class="chip">No date</span>', 'an undated document renders a grey chip');
  check(complianceChipHtml({ status: 'expired', daysLeft: -2 }).includes('chip bad') && !complianceChipHtml({ status: 'active', daysLeft: 40 }).includes('bad'), 'red is reserved for expired');

  console.log('\n--- Test 32: filterComplianceReport (HTML/PDF parity) ---');
  const reportFixture = {
    generatedAt: '2026-11-08T06:00:00Z',
    currency: 'KES',
    timeZone: 'Africa/Nairobi',
    expiryItems: [
      { plate: 'KDA 123A', category: 'licensing', categoryLabel: 'Road licence', item: 'Road License', dueDate: '2026-11-05', daysLeft: -3, status: 'expired', subjectType: 'vehicle' },
      { plate: 'KDB 456B', category: 'permit', categoryLabel: 'Permit', item: 'Permit', dueDate: '2026-11-13', daysLeft: 5, status: 'due_7d', subjectType: 'vehicle' },
      { plate: 'KDA 123A', category: 'insurance', categoryLabel: 'Insurance', item: 'Insurance', dueDate: '2026-11-28', daysLeft: 20, status: 'due_30d', subjectType: 'vehicle' },
      { plate: 'KDB 456B', category: 'insurance', categoryLabel: 'Insurance', item: 'Insurance', dueDate: '2027-01-07', daysLeft: 60, status: 'active', subjectType: 'vehicle' }
    ],
    documents: [
      { plate: 'KDA 123A', type: 'insurance', label: 'Insurance', expiry: '2026-11-28', daysLeft: 20, status: 'due_30d' },
      { plate: 'KDB 456B', type: 'insurance', label: 'Insurance', expiry: '2027-01-07', daysLeft: 60, status: 'active' }
    ],
    totals: { monitored: 4, active: 1, expiring30Days: 2, expiring7Days: 1, expired: 1 }
  };
  const dueViewFixture = filterComplianceReport(reportFixture, 'due');
  check(dueViewFixture.expiryItems.length === 2 && dueViewFixture.expiryItems[0].daysLeft === 5, 'Due Soon keeps only 0-30-day items, soonest first');
  check(dueViewFixture.totals.monitored === 2 && dueViewFixture.totals.expiring30Days === 2 && dueViewFixture.totals.expiring7Days === 1 && dueViewFixture.totals.expired === 0 && dueViewFixture.totals.active === 0, 'filtered totals are re-derived with the report bucket math');
  check(dueViewFixture.documents.length === 1 && dueViewFixture.documents[0].daysLeft === 20, 'documents are filtered by the same predicate');
  check(dueViewFixture.insuranceStatusMatrix.total === 1 && dueViewFixture.insuranceStatusMatrix.due30 === 1, 'the category matrix is re-derived (insurance)');
  check(dueViewFixture.inspectionAndPermits.permits.total === 1 && dueViewFixture.driverLicenses.total === 0, 'the category matrix is re-derived (permits/licences)');
  const expiredViewFixture = filterComplianceReport(reportFixture, 'expired');
  check(expiredViewFixture.expiryItems.length === 1 && expiredViewFixture.overdueItems.length === 1 && expiredViewFixture.totals.expired === 1, 'Expired keeps the lapsed item and pins it');
  const allViewFixture = filterComplianceReport(reportFixture, 'all');
  check(allViewFixture.expiryItems.length === 4 && allViewFixture.expiryItems[0].daysLeft === -3, 'All keeps everything with expired first');
  check(allViewFixture.totals.monitored === 4 && allViewFixture.totals.expired === 1, 'All totals match the report');

  console.log('\n--- Test 33: buildComplianceBoard (vehicle + driver rollups) ---');
  const complianceNow = new Date('2026-11-08T06:00:00Z');
  const cDay = (days) => new Date(complianceNow.getTime() + days * 86400000).toISOString().slice(0, 10);
  const complianceSeed = () => ({
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', make_model: 'Nissan Note', status: 'ACTIVE', assigned_driver_id: 'd-1', insurance_expiry: cDay(20), road_license_expiry: cDay(-3) },
      { id: 'v-b', owner_id: PROFILE.id, plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE', assigned_driver_id: 'd-2', insurance_expiry: cDay(60), permit_expiry: cDay(5) },
      { id: 'v-x', owner_id: 'someone-else', plate_number: 'KDX 999X', status: 'ACTIVE', assigned_driver_id: 'd-x', insurance_expiry: cDay(-10) }
    ],
    profiles: [
      { id: 'd-1', full_name: 'Brian Otieno', phone_number: '+254799999991' },
      { id: 'd-2', full_name: 'Grace Wanjiru', phone_number: '+254799999992' },
      { id: 'd-x', full_name: 'Foreign Driver', phone_number: '+254799999993' }
    ],
    driver_compliances: [
      { id: 'dc1', driver_id: 'd-1', type: 'driving_licence', label: 'Driving Licence', number: 'DL123456', expiry: cDay(8) },
      { id: 'dc2', driver_id: 'd-1', type: 'psv_badge', label: 'PSV Badge', number: 'PSV-7788', expiry: cDay(-2) },
      { id: 'dc3', driver_id: 'd-1', type: 'medical_certificate', label: 'Medical Certificate', number: 'MED-1', lifetime: true },
      { id: 'dc9', driver_id: 'd-x', type: 'driving_licence', label: 'Driving Licence', number: 'FX-999', expiry: cDay(-1) }
    ],
    reminders: [],
    vehicle_compliances: [],
    expiry_notification_log: [],
    expense_logs: [],
    private_earnings: [],
    passbook_transfers: []
  });
  const compMock = createMockSupabase(complianceSeed());
  const compBoard = await buildComplianceBoard({ supabase: compMock.client, ownerId: PROFILE.id, countryInfo: KE_INFO, now: complianceNow });
  check(compBoard.ok && compBoard.view === 'all', 'the board builds for the All view');
  check(compBoard.totals.monitored === 4 && compBoard.totals.expired === 1 && compBoard.totals.expiring30Days === 2, 'the board totals come from the report engine');
  check(compBoard.vehicles.length === 2 && compBoard.vehicles[0].plate === 'KDA 123A' && compBoard.vehicles[1].plate === 'KDB 456B', 'only the owner fleet appears, expired-pinned order');
  const vehicleRowA = compBoard.vehicles[0];
  check(vehicleRowA.monitored === 2 && vehicleRowA.expiredCount === 1 && vehicleRowA.dueCount === 1 && vehicleRowA.soonest.daysLeft === -3, 'a vehicle rollup counts tracked/expired/due and carries its soonest');
  check(compBoard.vehicles[1].soonest.daysLeft === 5 && compBoard.vehicles[1].expiredCount === 0, 'the second vehicle carries its own soonest');
  check(compBoard.drivers.length === 2, 'both assigned drivers appear (the foreign driver never does)');
  const driverRowA = compBoard.drivers.find((row) => row.id === 'd-1');
  check(driverRowA.name === 'Brian Otieno' && driverRowA.plates.join(',') === 'KDA 123A', 'the driver row carries name + plates');
  check(driverRowA.documentCount === 3 && driverRowA.expiredCount === 1 && driverRowA.dueCount === 1 && driverRowA.soonest.daysLeft === -2, 'the driver rollup counts documents and its soonest');
  const driverRowB = compBoard.drivers.find((row) => row.id === 'd-2');
  check(driverRowB.documentCount === 0 && driverRowB.soonest === null, 'a driver with no documents is honest, not invented');
  const dueBoard = await buildComplianceBoard({ supabase: createMockSupabase(complianceSeed()).client, ownerId: PROFILE.id, countryInfo: KE_INFO, now: complianceNow, view: 'due' });
  check(dueBoard.vehicles.length === 2 && dueBoard.totals.monitored === 2 && dueBoard.totals.expired === 0, 'Due Soon keeps only due items and their subjects');
  const expiredBoard = await buildComplianceBoard({ supabase: createMockSupabase(complianceSeed()).client, ownerId: PROFILE.id, countryInfo: KE_INFO, now: complianceNow, view: 'expired' });
  check(expiredBoard.vehicles.length === 1 && expiredBoard.vehicles[0].plate === 'KDA 123A', 'Expired narrows the vehicle table to the lapsed fleet');
  check(expiredBoard.drivers.length === 1 && expiredBoard.drivers[0].id === 'd-1', 'Expired narrows the driver table too');
  check(expiredBoard.reportData.totals.monitored === 1
    && JSON.stringify(expiredBoard.reportData.totals) === JSON.stringify(filterComplianceReport(expiredBoard.rawReportData, 'expired').totals),
    'the board report data equals a direct filter (one filter engine)');
  check((await buildComplianceBoard({ supabase: null, ownerId: PROFILE.id })).ok === false, 'no database answers ok:false');

  console.log('\n--- Test 34: buildDriverCompliancePage (ownership + unmasked numbers) ---');
  const driverPageData = await buildDriverCompliancePage({ supabase: compMock.client, ownerId: PROFILE.id, driverId: 'd-1', countryInfo: KE_INFO, now: complianceNow });
  check(driverPageData.ok && driverPageData.driver.name === 'Brian Otieno' && driverPageData.driver.phone === '+254799999991', 'the assigned driver page loads with name + phone');
  check(driverPageData.driver.plates.join(',') === 'KDA 123A' && driverPageData.driver.vehicles[0].id === 'v-a', 'the assigned vehicle rides the page for linking');
  check(driverPageData.documents.length === 3 && driverPageData.documents[0].status === 'expired', 'documents are soonest-first with the expired one on top');
  check(driverPageData.documents.some((doc) => doc.number === 'DL123456'), 'document numbers are unmasked for the owner (D1)');
  check(driverPageData.documents.some((doc) => doc.lifetime === true && doc.status === 'lifetime'), 'a lifetime document is carried as lifetime');
  check(driverPageData.soonest.daysLeft === -2, 'the page carries its soonest document');
  const noDocsPageData = await buildDriverCompliancePage({ supabase: compMock.client, ownerId: PROFILE.id, driverId: 'd-2', countryInfo: KE_INFO, now: complianceNow });
  check(noDocsPageData.ok && noDocsPageData.documents.length === 0 && noDocsPageData.driver.plates.join(',') === 'KDB 456B', 'a driver with no documents still loads');
  const foreignDriverPageData = await buildDriverCompliancePage({ supabase: compMock.client, ownerId: PROFILE.id, driverId: 'd-x', countryInfo: KE_INFO, now: complianceNow });
  check(foreignDriverPageData.ok === false && foreignDriverPageData.reason === 'not_found', "another owner's driver is not_found (structural ownership)");
  check((await buildDriverCompliancePage({ supabase: compMock.client, ownerId: PROFILE.id, driverId: 'nope' })).reason === 'not_found', 'an unknown driver id is not_found');
  check((await buildDriverCompliancePage({ supabase: compMock.client, ownerId: null, driverId: 'd-1' })).reason === 'not_found', 'a missing owner is not_found');

  console.log('\n--- Test 35: buildCompliancePdf (filtered Buffer + KPI parity) ---');
  const { complianceReportToPdf } = await import('./src/services/reportDelivery.js');
  const allCompliancePdf = await buildCompliancePdf(compBoard.reportData, { profile: PROFILE, countryInfo: KE_INFO });
  check(Buffer.isBuffer(allCompliancePdf) && allCompliancePdf.subarray(0, 5).toString() === '%PDF-', 'the compliance PDF is a real Buffer (no Storage)');
  check(allCompliancePdf.length > 1500, `the compliance PDF has real content (${allCompliancePdf.length} bytes)`);
  const pdfAll = complianceReportToPdf({ ok: true, type: 'compliance', data: compBoard.reportData }, 'compliance');
  const pdfDue = complianceReportToPdf({ ok: true, type: 'compliance', data: dueBoard.reportData }, 'compliance');
  const kpiOf = (pdfData, label) => pdfData.kpis.find((kpi) => kpi.label === label)?.value;
  check(kpiOf(pdfAll, 'Monitored items') === '4' && kpiOf(pdfAll, 'Expired') === '1', 'the full PDF KPIs match the board totals');
  check(kpiOf(pdfDue, 'Monitored items') === '2' && kpiOf(pdfDue, 'Expired') === '0' && kpiOf(pdfDue, 'Due within 30 days') === '2', 'the filtered PDF KPIs match the filtered totals (rule 51 ii)');
  check(pdfDue.tables[0].rows.length === 2, 'the filtered PDF table carries exactly the filtered items');
  const readableCompliancePdf = await buildCompliancePdf(expiredBoard.reportData, { profile: PROFILE, countryInfo: KE_INFO, useStandardFonts: true });
  const readableComplianceText = extractPdfText(readableCompliancePdf).text || '';
  check(/Compliance/.test(readableComplianceText) && /EXPIRED/.test(readableComplianceText), 'the expired PDF renders its title and KPI labels');

  console.log('\n--- Test 36: renderCompliancePage ---');
  const complianceHtml = renderCompliancePage({ board: compBoard, filters: { view: 'all' }, emailMasked: 'a***a@example.com' });
  check(complianceHtml.includes('Compliance') && complianceHtml.includes('href="/d/compliance?view=due"') && complianceHtml.includes('href="/d/compliance?view=expired"'), 'the page renders the three view links');
  check(complianceHtml.includes('href="/d/compliance.pdf?view=all"'), 'the export link carries the current view');
  check(complianceHtml.includes('KDA 123A') && complianceHtml.includes('KDB 456B') && complianceHtml.includes('Brian Otieno'), 'vehicle and driver rows render');
  check(complianceHtml.includes('href="/d/drivers/d-1"') && complianceHtml.includes('href="/d/vehicles/v-a"'), 'rows link to the vehicle and driver pages');
  check(complianceHtml.includes('chip bad') && complianceHtml.includes('chip due'), 'expired and due chips render');
  const complianceExpiredHtml = renderCompliancePage({ board: expiredBoard, filters: { view: 'expired' }, emailMasked: 'a***a@example.com' });
  check(complianceExpiredHtml.includes('Items in this view') && !complianceExpiredHtml.includes('KDB 456B'), 'the Expired view narrows the page and lists its items');
  const complianceEmptyHtml = renderCompliancePage({ board: { ...compBoard, items: [], vehicles: [], drivers: [] }, filters: { view: 'expired' } });
  check(complianceEmptyHtml.includes('No vehicles match this view') && complianceEmptyHtml.includes('Nothing expired'), 'empty states are warm and honest');
  const complianceErrorHtml = renderCompliancePage({ board: compBoard, filters: { view: 'all' }, error: 'That filter is not one I know — choose All, Due soon or Expired.' });
  check(complianceErrorHtml.includes('not one I know'), 'a rejected filter renders its explanation');
  const complianceHostileHtml = renderCompliancePage({ board: { ...compBoard, vehicles: [{ ...compBoard.vehicles[0], plate: '<script>alert(1)</script>' }] }, filters: { view: 'all' } });
  check(!complianceHostileHtml.includes('<script>alert(1)</script>') && complianceHostileHtml.includes('&lt;script&gt;'), 'plate and driver text are escaped');
  check(renderCompliancePage({ board: { ok: false }, filters: { view: 'all' } }).includes('could not be loaded'), 'a failed board renders one honest explanation');

  console.log('\n--- Test 37: renderDriverPage ---');
  const driverHtml = renderDriverPage({ page: driverPageData, emailMasked: 'a***a@example.com' });
  check(driverHtml.includes('Brian Otieno') && driverHtml.includes('+254799999991'), 'the driver page shows name and phone');
  check(driverHtml.includes('DL123456') && driverHtml.includes('PSV-7788'), 'document numbers are rendered in full for the owner (D1)');
  check(driverHtml.includes('href="/d/vehicles/v-a"') && driverHtml.includes('KDA 123A'), 'the assigned vehicle links from the page');
  check(driverHtml.includes('Valid for life') && driverHtml.includes('chip bad'), 'lifetime and expired documents render their chips');
  const emptyDriverHtml = renderDriverPage({ page: noDocsPageData, emailMasked: 'a***a@example.com' });
  check(emptyDriverHtml.includes('No driver documents on file yet') && !emptyDriverHtml.includes('undefined'), 'an empty driver ledger is honest');
  check(renderDriverPage({ page: { ok: false } }).includes('could not be loaded'), 'a failed driver page renders one explanation');

  console.log('\n--- Test 38: compliance routes end-to-end (Fastify inject) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const routeDay = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const compRouteMock = createMockSupabase({
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', make_model: 'Nissan Note', status: 'ACTIVE', assigned_driver_id: 'd-1', insurance_expiry: routeDay(20), road_license_expiry: routeDay(-3) },
      { id: 'v-b', owner_id: PROFILE.id, plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE', assigned_driver_id: 'd-2', insurance_expiry: routeDay(60), permit_expiry: routeDay(5) },
      { id: 'v-x', owner_id: 'someone-else', plate_number: 'KDX 999X', status: 'ACTIVE', assigned_driver_id: 'd-x', insurance_expiry: routeDay(-10) }
    ],
    profiles: [
      { id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country_code: 'KE' },
      { id: 'd-1', full_name: 'Brian Otieno', phone_number: '+254799999991' },
      { id: 'd-2', full_name: 'Grace Wanjiru', phone_number: '+254799999992' },
      { id: 'd-x', full_name: 'Foreign Driver', phone_number: '+254799999993' }
    ],
    driver_compliances: [
      { id: 'dc1', driver_id: 'd-1', type: 'driving_licence', label: 'Driving Licence', number: 'DL123456', expiry: routeDay(8) },
      { id: 'dc2', driver_id: 'd-1', type: 'psv_badge', label: 'PSV Badge', number: 'PSV-7788', expiry: routeDay(-2) },
      { id: 'dc9', driver_id: 'd-x', type: 'driving_licence', label: 'Driving Licence', number: 'FX-999', expiry: routeDay(-1) }
    ],
    reminders: [],
    vehicle_compliances: [],
    expiry_notification_log: [],
    expense_logs: [],
    private_earnings: [],
    passbook_transfers: [],
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({
      id: 'sess-comp',
      token_hash: hashToken('comp-link'),
      session_token_hash: hashToken('comp-session'),
      verified: true,
      session_expires_at: new Date(Date.now() + 86400000).toISOString()
    })],
    admin_audit_logs: [],
    error_logs: []
  });
  const compApp = Fastify({ logger: false });
  await registerDashboardRoutes(compApp, { supabase: compRouteMock.client });
  await compApp.ready();
  const compCookie = { cookie: 'saka_dash=comp-session' };

  const complianceRes = await compApp.inject({ method: 'GET', url: '/d/compliance', headers: compCookie });
  check(complianceRes.statusCode === 200 && complianceRes.body.includes('Compliance'), 'GET /d/compliance renders the board');
  check(complianceRes.body.includes('KDA 123A') && complianceRes.body.includes('Brian Otieno'), 'the board shows owner vehicles and assigned drivers');
  const expiredRes = await compApp.inject({ method: 'GET', url: '/d/compliance?view=expired', headers: compCookie });
  check(expiredRes.statusCode === 200 && expiredRes.body.includes('KDA 123A') && !expiredRes.body.includes('KDB 456B'), 'the Expired view narrows the board');
  const dueRes = await compApp.inject({ method: 'GET', url: '/d/compliance?view=due', headers: compCookie });
  check(dueRes.statusCode === 200 && dueRes.body.includes('Items in this view'), 'the Due Soon view lists the matching items');
  const badComplianceRes = await compApp.inject({ method: 'GET', url: '/d/compliance?view=weird', headers: compCookie });
  check(badComplianceRes.statusCode === 400 && /not one I know/.test(badComplianceRes.body), 'an invalid view is a 400 with a plain explanation');
  const anonCompliance = await compApp.inject({ method: 'GET', url: '/d/compliance' });
  check(anonCompliance.statusCode === 401, 'compliance never renders without a session');

  const driverRes = await compApp.inject({ method: 'GET', url: '/d/drivers/d-1', headers: compCookie });
  check(driverRes.statusCode === 200 && driverRes.body.includes('Brian Otieno'), 'GET /d/drivers/:id renders the assigned driver');
  check(driverRes.body.includes('DL123456') && driverRes.body.includes('PSV-7788'), 'the owner sees document numbers in full (D1)');
  check(driverRes.body.includes('href="/d/vehicles/v-a"'), 'the driver page links the assigned vehicle');
  const foreignDriverRes = await compApp.inject({ method: 'GET', url: '/d/drivers/d-x', headers: compCookie });
  check(foreignDriverRes.statusCode === 404, "another owner's driver answers 404");
  check(!foreignDriverRes.body.includes('Foreign Driver')
    && !foreignDriverRes.body.includes('+254799999993')
    && !foreignDriverRes.body.includes('FX-999'), 'the 404 body leaks no name, phone or document number (rule 51 iv)');
  const unknownDriverRes = await compApp.inject({ method: 'GET', url: '/d/drivers/does-not-exist', headers: compCookie });
  check(unknownDriverRes.statusCode === 404, 'an unknown driver id answers 404');
  const laneAnonDriver = await compApp.inject({ method: 'GET', url: '/d/drivers/d-1' });
  check(laneAnonDriver.statusCode === 401, 'the driver page never renders without a session');

  const compliancePdfRes = await compApp.inject({ method: 'GET', url: '/d/compliance.pdf', headers: compCookie });
  check(compliancePdfRes.statusCode === 200 && String(compliancePdfRes.headers['content-type']).includes('application/pdf'), 'GET /d/compliance.pdf answers application/pdf');
  check(compliancePdfRes.rawPayload.subarray(0, 5).toString() === '%PDF-', 'the compliance PDF is a real streamed PDF');
  check(/attachment; filename="saka-compliance-all-\d{4}-\d{2}-\d{2}\.pdf"/.test(String(compliancePdfRes.headers['content-disposition'])), 'the PDF carries a dated download filename');
  const expiredPdfRes = await compApp.inject({ method: 'GET', url: '/d/compliance.pdf?view=expired', headers: compCookie });
  check(expiredPdfRes.statusCode === 200 && expiredPdfRes.rawPayload.subarray(0, 5).toString() === '%PDF-', 'the filtered PDF exports the same view');
  const badPdfRes = await compApp.inject({ method: 'GET', url: '/d/compliance.pdf?view=weird', headers: compCookie });
  check(badPdfRes.statusCode === 400, 'an invalid view refuses the export with a 400');
  await compApp.close();

  console.log('\n--- Test 39: D1 — last_30_days + the bounds override are additive ---');
  const reportNow = new Date('2026-11-08T06:00:00Z');
  const last30 = dateRangeBounds('last_30_days', reportNow);
  check(last30.label === 'Last 30 days' && Math.round((new Date(last30.to) - new Date(last30.from)) / 86400000) === 30, 'last_30_days is a 30-day window with its own label');
  check(dateRangeBounds('this_month', reportNow).label === 'This month'
    && dateRangeBounds('this_year', reportNow).label === 'This year'
    && dateRangeBounds('last_3_months', reportNow).label === 'Last 3 months', 'every pre-existing range keeps its exact label (WhatsApp untouched)');
  check(dateRangeBounds('this_month', reportNow).from.slice(0, 10) === '2026-11-01', 'this_month still starts on the 1st');

  console.log('\n--- Test 40: parseReportSpec (validation + owner scope) ---');
  const specVehicles = ['v-a', 'v-b'];
  const defaultSpec = parseReportSpec({}, { vehicleIds: specVehicles, now: reportNow });
  check(defaultSpec.ok && defaultSpec.spec.range === 'this_month' && defaultSpec.spec.vehicleIds.length === 0, 'the default spec is This month across the whole fleet');
  check(defaultSpec.spec.metricIds.length === 5, 'with no metrics ticked the spec carries the five default owner metrics');
  check(REPORT_RANGES.join(',') === 'this_month,last_30_days,this_year,custom' && REPORT_MAX_METRICS === 8, 'the range set and the 8-metric cap are pinned');
  const last30Spec = parseReportSpec({ range: 'last_30_days' }, { vehicleIds: specVehicles, now: reportNow });
  check(last30Spec.ok && last30Spec.spec.label === 'Last 30 days', 'the Last 30 days preset resolves');
  const customSpec = parseReportSpec({ range: 'custom', from: '2026-10-01', to: '2026-10-31' }, { vehicleIds: specVehicles, now: reportNow });
  check(customSpec.ok && customSpec.spec.from === '2026-10-01T00:00:00+03:00' && customSpec.spec.to === '2026-10-31T23:59:59.999+03:00', 'a custom range becomes inclusive Nairobi day bounds');
  check(customSpec.spec.label === '2026-10-01 – 2026-10-31', 'the custom label names both dates');
  check(parseReportSpec({ range: 'custom', from: 'nope', to: '2026-10-31' }, { vehicleIds: specVehicles }).reason === 'bad_from', 'a malformed start date is refused');
  check(parseReportSpec({ range: 'custom', from: '2026-10-01', to: 'nope' }, { vehicleIds: specVehicles }).reason === 'bad_to', 'a malformed end date is refused');
  check(parseReportSpec({ range: 'custom', from: '2026-10-31', to: '2026-10-01' }, { vehicleIds: specVehicles }).reason === 'bad_range_dates', 'a reversed custom range is refused');
  check(parseReportSpec({ range: 'custom', from: '2024-01-01', to: '2026-10-01' }, { vehicleIds: specVehicles }).reason === 'range_too_wide', 'a custom range wider than 366 days is refused');
  check(parseReportSpec({ range: 'weird' }, { vehicleIds: specVehicles }).reason === 'bad_range', 'an unknown range is refused');
  check(parseReportSpec({ vehicles: 'v-foreign' }, { vehicleIds: specVehicles }).reason === 'unknown_vehicle', "another owner's vehicle id is refused");
  check(parseReportSpec({ vehicles: ['v-a', 'v-b'] }, { vehicleIds: specVehicles }).spec.vehicleIds.join(',') === 'v-a,v-b', 'checked vehicle boxes (array query values) are accepted');
  check(parseReportSpec({ metrics: 'not_a_metric' }, { vehicleIds: specVehicles }).reason === 'unknown_metric', 'an unknown metric id is refused');
  const nineMetrics = CUSTOM_METRICS.slice(0, 9).map((metric) => metric.id).join(',');
  check(parseReportSpec({ metrics: nineMetrics }, { vehicleIds: specVehicles }).reason === 'too_many_metrics', 'more than 8 metrics is refused');
  const eightMetrics = CUSTOM_METRICS.slice(0, 8).map((metric) => metric.id).join(',');
  check(parseReportSpec({ metrics: eightMetrics }, { vehicleIds: specVehicles }).spec.metricIds.length === 8, 'exactly 8 metrics passes');
  const chosenSpec = parseReportSpec({ metrics: ['earnings', 'total_spend'], vehicles: 'v-a', range: 'this_year' }, { vehicleIds: specVehicles, now: reportNow });
  check(chosenSpec.ok && chosenSpec.spec.metricIds.join(',') === 'earnings,total_spend' && chosenSpec.spec.vehicleIds.join(',') === 'v-a', 'an explicit selection is preserved exactly');

  console.log('\n--- Test 41: buildDashboardCustomReport (same engine, owner lane) ---');
  const rDay = (days) => new Date(reportNow.getTime() + days * 86400000).toISOString();
  const reportSeed = () => ({
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', status: 'ACTIVE' },
      { id: 'v-b', owner_id: PROFILE.id, plate_number: 'KDB 456B', status: 'ACTIVE' },
      { id: 'v-x', owner_id: 'someone-else', plate_number: 'KDX 999X', status: 'ACTIVE' }
    ],
    expense_logs: [
      { id: 'e1', vehicle_id: 'v-a', driver_id: PROFILE.id, expense_type: 'Fuel', amount: 5000, fuel_liters: 40, created_at: rDay(-2) },
      { id: 'e2', vehicle_id: 'v-b', driver_id: 'd-1', expense_type: 'Repairs', amount: 3000, created_at: rDay(-3) },
      { id: 'e3', vehicle_id: 'v-a', driver_id: PROFILE.id, expense_type: 'Fuel', amount: 1000, created_at: rDay(-40) },
      { id: 'e4', vehicle_id: 'v-x', driver_id: 'stranger', expense_type: 'Fuel', amount: 9999, created_at: rDay(-2) }
    ],
    private_earnings: [
      { id: 'n1', vehicle_id: 'v-a', driver_id: PROFILE.id, revenue_amount: 12000, earning_type: 'Trips', logged_at: rDay(-2), created_at: rDay(-2) }
    ],
    reminders: [],
    vehicle_compliances: [],
    driver_compliances: [],
    expiry_notification_log: [],
    passbook_transfers: []
  });
  const reportMock = createMockSupabase(reportSeed());
  const fleetSpec = parseReportSpec({ range: 'last_30_days', metrics: 'total_spend,earnings' }, { vehicleIds: ['v-a', 'v-b'], now: reportNow }).spec;
  const customReport = await buildDashboardCustomReport({ supabase: reportMock.client, ownerId: PROFILE.id, spec: fleetSpec, countryInfo: KE_INFO, profile: PROFILE, now: reportNow });
  check(customReport.ok && customReport.data && Array.isArray(customReport.data.kpis), 'the builder returns Apex report data');
  check(customReport.data.periodLabel === 'Last 30 days' && customReport.data.title === 'Bespoke Report', 'the window label and title come through');
  const kpiLabels = customReport.data.kpis.map((kpi) => kpi.label);
  check(kpiLabels.includes('Total spend') && kpiLabels.includes('Earnings'), 'the selected metrics become the KPIs');
  check(/8,000/.test(customReport.data.kpis.find((kpi) => kpi.label === 'Total spend').value), 'total spend covers the fleet and excludes the out-of-window row (8000)');
  check(/12,000/.test(customReport.data.kpis.find((kpi) => kpi.label === 'Earnings').value), 'the owner lane sees earnings');
  const narrowSpec = parseReportSpec({ range: 'custom', from: rDay(-4).slice(0, 10), to: rDay(-3).slice(0, 10), metrics: 'total_spend' }, { vehicleIds: ['v-a', 'v-b'], now: reportNow }).spec;
  const narrowReport = await buildDashboardCustomReport({ supabase: createMockSupabase(reportSeed()).client, ownerId: PROFILE.id, spec: narrowSpec, countryInfo: KE_INFO, profile: PROFILE, now: reportNow });
  check(narrowReport.ok && /3,000/.test(narrowReport.data.kpis.find((kpi) => kpi.label === 'Total spend').value), 'the explicit bounds win over the preset window');
  check(narrowReport.data.periodLabel === narrowSpec.label, 'the report label matches the custom window');
  const scopedReport = await buildDashboardCustomReport({ supabase: reportMock.client, ownerId: PROFILE.id, spec: { ...fleetSpec, vehicleIds: ['v-b'] }, countryInfo: KE_INFO, profile: PROFILE, now: reportNow });
  check(/3,000/.test(scopedReport.data.kpis.find((kpi) => kpi.label === 'Total spend').value), 'a ticked vehicle narrows the report');
  check((await buildDashboardCustomReport({ supabase: null, ownerId: PROFILE.id, spec: fleetSpec })).ok === false, 'no database answers ok:false');

  console.log('\n--- Test 42: settings (one writable preference, same column) ---');
  const settingsMock = createMockSupabase({
    profiles: [{ id: PROFILE.id, email: 'amina@example.com', phone_number: '+254712345678', full_name: 'Amina W', country: 'Kenya', country_code: 'KE', preferred_language: 'English', unit_system: 'metric', weekly_report_opt_in: true, subscription_tier: 'solo_pro', subscription_status: 'ACTIVE' }]
  });
  const settingsData = await buildSettingsPage({
    supabase: settingsMock.client,
    ownerId: PROFILE.id,
    profile: { ...PROFILE, email: 'amina@example.com', phone_number: '+254712345678', country: 'Kenya', preferred_language: 'English', unit_system: 'metric' },
    countryInfo: KE_INFO,
    sessionExpiresAt: rDay(20)
  });
  check(settingsData.ok && settingsData.weeklyReportOn === true && settingsData.weeklyReportKnown === true, 'the weekly-report preference is read as saved');
  check(Boolean(settingsData.planLabel) && settingsData.planLabel !== 'Free', 'the plan label comes from the tier registry');
  check(settingsData.emailMasked === 'a***a@example.com' && settingsData.phoneMasked.endsWith('5678') && !settingsData.phoneMasked.includes('712345'), 'email and phone are masked, never printed in full');
  check(settingsData.language === 'English' && settingsData.unitSystem === 'Metric (km)' && settingsData.countryLabel === 'Kenya', 'language, units and country are shown');
  check(settingsData.currency === 'KES' && settingsData.sessionExpiresAt === rDay(20), 'currency and the session expiry ride the page');
  const savedOff = await saveSettings({ supabase: settingsMock.client, ownerId: PROFILE.id, weeklyReportOn: false });
  check(savedOff.ok && settingsMock.db.profiles[0].weekly_report_opt_in === false, 'saving writes the SAME profiles.weekly_report_opt_in column');
  check(settingsMock.state.updates.at(-1).patch.weekly_report_opt_in === false, 'the update patch names the weekly-report column (dual-write safe)');
  const failingSettingsClient = { from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'boom' } }) }) }) };
  const failedSave = await saveSettings({ supabase: failingSettingsClient, ownerId: PROFILE.id, weeklyReportOn: true });
  check(failedSave.ok === false && /nothing changed/.test(failedSave.error), 'a failed write says nothing changed, never Saved');
  check((await saveSettings({ supabase: settingsMock.client, ownerId: PROFILE.id, weeklyReportOn: null })).ok === false, 'a non-boolean value is refused');
  check((await saveSettings({ supabase: settingsMock.client, ownerId: null, weeklyReportOn: true })).ok === false, 'a missing owner is refused');

  console.log('\n--- Test 42b: monthly PDF summary preference (v1.77.0) ---');
  const monthlyMock = createMockSupabase({
    profiles: [{ id: PROFILE.id, monthly_report_opt_in: true, weekly_report_opt_in: false, subscription_tier: 'solo_pro' }]
  });
  const monthlyRead = await buildSettingsPage({ supabase: monthlyMock.client, ownerId: PROFILE.id, profile: { ...PROFILE }, countryInfo: KE_INFO });
  check(monthlyRead.monthlyReportOn === true && monthlyRead.monthlyReportKnown === true, 'the monthly preference is read from profiles.monthly_report_opt_in');
  const monthlySaved = await saveSettings({ supabase: monthlyMock.client, ownerId: PROFILE.id, monthlyReportOn: false });
  check(monthlySaved.ok && monthlySaved.monthlyReportOn === false, 'saving the monthly toggle succeeds');
  check(monthlyMock.db.profiles[0].monthly_report_opt_in === false && monthlyMock.db.profiles[0].weekly_report_opt_in === false, 'the monthly save never touches the weekly column');
  check(monthlyMock.state.updates.at(-1).patch.monthly_report_opt_in === false
    && monthlyMock.state.updates.at(-1).patch.weekly_report_opt_in === undefined,
    'the update patch names ONLY the monthly column');
  const bothSaved = await saveSettings({ supabase: monthlyMock.client, ownerId: PROFILE.id, weeklyReportOn: true, monthlyReportOn: true });
  check(bothSaved.ok && monthlyMock.db.profiles[0].weekly_report_opt_in === true && monthlyMock.db.profiles[0].monthly_report_opt_in === true, 'both preferences can be written together');
  const missingColumnClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { message: 'column "monthly_report_opt_in" does not exist' } })
        })
      })
    })
  };
  const degradedSettings = await buildSettingsPage({ supabase: missingColumnClient, ownerId: PROFILE.id, profile: { ...PROFILE }, countryInfo: KE_INFO });
  check(degradedSettings.ok === true && degradedSettings.monthlyReportKnown === false && degradedSettings.weeklyReportKnown === false,
    'an un-migrated column degrades honestly (rule 50)');
  const monthlyHtml = renderSettingsPage({ settings: monthlyRead });
  check(monthlyHtml.includes('Monthly PDF summary') && monthlyHtml.includes('value="save_monthly"'), 'the settings page renders the monthly toggle with its own marker');
  check(monthlyHtml.includes('value="save_weekly"'), 'the weekly toggle keeps its own marker');

  console.log('\n--- Test 43: serializeAllDataCsv (sections, [CAP], escaping, scope) ---');
  const exportSeed = () => ({
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', status: 'ACTIVE', assigned_driver_id: 'd-1' },
      { id: 'v-x', owner_id: 'someone-else', plate_number: 'KDX 999X', status: 'ACTIVE', assigned_driver_id: 'd-x' }
    ],
    expense_logs: [
      { id: 'e1', vehicle_id: 'v-a', driver_id: PROFILE.id, expense_type: 'Fuel', amount: 5000, currency: 'KES', label: 'karen run', notes: 'Shell, "Karen"', created_at: '2026-11-07T06:00:00Z' },
      { id: 'e9', vehicle_id: 'v-x', driver_id: 'stranger', expense_type: 'Fuel', amount: 9999, created_at: '2026-11-07T06:00:00Z' }
    ],
    private_earnings: [{ id: 'n1', vehicle_id: 'v-a', driver_id: PROFILE.id, revenue_amount: 12000, currency: 'KES', earning_type: 'Trips', logged_at: '2026-11-07T07:00:00Z' }],
    reminders: [
      { id: 'r1', vehicle_id: 'v-a', subject_type: 'vehicle', category: 'insurance', reminder_type: 'Insurance', due_date: '2026-12-01', status: 'active' },
      { id: 'r2', vehicle_id: null, subject_type: 'driver', subject_id: 'd-1', category: 'driver_license', reminder_type: 'Licence', due_date: '2027-01-01', status: 'active' }
    ],
    vehicle_compliances: [{ id: 'vc1', vehicle_id: 'v-a', type: 'insurance', label: 'Insurance', number: 'POL-1', expiry: '2026-12-01', lifetime: false }],
    driver_compliances: [
      { id: 'dc1', driver_id: 'd-1', type: 'driving_licence', label: 'Driving Licence', number: 'DL123456', expiry: '2027-05-15' },
      { id: 'dc9', driver_id: 'd-x', type: 'driving_licence', label: 'Other', number: 'FX-999', expiry: '2027-05-15' }
    ],
    receipts: [
      { id: 'rc1', media_id: 'm1', vehicle_id: 'v-a', owner_id: PROFILE.id, document_kind: 'fuel_receipt', status: 'read', vendor: 'Shell', amount: 5000, currency: 'KES', created_at: '2026-11-07T06:00:00Z' },
      { id: 'rc2', media_id: 'm2', vehicle_id: null, owner_id: PROFILE.id, document_kind: 'insurance', status: 'read', vendor: 'Bima', amount: 22000, currency: 'KES', created_at: '2026-11-06T06:00:00Z' },
      { id: 'rc9', media_id: 'm9', vehicle_id: 'v-x', owner_id: 'someone-else', document_kind: 'fuel_receipt', status: 'read', vendor: 'Foreign', amount: 9999, created_at: '2026-11-07T06:00:00Z' }
    ],
    expiry_notification_log: [],
    passbook_transfers: []
  });
  const exportCsv = await serializeAllDataCsv({ supabase: createMockSupabase(exportSeed()).client, ownerId: PROFILE.id, currency: 'KES' });
  check(exportCsv.charCodeAt(0) === 0xFEFF, 'the export starts with a UTF-8 BOM');
  const sectionOrder = ['# expenses', '# earnings', '# reminders', '# vehicle_compliances', '# driver_compliances', '# receipts'].map((marker) => exportCsv.indexOf(marker));
  check(sectionOrder.every((index) => index >= 0), 'all six # section rows are present');
  check(sectionOrder.every((index, i) => i === 0 || index > sectionOrder[i - 1]), 'the sections appear in a stable order');
  check(EXPORT_COLUMNS.expenses[0] === 'record_type' && EXPORT_COLUMNS.driver_compliances[0] === 'record_type', 'record_type is the first column of every section');
  check(exportCsv.includes('expense,e1,2026-11-07T06:00:00Z,v-a,KDA 123A,Fuel,5000,KES'), 'the expense row carries record_type, ids, plate and amount');
  check(exportCsv.includes('"Shell, ""Karen"""'), 'commas and quotes are escaped (RFC 4180)');
  check(exportCsv.includes('earning,n1,2026-11-07T07:00:00Z,v-a,KDA 123A,Trips,12000'), 'the earning row uses revenue_amount');
  check(exportCsv.includes('reminder,r1,v-a,KDA 123A,vehicle,insurance,Insurance,2026-12-01'), 'vehicle reminders are exported');
  check(!exportCsv.includes('driver_license,Licence'), 'a driver-linked reminder without a vehicle is not in the vehicle section');
  check(exportCsv.includes('vehicle_compliance,vc1,v-a,KDA 123A,insurance,Insurance,POL-1,2026-12-01'), 'vehicle documents export with their number');
  check(exportCsv.includes('driver_compliance,dc1,d-1') && !exportCsv.includes('FX-999'), "only the owner's assigned driver documents export");
  check(!exportCsv.includes('9999'), "another owner's expense never reaches the export");
  check(exportCsv.includes('receipt,rc1,2026-11-07T06:00:00Z,v-a,KDA 123A,fuel_receipt,read,Shell,5000,KES,m1'), 'receipt metadata exports (never an image url)');
  check(exportCsv.includes('receipt,rc2,2026-11-06T06:00:00Z,,,insurance,read,Bima,22000'), "the owner's own vehicle-less scan still exports");
  check(!exportCsv.includes('Foreign'), "another owner's receipt never reaches the export");

  const cappedSeed = { ...exportSeed(), expense_logs: Array.from({ length: EXPORT_SECTION_CAP + 1 }, (_, i) => ({ id: `c${i}`, vehicle_id: 'v-a', expense_type: 'Fuel', amount: i + 1, created_at: '2026-11-07T06:00:00Z' })) };
  const cappedCsv = await serializeAllDataCsv({ supabase: createMockSupabase(cappedSeed).client, ownerId: PROFILE.id, currency: 'KES' });
  check(cappedCsv.includes(`[CAP] Reached ${EXPORT_SECTION_CAP}-row limit for expenses. Older rows may exist in your account.`), 'the 2000-row cap appends its [CAP] row (A1)');
  const cappedExpenseRows = cappedCsv.split('# expenses')[1].split('# earnings')[0].split('\r\n').filter((line) => line.startsWith('expense,'));
  check(cappedExpenseRows.length === EXPORT_SECTION_CAP, 'exactly the cap number of expense rows is written');

  const brokenExportClient = {
    from: (table) => {
      if (table === 'expense_logs') {
        return { select: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
      }
      return createMockSupabase(exportSeed()).client.from(table);
    }
  };
  const brokenExportCsv = await serializeAllDataCsv({ supabase: brokenExportClient, ownerId: PROFILE.id, currency: 'KES' });
  check(brokenExportCsv.includes('[ERROR] Could not read expenses just now.'), 'a failed table renders an [ERROR] row, never a silent empty section');
  check((await serializeAllDataCsv({ supabase: null, ownerId: null })).includes('[ERROR] No account context.'), 'no account context is reported honestly');

  console.log('\n--- Test 44: the reports + settings renderers ---');
  const reportsHtml = renderReportsPage({ vehicles: ownerVehicles, spec: { range: 'last_30_days', metricIds: ['earnings', 'total_spend'], vehicleIds: ['v-a'] } });
  check(reportsHtml.includes('method="GET" action="/d/reports.pdf"'), 'the builder form is a GET back to the PDF route');
  check(reportsHtml.includes('value="this_month"') && reportsHtml.includes('value="last_30_days" checked') && reportsHtml.includes('value="this_year"') && reportsHtml.includes('value="custom"'), 'all four ranges render with the current one checked');
  check(reportsHtml.includes('name="from"') && reportsHtml.includes('name="to"'), 'the custom date inputs render');
  check(reportsHtml.includes('name="vehicles" value="v-a" checked'), 'a ticked vehicle renders checked');
  check(reportsHtml.includes('name="metrics" value="earnings" checked') && reportsHtml.includes('name="metrics" value="fuel_spend"'), 'metrics render as checkboxes with the selection kept');
  check(reportsHtml.includes('<legend>Financial</legend>') && reportsHtml.includes('<legend>Fuel</legend>'), 'metric checkboxes are grouped by category');
  check(reportsHtml.includes('Build my PDF'), 'the submit button renders');
  check(renderReportsPage({ vehicles: ownerVehicles, spec: {}, error: 'That vehicle is not on your fleet.' }).includes('not on your fleet'), 'a rejected spec renders its explanation');
  check(renderReportsPage({ spec: {} }).includes('No vehicles yet'), 'an empty fleet renders an honest hint');

  const settingsHtml = renderSettingsPage({ settings: settingsData, saved: true });
  check(settingsHtml.includes('method="POST" action="/d/settings"') && settingsHtml.includes('name="action" value="save_weekly"'), 'the preferences form posts with its action marker');
  check(settingsHtml.includes('name="weekly_report" value="on" checked'), 'the weekly toggle reflects the saved state');
  check(settingsHtml.includes('<span class="chip ok">Saved</span>'), 'a successful save shows the Saved chip');
  check(settingsHtml.includes('href="/d/export.csv"') && settingsHtml.includes('Download all my data'), 'the data export link renders');
  check(settingsHtml.includes('href="/d/logout"'), 'the logout link renders');
  check(settingsHtml.includes(settingsData.planLabel) && settingsHtml.includes(settingsData.emailMasked) && !settingsHtml.includes('amina@example.com'), 'the plan and the MASKED email render (never the raw address)');
  const settingsErrorHtml = renderSettingsPage({ settings: settingsData, error: 'I could not save that setting — nothing changed. Please try again.' });
  check(settingsErrorHtml.includes('nothing changed') && !settingsErrorHtml.includes('Saved'), 'a failed save renders the error and no Saved chip');
  const hostileSettingsHtml = renderSettingsPage({ settings: { ...settingsData, planLabel: '<script>alert(1)</script>' } });
  check(!hostileSettingsHtml.includes('<script>alert(1)</script>') && hostileSettingsHtml.includes('&lt;script&gt;'), 'user-visible text is escaped');
  check(renderSettingsPage({ settings: { ok: false } }).includes('could not be loaded'), 'a failed settings load renders one explanation');

  console.log('\n--- Test 45: reports + settings + export routes (Fastify inject) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const settingsRouteMock = createMockSupabase({
    ...reportSeed(),
    profiles: [{ id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country: 'Kenya', country_code: 'KE', preferred_language: 'English', unit_system: 'metric', weekly_report_opt_in: false, subscription_tier: 'solo_pro', subscription_status: 'ACTIVE' }],
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({
      id: 'sess-set',
      token_hash: hashToken('set-link'),
      session_token_hash: hashToken('set-session'),
      verified: true,
      session_expires_at: new Date(Date.now() + 86400000).toISOString()
    })],
    admin_audit_logs: [],
    error_logs: []
  });
  const setApp = Fastify({ logger: false });
  await registerDashboardRoutes(setApp, { supabase: settingsRouteMock.client });
  await setApp.ready();
  const setCookie = { cookie: 'saka_dash=set-session' };
  const postForm = { 'content-type': 'application/x-www-form-urlencoded' };
  const sameOrigin = { ...setCookie, host: 'app.sakafleet.test', origin: 'https://app.sakafleet.test' };

  const reportsRes = await setApp.inject({ method: 'GET', url: '/d/reports', headers: setCookie });
  check(reportsRes.statusCode === 200 && reportsRes.body.includes('Build a report'), 'GET /d/reports renders the builder');
  check(reportsRes.body.includes('action="/d/reports.pdf"') && reportsRes.body.includes('Total spend'), 'the form targets the PDF route and lists the metrics');
  // v1.93.0 (Phase 30, Task 1) — the builder offers both layouts.
  check(reportsRes.body.includes('formaction="/d/reports.pdf?variant=mobile"') && reportsRes.body.includes('Build for phone (A5)'), 'the builder offers the phone (A5) download (v1.93.0)');
  const badReportsRes = await setApp.inject({ method: 'GET', url: '/d/reports?range=weird', headers: setCookie });
  check(badReportsRes.statusCode === 400 && /not one I know/.test(badReportsRes.body), 'an invalid range is a 400 on the form');
  const anonReports = await setApp.inject({ method: 'GET', url: '/d/reports' });
  check(anonReports.statusCode === 401, 'the builder never renders without a session');

  const reportPdfRes = await setApp.inject({ method: 'GET', url: '/d/reports.pdf?range=this_month&metrics=total_spend,earnings&vehicles=v-a', headers: setCookie });
  check(reportPdfRes.statusCode === 200 && String(reportPdfRes.headers['content-type']).includes('application/pdf'), 'GET /d/reports.pdf answers application/pdf');
  check(reportPdfRes.rawPayload.subarray(0, 5).toString() === '%PDF-', 'the built report is a real PDF');
  check(/attachment; filename="saka-report-this_month-\d{4}-\d{2}-\d{2}\.pdf"/.test(String(reportPdfRes.headers['content-disposition'])), 'the PDF carries a dated filename naming the range');
  const phoneReportPdf = await setApp.inject({ method: 'GET', url: '/d/reports.pdf?range=this_month&metrics=total_spend&variant=mobile', headers: setCookie });
  check(phoneReportPdf.statusCode === 200 && phoneReportPdf.rawPayload.subarray(0, 5).toString() === '%PDF-', 'GET /d/reports.pdf?variant=mobile answers a real PDF');
  check(/\b419(\.0+)?\s+595(\.0+)?\b/.test(phoneReportPdf.rawPayload.toString('latin1')), 'the reports phone variant is A5 (419 x 595)');
  const foreignVehicleReport = await setApp.inject({ method: 'GET', url: '/d/reports.pdf?vehicles=v-x', headers: setCookie });
  check(foreignVehicleReport.statusCode === 400 && /not on your fleet/.test(foreignVehicleReport.body), "another owner's vehicle id is refused (rule 51 i)");
  const customReportRes = await setApp.inject({ method: 'GET', url: '/d/reports.pdf?range=custom&from=2026-11-01&to=2026-11-07&metrics=total_spend', headers: setCookie });
  check(customReportRes.statusCode === 200 && customReportRes.rawPayload.subarray(0, 5).toString() === '%PDF-', 'a custom range builds its own PDF');
  const badCustomRes = await setApp.inject({ method: 'GET', url: '/d/reports.pdf?range=custom&from=nope&to=2026-11-07', headers: setCookie });
  check(badCustomRes.statusCode === 400, 'a malformed custom range refuses with a 400');

  const settingsRes = await setApp.inject({ method: 'GET', url: '/d/settings', headers: setCookie });
  check(settingsRes.statusCode === 200 && settingsRes.body.includes('Settings'), 'GET /d/settings renders');
  check(settingsRes.body.includes('href="/d/export.csv"') && settingsRes.body.includes('href="/d/logout"'), 'settings links the export and logout');
  const savedRes = await setApp.inject({ method: 'GET', url: '/d/settings?saved=1', headers: setCookie });
  check(savedRes.body.includes('Saved'), 'the saved banner renders after the redirect');
  const anonSettings = await setApp.inject({ method: 'GET', url: '/d/settings' });
  check(anonSettings.statusCode === 401, 'settings never render without a session');

  const saveRes = await setApp.inject({ method: 'POST', url: '/d/settings', headers: { ...sameOrigin, ...postForm }, payload: 'action=save_weekly&weekly_report=on' });
  check(saveRes.statusCode === 303 && String(saveRes.headers.location) === '/d/settings?saved=1', 'a same-origin save redirects with the saved flag');
  check(settingsRouteMock.db.profiles.find((row) => row.id === PROFILE.id).weekly_report_opt_in === true, 'the dashboard write is the SAME column the weekly worker reads (D5)');
  const crossOriginRes = await setApp.inject({ method: 'POST', url: '/d/settings', headers: { cookie: 'saka_dash=set-session', host: 'app.sakafleet.test', origin: 'https://evil.example', ...postForm }, payload: 'action=save_weekly' });
  check(crossOriginRes.statusCode === 403 && /another site/.test(crossOriginRes.body), 'a cross-origin POST is refused with 403 (D2 / rule 51 iv)');
  check(settingsRouteMock.db.profiles.find((row) => row.id === PROFILE.id).weekly_report_opt_in === true, 'the refused cross-origin write changed nothing');
  const noActionRes = await setApp.inject({ method: 'POST', url: '/d/settings', headers: { ...sameOrigin, ...postForm }, payload: 'weekly_report=on' });
  check(noActionRes.statusCode === 400 && /Nothing to save/.test(noActionRes.body), 'a POST without the action marker saves nothing');
  const anonPost = await setApp.inject({ method: 'POST', url: '/d/settings', headers: { host: 'app.sakafleet.test', origin: 'https://app.sakafleet.test', ...postForm }, payload: 'action=save_weekly&weekly_report=on' });
  check(anonPost.statusCode === 401, 'a same-origin POST without a session 401s');

  const monthlySaveRes = await setApp.inject({ method: 'POST', url: '/d/settings', headers: { ...sameOrigin, ...postForm }, payload: 'action=save_monthly&monthly_report=on' });
  check(monthlySaveRes.statusCode === 303, 'the monthly toggle saves with its own action marker');
  check(settingsRouteMock.db.profiles.find((row) => row.id === PROFILE.id).monthly_report_opt_in === true, 'the monthly write lands on profiles.monthly_report_opt_in');
  check(settingsRouteMock.db.profiles.find((row) => row.id === PROFILE.id).weekly_report_opt_in === true, 'the monthly save never flips the weekly preference');
  const weeklyFlipRes = await setApp.inject({ method: 'POST', url: '/d/settings', headers: { ...sameOrigin, ...postForm }, payload: 'action=save_weekly&weekly_report=off' });
  check(weeklyFlipRes.statusCode === 303 && settingsRouteMock.db.profiles.find((row) => row.id === PROFILE.id).monthly_report_opt_in === true,
    'the weekly save never flips the monthly preference');
  const settingsMonthlyPage = await setApp.inject({ method: 'GET', url: '/d/settings', headers: setCookie });
  check(settingsMonthlyPage.body.includes('Monthly PDF summary') && settingsMonthlyPage.body.includes('value="save_monthly"'),
    'GET /d/settings renders the monthly PDF summary toggle');

  const exportRes = await setApp.inject({ method: 'GET', url: '/d/export.csv', headers: setCookie });
  check(exportRes.statusCode === 200 && /text\/csv/.test(String(exportRes.headers['content-type'])), 'GET /d/export.csv answers text/csv');
  check(/attachment; filename="saka-export-\d{4}-\d{2}-\d{2}\.csv"/.test(String(exportRes.headers['content-disposition'])), 'the export carries a dated filename');
  check(exportRes.body.charCodeAt(0) === 0xFEFF && exportRes.body.includes('# expenses') && exportRes.body.includes('# receipts'), 'the export holds the sectioned data');
  const anonExport = await setApp.inject({ method: 'GET', url: '/d/export.csv' });
  check(anonExport.statusCode === 401, 'the export never renders without a session');
  await setApp.close();

  console.log('\n--- Test 46: role schema + resolveDashboardRole (Phase 15) ---');
  check(DASHBOARD_SQL.includes('session_role text NOT NULL DEFAULT') && DASHBOARD_SQL.includes("DEFAULT 'owner'"), 'the session table carries a role with an owner default');
  check(DASHBOARD_ROLES.join(',') === 'owner,driver,admin', 'the three lanes are pinned');
  const roleMock = (vehicles) => createMockSupabase({ vehicles, profiles: [] });
  const ownerRole = await resolveDashboardRole({
    supabase: roleMock([{ id: 'v-a', owner_id: 'p-owner', assigned_driver_id: 'd-1', status: 'ACTIVE' }]).client,
    profile: { id: 'p-owner', phone_number: '+254700000001' }
  });
  check(ownerRole.role === 'owner' && ownerRole.isOwner === true && ownerRole.isDriver === false, 'an owner resolves to the owner lane');
  const driverRole = await resolveDashboardRole({
    supabase: roleMock([{ id: 'v-a', owner_id: 'p-owner', assigned_driver_id: 'd-1', status: 'ACTIVE' }]).client,
    profile: { id: 'd-1', phone_number: '+254700000002' }
  });
  check(driverRole.role === 'driver' && driverRole.isDriver === true && driverRole.isOwner === false, 'an assigned driver resolves to the driver lane');
  const dualRole = await resolveDashboardRole({
    supabase: roleMock([{ id: 'v-a', owner_id: 'p-both', assigned_driver_id: 'p-both', status: 'ACTIVE' }]).client,
    profile: { id: 'p-both', phone_number: '+254700000003' }
  });
  check(dualRole.role === 'owner' && dualRole.isOwner === true && dualRole.isDriver === true, 'a dual-role profile lands in the owner lane (owner-first, like the WhatsApp lane)');
  const previousSuperadminPhone = process.env.SUPERADMIN_PHONE;
  process.env.SUPERADMIN_PHONE = '+254700000099';
  const adminRole = await resolveDashboardRole({ supabase: roleMock([]).client, profile: { id: 'p-admin', phone_number: '+254700000099' } });
  check(adminRole.role === 'admin' && adminRole.isAdmin === true, 'the superadmin phone resolves to the admin lane');
  check((await resolveDashboardRole({ supabase: null, profile: { id: 'p-x' } })).role === 'owner', 'a missing client degrades to owner');

  console.log('\n--- Test 47: requestDashboardOtp by role (D1/D4) ---');
  const captures = [];
  const captureOtp = async (to, text) => { captures.push({ to, text }); return true; };
  const freeEntitlements = { isTrial: false, isPaid: false };
  const driverProfile = { id: 'd-1', email: 'driver@example.com', email_verified: true, full_name: 'Brian Otieno', phone_number: '+254700000002' };
  const noAssignmentMock = createMockSupabase({ vehicles: [{ id: 'v-a', owner_id: 'p-owner', assigned_driver_id: null, status: 'ACTIVE' }], [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] });
  const noAssignment = await requestDashboardOtp({ supabase: noAssignmentMock.client, phone: driverProfile.phone_number, profile: driverProfile, entitlements: freeEntitlements, role: 'driver', sendOtp: captureOtp });
  check(noAssignment.ok === false && noAssignment.reason === 'no_assignment', 'a driver without a live assignment is refused (D1)');
  const assignedMock = createMockSupabase({ vehicles: [{ id: 'v-a', owner_id: 'p-owner', assigned_driver_id: 'd-1', status: 'ACTIVE' }], [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] });
  const driverAccess = await requestDashboardOtp({ supabase: assignedMock.client, phone: driverProfile.phone_number, profile: driverProfile, entitlements: freeEntitlements, role: 'driver', sendOtp: captureOtp });
  check(driverAccess.ok === true && driverAccess.role === 'driver', 'an assigned driver with a Free account gets a code (the plan gate is owner-only)');
  check(assignedMock.db[DASHBOARD_SESSIONS_TABLE][0].session_role === 'driver', 'the minted row carries the driver role');
  const previousAdminPhoneRole = process.env.SUPERADMIN_PHONE;
  process.env.SUPERADMIN_PHONE = '+254700000099';
  const nonAdminAccess = await requestDashboardOtp({ supabase: assignedMock.client, phone: '+254700000001', profile: { id: 'p-admin', phone_number: '+254700000001' }, role: 'admin', sendOtp: captureOtp });
  check(nonAdminAccess.ok === false && nonAdminAccess.reason === 'not_admin', 'a non-superadmin cannot mint an admin session');
  const adminAccess = await requestDashboardOtp({ supabase: createMockSupabase({ vehicles: [], [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] }).client, phone: '+254700000099', profile: { id: 'p-admin', phone_number: '+254700000099', full_name: 'Admin' }, role: 'admin', sendOtp: captureOtp });
  check(adminAccess.ok === true && adminAccess.role === 'admin', 'the superadmin phone mints an admin session');
  const adminOnOwnerDoor = await requestDashboardOtp({ supabase: createMockSupabase({ vehicles: [], [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] }).client, phone: '+254700000099', profile: { id: 'p-admin', phone_number: '+254700000099', full_name: 'Admin' }, role: 'auto', sendOtp: captureOtp });
  check(adminOnOwnerDoor.ok === false && adminOnOwnerDoor.reason === 'use_admin_login', 'D4: /d/login never mints an admin session');
  if (previousAdminPhoneRole === undefined) delete process.env.SUPERADMIN_PHONE;
  else process.env.SUPERADMIN_PHONE = previousAdminPhoneRole;
  const ownerFree = await requestDashboardOtp({ supabase: assignedMock.client, phone: '+254700000001', profile: { id: 'p-owner', phone_number: '+254700000001', full_name: 'Owner' }, entitlements: freeEntitlements, role: 'owner', sendOtp: captureOtp });
  check(ownerFree.ok === false && ownerFree.reason === 'not_entitled', 'the owner plan gate is unchanged');
  check((await requestDashboardOtp({ supabase: assignedMock.client, phone: driverProfile.phone_number, profile: driverProfile, role: 'wizard', sendOtp: captureOtp })).reason === 'bad_role', 'an unknown role is refused');

  console.log('\n--- Test 48: verifyDashboardOtp re-checks the role (rule 51 i) ---');
  // A driver token whose assignment vanished between mint and verify.
  const revokedMock = createMockSupabase({
    vehicles: [{ id: 'v-a', owner_id: 'p-owner', assigned_driver_id: null, status: 'ACTIVE' }],
    profiles: [{ id: 'd-1', phone_number: '+254700000002' }],
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({ id: 'sess-driver', owner_id: 'd-1', session_role: 'driver', otp_hash: hashToken('123456') })],
    admin_audit_logs: []
  });
  const revoked = await verifyDashboardOtp({ supabase: revokedMock.client, rawToken: 'seed-token', otp: '123456' });
  check(revoked.ok === false && revoked.reason === 'no_assignment', 'a driver whose assignment was withdrawn cannot verify');
  check(revokedMock.db[DASHBOARD_SESSIONS_TABLE][0].verified === false, 'a refused verify stamps nothing');
  // An admin token whose number is no longer the superadmin.
  const adminRevokedMock = createMockSupabase({
    vehicles: [],
    profiles: [{ id: 'p-admin', phone_number: '+254700000001' }],
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({ id: 'sess-admin', owner_id: 'p-admin', session_role: 'admin', otp_hash: hashToken('123456') })],
    admin_audit_logs: []
  });
  const adminRevoked = await verifyDashboardOtp({ supabase: adminRevokedMock.client, rawToken: 'seed-token', otp: '123456' });
  check(adminRevoked.ok === false && adminRevoked.reason === 'not_admin', 'an admin token is re-checked against SUPERADMIN_PHONE');
  // A legacy owner row (no session_role) keeps working and lands as owner.
  const legacyMock = createMockSupabase({
    vehicles: [],
    profiles: [{ id: 'p-owner', phone_number: '+254700000001' }],
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({ id: 'sess-legacy', owner_id: 'p-owner', otp_hash: hashToken('123456') })],
    admin_audit_logs: []
  });
  const legacyVerify = await verifyDashboardOtp({ supabase: legacyMock.client, rawToken: 'seed-token', otp: '123456' });
  check(legacyVerify.ok === true && legacyVerify.role === 'owner', 'a pre-1.76.0 row verifies as owner (rule 56)');
  const legacySession = await getSessionByToken({ supabase: legacyMock.client, sessionToken: legacyVerify.sessionToken });
  check(legacySession.ok === true && legacySession.role === 'owner', 'getSessionByToken returns the role (legacy → owner)');
  const driverVerifyMock = createMockSupabase({
    vehicles: [{ id: 'v-a', owner_id: 'p-owner', assigned_driver_id: 'd-1', status: 'ACTIVE' }],
    profiles: [{ id: 'd-1', phone_number: '+254700000002' }],
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({ id: 'sess-driver-ok', owner_id: 'd-1', session_role: 'driver', otp_hash: hashToken('123456') })],
    admin_audit_logs: []
  });
  const driverVerify = await verifyDashboardOtp({ supabase: driverVerifyMock.client, rawToken: 'seed-token', otp: '123456' });
  check(driverVerify.ok === true && driverVerify.role === 'driver', 'an assigned driver verifies into the driver lane');
  const driverSession = await getSessionByToken({ supabase: driverVerifyMock.client, sessionToken: driverVerify.sessionToken });
  check(driverSession.ok === true && driverSession.role === 'driver', 'the driver session carries its role');
  if (previousSuperadminPhone === undefined) delete process.env.SUPERADMIN_PHONE;
  else process.env.SUPERADMIN_PHONE = previousSuperadminPhone;

  console.log('\n--- Test 49: driver builders (own scope, unmasked docs) ---');
  const laneNow = new Date('2026-11-08T10:00:00.000Z');
  const laneSeed = () => ({
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', make_model: 'Nissan Note', status: 'ACTIVE', assigned_driver_id: 'd-1' },
      { id: 'v-b', owner_id: 'other-owner', plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE', assigned_driver_id: 'd-2' }
    ],
    profiles: [
      { id: 'd-1', full_name: 'Brian Otieno', phone_number: '+254799999991' },
      { id: 'd-2', full_name: 'Grace Wanjiru', phone_number: '+254799999992' }
    ],
    driver_compliances: [
      { id: 'dc1', driver_id: 'd-1', type: 'driving_licence', label: 'Driving Licence', number: 'DL123456', expiry: '2026-11-16' },
      { id: 'dc2', driver_id: 'd-1', type: 'psv_badge', label: 'PSV Badge', number: 'PSV-7788', expiry: '2026-11-06' },
      { id: 'dc9', driver_id: 'd-2', type: 'driving_licence', label: 'Driving Licence', number: 'FX-999', expiry: '2026-11-07' }
    ],
    expense_logs: [
      { id: 'e1', driver_id: 'd-1', vehicle_id: 'v-a', expense_type: 'fuel', amount: 3000, fuel_liters: 30, odometer_reading: 50000, created_at: '2026-11-07T08:00:00.000Z' },
      { id: 'e2', driver_id: 'd-2', vehicle_id: 'v-b', expense_type: 'fuel', amount: 7000, fuel_liters: 50, odometer_reading: 90000, created_at: '2026-11-07T09:00:00.000Z' },
      { id: 'e3', driver_id: 'd-1', vehicle_id: 'v-a', expense_type: 'service', amount: 1200, odometer_reading: 50120, created_at: '2026-11-08T07:00:00.000Z' }
    ],
    private_earnings: [
      { id: 'p1', driver_id: 'd-1', vehicle_id: 'v-a', amount: 4500, created_at: '2026-11-07T18:00:00.000Z' }
    ],
    reminders: [], vehicle_compliances: [], expiry_notification_log: [], passbook_transfers: []
  });
  const laneMock = createMockSupabase(laneSeed());
  const driverHome = await buildDriverHome({ supabase: laneMock.client, driverId: 'd-1', countryInfo: KE_INFO, now: laneNow });
  check(driverHome.ok === true && driverHome.vehicle.plate === 'KDA 123A' && driverHome.vehicle.status === 'ACTIVE', 'the driver home carries the assigned vehicle');
  check(driverHome.compliance.documents.length === 2 && driverHome.compliance.documents.some((doc) => doc.number === 'DL123456'), 'the compliance summary is scoped to THIS driver and unmasked (D3)');
  check(!driverHome.compliance.documents.some((doc) => doc.number === 'FX-999'), "another driver's document never appears");
  check(driverHome.week.kpis.length >= 3, 'the week strip carries engine KPIs');
  check((await buildDriverHome({ supabase: null, driverId: 'd-1' })).ok === false, 'no database answers ok:false');
  const daybookPage = await buildDriverDaybookPageData({ supabase: laneMock.client, driverId: 'd-1', countryInfo: KE_INFO, now: laneNow });
  check(daybookPage.ok === true, 'the driver daybook page builds');
  const daybookJson = JSON.stringify(daybookPage.data);
  check(daybookJson.includes('KDA 123A') && !daybookJson.includes('KDB 456B'), "the daybook carries only the driver's own vehicle");
  check((await buildDriverDaybookPageData({ supabase: createMockSupabase({ vehicles: [] }).client, now: laneNow })).ok === false, 'a daybook page without a driver identity refuses honestly');
  const selfPage = await buildDriverSelfCompliancePage({ supabase: laneMock.client, driverId: 'd-1', countryInfo: KE_INFO, now: laneNow });
  check(selfPage.ok === true && selfPage.vehicle.plate === 'KDA 123A', 'the compliance page carries the vehicle header');
  check(selfPage.documents.length === 2, 'own documents load on the private page');
  check(selfPage.documents.some((doc) => doc.number === 'PSV-7788'), 'the PSV badge number is shown unmasked on the private page');

  console.log('\n--- Test 50: admin builders (owner list + fleet view) ---');
  const adminSeed = () => ({
    ...laneSeed(),
    profiles: [
      ...laneSeed().profiles,
      { id: PROFILE.id, full_name: 'Amina Wanjiku', phone_number: '+254712345678', email: 'amina@example.com', country: 'KE', country_code: 'KE' },
      { id: 'other-owner', full_name: 'John Kamau', phone_number: '+254733333333', email: 'john@example.com', country: 'KE', country_code: 'KE' },
      { id: 'idle-owner', full_name: 'Idle Owner', phone_number: '+254744444444', email: 'idle@example.com', country: 'KE', country_code: 'KE' }
    ],
    vehicles: [
      { id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', make_model: 'Nissan Note', status: 'ACTIVE', assigned_driver_id: 'd-1' },
      { id: 'v-b', owner_id: 'other-owner', plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE', assigned_driver_id: 'd-2' },
      { id: 'v-c', owner_id: 'other-owner', plate_number: 'KDC 789C', make_model: 'Mazda Demio', status: 'PAUSED', assigned_driver_id: null }
    ]
  });
  const ownersList = await buildAdminOwnersList({ supabase: createMockSupabase(adminSeed()).client });
  check(ownersList.ok === true && ownersList.owners.length === 2, 'only owners with a live vehicle are listed (an idle profile never is)');
  check(ownersList.totalOwners === 2, 'the total counts the resulting owners');
  const kamau = ownersList.owners.find((owner) => owner.id === 'other-owner');
  check(kamau.vehicleCount === 2 && kamau.activeCount === 1, 'vehicle + active counts are engine facts');
  check(ownersList.owners.every((owner) => !owner.phoneMasked.includes('3333333')), 'phones are masked in the list');
  check(ownersList.owners[0].name === 'Amina Wanjiku', 'equal active counts sort by name (deterministic order)');
  const searched = await buildAdminOwnersList({ supabase: createMockSupabase(adminSeed()).client, search: 'amina' });
  check(searched.owners.length === 1 && searched.owners[0].id === PROFILE.id, 'search narrows by name');
  check((await buildAdminOwnersList({ supabase: createMockSupabase(adminSeed()).client, search: 'zzz-nobody' })).owners.length === 0, 'a no-match search is empty, never padded');
  const fleet = await buildAdminFleetView({ supabase: createMockSupabase(adminSeed()).client, ownerId: 'other-owner', now: laneNow });
  check(fleet.ok === true && fleet.owner.name === 'John Kamau' && fleet.owner.phoneMasked.includes('•'), 'the fleet view loads the target owner with a masked phone');
  check(fleet.directory?.vehicles?.length === 2, "the fleet view lists that owner's vehicles only");
  check((await buildAdminFleetView({ supabase: createMockSupabase(adminSeed()).client, ownerId: 'nobody' })).reason === 'not_found', 'an unknown owner id is not_found');
  check((await buildAdminFleetView({ supabase: createMockSupabase(adminSeed()).client, ownerId: null })).reason === 'not_found', 'a missing owner id is not_found');

  console.log('\n--- Test 51: driver + admin renderers ---');
  const driverHomeHtml = renderDriverHomePage({ data: driverHome, emailMasked: 'b•••@example.com' });
  check(driverHomeHtml.includes('KDA 123A') && driverHomeHtml.includes('DL123456'), 'the driver home renders the vehicle and unmasked licence');
  check(driverHomeHtml.includes('/d/driver/daybook') && driverHomeHtml.includes('/d/driver/compliance') && driverHomeHtml.includes('Log out'), 'the driver nav links its own pages');
  check(!driverHomeHtml.includes('/d/vehicles') && !driverHomeHtml.includes('/d/settings'), 'the driver page never links owner-only routes');
  const daybookHtml = renderDriverDaybookPage({ page: daybookPage });
  check(daybookHtml.includes('KDA 123A') && !daybookHtml.includes('KDB 456B'), 'the daybook page renders own rows only');
  const selfHtml = renderDriverSelfCompliancePage({ page: selfPage });
  check(selfHtml.includes('PSV-7788') && selfHtml.includes('Driving Licence'), 'the private compliance page renders unmasked numbers');
  check(renderDriverHomePage({ data: { ok: false } }).includes('could not be loaded'), 'a failed load renders the honest 503 page');
  const adminOwnersHtml = renderAdminOwnersPage({ data: ownersList, search: '' });
  check(adminOwnersHtml.includes('/d/admin/owners/other-owner') && adminOwnersHtml.includes('John Kamau'), 'the owners page links each fleet');
  check(adminOwnersHtml.includes('Owners') && adminOwnersHtml.includes('Log out'), 'the admin nav is its own');
  const adminFleetHtml = renderAdminFleetPage({ fleet });
  check(adminFleetHtml.includes('KDB 456B') && adminFleetHtml.includes('John Kamau'), 'the fleet page renders the target fleet');
  check(adminFleetHtml.includes('← Owners') && !adminFleetHtml.includes('/d/admin/logout'), 'the fleet page links back to the list');
  const hostileOwners = renderAdminOwnersPage({ data: { ok: true, totalOwners: 1, owners: [{ id: 'x', name: '<script>alert(1)</script>', phoneMasked: '•••', country: 'KE', vehicleCount: 1, activeCount: 1 }] }, search: '' });
  check(!hostileOwners.includes('<script>alert(1)</script>'), 'owner names are escaped');

  console.log('\n--- Test 51: analytics (tyre wear + cost-per-km) ---');
  const phase19Now = new Date('2026-11-08T06:00:00Z');
  const analyticsSeed = () => ({
    vehicles: [{
      id: 'v-an', owner_id: PROFILE.id, plate_number: 'KAS 628T', make_model: 'Toyota Land Cruiser',
      status: 'ACTIVE', current_mileage: 120000, deleted_at: null
    }],
    expense_logs: [
      { id: 'ax1', vehicle_id: 'v-an', expense_type: 'Tyres', amount: 40000, odometer_reading: 95000, created_at: '2026-09-01T00:00:00Z' },
      { id: 'ax2', vehicle_id: 'v-an', expense_type: 'Fuel', amount: 4000, odometer_reading: 100000, created_at: '2026-10-02T00:00:00Z' },
      { id: 'ax3', vehicle_id: 'v-an', expense_type: 'Fuel', amount: 1000, odometer_reading: 101000, created_at: '2026-10-20T00:00:00Z' },
      { id: 'ax4', vehicle_id: 'v-an', expense_type: 'Fuel', amount: 5000, odometer_reading: 102000, created_at: '2026-11-02T00:00:00Z' },
      { id: 'ax5', vehicle_id: 'v-an', expense_type: 'Fuel', amount: 1000, odometer_reading: 103000, created_at: '2026-11-06T00:00:00Z' }
    ]
  });
  const analytics = await buildAnalyticsPage({
    supabase: createMockSupabase(analyticsSeed()).client,
    ownerId: PROFILE.id,
    profile: PROFILE,
    countryInfo: KE_INFO,
    now: phase19Now
  });
  check(analytics.ok === true && analytics.vehicleCount === 1, 'the analytics page loads the owner fleet');
  check(analytics.tyres.length === 1 && analytics.tyres[0].kmSince === 25000 && analytics.tyres[0].remainingPct === 50,
    '25,000 km since the last tyre change = 50% life remaining (the spec example)');
  check(analytics.tyres[0].replaceSoon === false, '25,000 km does not flag Replace Soon');
  check(analytics.trend.months.length === 6 && analytics.trend.months[5].key === '2026-11', 'the trend ends in the current month');
  check(analytics.trend.months[5].spend === 6000 && analytics.trend.months[5].distance === 1000 && analytics.trend.months[5].costPerKm === 6,
    'November: 6,000 ÷ 1,000 km = 6.00 per km');
  check(analytics.chart.points.length === 2 && analytics.chart.maxValue === 6, 'the SVG chart prices the two moving months');
  check((await buildAnalyticsPage({ supabase: null, ownerId: PROFILE.id })).ok === false, 'no database answers ok:false (honest 503)');
  const analyticsHtml = renderAnalyticsPage({ data: analytics });
  check(analyticsHtml.includes('Analytics') && analyticsHtml.includes('KAS 628T'), 'the page names the vehicle');
  check(analyticsHtml.includes('25,000 km since the last tyre change') && analyticsHtml.includes('~50% life remaining'),
    'the tyre card states the distance and the estimate');
  check(analyticsHtml.includes('progress') && analyticsHtml.includes('width:50%'), 'the progress bar is 50% wide');
  check(analyticsHtml.includes('<svg') && analyticsHtml.includes('<polyline') && analyticsHtml.includes('class="dot"'),
    'the six-month chart is a server-rendered inline SVG (D4)');
  check(analyticsHtml.includes('href="/d/analytics"'), 'the shared nav carries Analytics');
  check(analyticsHtml.includes('Ksh') || analyticsHtml.includes('KES'), 'money renders in the owner currency');
  check(renderAnalyticsPage({ data: { ok: false } }).includes('could not be loaded'), 'a failed analytics load renders one honest explanation');
  const hostileAnalytics = renderAnalyticsPage({ data: { ...analytics, tyres: [{ ...analytics.tyres[0], plate: '<script>alert(1)</script>' }] } });
  check(!hostileAnalytics.includes('<script>alert(1)</script>'), 'analytics plate names are escaped');

  console.log('\n--- Test 51b: the care queue (Amina\'s hand-offs) ---');
  const careStamp = phase19Now.toISOString();
  const careSeed = () => ({
    support_tickets: [
      { id: 't-esc-1', subject: 'Fuel log stuck', sender_email: 'jane@example.com', issue_category: 'logging', status: 'ESCALATED', priority: 'high', ai_draft: 'We are checking this now.', internal_note: 'Amina investigated and escalated', created_at: careStamp, updated_at: careStamp },
      { id: 't-open-1', subject: 'How do I add a driver?', sender_email: 'sam@example.com', issue_category: 'driver', status: 'OPEN', priority: 'medium', ai_draft: null, created_at: careStamp, updated_at: careStamp }
    ],
    support_ticket_messages: [
      { id: 'cm1', ticket_id: 't-esc-1', direction: 'in', channel: 'email', message_body: 'Fuel log stuck', created_at: careStamp },
      { id: 'cm2', ticket_id: 't-esc-1', direction: 'internal', channel: 'ai', message_body: 'Amina checked get_recent_errors → 2 matching errors', created_at: careStamp }
    ],
    care_learnings: [{ id: 'cl1', trigger_context: 'missing receipt', lesson: 'Ask the customer to re-upload the receipt image.', created_at: careStamp }]
  });
  const careQueue = await buildCareQueue({ supabase: createMockSupabase(careSeed()).client });
  check(careQueue.ok === true && careQueue.escalated.length === 1 && careQueue.counts.escalated === 1 && careQueue.counts.open === 1,
    'the queue counts escalated and open tickets');
  check(careQueue.escalated[0].investigation.length === 1 && /get_recent_errors/.test(careQueue.escalated[0].investigation[0].message_body),
    'the investigation log rides the ticket');
  check(careQueue.escalated[0].ai_draft === 'We are checking this now.', "Amina's draft is exposed to the human");
  check(careQueue.learnings.length === 1, 'the newest lessons are listed');
  check((await buildCareQueue({ supabase: null })).ok === false, 'no database answers ok:false');
  const careHtml = renderCareQueuePage({ data: careQueue });
  check(careHtml.includes('Care queue') && careHtml.includes('Fuel log stuck'), 'the queue page lists the escalated ticket');
  check(careHtml.includes('Investigation log') && careHtml.includes('get_recent_errors'), 'the investigation log is rendered');
  check(careHtml.includes('Amina&#39;s draft') || careHtml.includes("Amina's draft"), 'the draft section is rendered');
  check(careHtml.includes('Ask the customer to re-upload'), 'the learned lesson is visible');
  check(careHtml.includes('href="/d/care"') && careHtml.includes('Owners'), 'the admin nav carries Care');
  check(renderCareQueuePage({ data: { ok: false } }).includes('could not be loaded'), 'a failed care load renders one honest explanation');
  const hostileCare = renderCareQueuePage({ data: { ...careQueue, escalated: [{ ...careQueue.escalated[0], subject: '<script>alert(1)</script>' }] } });
  check(!hostileCare.includes('<script>alert(1)</script>'), 'care subject lines are escaped');

  console.log('\n--- Test 52: role-gated routes (D2 isolation + D1 scope) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const sessionExpiry = new Date(Date.now() + 86400000).toISOString();
  const gateSeed = () => ({
    ...adminSeed(),
    profiles: [
      ...adminSeed().profiles,
      { id: 'p-admin', full_name: 'Super Admin', phone_number: '+254700000099', email: 'admin@example.com', country: 'KE', country_code: 'KE' }
    ],
    reminders: [],
    vehicle_compliances: [],
    expiry_notification_log: [],
    passbook_transfers: [],
    [DASHBOARD_SESSIONS_TABLE]: [
      seedRow({ id: 'sess-owner', owner_id: PROFILE.id, email: PROFILE.email, session_token_hash: hashToken('owner-sess'), verified: true, session_expires_at: sessionExpiry, session_role: 'owner' }),
      seedRow({ id: 'sess-driver', owner_id: 'd-1', email: 'driver@example.com', session_token_hash: hashToken('driver-sess'), verified: true, session_expires_at: sessionExpiry, session_role: 'driver' }),
      seedRow({ id: 'sess-admin', owner_id: 'p-admin', email: 'admin@example.com', session_token_hash: hashToken('admin-sess'), verified: true, session_expires_at: sessionExpiry, session_role: 'admin' }),
      seedRow({ id: 'sess-legacy', owner_id: PROFILE.id, email: PROFILE.email, session_token_hash: hashToken('legacy-sess'), verified: true, session_expires_at: sessionExpiry })
    ],
    // v1.80.0 (Phase 19) — the /d/care queue renders from these.
    support_tickets: [
      { id: 'gate-esc-1', subject: 'Fuel log stuck', sender_email: 'jane@example.com', issue_category: 'logging', status: 'ESCALATED', priority: 'high', ai_draft: 'We are checking this now.', internal_note: 'Amina escalated', created_at: phase19Now.toISOString(), updated_at: phase19Now.toISOString() }
    ],
    support_ticket_messages: [
      { id: 'gate-cm1', ticket_id: 'gate-esc-1', direction: 'internal', channel: 'ai', message_body: 'Amina checked get_recent_errors → 1 matching error', created_at: phase19Now.toISOString() }
    ],
    care_learnings: [
      { id: 'gate-cl1', trigger_context: 'missing receipt', lesson: 'Ask for a re-upload.', created_at: phase19Now.toISOString() }
    ],
    admin_audit_logs: []
  });
  const gateMock = createMockSupabase(gateSeed());
  const gateApp = Fastify({ logger: false });
  await registerDashboardRoutes(gateApp, { supabase: gateMock.client });
  await gateApp.ready();
  const ownerCookie = 'saka_dash=owner-sess';
  const driverCookie = 'saka_dash=driver-sess';
  const adminCookie = 'saka_dash=admin-sess';
  const legacyCookie = 'saka_dash=legacy-sess';
  const gateNoCookieDriver = await gateApp.inject({ method: 'GET', url: '/d/driver' });
  check(gateNoCookieDriver.statusCode === 401, 'a driver page without a cookie is 401');
  const gateNoCookieAdmin = await gateApp.inject({ method: 'GET', url: '/d/admin' });
  check(gateNoCookieAdmin.statusCode === 401, 'an admin page without a cookie is 401');
  const driverHomeRes = await gateApp.inject({ method: 'GET', url: '/d/driver', headers: { cookie: driverCookie } });
  check(driverHomeRes.statusCode === 200 && driverHomeRes.body.includes('KDA 123A'), 'a driver session opens its own home');
  check(driverHomeRes.body.includes('DL123456') && !driverHomeRes.body.includes('FX-999'), 'the driver home shows own documents only (D3)');
  const driverDaybookRes = await gateApp.inject({ method: 'GET', url: '/d/driver/daybook', headers: { cookie: driverCookie } });
  check(driverDaybookRes.statusCode === 200 && driverDaybookRes.body.includes('KDA 123A'), 'a driver session opens its own daybook');
  const driverComplianceRes = await gateApp.inject({ method: 'GET', url: '/d/driver/compliance', headers: { cookie: driverCookie } });
  check(driverComplianceRes.statusCode === 200 && driverComplianceRes.body.includes('PSV-7788'), 'a driver session opens its own compliance page, unmasked');
  const driverOnOwner = await gateApp.inject({ method: 'GET', url: '/d/vehicles', headers: { cookie: driverCookie } });
  check(driverOnOwner.statusCode === 403 && /driver/i.test(driverOnOwner.body), 'a driver on an owner page is 403');
  const ownerOnDriver = await gateApp.inject({ method: 'GET', url: '/d/driver', headers: { cookie: ownerCookie } });
  check(ownerOnDriver.statusCode === 403, 'an owner on a driver page is 403');
  const driverOnAdmin = await gateApp.inject({ method: 'GET', url: '/d/admin', headers: { cookie: driverCookie } });
  check(driverOnAdmin.statusCode === 404, 'a driver on the admin surface is 404 (D2)');
  const ownerOnAdmin = await gateApp.inject({ method: 'GET', url: '/d/admin', headers: { cookie: ownerCookie } });
  check(ownerOnAdmin.statusCode === 404 && !/owners/i.test(ownerOnAdmin.body), "an owner on the admin surface is 404 and never sees 'owners'");
  check(gateMock.db.admin_audit_logs.length === 0, 'refused admin attempts write no audit row (nothing was viewed)');
  const legacyOnOwner = await gateApp.inject({ method: 'GET', url: '/d/vehicles', headers: { cookie: legacyCookie } });
  check(legacyOnOwner.statusCode === 200, 'a pre-1.76.0 session keeps the owner lane (rule 56)');
  const legacyOnDriver = await gateApp.inject({ method: 'GET', url: '/d/driver', headers: { cookie: legacyCookie } });
  check(legacyOnDriver.statusCode === 403, 'a legacy session never drifts into the driver lane');

  const adminOwnersRes = await gateApp.inject({ method: 'GET', url: '/d/admin', headers: { cookie: adminCookie } });
  check(adminOwnersRes.statusCode === 200 && adminOwnersRes.body.includes('/d/admin/owners/other-owner'), 'an admin session opens the owner list');
  check(adminOwnersRes.body.includes('John Kamau') && !adminOwnersRes.body.includes('+254733333333'), 'the list names owners with masked phones');
  const ownersAudit = gateMock.db.admin_audit_logs.filter((row) => row.action === 'ADMIN_DASHBOARD_VIEW' && row.details?.page === 'owners');
  check(ownersAudit.length === 1 && ownersAudit[0].admin_phone === '+254700000099', 'the owners view wrote one audit row with the admin phone');
  const adminFleetRes = await gateApp.inject({ method: 'GET', url: '/d/admin/owners/other-owner', headers: { cookie: adminCookie } });
  check(adminFleetRes.statusCode === 200 && adminFleetRes.body.includes('KDB 456B'), 'an admin session opens a target fleet');
  const fleetAudit = gateMock.db.admin_audit_logs.filter((row) => row.action === 'ADMIN_DASHBOARD_VIEW' && row.details?.page === 'fleet');
  check(fleetAudit.length === 1 && fleetAudit[0].details.ownerViewed === 'other-owner' && fleetAudit[0].details.found === true, 'the fleet view audited WHICH owner was viewed');
  const missingFleet = await gateApp.inject({ method: 'GET', url: '/d/admin/owners/nobody-here', headers: { cookie: adminCookie } });
  check(missingFleet.statusCode === 404, 'an unknown owner id renders 404');
  const missingAudit = gateMock.db.admin_audit_logs.filter((row) => row.details?.ownerViewed === 'nobody-here');
  check(missingAudit.length === 1 && missingAudit[0].details.found === false, 'even a not-found view is audited (found:false)');

  // v1.86.0 (Phase 25) — /d/admin/command: admin-only, audited, renders the BI.
  const commandNoCookie = await gateApp.inject({ method: 'GET', url: '/d/admin/command' });
  check(commandNoCookie.statusCode === 401, 'the command center needs a session');
  const commandOwner = await gateApp.inject({ method: 'GET', url: '/d/admin/command', headers: { cookie: ownerCookie } });
  check(commandOwner.statusCode === 404, 'an owner never discovers the command center (404, same as /d/admin)');
  const commandAdmin = await gateApp.inject({ method: 'GET', url: '/d/admin/command', headers: { cookie: adminCookie } });
  check(commandAdmin.statusCode === 200 && /Command center/.test(commandAdmin.body), 'an admin session opens the command center');
  check(commandAdmin.body.includes('Est. MRR') && commandAdmin.body.includes('At-risk accounts'), 'the page carries the revenue KPI and the at-risk table');
  check(commandAdmin.body.includes('/d/admin/command') && commandAdmin.body.includes('Care'), 'the admin nav leads with Command');
  const commandAudit = gateMock.db.admin_audit_logs.filter((row) => row.action === 'ADMIN_DASHBOARD_VIEW' && row.details?.page === 'command');
  check(commandAudit.length === 1 && commandAudit[0].admin_phone === '+254700000099', 'the command view wrote one audit row');

  console.log('\n--- Test 52b: Phase 19 routes (/d/analytics owner, /d/care admin) ---');
  const analyticsNoCookie = await gateApp.inject({ method: 'GET', url: '/d/analytics' });
  check(analyticsNoCookie.statusCode === 401, 'analytics without a cookie is 401');
  const analyticsOwnerRes = await gateApp.inject({ method: 'GET', url: '/d/analytics', headers: { cookie: ownerCookie } });
  check(analyticsOwnerRes.statusCode === 200 && analyticsOwnerRes.body.includes('Analytics'), 'an owner session opens analytics');
  check(analyticsOwnerRes.body.includes('Tyre wear') && analyticsOwnerRes.body.includes('Cost per'), 'the page carries both analytics features');
  const analyticsDriverRes = await gateApp.inject({ method: 'GET', url: '/d/analytics', headers: { cookie: driverCookie } });
  check(analyticsDriverRes.statusCode === 403, 'a driver on analytics is 403');
  const analyticsAdminRes = await gateApp.inject({ method: 'GET', url: '/d/analytics', headers: { cookie: adminCookie } });
  check(analyticsAdminRes.statusCode === 403, 'an admin session never enters the owner analytics lane');
  const careNoCookie = await gateApp.inject({ method: 'GET', url: '/d/care' });
  check(careNoCookie.statusCode === 401, 'the care queue without a cookie is 401');
  const careOwnerRes = await gateApp.inject({ method: 'GET', url: '/d/care', headers: { cookie: ownerCookie } });
  check(careOwnerRes.statusCode === 404 && !/care queue/i.test(careOwnerRes.body), "an owner on the care surface is 404 (never sees 'Care queue')");
  const careDriverRes = await gateApp.inject({ method: 'GET', url: '/d/care', headers: { cookie: driverCookie } });
  check(careDriverRes.statusCode === 404, 'a driver on the care surface is 404');
  const careAdminRes = await gateApp.inject({ method: 'GET', url: '/d/care', headers: { cookie: adminCookie } });
  check(careAdminRes.statusCode === 200 && careAdminRes.body.includes('Fuel log stuck'), 'an admin session opens the escalated queue');
  check(careAdminRes.body.includes('Investigation log') && careAdminRes.body.includes('Ask for a re-upload'),
    'the investigation log + lessons render for the admin');
  const careAudit = gateMock.db.admin_audit_logs.filter((row) => row.action === 'ADMIN_DASHBOARD_VIEW' && row.details?.page === 'care');
  check(careAudit.length === 1 && careAudit[0].details.escalated === 1, 'the care view is audited with its escalated count');

  const adminOnOwner = await gateApp.inject({ method: 'GET', url: '/d', headers: { cookie: adminCookie } });
  check(adminOnOwner.statusCode === 403, 'an admin session never enters the owner lane');
  await gateApp.close();

  console.log('\n--- Test 53: Phase 22 — branding (fonts, logo, lime glow, assets route) ---');
  check(DASHBOARD_ASSET_VERSION === '1.86.0', 'the asset stamp ships with this release (cache-bust)');
  check(DASHBOARD_CSS.includes("@font-face { font-family:'Sora'; font-style:normal; font-weight:600") && DASHBOARD_CSS.includes("@font-face { font-family:'Sora'; font-style:normal; font-weight:700"), 'Sora 600/700 are self-hosted via @font-face');
  check(DASHBOARD_CSS.includes("@font-face { font-family:'Manrope'") && DASHBOARD_CSS.includes('Manrope-700.woff2'), 'Manrope 400/500/700 are self-hosted too');
  check(DASHBOARD_CSS.includes(`url('/d/assets/Sora-600.woff2?v=${DASHBOARD_ASSET_VERSION}')`), 'font URLs ride the allowlisted asset route, version-stamped');
  check(DASHBOARD_CSS.includes('--accent:#B8EF5C') && DASHBOARD_CSS.includes('--accent-dark:#65A30D'), 'the orange accent is retired for lime with a text-safe dark lime');
  check(DASHBOARD_CSS.includes('--glow:0 0 0 1px var(--accent-line)'), 'one glow token powers the green outline');
  check(/input:focus[^{]*\{[^}]*box-shadow:var\(--glow\)/.test(DASHBOARD_CSS), 'focused inputs carry the glowing green ring');
  check(/\.card:hover, \.card:focus-within[^{]*\{[^}]*box-shadow/.test(DASHBOARD_CSS), 'active cards take the same glow');
  check(/button:hover, button:focus-visible[^{]*\{[^}]*box-shadow:var\(--glow\)/.test(DASHBOARD_CSS), 'buttons glow on hover/focus');
  check(DASHBOARD_CSS.includes('@media (max-width: 640px)') && DASHBOARD_CSS.includes('min-height:48px'), 'the phone breakpoint enlarges tap targets');
  check(DASHBOARD_CSS.includes('prefers-reduced-motion'), 'reduced-motion users get no animation');
  check(DASHBOARD_CSS.includes('font-family:var(--font-body)') && DASHBOARD_CSS.includes('font-family:var(--font-display)'), 'body = Manrope, headings = Sora');
  const shellHtml = renderPageShell('Overview', '<p>hi</p>', { headerRight: '<a href="/d/x">X</a>' });
  // v1.94.0 (Phase 31) — the brand target is a shell option (default /d).
  check(shellHtml.includes('class="brand" href="/d"'), 'the shared shell brand defaults to /d (v1.94.0)');
  check(renderPageShell('X', '<p>hi</p>', { brandHref: 'https://sakafleet.com' }).includes('class="brand" href="https://sakafleet.com"'), 'a caller can point the brand at the public site (v1.94.0)');
  check(shellHtml.includes(`/d/assets/logo-lockup.png?v=${DASHBOARD_ASSET_VERSION}`) && shellHtml.includes('width="177" height="18"'), 'the header renders the real brand lockup at its intrinsic ratio');
  check(shellHtml.includes('alt="Saka Fleet"') && shellHtml.includes('class="nav"'), 'the logo is labelled and the nav slot is preserved');
  // v1.95.0 (Phase 32, Task 1) — the drawer: burger + overlay built from the
  // SAME anchors, inert on pages without navigation, banner above it (D2).
  check(shellHtml.includes('class="nav-burger"') && shellHtml.includes('aria-expanded="false"') && shellHtml.includes('aria-controls="navMenu"'), 'the shell renders the burger with its ARIA contract (v1.95.0)');
  check(shellHtml.includes('class="nav-menu"') && shellHtml.includes('role="dialog"') && shellHtml.includes('aria-modal="true"'), 'the drawer is a labelled modal dialog (v1.95.0)');
  check(shellHtml.includes(".querySelectorAll('a')") && shellHtml.includes("event.key === 'Escape'") && shellHtml.includes('window.innerWidth > 1024'), 'the inline script clones .nav anchors, closes on Escape and above 1024px (v1.95.0)');
  check(shellHtml.includes('burger.parentNode.removeChild(burger)'), 'login doors (no nav anchors) never show a dead burger (v1.95.0)');
  check(DASHBOARD_CSS.includes('@media (max-width: 1024px)') && DASHBOARD_CSS.includes('.nav-menu { position:fixed'), 'below 1024px the drawer owns the screen and the strip hides (D1)');
  check(DASHBOARD_CSS.includes('.nav-burger { display:none;') && DASHBOARD_CSS.includes('body.nav-open .nav-menu { display:block; }'), 'the strip stays above 1024px; the drawer opens via body.nav-open (v1.95.0)');
  const impersonatedShell = withImpersonationBanner(shellHtml, { targetName: 'Amina', expiresAt: new Date(Date.now() + 600000).toISOString() });
  check(impersonatedShell.indexOf('as-banner') < impersonatedShell.indexOf('class="nav-menu"'), 'the impersonation banner renders BEFORE the drawer markup (D2, z-index 60 > 50)');
  check(impersonatedShell.includes('🟡 Impersonating') && impersonatedShell.includes('Exit'), 'the banner copy and Exit link are unchanged (v1.91.0)');
  check(shellHtml.includes('theme-color" content="#0A0A0C"') && shellHtml.includes('/d/assets/favicon.svg'), 'the shell carries the brand theme colour and favicon');
  check(shellHtml.includes('noindex'), 'dashboard pages stay noindex');
  check(SAKA_PDF_THEME.brand === '#65A30D' && SAKA_PDF_THEME.lime === '#B8EF5C', 'PDF brand is the text-safe lime; the decorative lime stays separate');
  check(sakaWhatsAppLink('add car') === 'https://wa.me/19404407252?text=add%20car', 'the wa.me deep link uses the verified business number');

  const assetMock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] });
  const assetApp = Fastify({ logger: false });
  await registerDashboardRoutes(assetApp, { supabase: assetMock.client });
  await assetApp.ready();
  const fontRes = await assetApp.inject({ method: 'GET', url: '/d/assets/Sora-600.woff2' });
  check(fontRes.statusCode === 200 && String(fontRes.headers['content-type']).includes('font/woff2'), 'GET /d/assets/Sora-600.woff2 answers the real woff2');
  check(String(fontRes.headers['cache-control']).includes('immutable') && fontRes.headers['x-content-type-options'] === 'nosniff', 'fonts are cached immutably with nosniff');
  check(fontRes.rawPayload.length > 1000 && fontRes.rawPayload.subarray(0, 4).toString() === 'wOF2', 'the served font is a real WOFF2 payload');
  const logoRes = await assetApp.inject({ method: 'GET', url: '/d/assets/logo-lockup.png' });
  check(logoRes.statusCode === 200 && String(logoRes.headers['content-type']).includes('image/png') && logoRes.rawPayload.subarray(1, 4).toString() === 'PNG', 'the brand lockup serves as image/png');
  const unknownAsset = await assetApp.inject({ method: 'GET', url: '/d/assets/secrets.env' });
  check(unknownAsset.statusCode === 404, 'a filename outside the allowlist is 404');
  const traversalAsset = await assetApp.inject({ method: 'GET', url: '/d/assets/..%2F..%2Fpackage.json' });
  check(traversalAsset.statusCode === 404, 'traversal is impossible by construction (not on the allowlist)');
  const faviconRes = await assetApp.inject({ method: 'GET', url: '/d/assets/favicon.svg' });
  check(faviconRes.statusCode === 200 && String(faviconRes.headers['content-type']).includes('image/svg+xml'), 'the SVG favicon is allowlisted too');
  await assetApp.close();

  console.log('\n--- Test 54: Phase 22 — /d/transfer (owner steps 1-3, buyer stays on WhatsApp) ---');
  const dayMs = 24 * 60 * 60 * 1000;
  const p22OwnerProfile = {
    id: 'p22-owner',
    // v1.83.0 — a +1 number keeps the suite OFFLINE: buildGlobalContext derives
    // the currency from the phone's country (rule 7), and USD needs no FX fetch.
    phone_number: '+19405550123',
    email: 'p22@example.com',
    full_name: 'Phase Owner',
    subscription_tier: 'growth',
    subscription_status: 'ACTIVE',
    subscription_period_end: new Date(Date.now() + 20 * dayMs).toISOString(),
    currency: 'USD',
    country_code: 'US',
    unit_system: 'imperial'
  };
  const p22Seed = () => ({
    [DASHBOARD_SESSIONS_TABLE]: [
      { id: 'sess-p22-owner', token_hash: hashToken('p22-token'), session_token_hash: hashToken('p22-session'), owner_id: 'p22-owner', email: 'p22@example.com', verified: true, session_expires_at: new Date(Date.now() + dayMs).toISOString(), session_role: 'owner', attempts: 0 },
      { id: 'sess-p22-driver', token_hash: hashToken('p22-dtoken'), session_token_hash: hashToken('p22-driver-session'), owner_id: 'p22-driver', verified: true, session_expires_at: new Date(Date.now() + dayMs).toISOString(), session_role: 'driver', attempts: 0 }
    ],
    profiles: [
      p22OwnerProfile,
      { id: 'p22-driver', phone_number: '+254722000999', full_name: 'Phase Driver' }
    ],
    vehicles: [
      { id: 'v-p22-1', owner_id: 'p22-owner', plate_number: 'KDA 123A', make_model: 'Toyota Hiace', status: 'ACTIVE', deleted_at: null, assigned_driver_id: null },
      { id: 'v-p22-2', owner_id: 'p22-owner', plate_number: 'KDB 456B', make_model: 'Isuzu NQR', status: 'ACTIVE', deleted_at: null, assigned_driver_id: null }
    ],
    passbook_transfers: [
      { id: 'tr-open', vehicle_id: 'v-p22-1', vin: 'VINP220001', from_owner_id: 'p22-owner', status: 'PENDING_BUYER_ACCEPTANCE', to_owner_phone: '+254799000222', to_owner_email: 'buyer@example.com', is_free_transfer: true, fee_amount: 0, fee_currency: 'USD', initiated_at: new Date(Date.now() - dayMs).toISOString() },
      { id: 'tr-done', vehicle_id: 'v-p22-2', vin: 'VINP220002', from_owner_id: 'p22-owner', status: 'COMPLETED', to_owner_phone: '+254798000333', is_free_transfer: true, initiated_at: new Date(Date.now() - 3 * dayMs).toISOString(), completed_at: new Date(Date.now() - 2 * dayMs).toISOString() },
      { id: 'tr-foreign', vehicle_id: 'v-someone-else', vin: 'VINP220003', from_owner_id: 'someone-else', status: 'PENDING_BUYER_ACCEPTANCE', is_free_transfer: true, initiated_at: new Date(Date.now() - dayMs).toISOString() }
    ],
    subscriptions: [
      { id: 'sub-p22', owner_id: 'p22-owner', tier: 'growth', interval: 'monthly', status: 'ACTIVE', plan_code: 'PLAN_GROWTH_M', paystack_subscription_code: 'SUB_P22', created_at: new Date(Date.now() - 10 * dayMs).toISOString() }
    ],
    paystack_webhook_events: [],
    admin_audit_logs: []
  });
  const p22Mock = createMockSupabase(p22Seed());
  const p22Calls = { send: [], verify: [], tier: [], addon: [] };
  let p22BadCheckout = false;
  const p22Notifier = {
    async sendReleaseOtp({ transferId, buyerPhone, buyerEmail }) {
      p22Calls.send.push({ transferId, buyerPhone, buyerEmail });
      await p22Mock.client.from('passbook_transfers')
        .update({ status: 'PENDING_OWNER_RELEASE_OTP', to_owner_phone: buyerPhone, to_owner_email: buyerEmail })
        .eq('id', transferId);
      return { success: true, buyerPhone, buyerEmail, ownerEmail: 'p22@example.com' };
    },
    async verifyReleaseOtp({ transferId, providedOtp, sendWhatsAppFn }) {
      p22Calls.verify.push({ transferId, providedOtp, hasSender: typeof sendWhatsAppFn === 'function' });
      if (providedOtp !== '424242') return { success: false, error: 'Invalid 6-digit release PIN. Please check your email and try again.' };
      await p22Mock.client.from('passbook_transfers').update({ status: 'PENDING_BUYER_ACCEPTANCE' }).eq('id', transferId);
      return { success: true, buyerPhone: '+254799000222', plateNumber: 'KDA 123A' };
    }
  };
  const p22Checkout = {
    async tier(args) {
      p22Calls.tier.push(args);
      return p22BadCheckout
        ? { ok: true, checkoutUrl: 'http://insecure.example/pay' }
        : { ok: true, checkoutUrl: 'https://checkout.paystack.com/p22-tier', reference: 'ref-p22' };
    },
    async addon(args) {
      p22Calls.addon.push(args);
      return { ok: true, checkoutUrl: 'https://checkout.paystack.com/p22-addon', amountUSD: 3.99, quantity: args.addonQuantity };
    }
  };
  const p22App = Fastify({ logger: false });
  await registerDashboardRoutes(p22App, { supabase: p22Mock.client, transferNotifier: p22Notifier, checkoutEngine: p22Checkout });
  await p22App.ready();
  const p22OwnerCookie = { cookie: 'saka_dash=p22-session' };
  const p22DriverCookie = { cookie: 'saka_dash=p22-driver-session' };
  const p22Form = { 'content-type': 'application/x-www-form-urlencoded' };

  const transferNoCookie = await p22App.inject({ method: 'GET', url: '/d/transfer' });
  check(transferNoCookie.statusCode === 401, 'the transfer page needs a session');
  const transferDriver = await p22App.inject({ method: 'GET', url: '/d/transfer', headers: p22DriverCookie });
  check(transferDriver.statusCode === 403, 'a driver never enters the owner transfer page');
  const transferPage = await p22App.inject({ method: 'GET', url: '/d/transfer', headers: p22OwnerCookie });
  check(transferPage.statusCode === 200 && transferPage.body.includes('Passbook transfer'), 'an owner session opens the transfer page');
  // v1.86.0 (Phase 25) — the handover reading follows the fleet's meter.
  const transferReadingsFor = (meterId) => renderTransferPage({
    data: {
      ok: true,
      generatedAt: new Date('2026-11-08T09:00:00Z').toISOString(),
      locale: 'en-KE',
      timeZone: 'Africa/Nairobi',
      currency: 'KES',
      ownerEmailAvailable: true,
      ownerEmailMasked: 'a***a@example.com',
      handoverMeter: { meterId, meterLabel: meterId === 'engine_hours' ? 'Engine hours' : meterId === 'distance' ? 'Odometer' : 'Reading' },
      vehicles: [{ id: 'v-1', plate: 'KDA 123A', makeModel: 'Toyota', meterId }],
      transfers: []
    }
  });
  check(transferReadingsFor('distance').includes('Odometer at handover'), 'a road fleet asks the odometer at handover');
  check(transferReadingsFor('engine_hours').includes('Engine hours at handover') && !transferReadingsFor('engine_hours').includes('>Odometer at handover<'), 'an hours-led fleet asks engine hours (never an odometer)');
  check(transferReadingsFor('mixed').includes('Handover reading (odometer or engine hours, optional)'), 'a mixed garage asks the honest handover reading');
  check(transferReadingsFor('distance').includes('var meters = {"v-1":"distance"}'), 'the label follows the vehicle picker (inline meter map)');
  check(transferReadingsFor('engine_hours').includes('id="transferVehicle"') && transferReadingsFor('engine_hours').includes("picker.addEventListener('change', sync)"), 'the page re-labels when another vehicle is chosen');
  check(transferPage.body.includes('KDA 123A') && transferPage.body.includes('KDB 456B'), 'the vehicle picker lists the owner fleet');
  check(transferPage.body.includes('Waiting for the buyer&#39;s ACCEPT on WhatsApp') && transferPage.body.includes('Cancel transfer'), 'the in-flight handover shows its honest status and a cancel action');
  check(transferPage.body.includes(maskPhone('+254799000222')) && !transferPage.body.includes('+254799000222'), 'the buyer phone is masked, never shown raw');
  check(!transferPage.body.includes('release_otp') && !transferPage.body.includes('buyer_otp'), 'no OTP column ever reaches the page');
  check(transferPage.body.includes('How a handover works') && transferPage.body.includes('ACCEPT'), 'the page teaches the full 5-step machine');
  check(transferPage.body.includes('href="/d/subscription"') && transferPage.body.includes('href="/d/transfer"'), 'the nav carries the new Transfer + Subscription destinations');

  const startBadPhone = await p22App.inject({ method: 'POST', url: '/d/transfer/start', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'vehicle_id=v-p22-1&buyer_phone=12&buyer_email=buyer%40example.com' });
  check(startBadPhone.statusCode === 400 && /incomplete/.test(startBadPhone.body), 'an incomplete buyer number is refused warmly');
  const startForeignVehicle = await p22App.inject({ method: 'POST', url: '/d/transfer/start', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'vehicle_id=v-someone-else&buyer_phone=%2B254799000222&buyer_email=buyer%40example.com' });
  check(startForeignVehicle.statusCode === 400 && /Pick one of your live vehicles/.test(startForeignVehicle.body), "another owner's vehicle can never start a handover");
  const startCrossOrigin = await p22App.inject({ method: 'POST', url: '/d/transfer/start', headers: { ...p22OwnerCookie, ...p22Form, origin: 'https://evil.example' }, payload: 'vehicle_id=v-p22-1&buyer_phone=%2B254799000222&buyer_email=buyer%40example.com' });
  check(startCrossOrigin.statusCode === 400 && /open the transfer page again/.test(startCrossOrigin.body), 'a cross-origin start is refused (CSRF defence in depth)');

  const startOk = await p22App.inject({ method: 'POST', url: '/d/transfer/start', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'vehicle_id=v-p22-2&buyer_phone=%2B254799000222&buyer_email=buyer%40example.com&odometer=50350' });
  const startedLocation = String(startOk.headers.location || '');
  const startedId = decodeURIComponent((startedLocation.match(/pin=([^&]+)/) || [])[1] || '');
  check(startOk.statusCode === 303 && startedLocation.includes('/d/transfer?started=1&pin='), 'a valid start redirects with the transfer id');
  check(p22Calls.send.length === 1 && p22Calls.send[0].buyerPhone === '+254799000222' && p22Calls.send[0].buyerEmail === 'buyer@example.com', 'the machine received the buyer phone + email verbatim');
  const startedRow = (p22Mock.db.passbook_transfers || []).find((row) => row.id === startedId);
  check(Boolean(startedRow) && startedRow.from_owner_id === 'p22-owner' && startedRow.status === 'PENDING_OWNER_RELEASE_OTP', 'the transfer row belongs to the owner and awaits the release PIN');
  check((p22Mock.db.odometer_readings || []).some((row) => row.vehicle_id === 'v-p22-2' && Number(row.reading) === 50350 && row.label === 'handover'), 'the optional handover odometer lands in the ledger');

  const pinPage = await p22App.inject({ method: 'GET', url: startedLocation, headers: p22OwnerCookie });
  check(pinPage.statusCode === 200 && pinPage.body.includes('Enter your release PIN'), 'the PIN box renders for the transfer awaiting a release PIN');
  const verifyBadShape = await p22App.inject({ method: 'POST', url: '/d/transfer/verify', headers: { ...p22OwnerCookie, ...p22Form }, payload: `transfer_id=${encodeURIComponent(startedId)}&otp=abc` });
  check(verifyBadShape.statusCode === 400 && /6-digit release PIN/.test(verifyBadShape.body), 'a non 6-digit PIN is refused before any lookup');
  const verifyWrong = await p22App.inject({ method: 'POST', url: '/d/transfer/verify', headers: { ...p22OwnerCookie, ...p22Form }, payload: `transfer_id=${encodeURIComponent(startedId)}&otp=111111` });
  check(verifyWrong.statusCode === 400 && /Invalid 6-digit release PIN/.test(verifyWrong.body), 'a wrong release PIN re-renders the PIN box with the engine copy');
  const verifyForeign = await p22App.inject({ method: 'POST', url: '/d/transfer/verify', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'transfer_id=tr-foreign&otp=424242' });
  check(verifyForeign.statusCode === 404, "another owner's transfer answers 404 (existence never confirmed)");
  const verifyOk = await p22App.inject({ method: 'POST', url: '/d/transfer/verify', headers: { ...p22OwnerCookie, ...p22Form }, payload: `transfer_id=${encodeURIComponent(startedId)}&otp=424242` });
  check(verifyOk.statusCode === 303 && String(verifyOk.headers.location).includes('verified=1'), 'the correct PIN authorises the release');
  check(p22Calls.verify.length === 2 && p22Calls.verify[1].hasSender === true, 'the WhatsApp sender is handed to the machine (buyer notification)');
  check((p22Mock.db.passbook_transfers || []).find((row) => row.id === startedId).status === 'PENDING_BUYER_ACCEPTANCE', 'the transfer moved to the buyer-acceptance step');

  const verifyPage = await p22App.inject({ method: 'GET', url: '/d/transfer?verified=1', headers: p22OwnerCookie });
  check(verifyPage.statusCode === 200 && /Release authorised/.test(verifyPage.body), 'the verified redirect explains the buyer handshake');
  const cancelForeign = await p22App.inject({ method: 'POST', url: '/d/transfer/cancel', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'transfer_id=tr-foreign' });
  check(cancelForeign.statusCode === 404, "another owner's transfer can never be cancelled");
  const cancelOk = await p22App.inject({ method: 'POST', url: '/d/transfer/cancel', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'transfer_id=tr-open' });
  check(cancelOk.statusCode === 303 && String(cancelOk.headers.location).includes('cancelled=1'), 'cancel redirects with the notice');
  check((p22Mock.db.passbook_transfers || []).find((row) => row.id === 'tr-open').status === 'CANCELLED', 'the cancel is a status transition, never a delete');
  check((p22Mock.db.passbook_transfers || []).find((row) => row.id === 'tr-done').status === 'COMPLETED', 'a completed handover is never touched');
  // v1.87.5 — the cancel write must name ONLY real columns. The old payload set
  // `updated_at` (never a passbook_transfers column), PostgREST refused it and
  // the route still redirected ?cancelled=1 — the handover stayed in-flight and
  // blocked every new transfer (live 2026-11-09).
  const cancelPatches = (p22Mock.state.updates || []).filter((entry) => entry.table === 'passbook_transfers' && entry.patch?.status === 'CANCELLED');
  check(cancelPatches.length === 1 && !('updated_at' in cancelPatches[0].patch), 'the cancel write carries no phantom updated_at column (v1.87.5)');
  // A refused write answers honestly — never a fake success.
  const p22CancelFailMock = createMockSupabase(p22Seed(), { beforeUpdate: (table) => (table === 'passbook_transfers' ? { error: { message: "Could not find the column 'nope'" } } : null) });
  const p22CancelFailApp = Fastify({ logger: false });
  await registerDashboardRoutes(p22CancelFailApp, { supabase: p22CancelFailMock.client, transferNotifier: p22Notifier, checkoutEngine: p22Checkout });
  await p22CancelFailApp.ready();
  const cancelFailed = await p22CancelFailApp.inject({ method: 'POST', url: '/d/transfer/cancel', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'transfer_id=tr-open' });
  check(cancelFailed.statusCode === 500 && /could not be cancelled just now/.test(cancelFailed.body), 'a refused cancel answers honestly, never a fake ?cancelled=1 (v1.87.5)');
  check((p22CancelFailMock.db.passbook_transfers || []).find((row) => row.id === 'tr-open').status === 'PENDING_BUYER_ACCEPTANCE', 'a refused cancel leaves the transfer status untouched (v1.87.5)');
  await p22CancelFailApp.close();
  // v1.87.5 — every PENDING status blocks a second handover; the buyer-upgrade
  // pause was missing from the machine's guard.
  const upgradeMock = createMockSupabase({
    ...p22Seed(),
    passbook_transfers: [
      { id: 'tr-upgrade', vehicle_id: 'v-p22-1', vin: 'VINP220001', from_owner_id: 'p22-owner', status: 'PENDING_BUYER_UPGRADE', to_owner_phone: '+254799000222', to_owner_email: 'buyer@example.com', is_free_transfer: true, fee_amount: 0, fee_currency: 'USD', initiated_at: new Date().toISOString() }
    ]
  });
  const upgradeApp = Fastify({ logger: false });
  await registerDashboardRoutes(upgradeApp, { supabase: upgradeMock.client, transferNotifier: p22Notifier, checkoutEngine: p22Checkout });
  await upgradeApp.ready();
  const upgradeStart = await upgradeApp.inject({ method: 'POST', url: '/d/transfer/start', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'vehicle_id=v-p22-1&buyer_phone=%2B254799000222&buyer_email=buyer%40example.com' });
  check(upgradeStart.statusCode === 409 && /already an active transfer/.test(upgradeStart.body), 'a buyer-upgrade-paused handover still blocks a second one (v1.87.5)');
  await upgradeApp.close();

  // Phone-only owner (no email anywhere): the release PIN cannot be delivered.
  const noEmailMock = createMockSupabase({
    ...p22Seed(),
    profiles: [{ ...p22OwnerProfile, email: null }]
  });
  const noEmailApp = Fastify({ logger: false });
  await registerDashboardRoutes(noEmailApp, { supabase: noEmailMock.client, transferNotifier: p22Notifier, checkoutEngine: p22Checkout });
  await noEmailApp.ready();
  const noEmailPage = await noEmailApp.inject({ method: 'GET', url: '/d/transfer', headers: p22OwnerCookie });
  check(noEmailPage.statusCode === 200 && noEmailPage.body.includes('Add an email first'), 'a phone-only owner is told to add an email first');
  check(!noEmailPage.body.includes('Start a handover'), 'the start form is withheld when the PIN cannot be delivered');
  const noEmailStart = await noEmailApp.inject({ method: 'POST', url: '/d/transfer/start', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'vehicle_id=v-p22-1&buyer_phone=%2B254799000222&buyer_email=buyer%40example.com' });
  check(noEmailStart.statusCode === 400 && /Add an email first/.test(noEmailStart.body), 'the server refuses the start too (never a stranded transfer)');
  await noEmailApp.close();

  console.log('\n--- Test 55: Phase 22 — /d/subscription (plan, capacity, checkouts, history) ---');
  const subNoCookie = await p22App.inject({ method: 'GET', url: '/d/subscription' });
  check(subNoCookie.statusCode === 401, 'the subscription page needs a session');
  const subDriver = await p22App.inject({ method: 'GET', url: '/d/subscription', headers: p22DriverCookie });
  check(subDriver.statusCode === 403, 'a driver never enters the owner subscription page');
  const subPage = await p22App.inject({ method: 'GET', url: '/d/subscription', headers: p22OwnerCookie });
  check(subPage.statusCode === 200 && subPage.body.includes('Your plan'), 'an owner session opens the subscription page');
  check(subPage.body.includes('Growth Fleet') && subPage.body.includes('Active') && subPage.body.includes('Billed monthly'), 'the plan card names the tier, status and interval');
  check(subPage.body.includes('Vehicles:') && subPage.body.includes('of <strong>5</strong>'), 'the capacity line shows used of entitled slots');
  check(subPage.body.includes('Add a vehicle on WhatsApp') && subPage.body.includes('https://wa.me/19404407252?text=add%20car'), 'the Add Vehicle button is the wa.me deep link (quiz engine owns registration)');
  check(subPage.body.includes('Growth Fleet · Monthly') && subPage.body.includes('SUB_P22'), 'the billing history reads the owner-scoped subscriptions ledger');
  check(subPage.body.includes('Paystack confirms payments in the background'), 'the page never claims a payment outcome (rule 28)');
  const subReturn = await p22App.inject({ method: 'GET', url: '/d/subscription?reference=ref-123', headers: p22OwnerCookie });
  check(subReturn.statusCode === 200 && subReturn.body.includes('reference ref-123') && subReturn.body.includes('We&#39;re back from checkout'), 'returning from checkout shows the reference, not a fake success');
  const subXss = await p22App.inject({ method: 'GET', url: '/d/subscription?reference=%3Cscript%3Ealert(1)%3C%2Fscript%3E', headers: p22OwnerCookie });
  check(!subXss.body.includes('<script>alert') && subXss.body.includes('&lt;script&gt;'), 'the checkout reference is escaped');

  const checkoutNoTier = await p22App.inject({ method: 'POST', url: '/d/subscription/checkout', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'interval=monthly' });
  check(checkoutNoTier.statusCode === 400 && /Pick a plan/.test(checkoutNoTier.body), 'a checkout without a plan is refused');
  const checkoutOk = await p22App.inject({ method: 'POST', url: '/d/subscription/checkout', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'tier=team_fleet&interval=annual' });
  check(checkoutOk.statusCode === 303 && String(checkoutOk.headers.location) === 'https://checkout.paystack.com/p22-tier', 'the engine checkout URL is followed (303)');
  check(p22Calls.tier.length === 1 && p22Calls.tier[0].targetTierKey === 'team_fleet' && p22Calls.tier[0].interval === 'annual', 'the engine receives the chosen tier + interval verbatim');
  check(p22Calls.tier[0].callbackUrl === 'https://app.sakafleet.test/d/subscription', 'the callback returns to /d/subscription (PUBLIC_APP_URL base)');
  check(p22Calls.tier[0].currency === 'USD' && p22Calls.tier[0].owner.id === 'p22-owner', "the checkout carries the owner's currency + id");
  const checkoutCrossOrigin = await p22App.inject({ method: 'POST', url: '/d/subscription/checkout', headers: { ...p22OwnerCookie, ...p22Form, origin: 'https://evil.example' }, payload: 'tier=team_fleet' });
  check(checkoutCrossOrigin.statusCode === 400 && /open the subscription page again/.test(checkoutCrossOrigin.body), 'a cross-origin checkout is refused');
  p22BadCheckout = true;
  const checkoutInsecure = await p22App.inject({ method: 'POST', url: '/d/subscription/checkout', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'tier=team_fleet' });
  check(checkoutInsecure.statusCode === 502 && /payment page could not be opened/.test(checkoutInsecure.body), 'a non-HTTPS checkout URL is refused (no open redirect)');
  p22BadCheckout = false;

  // At capacity: the Add Vehicle link becomes the upgrade prompt (engine prices).
  const freeOwner = { ...p22OwnerProfile, id: 'p22-free', subscription_tier: 'free', subscription_status: 'ACTIVE', subscription_period_end: null };
  const freeMock = createMockSupabase({
    ...p22Seed(),
    [DASHBOARD_SESSIONS_TABLE]: [
      { id: 'sess-p22-free', token_hash: hashToken('p22-free-token'), session_token_hash: hashToken('p22-free-session'), owner_id: 'p22-free', email: 'p22@example.com', verified: true, session_expires_at: new Date(Date.now() + dayMs).toISOString(), session_role: 'owner', attempts: 0 }
    ],
    profiles: [freeOwner],
    vehicles: [{ id: 'v-free-1', owner_id: 'p22-free', plate_number: 'KCF 111A', status: 'ACTIVE', deleted_at: null }],
    passbook_transfers: [],
    subscriptions: []
  });
  const freeApp = Fastify({ logger: false });
  await registerDashboardRoutes(freeApp, { supabase: freeMock.client, transferNotifier: p22Notifier, checkoutEngine: p22Checkout });
  await freeApp.ready();
  const freeCookie = { cookie: 'saka_dash=p22-free-session' };
  const freePage = await freeApp.inject({ method: 'GET', url: '/d/subscription', headers: freeCookie });
  check(freePage.statusCode === 200 && freePage.body.includes('Free') && freePage.body.includes('of <strong>1</strong>'), 'a Free owner sees the Free plan and its single slot');
  check(freePage.body.includes('plan is full at 1 of 1 vehicle(s)') && !freePage.body.includes('Add a vehicle on WhatsApp'), 'at capacity the Add Vehicle link is replaced by the upgrade prompt');
  check(freePage.body.includes('Upgrade to Solo Pro') && freePage.body.includes('/d/subscription/checkout'), 'the upgrade form names the next tier with its engine price');
  const freeCheckout = await freeApp.inject({ method: 'POST', url: '/d/subscription/checkout', headers: { ...freeCookie, ...p22Form }, payload: 'tier=solo_pro&interval=monthly' });
  check(freeCheckout.statusCode === 303, 'a Free owner can start the next-tier checkout');
  await freeApp.close();

  // Fleet Command at capacity: add-on slots are sold from the same page.
  const fleetOwner = { ...p22OwnerProfile, id: 'p22-fleet', subscription_tier: 'fleet_command', subscription_status: 'ACTIVE', addon_quantity: 0 };
  const p22FleetMock = createMockSupabase({
    ...p22Seed(),
    [DASHBOARD_SESSIONS_TABLE]: [
      { id: 'sess-p22-fleet', token_hash: hashToken('p22-fleet-token'), session_token_hash: hashToken('p22-fleet-session'), owner_id: 'p22-fleet', email: 'p22@example.com', verified: true, session_expires_at: new Date(Date.now() + dayMs).toISOString(), session_role: 'owner', attempts: 0 }
    ],
    profiles: [fleetOwner],
    vehicles: [1, 2, 3, 4, 5].map((n) => ({ id: `v-fleet-${n}`, owner_id: 'p22-fleet', plate_number: `KCF 00${n}A`, status: 'ACTIVE', deleted_at: null })),
    passbook_transfers: [],
    subscriptions: []
  });
  const fleetApp = Fastify({ logger: false });
  await registerDashboardRoutes(fleetApp, { supabase: p22FleetMock.client, transferNotifier: p22Notifier, checkoutEngine: p22Checkout });
  await fleetApp.ready();
  const fleetCookie = { cookie: 'saka_dash=p22-fleet-session' };
  const fleetPage = await fleetApp.inject({ method: 'GET', url: '/d/subscription', headers: fleetCookie });
  check(fleetPage.statusCode === 200 && fleetPage.body.includes('Fleet Command') && fleetPage.body.includes('plan is full at 5 of 5 vehicle(s)'), 'Fleet Command at capacity is named honestly');
  check(fleetPage.body.includes('Extra vehicle slots') && fleetPage.body.includes('USD 3.99'), 'the add-on card prices extra slots from the engine');
  const addonCallsBefore = p22Calls.addon.length;
  const addonOk = await fleetApp.inject({ method: 'POST', url: '/d/subscription/addon', headers: { ...fleetCookie, ...p22Form }, payload: 'quantity=2' });
  check(addonOk.statusCode === 303 && String(addonOk.headers.location) === 'https://checkout.paystack.com/p22-addon', 'the add-on checkout is followed (303)');
  check(p22Calls.addon.length === addonCallsBefore + 1 && p22Calls.addon[addonCallsBefore].addonQuantity === 2 && p22Calls.addon[addonCallsBefore].callbackUrl.endsWith('/d/subscription'), 'the engine receives the slot quantity and the dashboard callback');
  await fleetApp.close();

  const addonNotEligible = await p22App.inject({ method: 'POST', url: '/d/subscription/addon', headers: { ...p22OwnerCookie, ...p22Form }, payload: 'quantity=1' });
  check(addonNotEligible.statusCode === 400 && /Fleet Command add-on/.test(addonNotEligible.body), 'add-ons are refused outside Fleet Command');
  await p22App.close();

  console.log('\n--- Test 39: Phase 23 — the stored document vault on the dashboard ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const p23Docs = [
    { id: 'doc-own', vehicle_id: 'v-a', document_type: 'insurance', storage_path: 'v-a/own.pdf', original_filename: 'cover.pdf', media_id: 'm-own', uploaded_by: PROFILE.id, uploaded_at: new Date().toISOString() },
    { id: 'doc-free', vehicle_id: 'v-a', document_type: 'logbook', storage_path: null, original_filename: null, media_id: 'm-free', uploaded_by: PROFILE.id, uploaded_at: new Date().toISOString() },
    { id: 'doc-foreign', vehicle_id: 'v-x', document_type: 'insurance', storage_path: 'v-x/x.pdf', media_id: 'm-x', uploaded_by: 'someone-else', uploaded_at: new Date().toISOString() }
  ];
  const docPageData = await buildVehiclePage({
    supabase: createMockSupabase(recordsSeed()).client,
    ownerId: PROFILE.id,
    vehicleId: 'v-a',
    countryInfo: KE_INFO,
    loadDetail: async () => detail,
    loadDocuments: async () => p23Docs.filter((doc) => doc.vehicle_id === 'v-a')
  });
  check(docPageData.ok === true && docPageData.storedDocuments.length === 2, 'buildVehiclePage attaches the stored documents (additive, never hides the page)');
  // v1.87.4 — the DEFAULT loader must be called with the real
  // `listVehicleDocuments(client, options)` convention. No loadDocuments is
  // injected here, so the convention itself is under test (live 2026-11-09: the
  // one-object call shipped an empty "Stored files" section on every vehicle page).
  const docPageReal = await buildVehiclePage({
    supabase: createMockSupabase({ ...recordsSeed(), vehicle_documents: p23Docs.map((doc) => ({ ...doc })) }).client,
    ownerId: PROFILE.id,
    vehicleId: 'v-a',
    countryInfo: KE_INFO,
    loadDetail: async () => detail
  });
  check(docPageReal.ok === true && docPageReal.storedDocuments.length === 2, 'the default loader runs the real listVehicleDocuments(supabase, options) query (v1.87.4)');
  check(docPageReal.replacedCount === 0 && Array.isArray(docPageReal.replacedDocuments), 'the replaced-file history fields ride the page (v1.87.4)');
  const docPageHtml = renderVehiclePage({ data: { ...detail, vehicle: { ...detail.vehicle, plate: 'KDA 123A' }, storedDocuments: p23Docs }, emailMasked: 'a***a@example.com' });
  check(docPageHtml.includes('Stored files') && docPageHtml.includes('Insurance certificate'), 'the vehicle page renders the Stored files section');
  check(docPageHtml.includes('href="/d/documents/doc-own"') && docPageHtml.includes('action="/d/documents/doc-own/delete"'), 'each file links to its signed view and a delete form');
  check(docPageHtml.includes('parsed only (Free plan keeps the figures, not the file)'), 'a file-less Free row is labelled honestly');
  check(docPageHtml.includes('confirm('), 'the dashboard delete asks for confirmation');
  const docBoard = await buildComplianceBoard({
    supabase: createMockSupabase({ vehicle_documents: p23Docs }).client,
    ownerId: PROFILE.id,
    countryInfo: KE_INFO,
    loadReport: async () => ({ ok: true, data: { generatedAt: new Date().toISOString(), currency: 'KES', timeZone: 'Africa/Nairobi', totals: { monitored: 1, active: 1, expiring30Days: 0, expired: 0 }, expiryItems: [{ subjectType: 'vehicle', plate: 'KDA 123A', categoryLabel: 'Insurance', daysLeft: 40 }] } }),
    loadVehicles: async () => [{ id: 'v-a', owner_id: PROFILE.id, plate_number: 'KDA 123A', status: 'ACTIVE' }]
  });
  check(docBoard.ok === true && docBoard.vehicles[0].docCount === 2, 'the compliance board counts stored files per vehicle');
  const docBoardHtml = renderCompliancePage({ board: docBoard, filters: { view: 'all' }, emailMasked: 'a***a@example.com' });
  check(docBoardHtml.includes('<th class="num">Files</th>') && docBoardHtml.includes('>2</a>'), 'the compliance page renders the Files column with the count link');

  const p23Mock = createMockSupabase({
    ...recordsSeed(),
    [DASHBOARD_SESSIONS_TABLE]: [seedRow({ id: 'sess-p23', token_hash: hashToken('p23-link'), session_token_hash: hashToken('p23-session'), verified: true, session_expires_at: new Date(Date.now() + 86400000).toISOString() })],
    vehicle_documents: p23Docs.map((doc) => ({ ...doc })),
    admin_audit_logs: [],
    error_logs: [],
    profiles: [{ id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country_code: 'KE' }]
  });
  const p23Signed = [];
  p23Mock.client.storage = {
    from: (bucket) => ({
      createSignedUrl: async (path, ttl) => {
        p23Signed.push({ bucket, path, ttl });
        return { data: { signedUrl: `https://storage.test/${bucket}/${path}?signed=1` }, error: null };
      },
      remove: async (paths) => ({ data: paths, error: null })
    })
  };
  const p23App = Fastify({ logger: false });
  await registerDashboardRoutes(p23App, { supabase: p23Mock.client });
  await p23App.ready();
  const p23Cookie = { cookie: 'saka_dash=p23-session' };

  const docAnon = await p23App.inject({ method: 'GET', url: '/d/documents/doc-own' });
  check(docAnon.statusCode === 401, 'the document route needs a session');
  const docOwn = await p23App.inject({ method: 'GET', url: '/d/documents/doc-own', headers: p23Cookie });
  check(docOwn.statusCode === 302 && /signed=1/.test(String(docOwn.headers.location)), 'the owner document redirects to a signed URL');
  check(p23Signed.at(-1)?.bucket === 'documents' && p23Signed.at(-1)?.path === 'v-a/own.pdf' && p23Signed.at(-1)?.ttl === 300, 'the signed URL is minted from storage_path with a 300-second TTL');
  const docFree = await p23App.inject({ method: 'GET', url: '/d/documents/doc-free', headers: p23Cookie });
  check(docFree.statusCode === 404, 'a Free row with no file answers an honest 404');
  const signedBeforeForeign = p23Signed.length;
  const docForeign = await p23App.inject({ method: 'GET', url: '/d/documents/doc-foreign', headers: p23Cookie });
  check(docForeign.statusCode === 404 && p23Signed.length === signedBeforeForeign, "another owner's document answers 404 and never mints a link");
  const docMissing = await p23App.inject({ method: 'GET', url: '/d/documents/nope', headers: p23Cookie });
  check(docMissing.statusCode === 404, 'an unknown document id answers 404');

  const crossOriginDelete = await p23App.inject({ method: 'POST', url: '/d/documents/doc-own/delete', headers: { ...p23Cookie, origin: 'https://evil.example', host: 'localhost:80' }, payload: '' });
  check(crossOriginDelete.statusCode === 403, 'a cross-origin delete is refused (nothing changed)');
  check(p23Mock.db.vehicle_documents.some((doc) => doc.id === 'doc-own'), 'the refused delete left the row intact');
  const foreignDelete = await p23App.inject({ method: 'POST', url: '/d/documents/doc-foreign/delete', headers: p23Cookie, payload: '' });
  check(foreignDelete.statusCode === 404, "another owner's document cannot be deleted through the dashboard");
  const ownDelete = await p23App.inject({ method: 'POST', url: '/d/documents/doc-own/delete', headers: p23Cookie, payload: '' });
  check(ownDelete.statusCode === 303 && String(ownDelete.headers.location) === '/d/vehicles/v-a', 'the owner delete redirects back to the vehicle page');
  check(!p23Mock.db.vehicle_documents.some((doc) => doc.id === 'doc-own'), 'the deleted document row is gone');
  check((p23Mock.db.admin_audit_logs || []).some((row) => row.action === 'VEHICLE_DOCUMENT_DELETED' && row.details?.document_id === 'doc-own'), 'the dashboard delete is audited VEHICLE_DOCUMENT_DELETED');
  const anonDelete = await p23App.inject({ method: 'POST', url: '/d/documents/doc-free/delete', payload: '' });
  check(anonDelete.statusCode === 401, 'the delete route never acts without a session');
  await p23App.close();

  console.log('\n--- Test 70: kind-aware dashboard (v1.85.0) ---');
  const genVehicle = { id: 'v-gen', owner_id: PROFILE.id, plate_number: null, make_model: 'Cummins 60kVA', asset_kind: 'generator', operating_hours: 1240, current_mileage: null, status: 'ACTIVE', deleted_at: null };
  const roadVehicle = { id: 'v-road', owner_id: PROFILE.id, plate_number: 'KAS 628T', make_model: 'Toyota Land Cruiser', asset_kind: 'vehicle', current_mileage: 120000, odometer_reading: 120000, status: 'ACTIVE', deleted_at: null };
  const kindNow = new Date('2026-11-08T06:00:00Z');
  const kindExpenses = [
    { id: 'kx1', vehicle_id: 'v-road', expense_type: 'Fuel', amount: 6000, odometer_reading: 100000, created_at: '2026-11-02T00:00:00Z' },
    { id: 'kx2', vehicle_id: 'v-road', expense_type: 'Fuel', amount: 4000, odometer_reading: 101000, created_at: '2026-11-06T00:00:00Z' },
    { id: 'kx3', vehicle_id: 'v-gen', expense_type: 'Fuel', amount: 6000, notes: 'Engine hours: 100 h', created_at: '2026-11-02T00:00:00Z' },
    { id: 'kx4', vehicle_id: 'v-gen', expense_type: 'Fuel', amount: 9000, notes: 'Engine hours: 140 h', created_at: '2026-11-06T00:00:00Z' }
  ];
  const kindPage = await buildAnalyticsPage({
    supabase: createMockSupabase({ vehicles: [genVehicle, roadVehicle], expense_logs: kindExpenses }).client,
    ownerId: PROFILE.id, profile: PROFILE, countryInfo: KE_INFO, now: kindNow
  });
  check(kindPage.ok === true && kindPage.hasRoad === true && kindPage.hasHours === true, 'a mixed fleet flags both road and hours analytics');
  check(kindPage.tyres.length === 1 && kindPage.tyres[0].plate === 'KAS 628T', 'tyre wear covers ONLY the road asset');
  check(kindPage.hoursTrend && kindPage.hoursTrend.months.find((month) => month.key === '2026-11').costPerHour === 375, 'the generator gets cost per operating hour (15,000 ÷ 40 h)');
  const genIntervals = await buildAnalyticsPage({
    supabase: createMockSupabase({ vehicles: [genVehicle], expense_logs: kindExpenses.filter((row) => row.vehicle_id === 'v-gen') }).client,
    ownerId: PROFILE.id, profile: PROFILE, countryInfo: KE_INFO, now: kindNow,
    loadReminders: async () => [{ id: 'r-k', vehicle_id: 'v-gen', reminder_type: 'Generator service', threshold_unit: 'hours', target_value: 1500, last_service_value: 1000, remaining_value: 260, status: 'active' }]
  });
  check(genIntervals.hasRoad === false && genIntervals.tyres.length === 0, 'a generator-only fleet NEVER sees tyre cards');
  check(genIntervals.trend === null && genIntervals.chart === null, 'a generator-only fleet never builds cost per km');
  check(genIntervals.serviceIntervals.length === 1 && genIntervals.serviceIntervals[0].currentHours === 1240, 'hours-led service intervals ride the page model');
  const genHtml = renderAnalyticsPage({ data: genIntervals });
  check(!genHtml.includes('Tyre wear') && genHtml.includes('Service intervals') && genHtml.includes('Cost per operating hour trend'), 'the page renders hours blocks and hides tyre wear');
  const roadOnlyHtml = renderAnalyticsPage({ data: { ...genIntervals, hasHours: false, hasRoad: true, tyres: [], trend: { months: [], totalSpend: 0, totalDistance: 0, averageCostPerKm: null, peakCostPerKm: null }, chart: null, serviceIntervals: [], hoursTrend: null, hoursChart: null } });
  check(roadOnlyHtml.includes('Tyre wear') && !roadOnlyHtml.includes('Service intervals'), 'a road-only fleet renders tyres and hides service intervals');
  const metered = attachMeterReadings([
    { vehicleId: 'v-road', odometer: 120000, kind: 'expense', at: '2026-11-06T00:00:00Z' },
    { vehicleId: 'v-gen', odometer: null, raw: { notes: 'Engine hours: 140 h' }, kind: 'expense', at: '2026-11-06T00:00:00Z' }
  ], [roadVehicle, genVehicle]);
  check(metered.meterLabel === 'Reading' && metered.rows[0].meter === 120000 && metered.rows[1].meter === 140, 'row meters follow each asset (odometer vs engine hours)');
  check(recordsMeterLabel([genVehicle]) === 'Engine hours' && recordsMeterLabel([roadVehicle]) === 'Odometer' && recordsMeterLabel([]) === 'Reading', 'the meter label resolves for hours / road / empty fleets');
  const genCsv = serializeRecordsCsv(metered.rows, { currency: 'KES', meterLabel: 'Engine hours' });
  check(genCsv.split('\r\n')[0].includes('Engine hours'), 'the records CSV header follows the fleet meter');
  check(renderImportPage({ readingLabel: 'Engine hours', preview: { rows: [], counts: { total: 0, valid: 0, invalid: 0 } } }).includes('<th>Engine hours</th>'), 'the import preview is labelled for an hours-led fleet');
  const genListHtml = renderVehiclesPage({ data: { ok: true, generatedAt: kindNow.toISOString(), currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', distanceUnit: 'km', vehicles: [{ id: 'v-gen', plate: 'Cummins 60kVA', meterLabel: 'Engine hours', meterValue: 1240, meterUnit: 'h', monthSpend: 0, driverName: null, status: 'active', active: true }] }, emailMasked: 'a***a@example.com' });
  check(genListHtml.includes('Engine hours 1,240 h') && !genListHtml.includes('Odometer'), 'the vehicles list renders the kind-aware meter');
  const genPageHtml = renderVehiclePage({ data: { ok: true, generatedAt: kindNow.toISOString(), currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', vehicle: { meterLabel: 'Engine hours', meterValue: 1240, meterUnit: 'h', monthSpend: 0, monthEarnings: 0 }, documents: [], records: [] }, emailMasked: 'a***a@example.com' });
  check(genPageHtml.includes('Engine hours') && !genPageHtml.includes('>Odometer<'), 'the vehicle page KPI label follows the kind');
  // v1.86.0 (Phase 25) — a renewal supersedes the old file; the page offers the history.
  const replacedPageHtml = renderVehiclePage({
    data: {
      ok: true,
      generatedAt: kindNow.toISOString(),
      currency: 'KES',
      locale: 'en-KE',
      timeZone: 'Africa/Nairobi',
      vehicle: { id: 'v-1', meterLabel: 'Odometer', meterValue: 120000, meterUnit: 'km', monthSpend: 0, monthEarnings: 0 },
      documents: [],
      records: [],
      storedDocuments: [{ id: 'd-new', document_type: 'insurance', storage_path: 'v-1/new.pdf', uploaded_at: '2026-11-01T00:00:00Z' }],
      replacedCount: 2,
      showReplaced: false,
      replacedDocuments: []
    },
    emailMasked: 'a***a@example.com'
  });
  check(replacedPageHtml.includes('Show replaced (2)') && replacedPageHtml.includes('/d/vehicles/v-1?docs=all'), 'the vehicle page offers the replaced-file history');
  check(!replacedPageHtml.includes('<h2>Replaced files</h2>'), 'the history stays hidden until asked');
  const historyPageHtml = renderVehiclePage({
    data: {
      ok: true,
      generatedAt: kindNow.toISOString(),
      currency: 'KES',
      locale: 'en-KE',
      timeZone: 'Africa/Nairobi',
      vehicle: { id: 'v-1', meterLabel: 'Odometer', meterValue: 120000, meterUnit: 'km', monthSpend: 0, monthEarnings: 0 },
      documents: [],
      records: [],
      storedDocuments: [{ id: 'd-new', document_type: 'insurance', storage_path: 'v-1/new.pdf', uploaded_at: '2026-11-01T00:00:00Z' }],
      replacedCount: 2,
      showReplaced: true,
      replacedDocuments: [{ id: 'd-old', document_type: 'insurance', storage_path: 'v-1/old.pdf', uploaded_at: '2026-05-01T00:00:00Z' }]
    },
    emailMasked: 'a***a@example.com'
  });
  check(historyPageHtml.includes('<h2>Replaced files</h2>') && historyPageHtml.includes('replaced'), 'every replaced file is listed with its own chip');
  check(historyPageHtml.includes('Hide replaced files') && historyPageHtml.includes('/d/vehicles/v-1"'), 'the toggle goes back to the current list');
  check(DASHBOARD_ASSET_VERSION === '1.86.0', 'the asset cache-bust stamp is 1.86.0');
  // v1.86.0 (Phase 25) — centered/responsive contract.
  check(DASHBOARD_CSS.includes('--page-max:1040px') && DASHBOARD_CSS.includes('max-width:var(--page-max); margin:0 auto'), 'one centered page column for the header and the content');
  check(DASHBOARD_CSS.includes('header.bar .bar-inner') && genPageHtml.includes('<div class="bar-inner">'), 'the header shares that column (bar-inner)');
  check(DASHBOARD_CSS.includes('justify-content:center') && DASHBOARD_CSS.includes('.kpi { text-align:center; }'), 'KPI cards are centered');
  check(DASHBOARD_CSS.includes('overflow-x:auto') && DASHBOARD_CSS.includes('linear-gradient(to left'), 'wide tables scroll inside the card with a soft fade');
  check(DASHBOARD_CSS.includes('flex-wrap:nowrap; overflow-x:auto'), 'the mobile nav is one horizontal swipe strip');
  check(DASHBOARD_CSS.includes('img, svg { max-width:100%; height:auto; }'), 'no image can overflow a phone width');
  check(!/#0EA5E9/i.test(DASHBOARD_CSS), 'no stray teal brand colour survived the standardization');

  console.log('\n--- v1.87.2: the Resend quota banner ---');
  const baseCommandData = {
    ok: true,
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    revenue: null,
    userHealth: null,
    support: null,
    ai: null,
    alerts: []
  };
  const quotaBanner = renderAdminCommandPage({ data: { ...baseCommandData, email: { quotaWarnedAt: '2026-11-09', quotaWarnedToday: true } } });
  check(quotaBanner.includes('Resend quota exhausted today') && quotaBanner.includes('#ef4444'), 'an active quota warning renders the red banner (v1.87.2)');
  const staleBanner = renderAdminCommandPage({ data: { ...baseCommandData, email: { quotaWarnedAt: '2026-11-08', quotaWarnedToday: false } } });
  check(!staleBanner.includes('Resend quota exhausted today'), 'a stale (previous-day) marker renders no banner (v1.87.2)');
  // v1.96.4 — the command page names the registered/vehicle gap (mirrors the digest).
  const healthPage = renderAdminCommandPage({
    data: {
      ...baseCommandData,
      userHealth: { totalProfiles: 7, registered: 6, withVehicles: 2, activeWithZeroAssets: 4, shells: 1, emailUnverified: 1, expiredTrialsNotConverted30d: 1 }
    }
  });
  check(healthPage.includes('With vehicles <span class="chip">2</span>'), 'the command page renders the with-vehicles count (v1.96.4)');
  check(healthPage.includes('Registered with 0 assets <span class="chip">4</span>'), 'the command page renders the 0-asset gap beside it (v1.96.4)');

  console.log('\n--- Test 71: Phase 32 — dual-role lane toggle + vehicle picker (v1.95.0) ---');
  const p32Dual = { id: 'p-dual', phone_number: '+254700111222', email: 'dual@example.com', email_verified: true, full_name: 'Dual Owner', country_code: 'KE', subscription_tier: 'solo_pro', subscription_status: 'ACTIVE' };
  const p32FreeDual = { ...p32Dual, id: 'p-dual-free', email: 'freedual@example.com', phone_number: '+254700111333', subscription_tier: 'free', subscription_status: 'ACTIVE' };
  const p32OwnerOnly = { ...p32Dual, id: 'p-owner-only', email: 'owneronly@example.com', phone_number: '+254700111444' };
  const p32DriverOnly = { ...p32Dual, id: 'p-driver-only', email: 'driveronly@example.com', phone_number: '+254700111555', subscription_tier: 'free', subscription_status: 'ACTIVE' };
  const p32Vehicles = [
    { id: 'v-dual-own', owner_id: 'p-dual', assigned_driver_id: 'someone-else', plate_number: 'KDA 111A', status: 'ACTIVE', deleted_at: null },
    { id: 'v-dual-assigned', owner_id: 'other-owner', assigned_driver_id: 'p-dual', plate_number: 'KDB 222B', status: 'ACTIVE', deleted_at: null },
    { id: 'v-dual-assigned2', owner_id: 'other-owner', assigned_driver_id: 'p-dual', plate_number: 'KDC 333C', status: 'ACTIVE', deleted_at: null },
    { id: 'v-owner-only', owner_id: 'p-owner-only', plate_number: 'KDE 444D', status: 'ACTIVE', deleted_at: null },
    { id: 'v-free-dual', owner_id: 'p-dual-free', plate_number: 'KDF 555E', status: 'ACTIVE', deleted_at: null },
    { id: 'v-free-assigned', owner_id: 'other-owner', assigned_driver_id: 'p-dual-free', plate_number: 'KDG 666F', status: 'ACTIVE', deleted_at: null },
    { id: 'v-driver-only', owner_id: 'other-owner', assigned_driver_id: 'p-driver-only', plate_number: 'KDH 777G', status: 'ACTIVE', deleted_at: null }
  ];
  const p32Session = (id, ownerId, token, role) => seedRow({ id, owner_id: ownerId, session_token_hash: hashToken(token), verified: true, session_expires_at: new Date(Date.now() + 86400000).toISOString(), session_role: role });
  const p32Mock = createMockSupabase({
    profiles: [p32Dual, p32FreeDual, p32OwnerOnly, p32DriverOnly],
    vehicles: p32Vehicles,
    [DASHBOARD_SESSIONS_TABLE]: [
      p32Session('sess-dual-owner', 'p-dual', 'dual-owner-session', 'owner'),
      p32Session('sess-dual-driver', 'p-dual', 'dual-driver-session', 'driver'),
      p32Session('sess-dual-page', 'p-dual', 'dual-page-session', 'driver'),
      p32Session('sess-owner-only', 'p-owner-only', 'owner-only-session', 'owner'),
      p32Session('sess-free-dual', 'p-dual-free', 'free-dual-session', 'owner'),
      p32Session('sess-driver-only', 'p-driver-only', 'driver-only-session', 'driver')
    ],
    trial_sessions: [], usage_counters: [], subscriptions: [], passbook_transfers: [],
    admin_audit_logs: [], admin_impersonations: [], receipts: [], expense_logs: [], private_earnings: [],
    vehicle_compliances: [], driver_compliances: [], vehicle_documents: [], reminders: [], error_logs: [], user_context_cache: []
  });
  const p32App = Fastify({ logger: false });
  await registerDashboardRoutes(p32App, { supabase: p32Mock.client });
  await p32App.ready();
  const p32DualOwnerCookie = { cookie: 'saka_dash=dual-owner-session' };
  const p32DualDriverCookie = { cookie: 'saka_dash=dual-driver-session' };
  const p32DualPageCookie = { cookie: 'saka_dash=dual-page-session' };
  const p32Form = { 'content-type': 'application/x-www-form-urlencoded', host: 'app.sakafleet.test', origin: 'https://app.sakafleet.test' };

  const p32Roles = await resolveDashboardRole({ supabase: p32Mock.client, profile: { id: 'p-dual' } });
  check(p32Roles.role === 'owner' && p32Roles.isOwner === true && p32Roles.isDriver === true, 'a dual-role profile resolves BOTH flags, owner lane first (v1.95.0)');

  const p32Overview = await p32App.inject({ method: 'GET', url: '/d', headers: p32DualOwnerCookie });
  check(p32Overview.body.includes('class="lane-switch"') && p32Overview.body.includes('value="owner"') && p32Overview.body.includes('value="driver"'), 'a dual-role session sees the Owner · Driver strip (v1.95.0)');
  check(p32Overview.body.includes('class="chip lane-chip active"') && p32Overview.body.includes('aria-current="true"'), 'the active lane is highlighted from the session role (v1.95.0)');
  const p32OwnerOnlyOverview = await p32App.inject({ method: 'GET', url: '/d', headers: { cookie: 'saka_dash=owner-only-session' } });
  check(!p32OwnerOnlyOverview.body.includes('class="lane-switch"'), 'an owner-only profile gets no toggle (v1.95.0)');
  const p32DriverOnlyDriver = await p32App.inject({ method: 'GET', url: '/d/driver', headers: { cookie: 'saka_dash=driver-only-session' } });
  check(!p32DriverOnlyDriver.body.includes('class="lane-switch"'), 'a driver-only profile gets no toggle either (v1.95.0)');

  const p32ToDriver = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { ...p32DualOwnerCookie, ...p32Form }, payload: 'lane=driver' });
  check(p32ToDriver.statusCode === 303 && String(p32ToDriver.headers.location) === '/d/driver', 'switching to the driver lane 303s to /d/driver');
  check(p32Mock.db[DASHBOARD_SESSIONS_TABLE].find((row) => row.id === 'sess-dual-owner').session_role === 'driver', 'the session ROW itself carries the new lane (D3 — no new cookie)');
  const p32BackToOwner = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { ...p32DualDriverCookie, ...p32Form }, payload: 'lane=owner' });
  check(p32BackToOwner.statusCode === 303 && String(p32BackToOwner.headers.location) === '/d', 'switching back to the owner lane 303s to /d');
  check(p32Mock.db[DASHBOARD_SESSIONS_TABLE].find((row) => row.id === 'sess-dual-driver').session_role === 'owner', 'the driver session row flips to owner');

  const p32OwnerToDriver = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { cookie: 'saka_dash=owner-only-session', ...p32Form }, payload: 'lane=driver' });
  check(p32OwnerToDriver.statusCode === 403, 'an owner-only profile cannot switch into the driver lane');
  const p32DriverToOwner = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { cookie: 'saka_dash=driver-only-session', ...p32Form }, payload: 'lane=owner' });
  check(p32DriverToOwner.statusCode === 403, 'a driver-only profile cannot switch into the owner lane');
  const p32FreeToDriver = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { cookie: 'saka_dash=free-dual-session', ...p32Form }, payload: 'lane=driver' });
  check(p32FreeToDriver.statusCode === 303, 'a Free dual-role driver may open the driver lane (a driver is not a payer)');
  const p32FreeToOwner = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { cookie: 'saka_dash=free-dual-session', ...p32Form }, payload: 'lane=owner' });
  check(p32FreeToOwner.statusCode === 403 && /live trial or paid plan/.test(p32FreeToOwner.body), 'the owner lane keeps its plan gate on every switch (v1.95.0)');
  const p32BadLane = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { ...p32DualOwnerCookie, ...p32Form }, payload: 'lane=admin' });
  check(p32BadLane.statusCode === 400, 'an unknown lane is refused');
  const p32CrossOriginLane = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { ...p32DualOwnerCookie, ...p32Form, origin: 'https://evil.example' }, payload: 'lane=driver' });
  check(p32CrossOriginLane.statusCode === 403 && /another site/.test(p32CrossOriginLane.body), 'a cross-origin lane switch is refused (D2)');
  const p32ImpersonatedLane = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: { ...p32DualOwnerCookie, ...p32Form, cookie: 'saka_dash=dual-owner-session; saka_dash_as=deadbeef' }, payload: 'lane=driver' });
  check(p32ImpersonatedLane.statusCode === 403 && /Exit impersonation to switch lanes/.test(p32ImpersonatedLane.body), 'impersonation overrides the toggle — switching is refused (D3)');
  const p32NoCookieLane = await p32App.inject({ method: 'POST', url: '/d/lane/switch', headers: p32Form, payload: 'lane=driver' });
  check(p32NoCookieLane.statusCode === 401, 'the lane switch never runs without a session');

  const p32PageWithPicker = await p32App.inject({ method: 'GET', url: '/d/driver', headers: p32DualPageCookie });
  check(p32PageWithPicker.body.includes('class="vehicle-switch"') && p32PageWithPicker.body.includes('KDB 222B') && p32PageWithPicker.body.includes('KDC 333C'), 'a driver with TWO assignments gets the vehicle picker (v1.95.0)');
  check(!p32PageWithPicker.body.includes('KDA 111A'), 'the picker never lists a vehicle the driver does not drive');
  const p32ForeignPick = await p32App.inject({ method: 'GET', url: '/d/driver?vehicle=v-dual-own', headers: p32DualPageCookie });
  check(p32ForeignPick.statusCode === 403 && /not assigned to you/.test(p32ForeignPick.body), '?vehicle with an unassigned id is a 403, never a fallback');
  const p32OwnPick = await p32App.inject({ method: 'GET', url: '/d/driver?vehicle=v-dual-assigned', headers: p32DualPageCookie });
  check(p32OwnPick.statusCode !== 403 && /KDB 222B/.test(p32OwnPick.body), '?vehicle with an assigned id renders that vehicle');
  const p32SinglePickHtml = renderDriverHomePage({
    data: { ok: true, vehicle: null, compliance: { kpis: [], documents: [] }, week: { kpis: [], ledger: null }, currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' },
    vehicles: [{ id: 'v-one', plate_number: 'KDA 999Z' }],
    activeVehicleId: null
  });
  check(!p32SinglePickHtml.includes('class="vehicle-switch"'), 'one assignment renders no picker at all');
  await p32App.close();

  process.env.DASHBOARD_ENABLED = previousFlag;
  if (previousBase === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = previousBase;
  console.log(`\n🎉 ${passed} dashboard assertions passed.`);
  console.log('Stateless suite: in-memory mock only; nothing was written to the database.');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
