/**
 * Saka Fleet — Routing text normalizer (v1.28.0)
 * ----------------------------------------------
 * Humans type fast on a phone: swapped letters, doubled letters, missing spaces,
 * stray punctuation and whole words left out. The AI layers are naturally
 * forgiving, but the DETERMINISTIC routers (product Q&A matching, greeting and
 * stop detection, quiz arbitration) are regex-based and used to miss those
 * messages completely.
 *
 * This module normalizes text for ROUTING ONLY. It must never touch values that
 * are stored: plates, VINs, amounts, emails and names are extracted from the raw
 * message and always go through the confirmation gate.
 *
 * Contract: pure, deterministic, never throws.
 */

/** Words the router understands — the fuzzy corrector only snaps to these. */
const ROUTING_DICTIONARY = Object.freeze(new Set([
  // greetings & social
  'hi', 'hello', 'hey', 'hiya', 'habari', 'mambo', 'jambo', 'hujambo', 'salama',
  'namaste', 'marhaba', 'bonjour', 'hola', 'hallo', 'ciao', 'sawubona', 'greetings',
  'good', 'morning', 'afternoon', 'evening', 'night', 'thanks', 'thank', 'please',
  'ok', 'okay', 'nice', 'cool', 'great', 'sure', 'well', 'welcome',
  // navigation & control
  'stop', 'pause', 'unsubscribe', 'cancel', 'quit', 'restart', 'reset', 'start',
  'help', 'hint', 'guide', 'confirm', 'save', 'skip', 'done', 'later', 'resend',
  'code', 'otp', 'email', 'change', 'update', 'edit', 'remove', 'delete', 'export',
  'transfer', 'keep', 'assign', 'register', 'registration', 'report', 'reports',
  'reminder', 'reminders', 'remind', 'log', 'record',
  // product & billing
  'saka', 'sakafleet', 'fleet', 'price', 'prices', 'pricing', 'cost', 'costs',
  'subscription', 'subscriptions', 'subscribe', 'plan', 'plans', 'tier', 'tiers',
  'trial', 'free', 'pay', 'payment', 'payments', 'billing', 'bill', 'annual',
  'annually', 'yearly', 'monthly', 'month', 'year', 'upgrade', 'addon', 'addons',
  'extra', 'slot', 'slots', 'vehicle', 'vehicles', 'car', 'cars', 'truck', 'trucks',
  'bike', 'bikes', 'machine', 'machines', 'limit', 'limits', 'maximum', 'features',
  'feature', 'details', 'detail', 'package', 'packages', 'privacy', 'data', 'safe',
  'security', 'support', 'contact', 'human', 'app', 'download', 'install',
  // domain
  'vin', 'passbook', 'resale', 'sell', 'value', 'history', 'buyer', 'proof',
  'insurance', 'inspection', 'compliance', 'driver', 'drivers', 'fuel', 'diesel',
  'petrol', 'expense', 'expenses', 'earning', 'earnings', 'odometer', 'mileage',
  'kilometre', 'kilometres', 'kilometer', 'kilometers', 'litre', 'litres', 'liter',
  'liters', 'document', 'documents', 'country', 'countries', 'units', 'metric',
  'imperial', 'whatsapp', 'message', 'messages', 'replies',
  // question glue (needed for missing-space splits)
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'tell', 'show',
  'give', 'list', 'explain', 'more', 'about', 'the', 'a', 'an', 'of', 'to', 'in',
  'for', 'my', 'me', 'i', 'you', 'it', 'this', 'that', 'and', 'or', 'any', 'much',
  'many', 'there', 'have', 'need', 'want'
]));

/** Hand-curated high-frequency phone typos (fast, zero ambiguity). */
const TYPO_MAP = Object.freeze({
  pricimg: 'pricing', pricng: 'pricing', pricngs: 'pricing', pricings: 'pricing',
  subscrition: 'subscription', subcription: 'subscription', subscripton: 'subscription',
  subscriptins: 'subscriptions', subscrption: 'subscription',
  insurence: 'insurance', insuarance: 'insurance', insuranse: 'insurance',
  remider: 'reminder', remidner: 'reminder', remindr: 'reminder',
  odometre: 'odometer', odomiter: 'odometer', odometr: 'odometer',
  vehical: 'vehicle', vehichle: 'vehicle', vehcle: 'vehicle', vehicals: 'vehicles',
  milege: 'mileage', milage: 'mileage', millege: 'mileage',
  litrs: 'litres', ltrs: 'litres', litters: 'litres',
  passbok: 'passbook', passbookk: 'passbook',
  complience: 'compliance', complance: 'compliance',
  acccount: 'account', acount: 'account',
  recieve: 'receive', reciept: 'receipt', reciepts: 'receipts',
  anual: 'annual', anually: 'annually',
  feautures: 'features', featurs: 'features', featues: 'features',
  pakage: 'package', pakages: 'packages', packge: 'package',
  suport: 'support', suportt: 'support', cusstomer: 'customer',
  expence: 'expense', expences: 'expenses', expens: 'expense',
  earnigs: 'earnings', earnngs: 'earnings',
  documnt: 'document', documnet: 'document', documnets: 'documents',
  registartion: 'registration', regstration: 'registration', registation: 'registration',
  greeetings: 'greetings', helo: 'hello', hlo: 'hello', hii: 'hi', hiii: 'hi',
  habri: 'habari', habarii: 'habari', jamboo: 'jambo', mamboo: 'mambo',
  sakafllet: 'sakafleet', sakafleett: 'sakafleet',
  sotp: 'stop', stpo: 'stop', pase: 'pause', puse: 'pause', pls: 'please', plz: 'please',
  abuot: 'about', waht: 'what', wnat: 'want', teh: 'the', hte: 'the',
  tel: 'tell', expalin: 'explain', shwo: 'show'
});

/** Adjacent-letter transposition ("abuot" -> "about") before fuzzy scoring. */
function transposedRoutingWord(token = '') {
  const value = String(token || '');
  if (value.length < 4 || value.length > 24) return null;
  for (let index = 0; index < value.length - 1; index += 1) {
    const swapped = `${value.slice(0, index)}${value[index + 1]}${value[index]}${value.slice(index + 2)}`;
    if (ROUTING_DICTIONARY.has(swapped)) return swapped;
  }
  return null;
}

const WORD_RE = /^[a-z]+$/;

/** Strip accents/diacritics so "Olá" and "Ola" route the same way. */
export function stripDiacritics(text = '') {
  return String(text || '^').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^\^$/, '');
}

/**
 * Lowercase, de-punctuate, de-emoji and collapse whitespace. This is the text
 * routers should reason about; the raw message stays untouched everywhere else.
 */
export function normalizeForRouting(text = '') {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Standard Levenshtein distance (small strings only). */
export function editDistance(a = '', b = '') {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

/** Closest dictionary word for a token, or null when nothing is close enough. */
export function nearestRoutingWord(token = '') {
  const value = String(token || '').toLowerCase();
  if (!value || !WORD_RE.test(value)) return null;
  if (ROUTING_DICTIONARY.has(value)) return value;
  const mapped = TYPO_MAP[value];
  if (mapped) return mapped;
  const transposed = transposedRoutingWord(value);
  if (transposed) return transposed;
  if (value.length < 4) return null;
  const threshold = value.length >= 6 ? 2 : 1;
  let best = null;
  let bestDistance = threshold + 1;
  for (const word of ROUTING_DICTIONARY) {
    if (Math.abs(word.length - value.length) > threshold) continue;
    const distance = editDistance(value, word);
    if (distance < bestDistance) {
      best = word;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return bestDistance <= threshold ? best : null;
}

/** Split a merged token ("howmuch" -> "how much") when both halves are known. */
function splitMergedToken(token = '') {
  const value = String(token || '');
  if (value.length < 6) return null;
  for (let index = 2; index <= value.length - 2; index += 1) {
    const head = value.slice(0, index);
    const tail = value.slice(index);
    if (ROUTING_DICTIONARY.has(head) && ROUTING_DICTIONARY.has(tail)) return [head, tail];
  }
  return null;
}

/** Token-level typo correction against the routing dictionary. */
export function correctRoutingTypos(normalizedText = '') {
  const tokens = String(normalizedText || '').split(' ').filter(Boolean);
  const corrected = [];
  for (const token of tokens) {
    if (ROUTING_DICTIONARY.has(token) || TYPO_MAP[token]) {
      corrected.push(TYPO_MAP[token] || token);
      continue;
    }
    const split = splitMergedToken(token);
    if (split) {
      corrected.push(...split);
      continue;
    }
    const nearest = nearestRoutingWord(token);
    corrected.push(nearest || token);
  }
  return corrected.join(' ');
}

/**
 * The routing text: normalized + typo-corrected. Use it for intent/QA/command
 * matching only — never for extraction, storage or display.
 */
export function prepareRoutingText(text = '') {
  try {
    return correctRoutingTypos(normalizeForRouting(text));
  } catch {
    return normalizeForRouting(text);
  }
}

export const ROUTING_KEYWORDS = ROUTING_DICTIONARY;

export default {
  stripDiacritics,
  normalizeForRouting,
  editDistance,
  nearestRoutingWord,
  correctRoutingTypos,
  prepareRoutingText,
  ROUTING_KEYWORDS
};
