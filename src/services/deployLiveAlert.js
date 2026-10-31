import fs from 'node:fs';

/**
 * Saka Fleet — "deployment is LIVE" announcement (v1.25.7).
 *
 * Cloud Run rollouts are gradual and can be triggered by any path (a local
 * push, cline.bot's pipeline, or a manual console deploy). The only component
 * that always knows a new revision is actually serving is the app itself, so
 * the boot sequence compares K_REVISION with `system_config.last_deployed_revision`
 * and announces each new revision exactly once.
 */

export function readReleaseVersion() {
  try {
    const doc = fs.readFileSync('SAKA_FLEET_ARCHITECTURE.md', 'utf8');
    return (doc.match(/\*\*Version:\*\*\s*([0-9.]+)/) || [])[1] || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildDeployLiveText({ version = 'unknown', revision = null, now = new Date() } = {}) {
  return [
    `🚀 *Saka is LIVE* - v${version}${revision ? ` · \`${revision}\`` : ''}`,
    '',
    'This revision is now answering WhatsApp conversations.',
    `_Announced at ${now.toISOString().slice(11, 16)} UTC — no action needed._`
  ].join('\n');
}

/**
 * Announce one revision exactly once. Never throws; returns a status object.
 * `send` is injected so the behaviour is unit-testable without WhatsApp.
 */
export async function announceRevisionLive({ supabase, revision, version = readReleaseVersion(), send = null, logger = console, now = new Date() } = {}) {
  try {
    if (!supabase || !revision) return { sent: false, reason: 'missing input' };
    const { data: config } = await supabase.from('system_config').select('value').eq('key', 'last_deployed_revision').maybeSingle();
    if (config && config.value === revision) return { sent: false, reason: 'already announced' };
    await supabase.from('system_config').upsert([{ key: 'last_deployed_revision', value: revision }]);
    const text = buildDeployLiveText({ version, revision, now });
    if (typeof send === 'function') await send(text);
    if (logger?.log) logger.log(`[deployLiveAlert] LIVE announcement sent for revision ${revision}.`);
    return { sent: true, text };
  } catch (err) {
    if (logger?.warn) logger.warn('[deployLiveAlert] announcement skipped:', err?.message || err);
    return { sent: false, reason: 'error' };
  }
}

export default { readReleaseVersion, buildDeployLiveText, announceRevisionLive };
