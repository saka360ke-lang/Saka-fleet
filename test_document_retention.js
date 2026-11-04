/** Saka Fleet - document pipeline retention/delete tests (v1.58.15, stateless) */
import assert from 'assert';
import { receiptStoragePaths, deleteReceipt, pruneOldReceipts } from './src/services/receipts.js';
import { pruneOcrTelemetry } from './src/services/ocrTelemetry.js';
import { wipeProfileForSignup } from './src/services/profileWipe.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

function makeMock({ profiles = [], vehicles = [], receipts = [], ocr = [] } = {}) {
  const db = { profiles: profiles.map((r) => ({ ...r })), vehicles: vehicles.map((r) => ({ ...r })), receipts: receipts.map((r) => ({ ...r })), ocr_requests: ocr.map((r) => ({ ...r })) };
  const removed = [];
  function query(table) {
    const state = { filters: [], limit: null };
    const rows = () => db[table] || (db[table] = []);
    const match = (r) => state.filters.every(([c, v, op]) => {
      if (op === 'ilike') return String(r[c] || '').toLowerCase().indexOf(String(v).split('%').join('').toLowerCase()) !== -1;
      if (op === 'in') return v.indexOf(r[c]) !== -1;
      if (op === 'lt') return String(r[c]) < String(v);
      return r[c] === v;
    });
    const q = {
      select: () => q,
      eq: (c, v) => { state.filters.push([c, v, 'eq']); return q; },
      in: (c, v) => { state.filters.push([c, v, 'in']); return q; },
      ilike: (c, v) => { state.filters.push([c, v, 'ilike']); return q; },
      lt: (c, v) => { state.filters.push([c, v, 'lt']); return q; },
      or: () => q,
      limit: (n) => { state.limit = n; return q; },
      maybeSingle: async () => ({ data: rows().filter(match)[0] || null, error: null }),
      then: (resolve) => resolve({ data: rows().filter(match).slice(0, state.limit || 999), error: null }),
      delete: () => ({
        in: async (c, v) => { const keep = rows().filter((r) => v.indexOf(r[c]) === -1); const n = rows().length - keep.length; db[table] = keep; return { error: null, count: n }; },
        eq: async (c, v) => { const keep = rows().filter((r) => r[c] !== v); const n = rows().length - keep.length; db[table] = keep; return { error: null, count: n }; },
        lt: async (c, v) => { const keep = rows().filter((r) => !(String(r[c]) < String(v))); const n = rows().length - keep.length; db[table] = keep; return { error: null, count: n }; }
      }),
      insert: (p) => { const items = Array.isArray(p) ? p : [p]; for (const it of items) rows().push({ ...it }); return { select: () => ({ maybeSingle: async () => ({ data: items[0] }) }) }; }
    };
    return q;
  }
  return { __db: db, __removed: removed, from: (t) => query(t), storage: { from: (bucket) => ({ remove: async (paths) => { removed.push([bucket, paths]); return { error: null }; } }) } };
}

const OLD = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
const NOW = new Date().toISOString();

console.log('--- paths ---');
const p1 = receiptStoragePaths({ media_id: 'm1' });
check(p1.indexOf('m1.jpg') !== -1 && p1.length === 3, 'a media id maps to jpg/png/webp object paths');
const p2 = receiptStoragePaths({ image_url: 'https://x.supabase.co/storage/v1/object/public/receipts/abc.jpg' });
check(p2.indexOf('abc.jpg') !== -1, 'the stored public URL resolves to its object path');

console.log('--- deleteReceipt ---');
const db1 = makeMock({ receipts: [{ id: 'r1', owner_id: 'o1', media_id: 'm1', image_url: null }] });
check((await deleteReceipt(db1, { receiptId: 'r1', ownerId: 'other' })).error === 'forbidden', 'another account cannot delete the receipt');
check(db1.__removed.length === 0, 'no bucket call on a forbidden delete');
const db2 = makeMock({ receipts: [{ id: 'r1', owner_id: 'o1', media_id: 'm1', image_url: null }] });
const del = await deleteReceipt(db2, { receiptId: 'r1', ownerId: 'o1' });
check(del.ok === true && del.objects >= 1, 'the owner deletes the receipt and its image');
check(db2.__db.receipts.length === 0, 'the receipt row is gone');
check(db2.__removed.length === 1, 'the bucket remove was called');

console.log('--- retention ---');
const db3 = makeMock({ receipts: [{ id: 'r1', media_id: 'old1', image_url: null, created_at: OLD }] });
check((await pruneOldReceipts(db3, 0)).skipped === true, 'retention 0 keeps receipts forever');
const pruned = await pruneOldReceipts(db3, 30);
check(pruned.ok === true && pruned.deleted === 1, 'a configured window prunes old receipts');
check(db3.__removed.length === 1, 'the pruned receipt image is removed');
const ocrMock = makeMock({ ocr: [{ id: 'o1', created_at: OLD }, { id: 'o2', created_at: NOW }] });
check((await pruneOcrTelemetry(ocrMock, 30)).ok === true, 'OCR telemetry prune runs');
check(ocrMock.__db.ocr_requests.length === 1, 'only the fresh telemetry row survives');

console.log('--- wipe removes images ---');
const wipeMock = makeMock({
  profiles: [{ id: 'p1', phone_number: '+254734852529' }],
  vehicles: [{ id: 'v1', owner_id: 'p1', plate_number: 'KDA 123A', vin: 'VIN1' }],
  receipts: [{ id: 'r1', owner_id: 'p1', driver_id: null, vehicle_id: 'v1', media_id: 'm9', image_url: 'https://x.supabase.co/storage/v1/object/public/receipts/m9.jpg' }]
});
const wiped = await wipeProfileForSignup(wipeMock, '0734852529');
check(wiped.ok === true, 'the wipe completes');
check(wiped.counts.storage_objects >= 1, 'the wipe reports removed receipt images');
check(wipeMock.__removed.length === 1, 'the wipe calls the bucket remove');
check(wipeMock.__db.profiles.length === 0, 'the profile is gone');

console.log('');
console.log(passed + ' document-retention assertions passed.');