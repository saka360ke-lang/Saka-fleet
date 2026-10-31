import { TIER_MATRIX, getTierPriceUSD, PLAN_CURRENCIES } from './subscriptionTiers.js';
import { TRIAL_DAYS } from './trialEngine.js';

/**
 * Saka Fleet — Product Q&A (v1.25.0).
 *
 * The user-facing answer engine for questions about Saka itself: cost, trial,
 * what gets logged, privacy, countries, limits, support, resale value.
 *
 * Design rules:
 *  - Facts are ENGINE-OWNED: prices come from subscriptionTiers (the single
 *    tier matrix) and the trial length from trialEngine. Nothing is hardcoded
 *    here, so a pricing change can never leave Saka quoting stale numbers.
 *  - Answers are deterministic first (zero tokens, instant), AI only for the
 *    long tail with this registry injected as context.
 *  - Backend is gated: env knobs, infrastructure, providers, databases and admin
 *    tooling are never disclosed.
 */

const usd = (value) => `$${Number(value).toFixed(2)}`;

function pricingLines() {
  const paid = ['solo_pro', 'team_fleet', 'growth', 'fleet_command'];
  return paid.map((key) => {
    const tier = TIER_MATRIX[key];
    const label = tier?.label || key;
    const limit = tier?.vehicleLimit ? `${tier.vehicleLimit} vehicle(s)` : 'vehicles';
    const addons = tier?.addonMonthlyUSD ? ' + add-ons' : '';
    return `• ${label} — ${usd(getTierPriceUSD(key, 'monthly'))}/month · ${limit}${addons}`;
  }).join('\n');
}

export const PRODUCT_QA = Object.freeze([
  {
    id: 'pricing',
    topics: /\b(cost|price|pricing|how much|charge[sd]?|fee[s]?|pay|paid|payment|subscription|plan[s]?|tier[s]?|premium|upgrade|billing|expensive)\b/i,
    build: () => '💳 *Saka is free to start* — one vehicle with reminders, receipts and monthly reports. No card, no catch.\n\n' +
      `When you want more:\n${pricingLines()}\n\n` +
      `Every new account begins with a *${TRIAL_DAYS}-day free trial of the full product* 😊\n` +
      `Billed in ${PLAN_CURRENCIES.join(', ')} at checkout. Local taxes may apply.\n\n` +
      '_Want the full experience? Say *REGISTER* and I\'ll set you up in two minutes._ 🚗'
  },
  {
    id: 'trial',
    topics: /\b(trial|free trial|try it|test it|how long|expire)\b/i,
    build: () => `🎁 Your first *${TRIAL_DAYS} days are on us* — the full product: unlimited reports, premium AI, driver tools.\n\n` +
      'No card. No auto-charge. If it is not for you, walk away and your passbook stays yours.\n\n' +
      'Shall we start? Just say *REGISTER*. 🚗'
  },
  {
    id: 'what_is_saka',
    topics: /\b(what is saka(?:\s*fleet)?|about saka(?:\s*fleet)?|who is saka|who are you|what are you|how does (?:it|this) work|what do you do|tell me\s+(?:more\s+)?about\s+(?:saka(?:\s*fleet)?|sakafleet|you|the service|this service))\b/i,
    build: () => '🙂 I\'m *Saka* — your machine\'s memory, money-saver and paperwork wizard, right here on WhatsApp.\n\n' +
      '⛽ Every fuel-up, expense and service — remembered for you\n' +
      '💰 What each kilometre really costs, so you can trim waste\n' +
      '🔔 Insurance, inspection and service reminders before they bite\n' +
      '📘 A passbook that proves the vehicle\'s history when you sell\n\n' +
      'Start with one line — e.g. *"Toyota Fielder 2016, diesel, 120,000 km"* — and I\'ll take it from there. 🚗'
  },
  {
    id: 'what_can_i_log',
    topics: /\b(what can i|can i log|log (?:fuel|expense|service)|track|record|receipts?|documents?|reminders?)\b/i,
    build: () => 'Here\'s what I do best 👇\n\n' +
      '⛽ Fuel — litres, price, odometer, full tank or top-up\n' +
      '💰 Expenses — service, repairs, insurance, tyres\n' +
      '📄 Documents — insurance, inspection, licences (send a photo)\n' +
      '🔔 Reminders — service, expiries, renewals\n' +
      '📊 Reports — cost per km, fuel economy, monthly summary\n\n' +
      'Try the easy way: *"Logged 40L at 50350 km for KES 5500 — full tank"* and I\'ll do the rest. 🚗'
  },
  {
    id: 'privacy',
    topics: /\b(privacy|private|safe|secure|security|who sees|data|delete my|gdpr)\b/i,
    build: () => '🔒 Your data is yours, full stop.\n\n' +
      '• Your passbook is private to you (and drivers you invite)\n' +
      '• We never sell or share it\n' +
      '• Ask me to export or delete your data anytime\n\n' +
      '_The plain version of our policy is right above._ 🙂'
  },
  {
    id: 'countries',
    topics: /\b(country|currency|units|km|miles|language|which countries|available|timezone)\b/i,
    build: () => '🌍 I work anywhere on WhatsApp — and I adapt to where you are.\n\n' +
      '• Currency: I use yours (KES, NGN, ZAR, USD…)\n' +
      '• Units: kilometres or miles, litres or gallons\n' +
      '• Dates: 15/10 or 10/15 or "next Monday" — I understand all of them\n' +
      '• Language: write in your language and I\'ll follow\n\n' +
      '_Want to change your country bucket? Say *country Kenya* (or yours)._ 🚗'
  },
  {
    id: 'limits',
    topics: /\b(how many (?:cars|vehicles|machines)|vehicle limit|add (?:a )?(?:car|vehicle)|more than one|fleet)\b/i,
    build: () => '🚗 Your free account covers one vehicle — plenty to fall in love with.\n\n' +
      'Growing? Team Fleet handles 3, Growth 5, and Fleet Command 5+ with per-vehicle add-ons — all in one passbook.\n\n' +
      '_Say *pricing* to see the plans, or *REGISTER* to start your first machine._ 🙂'
  },
  {
    id: 'resale',
    topics: /\b(resale|sell|value|passbook|history|proof|buyer)\b/i,
    build: () => '📘 Here\'s the quiet superpower: every fill-up, service and repair builds a *passbook* for your machine.\n\n' +
      'Buyers pay more when they can see the full, honest history — and handing it over takes one tap.\n\n' +
      'Start the passbook now; future-you (and the future buyer) will thank you. 🚗'
  },
  {
    id: 'support',
    topics: /\b(support|contact|talk to (?:someone|a human|a person)|human help|customer care)\b/i,
    build: () => '🙋 I\'m here for you first — most things I can fix in one message.\n\n' +
      'If you truly need a human, type *email support* and I\'ll pass it to support@sakafleet.com with the context.\n\n' +
      '_What would you like to sort out right now?_ 🙂'
  }
]);

/**
 * Which product question, if any, is being asked? Ordered — pricing first.
 *
 * v1.25.0 — statements are NOT questions: "I paid 5000 for fuel" must log the
 * expense, not trigger the pricing card. Only question-shaped messages (or the
 * unmistakable "how much / pricing / subscription / trial" phrasing) qualify.
 */
const QUESTION_SHAPE_RE = /^(?:what|how|how much|why|when|who|where|which|is|are|do|does|can|could|should|tell me|explain|any)\b|\?\s*$/i;
const STRONG_PRODUCT_RE = /\b(how much|pricing|price list|subscription|plans?|free trial|trial|cost of (?:this|the) service)\b/i;

export function matchProductQa(text = '') {
  const value = String(text || '').trim();
  if (!value) return null;
  const entry = PRODUCT_QA.find((candidate) => candidate.topics.test(value)) || null;
  if (!entry) return null;
  if (!QUESTION_SHAPE_RE.test(value) && !STRONG_PRODUCT_RE.test(value)) return null;
  return entry;
}

/** Deterministic customer-ready answer for a matched entry. */
export function buildProductQaReply(entry) {
  if (!entry) return null;
  if (typeof entry.build === 'function') return entry.build();
  return entry.answer || null;
}

/**
 * Authoritative context injected when the AI must answer an open-ended product
 * question. Facts + an explicit backend gate; never the architecture document.
 */
export function buildProductQaContext() {
  return [
    'PRODUCT ANSWERS (authoritative user-facing facts — never invent anything beyond these):',
    ...PRODUCT_QA.map((entry) => `- ${entry.id}: ${String(buildProductQaReply(entry) || '').replace(/\n/g, ' ')}`),
    'BACKEND GATE: never mention servers, APIs, databases, providers, environment variables, admin tools, pipelines or internal processes.',
    'If asked about internals, reply: "That\'s all under the hood 🙂 — what it means for you is …" and give the user-facing benefit.'
  ].join('\n');
}

export default {
  PRODUCT_QA,
  matchProductQa,
  buildProductQaReply,
  buildProductQaContext
};
