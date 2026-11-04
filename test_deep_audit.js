import {
  isDeepAuditEnabled, parseDeepAuditSchedule,
  lintMojibake, lintNairobiTime, lintLedgerScoping, sanitizeFinding,
  mintFindingProposal, hasRunThisWindow, recordDeepAuditRun, runDeepAudit,
  DEEP_AUDIT_CATEGORY
} from './src/services/deepAudit.js';

let pass = 0;
let failed = 0;
const check = (cond, label) => { if (cond) { pass += 1; console.log('✅', label); } else { failed += 1; console.error('❌', label); } };

// In-memory, awaitable Supabase mock — stateless (no real DB).
function makeMock() {
  const db = { remediation_proposals: [], admin_audit_logs: [], error_logs: [] };
  const builder = (table) => {
    const state = { filters: [], inserted: null };
    const chain = {
      select() { return chain; },
      eq(col, val) { state.filters.push([col, 'eq', val]); return chain; },
      in(col, vals) { state.filters.push([col, 'in', vals]); return chain; },
      like(col, pat) { state.filters.push([col, 'like', pat]); return chain; },
      gte() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      insert(rows) { state.inserted = rows; (db[table] = db[table] || []).push(...rows); return chain; },
      maybeSingle() {
        const row = state.inserted ? state.inserted[0] : null;
        return Promise.resolve({ data: row ? { proposal_code: row.proposal_code } : null, error: null });
      },
      then(resolve) {
        let rows = (db[table] || []).slice();
        for (const [col, typ, val] of state.filters) {
          if (typ === 'eq') rows = rows.filter((r) => r[col] === val);
          else if (typ === 'in') rows = rows.filter((r) => val.includes(r[col]));
          else if (typ === 'like') { const pre = String(val).replace(/%$/, ''); rows = rows.filter((r) => String(r[col] || '').startsWith(pre)); }
        }
        resolve({ data: rows, error: null });
      }
    };
    return chain;
  };
  return { db, client: { from: builder } };
}

async function run() {
  process.env.SENTINEL_DEEP_AUDIT_ENABLED = 'on';

  const sched = parseDeepAuditSchedule('Mon,Thu@03:00');
  check(sched.weekdays.has(1) && sched.weekdays.has(4) && sched.weekdays.size === 2 && sched.nairobiHour === 3, 'parses Mon,Thu@03:00');
  const bad = parseDeepAuditSchedule('nonsense');
  check(bad.weekdays.has(1) && bad.weekdays.has(4) && bad.nairobiHour === 3, 'malformed schedule falls back to Mon,Thu@03:00');

  check(isDeepAuditEnabled({}) === true, 'default enabled (on)');
  check(isDeepAuditEnabled({ SENTINEL_DEEP_AUDIT_ENABLED: 'off' }) === false, 'kill switch off');

  const moj = lintMojibake([{ path: 'x.js', text: 'const s = "\u00f0\u0178\u0161\u00a8 broken";' }]);
  check(moj.length === 1 && moj[0].severity === 'high' && moj[0].files[0] === 'x.js', 'mojibake lint catches double-encoded emoji');
  check(lintMojibake([{ path: 'y.js', text: 'const s = "🚀 fine";' }]).length === 0, 'clean source: no mojibake finding');

  const nai = lintNairobiTime([{ path: 'index.js', text: 'const h = now.getHours();' }]);
  check(nai.length === 1 && nai[0].severity === 'medium', 'nairobi lint catches now.getHours()');
  check(lintNairobiTime([{ path: 'index.js', text: 'const h = (now.getUTCHours() + 3) % 24;' }]).length === 0, 'utc + 3 is accepted');
  check(lintNairobiTime([{ path: 'index.js', text: "const w = new Date(`${d}T00:00:00Z`).getUTCDay();" }]).length === 0, 'weekday math via new Date(T00:00:00Z) is not flagged');
  check(lintNairobiTime([{ path: 'index.js', text: "q = q.gte('created_at', `${d}T00:00:00Z`);" }]).length === 1, 'UTC-midnight DB window is flagged');
  check(lintNairobiTime([{ path: 'src/services/other.js', text: 'now.getHours()' }]).length === 0, 'nairobi lint ignores non-scheduler files');

  const scoped = lintLedgerScoping([
    { path: 'src/services/entryLedger.js', text: "q = q.in('vehicle_id', scoped);" },
    { path: 'src/routes/whatsapp.js', text: 'resolveLedgerVehicleScope({}); await queryRecordLedger();' }
  ]);
  check(scoped.length === 0, 'scoped ledger passes');
  const unscoped = lintLedgerScoping([
    { path: 'src/services/entryLedger.js', text: "q = q.eq('owner_id', ownerId);" },
    { path: 'src/routes/whatsapp.js', text: 'await queryRecordLedger();' }
  ]);
  check(unscoped.length === 2, 'unscoped ledger flags both guards');

  const san = sanitizeFinding({ title: 't', slug: 's', files: ['src/services/entryLedger.js', '.env', 'paystack.js'] });
  check(san.files.length === 1 && san.files[0] === 'src/services/entryLedger.js', 'sanitizeFinding strips protected paths');
  check(sanitizeFinding({}) === null, 'sanitizeFinding rejects an empty finding');

  const m1 = makeMock();
  const finding = { slug: 'mojibake-x', severity: 'high', title: 'Mojibake in x.js', description: 'bad bytes', remediation: 're-save as UTF-8', files: ['x.js'] };
  const a = await mintFindingProposal(m1.client, { runKey: 'DEEP-AUDIT-TEST', finding });
  const b = await mintFindingProposal(m1.client, { runKey: 'DEEP-AUDIT-TEST', finding });
  check(a.ok === true && !a.duplicate && /^PROP-\d{4}-\d{2}-\d{2}-\d{2}$/.test(a.code), 'mint creates a PROP-YYYY-MM-DD-NN code');
  check(m1.db.remediation_proposals.length === 1 && m1.db.remediation_proposals[0].category === DEEP_AUDIT_CATEGORY, 'mint inserts one deep_audit_finding proposal');
  check(m1.db.remediation_proposals[0].status === 'PENDING_APPROVAL', 'minted proposal is PENDING_APPROVAL');
  check(b.ok === true && b.duplicate === true, 'second mint is deduped (same target_signature)');

  const m2 = makeMock();
  await recordDeepAuditRun(m2.client, { runKey: 'DEEP-AUDIT-2026-11-04', findings: [], summary: 'none' });
  check((await hasRunThisWindow(m2.client, 'DEEP-AUDIT-2026-11-04')) === true, 'run marker recorded (hasRunThisWindow true)');
  check((await hasRunThisWindow(m2.client, 'DEEP-AUDIT-1999-01-01')) === false, 'a different window is not marked');

  const m3 = makeMock();
  const dry = await runDeepAudit(m3.client, { dryRun: true });
  check(dry.status === 'success' && Array.isArray(dry.findingsList), 'runDeepAudit dryRun returns a success summary');
  check(m3.db.remediation_proposals.length === 0, 'dryRun mints no proposals');

  const m4 = makeMock();
  const r1 = await runDeepAudit(m4.client, {});
  check(r1.status === 'success', 'first runDeepAudit runs');
  const r2 = await runDeepAudit(m4.client, {});
  check(r2.status === 'skipped' && r2.reason === 'already_run', 'second runDeepAudit in the same window is skipped (idempotent)');
}

run().then(() => {
  console.log(`\n${failed === 0 ? '✅ ALL DEEP AUDIT TESTS PASSED' : '❌ DEEP AUDIT TESTS FAILED'} (${pass} assertions).`);
  if (failed > 0) process.exit(1);
}).catch((err) => {
  console.error('Deep audit test crashed:', err);
  process.exit(1);
});

