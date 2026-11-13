// v1.91.0 (Phase 28A) — superadmin write actions (stateless: in-memory mock only).
import assert from 'node:assert';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  DASHBOARD_SESSIONS_TABLE,
  ADMIN_IMPERSONATIONS_TABLE,
  IMPERSONATION_COOKIE_NAME,
  hashToken
} from './src/services/dashboard.js';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { registerDashboardRoutes } from './src/routes/dashboard.js';
import { adminActionKeyGenerator } from './src/services/rateLimitIdentity.js';
// v1.97.0 — the CRM builders are exercised directly (list/detail/degrade).
import { buildAdminProfilesList, buildAdminProfileDetail, renderAdminProfileDetailPage } from './src/services/dashboardAdmin.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${label}`);
}

const DAY = 86400000;
const ADMIN = { id: 'p-admin', phone_number: '+254700000900', email: 'admin@example.com', full_name: 'Super Admin', country_code: 'KE' };
const TARGET = { id: 'p-target', phone_number: '+254712345678', email: 'target@example.com', full_name: 'Target Owner', country: 'Kenya', country_code: 'KE' };
const OTHER = { id: 'p-other', phone_number: '+254799000111', email: null, full_name: 'Other Owner', country_code: 'KE' };
// v1.97.0 — a true shell (no name, no email) for the CRM master list.
const SHELL = { id: 'p-shell', phone_number: '+254799000222', email: null, full_name: null, country_code: 'KE' };
const VEHICLE = { id: 'v-1', owner_id: TARGET.id, plate_number: 'KDA 123A', vin: '1HGCM82633A004352', qr_passbook_token: 'SK-PASSBOOK-ABCDEF12', make_model: 'Nissan Note', status: 'ACTIVE', deleted_at: null };
const FOREIGN = { id: 'v-2', owner_id: OTHER.id, assigned_driver_id: TARGET.id, plate_number: 'KDK 607B', vin: 'JTE777A1234567890', qr_passbook_token: 'SK-PASSBOOK-99999999', status: 'ACTIVE', deleted_at: null };

const futureIso = (ms = DAY) => new Date(Date.now() + ms).toISOString();
const sessionRow = (id, ownerId, token, role) => ({
  id,
  token_hash: hashToken(`${id}-link`),
  session_token_hash: hashToken(token),
  owner_id: ownerId,
  email: null,
  attempts: 0,
  verified: true,
  link_expires_at: futureIso(),
  otp_expires_at: null,
  session_expires_at: futureIso(),
  session_role: role,
  created_at: new Date().toISOString()
});

const seed = () => ({
  profiles: [{ ...ADMIN }, { ...TARGET }, { ...OTHER }, { ...SHELL }],
  vehicles: [{ ...VEHICLE }, { ...FOREIGN }],
  [DASHBOARD_SESSIONS_TABLE]: [
    sessionRow('sess-admin', ADMIN.id, 'admin-sess', 'admin'),
    sessionRow('sess-admin-rl', ADMIN.id, 'admin-rl-sess', 'admin'),
    sessionRow('sess-target', TARGET.id, 'target-sess', 'owner')
  ],
  [ADMIN_IMPERSONATIONS_TABLE]: [],
  admin_audit_logs: [],
  trial_sessions: [{
    id: 'trial-1',
    owner_id: TARGET.id,
    owner_phone: TARGET.phone_number,
    status: 'ACTIVE',
    started_at: new Date(Date.now() - 5 * DAY).toISOString(),
    ends_at: futureIso(10 * DAY)
  }],
  passbook_transfers: [{
    id: 'tr-history',
    vehicle_id: VEHICLE.id,
    from_owner_id: TARGET.id,
    status: 'COMPLETED',
    to_owner_phone: '+254711111111',
    to_owner_email: 'buyer@example.com',
    is_free_transfer: true,
    fee_amount: 0,
    fee_currency: 'USD',
    initiated_at: new Date(Date.now() - 30 * DAY).toISOString()
  }],
  expense_logs: [{ id: 'exp-1', vehicle_id: VEHICLE.id, owner_id: TARGET.id, expense_type: 'fuel', amount: 3000, currency: 'KES', created_at: new Date().toISOString() }],
  private_earnings: [],
  reminders: [],
  vehicle_compliances: [],
  driver_compliances: [],
  receipts: [],
  expiry_notification_log: [],
  pending_owner_notifications: [],
  driver_assignments: [],
  coupons: [],
  // v1.97.0 — CRM: support tickets (detail page) + the billing ledger.
  support_tickets: [{
    id: 'ticket-1',
    whatsapp_number: TARGET.phone_number,
    status: 'OPEN',
    priority: 'high',
    issue_category: 'billing',
    subject: 'Double charge',
    created_at: new Date().toISOString()
  }],
  subscriptions: [],
  system_config: []
});

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const adminHeaders = { ...FORM, cookie: 'saka_dash=admin-sess' };

async function makeApp(mock, overrides = {}) {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute', keyGenerator: adminActionKeyGenerator });
  await registerDashboardRoutes(app, { supabase: mock.client, ...overrides });
  await app.ready();
  return app;
}

async function run() {
  const previousFlag = process.env.DASHBOARD_ENABLED;
  const previousAdmin = process.env.SUPERADMIN_PHONE;
  const previousBase = process.env.PUBLIC_APP_URL;
  process.env.DASHBOARD_ENABLED = 'on';
  process.env.SUPERADMIN_PHONE = ADMIN.phone_number;
  process.env.PUBLIC_APP_URL = 'https://app.sakafleet.test';

  const NEW_URLS = [
    ['GET', '/d/admin/as-user/p-target'], ['POST', '/d/admin/as-user/p-target'],
    ['GET', '/d/admin/exit-as'],
    ['GET', '/d/admin/reset/p-target'], ['POST', '/d/admin/reset/p-target'],
    ['GET', '/d/admin/extend-trial/p-target'], ['POST', '/d/admin/extend-trial/p-target'],
    ['GET', '/d/admin/passbook/v-1'],
    ['GET', '/d/admin/transfer/v-1'],
    ['POST', '/d/admin/transfer/v-1/step1'], ['POST', '/d/admin/transfer/v-1/step2'],
    ['POST', '/d/admin/transfer/v-1/step3'], ['POST', '/d/admin/transfer/v-1/cancel'],
    ['GET', '/d/admin/email/p-target'], ['POST', '/d/admin/email/p-target'],
    // v1.97.0 — the user-management CRM.
    ['GET', '/d/admin/profiles'], ['GET', '/d/admin/profiles/p-target'],
    ['POST', '/d/admin/profiles/p-target/identity'],
    ['POST', '/d/admin/profiles/p-target/note'],
    ['POST', '/d/admin/profiles/p-target/verify-email'],
    ['POST', '/d/admin/profiles/p-target/tier'],
    ['POST', '/d/admin/profiles/p-target/force-logout'],
    ['POST', '/d/admin/profiles/p-target/wipe']
  ];

  console.log('\n--- Test 1: A1 — every new URL is a plain 404 while the flag is off ---');
  process.env.DASHBOARD_ENABLED = 'off';
  const offApp = await makeApp(createMockSupabase(seed()));
  for (const [method, url] of NEW_URLS) {
    const res = await offApp.inject({
      method,
      url,
      headers: FORM,
      payload: method === 'POST' ? 'action=preview' : undefined
    });
    check(res.statusCode === 404 && String(res.body).includes('Not Found'), `${method} ${url} answers 404 while the flag is off`);
  }
  await offApp.close();
  process.env.DASHBOARD_ENABLED = 'on';

  console.log('\n--- Test 2: every admin POST refuses a cross-origin write ---');
  const crossMock = createMockSupabase(seed());
  const crossApp = await makeApp(crossMock);
  const crossHeaders = { ...FORM, cookie: 'saka_dash=admin-sess', origin: 'https://evil.example', host: 'app.sakafleet.test' };
  const crossPosts = [
    ['/d/admin/as-user/p-target', 'confirm=IMPERSONATE&reason=walkthrough'],
    ['/d/admin/reset/p-target', 'confirm=RESET&reason=cleanup'],
    ['/d/admin/extend-trial/p-target', 'confirm=EXTEND&days=5&reason=goodwill'],
    ['/d/admin/transfer/v-1/step1', 'x=1'],
    ['/d/admin/transfer/v-1/step2', 'x=1'],
    ['/d/admin/transfer/v-1/step3', 'x=1'],
    ['/d/admin/transfer/v-1/cancel', 'x=1'],
    ['/d/admin/email/p-target', 'action=preview&subject=s&body=b'],
    // v1.97.0 — every CRM write refuses a cross-origin POST.
    ['/d/admin/profiles/p-target/identity', 'full_name=Nope&confirm=UPDATE&reason=fix'],
    ['/d/admin/profiles/p-target/note', 'note=hello'],
    ['/d/admin/profiles/p-target/verify-email', 'confirm=VERIFY&reason=proof'],
    ['/d/admin/profiles/p-target/tier', 'confirm=TIER&tier=growth&reason=offline'],
    ['/d/admin/profiles/p-target/force-logout', 'confirm=LOGOUT&reason=lost'],
    ['/d/admin/profiles/p-target/wipe', 'confirm=WIPE&reason=gdpr']
  ];
  for (const [url, payload] of crossPosts) {
    const res = await crossApp.inject({ method: 'POST', url, headers: crossHeaders, payload });
    check(res.statusCode === 403, `${url} refuses a cross-origin write`);
  }
  check(crossMock.db[ADMIN_IMPERSONATIONS_TABLE].length === 0 && crossMock.db.admin_audit_logs.length === 0, 'a refused cross-origin write changed nothing');
  await crossApp.close();

  console.log('\n--- Test 3: typed confirmation + reason are enforced server-side ---');
  const impMock = createMockSupabase(seed());
  const impApp = await makeApp(impMock);
  const wrongWord = await impApp.inject({ method: 'POST', url: '/d/admin/as-user/p-target', headers: adminHeaders, payload: 'confirm=impersonate&reason=walkthrough' });
  check(wrongWord.statusCode === 200 && /Type IMPERSONATE exactly/.test(wrongWord.body), 'a lowercase confirmation word is refused');
  check(impMock.db[ADMIN_IMPERSONATIONS_TABLE].length === 0, 'a refused confirmation mints nothing');
  const shortReason = await impApp.inject({ method: 'POST', url: '/d/admin/as-user/p-target', headers: adminHeaders, payload: 'confirm=IMPERSONATE&reason=x' });
  check(shortReason.statusCode === 200 && /at least 3 characters/.test(shortReason.body), 'a too-short reason is refused');
  check(impMock.db[ADMIN_IMPERSONATIONS_TABLE].length === 0, 'a missing reason mints nothing');

  console.log('\n--- Test 4: impersonation lifecycle (D1) ---');
  const start = await impApp.inject({ method: 'POST', url: '/d/admin/as-user/p-target', headers: adminHeaders, payload: 'confirm=IMPERSONATE&reason=walkthrough' });
  check(start.statusCode === 303 && String(start.headers.location) === '/d', 'a valid impersonation starts and lands on /d');
  const cookieLine = String(start.headers['set-cookie'] || '');
  check(cookieLine.startsWith(`${IMPERSONATION_COOKIE_NAME}=`) && cookieLine.includes('Max-Age=1800') && cookieLine.includes('HttpOnly') && cookieLine.includes('SameSite=Strict') && cookieLine.includes('Path=/d'), 'the as-cookie is HttpOnly/Strict/Path=/d and lives 30 minutes');
  const asTokenMatch = cookieLine.match(new RegExp(`${IMPERSONATION_COOKIE_NAME}=([a-f0-9]{64})`));
  check(Boolean(asTokenMatch), 'the as-cookie carries a raw 64-hex token');
  const asToken = asTokenMatch[1];
  const impRow = impMock.db[ADMIN_IMPERSONATIONS_TABLE][0];
  check(impRow && impRow.token_hash === hashToken(asToken) && impRow.admin_profile_id === ADMIN.id && impRow.target_profile_id === TARGET.id, 'the row stores only the sha256 plus both profile ids');
  check(new Date(impRow.expires_at).getTime() - Date.now() <= 31 * 60 * 1000, 'the row expires within 30 minutes');
  check(impMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_ACTION_IMPERSONATE' && row.details?.reason === 'walkthrough' && row.details?.targetId === TARGET.id), 'ADMIN_ACTION_IMPERSONATE is audited with reason + targetId');
  const both = { cookie: `saka_dash=admin-sess; ${IMPERSONATION_COOKIE_NAME}=${asToken}` };
  const ownerView = await impApp.inject({ method: 'GET', url: '/d', headers: both });
  check(ownerView.statusCode === 200, 'the admin sees the target owner dashboard');
  check(/Impersonating Target Owner/.test(ownerView.body) && /expires \d{2}:\d{2}/.test(ownerView.body), 'the sticky banner names the owner and the expiry');
  // v1.94.0 (Phase 31, D6) — the brand stays on the TARGET owner's overview,
  // never the admin lane; Exit is the only way out.
  check(ownerView.body.includes('class="brand" href="/d"'), 'the impersonated brand stays /d — the target overview, never the admin lane (v1.94.0)');
  check(ownerView.body.includes('/d/admin/exit-as') && !ownerView.body.includes('/d/admin/command'), 'the page shows Exit and the OWNER nav (no admin command link)');
  // v1.95.0 (Phase 32, Task 2) — the target IS dual-role here (owns v-1, drives
  // v-2): the yellow banner renders and the lane toggle must NOT (D3).
  check(ownerView.body.includes('class="as-banner"') && !ownerView.body.includes('class="lane-switch"'), 'impersonation overrides the lane toggle — banner only, never a switch strip (v1.95.0)');
  const targetFleet = await impApp.inject({ method: 'GET', url: '/d/vehicles', headers: both });
  check(targetFleet.statusCode === 200 && targetFleet.body.includes('KDA 123A'), 'the impersonated fleet page renders the TARGET vehicles');
  const asOnly = await impApp.inject({ method: 'GET', url: '/d', headers: { cookie: `${IMPERSONATION_COOKIE_NAME}=${asToken}` } });
  check(asOnly.statusCode === 401, 'the as-cookie alone can never open a page');
  const blockedWrite = await impApp.inject({ method: 'POST', url: '/d/settings', headers: { ...FORM, ...both }, payload: 'action=save_weekly&weekly=on' });
  check(blockedWrite.statusCode === 403 && /Exit impersonation to make changes/.test(blockedWrite.body), 'owner-lane writes are refused while impersonating');
  check(!impMock.db.profiles.find((p) => p.id === TARGET.id).weekly_report_opt_in, 'the refused write changed nothing');

  console.log('\n--- Test 5: exit clears ONLY the as-cookie and keeps the admin signed in ---');
  const exit = await impApp.inject({ method: 'GET', url: '/d/admin/exit-as', headers: both });
  check(exit.statusCode === 303 && String(exit.headers.location) === '/d/admin?done=as-exited', 'exit lands on the admin console');
  const exitCookie = String(exit.headers['set-cookie'] || '');
  check(exitCookie.startsWith(`${IMPERSONATION_COOKIE_NAME}=`) && exitCookie.includes('Max-Age=0'), 'exit clears the as-cookie');
  check(!exitCookie.replace(IMPERSONATION_COOKIE_NAME, '').includes('saka_dash=;'), 'exit never clears the admin saka_dash cookie');
  check(impMock.db[ADMIN_IMPERSONATIONS_TABLE].length === 0, 'exit deletes the impersonation row');
  const adminAfter = await impApp.inject({ method: 'GET', url: '/d/admin', headers: { cookie: 'saka_dash=admin-sess' } });
  check(adminAfter.statusCode === 200 && adminAfter.body.includes('Owners'), 'the admin session is still alive after exit');
  check(impMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_ACTION_IMPERSONATE_END'), 'ADMIN_ACTION_IMPERSONATE_END is audited');
  const banner = await impApp.inject({ method: 'GET', url: '/d/admin?done=as-exited', headers: { cookie: 'saka_dash=admin-sess' } });
  check(banner.statusCode === 200 && /still signed in as the superadmin/.test(banner.body), 'the success banner renders on /d/admin');
  const actionLinks = ['/d/admin/as-user/p-target', '/d/admin/reset/p-target', '/d/admin/extend-trial/p-target', '/d/admin/email/p-target'];
  check(actionLinks.every((href) => adminAfter.body.includes(href)), 'each owner row carries the four action links');
  const fleetPage = await impApp.inject({ method: 'GET', url: '/d/admin/owners/p-target', headers: { cookie: 'saka_dash=admin-sess' } });
  check(fleetPage.statusCode === 200 && fleetPage.body.includes('/d/admin/passbook/v-1') && fleetPage.body.includes('/d/admin/transfer/v-1'), 'the fleet page links each vehicle to its passbook + facilitator');
  await impApp.close();

  console.log('\n--- Test 6: an expired or foreign impersonation grants nothing ---');
  const expMock = createMockSupabase({
    ...seed(),
    [ADMIN_IMPERSONATIONS_TABLE]: [{
      id: 'imp-expired',
      token_hash: hashToken('expired-as-token'),
      admin_profile_id: ADMIN.id,
      target_profile_id: TARGET.id,
      expires_at: new Date(Date.now() - 60000).toISOString(),
      created_at: new Date().toISOString()
    }]
  });
  const expApp = await makeApp(expMock);
  const expired = await expApp.inject({ method: 'GET', url: '/d', headers: { cookie: `saka_dash=admin-sess; ${IMPERSONATION_COOKIE_NAME}=expired-as-token` } });
  check(expired.statusCode === 403, 'an expired impersonation falls back to the plain admin session (owner lane refused)');
  const expiredCookie = String(expired.headers['set-cookie'] || '');
  check(expiredCookie.startsWith(`${IMPERSONATION_COOKIE_NAME}=`) && expiredCookie.includes('Max-Age=0'), 'the expired as-cookie is cleared');
  expMock.db[ADMIN_IMPERSONATIONS_TABLE].push({
    id: 'imp-foreign',
    token_hash: hashToken('foreign-as-token'),
    admin_profile_id: 'p-someone-else',
    target_profile_id: TARGET.id,
    expires_at: futureIso(),
    created_at: new Date().toISOString()
  });
  const foreign = await expApp.inject({ method: 'GET', url: '/d', headers: { cookie: `saka_dash=admin-sess; ${IMPERSONATION_COOKIE_NAME}=foreign-as-token` } });
  check(foreign.statusCode === 403 && String(foreign.headers['set-cookie'] || '').includes('Max-Age=0'), 'an impersonation minted by another admin is refused and cleared');
  await expApp.close();

  console.log('\n--- Test 7: reset erases the profile, its sessions and its impersonations ---');
  const resetMock = createMockSupabase(seed());
  const resetApp = await makeApp(resetMock);
  const mismatch = await resetApp.inject({ method: 'POST', url: '/d/admin/reset/p-target', headers: adminHeaders, payload: 'confirm=reset&reason=cleanup' });
  check(mismatch.statusCode === 200 && /Type RESET exactly/.test(mismatch.body), 'reset refuses a wrong confirmation word');
  check(resetMock.db.profiles.some((p) => p.id === TARGET.id), 'the refused reset changed nothing');
  const selfReset = await resetApp.inject({ method: 'POST', url: '/d/admin/reset/p-admin', headers: adminHeaders, payload: 'confirm=RESET&reason=cleanup' });
  check(selfReset.statusCode === 400, 'the superadmin can never reset their own profile');
  resetMock.db[ADMIN_IMPERSONATIONS_TABLE].push({
    id: 'imp-target',
    token_hash: hashToken('imp-target'),
    admin_profile_id: ADMIN.id,
    target_profile_id: TARGET.id,
    expires_at: futureIso(),
    created_at: new Date().toISOString()
  });
  const done = await resetApp.inject({ method: 'POST', url: '/d/admin/reset/p-target', headers: adminHeaders, payload: 'confirm=RESET&reason=cleanup' });
  check(done.statusCode === 303 && String(done.headers.location) === '/d/admin?done=reset', 'a valid reset lands on the success banner');
  check(!resetMock.db.profiles.some((p) => p.id === TARGET.id) && !resetMock.db.vehicles.some((v) => v.id === VEHICLE.id), 'the profile and its fleet are erased');
  check(!resetMock.db[DASHBOARD_SESSIONS_TABLE].some((session) => session.owner_id === TARGET.id), 'the reset ends the target dashboard sessions');
  check(resetMock.db[ADMIN_IMPERSONATIONS_TABLE].length === 0, 'the reset clears impersonations touching the profile');
  const resetAudit = resetMock.db.admin_audit_logs.find((row) => row.action === 'ADMIN_ACTION_PROFILE_RESET');
  check(resetAudit && resetAudit.details?.reason === 'cleanup' && resetAudit.details?.targetId === TARGET.id && resetAudit.details?.after?.counts, 'ADMIN_ACTION_PROFILE_RESET is audited with reason, target and per-table counts');
  await resetApp.close();

  console.log('\n--- Test 8: trial extension is engine-owned (clamp + honest errors) ---');
  const trialMock = createMockSupabase(seed());
  const trialApp = await makeApp(trialMock);
  const trialBefore = new Date(trialMock.db.trial_sessions[0].ends_at).getTime();
  const ext = await trialApp.inject({ method: 'POST', url: '/d/admin/extend-trial/p-target', headers: adminHeaders, payload: 'confirm=EXTEND&days=10&reason=goodwill' });
  check(ext.statusCode === 303 && /done=trial-extended/.test(String(ext.headers.location)), 'a valid extension lands on the success banner');
  const trialAfter = new Date(trialMock.db.trial_sessions[0].ends_at).getTime();
  check(Math.round((trialAfter - trialBefore) / DAY) === 10, 'the engine added exactly 10 days');
  check(trialMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_ACTION_TRIAL_EXTENDED' && row.details?.after?.daysAdded === 10), 'ADMIN_ACTION_TRIAL_EXTENDED is audited with before/after');
  const capped = await trialApp.inject({ method: 'POST', url: '/d/admin/extend-trial/p-target', headers: adminHeaders, payload: 'confirm=EXTEND&days=365&reason=goodwill' });
  check(capped.statusCode === 303 && /capped=1/.test(String(capped.headers.location)), 'an over-cap request reports the engine cap honestly');
  const startedMs = new Date(trialMock.db.trial_sessions[0].started_at).getTime();
  check(new Date(trialMock.db.trial_sessions[0].ends_at).getTime() <= startedMs + 46 * DAY, 'the total trial never exceeds the 45-day engine cap');
  const noTrial = await trialApp.inject({ method: 'POST', url: '/d/admin/extend-trial/p-other', headers: adminHeaders, payload: 'confirm=EXTEND&days=5&reason=nope' });
  check(noTrial.statusCode === 400 && /No active trial/.test(noTrial.body), 'an account with no active trial gets the honest engine error');
  await trialApp.close();

  console.log('\n--- Test 9: passbook view is read-only, masked and audited ---');
  const passMock = createMockSupabase(seed());
  const passApp = await makeApp(passMock);
  const passPage = await passApp.inject({ method: 'GET', url: '/d/admin/passbook/v-1', headers: { cookie: 'saka_dash=admin-sess' } });
  check(passPage.statusCode === 200, 'the passbook page renders');
  check(passPage.body.includes('••••••4352') && passPage.body.includes('1HGCM82633A004352'), 'the VIN is masked with a reveal of the full value');
  check(passPage.body.includes('••••••EF12') && passPage.body.includes('SK-PASSBOOK-ABCDEF12'), 'the passbook token is masked with a reveal');
  check(passPage.body.includes('COMPLETED') && !passPage.body.includes('+254711111111') && !passPage.body.includes('buyer@example.com'), 'transfer history renders with masked buyer details');
  check(passMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_ACTION_PASSBOOK_VIEW' && row.details?.vehicleId === VEHICLE.id), 'ADMIN_ACTION_PASSBOOK_VIEW is audited');
  const missingPass = await passApp.inject({ method: 'GET', url: '/d/admin/passbook/does-not-exist', headers: { cookie: 'saka_dash=admin-sess' } });
  check(missingPass.statusCode === 404, 'a missing vehicle answers 404');
  await passApp.close();

  console.log('\n--- Test 10: the facilitator reuses the transfer engine (steps 1-3) ---');
  const trMock = createMockSupabase(seed());
  const calls = { initiate: [], setBuyer: [], verify: [] };
  const trApp = await makeApp(trMock, {
    adminTransferEngine: {
      initiate: async (args) => { calls.initiate.push(args); return { success: true, transferId: 'tr-new', isFreeTransfer: true, feeAmount: 0 }; },
      setBuyer: async (args) => { calls.setBuyer.push(args); return { success: true, releasePin: '123456', ownerEmail: TARGET.email }; },
      verifyRelease: async (args) => { calls.verify.push(args); return { success: true }; }
    }
  });
  const trView = await trApp.inject({ method: 'GET', url: '/d/admin/transfer/v-1', headers: { cookie: 'saka_dash=admin-sess' } });
  check(trView.statusCode === 200 && trView.body.includes('🛡️ Admin-facilitated transfer'), 'the facilitator page carries the admin banner');
  check(trView.body.includes('Step 1 — start the handover'), 'with no handover in flight step 1 renders');
  const step1 = await trApp.inject({ method: 'POST', url: '/d/admin/transfer/v-1/step1', headers: adminHeaders, payload: 'x=1' });
  check(step1.statusCode === 303 && calls.initiate.length === 1 && calls.initiate[0].fromPhone === TARGET.phone_number && calls.initiate[0].vehicleCandidate === VEHICLE.plate_number, 'step 1 reuses the engine with the owner phone + plate');
  trMock.db.passbook_transfers.push({ id: 'tr-new', vehicle_id: VEHICLE.id, from_owner_id: TARGET.id, status: 'PENDING_TARGET_DETAILS', initiated_at: new Date().toISOString() });
  const step2 = await trApp.inject({ method: 'POST', url: '/d/admin/transfer/v-1/step2', headers: adminHeaders, payload: 'transfer_id=tr-new&buyer_phone=%2B254711111111&buyer_email=buyer%40example.com' });
  check(step2.statusCode === 303 && calls.setBuyer.length === 1 && calls.setBuyer[0].transferId === 'tr-new', 'step 2 calls the engine with the transfer id');
  const pinPage = await trApp.inject({ method: 'GET', url: '/d/admin/transfer/v-1', headers: { cookie: 'saka_dash=admin-sess' } });
  check(/emailed ONLY to the owner/.test(pinPage.body) && /Ask the owner for it in WhatsApp/.test(pinPage.body), 'step 2 copy says the PIN goes to the owner only (D2)');
  trMock.db.passbook_transfers.find((row) => row.id === 'tr-new').status = 'PENDING_OWNER_RELEASE_OTP';
  const step3 = await trApp.inject({ method: 'POST', url: '/d/admin/transfer/v-1/step3', headers: adminHeaders, payload: 'transfer_id=tr-new&release_pin=123456' });
  check(step3.statusCode === 303 && calls.verify.length === 1 && calls.verify[0].providedOtp === '123456' && typeof calls.verify[0].sendWhatsAppFn === 'function', 'step 3 passes the PIN and the WhatsApp sender to the engine');
  trMock.db.passbook_transfers.find((row) => row.id === 'tr-new').status = 'PENDING_BUYER_ACCEPTANCE';
  const waiting = await trApp.inject({ method: 'GET', url: '/d/admin/transfer/v-1', headers: { cookie: 'saka_dash=admin-sess' } });
  check(waiting.body.includes('Steps 4 and 5 stay on WhatsApp') && waiting.body.includes('Refresh status'), 'steps 4-5 stay on WhatsApp with a live status + refresh');
  const cancel = await trApp.inject({ method: 'POST', url: '/d/admin/transfer/v-1/cancel', headers: adminHeaders, payload: 'transfer_id=tr-new' });
  check(cancel.statusCode === 303 && trMock.db.passbook_transfers.find((row) => row.id === 'tr-new').status === 'CANCELLED', 'cancel marks the handover CANCELLED');
  check(['ADMIN_ACTION_TRANSFER_INITIATE', 'ADMIN_ACTION_TRANSFER_DETAILS', 'ADMIN_ACTION_TRANSFER_RELEASE', 'ADMIN_ACTION_TRANSFER_CANCEL'].every((action) => trMock.db.admin_audit_logs.some((row) => row.action === action)), 'every transfer step is audited');
  await trApp.close();

  console.log('\n--- Test 11: email as Saka (escaped preview + typed SEND) ---');
  const emailMock = createMockSupabase(seed());
  const sent = [];
  const emailApp = await makeApp(emailMock, {
    adminEmailSender: async (payload) => { sent.push(payload); return { data: { id: 'mail-1' }, error: null }; }
  });
  const draft = await emailApp.inject({ method: 'GET', url: '/d/admin/email/p-target', headers: { cookie: 'saka_dash=admin-sess' } });
  check(draft.statusCode === 200 && draft.body.includes('Email as Saka'), 'the draft page renders');
  const noEmail = await emailApp.inject({ method: 'GET', url: '/d/admin/email/p-other', headers: { cookie: 'saka_dash=admin-sess' } });
  check(noEmail.statusCode === 400 && /no email on file/.test(noEmail.body), 'an account without an email is refused honestly');
  const preview = await emailApp.inject({ method: 'POST', url: '/d/admin/email/p-target', headers: adminHeaders, payload: 'action=preview&subject=Hello&body=%3Cscript%3Ealert(1)%3C%2Fscript%3E' });
  check(preview.statusCode === 200 && preview.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !preview.body.includes('<script>alert(1)</script>'), 'the preview escapes the body (no raw script)');
  const noTyped = await emailApp.inject({ method: 'POST', url: '/d/admin/email/p-target', headers: adminHeaders, payload: 'action=send&subject=Hello&body=World&reason=support%20reply' });
  check(noTyped.statusCode === 200 && /Type SEND exactly/.test(noTyped.body) && sent.length === 0, 'send refuses without the typed word');
  const send = await emailApp.inject({ method: 'POST', url: '/d/admin/email/p-target', headers: adminHeaders, payload: 'action=send&subject=Hello&body=World&reason=support%20reply&confirm=SEND' });
  check(send.statusCode === 303 && String(send.headers.location) === '/d/admin?done=email' && sent.length === 1, 'a valid send delivers once and lands on the banner');
  check(sent[0].from === 'Saka Fleet <reports@reports.sakafleet.com>' && sent[0].to[0] === TARGET.email && sent[0].subject === 'Hello', 'the email is sent from Saka Fleet to the profile address');
  check(emailMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_ACTION_EMAIL_SENT' && row.details?.ok === true && row.details?.reason === 'support reply'), 'ADMIN_ACTION_EMAIL_SENT is audited with reason + masked recipient');
  await emailApp.close();
  const refusedMock = createMockSupabase(seed());
  const refusedApp = await makeApp(refusedMock, { adminEmailSender: async () => ({ error: { message: 'quota exhausted' } }) });
  const refused = await refusedApp.inject({ method: 'POST', url: '/d/admin/email/p-target', headers: adminHeaders, payload: 'action=send&subject=Hello&body=World&reason=support%20reply&confirm=SEND' });
  check(refused.statusCode === 502 && /refused by the sender/.test(refused.body), 'a refused send answers honestly (never a fake success)');
  check(refusedMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_ACTION_EMAIL_SENT' && row.details?.ok === false), 'the refused send is audited as ok:false');
  await refusedApp.close();

  console.log('\n--- Test 12: the admin action rate limit is 5 per 5 minutes ---');
  const rlMock = createMockSupabase(seed());
  const rlApp = await makeApp(rlMock);
  const rlHeaders = { ...FORM, cookie: 'saka_dash=admin-rl-sess' };
  let lastStatus = 0;
  for (let i = 0; i < 6; i += 1) {
    const res = await rlApp.inject({ method: 'POST', url: '/d/admin/email/p-target', headers: rlHeaders, payload: 'action=preview&subject=s&body=b' });
    lastStatus = res.statusCode;
  }
  check(lastStatus === 429, 'the 6th admin POST inside 5 minutes is rate-limited');
  await rlApp.close();

  console.log('\n--- Test 13: CRM master list — EVERY profile, search, degrade (v1.97.0) ---');
  const listMock = createMockSupabase(seed());
  const listData = await buildAdminProfilesList({ supabase: listMock.client });
  check(listData.ok === true && listData.totalProfiles === 4, 'every live profile is listed (owners, drivers and shells)');
  check(listData.profiles.some((row) => row.id === 'p-shell' && row.statusLabel === 'Shell'), 'a shell profile is labelled Shell');
  check(listData.profiles.some((row) => row.id === 'p-shell' && row.vehicleCount === 0 && row.activeCount === 0), 'a profile with no vehicle is still listed');
  check(String(listData.profiles.find((row) => row.id === TARGET.id)?.statusLabel || '').startsWith('Trial'), 'an active trial shows its days-left chip');
  check(listData.profiles.every((row) => !String(row.phoneMasked).includes('12345678')), 'phones stay masked in the list');
  const byEmail = await buildAdminProfilesList({ supabase: listMock.client, search: 'target@example.com' });
  check(byEmail.matchedProfiles === 1 && byEmail.profiles[0].id === TARGET.id, 'search matches the email');
  const byPhone = await buildAdminProfilesList({ supabase: listMock.client, search: '000222' });
  check(byPhone.matchedProfiles === 1 && byPhone.profiles[0].id === 'p-shell', 'search matches the phone digits');
  const failingTrials = {
    from(table) {
      if (table === 'trial_sessions') {
        const chain = { select: () => chain, eq: () => chain, limit: async () => ({ data: null, error: { message: 'table missing' } }) };
        return chain;
      }
      return listMock.client.from(table);
    }
  };
  const degradedList = await buildAdminProfilesList({ supabase: failingTrials });
  check(degradedList.ok === true && degradedList.degraded.includes('trials') && degradedList.profiles.length === 4,
    'a failed trials read degrades the chip, never the list (rule 50)');
  const listAppMock = createMockSupabase(seed());
  const listApp = await makeApp(listAppMock);
  const listRes = await listApp.inject({ method: 'GET', url: '/d/admin/profiles', headers: { cookie: 'saka_dash=admin-sess' } });
  check(listRes.statusCode === 200 && listRes.body.includes('Profiles') && listRes.body.includes('Shell'), 'the master list page renders every status');
  check(listRes.body.includes('target@example.com') === false, 'the list never prints a full email');
  check(listAppMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_DASHBOARD_VIEW' && row.details?.page === 'profiles'),
    'the profiles view is audited');
  await listApp.close();

  console.log('\n--- Test 14: CRM detail page — identity, fleet, support, degrade (v1.97.0) ---');
  const detailMock = createMockSupabase(seed());
  const detailApp = await makeApp(detailMock);
  const detailRes = await detailApp.inject({ method: 'GET', url: '/d/admin/profiles/p-target', headers: { cookie: 'saka_dash=admin-sess' } });
  check(detailRes.statusCode === 200 && detailRes.body.includes('Target Owner') && detailRes.body.includes('Identity'), 'the detail page renders the identity form');
  check(detailRes.body.includes('Double charge'), 'the account recent support ticket renders');
  check(detailRes.body.includes('Impersonate (read-only)') && detailRes.body.includes('/d/admin/extend-trial/p-target'), 'impersonate + extend-trial links render');
  check(detailRes.body.includes('Danger zone') && detailRes.body.includes('data-typed="WIPE"'), 'the danger zone carries the typed WIPE form');
  check(detailMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_DASHBOARD_VIEW' && row.details?.page === 'profile' && row.details?.targetId === TARGET.id),
    'the profile view is audited with the target id');
  const missingProfile = await detailApp.inject({ method: 'GET', url: '/d/admin/profiles/nobody-here', headers: { cookie: 'saka_dash=admin-sess' } });
  check(missingProfile.statusCode === 404, 'a missing profile answers 404');
  await detailApp.close();
  const ticketFailing = {
    from(table) {
      if (table === 'support_tickets') {
        const chain = { select: () => chain, or: () => chain, order: () => chain, limit: async () => ({ data: null, error: { message: 'missing' } }) };
        return chain;
      }
      return createMockSupabase(seed()).client.from(table);
    }
  };
  const degradedDetail = await buildAdminProfileDetail({ supabase: ticketFailing, id: TARGET.id });
  check(degradedDetail.ok === true && degradedDetail.degraded.includes('tickets'), 'a failed ticket read degrades only the support block');
  check(renderAdminProfileDetailPage({ data: degradedDetail }).includes('Support tickets could not be loaded'), 'the degraded support card is honest (rule 50)');

  console.log('\n--- Test 15: identity edit — whitelist, email re-verify, Force Verify (v1.97.0) ---');
  const idMock = createMockSupabase(seed());
  const idApp = await makeApp(idMock);
  const wrongIdentityWord = await idApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/identity', headers: adminHeaders, payload: 'full_name=Nope&reason=fix&confirm=update' });
  check(wrongIdentityWord.statusCode === 400 && /Type UPDATE exactly/.test(wrongIdentityWord.body), 'a lowercase UPDATE is refused server-side');
  const shortIdentityReason = await idApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/identity', headers: adminHeaders, payload: 'full_name=Nope&reason=x&confirm=UPDATE' });
  check(shortIdentityReason.statusCode === 400 && /short reason/.test(shortIdentityReason.body), 'a short reason is refused');
  const identity = await idApp.inject({
    method: 'POST',
    url: '/d/admin/profiles/p-target/identity',
    headers: adminHeaders,
    payload: 'full_name=Target+Updated&email=new%40example.com&country=Uganda&unit_system=imperial&reason=fix+typo&confirm=UPDATE'
  });
  check(identity.statusCode === 303 && String(identity.headers.location) === '/d/admin/profiles/p-target?done=updated', 'a valid identity change lands on the detail banner');
  const identityRow = idMock.db.profiles.find((row) => row.id === TARGET.id);
  check(identityRow.full_name === 'Target Updated' && identityRow.email === 'new@example.com', 'name and email are updated');
  check(identityRow.email_verified === false, 'a CHANGED email defaults email_verified=false (the new address must be proven)');
  check(identityRow.country === 'Uganda' && identityRow.country_source === 'user', 'a country change stamps country_source=user (reconcile never fights it)');
  check(identityRow.unit_system === 'imperial', 'units are updated');
  check(identityRow.subscription_tier === undefined && identityRow.subscription_status === undefined, 'tier/status can never be edited through identity (whitelist)');
  const identityAudit = idMock.db.admin_audit_logs.find((row) => row.action === 'ADMIN_ACTION_PROFILE_UPDATED');
  check(identityAudit && identityAudit.details?.targetId === TARGET.id
    && identityAudit.details?.before?.email === TARGET.email
    && identityAudit.details?.after?.email === 'new@example.com'
    && identityAudit.details?.emailVerificationReset === true, 'the change is audited before/after with the verification reset');
  await idApp.close();

  const forceMock = createMockSupabase(seed());
  const forceApp = await makeApp(forceMock);
  const forced = await forceApp.inject({
    method: 'POST',
    url: '/d/admin/profiles/p-target/identity',
    headers: adminHeaders,
    payload: 'email=forced%40example.com&force_verify=on&reason=proven+by+call&confirm=UPDATE'
  });
  check(forced.statusCode === 303 && forceMock.db.profiles.find((row) => row.id === TARGET.id).email_verified === true,
    'Force Verify keeps a changed address verified when the box is ticked');
  await forceApp.close();

  const dupeMock = createMockSupabase(seed());
  const dupeApp = await makeApp(dupeMock);
  const dupe = await dupeApp.inject({
    method: 'POST',
    url: '/d/admin/profiles/p-target/identity',
    headers: adminHeaders,
    payload: 'email=admin%40example.com&reason=fix+typo&confirm=UPDATE'
  });
  check(dupe.statusCode === 400 && /already belongs/.test(dupe.body) && dupeMock.db.profiles.find((row) => row.id === TARGET.id).email === TARGET.email,
    'a duplicate email is refused and nothing changes');
  await dupeApp.close();

  console.log('\n--- Test 16: manual tier override — engine-owned + ledger line (v1.97.0) ---');
  const tierMock = createMockSupabase(seed());
  const tierApp = await makeApp(tierMock);
  const bogusTier = await tierApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/tier', headers: adminHeaders, payload: 'tier=platinum&reason=offline&confirm=TIER' });
  check(bogusTier.statusCode === 400 && /unknown tier/.test(bogusTier.body) && tierMock.db.subscriptions.length === 0, 'a bogus tier is refused by the engine');
  const wrongTierWord = await tierApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/tier', headers: adminHeaders, payload: 'tier=growth&reason=offline&confirm=tier' });
  check(wrongTierWord.statusCode === 400 && /Type TIER exactly/.test(wrongTierWord.body), 'a lowercase TIER is refused');
  const tiered = await tierApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/tier', headers: adminHeaders, payload: 'tier=growth&interval=annual&reason=offline+payment&confirm=TIER' });
  check(tiered.statusCode === 303 && String(tiered.headers.location) === '/d/admin/profiles/p-target?done=tier', 'a valid override lands on the detail banner');
  const tieredRow = tierMock.db.profiles.find((row) => row.id === TARGET.id);
  check(tieredRow.subscription_tier === 'growth' && tieredRow.subscription_status === 'ACTIVE' && tieredRow.billing_interval === 'annual',
    'the profile flips to the chosen tier + ACTIVE (engine-owned)');
  const ledger = tierMock.db.subscriptions.find((row) => row.owner_id === TARGET.id);
  check(ledger && ledger.tier === 'growth' && ledger.status === 'ACTIVE' && ledger.source === 'manual', 'the billing ledger gains a line marked manual (no invisible edit)');
  const tierAudit = tierMock.db.admin_audit_logs.find((row) => row.action === 'ADMIN_ACTION_TIER_CHANGED');
  check(tierAudit && tierAudit.details?.before?.tier === 'free' && tierAudit.details?.after?.tier === 'growth' && tierAudit.details?.reason === 'offline payment',
    'the override is audited with before/after + reason');
  const superTier = await tierApp.inject({ method: 'POST', url: '/d/admin/profiles/p-admin/tier', headers: adminHeaders, payload: 'tier=growth&reason=test&confirm=TIER' });
  check(superTier.statusCode === 400 && /superadmin/.test(superTier.body), 'the superadmin account can never be overridden');
  await tierApp.close();

  console.log('\n--- Test 17: force logout ends sessions + impersonations (v1.97.0) ---');
  const logoutMock = createMockSupabase(seed());
  const logoutApp = await makeApp(logoutMock);
  check(logoutMock.db.dashboard_sessions.some((row) => row.owner_id === TARGET.id), 'precondition: the target has a live session');
  const wrongLogoutWord = await logoutApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/force-logout', headers: adminHeaders, payload: 'confirm=logout&reason=lost+phone' });
  check(wrongLogoutWord.statusCode === 400 && /Type LOGOUT exactly/.test(wrongLogoutWord.body), 'a lowercase LOGOUT is refused');
  const logout = await logoutApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/force-logout', headers: adminHeaders, payload: 'confirm=LOGOUT&reason=lost+phone' });
  check(logout.statusCode === 303 && String(logout.headers.location) === '/d/admin/profiles/p-target?done=logout', 'a valid force logout lands on the detail banner');
  check(!logoutMock.db.dashboard_sessions.some((row) => row.owner_id === TARGET.id), 'every session for the account is deleted');
  const logoutAudit = logoutMock.db.admin_audit_logs.find((row) => row.action === 'ADMIN_ACTION_FORCE_LOGOUT');
  check(logoutAudit && logoutAudit.details?.targetId === TARGET.id && logoutAudit.details?.after?.sessions === 1, 'the logout audit records the cleared count');
  const selfLogout = await logoutApp.inject({ method: 'POST', url: '/d/admin/profiles/p-admin/force-logout', headers: adminHeaders, payload: 'confirm=LOGOUT&reason=test' });
  check(selfLogout.statusCode === 400 && /your own session/.test(selfLogout.body), 'the admin cannot force-logout their own session');
  await logoutApp.close();

  console.log('\n--- Test 18: the wipe danger zone (v1.97.0) ---');
  const wipeMock = createMockSupabase(seed());
  const wipeApp = await makeApp(wipeMock);
  const wrongWipe = await wipeApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/wipe', headers: adminHeaders, payload: 'confirm=wipe&reason=gdpr' });
  check(wrongWipe.statusCode === 400 && /Type WIPE exactly/.test(wrongWipe.body) && wipeMock.db.profiles.some((row) => row.id === TARGET.id),
    'a wrong typed word erases nothing');
  const wiped = await wipeApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/wipe', headers: adminHeaders, payload: 'confirm=WIPE&reason=gdpr+request' });
  check(wiped.statusCode === 303 && String(wiped.headers.location) === '/d/admin/profiles?done=wiped', 'a valid wipe lands on the list banner');
  check(!wipeMock.db.profiles.some((row) => row.id === TARGET.id), 'the profile row is gone');
  const wipeAudit = wipeMock.db.admin_audit_logs.find((row) => row.action === 'ADMIN_ACTION_PROFILE_WIPED');
  check(wipeAudit && wipeAudit.details?.targetId === TARGET.id && wipeAudit.details?.reason === 'gdpr request', 'the wipe is audited with reason + target');
  const superWipe = await wipeApp.inject({ method: 'POST', url: '/d/admin/profiles/p-admin/wipe', headers: adminHeaders, payload: 'confirm=WIPE&reason=test' });
  check(superWipe.statusCode === 400 && /superadmin/.test(superWipe.body), 'the superadmin account can never be wiped');
  await wipeApp.close();

  console.log('\n--- Test 19: internal notes + force-verify email (v1.97.0) ---');
  const noteMock = createMockSupabase(seed());
  const noteApp = await makeApp(noteMock);
  const shortNote = await noteApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/note', headers: adminHeaders, payload: 'note=hi' });
  check(shortNote.statusCode === 400 && /at least 3 characters/.test(shortNote.body), 'a too-short note is refused');
  const note = await noteApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/note', headers: adminHeaders, payload: 'note=Called+David+-+pays+next+week' });
  check(note.statusCode === 303 && String(note.headers.location) === '/d/admin/profiles/p-target?done=note', 'a valid note lands on the detail banner');
  const noteRow = noteMock.db.admin_audit_logs.find((row) => row.action === 'ADMIN_PROFILE_NOTE');
  check(noteRow && noteRow.details?.targetId === TARGET.id && noteRow.details?.note.includes('David'), 'the note is stored as an audit row');
  const noteDetail = await noteApp.inject({ method: 'GET', url: '/d/admin/profiles/p-target', headers: { cookie: 'saka_dash=admin-sess' } });
  check(noteDetail.statusCode === 200 && noteDetail.body.includes('pays next week'), 'the note renders back on the detail page');
  const verify = await noteApp.inject({ method: 'POST', url: '/d/admin/profiles/p-target/verify-email', headers: adminHeaders, payload: 'confirm=VERIFY&reason=proven+by+call' });
  check(verify.statusCode === 303 && noteMock.db.profiles.find((row) => row.id === TARGET.id).email_verified === true, 'force-verify marks the email verified');
  check(noteMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_ACTION_EMAIL_VERIFIED' && row.details?.before?.emailVerified === false && row.details?.after?.emailVerified === true),
    'the verification change is audited before/after');
  await noteApp.close();

  console.log(`\n ${passed} admin-action assertions passed.`);
  console.log('Stateless suite: in-memory mock only; nothing was written to the database.');
  if (previousFlag === undefined) delete process.env.DASHBOARD_ENABLED; else process.env.DASHBOARD_ENABLED = previousFlag;
  if (previousAdmin === undefined) delete process.env.SUPERADMIN_PHONE; else process.env.SUPERADMIN_PHONE = previousAdmin;
  if (previousBase === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = previousBase;
}

run().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

