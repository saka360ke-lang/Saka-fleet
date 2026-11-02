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
  return { ok: true, data: { firstName, lastName, email, phone, preferredLanguage } };
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
export async function completeWebOnboarding(supabase, { email, phone, firstName, lastName, verified = false, preferredLanguage = null }) {
  if (!supabase) return { ok: false, error: 'no_client' };
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
  try {
    const { data: existing } = await supabase
      .from('profiles')
      .select('id, email_verified, full_name, preferred_language')
      .eq('phone_number', phone)
      .maybeSingle();

    if (existing) {
      const updates = { updated_at: new Date().toISOString() };
      if (verified) {
        updates.email = email;
        updates.email_verified = true;
      }
      if (fullName && !existing.full_name) updates.full_name = fullName;
      if (preferredLanguage && !existing.preferred_language) updates.preferred_language = preferredLanguage;
      const { error } = await supabase.from('profiles').update(updates).eq('id', existing.id);
      if (error) return { ok: false, error: error.message };
      if (verified) {
        if (existing.email && String(existing.email).toLowerCase() !== String(email).toLowerCase()) {
          await writeAudit(supabase, 'WEB_ONBOARD_EMAIL_UPDATED', { oldEmail: existing.email, newEmail: email, phone, profileId: existing.id });
        } else {
          await writeAudit(supabase, 'WEB_ONBOARD_VERIFIED', { email, phone, profileId: existing.id });
        }
      }
      return { ok: true, created: false };
    }

    const { error } = await supabase.from('profiles').insert([{
      id: crypto.randomUUID(),
      phone_number: phone,
      email,
      email_verified: verified,
      full_name: fullName || 'Asset Owner',
      // Governance (rule 23-26): a new account is ALWAYS Free until the
      // welcome trial starts at vehicle registration. Never inherit a legacy
      // tier default from the live schema.
      subscription_tier: 'free',
      is_active: true,
      preferred_language: preferredLanguage || null
    }]);
    if (error) return { ok: false, error: error.message };
    await writeAudit(supabase, verified ? 'WEB_ONBOARD_VERIFIED' : 'WEB_ONBOARD_CREATED', { email, phone });
    return { ok: true, created: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * WhatsApp fallback: a registered-but-unverified user replies with their
 * 6-digit code. Verifies against their most recent unexpired web session.
 * Returns { verified: true, email } on success, else { verified: false }.
 */
export async function tryVerifyPendingEmailCode(supabase, phone, rawText) {
  if (!supabase) return { verified: false };
  const code = String(rawText || '').trim();
  if (!/^\d{6}$/.test(code)) return { verified: false };
  const now = Date.now();
  const { data: rows } = await supabase
    .from(WEB_ONBOARD_OTP_TABLE)
    .select('*')
    .eq('phone', phone)
    .eq('verified', false)
    .order('created_at', { ascending: false })
    .limit(5);
  const row = (rows || []).find((r) => new Date(r.expires_at).getTime() >= now);
  if (!row || String(row.otp_code) !== code) return { verified: false };

  const attempts = Number(row.attempts || 0) + 1;
  await supabase.from(WEB_ONBOARD_OTP_TABLE).update({ verified: true, attempts }).eq('id', row.id);
  const done = await completeWebOnboarding(supabase, {
    email: row.email,
    phone,
    firstName: row.first_name,
    lastName: row.last_name,
    verified: true
  });
  return { verified: done.ok, email: row.email };
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
  if (!supabase) return { state: 'none' };
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, email_verified')
    .eq('phone_number', phone)
    .maybeSingle();
  if (!profile) return { state: 'none' };
  if (profile.email_verified === true && String(profile.email || '').toLowerCase() === String(email || '').toLowerCase()) {
    return { state: 'verified', profile };
  }
  if (profile.email && String(profile.email).toLowerCase() !== String(email || '').toLowerCase()) {
    return { state: 'different_email', profile };
  }
  return { state: 'unverified', profile };
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


