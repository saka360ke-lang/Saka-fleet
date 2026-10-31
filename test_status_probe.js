import {
  STATUS_PATHS,
  buildPublicStatus,
  buildRevisionInfo,
  isStatusAuthorized,
  buildStatusResponse
} from './src/services/statusProbe.js';

/**
 * Saka Fleet — operator status probes (v1.24.4). Stateless: pure payloads.
 * Guards the "which revision is live?" answer that the WhatsApp edge blocks on
 * /healthz for some deployments.
 */

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — STATUS PROBE TESTS (v1.24.4) ===\n');

console.log('--- Test 1: public payload stays metadata-free ---');
const now = new Date('2026-10-31T06:00:00.000Z');
const publicPayload = buildPublicStatus({ uptimeSeconds: 41.6, queue: { active: 1 }, now });
check(publicPayload.status === 'ok', 'status is ok');
check(publicPayload.uptimeSeconds === 42, 'uptime is rounded');
check(publicPayload.timestamp === '2026-10-31T06:00:00.000Z', 'timestamp is ISO-8601');
check(!('revision' in publicPayload) && !('service' in publicPayload), 'no build metadata leaks publicly');

console.log('\n--- Test 2: secret-gated revision metadata ---');
const env = { K_REVISION: 'saka-fleet-00042-abc', K_SERVICE: 'saka-fleet', NODE_ENV: 'production' };
const authorized = buildStatusResponse({
  headers: { 'x-saka-secret': 'top-secret' },
  secret: 'top-secret',
  uptimeSeconds: 10,
  queue: { active: 0 },
  env,
  now
});
check(authorized.revision === 'saka-fleet-00042-abc', 'revision is disclosed to the operator');
check(authorized.service === 'saka-fleet' && authorized.environment === 'production', 'service + environment are disclosed');
const unauthorized = buildStatusResponse({ headers: { 'x-saka-secret': 'wrong' }, secret: 'top-secret', uptimeSeconds: 10, env, now });
check(unauthorized.revision === undefined, 'a wrong secret gets no metadata');
const missing = buildStatusResponse({ headers: {}, secret: 'top-secret', uptimeSeconds: 10, env, now });
check(missing.revision === undefined, 'a missing header gets no metadata');

console.log('\n--- Test 3: authorization edge cases ---');
check(isStatusAuthorized({ 'x-saka-secret': 'abc' }, 'abc') === true, 'matching secret authorizes');
check(isStatusAuthorized({ 'x-saka-secret': 'abc' }, '') === false, 'an unset server secret never authorizes');
check(isStatusAuthorized({}, 'abc') === false, 'a missing header never authorizes');
check(isStatusAuthorized({ 'x-saka-secret': 'abcdef' }, 'abc') === false, 'a longer guess is rejected');
const localEnv = buildRevisionInfo({ env: {} });
check(localEnv.revision === null && localEnv.service === null && localEnv.environment === null, 'local runs report null build metadata');

console.log('\n--- Test 4: route aliases ---');
check(STATUS_PATHS.includes('/healthz') && STATUS_PATHS.includes('/api/health') && STATUS_PATHS.includes('/internal/status'), 'all three probe paths are registered');

console.log(`\n🎉 ${passed} status-probe assertions passed.`);
