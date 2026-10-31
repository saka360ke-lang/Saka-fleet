import {
  PLAN_CURRENCIES,
  getTierDefinition,
  getBaseVehicleLimit,
  getTierPriceUSD,
  getAddonPriceUSD,
  getAnnualDiscountPercent
} from './subscriptionTiers.js';
import { TRIAL_DAYS } from './trialEngine.js';
import { getEffectiveExchangeRate } from './paystack.js';
import { prepareRoutingText } from './textNormalizer.js';

/**
 * Saka Fleet — Product Q&A (v1.27.0).
 *
 * FACTS ONLY. Every string here is a plain, verifiable statement assembled from
 * the live tier registry and the trial engine. The AI composes the actual reply
 * every time (`purpose: 'product_answer'` / `'user_data_answer'`); these facts
 * are (a) the composer's context and (b) the outage fallback. No marketing copy,
 * no pre-written answer to paste.
 */

const usd = (value) => `$${Number(value).toFixed(2)}`;

const PAID_TIER_KEYS = Object.freeze(['solo_pro', 'team_fleet', 'growth', 'fleet_command']);

function capacityText(key) {
  const base = getBaseVehicleLimit(key);
  if (key === 'fleet_command') {
    return `${base} vehicles included, + ${usd(getAddonPriceUSD('fleet_command', 'monthly'))}/month per extra vehicle`;
  }
  return `${base} vehicle${base === 1 ? '' : 's'}`;
}

/** One factual line per paid tier: monthly + annual price and capacity. */
export function tierFactLines() {
  return PAID_TIER_KEYS.map((key) => {
    const tier = getTierDefinition(key);
    const monthly = getTierPriceUSD(key, 'monthly');
    const annual = getTierPriceUSD(key, 'annual');
    return `${tier.label} — ${usd(monthly)}/month or ${usd(annual)}/year, ${capacityText(key)}.`;
  });
}

function pricingFacts() {
  const maxDiscount = Math.max(...PAID_TIER_KEYS.map((key) => getAnnualDiscountPercent(key)));
  return [
    '💳 Saka is free to start — 1 vehicle, essential expense logs, 1 report per month.',
    ...tierFactLines(),
    `Annual billing saves up to ${maxDiscount}% versus 12 monthly payments.`,
    `Every new account starts with a ${TRIAL_DAYS}-day free trial of the full product — no card, no auto-charge.`,
    `Billed in ${PLAN_CURRENCIES.join(', ')} at checkout; local taxes may apply.`
  ];
}

/** Local-currency money string: ISO code first so it reads the same everywhere. */
function localMoney(usdAmount, rate, currency, locale = 'en-US') {
  const amount = Math.round(Number(usdAmount) * Number(rate));
  return `${currency} ${amount.toLocaleString(locale || 'en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * v1.28.0 — payment answers in the user's own currency.
 *
 * The tier matrix prices in USD; checkout converts with the same cached
 * `getEffectiveExchangeRate()` used by Paystack, so the numbers a user hears in
 * chat match what they will be charged. Conversion is display-only and always
 * labelled approximate ("≈") — the engine never promises an exact FX rate.
 *
 * Returns null for USD (the USD facts already carry everything) or when no rate
 * is available; never throws.
 */
export async function buildLocalPricingFacts({ supabase = null, currency = 'USD', locale = 'en-US', fleetCount = null } = {}) {
  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'USD') return null;
  let rate = null;
  try {
    rate = await getEffectiveExchangeRate(supabase, cur);
  } catch { rate = null; }
  if (!Number.isFinite(Number(rate)) || Number(rate) <= 0) return null;

  const monthly = PAID_TIER_KEYS.map((key) => `${getTierDefinition(key).label} ${localMoney(getTierPriceUSD(key, 'monthly'), rate, cur, locale)}/month`);
  const annual = PAID_TIER_KEYS.map((key) => `${getTierDefinition(key).label} ${localMoney(getTierPriceUSD(key, 'annual'), rate, cur, locale)}/year`);
  const addon = localMoney(getAddonPriceUSD('fleet_command', 'monthly'), rate, cur, locale);
  const freeTier = getTierDefinition('free');
  const lines = [
    `📦 Free — no cost, ${freeTier.baseLimit} vehicle, essential logs, ${freeTier.reportsPerMonth} report/month.`,
    `💳 Approximate prices in ${cur}: ${monthly.join(' · ')}.`,
    `Annual in ${cur}: ${annual.join(' · ')}.`,
    `Fleet Command extra vehicle: ≈ ${addon}/month. Checkout is charged in ${cur}; these figures are approximate.`
  ];

  // v1.28.1 — a fleet-size question must be answered in local currency too.
  // "I have 7 vehicles" now produces the full local total, never a USD card.
  const count = Math.floor(Number(fleetCount));
  const included = getBaseVehicleLimit('fleet_command');
  if (Number.isFinite(count) && count > included) {
    const extra = count - included;
    const totalUsd = getTierPriceUSD('fleet_command', 'monthly') + extra * getAddonPriceUSD('fleet_command', 'monthly');
    lines.push(`💡 For ${count} vehicles: Fleet Command ≈ ${localMoney(totalUsd, rate, cur, locale)}/month (${included} included + ${extra} extra slot${extra === 1 ? '' : 's'}).`);
  }
  return lines;
}

/**
 * v1.28.4 — a money answer is only acceptable when it carries a NUMERIC figure in
 * the user's currency ("KES 1,298"); merely naming the currency is not enough.
 * The route falls back to the complete local fact lines otherwise.
 */
export function hasLocalFigure(text = '', currency = '') {
  const code = String(currency || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!code) return false;
  return new RegExp(`\\b${code}\\b\\s*\\d`, 'i').test(String(text || ''));
}

/**
 * v1.28.1 — hard-invariant scrubber. When Saka quotes local currency, NO dollar
 * value may survive in the reply: "$12.34", "(≈ $9.99)" and "USD 9.99" are
 * removed, and a bare "USD" becomes the local currency code when supplied.
 * Used for non-USD users on money answers, so the model can never leak USD.
 */
export function stripUsdFigures(text = '', { currency = null } = {}) {
  let out = String(text || '');
  out = out.replace(/\s*\(\s*(?:≈|~)?\s*(?:US\$|\$)\s*\d[\d,.]*(?:\s*\/\s*[a-z]+)?\s*\)/gi, '');
  out = out.replace(/(?:≈|~)?\s*(?:US\$|\$)\s*\d[\d,.]*(?:\s*\/\s*(?:mo|month|months|yr|year|years|annual|annually))?/gi, '');
  out = out.replace(/\bUSD\s*\d[\d,.]*/gi, '');
  out = out.replace(/\s+([.,;:!?])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  if (currency && String(currency).toUpperCase() !== 'USD') {
    out = out.replace(/\bUSD\b/gi, String(currency).toUpperCase());
  }
  return out;
}

function packageFacts() {
  const free = getTierDefinition('free');
  return [
    `📦 Free — $0, ${free.baseLimit} vehicle, essential logs, ${free.reportsPerMonth} report/month.`,
    'Solo Pro — 1 vehicle, every feature, unlimited reports, premium AI.',
    'Team Fleet — 3 vehicles, every feature, unlimited reports.',
    'Growth — 5 vehicles, every feature, unlimited reports.',
    `Fleet Command — 5 vehicles included, plus ${usd(getAddonPriceUSD('fleet_command', 'monthly'))}/month per extra vehicle, every feature.`
  ];
}

function featureFacts() {
  return [
    '⛽ One-line logging from WhatsApp, e.g. "Logged 40L at 50350 km for KES 5500" — nothing to install.',
    '💰 Fuel, service, repairs, tyres, insurance and earnings, remembered per vehicle.',
    '🔔 Service, insurance and inspection reminders before the date, not after.',
    '📊 Running cost per kilometre, fuel efficiency and monthly PDF reports.',
    '📘 A VIN-locked passbook that proves the vehicle history when you sell.',
    '🧑‍✈️ Driver assignment with licence and compliance reminders, scoped access.',
    '🚚 Multi-vehicle fleet view with owner controls and driver oversight.'
  ];
}

/**
 * Capacity math, computed in code. "I have 8 cars" -> Fleet Command + 3 add-ons.
 * The model never does this arithmetic; it receives the finished recommendation.
 */
export function recommendTierForFleet(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) {
    return { tierKey: 'free', addons: 0, lines: ['No vehicle count was given, so no plan can be recommended.'] };
  }
  if (n <= 1) {
    return {
      tierKey: 'free',
      addons: 0,
      lines: [
        'For 1 vehicle the Free plan is enough: 1 vehicle, essential logs, 1 report/month.',
        `Solo Pro adds every feature and unlimited reports for ${usd(getTierPriceUSD('solo_pro', 'monthly'))}/month.`
      ]
    };
  }
  if (n <= 3) {
    return {
      tierKey: 'team_fleet',
      addons: 0,
      lines: [`For ${n} vehicles the fit is Team Fleet: 3 vehicles, every feature, ${usd(getTierPriceUSD('team_fleet', 'monthly'))}/month.`]
    };
  }
  if (n <= 5) {
    return {
      tierKey: 'growth',
      addons: 0,
      lines: [`For ${n} vehicles the fit is Growth: 5 vehicles, every feature, ${usd(getTierPriceUSD('growth', 'monthly'))}/month.`]
    };
  }
  const addons = n - 5;
  const monthly = getTierPriceUSD('fleet_command', 'monthly') + addons * getAddonPriceUSD('fleet_command', 'monthly');
  const annual = getTierPriceUSD('fleet_command', 'annual') + addons * getAddonPriceUSD('fleet_command', 'annual');
  return {
    tierKey: 'fleet_command',
    addons,
    lines: [
      `For ${n} vehicles the fit is Fleet Command: 5 vehicles included + ${addons} extra vehicle slots at ${usd(getAddonPriceUSD('fleet_command', 'monthly'))}/month each.`,
      `Total ${usd(monthly)}/month or ${usd(annual)}/year for ${n} vehicles.`
    ]
  };
}

export const PRODUCT_QA = Object.freeze([
  {
    id: 'packages',
    topics: /(?:details?|info|breakdown|list|describe|explain|compare).{0,24}(?:packages?|plans?|tiers?|subscriptions?)|(?:all|each|every|both).{0,16}(?:packages?|plans?|tiers?)/i,
    facts: packageFacts
  },
  {
    id: 'tier_details',
    topics: /\b(details? of|what is in|what does .* include|tell me\s+(?:more\s+)?about\s+(?:the\s+)?(?:solo|team|growth|fleet command)|compare (?:the )?(?:plans?|tiers?))\b/i,
    facts: () => [...packageFacts(), '💳 Every paid plan includes driver assignment, compliance tracking and unlimited reports.']
  },
  {
    id: 'pricing',
    topics: /\b(costs?|price[sd]?|pricing|how much|charge[sd]?|fee[s]?|free|pay|paid|payment|subscription|plan[s]?|tier[s]?|premium|upgrade|billing|expensive|annual|annually|yearly|per year)\b/i,
    facts: pricingFacts
  },
  {
    id: 'trial',
    topics: /\b(trial|free trial|try it|test it|how long|expire)\b/i,
    facts: () => [
      `🎁 Your first ${TRIAL_DAYS} days are on us — the full product: unlimited reports, premium AI, driver tools.`,
      'No card. No auto-charge. If it is not for you, walk away and your passbook stays yours.',
      'The trial is one per owner lifetime.'
    ]
  },
  {
    id: 'what_is_saka',
    topics: /\b(what is saka(?:\s*fleet)?|about saka(?:\s*fleet)?|who is saka|who are you|what are you|how does (?:it|this) work|what do you do|(?:first\s+)?tell me\s+(?:(?:more|a little|a bit|something)\s+)?about\s+(?:saka(?:\s*fleet)?|sakafleet|you|the service|this service))\b/i,
    facts: () => [
      '🙂 Saka is your machine memory, money-saver and paperwork wizard, on WhatsApp.',
      '⛽ Every fuel-up, expense and service is remembered for you.',
      '💰 You see what each kilometre really costs, so waste is easy to trim.',
      '🔔 Insurance, inspection and service reminders arrive before they bite.',
      '📘 A passbook proves the vehicle history when you sell.'
    ]
  },
  {
    id: 'features',
    topics: /\b(features?|what can (?:it|saka|you) do|capabilit(?:y|ies)|modules?|what else can (?:it|you) do)\b/i,
    facts: featureFacts
  },
  {
    id: 'what_can_i_log',
    topics: /\b(what can i|can i log|log (?:fuel|expense|service)|track|record|receipts?|documents?|reminders?)\b/i,
    facts: () => [
      '⛽ Fuel — litres, price, odometer, full tank or top-up.',
      '💰 Expenses — service, repairs, insurance, tyres.',
      '📄 Documents — insurance, inspection, licences and expiry dates.',
      '🔔 Reminders — by date, distance or engine hours.',
      '📊 Reports — monthly PDF and per-kilometre costs.'
    ]
  },
  {
    id: 'privacy',
    topics: /\b(privacy|data safe|secure|security|who can see|share my (?:data|info)|gdpr|confidential)\b/i,
    facts: () => [
      '🔒 Your data is yours. Only you (and a driver you assign, scoped to their vehicle) can see your records.',
      '📘 A buyer sees the passbook you choose to transfer, nothing else.',
      '🚫 We never sell data and never post to your WhatsApp timeline.',
      '🗑️ You can export or delete everything at any time.'
    ]
  },
  {
    id: 'limits',
    topics: /\b(how many (?:cars|vehicles)|vehicle limit|add (?:a )?(?:car|vehicle)|limit of|maximum (?:cars|vehicles)|extra vehicle)\b/i,
    facts: () => [
      `🚗 Free covers ${getBaseVehicleLimit('free')} vehicle; Solo Pro ${getBaseVehicleLimit('solo_pro')}; Team Fleet ${getBaseVehicleLimit('team_fleet')}; Growth ${getBaseVehicleLimit('growth')}.`,
      `Fleet Command covers ${getBaseVehicleLimit('fleet_command')} vehicles plus extra slots at ${usd(getAddonPriceUSD('fleet_command', 'monthly'))}/month each.`,
      'After a downgrade, extra vehicles are paused, never deleted.'
    ]
  },
  {
    id: 'addons',
    topics: /\b(add.?ons?|extra vehicles?|more vehicle slots?)\b/i,
    facts: () => [
      '🧩 Add-ons are extra vehicle slots, available on Fleet Command only.',
      `Each extra vehicle is ${usd(getAddonPriceUSD('fleet_command', 'monthly'))}/month or ${usd(getAddonPriceUSD('fleet_command', 'annual'))}/year.`,
      'They are added to your base plan and can be adjusted when your fleet changes.'
    ]
  },
  {
    id: 'how_to_use',
    topics: /\b(how do i use|how to use|how do i start|how to start|get started|begin|onboard)\b/i,
    facts: () => [
      '🚀 Reply REGISTER and answer one simple question at a time.',
      '⛽ Then log in one line: "Logged 40L at 50350 km for KES 5500".',
      '🔔 Ask "reminders" to see what is due, or "report" for this month.',
      '💬 Everything else is plain language — ask me anything.'
    ]
  },
  {
    id: 'how_to_subscribe',
    topics: /\b(how do i subscribe|how to subscribe|upgrade|pay for|checkout|payment link|switch plan|change plan)\b/i,
    facts: () => [
      '💳 Say UPGRADE (or the plan name) and I will send a secure Paystack checkout link.',
      '📱 Pay by card or mobile money, in your currency.',
      '✅ Access switches on immediately; annual billing saves up to 25%.',
      '🔁 Cancel anytime — you keep access until the paid period ends.'
    ]
  },
  {
    id: 'why_details',
    topics: /\b(why do you need|why (?:my|the) (?:vin|plate|email|otp)|why ask|why is it needed|why do you ask)\b/i,
    facts: () => [
      '🔐 The VIN is the vehicle permanent identity — it locks the passbook to that machine.',
      '🚗 The registration number is how you and your driver recognise the vehicle day to day.',
      '✉️ Your email receives the passbook, the reports and the verification codes.',
      '🔢 The OTP proves it is really you before anything sensitive changes.'
    ]
  },
  {
    id: 'mistakes',
    topics: /\b(mistake|wrong (?:entry|amount|log)|edit|change (?:the |my )?(?:amount|odometer|record)|undo|delete (?:a )?(?:log|entry))\b/i,
    facts: () => [
      '✏️ Say "edit last log" and tell me the correction — I will fix it.',
      '🔐 Only the VIN cannot be changed; it is the vehicle permanent identity.',
      '🗑️ You can delete a log or a vehicle at any time; history is preserved for audit.'
    ]
  },
  {
    id: 'progress',
    topics: /\b(how many questions|skip this|can i skip|how long does (?:this|registration) take|pause)\b/i,
    facts: () => [
      '📋 Registration is a few short questions, one at a time.',
      '⏭️ Optional specs can be skipped as a group.',
      '⏸️ Say pause to stop and resume whenever you like.'
    ]
  },
  {
    id: 'technical',
    topics: /\b(is there an app|need (?:an )?app|internet|data bundle|offline|low data|download|play store|app store)\b/i,
    facts: () => [
      '📱 No app to install — Saka lives in this WhatsApp chat.',
      '📶 Works on a normal data bundle; text messages are tiny.',
      '🖼️ Photos and PDFs are optional extras.'
    ]
  },
  {
    id: 'data_control',
    topics: /\b(delete my (?:data|account)|export my data|download my (?:data|records)|data control|gdpr|take my data)\b/i,
    facts: () => [
      '📤 Say "export my data" and I will prepare your records.',
      '🗑️ Say "delete my account" — nothing is removed without your explicit confirmation.',
      '📘 A transferred passbook stays with the vehicle, by design.'
    ]
  },
  {
    id: 'resale',
    topics: /\b(resale|sell|value|passbook|history|proof|buyer)\b/i,
    facts: () => [
      '📘 Every fill-up, service and repair builds a passbook for your machine.',
      '💰 Buyers pay more when they can see the full, honest history.',
      '🤝 Handing it over takes one tap and keeps the record intact.'
    ]
  },
  {
    id: 'support',
    topics: /\b(support|contact|talk to (?:someone|a human|a person)|human help|customer care)\b/i,
    facts: () => [
      '🙋 I am here first — most things I can fix in one message.',
      '✉️ If you need a human, type "email support" and I will pass it to support@sakafleet.com with the context.'
    ]
  }
]);

/**
 * Which product question, if any, is being asked? Ordered — pricing first.
 *
 * v1.25.0 — statements are NOT questions: "I paid 5000 for fuel" must log the
 * expense, not trigger the pricing facts. Only question-shaped messages (or the
 * unmistakable "how much / pricing / subscription / trial" phrasing) qualify.
 */
const QUESTION_SHAPE_RE = /^(?:what|how|how much|why|when|who|where|which|is|are|do|does|can|could|should|tell me|explain|any)\b|\?\s*$/i;
const STRONG_PRODUCT_RE = /\b(how much|pricing|price list|subscription|plans?|free trial|trial|cost of (?:this|the) service|tell me\s+(?:more\s+)?about|details? of|features?)\b/i;
// v1.26.0 — small talk in front of a real question ("Nice. Tell me more about Saka").
const SMALL_TALK_PREFIX_RE = /^(?:(?:ok(?:ay)?|nice|cool|great|sure|well|please|first|hi|hello|hey|thanks?|thank you|alright|got it)[\s,.!…]+)+/i;

export function matchProductQa(text = '') {
  const original = String(text || '').trim();
  if (!original) return null;
  // v1.28.0 — typo/omission tolerance: route on the corrected text, never on
  // the raw value used for extraction or storage.
  const prepared = prepareRoutingText(original) || original;
  const value = prepared.replace(SMALL_TALK_PREFIX_RE, '').trim() || prepared;
  const entry = PRODUCT_QA.find((candidate) => candidate.topics.test(value)) || null;
  if (!entry) return null;
  // v1.28.0 — the routing text loses punctuation, so trailing-question shape is
  // checked against BOTH the prepared and the original text ("... available please?").
  const questionShaped = QUESTION_SHAPE_RE.test(value) || QUESTION_SHAPE_RE.test(original);
  if (!questionShaped && !STRONG_PRODUCT_RE.test(value)) return null;
  return entry;
}

/** Deterministic, fact-only fallback for a matched entry (outage path). */
export function buildProductQaReply(entry) {
  if (!entry) return null;
  const facts = typeof entry.facts === 'function' ? entry.facts() : (entry.facts || []);
  return facts.join('\n');
}

/** All product knowledge as compact fact lines (universal question path). */
export function buildProductFactsContext() {
  return PRODUCT_QA.map((entry) => `${entry.id}: ${buildProductQaReply(entry).replace(/\n/g, ' ')}`).join('\n');
}

/**
 * Authoritative context injected when the AI must answer an open-ended product
 * question. Facts + an explicit backend gate; never the architecture document.
 */
export function buildProductQaContext() {
  return [
    'PRODUCT ANSWERS (authoritative user-facing facts — never invent anything beyond these):',
    ...PRODUCT_QA.map((entry) => `- ${entry.id}: ${buildProductQaReply(entry).replace(/\n/g, ' ')}`),
    'BACKEND GATE: never mention servers, APIs, databases, providers, environment variables, admin tools, pipelines or internal processes.',
    'ANSWER-FIRST RULE (v1.26.0): whenever the user asks a question — about Saka, cost, privacy, features, how to use, what happens next — answer THAT question first, warmly, in 1-3 short lines, using the PRODUCT ANSWERS above.',
    'NEVER reply with the registration / plate script unless the user asked to register, said REGISTER, or sent a plate. Answering a question with "send me your plate" is forbidden.',
    'If asked about internals, reply: "That\'s all under the hood 🙂 — what it means for you is …" and give the user-facing benefit.'
  ].join('\n');
}

const BANNED_HEDGES = [
  /I don'?t have (?:any |an )?[^.\n]{0,70}(?:to share|to confirm|to give|available|on file)/i,
  /as an AI(?: language)? model/i,
  /I understand your frustration/i,
  /I(?:'m| am) (?:just )?an AI\b/i
];

// v1.28.0 — a reply that OPENS with a bare greeting after the first exchange is
// the "Hi/Habari in every message" habit. Only the opener is checked, so
// "Habari! Your insurance expires..." style first-contact copy is unaffected
// (the caller passes historyLength 0 for first contact).
const GREETING_OPEN_RE = /^(?:hi|hello|hey|hiya|habari|mambo|jambo|hujambo|salama|namaste|marhaba|bonjour|hola|hallo|ciao|sawubona|good (?:morning|afternoon|evening|night))\b[\s!,.…—-]/i;

/**
 * Reply linter (v1.27.0) — the model can never ship corporate hedging, an empty
 * capacity placeholder ("· vehicles") or an unfilled token. On a violation the
 * caller's fact fallback is used instead.
 *
 * v1.28.0 — also blocks a repeated greeting opener once a conversation has
 * history (`historyLength > 0`), keeping Saka's flow lifelike.
 */
export function sanitizeSakaReply(text, fallback = '', { historyLength = 0 } = {}) {
  const value = String(text || '').trim();
  const safeFallback = String(fallback || '').trim() || value;
  if (!value) return safeFallback;
  if (/\b(?:undefined|null|NaN)\b/.test(value)) return safeFallback;
  if (/·\s*vehicles?\b/i.test(value)) return safeFallback;
  if (BANNED_HEDGES.some((pattern) => pattern.test(value))) return safeFallback;
  if (historyLength > 0 && GREETING_OPEN_RE.test(value)) return safeFallback;
  return value;
}

export default {
  PRODUCT_QA,
  matchProductQa,
  buildProductQaReply,
  buildProductQaContext,
  buildProductFactsContext,
  buildLocalPricingFacts,
  stripUsdFigures,
  hasLocalFigure,
  recommendTierForFleet,
  tierFactLines,
  sanitizeSakaReply
};

