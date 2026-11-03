#!/usr/bin/env node
/**
 * Saka Fleet — PROP-* proposal registry migration (v1.53.1, idempotent).
 *
 * Re-codes existing remediation_proposals + weekly_feature_proposals rows to
 * PROP-YYYY-MM-DD-NN (Nairobi date, one sequence across BOTH tables) and
 * stores the previous code in remediation_proposals.execution.legacy_code so
 * legacy lookups ("Status of FIX-…") can still resolve. Rows that already
 * carry a PROP- code are skipped. Safe to run repeatedly.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { formatNairobiDate } from '../src/services/dateParser.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const prefix = `PROP-${formatNairobiDate()}-`;
  let sequence = 0;
  let renamed = 0;

  const { data: fixRows, error: fixErr } = await supabase
    .from('remediation_proposals')
    .select('id,proposal_code,execution')
    .order('created_at', { ascending: true });
  if (fixErr) throw new Error(`read remediation_proposals failed: ${fixErr.message}`);

  for (const row of fixRows || []) {
    if (/^PROP-/.test(String(row.proposal_code || ''))) continue;
    sequence += 1;
    const newCode = `${prefix}${String(sequence).padStart(2, '0')}`;
    const execution = { ...(row.execution || {}), legacy_code: row.proposal_code };
    const { error: upErr } = await supabase
      .from('remediation_proposals')
      .update({ proposal_code: newCode, execution })
      .eq('id', row.id);
    if (upErr) console.warn(`⚠️ rename ${row.proposal_code} failed: ${upErr.message}`);
    else { renamed += 1; console.log(`remediation: ${row.proposal_code} → ${newCode}`); }
  }

  const { data: featRows, error: featErr } = await supabase
    .from('weekly_feature_proposals')
    .select('id,proposal_code')
    .order('created_at', { ascending: true });
  if (featErr) throw new Error(`read weekly_feature_proposals failed: ${featErr.message}`);

  for (const row of featRows || []) {
    if (/^PROP-/.test(String(row.proposal_code || ''))) continue;
    sequence += 1;
    const newCode = `${prefix}${String(sequence).padStart(2, '0')}`;
    const { error: upErr } = await supabase
      .from('weekly_feature_proposals')
      .update({ proposal_code: newCode })
      .eq('id', row.id);
    if (upErr) console.warn(`⚠️ rename ${row.proposal_code} failed: ${upErr.message}`);
    else { renamed += 1; console.log(`feature: ${row.proposal_code} → ${newCode}`); }
  }

  console.log(`✅ PROP-* migration complete: ${renamed} row(s) renamed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ PROP-* migration failed:', err.message);
  process.exit(1);
});
