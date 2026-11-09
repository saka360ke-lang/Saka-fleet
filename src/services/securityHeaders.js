/**
 * Saka Fleet — transport security at the Google edge (v1.90.0, Phase 28B)
 * ----------------------------------------------------------------------
 * Cloud Run terminates TLS at the Google Frontend, so the container only ever
 * sees plain HTTP plus `x-forwarded-proto`. Two guarantees are added here:
 *
 *   1. HSTS — every response that arrived over HTTPS carries
 *      `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
 *      Verified live before shipping (2026-11-09): sakafleet.com,
 *      www.sakafleet.com, app.sakafleet.com and reports.sakafleet.com ALL
 *      answer plain HTTP with a redirect to HTTPS, so includeSubDomains is safe.
 *   2. A 308 HTTP -> HTTPS redirect for any request the proxy marked as plain
 *      HTTP — EXCEPT the status probes. Google's edge intercepts /healthz on
 *      the custom domain (v1.24.4), platform health checks carry no
 *      x-forwarded-proto at all, and a redirect on a probe would be a
 *      self-inflicted outage.
 *
 * Never throws; a missing header simply means "not sure it was HTTPS".
 */

export const HSTS_HEADER_VALUE = 'max-age=31536000; includeSubDomains';
export const SECURITY_PROBE_PATHS = Object.freeze(['/healthz', '/api/health', '/internal/status']);

export function pathOf(request) {
  return String(request?.raw?.url || request?.url || '/').split('?')[0];
}

export function isProbePath(request) {
  return SECURITY_PROBE_PATHS.includes(pathOf(request));
}

export function forwardedProto(request) {
  return String(request?.headers?.['x-forwarded-proto'] || '').trim().toLowerCase();
}

/** `https://<host><path?query>` — null when the Host header is unusable. */
export function httpsRedirectUrl(request) {
  const host = String(request?.headers?.host || '').trim();
  if (!host) return null;
  const raw = String(request?.raw?.url || request?.url || '/');
  const pathAndQuery = raw.startsWith('/') ? raw : `/${raw}`;
  return `https://${host}${pathAndQuery}`;
}

/** The one hook: 308 for explicit plain-HTTP traffic, HSTS for HTTPS traffic. */
export async function securityHeadersHook(request, reply) {
  const proto = forwardedProto(request);
  if (proto === 'http' && !isProbePath(request)) {
    const target = httpsRedirectUrl(request);
    if (target) {
      // Early response: Fastify docs allow returning the reply after send().
      return reply.code(308).header('location', target).send();
    }
  }
  if (proto === 'https') {
    reply.header('strict-transport-security', HSTS_HEADER_VALUE);
  }
  // NEVER return the reply on the pass-through path — Fastify would treat a
  // returned Reply as the hook's response payload and the request would hang
  // (proven by the v1.90.0 Test 8 probe).
}

export function registerSecurityHeaders(fastify) {
  fastify.addHook('onRequest', securityHeadersHook);
}

export default { registerSecurityHeaders, securityHeadersHook, HSTS_HEADER_VALUE, SECURITY_PROBE_PATHS };
