/**
 * Saka Fleet — Link Shortener tests (v1.32.0, stateless)
 * -----------------------------------------------------
 * Proves long user-facing links become branded short links, codes are reused,
 * resolution round-trips, expired codes fail closed and every failure returns
 * the ORIGINAL url (a message must never lose its link).
 *
 * Run: node test_link_shortener.js
 */

import assert from 'assert';
import {
  SHORT_CODE_LENGTH,
  SHORT_LINK_TTL_DAYS,
  SHORT_LINK_PROBE_PATH,
  SHORT_LINK_PROBE_TAG,
  generateShortCode,
  shortenUrl,
  resolveShortCode,
  isShortLink,
  shortLinkBase,
  shortLinkProbeUrl,
  shortLinkProbeEnabled,
  shortLinkStatus,
  shortLinkNotFoundHtml,
  isShortLinkDomainReady,
  verifyShortLinkRoute,
  shortLinkReady
} from './src/services/linkShortener.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const LONG_URL = 'https://wnvbhpykboonygaznhhl.supabase.co/storage/v1/object/sign/fleet-reports/report-Saka_financial_KAS_628T-1793505100043.pdf?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTM1MTIzNDV9.signature';
const PAYSTACK_URL = 'https://checkout.paystack.com/abc123xyz?reference=T1793505100&currency=KES&plan=PLN_solo_pro_annual&callback_url=https%3A%2F%2Fsakafleet.com%2Fpayment-success';

function createMockSupabase(seed = [], options = {}) {
  const table = seed.map((row) => ({ ...row }));
  const state = { inserts: 0, failInsert: Boolean(options.failInsert) };

  function builder() {
    const filters = [];
    let limitN = null;
    let orderSpec = null;
    const match = (row) => filters.every((filter) => {
      if (filter.op === 'eq') return row[filter.col] === filter.val;
      if (filter.op === 'lt') return String(row[filter.col] || '') < String(filter.val || '');
      return true;
    });
    const run = () => {
      let rows = table.filter(match);
      if (orderSpec) {
        const { col, ascending } = orderSpec;
        rows = [...rows].sort((a, b) => (String(a[col] || '') < String(b[col] || '') ? -1 : 1) * (ascending ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: rows.map((row) => ({ ...row })), error: null };
    };
    const api = {
      select() { return api; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return api; },
      lt(col, val) { filters.push({ op: 'lt', col, val }); return api; },
      order(col, { ascending = true } = {}) { orderSpec = { col, ascending }; return api; },
      limit(n) { limitN = n; return api; },
      maybeSingle() { const out = run(); return Promise.resolve({ data: out.data[0] || null, error: null }); },
      insert(rows) {
        state.inserts += 1;
        if (state.failInsert) return Promise.resolve({ error: { message: 'simulated storage outage' } });
        for (const row of rows) {
          if (table.some((existing) => existing.code === row.code)) {
            return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } });
          }
          table.push({ code: row.code, url: row.url, created_at: new Date().toISOString(), expires_at: row.expires_at || null });
        }
        return Promise.resolve({ error: null });
      },
      delete() {
        return {
          lt(col, val) {
            for (let i = table.length - 1; i >= 0; i -= 1) {
              if (table[i][col] && String(table[i][col]) < String(val)) table.splice(i, 1);
            }
            return Promise.resolve({ error: null });
          }
        };
      },
      then(resolve) { return resolve(run()); }
    };
    return api;
  }

  return { table, state, client: { from: () => builder() } };
}

async function run() {
  console.log('=== SAKA FLEET — LINK SHORTENER (v1.32.0) ===\n');

  console.log('--- Test 1: codes + base ---');
  const code = generateShortCode();
  check(code.length === SHORT_CODE_LENGTH, `Codes are ${SHORT_CODE_LENGTH} characters`);
  check(/^[a-zA-Z0-9]+$/.test(code), 'Codes are URL-safe alphanumerics');
  check(new Set(Array.from({ length: 40 }, () => generateShortCode())).size > 30, 'Codes are collision-resistant in practice');
  check(shortLinkBase() === 'https://app.sakafleet.com', 'Default base is the app.sakafleet.com custom domain');
  check(isShortLink('https://app.sakafleet.com/r/abcd1234'), 'Branded short links are recognised');
  check(!isShortLink(LONG_URL), 'Long provider URLs are not short links');

  console.log('\n--- Test 1b: domain readiness gate (v1.32.2) ---');
  delete process.env.SHORT_LINK_DOMAIN_READY;
  check(isShortLinkDomainReady() === false, 'Short links are OFF until the branded domain is verified');
  const gated = await shortenUrl(createMockSupabase().client, LONG_URL);
  check(gated === LONG_URL, 'While the gate is off, the original working URL is sent (never a dead link)');
  process.env.SHORT_LINK_DOMAIN_READY = 'on';
  // v1.32.4 — the readiness probe needs a network round-trip; the stateless
  // suite pins it off so the shortening contract itself is what gets tested.
  process.env.SHORT_LINK_PROBE = 'off';
  check(isShortLinkDomainReady() === true, 'SHORT_LINK_DOMAIN_READY=on activates short links');
  check(shortLinkProbeEnabled() === false, 'SHORT_LINK_PROBE=off disables the network probe');

  console.log('\n--- Test 2: shortening long links ---');
  const mock = createMockSupabase();
  const shortPdf = await shortenUrl(mock.client, LONG_URL);
  check(shortPdf.startsWith('https://app.sakafleet.com/r/'), 'PDF storage URL becomes a branded short link');
  check(shortPdf.length < 60, `Short link is compact (${shortPdf.length} chars vs ${LONG_URL.length})`);
  check(mock.table.length === 1 && mock.table[0].url === LONG_URL, 'The original URL is stored for the redirect');
  const ttlDays = (new Date(mock.table[0].expires_at).getTime() - Date.now()) / 86400000;
  check(ttlDays > SHORT_LINK_TTL_DAYS - 1 && ttlDays <= SHORT_LINK_TTL_DAYS, 'Links carry the 90-day TTL');

  const shortPaystack = await shortenUrl(mock.client, PAYSTACK_URL);
  check(shortPaystack.startsWith('https://app.sakafleet.com/r/'), 'Paystack checkout URLs are shortened too');
  check(mock.table.length === 2, 'Each distinct URL gets its own code');

  console.log('\n--- Test 3: reuse + pass-through ---');
  const reused = await shortenUrl(mock.client, LONG_URL);
  check(reused === shortPdf, 'The same URL reuses the same short code');
  check(mock.table.length === 2, 'Reuse does not create duplicate rows');
  check(await shortenUrl(mock.client, 'https://sakafleet.com/pricing') === 'https://sakafleet.com/pricing', 'Already-short pricing links pass through');
  check(await shortenUrl(mock.client, shortPdf) === shortPdf, 'Existing short links are never double-shortened');
  check(await shortenUrl(mock.client, 'not-a-url') === 'not-a-url', 'Non-URL text passes through untouched');
  check(await shortenUrl(mock.client, null) === null, 'Nullish links pass through untouched');

  console.log('\n--- Test 4: resolution round-trip ---');
  const resolved = await resolveShortCode(mock.client, shortPdf.split('/r/')[1]);
  check(resolved === LONG_URL, 'resolveShortCode returns the original URL');
  check(await resolveShortCode(mock.client, 'unknown1') === null, 'Unknown codes resolve to null');
  mock.table.push({ code: 'expired1', url: 'https://example.com/old', expires_at: new Date(Date.now() - 86400000).toISOString() });
  check(await resolveShortCode(mock.client, 'expired1') === null, 'Expired codes fail closed');

  console.log('\n--- Test 5: fail-soft guarantees ---');
  check(await shortenUrl(null, LONG_URL) === LONG_URL, 'No database → the original link survives');
  const broken = createMockSupabase([], { failInsert: true });
  const fallback = await shortenUrl(broken.client, LONG_URL);
  check(fallback === LONG_URL, 'Insert failure → the original link survives (never throws)');
  check(await resolveShortCode(null, 'abc') === null, 'Resolution without a database returns null');

  console.log('\n--- Test 6: PUBLIC_APP_URL override ---');
  const previousBase = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = 'https://short.test/';
  const custom = await shortenUrl(createMockSupabase().client, LONG_URL);
  check(custom.startsWith('https://short.test/r/'), 'PUBLIC_APP_URL overrides the branded base');
  if (previousBase === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = previousBase;
  delete process.env.SHORT_LINK_DOMAIN_READY;

  delete process.env.SHORT_LINK_DOMAIN_READY;

  console.log('\n--- Test 7: self-verifying probe route (v1.32.4) ---');
  const probeBase = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = 'https://probe.test';
  delete process.env.SHORT_LINK_DOMAIN_READY;
  delete process.env.SHORT_LINK_PROBE;
  check(shortLinkProbeUrl() === 'https://probe.test/r/__saka_probe__', 'The probe URL is built on the branded base');
  check(SHORT_LINK_PROBE_PATH === '/r/__saka_probe__' && SHORT_LINK_PROBE_TAG === 'saka-shortlink', 'Probe path + header tag are a stable contract');

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const stubFetch = (impl) => {
    fetchCalls = 0;
    globalThis.fetch = async (...args) => {
      fetchCalls += 1;
      return impl(...args);
    };
  };
  try {
    stubFetch(async () => ({ status: 200, headers: { get: (name) => (String(name).toLowerCase() === 'x-saka-shortlink' ? 'saka-shortlink' : null) } }));
    const verified = await verifyShortLinkRoute({ force: true });
    check(verified.ready === true && verified.reason === 'verified', '200 + x-saka-shortlink means the base really serves short links');
    check(fetchCalls === 1, 'The probe hits the network exactly once');
    const cachedProbe = await verifyShortLinkRoute();
    check(cachedProbe.ready === true && fetchCalls === 1, 'The verdict is cached (no second request)');

    stubFetch(async () => ({ status: 302, headers: { get: () => null } }));
    const bounced = await verifyShortLinkRoute({ force: true });
    check(bounced.ready === false && bounced.reason === 'probe-mismatch', 'The 302-to-marketing incident is detected as NOT ready');
    check((await shortLinkReady()).ready === false, 'An unverified base never yields a short link');
    check(await shortenUrl(createMockSupabase().client, LONG_URL) === LONG_URL, 'Unverified base means the original working URL is delivered');

    stubFetch(async () => { throw new Error('getaddrinfo ENOTFOUND probe.test'); });
    const dead = await verifyShortLinkRoute({ force: true });
    check(dead.ready === false && /probe-error/.test(dead.reason), 'A probe network failure fails soft (never throws)');
    const snapshot = shortLinkStatus();
    check(snapshot.base === 'https://probe.test' && snapshot.ready === false && Boolean(snapshot.checkedAt), 'shortLinkStatus exposes base/ready/checkedAt for /internal/status');

    stubFetch(async () => ({ status: 200, headers: { get: () => null } }));
    check((await verifyShortLinkRoute({ force: true })).ready === false, 'A 200 without the tag is never trusted');

    process.env.SHORT_LINK_PROBE = 'off';
    const bypass = await verifyShortLinkRoute({ force: true });
    check(bypass.ready === true && bypass.reason === 'probe-disabled', 'SHORT_LINK_PROBE=off trusts an explicit operator signal');
    delete process.env.SHORT_LINK_PROBE;
  } finally {
    globalThis.fetch = originalFetch;
    if (probeBase === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = probeBase;
    delete process.env.SHORT_LINK_DOMAIN_READY;
  }

  const notFound = shortLinkNotFoundHtml({ pricingUrl: 'https://sakafleet.com/pricing' });
  check(/link has expired or does not exist/i.test(notFound), 'Unknown/expired codes get an honest 404 page');
  check(notFound.includes('https://sakafleet.com/pricing'), 'The 404 page links back to pricing');
  check(notFound.includes('90 days'), 'The 404 page explains the 90-day link lifetime');
  check(!/http-equiv="refresh"/i.test(notFound), 'The 404 page never bounces the user silently');

  console.log(`\n🎉 ${passed} link-shortener assertions passed.`);
  console.log('Stateless suite: only an in-memory mock was used; no database rows were written.');
}

run().catch((err) => {
  console.error('\n❌ Link-shortener suite failed:', err.message);
  process.exit(1);
});
