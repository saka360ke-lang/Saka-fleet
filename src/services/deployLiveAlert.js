import fs from 'node:fs';
// v1.72.1 (P2-6) — config reads/writes ride the dual-window service.
import { readConfig, writeConfig } from './systemConfigService.js';
import { CONFIG_KEY_DEPLOY_LAST_REVISION } from './systemConfigKeys.js';

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
 * `send(text, templateVars)` is injected so the behaviour is unit-testable
 * without WhatsApp; templateVars feeds the approved deploy_live template
 * ({{1}} version, {{2}} commit/revision) and degrades safely (rule 50).
 */
export async function announceRevisionLive({ supabase, revision, version = readReleaseVersion(), send = null, logger = console, now = new Date() } = {}) {
  try {
    if (!supabase || !revision) return { sent: false, reason: 'missing input' };
    // v1.72.1 (P2-6) — ONE atomic dual read [namespaced, legacy] through the
    // service: a rename or a mixed-version rolling deploy can never miss the
    // marker and re-announce the same revision.
    const lastRevision = await readConfig(supabase, CONFIG_KEY_DEPLOY_LAST_REVISION);
    if (lastRevision === revision) return { sent: false, reason: 'already announced' };
    const markerWrite = await writeConfig(supabase, CONFIG_KEY_DEPLOY_LAST_REVISION, revision);
    // v1.32.2 — a missing onConflict silently failed the upsert, so the marker
    // stayed frozen at the 2026-10-28 revision and every boot re-announced.
    if (!markerWrite.ok && logger?.warn) {
      logger.warn('[deployLiveAlert] revision marker not persisted:', markerWrite.error);
    }
    const text = buildDeployLiveText({ version, revision, now });
    // v1.78.1 (Phase 17.5) - the approved deploy_live template carries two body
    // variables: {{1}} the release version, {{2}} the commit/revision. An
    // 'unknown' version (architecture-file read failed) passes '' so
    // resolveProactiveMode degrades to the free-form text above (rule 50)
    // instead of firing a template with a broken variable.
    const templateVars = { version: version && version !== 'unknown' ? `v${version}` : '', commit: revision };
    if (typeof send === 'function') await send(text, templateVars);
    if (logger?.log) logger.log(`[deployLiveAlert] LIVE announcement sent for revision ${revision}.`);
    return { sent: true, text, templateVars };
  } catch (err) {
    if (logger?.warn) logger.warn('[deployLiveAlert] announcement skipped:', err?.message || err);
    return { sent: false, reason: 'error' };
  }
}

export default { readReleaseVersion, buildDeployLiveText, announceRevisionLive };
