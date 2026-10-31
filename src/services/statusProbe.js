import crypto from 'node:crypto';

/**
 * Saka Fleet — operator status probe (v1.24.4).
 *
 * `GET /healthz` stays the DB-free warm/liveness probe, but Google's edge
 * intercepts that exact path on some deployments (verified 2026-10-31 on
 * saka-fleet-*.europe-west1.run.app: Google HTML 404 while every other path
 * reached Fastify). The same payload is therefore also served on
 * `/api/health` and `/internal/status` so revision checks always work.
 *
 * Public callers get status/uptime/queue only. A caller holding
 * `SENTINEL_SECRET` (header `x-saka-secret`) additionally gets the Cloud Run
 * revision metadata, which is what makes "which build is live?" answerable.
 */

export const STATUS_PATHS = Object.freeze(['/healthz', '/api/health', '/internal/status']);

/** Public payload — never includes build metadata. */
export function buildPublicStatus({ uptimeSeconds = 0, queue = null, now = new Date() } = {}) {
  return {
    status: 'ok',
    uptimeSeconds: Math.round(Number(uptimeSeconds) || 0),
    queue: queue || null,
    timestamp: now instanceof Date ? now.toISOString() : String(now)
  };
}

/** Build metadata disclosed only to a secret-bearing caller. */
export function buildRevisionInfo({ env = process.env } = {}) {
  return {
    revision: env.K_REVISION || null,
    service: env.K_SERVICE || null,
    environment: env.APP_ENV || env.NODE_ENV || null
  };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** True when the request carries the configured operator secret. */
export function isStatusAuthorized(headers = {}, secret = process.env.SENTINEL_SECRET) {
  if (!secret) return false;
  const provided = headers?.['x-saka-secret'] ?? headers?.['X-Saka-Secret'] ?? '';
  if (!provided) return false;
  return safeEqual(provided, secret);
}

/** Full response for a status route. */
export function buildStatusResponse({ headers = {}, secret = process.env.SENTINEL_SECRET, uptimeSeconds = 0, queue = null, env = process.env, now = new Date() } = {}) {
  const base = buildPublicStatus({ uptimeSeconds, queue, now });
  return isStatusAuthorized(headers, secret) ? { ...base, ...buildRevisionInfo({ env }) } : base;
}

export default {
  STATUS_PATHS,
  buildPublicStatus,
  buildRevisionInfo,
  isStatusAuthorized,
  buildStatusResponse
};
