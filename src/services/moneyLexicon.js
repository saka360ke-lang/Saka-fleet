/**
 * Saka Fleet — Money Lexicon (v1.34.0)
 * ------------------------------------
 * People never type amounts the way a form expects them:
 *
 *   "50 bob", "6k", "1.5m", "KES 1,500", "1,500/-", "shs 2500",
 *   "@227kes per liter", "40L", "50350 km", "cost me 12,500 altogether"
 *
 * This module is the ONE place that turns those shapes into numbers. It is
 * deliberately paranoid, because money is the field a model must never guess:
 *
 *   1. **Unit-suffixed numbers are never money** — 40L, 50350 km, 12%, 3 kwh.
 *   2. **Per-unit prices are never the total** — "@227kes per liter" is a price,
 *      not what the user spent; the spend is the other number.
 *   3. **Bare 6+ digit integers are never money without a currency marker** —
 *      that is an odometer reading far more often than a price.
 *   4. **Two unrelated amounts are never summed silently** — without an additive
 *      word ("plus", "and", "altogether") the story is ambiguous and the caller
 *      must ask. Nothing is invented.
 *
 * Contract: pure, deterministic, never throws, zero AI tokens.
 */

/** Currency words/phrases → ISO code. Global audience (rule 7). */
const CURRENCY_WORDS = Object.freeze({
  kes: 'KES', ksh: 'KES', kshs: 'KES', sh: 'KES', shs: 'KES',
  shilling: 'KES', shillings: 'KES', bob: 'KES',
  tzs: 'TZS', tsh: 'TZS', tshs: 'TZS',
  ugx: 'UGX', ush: 'UGX',
  ngn: 'NGN', naira: 'NGN', nairas: 'NGN',
  zar: 'ZAR', rand: 'ZAR',
  ghs: 'GHS', cedi: 'GHS', cedis: 'GHS',
  usd: 'USD', dollar: 'USD', dollars: 'USD', buck: 'USD', bucks: 'USD',
  eur: 'EUR', euro: 'EUR', euros: 'EUR',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP', quid: 'GBP',
  inr: 'INR', rupee: 'INR', rupees: 'INR',
  aed: 'AED', dirham: 'AED', dirhams: 'AED',
  egp: 'EGP', cfa: 'XOF', franc: 'XOF', francs: 'XOF'
});

const CURRENCY_SYMBOLS = Object.freeze({
  $: 'USD', '€': 'EUR', '£': 'GBP', '₦': 'NGN', '₹': 'INR'
});

const CURRENCY_WORD_LIST = Object.keys(CURRENCY_WORDS).filter((word) => /^[a-z]+$/.test(word));
// Word boundaries matter: "braKES", "SHell" and "bob" inside another word must
// never register as a currency marker.
const CURRENCY_PATTERN = `(?:(?<![a-z])(?:${CURRENCY_WORD_LIST.join('|')})(?![a-z])|[$€£₦₹])`;

/** Scale suffixes: 6k → 6000, 1.5m → 1500000, 2 million → 2000000. */
const SCALES = Object.freeze({
  k: 1000, thousand: 1000, kt: 1000,
  m: 1000000, mil: 1000000, million: 1000000, mn: 1000000
});

/** Words that make several amounts ONE total. */
const ADDITIVE_RE = /\b(?:plus|\+|and|together|combined|altogether|in total|as well as)\b/i;
/** Words that point at the total itself. */
const TOTAL_RE = /\b(?:total|altogether|in all|all together|combined|grand total|overall|sum)\b/i;

/** Units that prove a number is a measurement, never money. */
const UNIT_TAIL_RE = /^\s*(?:l|lt|ltr|ltrs|litres?|liters?|gal|gals|gallons?|ml|km|kms|kilometres?|kilometers?|mi|miles?|m|metres?|meters?|%|kwh|kw|hrs?|hours?)\b/i;
/** Per-unit price context ("@227 per litre", "227/litre"). */
const UNIT_PRICE_TAIL_RE = /^\s*(?:\/|per|a)\s*(?:l|lt|ltr|litres?|liters?|gal|gallons?|km|kms|mile|miles?|hour|hr|day)\b/i;
const AT_MARKER_RE = /@\s*$/;

/**
 * Date/time shapes are blanked out (same length, so indexes stay valid) before
 * scanning: "28/10/2026", "2026-10-28", "15 Oct 2026", "19:45" are never money.
 */
const DATE_MASK_PATTERNS = Object.freeze([
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  /\b\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  // v1.96.2 — bare ordinals are calendar words, never money. Live 2026-11-10:
  // "Paid 300 parking ... on 7th, 8th and 9th of November 2026" was summed to
  // KES 315 (300 + 7 + 8) because "7th"/"8th" survived the date mask and the
  // "and" was read as additive.
  /\b\d{1,2}(?:st|nd|rd|th)\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{0,4}\b/gi,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,?\s*\d{4})?\b/gi,
  /\b(?:in|of|since|year)\s+(?:19|20)\d{2}\b/gi,
  /\b(?:19|20)\d{2}\s+(?:model|year)\b/gi
]);

function maskDateShapes(text) {
  let masked = String(text || '');
  for (const pattern of DATE_MASK_PATTERNS) {
    masked = masked.replace(pattern, (match) => ' '.repeat(match.length));
  }
  return masked;
}

/** Words that make a bare 4-digit number a spend rather than a model year. */
const MONEY_VERB_RE = /\b(?:paid|pay|spent|spend|cost|costs|charged|charge|fare|fares|bought|buy)\b/i;
/** Nouns that sit right next to an amount ("fuel 2000", "service 4500"). */
const MONEY_NOUN_RE = /(?:fuel|diesel|petrol|refuel|service|part|parts|repair|repairs|wash|parking|fine|fares?|tyres?|tires?|oil|labour|labor|towing|insurance|deposit|fee|fees|bill|price|amount|permit|licen[cs]e|salary|wages?)\s*$/i;

function looksLikeMoneyContext(text, index) {
  const head = String(text || '').slice(Math.max(0, index - 40), index);
  return MONEY_VERB_RE.test(head) || MONEY_NOUN_RE.test(head);
}

const LABEL_STOPWORDS = new Set([
  'i', 'we', 'you', 'it', 'a', 'an', 'the', 'for', 'on', 'at', 'to', 'of', 'and', 'with',
  'paid', 'pay', 'spent', 'spend', 'cost', 'costs', 'was', 'were', 'is', 'are', 'then',
  'today', 'yesterday', 'last', 'this', 'morning', 'evening', 'night', 'about', 'around',
  'roughly', 'exactly', 'only', 'just', 'altogether', 'total', 'plus', 'in', 'from',
  'my', 'our', 'his', 'her', 'their', 'also', 'so', 'but', 'that', 'car', 'vehicle'
]);

function cleanNumber(raw) {
  const withoutGrouping = String(raw || '').replace(/,/g, '');
  const n = Number(withoutGrouping);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/** Currency mentioned in a fragment (ISO code) or null. */
export function detectCurrencyMarker(text = '') {
  const clean = String(text || '').toLowerCase();
  if (!clean) return null;
  for (const symbol of Object.keys(CURRENCY_SYMBOLS)) {
    if (clean.includes(symbol)) return CURRENCY_SYMBOLS[symbol];
  }
  const wordMatch = clean.match(new RegExp(`(?:^|[^a-z])(${CURRENCY_WORD_LIST.join('|')})(?:$|[^a-z])`, 'i'));
  if (wordMatch) return CURRENCY_WORDS[wordMatch[1].toLowerCase()] || null;
  return null;
}

/** Words that describe what the money was for, nearest first (max 3). */
function labelBefore(text, index) {
  const head = String(text || '').slice(0, index);
  const words = head.split(/[^A-Za-z]+/).filter(Boolean);
  const kept = [];
  for (let i = words.length - 1; i >= 0 && kept.length < 3; i -= 1) {
    const word = words[i].toLowerCase();
    if (LABEL_STOPWORDS.has(word) || CURRENCY_WORDS[word] || word.length < 3) continue;
    kept.push(word);
  }
  return kept.reverse().join(' ') || null;
}

/** The noun that FOLLOWS the amount ("300 for water" → water). */
function labelAfter(text, index) {
  const tail = String(text || '').slice(index);
  const words = tail.split(/[^A-Za-z]+/).filter(Boolean);
  for (const raw of words) {
    const word = raw.toLowerCase();
    if (LABEL_STOPWORDS.has(word) || CURRENCY_WORDS[word] || word.length < 3) continue;
    return word;
  }
  return null;
}

/**
 * A line-item label. When the amount is introduced by "for/on/at/of" the noun
 * that FOLLOWS it is the correct label ("300 for water"), otherwise the noun
 * before it ("brakes 4,500").
 */
function labelFor(text, index) {
  const head = String(text || '').slice(0, index).trimEnd();
  const introducedByConnector = /(?:^|\s)(?:for|on|at|of|to|and|plus|with|&)\s*$/i.test(head);
  const before = labelBefore(text, index);
  if (introducedByConnector) return labelAfter(text, index) || before;
  return before || labelAfter(text, index);
}

/**
 * Every money-shaped number in the text, with the reason it was kept or
 * dropped. `kind` is one of: amount | unit_price | measurement | odometer_like.
 */
export function extractMoneyCandidates(text = '', { currency = null } = {}) {
  const source = String(text || '');
  if (!source.trim()) return [];
  // Dates and times are blanked first so "28/10/2026" never yields 28 / 10 / 2026.
  const scanned = maskDateShapes(source);
  const re = new RegExp(
    `(?<pre>${CURRENCY_PATTERN})?\\s*`
    + '(?<num>\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)'
    + '(?:\\s*(?<scale>k|thousand|million|mn|mil|kt|m)(?![a-z]))?'
    + '(?:\\s*(?:/-|/\\s*=|rs\\.?))?'
    + `(?:\\s*(?<post>${CURRENCY_PATTERN}))?`,
    'gi'
  );

  const candidates = [];
  for (const match of scanned.matchAll(re)) {
    const rawNumber = match.groups?.num || '';
    let value = cleanNumber(rawNumber);
    if (value === null) continue;

    const raw = match[0];
    const index = match.index || 0;
    const scaleWord = (match.groups?.scale || '').toLowerCase();
    const pre = (match.groups?.pre || '').toLowerCase();
    const post = (match.groups?.post || '').toLowerCase();
    const markedCurrency = CURRENCY_WORDS[pre] || CURRENCY_WORDS[post]
      || CURRENCY_SYMBOLS[pre] || CURRENCY_SYMBOLS[post] || null;
    const tail = scanned.slice(index + raw.length);

    // v1.96.2 — defence in depth for the ordinal mask above: a number that is
    // immediately followed by st/nd/rd/th is a calendar day, never money.
    if (/^(?:st|nd|rd|th)\b/i.test(tail)) continue;

    // "40l", "50350 km", "12 %" → a measurement, never money.
    if (UNIT_TAIL_RE.test(tail)) continue;

    const isUnitPrice = AT_MARKER_RE.test(scanned.slice(Math.max(0, index - 4), index))
      || UNIT_PRICE_TAIL_RE.test(tail);

    // A bare 6+ digit integer is far more likely an odometer reading.
    const bareDigits = rawNumber.replace(/[.,]/g, '');
    const odometerLike = !markedCurrency && !scaleWord && bareDigits.length >= 6;

    // A bare 4-digit number in model-year range with no money word nearby is a
    // year ("Toyota Fielder 2016"), never a spend.
    const yearLike = !markedCurrency && !scaleWord
      && bareDigits.length === 4
      && value >= 1950 && value <= new Date().getFullYear() + 2
      && !looksLikeMoneyContext(source, index);

    if (scaleWord && SCALES[scaleWord]) {
      // "15000m" is implausible as millions — only scale small numbers.
      if (scaleWord === 'm' && value > 999) continue;
      value *= SCALES[scaleWord];
    }

    if (!Number.isFinite(value) || value <= 0) continue;

    let kind = 'amount';
    if (isUnitPrice) kind = 'unit_price';
    else if (odometerLike) kind = 'odometer_like';
    else if (yearLike) kind = 'year_like';
    // "2 tyres", "4 new tyres", "5 days" → a count, not a spend.
    else if (!markedCurrency && !scaleWord && value <= 20
      && /^\s*(?:x|×)?\s*(?:[a-z]{2,}\s+){0,2}[a-z]{3,}s\b/i.test(tail)) kind = 'quantity';

    candidates.push({
      amount: roundMoney(value),
      raw: raw.trim(),
      index,
      currency: markedCurrency || currency,
      marked: Boolean(markedCurrency),
      kind,
      label: labelFor(source, index)
    });
  }

  return candidates;
}

/** The number a per-litre price is attached to ("@227kes per liter" → 227). */
export function extractUnitPrice(text = '') {
  const unit = extractMoneyCandidates(text).find((candidate) => candidate.kind === 'unit_price');
  return unit ? unit.amount : null;
}

/**
 * v1.96.2 — is `value` ONLY ever a per-unit price in this text?
 *
 * Live 2026-11-10 (+254734852529): "Price of diesel 222.7kes/liter" arrived
 * with a receipt that carried no readable total, and 222.7 was saved as the
 * SPEND. Law 2 of this module says a per-unit price is never the total — a
 * caller holding an AI-extracted amount must be able to ask this question
 * before it writes anything.
 */
export function isUnitPriceOnly(text = '', value = null) {
  const target = Number(value);
  if (!Number.isFinite(target) || target <= 0) return false;
  const matching = extractMoneyCandidates(text)
    .filter((candidate) => candidate.amount === roundMoney(target));
  if (matching.length === 0) return false;
  return matching.every((candidate) => candidate.kind === 'unit_price');
}

/**
 * Read a money story.
 *
 * Returns `{ amount, currency, candidates, lineItems, ambiguous, additive,
 * derivedTotal, unitPrice }` where `amount` is null when the story is not
 * unambiguous — the caller must then ask, never guess.
 */
export function parseMoneyStory(text = '', { currency = null, defaultCurrency = null } = {}) {
  const source = String(text || '');
  const candidates = extractMoneyCandidates(source, { currency: currency || defaultCurrency });
  const usable = candidates.filter((candidate) => candidate.kind === 'amount');
  const unitPrice = candidates.find((candidate) => candidate.kind === 'unit_price')?.amount ?? null;
  const marked = usable.filter((candidate) => candidate.marked);
  const resolvedCurrency = marked[0]?.currency || detectCurrencyMarker(source) || currency || defaultCurrency || null;

  if (usable.length === 0) {
    return {
      amount: null,
      currency: resolvedCurrency,
      candidates,
      lineItems: [],
      ambiguous: false,
      additive: false,
      derivedTotal: false,
      unitPrice
    };
  }

  // 1) An explicit total word names the total itself.
  if (usable.length > 1 && TOTAL_RE.test(source)) {
    const totalIndex = source.toLowerCase().match(TOTAL_RE)?.index ?? -1;
    const nearest = usable.reduce((best, candidate) => (
      Math.abs(candidate.index - totalIndex) < Math.abs(best.index - totalIndex) ? candidate : best
    ), usable[0]);
    const lineItems = usable.filter((candidate) => candidate !== nearest);
    return {
      amount: nearest.amount,
      currency: resolvedCurrency,
      candidates,
      lineItems: lineItems.map((candidate) => ({ label: candidate.label, amount: candidate.amount })),
      ambiguous: false,
      additive: ADDITIVE_RE.test(source),
      derivedTotal: false,
      unitPrice
    };
  }

  // 2) Several amounts joined by an additive word → one combined spend.
  if (usable.length > 1 && ADDITIVE_RE.test(source)) {
    return {
      amount: roundMoney(usable.reduce((sum, candidate) => sum + candidate.amount, 0)),
      currency: resolvedCurrency,
      candidates,
      lineItems: usable.map((candidate) => ({ label: candidate.label, amount: candidate.amount })),
      ambiguous: false,
      additive: true,
      derivedTotal: true,
      unitPrice
    };
  }

  // 3) Exactly one amount → done.
  if (usable.length === 1) {
    return {
      amount: usable[0].amount,
      currency: usable[0].currency || resolvedCurrency,
      candidates,
      lineItems: [],
      ambiguous: false,
      additive: false,
      derivedTotal: false,
      unitPrice
    };
  }

  // 4) Several untouched amounts → ask, never invent.
  return {
    amount: null,
    currency: resolvedCurrency,
    candidates,
    lineItems: usable.map((candidate) => ({ label: candidate.label, amount: candidate.amount })),
    ambiguous: true,
    additive: false,
    derivedTotal: false,
    unitPrice
  };
}

export const MONEY_LEXICON = Object.freeze({
  currencies: CURRENCY_WORDS,
  symbols: CURRENCY_SYMBOLS,
  scales: SCALES
});

export default {
  MONEY_LEXICON,
  detectCurrencyMarker,
  extractMoneyCandidates,
  extractUnitPrice,
  isUnitPriceOnly,
  parseMoneyStory
};
