/**
 * Saka Fleet — Message Queue & Concurrency Guard
 * ----------------------------------------------
 * Meta delivers webhooks in bursts. This module guarantees:
 *  1. Per-phone serialization  — two messages from the same user never mutate
 *     the same session/workflow concurrently.
 *  2. Global back-pressure     — a bounded semaphore caps parallel AI + DB work.
 *  3. Automatic retries        — transient network failures retry with backoff.
 *  4. Dead-letter hooks        — exhausted tasks surface to the caller so they
 *     can be recorded in error_logs.
 *
 * No external dependency is required.
 */

const MAX_CONCURRENT = Number(process.env.MESSAGE_MAX_CONCURRENCY || 8);
const MAX_ATTEMPTS = Number(process.env.MESSAGE_MAX_ATTEMPTS || 3);
const RETRY_BASE_MS = Number(process.env.MESSAGE_RETRY_BASE_MS || 250);

const userQueues = new Map();
const waiters = [];
let activeTasks = 0;

function acquireSlot() {
  if (activeTasks < MAX_CONCURRENT) {
    activeTasks += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve)).then(() => {
    activeTasks += 1;
  });
}

function releaseSlot() {
  activeTasks = Math.max(0, activeTasks - 1);
  const next = waiters.shift();
  if (next) next();
}

function isRetryable(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return /fetch failed|network|timeout|timed out|econnreset|econnrefused|etimedout|socket hang up|429|502|503|504/.test(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Queue a task for a specific WhatsApp phone. The returned promise resolves
 * with the task result (or rejects after retries are exhausted).
 */
export function enqueueUserMessage(phone, task) {
  const key = String(phone || 'unknown');
  const previous = userQueues.get(key) || Promise.resolve();

  const run = previous
    .catch(() => {})
    .then(async () => {
      await acquireSlot();
      try {
        let attempt = 0;
        while (true) {
          try {
            return await task();
          } catch (err) {
            attempt += 1;
            if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
            await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
          }
        }
      } finally {
        releaseSlot();
      }
    });

  const tracked = run.finally(() => {
    if (userQueues.get(key) === tracked) userQueues.delete(key);
  });

  userQueues.set(key, tracked);
  return tracked;
}

export function getQueueStats() {
  return {
    active: activeTasks,
    maxConcurrency: MAX_CONCURRENT,
    waiting: waiters.length,
    queuedUsers: userQueues.size
  };
}

/** Wait for all in-flight user queues (graceful shutdown / tests). */
export async function drainQueue(timeoutMs = 15000) {
  const pending = [...userQueues.values()];
  if (pending.length === 0) return true;
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  const result = await Promise.race([Promise.allSettled(pending), timeout]);
  return result !== 'timeout';
}
