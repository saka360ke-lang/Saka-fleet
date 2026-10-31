import fs from 'node:fs';
import { AI_BREAKER_DEFAULTS, getFallbackTimeoutMs, getChainBudgetMs } from './src/services/aiClient.js';
import { SLOW_ACK_DEFAULT_MS, SLOW_ACK_MIN_GAP_MS } from './src/services/turnAck.js';
import { TURN_LATENCY_MAX_ROWS, TURN_LATENCY_TRIM_EVERY } from './src/services/turnLatency.js';

/**
 * Saka Fleet — documentation drift guard (v1.25.2). Stateless.
 *
 * The architecture file is the operating manual; it must never silently drift
 * from the code. This suite binds the doc's version line to package.json and its
 * documented defaults to the real constants, so a knob change without a docs
 * update fails `npm run health`.
 */

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const doc = fs.readFileSync('SAKA_FLEET_ARCHITECTURE.md', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

console.log('=== SAKA FLEET — DOC SYNC TESTS (v1.25.2) ===\n');

console.log('--- Test 1: version alignment ---');
const docVersion = (doc.match(/\*\*Version:\*\*\s*([0-9.]+)/) || [])[1];
check(Boolean(docVersion), 'the architecture file declares a version');
check(docVersion === pkg.version, `doc version ${docVersion} equals package.json ${pkg.version}`);

console.log('\n--- Test 2: documented defaults match the code ---');
check(SLOW_ACK_DEFAULT_MS === 8000 && doc.includes('`SLOW_ACK_MS` (**8000'), 'slow-ack threshold is documented as 8000');
check(SLOW_ACK_MIN_GAP_MS === 60000, 'the ack anti-spam floor is 60 seconds');
check(getFallbackTimeoutMs() === 10000 && doc.includes('`AI_TIMEOUT_MS_FALLBACK` | 10000'), 'fallback timeout default 10000 is documented');
check(getChainBudgetMs() === 45000 && doc.includes('`AI_CHAIN_BUDGET_MS` | 45000'), 'chain budget default 45000 is documented');
check(AI_BREAKER_DEFAULTS.billingOpenMs === 1800000 && doc.includes('`AI_CB_BILLING_OPEN_MS` | 1800000'), 'billing breaker window 1800000 is documented');
check(TURN_LATENCY_MAX_ROWS === 10000 && doc.includes('TURN_LATENCY_MAX_ROWS'), 'telemetry row cap is documented');
check(TURN_LATENCY_TRIM_EVERY === 250 && doc.includes('TURN_LATENCY_TRIM_EVERY'), 'telemetry trim cadence is documented');
check(doc.includes('AI_TIMEOUT_MS_PREMIUM') && /\| `AI_TIMEOUT_MS_PREMIUM` \| 30000/.test(doc), 'premium timeout 30000 is documented');

console.log('\n--- Test 3: section map is intact ---');
for (const section of ['## 62.', '## 63.', '## 64.', '## 65.', '## 66.', '## 67.']) {
  check(doc.includes(section), `section ${section.replace('## ', '')} exists`);
}

console.log('\n--- Test 4: cross-document sync ---');
check(/v1\.25/.test(readme), 'README mentions the current release line');
check(Boolean(pkg.scripts?.health) && Boolean(pkg.scripts?.['test:all']), 'package scripts expose health and test:all');
check(/VOICE LAW/.test(doc) && /PRODUCT ANSWERS|Product Q&A/.test(doc), 'the voice and product-answer policies are documented');

console.log('\n--- Test 5: changelog mirrors the release (v1.25.3) ---');
const topVersion = (changelog.match(/^## \[([0-9.]+)\]/m) || [])[1];
check(Boolean(topVersion), 'the changelog declares a newest release');
check(topVersion === pkg.version, `changelog ${topVersion} equals package.json ${pkg.version}`);
check(changelog.includes('## [1.13.0]') && /Earlier milestones/.test(changelog), 'historical releases are recorded');
check(changelog.includes('ff82636') && changelog.includes('4774e21'), 'entries name the commit they shipped in');
check(/commit id in the title/.test(changelog), 'the current release is described in plain English');

console.log(`\n🎉 ${passed} doc-sync assertions passed.`);
