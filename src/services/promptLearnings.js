/**
 * Saka Fleet — Sentinel live learnings (v1.97.8)
 * ----------------------------------------------
 * ONE pure place for the append-only learning bullets that ride the stored
 * core-prompt refinement: parse, dedupe and bound them. The Sentinel worker
 * and the operator dedupe script share this module, so the loop can never
 * re-accumulate duplicates again (live 2026-11-14: the same five lessons were
 * repeated 3-4× in `system_config.prompt.saka_core_prompt`).
 *
 * Pure: no DB calls, never throws.
 */

/** Newest unique learnings kept in the stored refinement block. */
export const SENTINEL_LEARNINGS_MAX = 5;

/** Normalise one bullet: strip the "- " prefix, collapse whitespace. */
export function normalizeLearningBullet(raw = '') {
  return String(raw || '').replace(/^-\s*/, '').replace(/\s+/g, ' ').trim();
}

/** Every bullet in a stored refinement block (lines starting with "- "). */
export function parseLearningBullets(text = '') {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^-/.test(line))
    .map(normalizeLearningBullet)
    .filter(Boolean);
}

/**
 * Dedupe bullets case/whitespace-insensitively; the NEWEST occurrence keeps
 * its position (a later repeat refreshes an older lesson), and only the
 * newest `max` unique bullets survive.
 */
export function dedupeLearningBullets(lines = [], max = SENTINEL_LEARNINGS_MAX) {
  const order = new Map();
  for (const raw of lines || []) {
    const text = normalizeLearningBullet(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (order.has(key)) order.delete(key); // newest occurrence wins
    order.set(key, `- ${text}`);
  }
  const limit = Math.max(1, Number(max) || SENTINEL_LEARNINGS_MAX);
  const unique = [...order.values()];
  return unique.slice(Math.max(0, unique.length - limit));
}

export default { SENTINEL_LEARNINGS_MAX, normalizeLearningBullet, parseLearningBullets, dedupeLearningBullets };
