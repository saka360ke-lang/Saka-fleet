import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { reconcileProfileCountries } from '../src/services/countryLock.js';

/**
 * Saka Fleet - phone-primary country reconciliation (v1.59.0)
 * -----------------------------------------------------------
 * Backfills signups that missed the country rule: profiles whose stored country
 * is missing or does not match the E.164 country code of their WhatsApp number.
 * The phone's country code is the PRIMARY determinant; an explicit user choice
 * (`country <name>`, country_source='user') is never touched.
 *
 * Safety:
 *  - idempotent (a second run changes nothing);
 *  - profiles-only (never vehicles, ledgers or billing);
 *  - every change audited as COUNTRY_RECONCILED.
 *
 * Run: npm run reconcile:country [-- --dry-run] [-- --limit=500]
 */
async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find((arg) => /^--limit=\d+$/.test(arg));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 500;
  const supabase = createClient(url, key);

  const result = await reconcileProfileCountries(supabase, { dryRun, limit });
  if (!result.ok) {
    console.error('Country reconciliation failed:', result.error);
    process.exit(1);
  }
  console.log(`Scanned ${result.scanned} profile(s); ${dryRun ? 'would patch' : 'patched'} ${result.patched}; failed ${result.failed}.`);
  if (result.samples.length) {
    for (const sample of result.samples) {
      console.log(`  ${sample.phone}: ${sample.from || 'none'} -> ${sample.to}`);
    }
  }
  process.exit(result.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Country reconciliation error:', err);
  process.exit(1);
});
