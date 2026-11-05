/**
 * Saka Fleet — Web Onboarding Service (v1.39.0)
 * ---------------------------------------------
 * Server-side handshake for the sakafleet.com marketing site:
 *   POST /api/onboard          -> validate lead, send the email OTP, seed profile
 *   POST /api/onboard/verify   -> check the code, mark the profile email_verified
 *   POST /api/onboard/resend   -> re-send the code (60-second cooldown)
 * Plus the in-WhatsApp fallback: a registered-but-unverified user can reply
 * with their 6-digit code and Saka verifies it in chat.
 *
 * Governance (rule 26): the welcome trial is NEVER started here. Trials begin
 * when the user registers their first asset with Saka on WhatsApp.
 */

import crypto from 'crypto';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { sendExistingAccountNoticeEmail } from './mailer.js';
import { resolvePhoneCountryLock } from './globalization.js';
import { countryPatchForProfile, COUNTRY_SOURCE_DEFAULT } from './countryLock.js';

export const WEB_ONBOARD_OTP_TABLE = 'web_onboard_otps';
export const WEB_ONBOARD_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const WEB_ONBOARD_MAX_ATTEMPTS = 3;
export const WEB_ONBOARD_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const WEB_ONBOARD_AUDIT_ACTOR = 'WEB_ONBOARD';

export const WEB_ONBOARD_OTP_SQL = `
CREATE TABLE IF NOT EXISTS public.${WEB_ONBOARD_OTP_TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    onboard_token text UNIQUE NOT NULL,
    email text NOT NULL,
    phone text NOT NULL,
    first_name text,
    last_name text,
    otp_code text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    verified boolean NOT NULL DEFAULT false,
    last_sent_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_onboard_otps_email ON public.${WEB_ONBOARD_OTP_TABLE} (email);
CREATE INDEX IF NOT EXISTS idx_web_onboard_otps_phone ON public.${WEB_ONBOARD_OTP_TABLE} (phone);
CREATE INDEX IF NOT EXISTS idx_web_onboard_otps_expires ON public.${WEB_ONBOARD_OTP_TABLE} (expires_at DESC);
ALTER TABLE public.${WEB_ONBOARD_OTP_TABLE} ENABLE ROW LEVEL SECURITY;
`;

let tableReady = false;

/** Ensure the OTP table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureWebOnboardOtpTable(providedSupabase) {
  if (!providedSupabase) return { status: 'no_client' };
  const { error } = await providedSupabase.from(WEB_ONBOARD_OTP_TABLE).select('id').limit(1);
  if (!error) {
    tableReady = true;
    return { status: 'exists' };
  }
  if (hasSqlAccess()) {
    const result = await runSql(WEB_ONBOARD_OTP_SQL, { label: 'ensureWebOnboardOtpTable' });
    if (result.ok) {
      tableReady = true;
      return { status: 'created' };
    }
  }
  return { status: 'missing' };
}

export function isWebOnboardTableReady() {
  return tableReady;
}

/** E.164 normalisation: digits only, 9–15 long, returned with a leading +. */
export function normalizePhoneE164(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Normalise a browser language name to a short, title-cased display name. */
export function normalizeLanguageName(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 40 || !/^[a-zA-Z][a-zA-Z -]*$/.test(raw)) return null;
  return raw.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Strict payload gate: names, valid email, E.164 phone and consent. */
export function sanitizeOnboardPayload(body = {}) {
  const firstName = String(body?.first_name || '').trim().slice(0, 60);
  const lastName = String(body?.last_name || '').trim().slice(0, 60);
  const email = String(body?.email || '').trim().toLowerCase();
  const phone = normalizePhoneE164(body?.phone);
  const preferredLanguage = normalizeLanguageName(body?.preferred_language);
  if (!firstName || !lastName) return { ok: false, error: 'First and last name are required.' };
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) return { ok: false, error: 'A valid email address is required.' };
  if (!phone) return { ok: false, error: 'A valid WhatsApp number in international format is required.' };
  if (body?.consent !== true) return { ok: false, error: 'The Terms & Conditions and Privacy Policy consent is required.' };
  // v1.58.26 — campaign attribution (UTM) is optional and strictly sanitized:
  // 64 chars max, letters/digits/_-.~ and spaces only; anything else is dropped.
  const utm = {
    source: sanitizeUtmValue(body?.utm_source),
    medium: sanitizeUtmValue(body?.utm_medium),
    campaign: sanitizeUtmValue(body?.utm_campaign)
  };
  return { ok: true, data: { firstName, lastName, email, phone, preferredLanguage, utm } };
}

/** Campaign tag gate: null when absent/invalid (never an error for the user). */
export function sanitizeUtmValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.length > 64) return null;
  if (!/^[a-zA-Z0-9._~ -]+$/.test(raw)) return null;
  return raw.toLowerCase();
}

function mintOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function mintToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function writeAudit(supabase, action, details = {}) {
  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: WEB_ONBOARD_AUDIT_ACTOR,
      action,
      details
    }]);
  } catch { /* audit is best-effort */ }
}

/**
 * Create a fresh OTP session for a web signup. Returns the opaque
 * onboard_token and the code to email (the code is never echoed to a browser).
 */
export async function createWebOnboardSession(supabase, { email, phone, firstName, lastName }) {
  if (!supabase) return { ok: false, error: 'no_client' };
  const code = mintOtp();
  const token = mintToken();
  const expiresAt = new Date(Date.now() + WEB_ONBOARD_OTP_TTL_MS).toISOString();
  const { error } = await supabase.from(WEB_ONBOARD_OTP_TABLE).insert([{
    onboard_token: token,
    email,
    phone,
    first_name: firstName,
    last_name: lastName,
    otp_code: code,
    attempts: 0,
    verified: false,
    last_sent_at: new Date().toISOString(),
    expires_at: expiresAt
  }]);
  if (error) return { ok: false, error: error.message };
  return { ok: true, token, code, email, phone };
}
/** Verify a code against its session. Success consumes the row. */
export async function verifyWebOnboardCode(supabase, { token, code }) {
  if (!supabase) return { ok: false, error: 'Database unavailable.' };
  const { data: row } = await supabase
    .from(WEB_ONBOARD_OTP_TABLE)
    .select('*')
    .eq('onboard_token', String(token || ''))
    .maybeSingle();
  if (!row) return { ok: false, error: 'This verification session is unknown. Please start again.' };
  if (row.verified) return { ok: false, error: 'This email is already verified.' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'That code has expired. Please request a new one.' };
  if (Number(row.attempts || 0) >= WEB_ONBOARD_MAX_ATTEMPTS) {
    return { ok: false, error: 'Too many incorrect codes. Please start again with a fresh code.' };
  }

  const attempts = Number(row.attempts || 0) + 1;
  if (String(code) !== String(row.otp_code)) {
    const failed = attempts >= WEB_ONBOARD_MAX_ATTEMPTS;
    await supabase.from(WEB_ONBOARD_OTP_TABLE).update({ attempts }).eq('id', row.id);
    if (failed) {
      await writeAudit(supabase, 'WEB_ONBOARD_OTP_LOCKED', { email: row.email, phone: row.phone });
      return { ok: false, error: 'Too many incorrect codes. Please start again with a fresh code.' };
    }
    return { ok: false, error: 'That code did not match. Please check and try again.' };
  }

  const { error: updateErr } = await supabase.from(WEB_ONBOARD_OTP_TABLE)
    .update({ verified: true, attempts })
    .eq('id', row.id);
  if (updateErr) return { ok: false, error: 'Could not record verification.' };

  // Flip the profile (created by /api/onboard or by WhatsApp first contact).
  await completeWebOnboarding(supabase, {
    email: row.email,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    verified: true
  });
  return { ok: true, email: row.email, phone: row.phone };
}

/** Re-send the code for an active session (60-second cooldown, same token). */
export async function resendWebOnboardCode(supabase, { token }) {
  if (!supabase) return { ok: false, error: 'Database unavailable.' };
  const { data: row } = await supabase
    .from(WEB_ONBOARD_OTP_TABLE)
    .select('*')
    .eq('onboard_token', String(token || ''))
    .maybeSingle();
  if (!row || row.verified) return { ok: false, error: 'This verification session is unknown. Please start again.' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'That code has expired. Please start again.' };
  const lastSent = row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
  const waitMs = lastSent + WEB_ONBOARD_RESEND_COOLDOWN_MS - Date.now();
  if (waitMs > 0) {
    return { ok: false, error: `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code.`, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  }

  const code = mintOtp();
  const { error } = await supabase.from(WEB_ONBOARD_OTP_TABLE).update({
    otp_code: code,
    last_sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + WEB_ONBOARD_OTP_TTL_MS).toISOString()
  }).eq('id', row.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, code, email: row.email };
}
/**
 * Upsert the profile for a web signup. `verified` is only flipped true after a
 * code was matched. Never touches subscription state and never starts a trial.
 */
export async function completeWebOnboarding(supabase, { email, phone, firstName, lastName, verified = false, preferredLanguage = null, utm = null }) {
  if (!supabase) return { ok: false, error: 'no_client' };
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
  try {
    // v1.58.14 - resolve by phone variants (E.164 / bare / 9-digit tail) so a
    // local-format submission reuses the existing profile instead of inserting
    // a duplicate.
    const existing = await findProfileByPhone(supabase, phone);

    if (existing) {
      const updates = { updated_at: new Date().toISOString() };
      if (verified) {
        updates.email = email;
        updates.email_verified = true;
      }
      if (fullName && !existing.full_name) updates.full_name = fullName;
      if (preferredLanguage && !existing.preferred_language) updates.preferred_language = preferredLanguage;
      // v1.58.26 — first-touch attribution only; never overwrite an existing tag.
      if (utm?.source && !existing.utm_source) updates.utm_source = utm.source;
      if (utm?.medium && !existing.utm_medium) updates.utm_medium = utm.medium;
      if (utm?.campaign && !existing.utm_campaign) updates.utm_campaign = utm.campaign;
      // v1.59.0 — the phone's E.164 country code is PRIMARY: fill a missing
      // country or correct a mismatch unless the user explicitly chose one.
      const countryPatch = countryPatchForProfile(existing, phone);
      if (countryPatch) Object.assign(updates, countryPatch);
      let { error } = await supabase.from('profiles').update(updates).eq('id', existing.id);
      if (error && /country_source/i.test(error.message || '')) {
        // Rule 50 — an un-migrated optional column never blocks a signup.
        delete updates.country_source;
        ({ error } = await supabase.from('profiles').update(updates).eq('id', existing.id));
      }
      if (error) return { ok: false, error: error.message };
      if (countryPatch) {
        await writeAudit(supabase, 'WEB_ONBOARD_COUNTRY_SET', {
          email, phone, profileId: existing.id,
          country: countryPatch.country, country_code: countryPatch.country_code, source: 'phone'
        });
      }
      if (verified) {
        if (existing.email && String(existing.email).toLowerCase() !== String(email).toLowerCase()) {
          await writeAudit(supabase, 'WEB_ONBOARD_EMAIL_UPDATED', { oldEmail: existing.email, newEmail: email, phone, profileId: existing.id });
        } else {
          await writeAudit(supabase, 'WEB_ONBOARD_VERIFIED', { email, phone, profileId: existing.id });
        }
      }
      return { ok: true, created: false };
    }

    // v1.59.0 — phone-primary country lock: the E.164 country code of the
    // WhatsApp number decides the stored country. Browser locale never does.
    const phoneCountry = resolvePhoneCountryLock(phone);
    const profileRow = {
      id: crypto.randomUUID(),
      phone_number: phone,
      email,
      email_verified: verified,
      full_name: fullName || 'Asset Owner',
      // Governance (rule 23-26): a new account is ALWAYS Free until the
      // welcome trial starts at vehicle registration. Never inherit a legacy
      // tier default from the live schema.
      subscription_tier: 'free',
      subscription_status: 'ACTIVE',
      // v1.58.13 — never inherit the legacy `now() + 90 days` trial_ends_at
      // default: a fresh account has no trial until its welcome trial starts.
      trial_ends_at: null,
      is_active: true,
      preferred_language: preferredLanguage || null,
      ...(phoneCountry ? { country: phoneCountry.country, country_code: phoneCountry.country_code } : {})
    };
    // v1.58.26 — campaign attribution rides the insert when present.
    const utmColumns = {};
    if (utm?.source) utmColumns.utm_source = utm.source;
    if (utm?.medium) utmColumns.utm_medium = utm.medium;
    if (utm?.campaign) utmColumns.utm_campaign = utm.campaign;
    // Rule 50 — every optional column degrades independently; a schema that has
    // not been migrated yet must never block a signup.
    const optionalColumns = { ...utmColumns };
    if (phoneCountry) optionalColumns.country_source = COUNTRY_SOURCE_DEFAULT;

    let { error } = await supabase.from('profiles').insert([{ ...profileRow, ...optionalColumns }]);
    if (error && /country_source/i.test(error.message || '')) {
      delete optionalColumns.country_source;
      ({ error } = await supabase.from('profiles').insert([{ ...profileRow, ...optionalColumns }]));
    }
    if (error && /utm_|column .* does not exist|schema cache/i.test(error.message || '')) {
      ({ error } = await supabase.from('profiles').insert([profileRow]));
    }
    if (error) return { ok: false, error: error.message };
    await writeAudit(supabase, verified ? 'WEB_ONBOARD_VERIFIED' : 'WEB_ONBOARD_CREATED', {
      email, phone, country_code: phoneCountry?.country_code || null
    });
    return { ok: true, created: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


/**
 * v1.40.0 — existing-account inspection for /api/onboard.
 *   'none'            -> brand-new visitor, normal OTP flow
 *   'unverified'      -> profile exists, email not yet verified, normal OTP flow
 *   'verified'        -> profile exists AND verified with the SAME email:
 *                        never re-onboard; the site shows "you're all set"
 *   'different_email' -> profile exists but with another address: OTP verifies
 *                        the new address and the profile email is updated
 */
export async function inspectExistingSignup(supabase, { email, phone }) {
  const { profile, matchedBy } = await findExistingProfile(supabase, { email, phone });
  if (!profile) return { state: 'none', matchedBy: null };
  const sameEmail = String(profile.email || '').toLowerCase() === String(email || '').toLowerCase();
  if (matchedBy === 'email') return { state: 'email_exists', profile, matchedBy };
  if (profile.email_verified === true && sameEmail) return { state: 'verified', profile, matchedBy };
  if (profile.email && !sameEmail) return { state: 'different_email', profile, matchedBy };
  return { state: 'unverified', profile, matchedBy };
}

/** Public audit helper so routes can stamp web-onboarding events. */
export async function auditWebOnboardEvent(supabase, action, details = {}) {
  await writeAudit(supabase, action, details);
}

/**
 * v1.40.0 — housekeeping: expired OTP sessions are dead weight and a
 * verification surface; prune anything older than one day. Runs at boot and
 * every 15 minutes.
 */
export async function pruneExpiredWebOnboardOtps(supabase) {
  if (!supabase) return { ok: false };
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from(WEB_ONBOARD_OTP_TABLE)
    .delete()
    .lt('expires_at', cutoff);
  return { ok: !error, error: error?.message };
}

/**
 * v1.58.14 - phone-lookup variants. A user may type a local "07..." number,
 * the bare digits, or the full E.164 form, while profiles store E.164. The
 * 9-digit national tail lets a local-format submission match a stored "+254...".
 */
export function phoneVariants(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) return [];
  const variants = ['+' + digits, digits];
  const tail = digits.slice(-9);
  if (tail.length === 9 && variants.indexOf(tail) === -1) variants.push(tail);
  return variants;
}

/** Find a profile by phone variants (exact E.164/bare, then 9-digit suffix). */
const PROFILE_BASE_SELECT = 'id, email, email_verified, phone_number, full_name, preferred_language';
// v1.59.0 — country context rides the duplicate lookup; a schema that has not
// applied `country_source` yet degrades to the base columns (rule 50).
const PROFILE_CONTEXT_SELECT = `${PROFILE_BASE_SELECT}, country, country_code, country_source`;

async function runProfileQuery(supabase, build) {
  let { data, error } = await build(PROFILE_CONTEXT_SELECT);
  if (error) {
    ({ data, error } = await build(PROFILE_BASE_SELECT));
  }
  return { data, error };
}

export async function findProfileByPhone(supabase, phone) {
  if (!supabase) return null;
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  const { data: exact } = await runProfileQuery(supabase, (select) =>
    supabase.from('profiles').select(select).in('phone_number', variants).limit(3));
  if (exact && exact.length) return { ...exact[0] };
  const tail = variants[variants.length - 1];
  if (tail.length !== 9) return null;
  const { data: byTail } = await runProfileQuery(supabase, (select) =>
    supabase.from('profiles').select(select).ilike('phone_number', '%' + tail).limit(3));
  return byTail && byTail.length ? { ...byTail[0] } : null;
}

/** Find a profile by phone (variants) OR email (case-insensitive). */
export async function findExistingProfile(supabase, { email, phone }) {
  const byPhone = await findProfileByPhone(supabase, phone);
  if (byPhone) return { profile: byPhone, matchedBy: 'phone' };
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail) {
    const { data: byEmail } = await supabase.from('profiles').select('id, email, email_verified, phone_number, full_name, preferred_language').ilike('email', normalizedEmail).limit(3);
    if (byEmail && byEmail.length) return { profile: byEmail[0], matchedBy: 'email' };
  }
  return { profile: null, matchedBy: null };
}

/** Mask a phone for the duplicate-signup email: +254****852529. */
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length < 6) return String(phone || '');
  const head = digits.slice(0, Math.min(4, digits.length - 4));
  const tail = digits.slice(-4);
  const stars = new Array(Math.max(2, digits.length - head.length - tail.length) + 1).join('*');
  return '+' + head + stars + tail;
}

/**
 * v1.58.14 - notify the account owner that a duplicate signup was blocked.
 * Emails the stored address and pings the stored WhatsApp number (if a sender
 * is injected), then stamps an audit row. Never throws.
 */
export async function notifyExistingSignup(supabase, { profile, email = null, phone = null, sendWhatsApp = null }) {
  if (!profile) return { ok: false, reason: 'no-profile' };
  const masked = maskPhone(profile.phone_number);
  let emailed = false;
  if (profile.email) {
    try { emailed = await sendExistingAccountNoticeEmail(profile.email, { maskedPhone: masked }); } catch { emailed = false; }
  }
  let whatsapped = false;
  if (profile.phone_number && typeof sendWhatsApp === 'function') {
    try {
      const text = "You already have a Saka account! We stopped a duplicate sign-up on sakafleet.com using your details. No new account was created - just message me here and we will keep going.";
      whatsapped = (await sendWhatsApp(profile.phone_number, text)) !== false;
    } catch { whatsapped = false; }
  }
  await writeAudit(supabase, 'WEB_ONBOARD_DUPLICATE_NOTIFIED', { email: email || null, phone: phone || null, profileId: profile.id, emailed, whatsapped });
  return { ok: true, emailed, whatsapped, masked };
}


