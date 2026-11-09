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

export default { rightmostClientIp, rateLimitKeyGenerator };
