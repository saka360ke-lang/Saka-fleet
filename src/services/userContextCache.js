/**
 * Saka Fleet — per-user context cache (v1.61.14)
 * ----------------------------------------------
 * Saka must never depend on chat history alone for context. When a conversation
 * STARTS (no fresh history), the engine assembles the user's facts ONCE — plan,
 * assets, expiries, trial state, driver compliance, month spend, missing-field
 * steps (the existing `buildUserContextSnapshot` engine) — and caches them here.
 * Every later turn in the conversation reuses the cache (15-minute TTL) instead
 * of re-reading six tables, and any write that changes the facts invalidates it.
 *
 * Facts only: masked email, no OTP codes, no tokens, no quiz state. Never
 * throws; a missing table or a DB error simply falls back to a live build
 * (rule 50 — no flow ever depends on this cache).
 */
import { buildUserContextSnapshot } from './userContextSnapshot.js';

export const USER_CONTEXT_CACHE_TABLE = 'user_context_cache';
export const USER_CONTEXT_DEFAULT_TTL_MINUTES = 15;
export const USER_CONTEXT_MAX_PAYLOAD_CHARS = 12000;

// Idempotent DDL for `npm run migrate:user-context`.
export const USER_CONTEXT_SQL = `
CREATE TABLE IF NOT EXISTS public.${USER_CONTEXT_CACHE_TABLE} (
  phone_number text PRIMARY KEY,
  owner_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  built_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_user_context_owner ON public.${USER_CONTEXT_CACHE_TABLE}(owner_id);
CREATE INDEX IF NOT EXISTS idx_user_context_expires ON public.${USER_CONTEXT_CACHE_TABLE}(expires_at);
ALTER TABLE public.${USER_CONTEXT_CACHE_TABLE} ENABLE ROW LEVEL SECURITY;
`;

export function getUserContextTtlMinutes(env = process.env) {
  const raw = env?.USER_CONTEXT_CACHE_TTL_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value)) return USER_CONTEXT_DEFAULT_TTL_MINUTES;
  if (value === 0) return 0; // 0 = always rebuild (cache off)
  return Math.min(1440, Math.max(1, Math.round(value)));
}

const SECRET_KEY_RE = /(otp|code|token|password|secret|pin)/i;

/** Strip anything secret-shaped and cap the payload (pure). */
export function sanitizeContextPayload(payload = {}) {
  const clean = (value, depth = 0) => {
    if (depth > 4) return null;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => clean(item, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        if (SECRET_KEY_RE.test(key)) continue;
        out[key] = clean(entry, depth + 1);
      }
      return out;
    }
    return null;
  };
  const safe = clean(payload) || {};
  const json = JSON.stringify(safe);
  if (json.length <= USER_CONTEXT_MAX_PAYLOAD_CHARS) return safe;
  return { truncated: true, lines: Array.isArray(safe.lines) ? safe.lines.slice(0, 25) : [] };
}

/** Deterministic prompt block. Pure. */
export function formatUserFactsBlock(payload = {}) {
  const lines = Array.isArray(payload?.lines) ? payload.lines.filter(Boolean) : [];
  if (!lines.length) return '';
  const builtAt = payload?.builtAt ? String(payload.builtAt).slice(0, 16).replace('T', ' ') : null;
  return [
    `USER FACTS (engine-provided${builtAt ? `, current as of ${builtAt} UTC` : ''} — authoritative; never contradict or invent beyond them):`,
    ...lines.map((line) => `- ${line}`)
  ].join('\n');
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : null;
}

async function readRow(supabase, phone) {
  const { data } = await supabase
    .from(USER_CONTEXT_CACHE_TABLE)
    .select('payload,built_at,expires_at')
    .eq('phone_number', phone)
    .maybeSingle();
  return data || null;
}

/**
 * Build the facts payload from the existing snapshot engine.
 * Returns `{ ok, payload, lines, reason? }`; never throws.
 */
export async function buildContextPayload({
  supabase,
  profile = null,
  vehicles = [],
  entitlements = null,
  countryInfo = null,
  now = new Date()
} = {}) {
  try {
    const snapshot = await buildUserContextSnapshot({
      supabase,
      profile,
      vehicles,
      currency: entitlements?.currency || countryInfo?.currency || profile?.currency || 'USD',
      now
    });
    const payload = sanitizeContextPayload({
      builtAt: now.toISOString(),
      plan: entitlements ? {
        tierKey: entitlements.tierKey,
        tierName: entitlements.tierName,
        isTrial: Boolean(entitlements.isTrial),
        trialDaysLeft: entitlements.trialDaysLeft || 0,
        capacity: entitlements.effectiveVehicleCapacity
      } : null,
      vehicleCount: Array.isArray(vehicles) ? vehicles.length : (snapshot?.data?.vehicles || []).length,
      lines: Array.isArray(snapshot?.lines) ? snapshot.lines : [],
      memory: snapshot?.data?.memory || null
    });
    return { ok: true, payload, lines: payload.lines || [] };
  } catch (err) {
    return { ok: false, payload: null, lines: [], reason: err?.message || 'build_failed' };
  }
}

/**
 * Read the cache; rebuild when stale/absent/forced. Never throws.
 * `cached: true` means the row was reused (no snapshot work on this turn).
 */
export async function getUserContextCache(supabase, phone, {
  forceRefresh = false,
  profile = null,
  vehicles = [],
  entitlements = null,
  countryInfo = null,
  now = new Date(),
  ttlMinutes = null
} = {}) {
  const key = normalizePhone(phone);
  const ttl = ttlMinutes === null ? getUserContextTtlMinutes() : Number(ttlMinutes);
  const build = async () => {
    const built = await buildContextPayload({ supabase, profile, vehicles, entitlements, countryInfo, now });
    if (!built.ok || !supabase || !key || ttl === 0) return { ...built, cached: false };
    try {
      await supabase.from(USER_CONTEXT_CACHE_TABLE).upsert([{
        phone_number: key,
        owner_id: profile?.id || null,
        payload: built.payload,
        built_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttl * 60 * 1000).toISOString()
      }], { onConflict: 'phone_number' });
    } catch { /* a cache write must never block the turn */ }
    return { ...built, cached: false };
  };

  if (!supabase || !key || ttl === 0) return build();
  if (!forceRefresh) {
    try {
      const row = await readRow(supabase, key);
      const expiresMs = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
      if (row && Number.isFinite(expiresMs) && expiresMs > now.getTime()) {
        return { ok: true, payload: row.payload || null, lines: row.payload?.lines || [], cached: true };
      }
    } catch { /* missing table or DB error → live build (rule 50) */ }
  }
  return build();
}

/** Drop the cached facts after any write that changes them. Fire-and-forget. */
export function invalidateUserContext(supabase, { phone = null, ownerId = null } = {}) {
  if (!supabase) return;
  const key = normalizePhone(phone);
  try {
    if (key) {
      supabase.from(USER_CONTEXT_CACHE_TABLE).delete().eq('phone_number', key).then(() => {}, () => {});
      return;
    }
    if (ownerId) {
      supabase.from(USER_CONTEXT_CACHE_TABLE).delete().eq('owner_id', ownerId).then(() => {}, () => {});
    }
  } catch { /* invalidation is best-effort by design */ }
}

export default {
  USER_CONTEXT_CACHE_TABLE,
  USER_CONTEXT_DEFAULT_TTL_MINUTES,
  USER_CONTEXT_SQL,
  getUserContextTtlMinutes,
  sanitizeContextPayload,
  formatUserFactsBlock,
  buildContextPayload,
  getUserContextCache,
  invalidateUserContext
};

