/**
 * Saka Fleet — GitHub repository_dispatch bridge (v1.10.0).
 *
 * The autonomous remediation pipeline runs Cline inside GitHub Actions.
 * This module is the ONLY server → GitHub trigger. It is deliberately:
 *   - fail-soft (never throws; callers keep running),
 *   - gated by the REMEDIATION_AUTONOMY kill switch (default: off),
 *   - least-privilege (fine-grained PAT in GH_REMEDIATION_TOKEN, contents:write +
 *     "workflow dispatch" on a single repository).
 *
 * Dispatch events consumed by .github/workflows/remediation.yml:
 *   - remediation_plan    { audit_run_id, run_date?, feedback?, proposal_code? }
 *   - remediation_execute { proposal_code, approval_nonce }
 */

export function resolveRemediationRepo() {
  return process.env.GH_REMEDIATION_REPO || process.env.GITHUB_REPOSITORY || null;
}

export function isRemediationAutonomyEnabled() {
  return String(process.env.REMEDIATION_AUTONOMY || 'off').toLowerCase() === 'on';
}

const DISPATCH_TIMEOUT_MS = Number(process.env.REMEDIATION_DISPATCH_TIMEOUT_MS || 15000);

/**
 * Trigger a GitHub Actions workflow through repository_dispatch.
 * @param {string} eventType
 * @param {object} clientPayload
 * @returns {Promise<{ok:boolean, status?:number, error?:string, skipped?:boolean}>}
 */
export async function dispatchRepositoryEvent(eventType, clientPayload = {}) {
  if (!eventType) return { ok: false, error: 'Missing repository_dispatch event type.' };

  if (!isRemediationAutonomyEnabled()) {
    return { ok: false, skipped: true, error: 'REMEDIATION_AUTONOMY is not enabled (kill switch off).' };
  }

  const token = process.env.GH_REMEDIATION_TOKEN || process.env.GITHUB_TOKEN;
  const repo = resolveRemediationRepo();
  if (!token || !repo) {
    return { ok: false, error: 'Missing GH_REMEDIATION_TOKEN or GH_REMEDIATION_REPO.' };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS)
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[githubDispatch] ${eventType} failed (${res.status}):`, body.slice(0, 300));
      return { ok: false, status: res.status, error: `GitHub dispatch failed (${res.status}).` };
    }

    console.log(`[githubDispatch] ${eventType} dispatched to ${repo}.`);
    return { ok: true, status: res.status };
  } catch (err) {
    console.error(`[githubDispatch] ${eventType} exception:`, err.message);
    return { ok: false, error: err.message };
  }
}
