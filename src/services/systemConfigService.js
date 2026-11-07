/**
 * Saka Fleet — system_config access choke point (v1.72.1, Phase 8C / P2-6)
 * ------------------------------------------------------------------------
 * Every read and write of `system_config` goes through this module. In dual
 * mode (the default for one release) a read fetches the namespaced key AND its
 * legacy key in ONE atomic `.in()` query (prefer new, fall back to legacy) and
 * a write upserts BOTH rows — so a mixed-version rolling deploy can never
 * double-fire a marker (deploy LIVE alert, digests, urgent cooldown, wipe OTP).
 *
 * Never throws: a DB failure degrades to the registry default (rule 50) and a
 * refused write is logged with its reason instead of being swallowed silently.
 */
import {
  SYSTEM_CONFIG_KEYS,
  describeConfigKey,
  isDualKeyMode,
  systemConfigKeyMode
} from './systemConfigKeys.js';

function present(value) {
  return value !== null && value !== undefined && String(value).length > 0;
}

function valueFromRows(rows, key) {
  const row = (rows || []).find((entry) => entry?.key === key);
  return row ? row.value : null;
}

/**
 * Read one config value. Dual mode: new key first, legacy fallback (single
 * atomic query). Returns the descriptor default when nothing is stored.
 */
export async function readConfig(supabase, configKey) {
  const descriptor = describeConfigKey(configKey);
  if (!supabase) return descriptor.default ?? null;
  const keys = [descriptor.namespacedKey];
  if (isDualKeyMode() && descriptor.legacyKey && descriptor.legacyKey !== descriptor.namespacedKey) {
    keys.push(descriptor.legacyKey);
  }
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('key,value')
      .in('key', keys)
      .limit(keys.length + 1);
    if (error) return descriptor.default ?? null;
    const fresh = valueFromRows(data, descriptor.namespacedKey);
    if (present(fresh)) return fresh;
    if (keys.length > 1) {
      const legacy = valueFromRows(data, descriptor.legacyKey);
      if (present(legacy)) return legacy;
    }
    return descriptor.default ?? null;
  } catch {
    return descriptor.default ?? null;
  }
}

/**
 * Write one config value. Dual mode upserts the namespaced row AND the legacy
 * row so older instances in a rolling deploy still see the marker.
 */
export async function writeConfig(supabase, configKey, value, { updatedBy = null, updatedAt = null } = {}) {
  const descriptor = describeConfigKey(configKey);
  if (!supabase) return { ok: false, error: 'no_client' };
  const stamp = updatedAt || new Date().toISOString();
  const rows = [{
    key: descriptor.namespacedKey,
    value,
    ...(updatedBy ? { updated_by: updatedBy } : {}),
    updated_at: stamp
  }];
  if (isDualKeyMode() && descriptor.legacyKey && descriptor.legacyKey !== descriptor.namespacedKey) {
    rows.push({
      key: descriptor.legacyKey,
      value,
      ...(updatedBy ? { updated_by: updatedBy } : {}),
      updated_at: stamp
    });
  }
  try {
    const { error } = await supabase.from('system_config').upsert(rows, { onConflict: 'key' });
    if (error) {
      console.warn(`[systemConfig] ${descriptor.namespacedKey} write failed:`, error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[systemConfig] ${descriptor.namespacedKey} write exception:`, err?.message || err);
    return { ok: false, error: err?.message || 'write_exception' };
  }
}

/**
 * Batch read (the eval digest reads two markers at once). Returns a Map keyed
 * by the NAMESPACED name, each resolved new-first with a legacy fallback.
 */
export async function readConfigMany(supabase, configKeys = []) {
  const resolved = new Map();
  if (!supabase) {
    for (const key of configKeys) resolved.set(key, describeConfigKey(key).default ?? null);
    return resolved;
  }
  const descriptors = configKeys.map((key) => describeConfigKey(key));
  const queryKeys = [];
  for (const descriptor of descriptors) {
    queryKeys.push(descriptor.namespacedKey);
    if (isDualKeyMode() && descriptor.legacyKey && descriptor.legacyKey !== descriptor.namespacedKey) {
      queryKeys.push(descriptor.legacyKey);
    }
  }
  let rows = [];
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('key,value')
      .in('key', queryKeys)
      .limit(queryKeys.length + 1);
    if (!error) rows = data || [];
  } catch { rows = []; }
  for (const descriptor of descriptors) {
    const fresh = valueFromRows(rows, descriptor.namespacedKey);
    if (present(fresh)) { resolved.set(descriptor.namespacedKey, fresh); continue; }
    const legacy = descriptor.legacyKey ? valueFromRows(rows, descriptor.legacyKey) : null;
    resolved.set(descriptor.namespacedKey, present(legacy) ? legacy : (descriptor.default ?? null));
  }
  return resolved;
}

export { systemConfigKeyMode, isDualKeyMode, SYSTEM_CONFIG_KEYS };

export default { readConfig, writeConfig, readConfigMany, systemConfigKeyMode, isDualKeyMode };
