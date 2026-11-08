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
  renderOverviewPage,
  renderVehiclesPage,
  renderVehiclePage,
  renderOtpPage,
  renderErrorPage
} from './src/services/dashboard.js';
import { upcomingExpiryItems, buildVehicleDirectory, buildVehicleDetail } from './src/services/fleetReports.js';
import { detectCountryFromPhone } from './src/services/globalization.js';
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
