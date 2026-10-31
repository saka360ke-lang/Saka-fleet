import assert from 'assert';
import { isDeployNoiseLog } from './src/workers/sentinel.js';
import { formatRemediationBlockedReply } from './src/workers/remediation.js';
import { buildDeploymentAlertText } from './scripts/notify_git_push.js';
import { buildDeployLiveText, announceRevisionLive } from './src/services/deployLiveAlert.js';

/** Plain-English superadmin notifications & deploy-noise decoding (v1.23.2). */
let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  \u2705 ${message}`);
}

console.log('=== SAKA FLEET - SUPERADMIN NOTIFICATIONS TESTS ===');
console.log('--- Test 1: deploy alert in plain English ---');
const alert = buildDeploymentAlertText({ version: '1.23.1', commitHash: '88a4cc6', branch: 'main', author: 'saka360ke-lang', timestamp: 'Oct 30, 2026' });
check(alert.includes('Saka update building') && alert.includes('v1.23.1'), 'deploy alert names the release');
check(alert.includes('v1.23.1 - 88a4cc6'), 'deploy alert surfaces the commit id in the title');
check(alert.includes('second message') && alert.includes('LIVE'), 'deploy alert promises the LIVE follow-up');
check(alert.includes('In plain words:') && alert.includes('Pricing v2'), 'deploy alert pulls the plain-English headline from the release history');
check(alert.includes('Details: commit 88a4cc6'), 'deploy alert keeps a compact details footer');
const failure = buildDeploymentAlertText({ mode: 'failure', commitHash: 'abc1234', branch: 'main', timestamp: 'Oct 31, 2026' });
check(failure.includes('build rules check FAILED') && failure.includes('abc1234'), 'the rules-gate failure alert names the commit');

console.log('--- Test 1b: the LIVE announcement (v1.25.7) ---');
const live = buildDeployLiveText({ version: '1.25.7', revision: 'saka-fleet-00139-abc', now: new Date('2026-10-31T12:30:00Z') });
check(live.includes('Saka is LIVE') && live.includes('v1.25.7') && live.includes('00139-abc'), 'the LIVE text names the version and revision');
check(live.includes('12:30 UTC'), 'the LIVE text carries the announce time');
const fakeSupabase = (stored) => {
  const state = { value: stored };
  return {
    from() {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.value === null ? null : { value: state.value }, error: null }) }) }),
        upsert: async (rows) => { state.value = rows[0].value; return { error: null }; }
      };
    },
    get value() { return state.value; }
  };
};
const firstDb = fakeSupabase(null);
const sent = [];
const firstAnnounce = await announceRevisionLive({ supabase: firstDb, revision: 'rev-1', version: '1.25.7', send: async (text) => sent.push(text), logger: { log() {}, warn() {} } });
check(firstAnnounce.sent === true && sent.length === 1, 'a new revision announces exactly once');
const repeat = await announceRevisionLive({ supabase: firstDb, revision: 'rev-1', version: '1.25.7', send: async (text) => sent.push(text), logger: { log() {}, warn() {} } });
check(repeat.sent === false && repeat.reason === 'already announced' && sent.length === 1, 'restarting the same revision stays silent');
const noRevision = await announceRevisionLive({ supabase: fakeSupabase(null), revision: null, send: async () => { throw new Error('should not send'); } });
check(noRevision.sent === false, 'missing revision never announces');

console.log('--- Test 2: remediation watchdog in plain English ---');
const blocked = formatRemediationBlockedReply({ minutes: 583 });
check(blocked.includes('auto-fix system is stuck') && blocked.includes('In plain words'), 'watchdog explains the situation simply');
check(blocked.includes('583 minutes'), 'watchdog includes how long it has been waiting');
check(blocked.includes('GH_REMEDIATION_TOKEN') && blocked.includes('Settings'), 'watchdog names the likely cause and the exact fix');
check(blocked.includes('only be told once'), 'watchdog promises no repeat spam');

console.log('--- Test 3: deploy-noise decoding (protobuf AuditLog) ---');
const noisyPayload = JSON.stringify({
  type_url: 'type.googleapis.com/google.cloud.audit.AuditLog',
  value: { type: 'Buffer', data: Array.from(Buffer.from("Conflict for resource 'saka-fleet': version '1793379564471557' was specified but current version is '1793379888484753'")) }
});
check(isDeployNoiseLog(noisyPayload) === true, 'byte-array AuditLog deploy conflicts are filtered');
check(isDeployNoiseLog('version \'123\' was specified but current version is \'456\'') === true, 'plain-text conflicts remain filtered');
check(isDeployNoiseLog('TypeError: Cannot read properties of undefined') === false, 'genuine errors still alert');

console.log(`\nALL NOTIFICATION TESTS PASSED (${passed} assertions).`);