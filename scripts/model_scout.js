import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  AI_MODEL_TIER_SLOTS,
  AI_MODEL_MAX_CANARY_PCT,
  applyModelRollout,
  getModelWatchdogSummary,
  installModelRuntime,
  rollbackModel,
  runModelScoutCycle,
  verifyModelUpdateAgainstRegistry
} from '../src/services/aiModelRegistry.js';

/**
 * Saka Fleet — Model Watchdog ops CLI (v1.17.0).
 *
 * Usage:
 *   node scripts/model_scout.js status
 *   node scripts/model_scout.js scout
 *   node scripts/model_scout.js adopt <model_id> [--split 25]
 *   node scripts/model_scout.js rollback [tier_1|tier_2|tier_3]
 *
 * Read/adoption commands are guarded by the same registry verification used by
 * the superadmin WhatsApp commands. No source code is ever edited here.
 */

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing in environment');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function status(supabase) {
  await installModelRuntime(supabase);
  const summary = await getModelWatchdogSummary(supabase);
  console.log(JSON.stringify(summary, null, 2));
}

async function scout(supabase) {
  const result = await runModelScoutCycle(supabase, { force: true });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ok') process.exitCode = 1;
}

async function adopt(supabase, modelId) {
  if (!modelId) throw new Error('Usage: node scripts/model_scout.js adopt <model_id> [--split 25]');
  const split = Math.min(
    AI_MODEL_MAX_CANARY_PCT,
    Math.max(1, Number(readFlag('--split', AI_MODEL_MAX_CANARY_PCT)))
  );
  const gate = await verifyModelUpdateAgainstRegistry(supabase, {
    model_id: modelId,
    traffic_split: split,
    rollback: 'admin model rollback',
    tests: ['test_model_scout.js', 'test_model_router.js', 'test_agent_training.js'],
    changes: [{ file: 'src/services/aiModelRegistry.js' }]
  });
  if (!gate.ok) {
    console.error(JSON.stringify(gate.violations, null, 2));
    process.exitCode = 1;
    return;
  }
  const rollout = await applyModelRollout(supabase, {
    modelId,
    trafficSplit: split,
    activatedBy: 'ops_cli',
    reason: 'scripts/model_scout.js adopt'
  });
  console.log(JSON.stringify(rollout, null, 2));
  if (!rollout.ok) process.exitCode = 1;
}

async function rollback(supabase, tierSlot) {
  const slot = AI_MODEL_TIER_SLOTS.includes(tierSlot) ? tierSlot : 'tier_1';
  const result = await rollbackModel(supabase, { tierSlot: slot, reason: 'ops_cli' });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const supabase = getClient();

  switch (command) {
    case 'status':
      return status(supabase);
    case 'scout':
      return scout(supabase);
    case 'adopt':
      return adopt(supabase, args[0]);
    case 'rollback':
      return rollback(supabase, args[0]);
    default:
      console.error('Usage: node scripts/model_scout.js <status|scout|adopt <model_id> [--split N]|rollback [tier_1]>');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[model_scout] Fatal:', err.message);
  process.exit(1);
});
