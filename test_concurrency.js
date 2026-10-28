import { enqueueUserMessage, getQueueStats, drainQueue } from './src/services/messageQueue.js';

/**
 * Targeted suite: per-phone serialization, global concurrency cap, retries and
 * graceful drain. Stateless — no database access or data created.
 */

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('--- Test 1: per-phone serialization ---');
  let activePerPhone = 0;
  let maxActivePerPhone = 0;

  const samePhoneTasks = Array.from({ length: 12 }, (_, i) =>
    enqueueUserMessage('+254700111222', async () => {
      activePerPhone += 1;
      maxActivePerPhone = Math.max(maxActivePerPhone, activePerPhone);
      await sleep(15);
      activePerPhone -= 1;
      return i;
    })
  );

  await Promise.all(samePhoneTasks);
  assert(maxActivePerPhone === 1, 'Same-phone messages are processed strictly one at a time');

  console.log('\n--- Test 2: global concurrency back-pressure ---');
  let activeGlobal = 0;
  let maxActiveGlobal = 0;

  const acrossPhones = Array.from({ length: 24 }, (_, i) =>
    enqueueUserMessage(`+2547009${String(i).padStart(5, '0')}`, async () => {
      activeGlobal += 1;
      maxActiveGlobal = Math.max(maxActiveGlobal, activeGlobal);
      await sleep(30);
      activeGlobal -= 1;
    })
  );

  await Promise.all(acrossPhones);
  const stats = getQueueStats();
  assert(maxActiveGlobal <= stats.maxConcurrency, `Global concurrency never exceeded the cap (${maxActiveGlobal} <= ${stats.maxConcurrency})`);

  console.log('\n--- Test 3: retry with backoff on transient failure ---');
  let attempts = 0;
  const result = await enqueueUserMessage('+254700333444', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('fetch failed');
    return 'recovered';
  });
  assert(result === 'recovered', 'Transient failure retried successfully');
  assert(attempts === 2, 'Exactly one retry was needed');

  console.log('\n--- Test 4: retries exhausted surface the error ---');
  let failingAttempts = 0;
  let rejected = false;
  try {
    await enqueueUserMessage('+254700555666', async () => {
      failingAttempts += 1;
      throw new Error('fetch failed');
    });
  } catch (err) {
    rejected = err.message.includes('fetch failed');
  }
  assert(rejected, 'Exhausted retries reject to the caller (dead-letter hook)');
  assert(failingAttempts === Number(process.env.MESSAGE_MAX_ATTEMPTS || 3), 'Configured retry attempts were executed');

  console.log('\n--- Test 5: graceful drain ---');
  const drained = await drainQueue(5000);
  assert(drained === true, 'Queue drains cleanly');
  assert(getQueueStats().active === 0, 'No active tasks remain after drain');

  console.log(`\n🎉 ALL CONCURRENCY TESTS PASSED (${passed} assertions).`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
