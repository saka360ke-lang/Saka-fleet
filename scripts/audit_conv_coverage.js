import { SAKA_INTENTS, SAKA_QUIZ_FLOWS, SAKA_INTENT_PLAYBOOK } from '../src/services/flowKnowledge.js';
import { CONVERSATION_CASES, SYNTHETIC_CASES } from '../src/services/convEvalCases.js';

/**
 * Saka Fleet — conversation eval coverage audit (v1.61.3)
 * ------------------------------------------------------
 * Read-only map of the eval corpus against the live registries. A flow counts
 * as covered when a case's id/tags/turns/reply names its key or trigger words.
 * Heuristic by design: the report is a gap finder, not a score.
 *
 * Run: npm run audit:conv
 */

const CASES = [...CONVERSATION_CASES, ...SYNTHETIC_CASES];

function haystackOf(caseDef = {}) {
  return [
    caseDef.id,
    ...(caseDef.tags || []),
    String(caseDef.frictionType || ''),
    ...(caseDef.turns || []).map((turn) => turn.text),
    caseDef.reply
  ].join(' ').toLowerCase();
}

function keywordsOf(flow = {}) {
  const words = new Set();
  for (const token of String(flow.key || '').split(/[_\s-]+/)) if (token.length > 3) words.add(token);
  for (const token of String(flow.trigger || '').split(/[^a-z0-9]+/i)) if (token.length > 3) words.add(token);
  return [...words];
}

function report(label, entries, keywordsOfEntry) {
  const rows = entries.map((entry) => {
    const keywords = keywordsOfEntry(entry);
    const hits = CASES.filter((caseDef) => {
      const hay = haystackOf(caseDef);
      return keywords.some((keyword) => hay.includes(String(keyword).toLowerCase()));
    });
    return { key: entry.key || entry.intent || entry.label || String(entry), hits: hits.length, examples: hits.slice(0, 3).map((caseDef) => caseDef.id) };
  });
  const covered = rows.filter((row) => row.hits > 0);
  const gaps = rows.filter((row) => row.hits === 0);
  console.log(`\n=== ${label} — ${covered.length}/${rows.length} covered ===`);
  for (const row of rows.sort((a, b) => a.hits - b.hits)) {
    console.log(`  ${row.hits > 0 ? '✅' : '❌'} ${row.key.padEnd(34)} ${String(row.hits).padStart(2)} case(s)${row.examples.length ? ` · ${row.examples.join(', ')}` : ''}`);
  }
  return { covered: covered.length, total: rows.length, gaps: gaps.map((row) => row.key) };
}

console.log('=== SAKA FLEET — CONVERSATION EVAL COVERAGE AUDIT (v1.61.3) ===');
console.log(`Corpus: ${CONVERSATION_CASES.length} hand-written + ${SYNTHETIC_CASES.length} synthetic = ${CASES.length} case(s)`);

const flows = report('QUIZ FLOWS (21)', SAKA_QUIZ_FLOWS, keywordsOf);
// Intent names are constants, not user phrases — map them through the playbook
// behaviour text so the report measures real conversational coverage.
const intents = report('INTENTS (heuristic via playbook)', SAKA_INTENT_PLAYBOOK, (row) => {
  const words = new Set(String(row.behavior || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 4));
  for (const token of String(row.intent || '').toLowerCase().split(/[_\s-]+/)) if (token.length > 3) words.add(token);
  return [...words].slice(0, 12);
});

// Cross-cutting edge classes every "unknown scenario" pass must cover.
const EDGE_CLASSES = [
  { key: 'unreadable photo / voice note', re: /unread|photo|picture|voice|ocr|image/ },
  { key: 'mixed language / Sheng / pidgin', re: /sheng|swahili|pidgin|taglish|hinglish|spanish|afrikaans/ },
  { key: 'date convention chaos', re: /dd\/mm|mm\/dd|date|expiry/ },
  { key: 'multi-vehicle ambiguity', re: /vehicle|plate|fleet|which/ },
  { key: 'OTP / verification friction', re: /otp|code|verif/ },
  { key: 'capacity / plan limits', re: /plan|capacity|upgrade|trial|limit/ },
  { key: 'restart / typos / frustration', re: /restart|frustrat|loop|typo|wrong/ },
  { key: 'document number search', re: /search|tsv|number|find/ },
  { key: 'paste / photo documents', re: /paste|licen[cs]e|document|badge|permit/ },
  { key: 'currency / units', re: /kes|ngn|zar|usd|litre|gallon|km/ }
];
const edgeRows = EDGE_CLASSES.map((entry) => {
  const hits = CASES.filter((caseDef) => entry.re.test(haystackOf(caseDef))).length;
  return { key: entry.key, hits };
});
console.log('\n=== EDGE-CLASS COVERAGE ===');
for (const row of edgeRows.sort((a, b) => a.hits - b.hits)) {
  console.log(`  ${row.hits > 0 ? '✅' : '❌'} ${row.key.padEnd(32)} ${row.hits} case(s)`);
}

const totalGaps = flows.gaps.length + intents.gaps.length;
console.log(`\nSUMMARY: flows ${flows.covered}/${flows.total} · intents ${intents.covered}/${intents.total} · edge classes ${edgeRows.filter((row) => row.hits > 0).length}/${edgeRows.length}`);
if (totalGaps) console.log(`FLOW/INTENT GAPS: ${[...flows.gaps, ...intents.gaps].join(', ')}`);
console.log('Next: generate per-flow batches with `npm run synth:cases -- --countries=KE,GLOBAL --batch=4 --edge` and curate ≥0.90 passers.');
