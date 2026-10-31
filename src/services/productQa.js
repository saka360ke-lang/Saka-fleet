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
    topics: /\b(costs?|price[sd]?|pricing|how much|charge[sd]?|fee[s]?|pay|paid|payment|subscription|plan[s]?|tier[s]?|premium|upgrade|billing|expensive)\b/i,
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
    id: 'how_to_use',
    topics: /\b(how (?:do i|can i|to) use|how does (?:saka(?:\s*fleet)?|this) work|what do i do|where do i start)\b/i,
    build: () => '🚗 Easy — just talk to me like a person.\n\n' +
      '• Send a sentence: *"Toyota Fielder 2016, diesel, 120,000 km"* — I set it up\n' +
      '• Or reply *REGISTER* and I ask one short question at a time\n' +
      '• Later: *"Logged 40L at 50350 km for KES 5500 — full tank"*\n' +
      '• *reminders*, *report*, *pricing* work anytime\n\n' +
      '_What do you drive? Tell me and I\'ll take it from there._ 🙂'
  },
  {
    id: 'how_to_subscribe',
    topics: /\b(how (?:do i|can i|to) (?:subscribe|upgrade|pay)|subscribe to|upgrade to|sign ?up for)\b/i,
    build: () => '💳 Two steps, all inside WhatsApp:\n\n' +
      '1. Reply *UPGRADE*\n' +
      '2. Pick your plan and pay on the secure checkout page\n\n' +
      'Your *30-day free trial* keeps running to the end, then your plan takes over. No card needed today.\n\n' +
      '_Want to see the plans first? Say *pricing*._ 🚗'
  },
  {
    id: 'tier_details',
    topics: /\b(solo ?pro|team fleet|growth(?: fleet)?|fleet command)\b/i,
    build: () => 'Here\'s what each plan unlocks 👇\n\n' +
      pricingLines() + '\n\n' +
      'Every plan includes the full passbook, reminders, receipts, reports and driver tools.\n\n' +
      `_All start with a *${TRIAL_DAYS}-day free trial*. Reply *UPGRADE* when you're ready._ 🙂`
  },
  {
    id: 'addons',
    topics: /\b(add.?ons?|extra vehicles?|more vehicle slots?)\b/i,
    build: () => '🧩 Add-ons are extra vehicle slots — only on *Fleet Command*.\n\n' +
      `Each extra vehicle is $${Number(TIER_MATRIX.fleet_command.addonMonthlyUSD || 0).toFixed(2)}/month (or the annual equivalent), added to your base plan.\n\n` +
      '_Reply *pricing* to see the plans, or *UPGRADE* to get started._ 🙂'
  },
  {
    id: 'why_details',
    topics: /\b(why (?:do you|does saka|would you) need|why my (?:plate|vin|email)|what do you need my|safe to share|share my (?:vin|plate|details)|who sees)\b/i,
    build: () => '🔒 Great question — here\'s exactly why:\n\n' +
      '• *Plate* — finds your machine\'s records\n' +
      '• *VIN* — locks the passbook to you alone, permanently\n' +
      '• *Email* — only for the OTP that proves it\'s you\n\n' +
      'Nothing is shared or sold, and you can view or delete your data anytime.\n\n' +
      '_Shall we continue? Reply *REGISTER*._ 🙂'
  },
  {
    id: 'mistakes',
    topics: /\b(made a mistake|wrong (?:vin|plate|number|details?)|fix (?:it|that|a typo)|undo|edit (?:it|that)|can i change)\b/i,
    build: () => '🙂 No stress — almost everything can be fixed later (edit the plate, mileage, costs, expiry dates).\n\n' +
      'The *VIN* is the one exception: it locks permanently the moment it\'s saved, so double-check it before you send it.\n\n' +
      '_Need a change now? Just tell me — I\'ll walk you through it._ 🚗'
  },
  {
    id: 'progress',
    topics: /\b(how many questions|how long (?:will|does) (?:this|it) take|what happens next|how much more|can i skip|skip (?:it|this))\b/i,
    build: () => '⏱️ About two minutes — a few short questions: what it is, the plate, then a few specs.\n\n' +
      'Optional bits (insurance, colour…) can be skipped with *Skip* — I\'ll never force them.\n\n' +
      '_Ready? Reply *REGISTER* (or just type what you drive)._ 🙂'
  },
  {
    id: 'technical',
    topics: /\b(do i need an app|is there an app|download|smart ?phone|technical|tech savvy|low data)\b/i,
    build: () => '📱 No app, no download — I live right here in WhatsApp.\n\n' +
      'Any phone works, even on a slow connection. If you can type a sentence (or send a voice note), you can use Saka.\n\n' +
      '_What do you drive? One line and I\'ll set it up._ 🚗'
  },
  {
    id: 'data_control',
    topics: /\b(delete (?:my|the) (?:data|account)|export (?:my )?data|who owns my data|stop using|remove my data)\b/i,
    build: () => '🔐 Your data belongs to you, always.\n\n' +
      'Ask me to *export* your passbook (PDF/CSV) or *delete my account* — both are honoured, and deletion removes your personal records.\n\n' +
      '_Anything else you\'d like to know?_ 🙂'
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
const STRONG_PRODUCT_RE = /\b(how much|pricing|price list|subscription|plans?|free trial|trial|cost of (?:this|the) service|tell me\s+(?:more\s+)?about)\b/i;
// v1.26.0 — small talk in front of a real question ("Nice. Tell me more about Saka").
const SMALL_TALK_PREFIX_RE = /^(?:(?:ok(?:ay)?|nice|cool|great|sure|well|please|hi|hello|hey|thanks?|thank you|alright|got it)[\s,.!…]+)+/i;

export function matchProductQa(text = '') {
  const original = String(text || '').trim();
  if (!original) return null;
  const value = original.replace(SMALL_TALK_PREFIX_RE, '').trim() || original;
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
    'ANSWER-FIRST RULE (v1.26.0): whenever the user asks a question — about Saka, cost, privacy, features, how to use, what happens next — answer THAT question first, warmly, in 1-3 short lines, using the PRODUCT ANSWERS above.',
    'NEVER reply with the registration / plate script unless the user asked to register, said REGISTER, or sent a plate. Answering a question with "send me your plate" is forbidden.',
    'If asked about internals, reply: "That\'s all under the hood 🙂 — what it means for you is …" and give the user-facing benefit.'
  ].join('\n');
}

export default {
  PRODUCT_QA,
  matchProductQa,
  buildProductQaReply,
  buildProductQaContext
};
