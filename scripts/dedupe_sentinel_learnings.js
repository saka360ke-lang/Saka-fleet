#!/usr/bin/env node
/**
 * Saka Fleet — dedupe the live Sentinel learnings (v1.97.8)
 * --------------------------------------------------------
 * The stored core-prompt refinement (`system_config.prompt.saka_core_prompt`)
 * is append-only; before v1.97.8 every synthesis could re-append a lesson it
 * had already stored, so the live prompt showed the same five bullets 3-4×.
 *
 * This script rewrites ONLY the learnings block: it keeps the schema marker,
 * the SENTINEL header and the NEWEST unique lessons (case/whitespace-
 * insensitive, max 5). Idempotent, content-gated and audited. It never touches
 * the trained prompt in code.
 *
 * Usage:
 *   node scripts/dedupe_sentinel_learnings.js --dry-run
 *   node scripts/dedupe_sentinel_learnings.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PROMPT_REFINEMENT_MARKER } from '../sakaAi.js';
import { readConfig, writeConfig } from '../src/services/systemConfigService.js';
import { CONFIG_KEY_SAKA_CORE_PROMPT } from '../src/services/systemConfigKeys.js';
import { dedupeLearningBullets, parseLearningBullets } from '../src/services/promptLearnings.js';
import { refinementIsSafe } from '../src/workers/sentinel.js';

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_KEY_LABEL = 'prompt.saka_core_prompt';

async function audit(supabase, action, details) {
  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'system',
      action,
      details
    }]);
  } catch { /* audit is best-effort */ }
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY missing.');
    process.exit(1);
  }
  const supabase = createClient(url, key);
  const current = await readConfig(supabase, CONFIG_KEY_SAKA_CORE_PROMPT);

  if (!current || !String(current).includes(PROMPT_REFINEMENT_MARKER)) {
    console.log('ℹ️ No stored refinement block to dedupe — nothing to do.');
    return;
  }

  const text = String(current);
  const headerLine = text.split('\n').map((l) => l.trim()).find((l) => /^SENTINEL LIVE LEARNINGS/i.test(l)) || null;
  const bullets = parseLearningBullets(text);
  const unique = dedupeLearningBullets(bullets);
  const header = headerLine || `SENTINEL LIVE LEARNINGS (append-only, ${new Date().toISOString().slice(0, 10)}):`;
  const next = `${PROMPT_REFINEMENT_MARKER}\n${header}\n${unique.join('\n')}`.trim();

  console.log(`Bullets before: ${bullets.length} (unique ${new Set(bullets.map((b) => b.toLowerCase())).size})`);
  console.log(`Bullets after:  ${unique.length}`);
  unique.forEach((line, idx) => console.log(`  ${idx + 1}. ${line.slice(0, 100)}`));

  if (next === text.trim()) {
    console.log('✅ Already deduped — no change written.');
    return;
  }
  if (!refinementIsSafe(next)) {
    console.error('❌ Rewrite refused: it fails the prompt content gate.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n--- dry run: the value that WOULD be stored ---\n' + next);
    return;
  }

  const write = await writeConfig(supabase, CONFIG_KEY_SAKA_CORE_PROMPT, next, {
    updatedBy: 'sentinel_dedupe_v1.97.8',
    updatedAt: new Date().toISOString()
  });
  if (!write.ok) {
    console.error(`❌ Write failed: ${write.error}`);
    process.exit(1);
  }
  await audit(supabase, 'SENTINEL_LEARNINGS_DEDUPED', {
    config_key: CONFIG_KEY_LABEL,
    bullets_before: bullets.length,
    bullets_after: unique.length,
    dropped: Math.max(0, bullets.length - unique.length)
  });
  console.log(`✅ ${CONFIG_KEY_LABEL} deduped: ${bullets.length} → ${unique.length} bullets (audited SENTINEL_LEARNINGS_DEDUPED).`);
}

main().catch((err) => {
  console.error('❌ Dedupe failed:', err?.message || err);
  process.exit(1);
});
