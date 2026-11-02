/**
 * Saka Fleet — refresh the landing site's displayed exchange rates (v1.46.0).
 *
 * Fetches live USD rates from open.er-api.com (the same free source the billing
 * engine reads) and applies the one-sided revenue ratchet from paystack.js, so a
 * mid-month weakening of the USD can never lower a shown local price.
 *
 * Run: node scripts/refresh_landing_rates.mjs
 * Used by .github/workflows/refresh_landing_rates.yml (monthly cron + manual).
 * Exits non-zero on a failed fetch so a stale rate can never ship silently.
 */

import fs from 'node:fs';
import { applyRateRatchet, FALLBACK_EXCHANGE_RATES } from '../src/services/paystack.js';

const DATA = 'landing/data/countries.json';

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const prevRates = data.exchangeRates || {};
  const prevUpdated = data.ratesUpdatedAt || null;

  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`rate fetch failed: HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !json.rates || !json.rates.USD) throw new Error('rate fetch returned no rates');

  const now = new Date();
  const next = {};
  for (const cur of Object.keys(FALLBACK_EXCHANGE_RATES)) {
    const live = Number(json.rates[cur]);
    const baseline = Number(prevRates[cur]);
    if (!Number.isFinite(live) || live <= 0) {
      next[cur] = Number.isFinite(baseline) && baseline > 0 ? baseline : (FALLBACK_EXCHANGE_RATES[cur] || 1.0);
      continue;
    }
    const decision = applyRateRatchet({
      baseline: Number.isFinite(baseline) && baseline > 0 ? baseline : live,
      live,
      lastReset: prevUpdated || now.toISOString(),
      now
    });
    next[cur] = Number(decision.effective.toFixed(4));
  }

  const block = `"exchangeRates": ${JSON.stringify(next)}`;
  const stamp = `"ratesUpdatedAt": "${now.toISOString().slice(0, 10)}"`;
  const out = fs.readFileSync(DATA, 'utf8')
    .replace(/"exchangeRates":\s*\{[\s\S]*?\}/, block)
    .replace(/"ratesUpdatedAt":\s*"[^"]*"/, stamp);
  fs.writeFileSync(DATA, out);
  console.log('Landing exchange rates refreshed:', JSON.stringify(next));
}

main().catch((err) => {
  console.error('Failed to refresh landing exchange rates:', err.message);
  process.exit(1);
});
