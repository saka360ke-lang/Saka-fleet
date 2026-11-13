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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeOnboardPayload,
  normalizePhoneE164,
  createWebOnboardSession,
  verifyWebOnboardCode,
  resendWebOnboardCode,
  completeWebOnboarding,
  inspectExistingSignup,
  // v1.97.1 — resume an unverified email-matched signup.
  reissueWebOnboardCode,
  pruneExpiredWebOnboardOtps,
  sanitizeUtmValue,
  WEB_ONBOARD_OTP_TABLE,
  WEB_ONBOARD_MAX_ATTEMPTS
} from './src/services/webOnboarding.js';
import { handleStage2OptionalWeaving, saveVehicleAssetRecord } from './src/services/onboarding.js';

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

  function rowMatches(row, [c, v]) {
    if (typeof c === 'string' && c.startsWith('__in__')) {
      const col = c.slice(6);
      return Array.isArray(v) && v.indexOf(row[col]) !== -1;
    }
    if (typeof c === 'string' && c.startsWith('__ilike__')) {
      const col = c.slice(9);
      const value = String(row[col] || '').toLowerCase();
      const pat = String(v || '').toLowerCase();
      if (pat.startsWith('%') && pat.endsWith('%')) return value.indexOf(pat.slice(1, -1)) !== -1;
      if (pat.startsWith('%')) return value.endsWith(pat.slice(1));
      if (pat.endsWith('%')) return value.startsWith(pat.slice(0, -1));
      return value === pat;
    }
    return row[c] === v;
  }

  function makeQuery(rows) {
    const filters = [];
    let orderBy = null;
    const q = {
      eq: (col, value) => { filters.push([col, value]); return q; },
      is: (col, value) => { filters.push([col, value]); return q; },
      in: (col, values) => { filters.push(['__in__' + col, values]); return q; },
      ilike: (col, pattern) => { filters.push(['__ilike__' + col, pattern]); return q; },
      order: (col, opts) => { orderBy = { col, dir: opts?.ascending === false ? 'desc' : 'asc' }; return q; },
      limit: async (n) => {
        let out = rows.filter((row) => filters.every((f) => rowMatches(row, f)));
        if (orderBy) out.sort((a, b) => (orderBy.dir === 'asc'
          ? String(a[orderBy.col]).localeCompare(String(b[orderBy.col]))
          : String(b[orderBy.col]).localeCompare(String(a[orderBy.col]))));
        return { data: out.slice(0, n) };
      },
      maybeSingle: async () => {
        const out = rows.filter((row) => filters.every((f) => rowMatches(row, f)));
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

console.log('\n--- Test 6: existing-account inspection (v1.40.0) ---');
const inspectDb = createMockSupabase({
  profiles: [
    { id: 'p-none', phone_number: '+254700000020', email: 'none@example.com', email_verified: false },
    { id: 'p-verified', phone_number: '+254700000021', email: 'verified@example.com', email_verified: true },
    { id: 'p-other', phone_number: '+254700000022', email: 'old@example.com', email_verified: true },
    // v1.97.1 — the kiddymoms01 shape: an email match that is NOT yet verified.
    { id: 'p-unverified-email', phone_number: '+254700000026', email: 'pending@example.com', email_verified: false }
  ]
});
check((await inspectExistingSignup(inspectDb, { email: 'a@b.com', phone: '+254700000099' })).state === 'none', 'A brand-new phone is "none"');
check((await inspectExistingSignup(inspectDb, { email: 'verified@example.com', phone: '+254700000021' })).state === 'verified', 'A verified account with the same email is "verified"');
check((await inspectExistingSignup(inspectDb, { email: 'new@example.com', phone: '+254700000022' })).state === 'different_email', 'A different address on an existing account is "different_email"');
check((await inspectExistingSignup(inspectDb, { email: 'none@example.com', phone: '+254700000020' })).state === 'unverified', 'An unverified account stays in the normal OTP flow');
// v1.97.1 — the retired "email_exists" state lied to half-finished signups.
const unverifiedEmailMatch = await inspectExistingSignup(inspectDb, { email: 'pending@example.com', phone: '+254721111111' });
check(unverifiedEmailMatch.state === 'unverified' && unverifiedEmailMatch.matchedBy === 'email', 'an UNVERIFIED email match resumes the OTP flow (v1.97.1)');
check((await inspectExistingSignup(inspectDb, { email: 'pending@example.com', phone: '+254700000026' })).state === 'unverified', 'an unverified email + same phone is also "unverified"');

console.log('\n--- Test 6b: reissueWebOnboardCode resumes the SAME account (v1.97.1) ---');
const resumeDb = createMockSupabase({
  profiles: [{ id: 'p-resume', phone_number: '+254720641983', email: 'pending@example.com', email_verified: false, full_name: 'David N' }],
  web_onboard_otps: [],
  admin_audit_logs: []
});
const resumed = await reissueWebOnboardCode(resumeDb, { email: 'Pending@Example.com', phone: '+254721111111', firstName: 'David', lastName: 'N', profile: resumeDb.__db.profiles[0] });
check(resumed.ok === true && /^\d{6}$/.test(String(resumed.code)) && Boolean(resumed.token), 'a fresh code + token are issued');
check(resumeDb.__db.web_onboard_otps.length === 1 && resumeDb.__db.web_onboard_otps[0].phone === '+254720641983', 'the OTP carries the STORED phone, never the retyped one');
check(resumeDb.__db.profiles[0].email_verified === false && resumeDb.__db.profiles[0].phone_number === '+254720641983', 'the profile itself is untouched (no phone overwrite, no new row)');
check(resumeDb.__db.admin_audit_logs.some((a) => a.action === 'WEB_ONBOARD_RESUMED' && a.details?.profileId === 'p-resume'), 'the resume is audited as WEB_ONBOARD_RESUMED');
resumeDb.__db.web_onboard_otps[0].attempts = 2;
const resumedAgain = await reissueWebOnboardCode(resumeDb, { email: 'pending@example.com', profile: resumeDb.__db.profiles[0] });
check(resumedAgain.ok === true && resumedAgain.token === resumed.token && resumeDb.__db.web_onboard_otps.length === 1 && resumeDb.__db.web_onboard_otps[0].attempts === 0,
  'a retry reuses the same session row and resets the attempts');
const refusedVerified = await reissueWebOnboardCode(resumeDb, { email: 'pending@example.com', profile: { ...resumeDb.__db.profiles[0], email_verified: true } });
check(refusedVerified.ok === false && /already verified/i.test(refusedVerified.error), 'a VERIFIED account is never re-issued');

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

console.log('\n--- Test 8: language capture at signup (v1.47.0) ---');
check(sanitizeOnboardPayload({ ...VALID_PAYLOAD, preferred_language: 'swahili' }).data.preferredLanguage === 'Swahili', 'The payload normalises a browser language name');
check(sanitizeOnboardPayload(VALID_PAYLOAD).data.preferredLanguage === null, 'A missing language is null (Saka defaults to English)');
const langDb = createMockSupabase({ profiles: [], admin_audit_logs: [] });
await completeWebOnboarding(langDb, { email: 'lang@example.com', phone: '+254700000030', firstName: 'Lang', lastName: 'User', verified: false, preferredLanguage: 'English' });
check(langDb.__db.profiles[0].preferred_language === 'English', 'The profile stores the captured language');

console.log('\n--- Test 9: launch campaign attribution (v1.58.26) ---');
const utmPayload = sanitizeOnboardPayload({ ...VALID_PAYLOAD, utm_source: 'Meta', utm_medium: 'paid_social', utm_campaign: 'launch-365' });
check(utmPayload.ok === true && utmPayload.data.utm.source === 'meta' && utmPayload.data.utm.medium === 'paid_social' && utmPayload.data.utm.campaign === 'launch-365', 'UTM attribution is sanitised and lower-cased');
check(sanitizeOnboardPayload({ ...VALID_PAYLOAD, utm_source: 'meta; drop table' }).data.utm.source === null, 'Unsafe UTM characters are dropped, never stored');
check(sanitizeOnboardPayload({ ...VALID_PAYLOAD, utm_campaign: 'x'.repeat(65) }).data.utm.campaign === null, 'Over-long UTM values are dropped');
check(sanitizeOnboardPayload(VALID_PAYLOAD).data.utm.source === null && sanitizeUtmValue(undefined) === null, 'A signup without campaign params stores no attribution');
const utmDb = createMockSupabase({ profiles: [], admin_audit_logs: [] });
await completeWebOnboarding(utmDb, { email: 'utm@example.com', phone: '+254700000031', firstName: 'Utm', lastName: 'User', verified: false, preferredLanguage: 'English', utm: { source: 'meta', medium: 'paid_social', campaign: 'launch-365' } });
check(utmDb.__db.profiles[0].utm_source === 'meta' && utmDb.__db.profiles[0].utm_campaign === 'launch-365', 'First-touch attribution lands on the profile');

// v1.49.5 — website signup is mandatory: no registration path may create a
// vehicle (or start the trial) for an email-unverified account, and the legacy
// WhatsApp auth endpoints are removed.
const here = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(here, 'index.js'), 'utf8');
check(!indexSrc.includes('/api/auth/whatsapp/verify') && !indexSrc.includes('/api/auth/whatsapp/request'), 'the legacy WhatsApp auth endpoints are removed');
const quizSrc = fs.readFileSync(path.join(here, 'src/services/quizEngine.js'), 'utf8');
check(quizSrc.includes('ctx.profile?.email_verified !== true'), 'persistVehicleRegistration refuses unverified accounts');
const onbSrc = fs.readFileSync(path.join(here, 'src/services/onboarding.js'), 'utf8');
check(onbSrc.includes('profileData?.email_verified !== true'), 'saveVehicleAssetRecord refuses unverified accounts');
const waSrc = fs.readFileSync(path.join(here, 'src/routes/whatsapp/messages.js'), 'utf8');
check(waSrc.includes('unverified_gated') && waSrc.includes('unverified_gated_media') && /profileData\.email_verified !== true/.test(waSrc), 'the WhatsApp route hard-gates unverified numbers (text and media)');

console.log('\n--- Test 10: phone-primary country lock (v1.59.0) ---');
const lockCreateDb = createMockSupabase({ profiles: [], admin_audit_logs: [] });
await completeWebOnboarding(lockCreateDb, { email: 'lock@example.com', phone: '+254711000001', firstName: 'Lock', lastName: 'Kenya', verified: false });
check(lockCreateDb.__db.profiles[0].country === 'Kenya' && lockCreateDb.__db.profiles[0].country_code === 'KE', 'A website signup stores the country derived from the phone (KE)');
check(lockCreateDb.__db.profiles[0].country_source === 'phone', 'A website signup stamps country_source=phone');

const lockFillDb = createMockSupabase({
  profiles: [{ id: 'p-lock', phone_number: '+254711000002', email: 'missed@example.com', email_verified: false, country: null, country_code: null }],
  admin_audit_logs: []
});
await completeWebOnboarding(lockFillDb, { email: 'missed@example.com', phone: '+254711000002', firstName: 'Missed', lastName: 'Rule', verified: false });
check(lockFillDb.__db.profiles[0].country_code === 'KE' && lockFillDb.__db.profiles[0].country === 'Kenya', 'A signup that missed the country rule is filled from the phone');
check(lockFillDb.__db.admin_audit_logs.some((a) => a.action === 'WEB_ONBOARD_COUNTRY_SET' && a.details?.country_code === 'KE'), 'The country backfill is audited');

const lockUserDb = createMockSupabase({
  profiles: [{ id: 'p-user', phone_number: '+254711000003', email: 'user@example.com', email_verified: true, country: 'Uganda', country_code: 'UG', country_source: 'user' }],
  admin_audit_logs: []
});
await completeWebOnboarding(lockUserDb, { email: 'user@example.com', phone: '+254711000003', firstName: 'U', lastName: 'G', verified: true });
check(lockUserDb.__db.profiles[0].country_code === 'UG', 'An explicit user country choice is never overridden by the phone');

const lockMismatchDb = createMockSupabase({
  profiles: [{ id: 'p-mis', phone_number: '+254711000004', email: 'mis@example.com', email_verified: false, country: 'United States', country_code: 'US', country_source: 'phone' }],
  admin_audit_logs: []
});
await completeWebOnboarding(lockMismatchDb, { email: 'mis@example.com', phone: '+254711000004', firstName: 'M', lastName: 'X', verified: false });
check(lockMismatchDb.__db.profiles[0].country_code === 'KE', 'The phone code wins over a mismatched phone-sourced country');

const lockUnknownDb = createMockSupabase({ profiles: [], admin_audit_logs: [] });
await completeWebOnboarding(lockUnknownDb, { email: 'unk@example.com', phone: '+999711000005', firstName: 'U', lastName: 'N', verified: false });
check(!lockUnknownDb.__db.profiles[0].country && !lockUnknownDb.__db.profiles[0].country_code, 'An unresolvable number never locks a country (GLOBAL stays neutral)');

console.log('\n--- Test 11: launch-offer opt-in (v1.59.1) ---');
check(sanitizeOnboardPayload({ ...VALID_PAYLOAD, launch_opt_in: false }).data.launchOptIn === false, 'An explicit opt-out is carried (strict boolean)');
check(sanitizeOnboardPayload({ ...VALID_PAYLOAD, launch_opt_in: true }).data.launchOptIn === true, 'An explicit opt-in is carried');
check(sanitizeOnboardPayload(VALID_PAYLOAD).data.launchOptIn === null, 'A missing tick is null (the backend default applies)');
check(sanitizeOnboardPayload({ ...VALID_PAYLOAD, launch_opt_in: 'no' }).data.launchOptIn === null, 'A non-boolean value is dropped, never guessed');

const optInDb = createMockSupabase({ profiles: [], admin_audit_logs: [] });
await completeWebOnboarding(optInDb, { email: 'in@example.com', phone: '+254711000011', firstName: 'In', lastName: 'Offer', verified: false });
check(optInDb.__db.profiles[0].launch_opt_in === true, 'A new profile defaults to opted in (checked box)');
check(optInDb.__db.admin_audit_logs.some((a) => a.action === 'WEB_ONBOARD_CREATED' && a.details?.launch_opt_in === true), 'The opt-in default is audited');

const optOutDb = createMockSupabase({ profiles: [], admin_audit_logs: [] });
await completeWebOnboarding(optOutDb, { email: 'out@example.com', phone: '+254711000012', firstName: 'Out', lastName: 'Offer', verified: false, launchOptIn: false });
check(optOutDb.__db.profiles[0].launch_opt_in === false, 'An explicit opt-out is stored on a new profile');

const keepOffDb = createMockSupabase({
  profiles: [{ id: 'p-off', phone_number: '+254711000013', email: 'keep@example.com', email_verified: false, launch_opt_in: false }],
  admin_audit_logs: []
});
await completeWebOnboarding(keepOffDb, { email: 'keep@example.com', phone: '+254711000013', firstName: 'Keep', lastName: 'Off', verified: false });
check(keepOffDb.__db.profiles[0].launch_opt_in === false, 'A duplicate signup without the field never overwrites a stored opt-out');
const switchOnDb = createMockSupabase({
  profiles: [{ id: 'p-sw', phone_number: '+254711000014', email: 'sw@example.com', email_verified: false, launch_opt_in: false }],
  admin_audit_logs: []
});
await completeWebOnboarding(switchOnDb, { email: 'sw@example.com', phone: '+254711000014', firstName: 'S', lastName: 'W', verified: false, launchOptIn: true });
check(switchOnDb.__db.profiles[0].launch_opt_in === true, 'An explicit re-tick on a later visit updates the stored choice');

// v1.63.1 (2C) — onboarding write invalidation spies (stateless chain mock).
console.log('\n--- v1.63.1: onboarding invalidation spies ---');
{
  const deletes = [];
  const builder = (table) => {
    const api = {
      select: () => api,
      eq: () => api,
      in: () => api,
      is: () => api,
      limit: () => api,
      insert: (rows) => {
        const data = Array.isArray(rows) ? rows : [rows];
        const chain = {
          select: () => chain,
          maybeSingle: async () => ({ data: data[0], error: null }),
          single: async () => ({ data: data[0], error: null }),
          then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject)
        };
        return chain;
      },
      update: () => {
        const vehicleRow = table === 'vehicles' ? { id: 'v-1', owner_id: 'own-1' } : null;
        const chain = {
          eq: () => chain,
          is: () => chain,
          select: () => chain,
          maybeSingle: async () => ({ data: vehicleRow, error: null }),
          single: async () => ({ data: vehicleRow, error: null }),
          then: (resolve, reject) => Promise.resolve({ data: vehicleRow, error: null }).then(resolve, reject)
        };
        return chain;
      },
      delete: () => ({ eq: (col, value) => { deletes.push({ table, col, value }); return Promise.resolve({ error: null }); } }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
    };
    return api;
  };
  const client = { from: builder, storage: { from: () => ({ remove: async () => ({ error: null }) }) } };
  const savedResendKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY; // stateless suite: never call the mailer

  const stage2 = await handleStage2OptionalWeaving({
    obState: { core: { plate_number: 'KDA 123A' }, optional: {}, registered_plate: 'KDA 123A' },
    mergedExt: { insurance_expiry: '2026-12-15' },
    messageText: 'insurance expires 2026-12-15',
    senderPhone: '+254712345678',
    session: { state: 'ONBOARDING_STAGE_2', history: [] },
    countryInfo: { country_code: 'KE', default_units: 'metric' },
    supabaseClient: client
  });
  check(typeof stage2 === 'string' && deletes.some((d) => d.table === 'user_context_cache' && d.col === 'phone_number' && d.value === '+254712345678'), 'handleStage2OptionalWeaving invalidates the owner cache (v1.63.1)');

  const saved = await saveVehicleAssetRecord({
    obState: {
      core: { plate_number: 'KDB 456B', make_model: 'Toyota Hilux', yom: '2020', fuel_type: 'Diesel', current_mileage: '1000', vin: 'JT1WEB0000000001', owner_email: 'amina@example.com' },
      optional: {},
      role: 'Owner'
    },
    profileData: { id: 'own-1', email: 'amina@example.com', email_verified: true, trial_used_at: '2026-01-01T00:00:00Z', phone_number: '+254712345678', unit_system: 'metric' },
    countryInfo: { default_units: 'metric', country_code: 'KE' },
    supabaseClient: client,
    formattedPhone: '+254712345678'
  });
  check(saved.corePlate === 'KDB 456B' && deletes.some((d) => d.table === 'user_context_cache' && d.value === '+254712345678'), 'saveVehicleAssetRecord invalidates the cached facts (v1.63.1 - the section 177 claim made true)');
  if (savedResendKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedResendKey;
}

console.log(`\n🎉 ${passed} web-onboarding assertions passed.`);
console.log('Stateless suite: in-memory database double only — no real rows, no cleanup needed.');

