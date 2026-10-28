import 'dotenv/config';
import { spawnSync } from 'child_process';
import { cleanupTestData, KNOWN_TEST_PHONES, KNOWN_TEST_VINS } from './testCleanup.js';

/**
 * Targeted test runner with the permanent auto-cleanup rule.
 * Usage:
 *   node scripts/run_tests.js                      # default focused edit/delete suite
 *   node scripts/run_tests.js test_whatsapp_flow.js
 *   node scripts/run_tests.js --cleanup-only       # clear test data without running tests
 */

const args = process.argv.slice(2);
const cleanupOnly = args.includes('--cleanup-only');
const testFiles = args.filter(a => !a.startsWith('--'));
const filesToRun = testFiles.length ? testFiles : ['test_edit_delete.js'];

async function runCleanup() {
  console.log('\n🧹 Auto-cleaning test data (permanent rule)...');
  try {
    await cleanupTestData({ phones: KNOWN_TEST_PHONES, vins: KNOWN_TEST_VINS });
  } catch (err) {
    console.error('Cleanup failed:', err.message);
  }
}

if (cleanupOnly) {
  await runCleanup();
  process.exit(0);
}

console.log(`🧪 Running ${filesToRun.length} targeted test suite(s): ${filesToRun.join(', ')}`);

let failures = 0;
for (const file of filesToRun) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [file], {
    stdio: 'inherit',
    env: { ...process.env, SAKA_TEST_RUN: '1' }
  });
  if (result.status !== 0) failures += 1;
}

// Permanent rule: always clear test data after every run (pass or fail).
await runCleanup();

if (failures > 0) {
  console.error(`\n❌ ${failures} suite(s) failed.`);
  process.exit(1);
}
console.log('\n✅ All targeted suites passed and test data was cleared.');
