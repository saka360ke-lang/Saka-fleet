import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Saka Fleet — exhaustive suite runner (v1.25.2).
 *
 * Runs EVERY test_*.js file standalone, captures pass/fail, then performs the
 * permanent test-data cleanup sweep. Usage:
 *   npm run test:all
 * Results are also written to test-all-report.json (gitignored) for triage.
 */

const root = process.cwd();
const files = fs.readdirSync(root).filter((file) => /^test_.*\.js$/.test(file)).sort();
const results = [];

console.log(`🧪 Exhaustive run: ${files.length} suites\n`);

for (const file of files) {
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [file], {
    cwd: root,
    timeout: 240000,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' }
  });
  const ok = res.status === 0;
  const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const tail = output.split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' | ').slice(0, 180);
  results.push({ file, ok, ms: Date.now() - startedAt, exit: res.status, tail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${file.padEnd(34)} ${String(Date.now() - startedAt).padStart(6)}ms${ok ? '' : `  ${tail}`}`);
}

const failures = results.filter((result) => !result.ok);
try {
  fs.writeFileSync('test-all-report.json', JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
} catch { /* report is best-effort */ }

console.log(`\n${results.length - failures.length}/${results.length} suites passed.`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`- ${failure.file} (exit ${failure.exit}): ${failure.tail}`);
}

console.log('\n🧹 Final test-data cleanup sweep...');
spawnSync(process.execPath, ['scripts/run_tests.js', '--cleanup-only'], { cwd: root, encoding: 'utf8', stdio: 'inherit' });

process.exit(failures.length ? 1 : 0);
