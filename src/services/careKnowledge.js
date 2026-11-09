/**
 * Saka Fleet — Amina's care knowledge base (v1.80.0, Phase 19)
 * -----------------------------------------------------------
 * Deterministic, engine-owned FAQ blocks + investigation tool specs for the
 * autonomous care agent. This module is DATA ONLY: no database, no AI, no
 * network. The prompt renders from here, so Amina can never invent a product
 * fact and the copy can never drift from the shipped flows (rule 55 — one
 * source, reused everywhere).
 *
 * Boundaries (permanent): billing math, refunds, prices, VIN, ledger writes and
 * account actions are never described as things Amina can do (rules 8/28/46).
 */

/** Tool names Amina may request. The engine executes them; the model never does. */
export const CARE_TOOLS = Object.freeze([
  {
    name: 'get_profile_context',
    args: { email: 'customer email address' },
    description: 'The customer profile: name, phone, country, plan/trial state and their vehicles (plate, make/model, odometer).'
  },
  {
    name: 'get_recent_errors',
    args: { phone: 'customer phone number or email' },
    description: 'The last 5 system errors (error_logs) that mention this customer.'
  },
  {
    name: 'get_recent_chat',
    args: { phone: 'customer phone number' },
    description: 'The last 10 WhatsApp messages the customer exchanged with Saka (oldest first).'
  },
  {
    name: 'get_payment_status',
    args: { email: 'customer email address' },
    description: 'The billing ledger for this customer: plan, subscription state, trial and recent Paystack webhook events.'
  }
]);


export const CARE_TOOL_NAMES = Object.freeze(CARE_TOOLS.map((tool) => tool.name));

/**
 * The product facts Amina may use. Every line is a shipped behaviour (rules
 * 13/31/60): short, plain, one next step per answer.
 */
export const CARE_FAQ_BLOCKS = Object.freeze([
  {
    topic: 'logging',
    text: [
      'LOGGING (whatsapp)',
      '- A one-liner logs instantly: "Log 40L at 50350 km — full tank" (fuel), "Spent 2500 on tyres at 50500 km".',
      '- Or reply "log expense" and answer the quiz one question at a time.',
      '- A photo of a receipt works too: Saka reads the figures and asks to confirm before saving.',
      '- Entries can be corrected: reply "my entries" then "edit 3" or "delete 3" (type DELETE to confirm); "restore" works for 30 minutes. The vehicle, driver, date, VIN and owner can never be edited.'
    ].join('\n')
  },
  {
    topic: 'drivers',
    text: [
      'DRIVERS',
      '- Add a driver: reply "add driver +2547XXXXXXXX" (or "assign driver") and name the vehicle.',
      '- Remove: reply "remove driver" and pick the vehicle. The handback odometer is asked so the distance stays correct.',
      '- The owner keeps full control: only the owner can assign or remove a driver.'
    ].join('\n')
  },
  {
    topic: 'dashboard',
    text: [
      'WEB DASHBOARD',
      '- Reply "dashboard" in WhatsApp: Saka emails a magic link AND a 6-digit code.',
      '- The link works for 15 minutes, the code for 10; the code is never sent over WhatsApp.',
      '- Pages: Overview, Vehicles, Records, Compliance, Reports, Settings — plus Analytics for trends.',
      '- The code is single-use. If it expired, reply "dashboard" again for a fresh one.'
    ].join('\n')
  },
  {
    topic: 'reminders',
    text: [
      'REMINDERS & COMPLIANCE',
      '- "Remind me to change oil at 40000 km" / "insurance expires 15 Dec" / "service in 3000 km".',
      '- Reply "reminders" to see what is due; reply "done" to close one.',
      '- Documents (insurance, inspection, road licence, permits, driver licence) can be updated by replying with the new date.'
    ].join('\n')
  },
  {
    topic: 'receipts',
    text: [
      'RECEIPTS & DOCUMENTS',
      '- Photo a receipt or logbook: Saka reads it and confirms what it found.',
      '- Reply "receipts" to list them; "delete receipt 2" (type DELETE to confirm) removes the image. The parsed expense stays in the ledger and is edited through "my entries".',
      '- On the Free plan only the parsed figures are kept; paid plans and the welcome trial store the original image too.'
    ].join('\n')
  },
  {
    topic: 'reports',
    text: [
      'REPORTS',
      '- Reply "report" for the fleet summary, or name a report: financial, compliance, maintenance.',
      '- The dashboard Reports page builds a bespoke PDF instantly (range, vehicles, up to 8 metrics).',
      '- A monthly PDF summary can be switched on in Settings — it never uses the monthly report quota.'
    ].join('\n')
  },
  {
    topic: 'subscription',
    text: [
      'TRIAL & SUBSCRIPTION',
      '- The welcome trial starts automatically at the first registered vehicle: 30 days (6 months for the first 50 launch sign-ups), no card.',
      '- Reply "subscription" in WhatsApp for plans, upgrades or billing — checkout happens in chat.',
      '- The engine owns every price, coupon and date. Amina never quotes a price, discounts or refunds.',
      '- When a plan lapses, excess vehicles are PAUSED, never deleted.'
    ].join('\n')
  },
  {
    topic: 'support',
    text: [
      'SUPPORT',
      '- Reply "contact support" in WhatsApp or email support@reports.sakafleet.com.',
      '- "my ticket" shows the customer\'s own last 3 tickets with their status.',
      '- Support never asks for a PIN, OTP, password or card number — and Saka never asks for them in chat either.'
    ].join('\n')
  },
  {
    topic: 'voice',
    text: [
      'VOICE NOTES',
      '- A voice note up to about a minute is transcribed and handled exactly like typed text.',
      '- If a note cannot be heard, Saka says so honestly and asks for a typed message — nothing is saved from a note it could not understand.'
    ].join('\n')
  }
]);

/** The single rendered knowledge block injected into Amina's prompt. */
export function formatCareKnowledge(blocks = CARE_FAQ_BLOCKS) {
  return (blocks || []).map((block) => block.text).join('\n\n').slice(0, 6000);
}

/** The tool catalogue rendered for the prompt. */
export function formatCareTools(tools = CARE_TOOLS) {
  return (tools || []).map((tool) => {
    const args = Object.entries(tool.args || {}).map(([key, value]) => `"${key}": "<${value}>"`).join(', ');
    return `- ${tool.name} { ${args} } -> ${tool.description}`;
  }).join('\n');
}

export default { CARE_TOOLS, CARE_TOOL_NAMES, CARE_FAQ_BLOCKS, formatCareKnowledge, formatCareTools };
