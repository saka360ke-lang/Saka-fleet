import assert from 'assert';
import { isDeployNoiseLog } from './src/workers/sentinel.js';
import { formatRemediationBlockedReply } from './src/workers/remediation.js';
import { buildDeploymentAlertText } from './scripts/notify_git_push.js';

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
check(alert.includes('Saka update is live') && alert.includes('v1.23.1'), 'deploy alert names the release');
check(alert.includes('In plain words:') && alert.includes('Pricing v2'), 'deploy alert pulls the plain-English headline from the release history');
check(alert.includes('Action needed:') && alert.includes('None'), 'deploy alert says when no action is needed');
check(alert.includes('Details: commit 88a4cc6'), 'deploy alert keeps a compact details footer');

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