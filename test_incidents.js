import assert from 'assert';
import {
  INCIDENT_STATUS,
  INCIDENT_REOPEN_THRESHOLD,
  buildIncidentSignature,
  upsertIncident,
  isIncidentSilenced,
  countOpenIncidents,
  listIncidents,
  resolveIncident,
  suppressIncident,
  formatIncidentsReply,
  formatIncidentResolvedReply
} from './src/services/incidents.js';
import { parseSuperadminCommand } from './src/services/superadmin.js';

let passed = 0;
function check(c, m) { assert(c, m); passed += 1; console.log('  ✅ ' + m); }

function makeFakeSupabase(initial = {}) {
  const tables = { backend_incidents: [], ...initial };
  let counter = 0;
  function builder(table) {
    const state = { op: 'select', payload: null, conds: [], limit: null, single: false };
    const rows = () => tables[table] || (tables[table] = []);
    const matches = (row) => state.conds.every(([c, v]) => row[c] === v);
    const api = {
      select(cols, opts) { state.head = Boolean(opts && opts.head); return api; },
      insert(p) { state.op = 'insert'; state.payload = p; return api; },
      update(p) { state.op = 'update'; state.payload = p; return api; }, delete() { state.op = 'delete'; return api; },
      eq(c, v) { state.conds.push([c, v]); return api; }, order() { return api; },
      limit(v) { state.limit = v; return api; }, maybeSingle() { state.single = true; return api; },
      then(resolve) {
        if (state.op === 'select' && state.head) { resolve({ data: null, error: null, count: rows().filter(matches).length }); return; }
        let data = null;
        if (state.op === 'insert') { const list = Array.isArray(state.payload) ? state.payload : [state.payload]; for (const row of list) rows().push({ id: 'id-' + (++counter), ...row }); data = list; }
        else if (state.op === 'update') { const t = rows().filter(matches); for (const row of t) Object.assign(row, state.payload); data = t; }
        else { let sel = rows().filter(matches); if (state.limit) sel = sel.slice(0, state.limit); data = sel.map((r) => ({ ...r })); }
        if (state.single) data = Array.isArray(data) ? (data[0] || null) : data;
        resolve({ data, error: null });
      }
    };
    return api;
  }
  return { tables, from: builder };
}

async function run() {
  console.log('=== INCIDENT REGISTRY TESTS (v1.23.3) ===');
  const sig1 = buildIncidentSignature('TypeError at 123456 in uuid 11111111-1111-1111-1111-111111111111');
  const sig2 = buildIncidentSignature('TypeError at 998877 in uuid 22222222-2222-2222-2222-222222222222');
  check(sig1 === sig2, 'signatures ignore ids/timestamps (stable clustering)');

  const fake = makeFakeSupabase();
  const first = await upsertIncident(fake, { signature: sig1, category: 'error_log', message: 'TypeError at boot', source: 'test' });
  check(first.ok && first.created === true, 'new issue opens an incident');
  const row = fake.tables.backend_incidents[0];
  check(row.status === INCIDENT_STATUS.OPEN && row.severity === 'high', 'errors are high severity and open');

  const second = await upsertIncident(fake, { signature: sig1, category: 'error_log', message: 'TypeError again' });
  check(second.created === false && second.silenced === false, 'open incidents are updated, not silenced');
  check(fake.tables.backend_incidents[0].occurrence_count === 2, 'occurrence count increments');

  const resolved = await resolveIncident(fake, row.id, { note: 'fixed in v1.23.3', version: '1.23.3' });
  check(resolved.ok && resolved.incident.status === INCIDENT_STATUS.RESOLVED, 'incident can be resolved');
  check(await isIncidentSilenced(fake, sig1) === true, 'resolved signatures are silenced');

  const quiet1 = await upsertIncident(fake, { signature: sig1, category: 'error_log' });
  const quiet2 = await upsertIncident(fake, { signature: sig1, category: 'error_log' });
  check(quiet1.silenced && quiet2.silenced, 'post-fix recurrences stay quiet below the threshold');
  let reopened = null;
  for (let i = 0; i < INCIDENT_REOPEN_THRESHOLD && !reopened; i += 1) {
    const attempt = await upsertIncident(fake, { signature: sig1, category: 'error_log' });
    if (attempt.reopened) reopened = attempt;
  }
  check(reopened.reopened === true && fake.tables.backend_incidents[0].status === INCIDENT_STATUS.OPEN, 'a regression re-opens after the threshold');

  const other = await upsertIncident(fake, { signature: 'other-issue', category: 'conversation_stall' });
  const suppressed = await suppressIncident(fake, other.ok ? fake.tables.backend_incidents.find((r) => r.signature === 'other-issue').id : row.id);
  check(suppressed.ok, 'incident can be suppressed');
  check(await countOpenIncidents(fake) === 1, 'only open incidents are counted');
  const list = await listIncidents(fake);
  check(list.ok && list.rows.length === 1, 'list returns open incidents only');

  check(formatIncidentsReply([]).includes('No open backend issues'), 'empty reply is reassuring');
  check(formatIncidentsReply(list.rows).includes('admin incident resolve'), 'list explains how to resolve');
  check(formatIncidentResolvedReply({ status: 'suppressed', signature: sig1 }).includes('quiet'), 'suppress reply explains silence');
  check(formatIncidentResolvedReply({ status: 'resolved', signature: sig1 }).includes('will not be raised again'), 'resolve reply promises no repeats');

  check((await parseSuperadminCommand('admin incidents')).intent === 'ADMIN_INCIDENTS', 'admin incidents parses');
  const cmd = await parseSuperadminCommand('admin incident resolve 6f1f55aa-1111-2222-3333-444455556666 fixed in build');
  check(cmd.intent === 'ADMIN_INCIDENT_RESOLVE' && cmd.note === 'fixed in build', 'admin incident resolve parses id + note');
  check((await parseSuperadminCommand('admin incident suppress 6f1f55aa-1111-2222-3333-444455556666')).intent === 'ADMIN_INCIDENT_SUPPRESS', 'admin incident suppress parses');

  console.log(`\nALL INCIDENT TESTS PASSED (${passed} assertions).`);
}

run().catch((err) => { console.error(err.message); process.exit(1); });