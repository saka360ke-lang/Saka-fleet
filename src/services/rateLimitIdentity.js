import crypto from 'node:crypto';

/**
 * Saka Fleet — real-client identity behind the Google Frontend (v1.90.0)
 * ---------------------------------------------------------------------
 * Cloud Run routes every browser through Google's shared frontend, so the
 * socket peer (request.ip without trustProxy) is a shared GFE address and every
 * per-route rate-limit bucket was effectively global: one noisy user could
 * starve /d/login for the whole fleet.
 *
 * The GFE APPENDS the true client address as the RIGHTMOST x-forwarded-for
 * entry. Reading from the right is therefore spoof-resistant: a caller may
 * write whatever it likes in the earlier entries, but it can never control the
 * address Google adds after it. With no header (direct or internal calls) the
 * socket address is the honest fallback.
 */

export function rightmostClientIp(request) {
  const xff = String(request?.headers?.['x-forwarded-for'] || '').trim();
  if (xff) {
    const hops = xff.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  const socketIp = request?.ip || request?.socket?.remoteAddress;
  return socketIp ? String(socketIp) : 'unknown';
}

/** @fastify/rate-limit keyGenerator — one bucket per real client. */
export function rateLimitKeyGenerator(request) {
  return rightmostClientIp(request);
}

/**
 * v1.91.0 (Phase 28A, D5) — the superadmin action bucket: real client IP PLUS
 * the dashboard session (hashed, never stored raw). Two admins behind the same
 * office NAT get their own 5/5-min budgets, and an anonymous caller can never
 * inherit a signed-in admin's bucket.
 */
export function adminActionKeyGenerator(request) {
  const ip = rightmostClientIp(request);
  const raw = String(request?.headers?.cookie || '');
  const match = raw.match(/(?:^|;\s*)saka_dash=([^;]+)/);
  const session = match && match[1]
    ? crypto.createHash('sha256').update(match[1]).digest('hex').slice(0, 16)
    : 'anon';
  return `${ip}|${session}`;
}

export default { rightmostClientIp, rateLimitKeyGenerator, adminActionKeyGenerator };
