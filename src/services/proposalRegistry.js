import { formatNairobiDate } from './dateParser.js';

/**
 * Saka Fleet — single proposal-code sequence (v1.58.5)
 * ---------------------------------------------------
 * Every server-side proposal minting (conversation diagnosis, UPDATE-SUGGEST,
 * feature adoption, the bi-weekly deep audit) uses this helper so the
 * `PROP-YYYY-MM-DD-NN` sequence never forks. Never throws; falls back to
 * `PROP-<date>-01` if the read fails.
 */
export async function nextProposalCode(supabase, prefix = null) {
  const base = prefix || `PROP-${formatNairobiDate()}-`;
  try {
    const { data } = await supabase
      .from('remediation_proposals')
      .select('proposal_code')
      .like('proposal_code', `${base}%`);
    const numbers = (data || [])
      .map((row) => Number(String(row.proposal_code || '').replace(base, '')))
      .filter((value) => Number.isFinite(value));
    const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
    return `${base}${String(next).padStart(2, '0')}`;
  } catch {
    return `${base}01`;
  }
}

export default { nextProposalCode };
