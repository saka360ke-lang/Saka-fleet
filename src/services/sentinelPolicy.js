/**
 * Saka Fleet - Sentinel policy switch (v1.58.14)
 * -----------------------------------------------
 * Sentinel is the background supervisor: it DETECTS friction and errors, but
 * it must not offer remediations or proposals on its own. Every autonomous
 * proposal path (conversation diagnosis, deep-audit minting, CI plan dispatch)
 * is gated here. When the switch is off, findings are written to
 * chat_friction_logs (log-only) for a human to tend later.
 */
export const SENTINEL_PROPOSALS_DEFAULT = 'off';

export function isSentinelProposalsEnabled(env = process.env) {
  const raw = (env && env.SENTINEL_PROPOSALS_ENABLED) || SENTINEL_PROPOSALS_DEFAULT;
  return /^(?:on|true|1|yes)$/i.test(String(raw));
}

export default { SENTINEL_PROPOSALS_DEFAULT, isSentinelProposalsEnabled };
