/**
 * Saka Fleet - Duplicate website signup regression (v1.58.14, stateless)
 * In-memory Supabase double only - no real rows, no cleanup needed.
 */
import assert from 'assert';
import {
  phoneVariants, findProfileByPhone, findExistingProfile,
  inspectExistingSignup, completeWebOnboarding, notifyExistingSignup, maskPhone,
  checkSignupAvailability
} from './src/services/webOnboarding.js';

let passed = 0;
function check(cond, label) {
  assert.ok(cond, label);
  passed += 1;
  console.log('  ok ' + label);
}

function createMock(seed = {}) {
  const db = {};
  for (const [name, rows] of Object.entries(seed)) db[name] = rows.map((r) => ({ ...r }));
  function matches(row, [c, v]) {
    if (c.startsWith('__in__')) { const col = c.slice(6); return Array.isArray(v) && v.indexOf(row[col]) !== -1; }
    if (c.startsWith('__ilike__')) {
      const col = c.slice(9);
      const value = String(row[col] || '').toLowerCase();
      const pat = String(v || '').toLowerCase();
      if (pat.startsWith('%') && pat.endsWith('%')) return value.indexOf(pat.slice(1, -1)) !== -1;
      if (pat.startsWith('%')) return value.endsWith(pat.slice(1));
      if (pat.endsWith('%')) return value.startsWith(pat.slice(0, -1));
      return value === pat;
    }
    return row[c] === v;
  }
  function query(rows) {
    const filters = [];
    const q = {
      eq(c, v) { filters.push([c, v]); return q; },
      in(c, v) { filters.push(['__in__' + c, v]); return q; },
      ilike(c, v) { filters.push(['__ilike__' + c, v]); return q; },
      limit: async (n) => ({ data: rows.filter((r) => filters.every((f) => matches(r, f))).slice(0, n) }),
      maybeSingle: async () => {
        const out = rows.filter((r) => filters.every((f) => matches(r, f)));
        return { data: out.length ? { ...out[0] } : null };
      }
    };
    return q;
  }
  return {
    __db: db,
    from(name) {
      const rows = db[name] || (db[name] = []);
      return {
        select: () => query(rows),
        insert(payload) {
          const items = Array.isArray(payload) ? payload : [payload];
          for (const item of items) rows.push({ ...item });
          return { select: () => ({ maybeSingle: async () => ({ data: items[0] || null }) }) };
        },
        update(payload) {
          return { eq: async (c, v) => { for (const r of rows) if (r[c] === v) Object.assign(r, payload); return { error: null }; } };
        }
      };
    }
  };
}

console.log('--- Test 1: phone variants + mask ---');
check(phoneVariants('0734852529').indexOf('734852529') !== -1, 'a local 07 number exposes its 9-digit tail');
check(phoneVariants('+254734852529').indexOf('+254734852529') !== -1, 'an E.164 number keeps its full form');
check(maskPhone('+254734852529') === '+2547****2529', 'maskPhone hides the middle digits');

console.log('--- Test 2: local phone finds the E.164 profile ---');
const db = createMock({ profiles: [{ id: 'p-1', phone_number: '+254734852529', email: 'david@example.com', email_verified: true, full_name: 'David M', preferred_language: null }], admin_audit_logs: [] });
check((await findProfileByPhone(db, '0734852529')).id === 'p-1', '0734852529 resolves to the +254734852529 profile');
check((await findProfileByPhone(db, '+254734852529')).id === 'p-1', 'the E.164 form still resolves');

console.log('--- Test 3: email matching ---');
const byEmail = await findExistingProfile(db, { email: 'DAVID@example.com', phone: '+254700000000' });
check(byEmail.matchedBy === 'email' && byEmail.profile.id === 'p-1', 'an email match is case-insensitive');

console.log('--- Test 4: inspection states ---');
check((await inspectExistingSignup(db, { email: 'david@example.com', phone: '0734852529' })).state === 'verified', 'same phone (local) + same email is verified');
check((await inspectExistingSignup(db, { email: 'david@example.com', phone: '+254700000000' })).state === 'email_exists', 'an email owned by another number is email_exists');
check((await inspectExistingSignup(db, { email: 'brand.new@example.com', phone: '+254700000000' })).state === 'none', 'a genuinely new visitor is none');

console.log('--- Test 5: completeWebOnboarding never duplicates ---');
const res = await completeWebOnboarding(db, { email: 'david@example.com', phone: '0734852529', firstName: 'David', lastName: 'M', verified: true });
check(res.ok === true && res.created === false, 'a local-format signup reuses the existing profile');
check(db.__db.profiles.length === 1, 'no second profile row is created');

console.log('--- Test 6: duplicate notification ---');
let waCalled = null;
const notify = await notifyExistingSignup(db, { profile: db.__db.profiles[0], email: 'david@example.com', phone: '0734852529', sendWhatsApp: async (to) => { waCalled = to; return true; } });
check(notify.ok === true && notify.whatsapped === true, 'the owner is pinged on WhatsApp');
check(waCalled === '+254734852529', 'the WhatsApp ping goes to the stored number');
check(db.__db.admin_audit_logs.some((a) => a.action === 'WEB_ONBOARD_DUPLICATE_NOTIFIED'), 'the block is audited');

console.log('--- Test 7: live availability check (v1.59.2) ---');
const known = await checkSignupAvailability(db, { email: 'DAVID@example.com', phone: '0734852529' });
check(known.ok === true && known.email === 'registered' && known.phone === 'registered', 'a known email and number both report registered');
check(known.verified === true, 'the verified flag rides the availability answer');
const partlyFree = await checkSignupAvailability(db, { email: 'brand.new@example.com', phone: '+254700000000' });
check(partlyFree.email === 'available' && partlyFree.phone === 'available', 'a free email and number both report available');
const noClient = await checkSignupAvailability(null, { phone: '+254700000000' });
check(noClient.ok === false, 'a missing client fails open (never a false "registered")');
const brokenCheck = await checkSignupAvailability({ from() { throw new Error('db down'); } }, { phone: '+254700000000' });
check(brokenCheck.ok === false, 'a DB failure fails open (never a false "registered")');

console.log('--- Test 8: unique-violation race merges into the existing profile (v1.59.2) ---');
let findCalls = 0;
const raceDb = {
  from(name) {
    if (name === 'profiles') {
      return {
        select: () => ({
          in: () => ({
            limit: async () => {
              findCalls += 1;
              if (findCalls === 1) return { data: [], error: null };
              return { data: [{ id: 'p-raced', phone_number: '+254700000123', email_verified: false, full_name: null, preferred_language: null }], error: null };
            }
          }),
          ilike: () => ({ limit: async () => ({ data: [], error: null }) })
        }),
        insert: () => Promise.resolve({ error: { message: 'duplicate key value violates unique constraint "idx_profiles_phone_unique"' } }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
    return { insert: () => Promise.resolve({ error: null }) };
  }
};
const raced = await completeWebOnboarding(raceDb, { email: 'race@example.com', phone: '+254700000123', firstName: 'R', lastName: 'A', verified: true });
check(raced.ok === true && raced.created === false && raced.raced === true, 'a unique-violation race merges instead of failing the signup');
check(findCalls >= 2, 'the race path re-reads the profile before merging');

console.log('');
console.log(passed + ' duplicate-signup assertions passed.');