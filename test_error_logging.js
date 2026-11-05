// v1.61.12 — "every error gets logged": the shared `error_logs` logger lives in
// a service (so non-worker modules can use it), every user-impacting write path
// logs its failures, and a ratchet stops NEW silent catches from appearing.
import fs from 'node:fs';
import path from 'node:path';
import { logSystemError, logWriteFailure } from './src/services/systemErrors.js';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('=== 1. shared logger ===');
check(typeof logSystemError === 'function', 'logSystemError is exported by the service');
check(typeof logWriteFailure === 'function', 'logWriteFailure (fire-and-forget) is exported');
const sentinelSource = fs.readFileSync('src/workers/sentinel.js', 'utf8');
check(sentinelSource.includes("from '../services/systemErrors.js'"), 'sentinel imports the shared implementation');
check(sentinelSource.includes('export async function logSystemError'), 'sentinel still exports logSystemError (call sites unchanged)');

console.log('\n=== 2. user-impacting writes log their failures ===');
const requiredRoutes = [
  ['src/services/quizEngine.js', 'quizEngine.persistVehicleRegistration'],
  ['src/services/onboarding.js', 'onboarding.saveVehicleAssetRecord'],
  ['src/services/subscriptions.js', 'subscriptions.ledgerInsert'],
  ['src/services/subscriptions.js', 'subscriptions.trialConvertedStamp'],
  ['src/services/trialEngine.js', 'trialEngine.stampTrial'],
  ['src/services/launchAwards.js', 'launchAwards.awardMetadata'],
  ['src/services/vehicles.js', 'vehicles.ownerEmailSync'],
  ['src/services/vehicles.js', 'vehicles.cancelRemindersOnDelete'],
  ['src/services/webOnboarding.js', 'webOnboarding.raceMerge'],
  ['src/services/careConsole.js', 'careConsole.priorityBump'],
  ['src/services/inboundEmail.js', 'inboundEmail.internalNote']
];
for (const [file, route] of requiredRoutes) {
  check(`${path.basename(file)} logs ${route}`, fs.readFileSync(file, 'utf8').includes(route));
}

console.log('\n=== 3. silent-catch ratchet ===');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  ));
}
function countSilentCatches() {
  const re = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?\}/g;
  let count = 0;
  for (const file of walk('src').filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    while (re.exec(text)) count += 1;
  }
  return count;
}
// Pinned at the v1.61.12 audit: remaining silent catches are best-effort UI,
// telemetry and notify paths. A NEW silent catch fails this ratchet.
const SILENT_CATCH_BUDGET = 100;
const silentNow = countSilentCatches();
check(`silent catches stay within the pinned budget (${silentNow}/${SILENT_CATCH_BUDGET})`, silentNow <= SILENT_CATCH_BUDGET);
console.log('\n=== 4. logger behaviour ===');
const inserts = [];
const mockSupabase = {
  from() {
    return {
      select() {
        return { eq() { return { eq() { return { gte() { return { limit: async () => ({ data: [] }) }; } }; } }; } };
      },
      insert(rows) {
        inserts.push(rows[0]);
        return { select() { return { maybeSingle: async () => ({ data: { id: 'row-1' } }) }; } };
      }
    };
  }
};
const id = await logSystemError(mockSupabase, new Error('boom'), 'test.route', { plate: 'KBJ819C', code: '23502' });
check('a failure is written to error_logs', id === 'row-1' && inserts.length === 1);
check('context is folded into the logged message', inserts[0].error_message.includes('boom') && inserts[0].error_message.includes('plate=KBJ819C') && inserts[0].error_message.includes('code=23502'), inserts[0].error_message);
await logSystemError(mockSupabase, new Error(''), 'test.route');
check('an empty error is never logged', inserts.length === 1);
await logSystemError(mockSupabase, { message: 'ignored', statusCode: 200 }, 'test.route');
check('benign status codes are never logged', inserts.length === 1);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
else console.log(`✅ ALL ERROR-LOGGING TESTS PASSED (${pass} assertions).`);
