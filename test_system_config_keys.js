/**
 * Saka Fleet — system_config registry & dual-window suite (v1.72.1, Phase 8C / P2-6)
 * ---------------------------------------------------------------------------------
 * Offline: mocked Supabase only (no DB, no cleanup needed). Proves:
 *   - the SYSTEM_CONFIG_KEYS registry is complete and consistent,
 *   - dual-read prefers the namespaced key and falls back to the legacy key,
 *   - dual-write upserts BOTH keys; `new` mode stops legacy traffic,
 *   - the dynamic budget-alert family resolves both forms,
 *   - the migration copy plan is idempotent (COPY-then-DELETE, release A keeps both),
 *   - every `system_config` access in the app goes through the service choke point.
 *
 * Run: node test_system_config_keys.js
 */
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  SYSTEM_CONFIG_KEYS,
  SYSTEM_CONFIG_KEY_MODES,
  CONFIG_KEY_SAKA_CORE_PROMPT,
  CONFIG_KEY_DEPLOY_LAST_REVISION,
  CONFIG_KEY_ADMIN_WIPE_PENDING,
  dynamicConfigKey,
  legacyDynamicConfigKey,
  describeConfigKey,
  legacyConfigKeyFor,
  planSystemConfigCopies,
  knownSystemConfigKeys
} from './src/services/systemConfigKeys.js';
import { readConfig, writeConfig, readConfigMany } from './src/services/systemConfigService.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

/** Minimal chainable Supabase mock for system_config only. */
function makeConfigMock(rows = []) {
  const state = { rows: [...rows], writes: [] };
  const client = {
    from(table) {
      if (table !== 'system_config') throw new Error(`unexpected table ${table}`);
      const api = {
        select() { return api; },
        in(column, keys) {
          return {
            limit: async () => ({
              data: state.rows.filter((row) => keys.includes(row.key)),
              error: null
            })
          };
        },
        upsert(entries) {
          state.writes.push(entries);
          for (const entry of entries) {
            const index = state.rows.findIndex((row) => row.key === entry.key);
            if (index >= 0) state.rows[index] = { ...state.rows[index], ...entry };
            else state.rows.push(entry);
          }
          return Promise.resolve({ error: null });
        }
      };
      return api;
    }
  };
  return { client, state };
}

async function withMode(mode, fn) {
  const original = process.env.SYSTEM_CONFIG_KEY_MODE;
  if (mode === null) delete process.env.SYSTEM_CONFIG_KEY_MODE;
  else process.env.SYSTEM_CONFIG_KEY_MODE = mode;
  try { return await fn(); } finally {
    if (original !== undefined) process.env.SYSTEM_CONFIG_KEY_MODE = original;
    else delete process.env.SYSTEM_CONFIG_KEY_MODE;
  }
}

console.log('=== SAKA FLEET - SYSTEM_CONFIG KEY REGISTRY (P2-6) ===');

console.log('--- Test 1: registry integrity ---');
{
  const entries = Object.entries(SYSTEM_CONFIG_KEYS);
  check(entries.length === 9, `the registry carries the 9 fixed keys (found ${entries.length})`);
  const legacyKeys = entries.map(([, descriptor]) => descriptor.legacyKey);
  check(new Set(legacyKeys).size === legacyKeys.length, 'every legacy key is unique');
  check(entries.every(([key]) => key.includes('.') && /^[a-z]+(\.[a-z0-9_]+)+$/.test(key)), 'every namespaced key is domain.namespaced');
  check(entries.every(([, descriptor]) => typeof descriptor.owner === 'string' && descriptor.owner.length > 0), 'every key names its owning module');
  check(entries.every(([, descriptor]) => descriptor.kind === 'fixed' && typeof descriptor.bootCritical === 'boolean'), 'every fixed key carries bootCritical + kind');
  check(SYSTEM_CONFIG_KEYS[CONFIG_KEY_SAKA_CORE_PROMPT]?.bootCritical === true && SYSTEM_CONFIG_KEYS[CONFIG_KEY_DEPLOY_LAST_REVISION]?.bootCritical === true, 'the two boot-critical keys are flagged (prompt + deploy revision)');
  check(SYSTEM_CONFIG_KEYS['remediation.digest_frequency']?.default === 'twice_daily', 'the digest cadence keeps its engine default');
  check(SYSTEM_CONFIG_KEY_MODES.join(',') === 'dual,new', 'the two transition modes are dual and new');
}

console.log('--- Test 2: describeConfigKey resolves every form ---');
{
  const fromNew = describeConfigKey(CONFIG_KEY_ADMIN_WIPE_PENDING);
  check(fromNew.namespacedKey === 'admin.wipe_pending' && fromNew.legacyKey === 'admin_wipe_pending', 'a namespaced key resolves to itself + its legacy name');
  const fromLegacy = describeConfigKey('admin_wipe_pending');
  check(fromLegacy.namespacedKey === 'admin.wipe_pending' && fromLegacy.legacyKey === 'admin_wipe_pending', 'a legacy key resolves to the namespaced pair');
  check(legacyConfigKeyFor(CONFIG_KEY_DEPLOY_LAST_REVISION) === 'last_deployed_revision', 'legacyConfigKeyFor answers the deploy marker legacy name');
  const dynamicNew = dynamicConfigKey(80, '2026-11-07');
  const dynamicLegacy = legacyDynamicConfigKey(80, '2026-11-07');
  check(dynamicNew === 'budget.alert.80_2026-11-07' && dynamicLegacy === 'ai_budget_alert_80_2026-11-07', 'the dynamic budget-alert family round-trips');
  check(describeConfigKey(dynamicNew).legacyKey === dynamicLegacy && describeConfigKey(dynamicLegacy).namespacedKey === dynamicNew, 'both dynamic forms resolve to the same pair');
  const unknown = describeConfigKey('some_future_key');
  check(unknown.namespacedKey === 'some_future_key' && unknown.legacyKey === null, 'an unknown key passes through untouched');
}

console.log('--- Test 3: dual-read prefers the new key, falls back to the legacy key ---');
await withMode('dual', async () => {
  {
    const { client } = makeConfigMock([
      { key: CONFIG_KEY_ADMIN_WIPE_PENDING, value: 'NEW-VALUE' },
      { key: 'admin_wipe_pending', value: 'LEGACY-VALUE' }
    ]);
    check((await readConfig(client, CONFIG_KEY_ADMIN_WIPE_PENDING)) === 'NEW-VALUE', 'the namespaced value wins when both rows exist');
  }
  {
    const { client } = makeConfigMock([{ key: 'admin_wipe_pending', value: 'LEGACY-VALUE' }]);
    check((await readConfig(client, CONFIG_KEY_ADMIN_WIPE_PENDING)) === 'LEGACY-VALUE', 'the legacy row is the fallback during the dual window');
  }
  {
    const { client } = makeConfigMock([]);
    check((await readConfig(client, 'remediation.digest_frequency')) === 'twice_daily', 'an empty table returns the registry default');
    check((await readConfig(client, CONFIG_KEY_ADMIN_WIPE_PENDING)) === null, 'a key without a default returns null');
  }
  {
    const { client } = makeConfigMock([{ key: 'ai_budget_alert_80_2026-11-07', value: 'SENT' }]);
    check((await readConfig(client, dynamicConfigKey(80, '2026-11-07'))) === 'SENT', 'the dynamic family dual-reads its legacy ai_budget_alert_* row');
  }
});
await withMode('new', async () => {
  const { client } = makeConfigMock([{ key: 'admin_wipe_pending', value: 'LEGACY-VALUE' }]);
  check((await readConfig(client, CONFIG_KEY_ADMIN_WIPE_PENDING)) === null, 'new mode ignores the legacy row entirely');
});
await withMode(null, async () => {
  const { client } = makeConfigMock([{ key: 'admin_wipe_pending', value: 'LEGACY-VALUE' }]);
  check((await readConfig(client, CONFIG_KEY_ADMIN_WIPE_PENDING)) === 'LEGACY-VALUE', 'an unset mode defaults to dual (legacy fallback works)');
});

console.log('--- Test 4: dual-write upserts both keys (one write in new mode) ---');
await withMode('dual', async () => {
  const { client, state } = makeConfigMock([]);
  const result = await writeConfig(client, CONFIG_KEY_DEPLOY_LAST_REVISION, 'rev-42');
  check(result.ok === true, 'the dual write succeeds');
  check(state.writes.length === 1 && state.writes[0].length === 2, 'dual mode writes exactly two rows (namespaced + legacy)');
  check(state.writes[0].some((row) => row.key === CONFIG_KEY_DEPLOY_LAST_REVISION && row.value === 'rev-42')
    && state.writes[0].some((row) => row.key === 'last_deployed_revision' && row.value === 'rev-42'), 'both rows carry the same value');
});
await withMode('new', async () => {
  const { client, state } = makeConfigMock([]);
  await writeConfig(client, CONFIG_KEY_DEPLOY_LAST_REVISION, 'rev-43');
  check(state.writes.length === 1 && state.writes[0].length === 1 && state.writes[0][0].key === CONFIG_KEY_DEPLOY_LAST_REVISION, 'new mode writes the namespaced row only');
});

console.log('--- Test 5: batch read resolves new-first with a legacy fallback ---');
await withMode('dual', async () => {
  const { client } = makeConfigMock([
    { key: 'eval.digest_last_at', value: 'NEW' },
    { key: 'last_eval_digest_attempt_at', value: 'LEGACY-ATTEMPT' }
  ]);
  const map = await readConfigMany(client, ['eval.digest_last_at', 'eval.digest_attempt_at']);
  check(map.get('eval.digest_last_at') === 'NEW', 'the batch prefers the namespaced marker');
  check(map.get('eval.digest_attempt_at') === 'LEGACY-ATTEMPT', 'the batch falls back to the legacy marker');
});

console.log('--- Test 6: migration plan is COPY-only and idempotent ---');
{
  const legacyRows = [
    { key: 'saka_core_prompt', value: 'PROMPT-A', updated_by: 'sentinel_worker', updated_at: '2026-11-01T00:00:00Z' },
    { key: 'last_deployed_revision', value: 'rev-1', updated_by: null, updated_at: '2026-11-02T00:00:00Z' },
    { key: 'ai_budget_alert_80_2026-11-07', value: '2026-11-07T09:00:00Z' },
    { key: 'unknown_legacy_key', value: 'KEEP' }
  ];
  const first = planSystemConfigCopies(legacyRows);
  check(first.length === 3, `the first run copies the 3 legacy rows (found ${first.length})`);
  check(first.every((copy) => copy.namespacedKey.includes('.')), 'every copy targets a namespaced key');
  check(first.every((copy) => !('delete' in copy) && !('remove' in copy)), 'release A plans copies only, never deletes');
  check(first.some((copy) => copy.namespacedKey === 'prompt.saka_core_prompt' && copy.value === 'PROMPT-A' && copy.updated_by === 'sentinel_worker'), 'the prompt keeps its value and author');
  check(first.some((copy) => copy.namespacedKey === 'budget.alert.80_2026-11-07'), 'the dynamic budget-alert rows are copied');
  const migratedRows = [...legacyRows, ...first.map((copy) => ({ key: copy.namespacedKey, value: copy.value }))];
  check(planSystemConfigCopies(migratedRows).length === 0, 'a re-run copies nothing twice (idempotent)');
  const changed = migratedRows.map((row) => (row.key === 'saka_core_prompt' ? { ...row, value: 'PROMPT-B' } : row));
  const third = planSystemConfigCopies(changed);
  check(third.length === 1 && third[0].namespacedKey === 'prompt.saka_core_prompt' && third[0].value === 'PROMPT-B', 'a changed legacy value is re-copied exactly once');
  check(!knownSystemConfigKeys().has('unknown_legacy_key'), 'unregistered keys stay outside the registry');
}

console.log('--- Test 7: service choke point (no raw system_config access) ---');
{
  const offenders = [];
  const allowed = path.join('src', 'services', 'systemConfigService.js');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!full.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (source.includes(".from('system_config')") && !full.endsWith(allowed)) offenders.push(full);
    }
  };
  walk('src');
  if (fs.readFileSync('sakaAi.js', 'utf8').includes(".from('system_config')")) offenders.push('sakaAi.js');
  check(offenders.length === 0, `every src/ system_config access rides the service choke point${offenders.length ? ` — offenders: ${offenders.join(', ')}` : ''}`);
  check(Object.values(SYSTEM_CONFIG_KEYS).some((descriptor) => descriptor.owner === 'sentinel')
    && Object.values(SYSTEM_CONFIG_KEYS).some((descriptor) => descriptor.owner === 'deployLiveAlert'), 'the boot-path owners are registered');
}

console.log(`\nALL SYSTEM_CONFIG KEY TESTS PASSED (${passed} assertions).`);
