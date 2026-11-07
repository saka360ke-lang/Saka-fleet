// v1.58.8 - OTP-gated profile wipe (mock; stateless, no real DB / no email).
import { wipeProfileForSignup } from './src/services/profileWipe.js';
import { handleAdminProfileWipeConfirm } from './src/services/superadmin.js';

let pass = 0;
let fail = 0;
const check = (c, l) => { if (c) { pass += 1; console.log('✅', l); } else { fail += 1; console.error('❌', l); } };

function makeMock({ pending = null } = {}) {
  const deleted = [];
  const deleteCalls = [];
  const cfg = {};
  if (pending) cfg.admin_wipe_pending = JSON.stringify(pending);
  const builder = (table) => {
    const state = { filters: [] };
    const chain = {
      select() { return chain; },
      eq(col, val) { state.filters.push([col, val]); return chain; },
      in() { return chain; },
      ilike() { return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() {
        if (table === 'system_config') {
          const key = (state.filters.find(([c]) => c === 'key') || [])[1];
          const val = cfg[key];
          return Promise.resolve({ data: val !== undefined && val !== null ? { value: val } : null });
        }
        return Promise.resolve({ data: null });
      },
      upsert(rows) { rows.forEach((r) => { cfg[r.key] = r.value; }); return Promise.resolve({ error: null }); },
      delete() { return { in: (col, vals) => { deleted.push(table); deleteCalls.push({ table, col, vals: vals || [] }); return Promise.resolve({ count: (vals && vals.length) ? 1 : 0 }); } }; },
      then(resolve) {
        // v1.72.1 (P2-6) — the dual-window service lists config rows with ONE
        // atomic `.in()` query; answer for the requested keys.
        if (table === 'system_config') {
          const asked = state.inKeys || Object.keys(cfg);
          resolve({ data: asked.filter((k) => cfg[k] !== undefined && cfg[k] !== null).map((k) => ({ key: k, value: cfg[k] })), error: null });
        }
        else if (table === 'profiles') resolve({ data: [{ id: 'p1', phone_number: '+254734852529' }] });
        else if (table === 'vehicles') resolve({ data: [{ id: 'v1', plate_number: 'KBJ 819C', vin: 'KBJ123456789' }] });
        else resolve({ data: [] });
      }
    };
    return chain;
  };
  return { deleted, deleteCalls, cfg, client: { from: builder } };
}

async function run() {
  const m1 = makeMock();
  const r1 = await wipeProfileForSignup(m1.client, '0734852529');
  check(r1.ok === true, 'wipe returns ok');
  check(m1.deleted.includes('profiles'), 'wipe deletes profiles');
  check(m1.deleted.includes('vehicles'), 'wipe deletes vehicles');
  check(m1.deleted.includes('expense_logs'), 'wipe deletes expense_logs');
  check(m1.deleted.includes('private_earnings'), 'wipe deletes private_earnings');
  check(m1.deleted.includes('chat_sessions'), 'wipe deletes chat_sessions');
  check(m1.deleted.includes('vin_registry'), 'wipe deletes vin_registry (clean slate)');
  const ctCall = m1.deleteCalls.find((c) => c.table === 'chat_transcripts');
  check(ctCall && ctCall.vals.includes('254734852529'), 'wipe matches the bare 254... phone form');
  check((await wipeProfileForSignup(m1.client, '123')).ok === false, 'short phone is rejected');

  const m2 = makeMock();
  const r2 = await handleAdminProfileWipeConfirm(m2.client, '123456');
  check(r2.wiped === false && /no pending/i.test(r2.reply), 'confirm with no pending is refused');

  const future = new Date(Date.now() + 60000).toISOString();
  const m3 = makeMock({ pending: { targetPhone: '+254734852529', code: '654321', expiresAt: future, attempts: 0 } });
  const r3 = await handleAdminProfileWipeConfirm(m3.client, '111111');
  check(r3.wiped === false && /not correct/i.test(r3.reply), 'wrong code is rejected');

  const past = new Date(Date.now() - 60000).toISOString();
  const m4 = makeMock({ pending: { targetPhone: '+254734852529', code: '654321', expiresAt: past, attempts: 0 } });
  const r4 = await handleAdminProfileWipeConfirm(m4.client, '654321');
  check(r4.wiped === false && /expired/i.test(r4.reply), 'expired code is rejected');

  const m5 = makeMock({ pending: { targetPhone: '+254734852529', code: '654321', expiresAt: future, attempts: 0 } });
  const r5 = await handleAdminProfileWipeConfirm(m5.client, '654321');
  check(r5.wiped === true && /Profile wiped/i.test(r5.reply), 'correct code wipes and confirms');
  check(m5.deleted.includes('profiles'), 'correct code actually deletes profiles');
}

run().then(() => {
  console.log(`\n${fail === 0 ? '✅ ALL PROFILE WIPE TESTS PASSED' : '❌ PROFILE WIPE TESTS FAILED'} (${pass} assertions).`);
  if (fail > 0) process.exit(1);
}).catch((e) => { console.error('Profile wipe test crashed:', e); process.exit(1); });
