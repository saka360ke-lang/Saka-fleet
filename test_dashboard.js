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
  requestDashboardAccess,
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
  renderOverviewPage,
  renderVehiclesPage,
  renderVehiclePage,
  renderOtpPage,
  renderErrorPage
} from './src/services/dashboard.js';
import { upcomingExpiryItems, buildVehicleDirectory, buildVehicleDetail } from './src/services/fleetReports.js';
import { detectCountryFromPhone } from './src/services/globalization.js';
import { extractPdfText } from './src/services/pdfTextExtractor.js';
import { registerDashboardRoutes } from './src/routes/dashboard.js';

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
  const emptyMock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] });
  const baseRequest = {
    supabase: emptyMock.client,
    ownerId: PROFILE.id,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendEmail: async () => true
  };
  check((await requestDashboardAccess({ ...baseRequest, ownerId: null })).reason === 'db_error', 'a missing owner id is refused');
  check((await requestDashboardAccess({ ...baseRequest, profile: { ...PROFILE, email: '' } })).reason === 'no_email', 'a profile without an email is refused');
  check((await requestDashboardAccess({ ...baseRequest, profile: { ...PROFILE, email_verified: false } })).reason === 'email_unverified', 'an unverified email is refused');
  check((await requestDashboardAccess({ ...baseRequest, entitlements: null })).reason === 'not_entitled', 'missing entitlements are refused');
  check((await requestDashboardAccess({ ...baseRequest, entitlements: { isTrial: false, isPaid: false } })).reason === 'not_entitled', 'a free (or lapsed PAST_DUE) account is refused');
  check(emptyMock.state.inserts.length === 0, 'no auth row is created for a refused request');
  const paid = await requestDashboardAccess({ ...baseRequest, entitlements: { isTrial: false, isPaid: true } });
  check(paid.ok === true, 'a paid account passes the gate');

  console.log('\n--- Test 4: request mints a link + code, stores hashes only ---');
  const mock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] });
  let emailPayload = null;
  const access = await requestDashboardAccess({
    supabase: mock.client,
    ownerId: PROFILE.id,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendEmail: async (payload) => { emailPayload = payload; return true; }
  });
  check(access.ok === true, 'a trial account receives access');
  const rawToken = access.link.split('/').pop();
  check(access.link.startsWith('https://app.sakafleet.test/d/'), 'the magic link rides PUBLIC_APP_URL + /d/');
  check(emailPayload && emailPayload.to === PROFILE.email, 'the email goes to the verified address');
  check(emailPayload && /^\d{6}$/.test(emailPayload.otp), 'the email carries a 6-digit code');
  check(rawToken.length === 64, 'the raw token is 32 bytes of hex');
  check(emailPayload.link === access.link, 'the emailed link is exactly the returned link');
  const row = mock.db[DASHBOARD_SESSIONS_TABLE][0];
  check(row.token_hash === hashToken(rawToken) && row.token_hash !== rawToken, 'the link token is stored as sha256 (never raw)');
  check(row.otp_hash === hashToken(emailPayload.otp) && row.otp_hash !== emailPayload.otp, 'the OTP is stored as sha256 (never raw)');
  const serialized = JSON.stringify(mock.db[DASHBOARD_SESSIONS_TABLE]);
  check(!serialized.includes(rawToken) && !serialized.includes(emailPayload.otp), 'no raw token or code exists anywhere in the database rows');
  const linkTtl = new Date(row.link_expires_at).getTime() - new Date(row.created_at).getTime();
  check(Math.abs(linkTtl - DASHBOARD_LINK_TTL_MS) < 5000, 'the link TTL is 15 minutes');
  const otpTtl = new Date(row.otp_expires_at).getTime() - new Date(row.created_at).getTime();
  check(Math.abs(otpTtl - DASHBOARD_OTP_TTL_MS) < 5000, 'the OTP TTL is 10 minutes');

  console.log('\n--- Test 5: 60-second resend cooldown ---');
  const cooldown = await requestDashboardAccess({
    supabase: mock.client,
    ownerId: PROFILE.id,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendEmail: async () => true
  });
  check(cooldown.ok === false && cooldown.reason === 'cooldown', 'a second request within 60 seconds answers cooldown');
  check(mock.db[DASHBOARD_SESSIONS_TABLE].length === 1, 'the cooldown never inserts a second row');

  console.log('\n--- Test 6: email failure leaves no orphaned live token ---');
  const failMock = createMockSupabase({ [DASHBOARD_SESSIONS_TABLE]: [], admin_audit_logs: [] });
  const failed = await requestDashboardAccess({
    supabase: failMock.client,
    ownerId: PROFILE.id,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendEmail: async () => false
  });
  check(failed.ok === false && failed.reason === 'email_failed', 'a failed email is reported, never thrown');
  check(failMock.db[DASHBOARD_SESSIONS_TABLE].length === 0, 'the auth row is removed when the email cannot be sent');

  console.log('\n--- Test 7: OTP verify -> single-use link -> 30-day session ---');
  const verified = await verifyDashboardOtp({ supabase: mock.client, rawToken, otp: emailPayload.otp });
  check(verified.ok === true && typeof verified.sessionToken === 'string', 'the correct code issues a session token');
  check(verified.sessionToken.length === 64, 'the session token is 32 bytes of hex');
  const verifiedRow = mock.db[DASHBOARD_SESSIONS_TABLE][0];
  check(verifiedRow.verified === true, 'the row is stamped verified');
  check(verifiedRow.otp_hash === null, 'the OTP hash is burned after use');
  check(verifiedRow.session_token_hash === hashToken(verified.sessionToken), 'only the session token hash is stored');
  check(!JSON.stringify(verifiedRow).includes(verified.sessionToken), 'the raw session token never appears in the row');
  const sessionTtl = new Date(verifiedRow.session_expires_at).getTime() - Date.now();
  check(Math.abs(sessionTtl - DASHBOARD_SESSION_TTL_MS) < 10000, 'the session TTL is 30 days');
  const lookedUp = await getSessionByToken({ supabase: mock.client, sessionToken: verified.sessionToken });
  check(lookedUp.ok === true && lookedUp.ownerId === PROFILE.id, 'the session token resolves to its owner');
  const replayLink = await getLinkState({ supabase: mock.client, rawToken });
  check(replayLink.ok === false && replayLink.reason === 'already_used', 'a used link never opens again');
  const replayOtp = await verifyDashboardOtp({ supabase: mock.client, rawToken, otp: emailPayload.otp });
  check(replayOtp.ok === false && replayOtp.reason === 'already_used', 'the same link + code cannot be re-verified');
  const cleared = await clearDashboardSession({ supabase: mock.client, sessionToken: verified.sessionToken });
  check(cleared.ok === true, 'logout clears the session row');
  const afterLogout = await getSessionByToken({ supabase: mock.client, sessionToken: verified.sessionToken });
  check(afterLogout.ok === false && afterLogout.reason === 'no_session', 'the cleared session no longer resolves');
  check(mock.db.admin_audit_logs.some((a) => a.action === 'DASHBOARD_ACCESS_REQUESTED')
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
  check(cookie.includes(`Max-Age=${Math.floor(DASHBOARD_SESSION_TTL_MS / 1000)}`), 'the cookie lives 30 days');
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
  check(!remaining.includes('dead-session'), 'a session past its 30-day window is removed');
  check(remaining.includes('live-session'), 'a live session is never pruned');

  console.log('\n--- Test 12: WhatsApp lane (13B) ---');
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
  process.env.DASHBOARD_ENABLED = 'off';
  const laneOff = await resolveReadCommand('dashboard', laneCtx()).render(laneCtx());
  check(laneOff.reply_message === "That's not something I can do yet — reply *help* to see what I can do.", 'flag OFF -> the verbatim A2 line (real service path)');
  check(!/dashboard/i.test(laneOff.reply_message), 'the A2 line never names the dashboard');
  process.env.DASHBOARD_ENABLED = 'on';
  const unverifiedProfile = { ...laneProfile, email_verified: false };
  const laneUnverified = await resolveReadCommand('dashboard', laneCtx({ profile: unverifiedProfile })).render(laneCtx({ profile: unverifiedProfile }));
  check(/finish the quick sign-up at https:\/\/sakafleet\.com/.test(laneUnverified.reply_message), 'an unverified email gets the website sign-up line (no email is sent)');
  const freeCtx = laneCtx({ dashboardEntitlements: { isTrial: false, isPaid: false } });
  const laneFree = await resolveReadCommand('dashboard', freeCtx).render(freeCtx);
  check(/trial or a paid plan/.test(laneFree.reply_message) && !/app\.sakafleet/i.test(laneFree.reply_message), 'a free account gets the deterministic upgrade line and no link');
  let capturedArgs = null;
  const eligibleCtx = laneCtx({
    dashboardEntitlements: { isTrial: true, isPaid: false },
    dashboardRequestAccess: async (args) => {
      capturedArgs = args;
      return { ok: true, link: 'https://app.sakafleet.com/d/feedface', email: PROFILE.email };
    }
  });
  const laneEligible = await resolveReadCommand('dashboard', eligibleCtx).render(eligibleCtx);
  check(capturedArgs && capturedArgs.ownerId === PROFILE.id && capturedArgs.entitlements.isTrial === true, 'the lane passes owner + entitlements to the service');
  check(capturedArgs.profile.email === PROFILE.email && capturedArgs.supabase === eligibleCtx.supabaseClient, 'the lane passes the profile and client through');
  check(laneEligible.reply_message.includes('https://app.sakafleet.com/d/feedface'), 'an eligible reply carries the magic link');
  check(/code is in that same email/.test(laneEligible.reply_message) && !/\b\d{6}\b/.test(laneEligible.reply_message.replace(/\d+\s*minutes?/gi, '')), 'the reply never contains the 6-digit code itself (D2)');

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

  console.log('\n--- Test 16: the four pages end-to-end (Fastify inject) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const pageMock = createMockSupabase({
    [DASHBOARD_SESSIONS_TABLE]: [],
    admin_audit_logs: [],
    profiles: [{ id: PROFILE.id, phone_number: PROFILE.phone_number, email: PROFILE.email, full_name: PROFILE.full_name, country_code: 'KE' }],
    vehicles: []
  });
  let pageEmail = null;
  const pageAccess = await requestDashboardAccess({
    supabase: pageMock.client,
    ownerId: PROFILE.id,
    profile: PROFILE,
    entitlements: { isTrial: true, isPaid: false },
    sendEmail: async (payload) => { pageEmail = payload; return true; }
  });
  const pageToken = pageAccess.link.split('/').pop();
  const app = Fastify({ logger: false });
  await registerDashboardRoutes(app, { supabase: pageMock.client });
  await app.ready();

  const otpPage = await app.inject({ method: 'GET', url: `/d/${pageToken}` });
  check(otpPage.statusCode === 200 && /Check your email/.test(otpPage.body), 'GET /d/<token> renders the OTP page');
  check(otpPage.body.includes('a***a@example.com'), 'the OTP page shows the masked destination address');
  check(otpPage.body.includes(`value="${pageToken}"`), 'the form carries the link token in a hidden field');
  check(otpPage.body.includes('Open my dashboard') && otpPage.body.includes('10 minutes'), 'the form names the action and the code TTL');

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
    payload: `token=${pageToken}&otp=${pageEmail.otp}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  check(goodOtp.statusCode === 303 && goodOtp.headers.location === '/d', 'the correct code redirects 303 to /d');
  const cookieLine = String(Array.isArray(goodOtp.headers['set-cookie']) ? goodOtp.headers['set-cookie'][0] : goodOtp.headers['set-cookie'] || '');
  check(/saka_dash=[a-f0-9]{64}/.test(cookieLine), 'the session cookie carries a raw 64-hex token');
  check(cookieLine.includes('HttpOnly') && cookieLine.includes('SameSite=Strict') && cookieLine.includes('Path=/d') && cookieLine.includes('Max-Age=2592000'),
    'the cookie is HttpOnly, SameSite=Strict, Path=/d and lives 30 days');
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

  const logout = await app.inject({ method: 'GET', url: '/d/logout', headers: { cookie: `saka_dash=${sessionCookie}` } });
  check(logout.statusCode === 200 && /logged out/i.test(logout.body), 'GET /d/logout renders the logged-out page');
  check(String(logout.headers['set-cookie'] || '').includes('Max-Age=0'), 'logout clears the cookie');
  check(pageMock.db[DASHBOARD_SESSIONS_TABLE].length === 0, 'logout deletes the session row');
  const afterPageLogout = await app.inject({ method: 'GET', url: '/d', headers: { cookie: `saka_dash=${sessionCookie}` } });
  check(afterPageLogout.statusCode === 401, 'the old cookie no longer opens the dashboard');
  await app.close();

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
  const hostile = { ...detail, vehicle: { ...detail.vehicle, plate: '<script>alert(1)</script>', makeModel: '<b>x</b>' } };
  const hostileHtml = renderVehiclePage({ data: hostile, emailMasked: 'a***a@example.com' });
  check(!hostileHtml.includes('<script>alert(1)</script>') && hostileHtml.includes('&lt;script&gt;'), 'plate and model are escaped (no HTML injection)');
  const hostileIndex = renderVehiclesPage({ data: { ...directory, vehicles: [{ ...rowB, plate: '<img src=x onerror=1>' }] }, emailMasked: 'a***a@example.com' });
  check(!hostileIndex.includes('<img src=x') && hostileIndex.includes('&lt;img'), 'the list escapes a hostile plate too');
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
      { id: 'v-b', owner_id: PROFILE.id, plate_number: 'KDB 456B', make_model: 'Toyota Hiace', status: 'ACTIVE' },
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
    { at: '2026-11-07T06:00:00.000Z', kind: 'expense', vehicle: 'KDA 123A', typeLabel: 'Fuel', description: 'Fuel - 40 L - Shell, "Karen"', odometer: 100500, unitCost: 125.5, amount: 5000, label: 'karen run' },
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
  const anonDriver = await compApp.inject({ method: 'GET', url: '/d/drivers/d-1' });
  check(anonDriver.statusCode === 401, 'the driver page never renders without a session');

  const compliancePdfRes = await compApp.inject({ method: 'GET', url: '/d/compliance.pdf', headers: compCookie });
  check(compliancePdfRes.statusCode === 200 && String(compliancePdfRes.headers['content-type']).includes('application/pdf'), 'GET /d/compliance.pdf answers application/pdf');
  check(compliancePdfRes.rawPayload.subarray(0, 5).toString() === '%PDF-', 'the compliance PDF is a real streamed PDF');
  check(/attachment; filename="saka-compliance-all-\d{4}-\d{2}-\d{2}\.pdf"/.test(String(compliancePdfRes.headers['content-disposition'])), 'the PDF carries a dated download filename');
  const expiredPdfRes = await compApp.inject({ method: 'GET', url: '/d/compliance.pdf?view=expired', headers: compCookie });
  check(expiredPdfRes.statusCode === 200 && expiredPdfRes.rawPayload.subarray(0, 5).toString() === '%PDF-', 'the filtered PDF exports the same view');
  const badPdfRes = await compApp.inject({ method: 'GET', url: '/d/compliance.pdf?view=weird', headers: compCookie });
  check(badPdfRes.statusCode === 400, 'an invalid view refuses the export with a 400');
  await compApp.close();

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
