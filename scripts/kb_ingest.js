import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  runKbIngest,
  listKbDrafts,
  getKbStaleRules,
  approveKbRule,
  rejectKbRule,
  formatKbQueueReply,
  formatKbStaleReply,
  listKbCountries
} from '../src/services/kbIngest.js';

/**
 * Saka Fleet — Country KB ingest CLI (v1.21.1)
 * --------------------------------------------
 *   npm run kb:ingest                       # dry-run all countries
 *   npm run kb:ingest -- --apply            # write DRAFT rows only
 *   npm run kb:ingest -- --countries=KE,TZ --apply
 *   npm run kb:ingest -- --review           # show the draft queue
 *   npm run kb:ingest -- --stale            # rules due for re-verification
 *   npm run kb:ingest -- --approve <uuid> [--phone +254...]
 *   npm run kb:ingest -- --reject  <uuid>
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const valueOf = (name) => {
  const prefixed = args.find((arg) => arg.startsWith(`--${name}=`));
  if (prefixed) return prefixed.split('=').slice(1).join('=');
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] || null : null;
};

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  : null;

const adminPhone = valueOf('phone') || 'CLI';

async function audit(action, details) {
  if (!supabase) return;
  try {
    await supabase.from('admin_audit_logs').insert([{ admin_phone: adminPhone, action, details }]);
  } catch { /* audit is best-effort */ }
}

async function main() {
  if (valueOf('approve')) {
    const result = await approveKbRule(supabase, valueOf('approve'), { adminPhone, audit });
    console.log(result.ok ? `✅ Approved ${result.rule.country_code} · ${result.rule.rule_key}` : `❌ ${result.error}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (valueOf('reject')) {
    const result = await rejectKbRule(supabase, valueOf('reject'), { adminPhone, audit });
    console.log(result.ok ? `🗑️ Rejected ${result.rule.country_code} · ${result.rule.rule_key}` : `❌ ${result.error}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (flag('review')) {
    const queue = await listKbDrafts(supabase, { limit: Number(valueOf('limit') || 20) });
    console.log(formatKbQueueReply(queue.rows));
    process.exit(queue.ok ? 0 : 1);
  }

  if (flag('stale')) {
    const stale = await getKbStaleRules(supabase);
    console.log(formatKbStaleReply(stale.rows));
    process.exit(stale.ok ? 0 : 1);
  }

  const countriesArg = valueOf('countries');
  const countries = countriesArg ? countriesArg.split(',').map((code) => code.trim()).filter(Boolean) : null;
  const dryRun = !flag('apply');
  console.log(`🌍 KB ingest — ${countries ? countries.join(', ') : `${listKbCountries().length} countries`} · ${dryRun ? 'DRY RUN' : 'writing drafts'}`);

  const report = await runKbIngest(supabase, { countries, dryRun });
  console.log(`Sources fetched: ${report.sources} · drafts: ${report.drafts} · skipped: ${report.skipped}`);
  for (const row of report.rows.slice(0, 20)) {
    console.log(`  • ${row.country_code} · ${row.rule_key} — ${row.summary.slice(0, 90)}`);
  }
  for (const error of report.errors.slice(0, 10)) console.log(`  ⚠️ ${error}`);
  if (!dryRun) await audit('ADMIN_KB_INGEST', { countries: countries || 'all', drafts: report.drafts });
  console.log(dryRun ? 'No rows were written (dry run).' : '✅ Drafts written — review with --review, publish with --approve.');
  process.exit(0);
}

main().catch((err) => {
  console.error('KB ingest failed:', err.message);
  process.exit(1);
});
