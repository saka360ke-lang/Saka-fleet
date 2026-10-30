import assert from 'assert';
import {
  FEATURE_NOTICE_VERSION,
  isNoticeStale,
  buildFeatureNotice,
  shouldShowFeatureNotice
} from './src/services/featureNotice.js';
import { isDeployNoiseLog } from './src/workers/sentinel.js';
import { readFileSync } from 'node:fs';

/**
 * Saka Fleet — Existing-user rollout tests (v1.19.1).
 * Stateless: version stamps, role-aware digest, deployment-noise filter.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

function emojiCount(text) {
  return (String(text).match(/\p{Extended_Pictographic}/gu) || []).length;
}

console.log('=== SAKA FLEET — FEATURE NOTICE & ROLLOUT TESTS ===\n');

console.log('--- Test 1: version stamping ---');
check(FEATURE_NOTICE_VERSION === '1.20.0', 'current notice version is 1.20.0');
check(isNoticeStale(null) === true, 'no stored version means the digest is due');
check(isNoticeStale('1.19.0') === true, 'older version is stale');
check(isNoticeStale('1.20.0') === false, 'same version never repeats');
check(isNoticeStale('1.20.10') === false, 'semantic compare is numeric (1.20.10 > 1.20.0)');
check(isNoticeStale('2.0.0') === false, 'a future stamp outranks the current digest');

console.log('--- Test 2: role-aware digest ---');
const ownerDigest = buildFeatureNotice({ lane: 'owner' });
const driverDigest = buildFeatureNotice({ lane: 'driver' });
check(ownerDigest.includes("What's new in Saka"), 'owner digest is owner-scoped');
check(ownerDigest.includes('receipt') && ownerDigest.includes('PDF') && ownerDigest.includes('full tank'), 'owner digest mentions receipts, PDF reports and fill type');
check(driverDigest.includes("What's new for you") && driverDigest.includes('Driver Daybook'), 'driver digest is driver-scoped');
check(!driverDigest.includes('km/L'), 'drivers never see owner financial/fuel-economy prompts');
check(emojiCount(ownerDigest) <= 4 && emojiCount(driverDigest) <= 4, 'both digests respect the 4-emoji ceiling');
check(!/KES|INR|USD|\$/.test(ownerDigest + driverDigest), 'no currency figures inside the digest');

console.log('--- Test 3: display gating ---');
const profile = { id: 'p1', feature_notice: null };
check(shouldShowFeatureNotice({ profile, session: {}, hasQuiz: false, hasVehicleRegistered: true }) === true, 'existing owner with no stamp sees the digest once');
check(shouldShowFeatureNotice({ profile, session: {}, hasQuiz: true, hasVehicleRegistered: true }) === false, 'quiz/confirmation turns never carry the digest');
check(shouldShowFeatureNotice({ profile, session: {}, hasQuiz: false, hasVehicleRegistered: false }) === false, 'brand-new users skip the digest');
check(shouldShowFeatureNotice({ profile, session: { featureNoticeShown: true }, hasQuiz: false, hasVehicleRegistered: true }) === false, 'one digest per session');
check(shouldShowFeatureNotice({ profile: { id: 'p1', feature_notice: '1.20.0' }, session: {}, hasQuiz: false, hasVehicleRegistered: true }) === false, 'stamped profiles never repeat');
check(shouldShowFeatureNotice({ profile: null, session: {}, hasQuiz: false, hasVehicleRegistered: true }) === false, 'missing profile is safe');

console.log('--- Test 4: Cloud Run deployment noise ---');
check(isDeployNoiseLog("Conflict for resource 'saka-fleet' was found") === true, 'revision conflict is filtered');
check(isDeployNoiseLog("version 'saka-fleet-00042-abc' was specified but current version is 00041") === true, 'stale revision pin is filtered');
check(isDeployNoiseLog('TypeError: Cannot read properties of undefined') === false, 'real runtime errors still alert');
check(isDeployNoiseLog('') === false, 'empty text is safe');

console.log('--- Test 5: route wiring ---');
const routeSource = readFileSync('./src/routes/whatsapp.js', 'utf8');
check(/const summaryCommand[\s\S]*emailVehicleSummary/.test(routeSource), 'WhatsApp route builds and emails the registration summary');
check(/shouldShowFeatureNotice\(/.test(routeSource) && /markFeatureNoticeSeen\(/.test(routeSource), 'digest is appended and stamped in the live route');

console.log(`\n🎉 ${passed} rollout & feature-notice assertions passed.`);
