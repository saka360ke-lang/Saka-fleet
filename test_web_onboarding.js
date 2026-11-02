/**
 * Saka Fleet — Web onboarding service tests (v1.39.0, stateless)
 * --------------------------------------------------------------
 * Proves the sakafleet.com signup handshake: strict payload gate, durable OTP
 * session, attempt/expiry/cooldown rules, profile upsert without subscription
 * side effects, and the in-WhatsApp code fallback. All database work runs
 * against an in-memory Supabase double — no real rows, no cleanup needed.
 *
 * Run: node test_web_onboarding.js
 */

import assert from 'assert';
import {
  sanitizeOnboardPayload,
  normalizePhoneE164,
  createWebOnboardSession,
  verifyWebOnboardCode,
  resendWebOnboardCode,
  completeWebOnboarding,
  tryVerifyPendingEmailCode,
  inspectExistingSignup,
  pruneExpiredWebOnboardOtps,
  WEB_ONBOARD_OTP_TABLE,
  WEB_ONBOARD_MAX_ATTEMPTS
} from './src/services/webOnboarding.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

/** In-memory Supabase double covering the exact PostgREST chains we use. */
function createMockSupabase(seed = {}) {
  const db = {};
  for (const [name, rows] of Object.entries(seed)) db[name] = rows.map((row) => ({ ...row }));

  function makeQuery(rows) {
    const filters = [];
    let orderBy = null;
    const q = {
      eq: (col, value) => { filters.push([col, value]); return q; },
      is: (col, value) => { filters.push([col, value]); return q; },
      order: (col, opts) => { orderBy = { col, dir: opts?.ascending === false ? 'desc' : 'asc' }; return q; },
      limit: async (n) => {
        let out = rows.filter((row) => filters.every(([c, v]) => row[c] === v));
        if (orderBy) out.sort((a, b) => (orderBy.dir === 'asc'
          ? String(a[orderBy.col]).localeCompare(String(b[orderBy.col]))
          : String(b[orderBy.col]).localeCompare(String(a[orderBy.col]))));
        return { data: out.slice(0, n) };
      },
      maybeSingle: async () => {
        const out = rows.filter((row) => filters.every(([c, v]) => row[c] === v));
        return out.length === 0 ? { data: null } : { data: { ...out[0] } };
      }
    };
    return q;
  }

  return {
    __db: db,
    from: (name) => {
      const rows = db[name] || (db[name] = []);
      return {
        insert: (payload) => {
          const items = Array.isArray(payload) ? payload : [payload];
          for (const item of items) rows.push({ ...item });
          return {
            select: () => ({ maybeSingle: async () => ({ data: items[0] || null }), single: async () => ({ data: items[0] || null }) })
          };
        },
        select: () => makeQuery(rows),
        delete: () => ({
          lt: async (col, value) => {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (String(rows[i][col]) < String(value)) rows.splice(i, 1);
            }
            return { error: null };
          }
        }),
        update: (payload) => ({
          eq: async (col, value) => {
            let touched = 0;
            for (const row of rows) {
              if (row[col] === value) { Object.assign(row, payload); touched += 1; }
            }
            return { error: touched ? null : new Error('row not found') };
          }
        })
      };
    }
  };
}

const VALID_PAYLOAD = {
  first_name: ' Amina ',
  last_name: 'Wanjiru',
  email: 'AMINA@Example.COM',
  phone: '+254 712 345 678',
  consent: true
};

console.log('--- Test 1: payload gate ---');
check(sanitizeOnboardPayload({}).ok === false, 'An empty payload is refused');
check(/consent/i.test(sanitizeOnboardPayload({ ...VALID_PAYLOAD, consent: false }).error), 'Missing consent is refused');
check(/email/i.test(sanitizeOnboardPayload({ ...VALID_PAYLOAD, email: 'not-an-email' }).error), 'An invalid email is refused');
check(/whatsapp/i.test(sanitizeOnboardPayload({ ...VALID_PAYLOAD, phone: '+123' }).error), 'A short phone is refused');
check(normalizePhoneE164('+254 712 345 678') === '+254712345678', 'Phones normalise to E.164');
const clean = sanitizeOnboardPayload(VALID_PAYLOAD);
check(clean.ok && clean.data.email === 'amina@example.com' && clean.data.firstName === 'Amina', 'Names and email are trimmed/normalised');

console.log('\n--- Test 2: session lifecycle ---');
const supabase = createMockSupabase({ profiles: [], web_onboard_otps: [], admin_audit_logs: [] });
const created = await createWebOnboardSession(supabase, { email: 'amina@example.com', phone: '+254712345678', firstName: 'Amina', lastName: 'Wanjiru' });
check(created.ok && created.token && /^\d{6}$/.test(created.code), 'A session mints a token and a 6-digit code');
const row = supabase.__db[WEB_ONBOARD_OTP_TABLE][0];
check(row && new Date(row.expires_at).getTime() > Date.now(), 'The OTP row expires in the future');

const wrong1 = await verifyWebOnboardCode(supabase, { token: created.token, code: '000000' });
const wrong2 = await verifyWebOnboardCode(supabase, { token: created.token, code: '111111' });
check(wrong1.ok === false && wrong2.ok === false, 'Wrong codes are refused');
check(supabase.__db[WEB_ONBOARD_OTP_TABLE][0].attempts === 2, 'Failed attempts are counted');

const verified = await verifyWebOnboardCode(supabase, { token: created.token, code: created.code });
check(verified.ok === true && verified.email === 'amina@example.com', 'The right code verifies the email');
check(supabase.__db[WEB_ONBOARD_OTP_TABLE][0].verified === true, 'The session row is consumed');
const profile = supabase.__db.profiles.find((p) => p.phone_number === '+254712345678');
check(profile && profile.email_verified === true && profile.email === 'amina@example.com', 'The profile is flipped to email-verified');
check(supabase.__db.admin_audit_logs.some((a) => a.action === 'WEB_ONBOARD_VERIFIED'), 'Verification is audited');
check(!supabase.__db.trial_sessions, 'No trial table was touched — the trial never starts at web signup');
console.log('\n--- Test 3: attempts, expiry and cooldown ---');
const lockDb = createMockSupabase({ profiles: [], web_onboard_otps: [], admin_audit_logs: [] });
const lockSession = await createWebOnboardSession(lockDb, { email: 'lock@example.com', phone: '+254700000001', firstName: 'L', lastName: 'K' });
for (let i = 0; i < WEB_ONBOARD_MAX_ATTEMPTS; i += 1) {
  await verifyWebOnboardCode(lockDb, { token: lockSession.token, code: '999999' });
}
const locked = await verifyWebOnboardCode(lockDb, { token: lockSession.token, code: lockSession.code });
check(locked.ok === false && /too many/i.test(locked.error), 'Three wrong codes lock the session');

const expDb = createMockSupabase({ profiles: [], web_onboard_otps: [], admin_audit_logs: [] });
const expSession = await createWebOnboardSession(expDb, { email: 'exp@example.com', phone: '+254700000002', firstName: 'E', lastName: 'X' });
expDb.__db[WEB_ONBOARD_OTP_TABLE][0].expires_at = new Date(Date.now() - 1000).toISOString();
check((await verifyWebOnboardCode(expDb, { token: expSession.token, code: expSession.code })).ok === false, 'An expired code is refused');

const coolDb = createMockSupabase({ profiles: [], web_onboard_otps: [], admin_audit_logs: [] });
const coolSession = await createWebOnboardSession(coolDb, { email: 'cool@example.com', phone: '+254700000003', firstName: 'C', lastName: 'D' });
const blocked = await resendWebOnboardCode(coolDb, { token: coolSession.token });
check(blocked.ok === false && blocked.retryAfterSeconds > 0, 'Resend is rate-limited for 60 seconds');
coolDb.__db[WEB_ONBOARD_OTP_TABLE][0].last_sent_at = new Date(Date.now() - 120000).toISOString();
const resent = await resendWebOnboardCode(coolDb, { token: coolSession.token });
check(resent.ok === true && resent.code !== coolSession.code, 'A fresh code mints after the cooldown');
check((await verifyWebOnboardCode(coolDb, { token: coolSession.token, code: resent.code })).ok === true, 'The resent code verifies');

console.log('\n--- Test 4: profile upsert never touches subscriptions ---');
const keepDb = createMockSupabase({
  profiles: [{ id: 'p-keep', phone_number: '+254700000009', email: 'old@example.com', email_verified: false, full_name: 'Keep Me', subscription_status: 'TRIALING', subscription_tier: 'solo_pro' }],
  admin_audit_logs: []
});
const keepResult = await completeWebOnboarding(keepDb, { email: 'new@example.com', phone: '+254700000009', firstName: 'New', lastName: 'Name', verified: true });
check(keepResult.ok === true && keepResult.created === false, 'An existing profile is updated, not duplicated');
const kept = keepDb.__db.profiles[0];
check(kept.subscription_status === 'TRIALING' && kept.subscription_tier === 'solo_pro', 'Subscription state is never touched');
check(kept.full_name === 'Keep Me', 'An existing name is never overwritten');
check(kept.email_verified === true && kept.email === 'new@example.com', 'Only the email/verified flags move on verification');

const freshDb = createMockSupabase({ profiles: [], admin_audit_logs: [] });
const freshResult = await completeWebOnboarding(freshDb, { email: 'fresh@example.com', phone: '+254700000010', firstName: 'Fresh', lastName: 'Start', verified: false });
check(freshResult.ok === true && freshResult.created === true, 'A new profile is created');
check(freshDb.__db.profiles[0].email_verified === false, 'An unverified signup stays unverified until the code matches');
check(freshDb.__db.profiles[0].subscription_tier === 'free', 'A new web account is explicitly Free — never a legacy tier default');

console.log('\n--- Test 5: WhatsApp fallback code check ---');
const waDb = createMockSupabase({ profiles: [], web_onboard_otps: [], admin_audit_logs: [] });
const waSession = await createWebOnboardSession(waDb, { email: 'wa@example.com', phone: '+254700000011', firstName: 'Wa', lastName: 'User' });
await completeWebOnboarding(waDb, { email: 'wa@example.com', phone: '+254700000011', firstName: 'Wa', lastName: 'User', verified: false });
check((await tryVerifyPendingEmailCode(waDb, '+254700000011', 'not a code')).verified === false, 'Non-code messages never verify');
check((await tryVerifyPendingEmailCode(waDb, '+254700000011', '000000')).verified === false, 'A wrong code never verifies');
const waDone = await tryVerifyPendingEmailCode(waDb, '+254700000011', waSession.code);
check(waDone.verified === true && waDone.email === 'wa@example.com', 'The right code verifies in WhatsApp');
check(waDb.__db.profiles[0].email_verified === true, 'The WhatsApp fallback flips the profile');

console.log('\n--- Test 6: existing-account inspection (v1.40.0) ---');
const inspectDb = createMockSupabase({
  profiles: [
    { id: 'p-none', phone_number: '+254700000020', email: 'none@example.com', email_verified: false },
    { id: 'p-verified', phone_number: '+254700000021', email: 'verified@example.com', email_verified: true },
    { id: 'p-other', phone_number: '+254700000022', email: 'old@example.com', email_verified: true }
  ]
});
check((await inspectExistingSignup(inspectDb, { email: 'a@b.com', phone: '+254700000099' })).state === 'none', 'A brand-new phone is "none"');
check((await inspectExistingSignup(inspectDb, { email: 'verified@example.com', phone: '+254700000021' })).state === 'verified', 'A verified account with the same email is "verified"');
check((await inspectExistingSignup(inspectDb, { email: 'new@example.com', phone: '+254700000022' })).state === 'different_email', 'A different address on an existing account is "different_email"');
check((await inspectExistingSignup(inspectDb, { email: 'none@example.com', phone: '+254700000020' })).state === 'unverified', 'An unverified account stays in the normal OTP flow');

console.log('\n--- Test 7: email-change audit + prune (v1.40.0) ---');
const changeDb = createMockSupabase({
  profiles: [{ id: 'p-chg', phone_number: '+254700000023', email: 'old@example.com', email_verified: true, full_name: 'Keeper' }],
  admin_audit_logs: []
});
await completeWebOnboarding(changeDb, { email: 'new@example.com', phone: '+254700000023', firstName: 'A', lastName: 'B', verified: true });
check(changeDb.__db.admin_audit_logs.some((a) => a.action === 'WEB_ONBOARD_EMAIL_UPDATED' && a.details?.oldEmail === 'old@example.com' && a.details?.newEmail === 'new@example.com'), 'A verified email change is audited with old and new addresses');

const pruneDb = createMockSupabase({ web_onboard_otps: [
  { id: 'row-old', email: 'o@example.com', phone: '+254700000024', otp_code: '111111', verified: false, expires_at: new Date(Date.now() - 2 * 86400000).toISOString() },
  { id: 'row-new', email: 'n@example.com', phone: '+254700000025', otp_code: '222222', verified: false, expires_at: new Date(Date.now() + 600000).toISOString() }
] });
await pruneExpiredWebOnboardOtps(pruneDb);
check(!pruneDb.__db.web_onboard_otps.some((r) => r.id === 'row-old'), 'Expired OTP sessions are pruned');
check(pruneDb.__db.web_onboard_otps.some((r) => r.id === 'row-new'), 'Fresh OTP sessions survive the prune');

console.log(`\n🎉 ${passed} web-onboarding assertions passed.`);
console.log('Stateless suite: in-memory database double only — no real rows, no cleanup needed.');

