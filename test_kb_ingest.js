import assert from 'assert';
import PDFDocument from 'pdfkit';
import {
  isAllowedSourceUrl,
  stripHtmlToText,
  fetchSourceDocument,
  buildDraftRules,
  runKbIngest,
  listKbDrafts,
  approveKbRule,
  rejectKbRule,
  getKbStaleRules,
  formatKbQueueReply,
  formatKbStaleReply,
  listKbCountries,
  getKbLegislation,
  collectCountrySources
} from './src/services/kbIngest.js';
import { parseSuperadminCommand } from './src/services/superadmin.js';

/**
 * Saka Fleet — Country KB ingest & review suite (v1.21.1).
 * Stateless: fetch + database are mocked; PDFs are generated in memory.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

// Minimal in-memory Supabase-compatible builder.
function makeFakeSupabase(initial = {}) {
  const tables = { country_kb: [], admin_audit_logs: [], ...initial };
  let counter = 0;

  function builder(table) {
    const state = { op: 'select', payload: null, conds: [], limit: null, single: false };
    const rows = () => tables[table] || (tables[table] = []);
    const matches = (row) => state.conds.every(([column, value]) => row[column] === value);

    const api = {
      select() { return api; },
      insert(payload) { state.op = 'insert'; state.payload = payload; return api; },
      update(payload) { state.op = 'update'; state.payload = payload; return api; },
      delete() { state.op = 'delete'; return api; },
      eq(column, value) { state.conds.push([column, value]); return api; },
      order() { return api; },
      limit(value) { state.limit = value; return api; },
      maybeSingle() { state.single = true; return api; },
      then(resolve, reject) {
        try {
          let data = null;
          if (state.op === 'insert') {
            const rowsIn = Array.isArray(state.payload) ? state.payload : [state.payload];
            for (const row of rowsIn) rows().push({ id: `id-${++counter}`, ...row });
            data = rowsIn.map((row) => ({ id: `id-${counter}`, ...row }));
          } else if (state.op === 'update') {
            const targets = rows().filter(matches);
            for (const row of targets) Object.assign(row, state.payload);
            data = targets;
          } else if (state.op === 'delete') {
            const keep = rows().filter((row) => !matches(row));
            const removed = rows().filter(matches);
            tables[table] = keep;
            data = removed;
          } else {
            let selected = rows().filter(matches);
            if (state.limit) selected = selected.slice(0, state.limit);
            data = selected.map((row) => ({ ...row }));
          }
          if (state.single) data = Array.isArray(data) ? (data[0] || null) : data;
          resolve({ data, error: null });
        } catch (err) {
          if (reject) reject(err); else resolve({ data: null, error: { message: err.message } });
        }
      }
    };
    return api;
  }

  return { tables, from: builder };
}

function buildPdf(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    lines.forEach((line) => doc.fontSize(11).text(line));
    doc.end();
  });
}

const realFetch = global.fetch;

async function run() {
  console.log('=== SAKA FLEET — COUNTRY KB INGEST TESTS (v1.21.1) ===\n');

  console.log('--- Test 1: official-source allow-list ---');
  check(listKbCountries().includes('KE'), 'the registry covers Kenya');
  check(isAllowedSourceUrl('https://www.ntsa.go.ke/') === true, 'official HTTPS sources are allowed');
  check(isAllowedSourceUrl('https://sub.ntsa.go.ke/page') === true, 'official subdomains are allowed');
  check(isAllowedSourceUrl('http://www.ntsa.go.ke/') === false, 'plain HTTP is rejected');
  check(isAllowedSourceUrl('https://ntsa.go.ke.evil.example/') === false, 'look-alike domains are rejected');
  check(isAllowedSourceUrl('https://random-blog.example/') === false, 'unofficial sources are rejected');

  console.log('\n--- Test 2: HTML → text ---');
  const html = '<html><head><style>.x{}</style><script>alert(1)</script></head><body><h1>Insurance</h1><p>Third&nbsp;party insurance is required.</p></body></html>';
  const stripped = stripHtmlToText(html);
  check(!/script|style|alert/i.test(stripped), 'scripts and styles are removed');
  check(stripped.includes('Third party insurance'), 'entities decode and tags collapse');

  console.log('\n--- Test 3: fetching official documents ---');
  let called = false;
  global.fetch = async () => { called = true; return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }); };
  const blocked = await fetchSourceDocument('https://random-blog.example/');
  check(blocked.text === null && /allow-list/i.test(blocked.error) && called === false, 'blocked sources are never fetched');

  global.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const page = await fetchSourceDocument('https://www.ntsa.go.ke/');
  check(page.error === null && page.text.includes('insurance'), 'official HTML pages return text');

  const pdf = await buildPdf(['Motor insurance is mandatory.', 'Driving licence renewals are annual.']);
  global.fetch = async () => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
  const pdfSource = await fetchSourceDocument('https://www.ntsa.go.ke/guide.pdf');
  check(pdfSource.error === null && /insurance/i.test(pdfSource.text), 'official PDF sources are read by the extractor');

  console.log('\n--- Test 4: draft rules are never live ---');
  const sourceText = 'Motor insurance is mandatory for every vehicle. The policy must be renewed annually. '
    + 'Annual inspection is required for roadworthiness. A valid driving licence is required for the vehicle class. '
    + 'Road tax must be paid each year. Speed limiter certificates apply to buses and heavy vehicles.';
  const drafts = buildDraftRules({
    countryCode: 'KE',
    authority: 'NTSA',
    sourceUrl: 'https://www.ntsa.go.ke/',
    text: sourceText
  });
  check(drafts.length >= 4, 'multiple rules are drafted from one page');
  check(drafts.every((row) => row.is_active === false), 'drafts are inactive until approved');
  check(drafts.every((row) => row.verified_at === null), 'drafts carry no verification date');
  check(drafts.every((row) => row.curated_by === 'ingest-draft'), 'drafts are labelled as ingest drafts');
  check(drafts.every((row) => row.source_urls?.[0] === 'https://www.ntsa.go.ke/'), 'drafts keep their official source URL');
  check(drafts.some((row) => row.rule_key === 'vehicle_insurance' && /insurance/i.test(row.summary)), 'insurance draft carries a real summary sentence');
  check(drafts.some((row) => row.rule_key === 'driver_licence' && row.category === 'driver_compliance'), 'driver rules stay in the driver lane');
  check(buildDraftRules({ countryCode: 'KE', text: 'Nothing relevant here.' }).length === 0, 'pages without rules produce no drafts');

  console.log('\n--- Test 5: ingest run (dry run vs apply) ---');
  const fake = makeFakeSupabase();
  const fakeFetch = async () => ({ text: sourceText, contentType: 'text/html', error: null });
  const dry = await runKbIngest(null, { countries: ['KE'], dryRun: true, fetchImpl: fakeFetch });
  check(dry.drafts >= 4 && dry.rows.every((row) => row.country_code === 'KE'), 'dry run reports the drafts');
  check((fake.tables.country_kb || []).length === 0, 'dry run writes nothing');

  const applied = await runKbIngest(fake, { countries: ['KE'], dryRun: false, fetchImpl: fakeFetch });
  check(applied.drafts >= 4 && fake.tables.country_kb.length === applied.drafts, 'apply writes draft rows');
  check(fake.tables.country_kb.every((row) => row.is_active === false), 'applied drafts remain inactive');

  fake.tables.country_kb.push({
    id: 'active-1', country_code: 'KE', rule_key: 'vehicle_insurance',
    title: 'Motor insurance', summary: 'Human-approved rule', is_active: true, verified_at: '2026-10-01'
  });
  const rerun = await runKbIngest(fake, { countries: ['KE'], dryRun: false, fetchImpl: fakeFetch });
  const activeRow = fake.tables.country_kb.find((row) => row.id === 'active-1');
  check(rerun.drafts >= 4 && activeRow.summary === 'Human-approved rule', 'approved rules are never overwritten by ingest');

  console.log('\n--- Test 6: review, approve & reject ---');
  const queue = await listKbDrafts(fake, { limit: 20 });
  check(queue.ok && queue.rows.length >= 4, 'the draft queue lists pending rules');
  const target = queue.rows.find((row) => row.rule_key === 'driver_licence');
  const audits = [];
  const approved = await approveKbRule(fake, target.id, {
    adminPhone: '+254720641985',
    audit: async (phone, action, details) => audits.push({ phone, action, details })
  });
  check(approved.ok && approved.rule.verified_at, 'approval stamps a verified date');
  check(fake.tables.country_kb.find((row) => row.id === target.id).is_active === true, 'approval activates the rule');
  check(audits[0]?.action === 'ADMIN_KB_APPROVE', 'approval is audit-logged');
  const reactivate = await approveKbRule(fake, target.id);
  check(reactivate.ok === false && /already active/i.test(reactivate.error), 'already-active rules cannot be re-approved');

  const rejectTarget = queue.rows.find((row) => row.rule_key === 'road_tax');
  const rejected = await rejectKbRule(fake, rejectTarget.id, { audit: async (p, a) => audits.push({ phone: p, action: a }) });
  check(rejected.ok && !fake.tables.country_kb.some((row) => row.id === rejectTarget.id), 'reject removes the draft');
  check(audits.some((entry) => entry.action === 'ADMIN_KB_REJECT'), 'rejection is audit-logged');
  const rejectActive = await rejectKbRule(fake, target.id);
  check(rejectActive.ok === false && /active rules/i.test(rejectActive.error), 'active rules cannot be deleted');


  console.log('\n--- Test 7: freshness sweep ---');
  const oldDate = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  fake.tables.country_kb.push(
    { id: 'stale-1', country_code: 'KE', rule_key: 'vehicle_inspection', title: 'Inspection', is_active: true, verified_at: oldDate },
    { id: 'fresh-1', country_code: 'KE', rule_key: 'vehicle_insurance', title: 'Insurance', is_active: true, verified_at: new Date().toISOString().slice(0, 10) }
  );
  const stale = await getKbStaleRules(fake);
  check(stale.ok && stale.rows.some((row) => row.id === 'stale-1'), 'rules older than the review window are flagged');
  check(!stale.rows.some((row) => row.id === 'fresh-1'), 'freshly verified rules are not flagged');
  check(formatKbStaleReply(stale.rows).includes('Inspection'), 'the stale digest names the rule');
  check(formatKbQueueReply(queue.rows).includes('approve'), 'the queue reply explains how to approve');

  console.log('\n--- Test 8: superadmin commands ---');
  check((await parseSuperadminCommand('admin kb')).intent === 'ADMIN_KB', '"admin kb" opens the queue');
  check((await parseSuperadminCommand('admin kb review')).intent === 'ADMIN_KB_REVIEW', '"admin kb review" lists drafts');
  check((await parseSuperadminCommand('admin kb stale')).intent === 'ADMIN_KB_STALE', '"admin kb stale" runs the freshness digest');
  const approveCmd = await parseSuperadminCommand('admin kb approve 6f1f55aa-1111-2222-3333-444455556666');
  check(approveCmd.intent === 'ADMIN_KB_APPROVE' && approveCmd.rule_id.startsWith('6f1f55aa'), 'approval parses the rule id');
  const rejectCmd = await parseSuperadminCommand('admin kb reject 6f1f55aa-1111-2222-3333-444455556666');
  check(rejectCmd.intent === 'ADMIN_KB_REJECT', 'rejection parses the rule id');
  check((await parseSuperadminCommand('admin kb approve not-a-uuid')).intent === 'ADMIN_KB', 'invalid ids fall back to the queue (never a blind write)');

  console.log('\n--- Test 9: traffic-act legislation deep-links ---');
  const keLaw = getKbLegislation('KE');
  check(keLaw.verified.some((row) => /Traffic Act \(Cap 403\)/.test(row.law_name)), 'Kenya traffic act is a verified source');
  check(keLaw.verified[0].url.includes('kenyalaw.org'), 'the Kenya link points at the official law site');
  const tzLaw = getKbLegislation('TZ');
  check(tzLaw.pending.length > 0 && tzLaw.verified.length === 0, 'Tanzania ships as pending (law name only, no guessed URL)');
  check(collectCountrySources({ legislation: [{ label: 'x', law_name: 'Law X', url: 'https://www.legislation.gov.uk/x', status: 'verified' }], sources: [{ label: 'y', url: 'https://www.gov.uk/y' }] })
    .map((row) => row.kind).join(',') === 'legislation,authority', 'legislation is fetched before authority pages');

  const lawDrafts = buildDraftRules({
    countryCode: 'GB',
    authority: 'DVLA / DVSA',
    sourceUrl: 'https://www.legislation.gov.uk/ukpga/1988/52/contents',
    text: 'Motor insurance is mandatory for every vehicle. Annual inspection is required for roadworthiness. A valid driving licence is required for the vehicle class.',
    lawReference: 'Road Traffic Act 1988 (c. 52)'
  });
  check(lawDrafts.every((row) => row.law_reference === 'Road Traffic Act 1988 (c. 52)'), 'legislation drafts inherit the exact law reference');
  check(lawDrafts.some((row) => row.rule_key === 'vehicle_insurance'), 'legislation text produces real rule drafts');

  const fetchedUrls = [];
  const pendingReport = await runKbIngest(null, {
    countries: ['TZ'],
    dryRun: true,
    fetchImpl: async (url) => { fetchedUrls.push(url); return { text: sourceText, contentType: 'text/html', error: null }; }
  });
  check(!fetchedUrls.some((url) => url.includes('null')), 'pending legislation is never fetched');
  check(pendingReport.pendingLegislation.some((row) => row.country_code === 'TZ' && /Cap 168/.test(row.law_name)), 'the ingest report lists pending legislation by law name');


  global.fetch = realFetch;
  console.log(`\n🎉 ALL COUNTRY KB INGEST TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: sources and database are mocked, so no cleanup is required.');
}

run().catch((err) => {
  global.fetch = realFetch;
  console.error(err.message);
  process.exit(1);
});

