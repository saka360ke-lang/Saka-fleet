/**
 * Saka Fleet — superadmin identity (v1.76.0, Phase 15)
 * ---------------------------------------------------
 * The env-based superadmin check lives here — a tiny, dependency-free module —
 * so the dashboard can verify the same identity WITHOUT importing the
 * superadmin service (which pulls the Sentinel worker). `superadmin.js`
 * re-exports these for every existing caller; there is exactly one source.
 */

/** Digits-only match against SUPERADMIN_PHONE. */
export function isSuperadminPhone(senderPhone) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  if (!superadminPhone || !senderPhone) return false;
  const clean = (p) => p.toString().replace(/[^\d]/g, '');
  return clean(senderPhone) === clean(superadminPhone);
}

/** Case-insensitive match against SUPERADMIN_EMAIL. */
export function isSuperadminEmail(email) {
  const superadminEmail = process.env.SUPERADMIN_EMAIL;
  if (!superadminEmail || !email) return false;
  return email.trim().toLowerCase() === superadminEmail.trim().toLowerCase();
}

export default { isSuperadminPhone, isSuperadminEmail };
