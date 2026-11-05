// v1.61.14 — per-user context cache: built at chat initiation, reused for 15
// minutes, invalidated by writes. Facts only (never OTP/token/quiz state).
import fs from 'node:fs';
import {
  USER_CONTEXT_CACHE_TABLE,
  USER_CONTEXT_SQL,
  getUserContextTtlMinutes,
  sanitizeContextPayload,
  formatUserFactsBlock,
  buildContextPayload,
  getUserContextCache,
  invalidateUserContext
} from './src/services/userContextCache.js';

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

console.log('=== 1. config + pure helpers ===');
check('TTL defaults to 15 minutes', getUserContextTtlMinutes({}) === 15, getUserContextTtlMinutes({}));
check('TTL 0 means "always rebuild"', getUserContextTtlMinutes({ USER_CONTEXT_CACHE_TTL_MINUTES: '0' }) === 0);
check('TTL clamps to 1..1440', getUserContextTtlMinutes({ USER_CONTEXT_CACHE_TTL_MINUTES: '-5' }) === 1 && getUserContextTtlMinutes({ USER_CONTEXT_CACHE_TTL_MINUTES: '99999' }) === 1440);
const dirty = { lines: ['Plan: Free.'], otp: '123456', token: 'secret', nested: { pin: '9999', ok: 'keep' } };
const clean = sanitizeContextPayload(dirty);
check('secrets are stripped from the payload', !('otp' in clean) && !('token' in clean) && !('pin' in clean.nested), clean);
check('non-secret facts survive sanitisation', clean.lines[0] === 'Plan: Free.' && clean.nested.ok === 'keep');
check('an empty payload formats to an empty block', formatUserFactsBlock({}) === '');
const block = formatUserFactsBlock({ builtAt: '2026-11-05T18:00:00.000Z', lines: ['Plan: Growth (trialing).', 'Vehicles on file (2): KBJ 819C'] });
check('the block is labelled authoritative and dated', /^USER FACTS \(engine-provided, current as of 2026-11-05 18:00 UTC/.test(block) && /- Plan: Growth/.test(block), block.split('\n')[0]);
check('the SQL creates the cache table idempotently', USER_CONTEXT_SQL.includes('CREATE TABLE IF NOT EXISTS public.user_context_cache') && USER_CONTEXT_SQL.includes('ENABLE ROW LEVEL SECURITY'));

console.log('\n=== 2. build + cache lifecycle ===');
function makeSupabase(state) {
  const chain = (table) => {
    const obj = {
      select: () => obj,
      eq: () => obj,
      is: () => obj,
      or: () => obj,
      in: () => obj,
      gte: () => obj,
      order: () => obj,
      limit: async () => ({ data: [] }),
      maybeSingle: async () => ({ data: table === USER_CONTEXT_CACHE_TABLE ? (state.row || null) : null }),
      upsert: async (rows) => { if (table === USER_CONTEXT_CACHE_TABLE) state.upserts.push(rows[0]); return { error: null }; },
      delete: () => ({ eq: (col, value) => { state.deletes.push({ col, value }); return Promise.resolve({ error: null }); } })
    };
    return obj;
  };
  return {
    from(table) {
      if (state.failAll) throw new Error('db down');
      return chain(table);
    }
  };
}
const profile = { id: 'p-1', phone_number: '+254734852529', full_name: 'David', email: 'david@example.com', email_verified: true, subscription_tier: 'growth', subscription_status: 'TRIALING', created_at: '2026-10-01T00:00:00Z' };
const vehicles = [{ id: 'v-1', plate_number: 'KBJ 819C', make_model: 'Toyota Hiace', current_mileage: 400500, fuel_type: 'Diesel', insurance_expiry: '2026-12-01' }];
const entitlements = { tierKey: 'growth', tierName: 'Growth', isTrial: true, trialDaysLeft: 12, effectiveVehicleCapacity: 5, currency: 'KES' };

const build = await buildContextPayload({ supabase: makeSupabase({ db: {} }), profile, vehicles, entitlements });
check('the payload carries engine facts (plan + vehicles)', build.ok === true && build.lines.some((l) => /Plan:/.test(l)) && build.lines.some((l) => /Vehicles on file \(1\)/.test(l)), build.lines?.slice(0, 3));
check('the payload records the plan for the prompt', build.payload.plan?.tierKey === 'growth' && build.payload.plan?.capacity === 5);

const state = { row: null, upserts: [], deletes: [] };
const supabase = makeSupabase(state);
const first = await getUserContextCache(supabase, '+254734852529', { profile, vehicles, entitlements, now: new Date('2026-11-05T18:00:00Z') });
check('a chat start builds and caches (cached: false)', first.ok === true && first.cached === false && first.lines.length > 0);
check('the cache row is keyed by the normalised phone with the owner', state.upserts.length === 1 && state.upserts[0].phone_number === '+254734852529' && state.upserts[0].owner_id === 'p-1', state.upserts[0]);
state.row = { payload: state.upserts[0].payload, built_at: state.upserts[0].built_at, expires_at: new Date('2026-11-05T18:15:00Z').toISOString() };
const reused = await getUserContextCache(supabase, '254734852529', { profile, vehicles, entitlements, now: new Date('2026-11-05T18:05:00Z') });
check('a fresh conversation turn reuses the cache (no second write)', reused.cached === true && state.upserts.length === 1, state.upserts.length);
const forced = await getUserContextCache(supabase, '254734852529', { forceRefresh: true, profile, vehicles, entitlements, now: new Date('2026-11-05T18:06:00Z') });
check('a chat initiation forces a rebuild', forced.cached === false && state.upserts.length === 2);
state.row = { payload: state.upserts[1].payload, built_at: '2026-11-05T17:00:00Z', expires_at: '2026-11-05T17:15:00Z' };
const stale = await getUserContextCache(supabase, '254734852529', { profile, vehicles, entitlements, now: new Date('2026-11-05T18:20:00Z') });
check('an expired row is rebuilt', stale.cached === false && state.upserts.length === 3);
const offState = { row: null, upserts: [], deletes: [] };
await getUserContextCache(makeSupabase(offState), '+254734852529', { profile, vehicles, entitlements, ttlMinutes: 0 });
check('TTL 0 rebuilds and never writes', offState.upserts.length === 0);
const down = await getUserContextCache(makeSupabase({ row: null, upserts: [], deletes: [], failAll: true }), '+254734852529', { profile, vehicles, entitlements });
check('a broken cache degrades to a live build (rule 50)', down.ok === true && down.cached === false && down.lines.length > 0);

console.log('\n=== 3. invalidation ===');
const invState = { row: null, upserts: [], deletes: [] };
invalidateUserContext(makeSupabase(invState), { phone: '+254734852529' });
invalidateUserContext(makeSupabase(invState), { ownerId: 'p-1' });
await new Promise((resolve) => setTimeout(resolve, 10));
check('a phone write drops the cached row', invState.deletes.some((entry) => entry.col === 'phone_number' && entry.value === '+254734852529'), invState.deletes);
check('an owner-level write drops by owner_id', invState.deletes.some((entry) => entry.col === 'owner_id' && entry.value === 'p-1'), invState.deletes);
invalidateUserContext(null, { ownerId: 'p-1' });
check('invalidation without a client is a no-op (never throws)', true);
check('the slate wipe includes the cache table', fs.readFileSync('scripts/reset-db.js', 'utf8').includes("'user_context_cache'"));

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
else console.log(`✅ ALL USER-CONTEXT CACHE TESTS PASSED (${pass} assertions).`);

