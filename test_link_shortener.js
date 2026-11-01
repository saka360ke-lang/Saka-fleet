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
  generateShortCode,
  shortenUrl,
  resolveShortCode,
  isShortLink,
  shortLinkBase,
  isShortLinkDomainReady
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
  check(isShortLinkDomainReady() === true, 'SHORT_LINK_DOMAIN_READY=on activates short links');

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

  console.log(`\n🎉 ${passed} link-shortener assertions passed.`);
  console.log('Stateless suite: only an in-memory mock was used; no database rows were written.');
}

run().catch((err) => {
  console.error('\n❌ Link-shortener suite failed:', err.message);
  process.exit(1);
});
