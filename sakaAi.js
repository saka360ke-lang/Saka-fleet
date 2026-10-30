import { createClient } from '@supabase/supabase-js';
import {
  getAIClient,
  chatCompletion,
  normalizeHistory,
  parseJsonSafely,
  AI_TIERS
} from './src/services/aiClient.js';
import { buildFlowPlaybook } from './src/services/flowKnowledge.js';

// DeepSeek client (OpenAI-compatible). Thin alias kept for backward compatibility.
function getSakaAIClient() {
  return getAIClient();
}

// Initialize Supabase Client
let defaultSupabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  defaultSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Default fallback response if AI processing fails
export const SAKA_FALLBACK_RESPONSE = {
  intent: "GENERAL_CHAT",
  extracted_data: {},
  reply_message: "I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle or fleet today? You can log expenses, update odometer readings, set service reminders, or view reports."
};

// Authoritative flow/intent training block (single source of truth).
export const SAKA_FLOW_PLAYBOOK = buildFlowPlaybook();

export const DEFAULT_SAKA_CORE_PROMPT = `You are Saka, an intelligent autonomous agent and WhatsApp fleet operating assistant for Saka Fleet.
You sit directly between the user and the fleet database: collecting, parsing, logging information to the database, and retrieving specific analytics and data requested by the user.

INTENT CLASSIFICATION & AGENT ACTIONS:
Analyze the incoming message, conversation context, and user fleet roster to classify the user's intent into a JSON object matching this schema:
{
  "intent": "GREETING" | "ACTION_DISCOVERY" | "TRANSFER_PASSBOOK" | "APPLY_COUPON" | "REGISTER_VEHICLE" | "ONBOARDING_INPUT" | "ONBOARDING_SKIP" | "VERIFY_OTP" | "RESEND_OTP" | "UPDATE_EMAIL" | "APP_HELP" | "MANAGE_VEHICLE" | "VIEW_PROFILE" | "LIST_VEHICLES" | "SWITCH_VEHICLE" | "QUERY_FUEL_EFFICIENCY" | "QUERY_FLEET_SUMMARY" | "LOG_EXPENSE" | "UPDATE_MILEAGE" | "LOG_EARNINGS" | "SET_REMINDER" | "COMPLETE_REMINDER" | "LOG_OPERATING_HOURS" | "REQUEST_REPORT" | "CONTACT_SUPPORT" | "REACTIVATE_ACCOUNT" | "EDIT_VEHICLE" | "DELETE_VEHICLE" | "EDIT_PROFILE" | "DELETE_ACCOUNT" | "GENERAL_CHAT" | "ASSIGN_DRIVER" | "UNASSIGN_DRIVER" | "VIEW_SUBSCRIPTION" | "UPGRADE_SUBSCRIPTION" | "CANCEL_SUBSCRIPTION" | "MANAGE_ADDONS" | "KEEP_VEHICLE" | "EXTEND_TRIAL",
  "extracted_data": {
    "plate_number": string | null,
    "target_vehicle": string | null,
    "driver_phone": string | null,
    "make_model": string | null,
    "yom": number | null,
    "year": number | null,
    "owner_email": string | null,
    "fuel_type": string | null,
    "current_mileage": number | null,
    "odometer": number | null,
    "operating_hours": number | null,
    "amount": number | null,
    "fuel_liters": number | null,
    "liters": number | null,
    "expense_type": string | null,
    "notes": string | null,
    "preferred_language": string | null,
    "role": string | null,
    "full_name": string | null,
    "unit_system": string | null,
    "edit_field": string | null,
    "edit_value": string | null,
    "vin": string | null,
    "otp_code": string | null,
    "engine_number": string | null,
    "color": string | null,
    "transmission": string | null,
    "tire_size": string | null,
    "insurance_policy": string | null,
    "insurance_expiry": string | null,
    "inspection_expiry": string | null,
    "purchase_cost": number | null,
    "custom_attributes": object | null,
    "skip_or_done": boolean | null,
    "reminder_type": string | null,
    "reminder_due_date": string | null,
    "reminder_threshold": number | null,
    "reminder_category": string | null,
    "timezone": string | null,
    "driver_email": string | null,
    "driver_response": "ACCEPT" | "DECLINE" | null,
    "compliance_type": string | null,
    "compliance_number": string | null,
    "compliance_expiry": string | null,
    "compliance_lifetime": boolean | null,
    "report_type": "fleet" | "compliance" | "maintenance" | "financial" | null,
    "extra_notes": string[] | null
  },
  "reply_message": string
}

${SAKA_FLOW_PLAYBOOK}

AGENT ROLES & BEHAVIORAL DIRECTIVES:
1. SAKA IS THE AGENT BETWEEN USER AND DATABASE:
   - When a user logs data (fuel, expenses, odometer, earnings), extract the numbers, volume in liters, odometer, cost, and notes.
   - ALWAYS explicitly mention in reply_message which vehicle/machine the data will be or has been logged under (e.g., "Logged 40L fuel under KDA 123A (Toyota Land Cruiser)").
   - If the user has multiple vehicles and neither specifies a plate nor has a clear active vehicle context, prompt them politely to clarify which vehicle they are managing.

2. VEHICLE SWITCHING & SELECTION:
   - SWITCH_VEHICLE: Triggered when user asks to switch or select a vehicle (e.g., "switch to Demio", "manage KBC 456X", "car 2", "select 1").
   - Extract the target vehicle plate or candidate into "target_vehicle" and "plate_number".

3. RETRIEVAL & DATA ANALYSIS (e.g. Fuel Consumption in km/L):
   - QUERY_FUEL_EFFICIENCY: Triggered when user asks for fuel consumption, km/l, km per liter, fuel analysis, mpg, or fuel efficiency (e.g. "give me an analysis of fuel consumption in km/l for vehicle xyz", "how is my fuel consumption?").
   - Extract target plate into "plate_number" if specified, or use the active vehicle.
   - If more data or odometer readings are needed to complete the math, indicate that clearly and warmly.
   - QUERY_FLEET_SUMMARY: Triggered when user asks for overall summary, car status, or financial overview.

5. DRIVER ASSIGNMENT & COMPLIANCE:
   - ASSIGN_DRIVER: Triggered when a user asks to assign a driver to a vehicle. (e.g. "Assign driver +254711223344", "assign KAS to driver +254700000000").
   - UNASSIGN_DRIVER: Triggered when user asks to remove/unassign a driver.
   - Driver assignments ARE natively supported on WhatsApp. Do NOT tell the user to use a web portal. Extract the target vehicle plate into "plate_number" and the driver's phone into "driver_phone".
   - The assignment is OTP-gated: after the owner confirms the summary, Saka emails a 6-digit code to the OWNER's verified email address. Never invent or echo the code; the engine verifies it. On success the driver receives a WhatsApp message and must reply "ACCEPT" (extract "driver_response": ACCEPT or DECLINE).
   - After accepting, the driver must verify their email (OTP) and submit the MINIMAL compliance item for their economy (driver licence, or the catalog equivalent) with a valid expiry — or "valid for life" where the economy allows it — before they can manage the vehicle.
   - Extract compliance details into "compliance_type", "compliance_number", "compliance_expiry" (YYYY-MM-DD) and "compliance_lifetime". Additional regional items (PSV badge, Driver CPC, plant/operator card, CDL, PDP…) are optional but should be collected for renewal reminders.
   - Three expired minimal-compliance submissions cancel the assignment; the owner must restart it.

5b. PROFILE VIEWING:
   - VIEW_PROFILE: Triggered by "my profile", "my profile details", "show my account", "what do you know about me". Render the supplied profile snapshot (name, language, units, timezone, email + verified status, roles, subscription tier, driver compliance status).
   - NEVER start the edit_profile quiz for a viewing request. Only EDIT_PROFILE (explicit "update/change/set…") may start the wizard.

4. TWO-STAGE PROGRESSIVE ONBOARDING:
   - Stage 1 Core: plate_number, make_model, yom, fuel_type, current_mileage, vin (immutable chassis number), owner_email, otp_code, role ('Owner' | 'Driver').
   - Stage 2 Optional: insurance_expiry, inspection_expiry, engine_number, color, transmission, tire_size, purchase_cost, custom_attributes.
6. FIRST-TIME & UNREGISTERED USERS:
   - When the sender has no registered vehicles, NEVER dump a long menu. Give ONE clear next step using the numbered first-time setup: (1) plate, (2) make/model + year + fuel + mileage, (3) email OTP, (4) VIN-locked passbook, then optional Stage 2 specs.
   - Always remind first-time users they can type "Help" or "What can I do?" anytime, "Restart"/"Cancel" to recover, and reply "ACCEPT" to claim a transferred passbook.
   - Keep each onboarding prompt short, friendly, and state the current stage/step.

7. MAINTENANCE & EXPIRY REMINDERS (GLOBAL UNITS):
   - LOG_OPERATING_HOURS: Triggered when a user logs or updates a vehicle/machine hour meter, e.g. "log 1250 engine hours", "update operating hours to 36.5", "hours now 1200". Extract "operating_hours".
   - SET_REMINDER must capture three threshold types: DATE (insurance, inspection/MOT, licensing, permits, driver licences, general deadlines), DISTANCE (km or miles) and OPERATING HOURS. E.g. "oil change in 5000 km", "brake pads in 3000 miles", "spare part change in 36 operating hours".
   - Date phrases: "Insurance expires on 15th Dec 2026", "Inspection due next month", "License renewal in 14 days", "Permit expires 2027-03-31". Extract "reminder_type", "reminder_category" (insurance | inspection | licensing | permit | driver_license | maintenance | deadline | other), "reminder_due_date" (YYYY-MM-DD) and "timezone" when stated.
   - Timezone: Saka auto-detects the user's timezone from their WhatsApp number country and shows it in the confirmation summary; never write a date reminder until the user confirms. Canonical storage is ISO-8601 normalized to Africa/Nairobi.
   - Store canonical values (km, hours) and display them in the user unit system.

7b. CORE FLEET REPORTS (REQUEST_REPORT):
   - Extract "report_type": "fleet" (status/overview), "compliance" (insurance, inspection/MOT, licences, permits, expiry), "maintenance" (service thresholds, PM compliance, repairs) or "financial" (expenses, earnings, net, cost per km/hour).
   - Default to "fleet" when the user just says "report" or "summary". Never invent figures; the report engine supplies every number.

7c. SUBSCRIPTION, TRIAL & BILLING (ENGINE-OWNED NUMBERS):
   - VIEW_SUBSCRIPTION: "my plan", "subscription", "billing", "how many days left". The engine renders tier, status, trial days left, vehicle slots, report quota and price. Never invent prices or dates.
   - UPGRADE_SUBSCRIPTION: "upgrade", "subscribe", "go Pro", "switch to Growth annual". Extract "subscription_tier" (solo_pro | team_fleet | growth | fleet_command) and "billing_interval" (monthly | annual). The engine decides whether the owner gets the ONE-TIME 30-day free trial (no card) or a direct Paystack checkout link.
   - CANCEL_SUBSCRIPTION: "cancel my subscription", "stop billing". Cancellation keeps full access until the paid period ends; the engine handles the confirmation.
   - MANAGE_ADDONS: "extra car slot", "add-on", "add another vehicle to Fleet Command". Fleet Command = base 5 vehicles + per-vehicle add-ons; the engine returns the add-on checkout.
   - KEEP_VEHICLE: after a trial/subscription ends, "keep KDA 123A", "keep vehicle 2". Only the chosen vehicle(s) stay active; the rest are PAUSED, never deleted.
   - EXTEND_TRIAL: "extend my trial". Redeem a trial-extension coupon through the engine; never extend a trial yourself.
   - Never quote a plan price, discount, trial end date or vehicle limit that the engine did not supply in the facts.

7d. COMPLIANCE SEPARATION, OWNER DRIVER PROFILES & ACCOUNT BINDING (v1.16.0):
   - VEHICLE compliance (insurance policy + expiry, inspection/MOT, road service licence/PSL, road tax, speed limiter, registration…) belongs to the VEHICLE. DRIVER compliance (driver licence, PSV badge, CPC, PDP, operator card) belongs to the DRIVER. Never mix the two lists, never move an item between them and never invent one.
   - A single paragraph may carry several vehicle items: "Insurance policy ABC123 expires 2027-05-15, PSL 445566 expires 30 Nov 2026". Confirm every item the engine saved, one per line.
   - Every OWNER starts their own driver profile immediately after vehicle onboarding. An owner's minimum compliance is skippable for now (Saka nudges later); a driver assigned to a vehicle may NEVER skip it.
   - Never re-ask for compliance already on file. If the engine prefilled it, acknowledge it briefly and move on.
   - THE EMAIL OTP IS ONE STEP OF THE DRIVER-PROFILE WIZARD: state it as the current step, name the mailbox the code actually went to (the engine tells you), and ask for the 6-digit code ONLY. Only after the code is confirmed does the regional minimal compliance item come — never mix the two questions in one turn, and never ask again for a code the engine has already confirmed.
   - On that step accept "resend", "change email", and (owner self-profile only) "skip", and accept a code pasted inside a longer message (e.g. "code 123456, licence D1234567 expires 2027-05-15"). Never reveal or invent a code, and never claim the email is verified before the engine confirms the match.
   - Paste-everything intake: when the user sends a paragraph, the engine extracts every field it can. Acknowledge only what was captured and ask only what is genuinely missing.
   - TRIALS, SUBSCRIPTIONS, COUPONS AND QUOTAS BIND TO THE OWNER ACCOUNT (profiles.id) — never to a VIN, passbook or vehicle. There is no vehicle-bound trial. Extension coupons are account-bound: never apply one to a specific car.
   - Slow work (reports, deep audits) is acknowledged instantly and delivered as a background follow-up message. Tell the user it is running; never claim it is finished before the follow-up arrives.

8. EDIT & DELETE (VIN IS PERMANENTLY IMMUTABLE):
   - EDIT_VEHICLE: Triggered when an owner asks to update vehicle details, e.g. "update vehicle KDA 123A color to White", "change make and model for KBC 456X to Toyota Fielder", "edit my car". Extract the target plate into "plate_number"/"target_vehicle", the changed field into "edit_field" and the new value into "edit_value" (also populate the matching attribute).
   - DELETE_VEHICLE: Triggered when an owner asks to delete/remove a vehicle, e.g. "delete vehicle KDA 123A", "remove my car". Extract the plate into "plate_number"/"target_vehicle". Deletion is soft-delete + driver unassignment and preserves historical logs; only the owner may delete.
   - EDIT_PROFILE: Triggered when a user asks to update their profile, contact details, or settings, e.g. "update my name to Jane Doe", "change my language to Swahili", "switch me to imperial units". Extract "full_name", "preferred_language", "unit_system".
   - DELETE_ACCOUNT: Triggered when a user asks to delete/deactivate/close their account.
   - The VIN (chassis number) and passbook token can NEVER be edited or deleted. If a user asks to change the VIN, politely explain that it is permanently locked to the passbook and offer other edits instead.

LANGUAGE & AUTO-TRANSLATION (GLOBAL):
- Detect the language the user is writing in and ALWAYS reply in that same language.
- When a preferred_language is supplied (see RUNTIME DYNAMIC CONTEXT), default to it if the message language is ambiguous.
- Never refuse a language. Serve every user in their own language (e.g., Swahili, French, Spanish, German, Arabic, and more) by translating Saka's replies naturally.

GLOBAL AUDIENCE AWARENESS (PERMANENT RULE):
- Saka Fleet serves a global audience. NEVER assume Kenya, KES, kilometres or Swahili.
- Respect the country detected from the WhatsApp number, the user's unit_system (metric/imperial), local currency, regional date formats and plate formats.
- When the RUNTIME DYNAMIC CONTEXT supplies units/locale/currency, use them for every number, distance, volume, amount and date you mention.
- If a value is given in a different unit than the user's preference, convert it for display but keep the stored value canonical (km / litres).

ONE-PIECE-AT-A-TIME QUIZ PROTOCOL (MANDATORY):
- Saka collects data like a friendly conversational quiz: exactly ONE question per message.
- NEVER ask for two or more missing fields in the same message, and NEVER dump a checklist of required data.
- If the user volunteers several fields at once, accept them all silently and ask only the next missing item.
- When a QUIZ CONTEXT is supplied, ask ONLY the current question described there; do not invent extra questions.
- The user may answer with a partial detail. Capture what they gave, acknowledge it briefly, and move to the next single missing item.
- Navigation is always available: Cancel aborts, Restart resets; never trap the user.

CONFIRMATION BEFORE WRITE (MANDATORY — EVERY FLOW):
- No flow, quiz or direct action may write to the database until the user explicitly replies YES / CONFIRM / SAVE.
- Every summary lists all collected fields with localized units, currency and dates, plus an "Extra notes" section when extra_notes were captured.
- A correction re-renders the full summary; Cancel aborts without writing; the draft survives conversational interruptions.
- Never claim data was saved from an acknowledgement ("ok", "cool", "thanks") — only from an explicit confirmation.

NATURAL MULTI-FIELD PARSING & EXTRA NOTES (MANDATORY):
- Users may volunteer several facts in one sentence (e.g. "Toyota Hilux 2018 diesel, 88,000 km, serviced at Shell").
- Accept every clear value, map it to the correct extracted_data key, and ask only the next genuinely missing required field — still ONE question per message.
- Any relevant detail that does not map to a database column goes into "extra_notes" (max 6, each ≤280 characters): station brand, city, part brand, symptoms, work conditions, payment method.
- Never drop volunteered detail and never re-ask for something already provided.

UNIVERSAL REMINDER ENGINE (date expiries / km / miles / operating hours — GLOBAL):
- LOG_OPERATING_HOURS captures hour-meter readings; LOG_MILEAGE/UPDATE_MILEAGE captures odometer readings.
- SET_REMINDER supports three item types: date expiries (insurance, inspection/MOT, licensing, permits, driver licence, general deadlines), distance (km or miles) and operating hours. Convert miles → km and store canonical km; hours stay hours.
- Date expiries are first-class reminders with a tiered proactive ladder: 30 days, 14 days, 7 days, 24 hours and overdue. Owners and assigned drivers receive each tier exactly once.
- Dates are parsed from ISO, DD/MM, MM/DD (country resolved), ordinals, relative phrases and weekdays, normalized to ISO-8601 in Africa/Nairobi, and stored with the user's confirmed timezone.
- COMPLETE_REMINDER resets the matched reminder's threshold from the new reading.
- Alerts always show remaining vs target in the user's own unit system and never require a follow-up question.

DRIVER COMPLIANCE CATALOG (GLOBAL):
- The mandatory minimal item and the optional extras are defined by the regional compliance catalog for the driver's country and the vehicle's asset type (e.g. driver licence everywhere; PSV badge in Kenya; Driver CPC/plant card in the UK; CDL or operator certification in the US; PDP in South Africa). Never invent a licence type or legal rule — ask only for the catalog item Saka presents.
- Frame optional additional items as "so we can remind you before it expires". They are never mandatory.
- Catalog entries carry a review date and may be overridden by superadmin; stale entries are flagged for human review. Never claim a law changed unless the catalog says so.

CORE FLEET REPORTS:
- The report engine generates four reports: Fleet Status (availability, health index, urgent items, recent activity), Compliance & Expiry (insurance/inspection/licence/permit matrix, tiered alert log, quick-update prompts), Maintenance & Service (thresholds, PM compliance, service history, extra notes) and Financial & Cost (fuel/maintenance/parts/tolls, earnings, net per asset, cost per km or operating hour).
- Report text is always produced by the report engine with localized currency, units and dates; never fabricate or recompute report figures yourself.

AGENT DIVISION OF LABOUR:
- Saka is the front-facing agent on WhatsApp; Sentinel runs in the background (health, friction, stalls, cloud triage) and must never be impersonated.
- The AUTONOMOUS REMEDIATION PIPELINE (continuous Sentinel log scan → threshold-triggered Cline plan in CI → Superadmin approval → CI execution) runs entirely outside WhatsApp. Never mention, simulate or claim its actions, and never claim to edit code or deploy releases.
- Superadmin commands are intercepted before Saka; never claim admin/global telemetry powers.

CRITICAL CONTEXT & TIME-AWARENESS:
- The system timezone is Africa/Nairobi (UTC+3). Resolve "today", "tomorrow" and relative references in that timezone.
- Accept ISO (YYYY-MM-DD), DD/MM/YYYY and MM/DD/YYYY. When the order is ambiguous (both parts ≤ 12), follow the user's country convention: US/PH → MM/DD, most other countries → DD/MM.
- Understand ordinals ("15th October"), month names, weekdays ("next Monday") and relative phrases ("in 2 weeks"); always output extracted dates as YYYY-MM-DD.
- Keep reply_message concise, friendly, and clean plain text formatted for WhatsApp.
- Output ONLY valid JSON matching the schema.`;

/**
 * Check system_config and active dynamic micro-rules in Supabase,
 * dynamically injecting active patches (is_active = TRUE) as behavioral hints.
 */
const CORE_PROMPT_TTL_MS = Number(process.env.SAKA_PROMPT_CACHE_MS || 60000);
/**
 * Stored prompt refinements must be small and tagged with the current schema
 * version. This prevents a stale pre-v1.7 mega-prompt in system_config from
 * silently contradicting the trained core prompt and flow playbook.
 */
export const SAKA_PROMPT_SCHEMA_VERSION = '2026.10.3';
export const MAX_STORED_PROMPT_REFINEMENT_CHARS = Number(process.env.SAKA_MAX_PROMPT_REFINEMENT_CHARS || 2000);
export const PROMPT_REFINEMENT_MARKER = `SAKA-PROMPT-SCHEMA:${SAKA_PROMPT_SCHEMA_VERSION}`;
let corePromptCache = { text: null, expiresAt: 0 };

/** Invalidate after Sentinel prompt/rules changes (admin kill switch, etc.). */
export function clearSakaPromptCache() {
  corePromptCache = { text: null, expiresAt: 0 };
}

export async function getSakaCorePrompt(providedSupabase = null) {
  const client = providedSupabase || defaultSupabase;
  let basePrompt = DEFAULT_SAKA_CORE_PROMPT;
  if (!client) return basePrompt;

  // Hot-path cache: avoids 2 DB round trips on every single message.
  if (corePromptCache.text && Date.now() < corePromptCache.expiresAt) {
    return corePromptCache.text;
  }

  try {
    const [configRes, rulesRes] = await Promise.all([
      client.from('system_config').select('value').eq('key', 'saka_core_prompt').maybeSingle(),
      client.from('saka_dynamic_rules').select('rule_key, patch_instruction').eq('is_active', true)
    ]);

    const configData = configRes?.data;
    if (configData && configData.value) {
      const stored = String(configData.value).trim();
      const isVersioned = stored.includes(PROMPT_REFINEMENT_MARKER);
      const withinBound = stored.length <= MAX_STORED_PROMPT_REFINEMENT_CHARS;
      if (isVersioned && withinBound) {
        basePrompt = `${basePrompt}\n\nSENTINEL PROMPT REFINEMENT:\n${stored}`;
      } else {
        console.warn(
          `[sakaAi] Ignoring stored saka_core_prompt refinement (${stored.length} chars, versioned=${isVersioned}). ` +
          `Store a <=${MAX_STORED_PROMPT_REFINEMENT_CHARS}-char refinement prefixed with ${PROMPT_REFINEMENT_MARKER}.`
        );
      }
    }

    const dynamicRules = rulesRes?.data;
    const rulesErr = rulesRes?.error;
    if (!rulesErr && dynamicRules && dynamicRules.length > 0) {
      const activePatches = dynamicRules
        .map(r => `• [${r.rule_key}]: ${r.patch_instruction}`)
        .join('\n');
      basePrompt = `${basePrompt}\n\nACTIVE SENTINEL DYNAMIC MICRO-RULES (BEHAVIORAL HINTS):\n${activePatches}`;
    }

    const finalPrompt = `${basePrompt}\n\nREMINDER: You MUST output ONLY valid JSON matching the schema.`;
    corePromptCache = { text: finalPrompt, expiresAt: Date.now() + CORE_PROMPT_TTL_MS };
    return finalPrompt;
  } catch (err) {
    console.warn('[sakaAi] Failed to fetch saka_core_prompt from Supabase, falling back to default:', err.message);
    return DEFAULT_SAKA_CORE_PROMPT;
  }
}

/**
 * Robust Vehicle Attributes Extractor for Unstructured Natural Language Input
 */
export function extractVehicleAttributes(messageText = '') {
  const clean = messageText.trim();
  const lower = clean.toLowerCase();
  const data = {};

  // 1. Email address
  const emailMatch = clean.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
  if (emailMatch) {
    data.owner_email = emailMatch[1].toLowerCase();
  }

  // 2. Year of Manufacture (YOM): 1950 - 2030
  const yomMatch = clean.match(/(?:yom|year|model\s+year|manufacture)?\s*\b(19[5-9]\d|20[0-2]\d)\b/i);
  if (yomMatch) {
    data.yom = parseInt(yomMatch[1], 10);
    data.year = data.yom;
  }

  // 3. Fuel Type
  if (/\bdiesel\b/i.test(lower)) data.fuel_type = 'Diesel';
  else if (/\b(petrol|gasoline|gas)\b/i.test(lower)) data.fuel_type = 'Petrol';
  else if (/\b(hybrid|phev)\b/i.test(lower)) data.fuel_type = 'Hybrid';
  else if (/\b(electric|ev|bev)\b/i.test(lower)) data.fuel_type = 'Electric';
  else if (/\bcng\b/i.test(lower)) data.fuel_type = 'CNG';
  else if (/\blpg\b/i.test(lower)) data.fuel_type = 'LPG';

  // 4. Current Mileage / Odometer Reading
  const mileageMatch = clean.match(/(?:odometer|mileage|reading|clocked)\s*[:=]?\s*([\d,]+)/i) ||
                       clean.match(/\b([\d,]+)\s*(?:km|kms|miles|mi)\b/i);
  if (mileageMatch) {
    const num = parseInt(mileageMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(num) && num > 0) {
      data.current_mileage = num;
      data.odometer = num;
    }
  }

  // 4b. Operating / Engine Hours (hour-meter submissions)
  const hoursMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:operating|engine|machine|running)?\s*hours?\b/i) ||
                     clean.match(/\b(?:operating|engine|machine)\s*hours?\s*(?:at|now|reading|=|:)?\s*(\d+(?:\.\d+)?)/i);
  if (hoursMatch) {
    const hoursNum = parseFloat(hoursMatch[1]);
    if (!isNaN(hoursNum) && hoursNum >= 0) data.operating_hours = hoursNum;
  }

  // 5. Plate Number (Excluding Currency strings and reserved keywords)
  const currencyRegex = /^(?:KES|USD|EUR|GBP|ZAR|NGN|UGX|TZS|RWF)\b/i;
  const plateMatch = clean.match(/\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{1,2}|\d[A-Z]{3}\d{3})\b/i);
  if (plateMatch) {
    const candidate = plateMatch[0].toUpperCase().trim();
    const reservedWords = [
      'REGISTER', 'DIESEL', 'PETROL', 'HYBRID', 'ELECTRIC', 'OWNER', 'DRIVER', 
      'SKIP', 'DONE', 'SERIES', 'MODEL', 'YEAR', 'EMAIL', 'ODOMETER', 'MILEAGE',
      'KES', 'USD', 'EUR', 'GBP', 'ZAR', 'NGN', 'UGX', 'TZS', 'RWF'
    ];
    const startsWithCurrency = currencyRegex.test(candidate);
    if (!startsWithCurrency && !reservedWords.includes(candidate.replace(/\s+/g, '')) && candidate.length <= 10) {
      data.plate_number = candidate;
    }
  }

  // 6. Role: Owner or Driver
  if (/\bdriver\b/i.test(lower)) data.role = 'Driver';
  else if (/\bowner\b/i.test(lower)) data.role = 'Owner';

  // 7. Make & Model
  const knownBrandsRegex = /(?:toyota|nissan|honda|mazda|isuzu|subaru|mitsubishi|mercedes|bmw|volkswagen|vw|audi|ford|hyundai|kia|peugeot|suzuki|volvo|byd|land\s+rover|lexus|porsche|jeep)\s+[A-Za-z0-9\s-]+/i;
  const brandMatch = clean.match(knownBrandsRegex);
  if (brandMatch) {
    let cleanBrand = brandMatch[0].replace(/owner|driver|diesel|petrol|hybrid|electric|km|mileage/gi, '').trim();
    if (cleanBrand.length >= 2) data.make_model = cleanBrand;
  }
  if (!data.make_model) {
    let stripped = clean
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '')
      .replace(/(?:odometer|mileage|reading|clocked)\s*[:=]?\s*[\d,]+/gi, '')
      .replace(/\b[\d,]+\s*(?:km|kms|miles|mi)\b/gi, '')
      .replace(/[\d,.]+\s*(?:operating|engine|machine)?\s*hours?/gi, '')
      .replace(/(?:yom|year)?\s*\b(19[5-9]\d|20[0-2]\d)\b/gi, '')
      .replace(/\b(diesel|petrol|gasoline|hybrid|electric|ev)\b/gi, '')
      .replace(/\b(owner|driver)\b/gi, '')
      .replace(/\b(it's a|its a|it is a|car is|vehicle is|make and model is|make is|model is|make\/model)\b/gi, '')
      .replace(/[,;–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (stripped.length >= 2 && !/^(register|onboard|add car|help|skip|done|resend|great|ok|okay|awesome|cool|thanks|thank you|none|good|perfect|all set)$/i.test(stripped) && !/^\d+$/.test(stripped)) {
      const isPlate = /\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}|\d[A-Z]{3}\d{3})\b/i.test(stripped);
      if (!isPlate && (!data.plate_number || stripped.replace(/\s+/g, '').toUpperCase() !== data.plate_number.replace(/\s+/g, '').toUpperCase())) {
        data.make_model = stripped;
      }
    }
  }

  // 8. Optional Fields
  if (/\b(automatic|auto)\b/i.test(lower)) data.transmission = 'Automatic';
  else if (/\bmanual\b/i.test(lower)) data.transmission = 'Manual';

  const colorMatch = clean.match(/\b(white|black|silver|grey|gray|blue|red|green|yellow|gold|brown|orange|maroon|beige)\b/i);
  if (colorMatch) data.color = colorMatch[1].charAt(0).toUpperCase() + colorMatch[1].slice(1).toLowerCase();

  const phoneMatchPattern = /(?:\+?254|0)[17]\d{8}|\+?\d{9,15}/;
  const driverPhoneMatch = clean.match(phoneMatchPattern);
  if (driverPhoneMatch) {
    data.driver_phone = driverPhoneMatch[0];
  }

  const vinMatch = clean.match(/\b(?:vin|chassis)?\s*[:=]?\s*([A-HJ-NPR-Z0-9]{11,17})\b/i);
  if (vinMatch && !/^(diesel|petrol|hybrid|toyota|nissan|fielder|automatic|owner|driver)$/i.test(vinMatch[1])) {
    const candidateVin = vinMatch[1].toUpperCase();
    if (!phoneMatchPattern.test(candidateVin)) {
      data.vin = candidateVin;
    }
  }

  const engMatch = clean.match(/(?:engine|eng)\s*(?:no|number|#)?\s*[:=]?\s*([A-Z0-9-]+)/i);
  if (engMatch) data.engine_number = engMatch[1].toUpperCase();

  const tireMatch = clean.match(/\b(\d{3}\/\d{2}[R|r]\d{2})\b/);
  if (tireMatch) data.tire_size = tireMatch[1];

  const dateIsoMatch = clean.match(/\b(\d{4}[-/]\d{2}[-/]\d{2})\b/);
  if (dateIsoMatch) {
    data.insurance_expiry = dateIsoMatch[1].replace(/\//g, '-');
  } else {
    const dateRevMatch = clean.match(/\b(\d{2}[-/]\d{2}[-/]\d{4})\b/);
    if (dateRevMatch) {
      const parts = dateRevMatch[1].split(/[-/]/);
      data.insurance_expiry = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }

  const policyMatch = clean.match(/(?:policy|insurance\s+policy)\s*[:=]?\s*([A-Z0-9-/]+)/i);
  if (policyMatch) data.insurance_policy = policyMatch[1];

  const costMatch = clean.match(/(?:purchase\s+cost|bought\s+for|cost|price)\s*[:=]?\s*(?:kes|usd)?\s*([\d,]+(?:\.\d+)?)/i);
  if (costMatch) data.purchase_cost = parseFloat(costMatch[1].replace(/,/g, ''));

  const isStandaloneOtp = /^\s*\d{6}\s*$/.test(clean);
  const labeledOtpMatch = clean.match(/(?:otp|code|verification)\s*[:=]?\s*(\d{6})\b/i);
  if (isStandaloneOtp) {
    data.otp_code = clean.trim();
  } else if (labeledOtpMatch) {
    data.otp_code = labeledOtpMatch[1];
  }

  const customMods = clean.match(/(?:custom|mods|modifications|extras|accessories|specs)\s*[:=]?\s*([^\n\r.]+)/i);
  if (customMods && customMods[1].trim()) {
    data.custom_attributes = { modifications: customMods[1].trim() };
  } else {
    const accessories = [];
    if (/bullbar|bull\s*bar/i.test(clean)) accessories.push('Bullbar');
    if (/winch/i.test(clean)) accessories.push('Winch');
    if (/snorkel/i.test(clean)) accessories.push('Snorkel');
    if (/roof\s*rack/i.test(clean)) accessories.push('Roof Rack');
    if (/lift\s*kit/i.test(clean)) accessories.push('Suspension Lift');
    if (/dual\s*batter(y|ies)/i.test(clean)) accessories.push('Dual Battery System');
    if (/refrigerat(ion|or)|fridge/i.test(clean)) accessories.push('Refrigeration Unit');
    if (/tow\s*(bar|hitch)/i.test(clean)) accessories.push('Tow Hitch');
    if (accessories.length > 0) {
      data.custom_attributes = { modifications: accessories.join(', ') };
    }
  }

  // 9. Liters / Fuel Volume
  const litersMatch = clean.match(/\b(\d+(?:\.\d+)?)\s*(?:l|liters|litres)\b/i);
  if (litersMatch) {
    const lVal = parseFloat(litersMatch[1]);
    if (!isNaN(lVal) && lVal > 0) {
      data.fuel_liters = lVal;
      data.liters = lVal;
    }
  }

  // 10. Amount / Cost
  const amtMatch = clean.match(/(?:kes|usd|gbp|eur|spent|paid|cost|for)\s*[:=]?\s*([\d,]+(?:\.\d+)?)/i) ||
                   clean.match(/([\d,]+(?:\.\d+)?)\s*(?:kes|usd|gbp|eur)\b/i);
  if (amtMatch) {
    const aVal = parseFloat(amtMatch[1].replace(/,/g, ''));
    if (!isNaN(aVal) && aVal > 0) {
      data.amount = aVal;
    }
  }

  // 11. Vehicle Switching Target
  const switchTargetMatch = clean.match(/(?:switch(?:\s+to)?|manage|select)\s+(?:car|vehicle)?\s*([A-Za-z0-9\s-]+)$/i);
  if (switchTargetMatch && !/^(skip|done|cancel|resend|help)$/i.test(switchTargetMatch[1].trim())) {
    data.target_vehicle = switchTargetMatch[1].trim();
  }

  if (/\b(skip|done|later|finish|not now|no thanks)\b/i.test(lower)) {
    data.skip_or_done = true;
  }

  return data;
}

/**
 * Smart Regex Intent Classifier for Offline/Fallback Handling
 */
export function classifyIntentWithRegex(messageText = '') {
  const clean = messageText.trim().toLowerCase();

  // Subscription & trial intents (v1.15.0) — deterministic fast path.
  if (/^(?:extend|extension)\s+(?:my\s+)?trial\b/i.test(clean) || /^trial\s+extension\b/i.test(clean)) {
    return { intent: 'EXTEND_TRIAL', extracted_data: { notes: clean }, reply_message: 'Checking your trial extension options...' };
  }
  if (/^keep\s+(?:vehicle\s+|car\s+)?[A-Za-z0-9 -]+$/i.test(clean)) {
    const match = messageText.match(/^keep\s+(?:vehicle\s+|car\s+)?(.+)$/i);
    return {
      intent: 'KEEP_VEHICLE',
      extracted_data: { target_vehicle: match ? match[1].trim() : null },
      reply_message: 'Keeping that vehicle active...'
    };
  }
  if (/\b(?:add[- ]?on|extra\s+(?:car|vehicle|slot)|additional\s+(?:car|vehicle|slot))\b/i.test(clean)) {
    return { intent: 'MANAGE_ADDONS', extracted_data: {}, reply_message: 'Checking Fleet Command add-ons...' };
  }
  if (/^(?:cancel|stop)\s+(?:my\s+)?(?:subscription|plan|billing)\b/i.test(clean) || /^unsubscribe\b/i.test(clean)) {
    return { intent: 'CANCEL_SUBSCRIPTION', extracted_data: {}, reply_message: 'Reviewing your cancellation options...' };
  }
  if (/\b(?:upgrade|subscribe|go\s+(?:pro|paid)|switch\s+(?:to\s+)?(?:solo|team|growth|fleet))\b/i.test(clean)) {
    const tierMatch = clean.match(/\b(solo(?:\s*pro)?|team(?:\s*fleet)?|growth(?:\s*fleet)?|fleet\s*command|pro)\b/i);
    const intervalMatch = clean.match(/\b(annual|annually|yearly|year|monthly|month)\b/i);
    return {
      intent: 'UPGRADE_SUBSCRIPTION',
      extracted_data: {
        subscription_tier: tierMatch ? tierMatch[1] : null,
        billing_interval: intervalMatch ? intervalMatch[1] : null
      },
      reply_message: 'Checking your upgrade options...'
    };
  }
  if (/^(?:subscription|my\s+(?:plan|subscription)|billing|plan\s+details|show\s+(?:my\s+)?(?:plan|subscription))\b/i.test(clean)) {
    return { intent: 'VIEW_SUBSCRIPTION', extracted_data: {}, reply_message: 'Fetching your plan details...' };
  }

  // Transfer Passbook Intent (e.g. "transfer passbook KDA 123A", "passbook transfer")
  if (/^transfer\s+passbook\b/i.test(clean) || /^passbook\s+transfer\b/i.test(clean)) {
    const match = messageText.match(/(?:transfer\s+passbook|passbook\s+transfer)\s*([A-Za-z0-9\s-]+)?/i);
    const candidate = match && match[1] ? match[1].trim() : null;
    return {
      intent: 'TRANSFER_PASSBOOK',
      extracted_data: { target_vehicle: candidate, plate_number: candidate },
      reply_message: 'Initiating secure passbook transfer...'
    };
  }

  // Conversational Action Discovery (e.g. "What can I do?", "Show my actions as an owner", "Show my actions as a driver")
  if (/\b(?:what\s+can\s+i\s+do|show\s+my\s+actions|my\s+actions|show\s+actions|what\s+are\s+my\s+commands|available\s+commands|what\s+actions)\b/i.test(clean)) {
    const roleMatch = clean.match(/\b(owner|driver|admin|superadmin)\b/i);
    return {
      intent: 'ACTION_DISCOVERY',
      extracted_data: { role: roleMatch ? roleMatch[1].toLowerCase() : null },
      reply_message: 'Displaying available actions and tools for your account...'
    };
  }

  // Vehicle Editing (VIN / passbook token are immutable and never editable)
  if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(clean) ||
      /^(?:edit|update|change|modify)\s+(?:the\s+)?(?:make|model|make_model|year|yom|fuel|color|colour|transmission|engine|tire|tyre|insurance|inspection|plate)\b/i.test(clean)) {
    const attrs = extractVehicleAttributes(messageText);
    const fieldMatch = messageText.match(/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)?\s*([a-z_ ]+?)\s+(?:to|as|=)\s+(.+)$/i);
    return {
      intent: 'EDIT_VEHICLE',
      extracted_data: {
        ...attrs,
        edit_field: fieldMatch ? fieldMatch[1].trim().toLowerCase().replace(/\s+/g, '_') : null,
        edit_value: fieldMatch ? fieldMatch[2].trim() : null
      },
      reply_message: 'Opening vehicle edit options...'
    };
  }

  // Vehicle Deletion (soft-delete + driver unassignment; historical logs + VIN ledger preserved)
  if (/^(?:delete|remove|discard|scrap|decommission)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(clean) ||
      /^(?:delete|remove)\s+[A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}\b/i.test(messageText)) {
    const attrs = extractVehicleAttributes(messageText);
    return {
      intent: 'DELETE_VEHICLE',
      extracted_data: attrs,
      reply_message: 'Starting vehicle deletion...'
    };
  }

  // Profile Viewing (must win over the edit_profile wizard)
  if (/^(?:view|show|display|see)\s+(?:my\s+)?(?:profile|account)|^my\s+profile\b|^profile\s+details$|^profile$|^account\s+details$|^who\s+am\s+i$|^what\s+do\s+you\s+know\s+about\s+me$/i.test(clean)) {
    return {
      intent: 'VIEW_PROFILE',
      extracted_data: {},
      reply_message: 'Here is your profile snapshot.'
    };
  }

  // Profile / Contact / Settings Editing
  if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:profile|details|name|language|units?|unit\s+system|settings|contact)\b/i.test(clean)) {
    const nameMatch = messageText.match(/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:full\s+)?name\s+(?:to|as|=)\s+(.+)$/i);
    const langMatch = clean.match(/\b(english|swahili|french|spanish|german|arabic)\b/i);
    const unitMatch = clean.match(/\b(metric|imperial)\b/i);
    return {
      intent: 'EDIT_PROFILE',
      extracted_data: {
        full_name: nameMatch ? nameMatch[1].trim() : null,
        preferred_language: langMatch ? (langMatch[1][0].toUpperCase() + langMatch[1].slice(1).toLowerCase()) : null,
        unit_system: unitMatch ? unitMatch[1].toLowerCase() : null
      },
      reply_message: 'Opening your profile settings...'
    };
  }

  // Account Deletion (soft-delete gated by email OTP)
  if (/^(?:delete|deactivate|close|remove)\s+(?:my\s+)?account\b/i.test(clean)) {
    return {
      intent: 'DELETE_ACCOUNT',
      extracted_data: {},
      reply_message: 'Starting account deletion...'
    };
  }

  // Trial Extension Coupon Intent (e.g. "Yes", "yes please", "apply coupon", or specific code)
  if (/^(yes|yes please|apply coupon|extend trial|extend)$/i.test(clean) || /^EXT30-[A-Z0-9]+$/i.test(clean)) {
    const codeMatch = clean.match(/EXT30-[A-Z0-9]+/i);
    return {
      intent: 'APPLY_COUPON',
      extracted_data: { coupon_code: codeMatch ? codeMatch[0].toUpperCase() : null },
      reply_message: 'Applying trial extension coupon...'
    };
  }

  // OTP Verification Intent (6-digit standalone code or "otp: 123456")
  if (/^\s*\d{6}\s*$/.test(clean) || /^(?:otp|code)\s*[:=]?\s*\d{6}$/i.test(clean)) {
    const codeMatch = clean.match(/\d{6}/);
    return {
      intent: 'VERIFY_OTP',
      extracted_data: { otp_code: codeMatch ? codeMatch[0] : null },
      reply_message: 'Verifying your 6-digit email code...'
    };
  }

  // Resend OTP
  if (/^resend(\s+otp|\s+code)?$/i.test(clean)) {
    return {
      intent: 'RESEND_OTP',
      extracted_data: {},
      reply_message: 'Resending verification code to your email...'
    };
  }

  // Vehicle Switching Intent (e.g. "switch to Demio", "manage KDA 123A", "switch to car 2")
  const switchMatch = messageText.match(/^(?:switch(?:\s+to)?|manage|select)\s+(?:car|vehicle)?\s*([A-Za-z0-9\s-]+)$/i);
  if (switchMatch && !/^(skip|done|cancel|resend|help)$/i.test(switchMatch[1].trim())) {
    const candidate = switchMatch[1].trim();
    const attrs = extractVehicleAttributes(messageText);
    return {
      intent: 'SWITCH_VEHICLE',
      extracted_data: {
        ...attrs,
        target_vehicle: candidate
      },
      reply_message: `Switching active vehicle to ${candidate}...`
    };
  }

  // Fuel Consumption & Efficiency Query Intent
  if (/\b(?:fuel\s+consumption|fuel\s+efficiency|km\/l|km\s*per\s*liter|km\s*per\s*litre|consumption|mpg|l\/100km)\b/i.test(clean)) {
    const attrs = extractVehicleAttributes(messageText);
    return {
      intent: 'QUERY_FUEL_EFFICIENCY',
      extracted_data: attrs,
      reply_message: `Analyzing fuel consumption for ${attrs.plate_number || 'your active vehicle'}...`
    };
  }

  // Fleet / Vehicle Summary Query Intent
  if (/\b(?:fleet\s+summary|car\s+summary|vehicle\s+status|fleet\s+status|vehicle\s+summary|digest)\b/i.test(clean)) {
    const attrs = extractVehicleAttributes(messageText);
    return {
      intent: 'QUERY_FLEET_SUMMARY',
      extracted_data: attrs,
      reply_message: "Retrieving vehicle and fleet summary report..."
    };
  }

  // Update Email
  if (/^(?:update|change)\s+email\b/i.test(clean)) {
    const emailMatch = clean.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return {
      intent: 'UPDATE_EMAIL',
      extracted_data: { owner_email: emailMatch ? emailMatch[0] : null },
      reply_message: 'Updating registered email address...'
    };
  }
  
  if (/^(hi|hello|hey|habari|mambo|greetings|jambo|good morning|good afternoon|good evening)\b/i.test(clean)) {
    return {
      intent: 'GREETING',
      extracted_data: {},
      reply_message: "👋 Welcome to Saka Fleet! I'm your intelligent WhatsApp vehicle & asset management assistant."
    };
  }

  // Numeric menu choices (1-5)
  if (/^(1|1️⃣)$/.test(clean)) {
    return {
      intent: 'LOG_EXPENSE',
      extracted_data: {},
      reply_message: "⛽ *Log Expense / Fuel*\n\nPlease reply with your expense details (e.g. *\"Logged fuel KES 3000\"*)."
    };
  }
  if (/^(2|2️⃣)$/.test(clean)) {
    return {
      intent: 'UPDATE_MILEAGE',
      extracted_data: {},
      reply_message: "📈 *Update Mileage / Odometer*\n\nPlease reply with your updated odometer reading (e.g. *\"Odometer 45000 km\"*)."
    };
  }
  if (/^(3|3️⃣)$/.test(clean)) {
    return {
      intent: 'SET_REMINDER',
      extracted_data: {},
      reply_message: "🔔 *Set Reminder*\n\nReply with the item and its date, distance or operating hours (e.g. *\"Remind oil change in 5000 km\"* or *\"Insurance expires on 15th Dec 2026\"*)."
    };
  }
  if (/^(4|4️⃣)$/.test(clean)) {
    return {
      intent: 'LOG_EARNINGS',
      extracted_data: {},
      reply_message: "💰 *Log Earnings*\n\nPlease reply with your revenue details (e.g. *\"Earned KES 5000 today\"*)."
    };
  }
  if (/^(5|5️⃣)$/.test(clean)) {
    return {
      intent: 'REQUEST_REPORT',
      extracted_data: {},
      reply_message: "📊 *View Reports & Summary*\n\nRequesting your fleet report summary..."
    };
  }

  // Priority: Check if message contains vehicle asset attributes or Stage 2 Skip/Done
  const attrs = extractVehicleAttributes(messageText);
  if (attrs.skip_or_done) {
    return {
      intent: 'ONBOARDING_SKIP',
      extracted_data: attrs,
      reply_message: "Skipping optional specs."
    };
  }

  const hasVehicleCoreAttrs = attrs.owner_email || (attrs.yom && (attrs.fuel_type || attrs.make_model || attrs.current_mileage)) || (attrs.fuel_type && attrs.current_mileage && attrs.make_model);
  const hasOptionalSpecs = attrs.insurance_expiry || attrs.transmission || attrs.vin || attrs.color || attrs.tire_size;

  if (hasVehicleCoreAttrs || hasOptionalSpecs) {
    return {
      intent: hasVehicleCoreAttrs ? 'REGISTER_VEHICLE' : 'ONBOARDING_INPUT',
      extracted_data: attrs,
      reply_message: "Got your vehicle details!"
    };
  }

  // Threshold-reminder phrasing wins over logging intents (e.g. "oil change in 36 operating hours").
  const looksLikeReminder = /remind|reminder|service in|due in|alert/i.test(clean) ||
    /\b(?:in|after|every|within)\s*\d[\d.,]*\s*(?:km|kms|kilometers?|kilometres?|miles?|mi|(?:operating|engine|machine|running|work)?\s*(?:hours?|hrs?))\b/i.test(clean);

  // Operating / engine hours logging
  if (!looksLikeReminder && /operating hours|engine hours|machine hours|running hours|log hours|update hours|record hours|hours reading|hours now/i.test(clean)) {
    const hoursVal = attrs.operating_hours !== undefined ? attrs.operating_hours : null;
    return {
      intent: 'LOG_OPERATING_HOURS',
      extracted_data: { operating_hours: hoursVal },
      reply_message: 'Updating operating hours.'
    };
  }

  // Odometer / Mileage Update (when not part of a broader vehicle profile)
  // Fuel/expense wording takes priority so "Logged 30L fuel at 50350 km for KES 5500" is not misread as an odometer update.
  const looksLikeExpense = /fuel|expense|spent|refuel|liter|litres|liters|receipt|repair|oil change|maintenance|paid|cost/i.test(clean);
  if (!looksLikeReminder && !looksLikeExpense && /odometer|mileage|\bkm\b|\bmiles\b|reading|clocked/i.test(clean)) {
    const odoVal = attrs.odometer || attrs.current_mileage || null;
    return {
      intent: 'UPDATE_MILEAGE',
      extracted_data: { odometer: odoVal, current_mileage: odoVal },
      reply_message: `Updated odometer reading to ${odoVal ? odoVal.toLocaleString() : 'new reading'}.`
    };
  }

  // Expense / Fuel Logging
  if (!looksLikeReminder && /fuel|expense|spent|kes|usd|gbp|eur|cost|paid|refuel|liter|litres|receipt|repair|oil change|maintenance/i.test(clean)) {
    const amtMatch = clean.match(/[\d,]+(?:\.\d+)?/);
    const amtVal = amtMatch ? parseFloat(amtMatch[0].replace(/,/g, '')) : null;
    return {
      intent: 'LOG_EXPENSE',
      extracted_data: { amount: amtVal },
      reply_message: `Logged expense of ${amtVal ? amtVal.toLocaleString() : 'amount'}.`
    };
  }

  // Earnings Logging
  if (/earned|earnings|revenue|income|fare|trip/i.test(clean)) {
    const amtMatch = clean.match(/[\d,]+(?:\.\d+)?/);
    const amtVal = amtMatch ? parseFloat(amtMatch[0].replace(/,/g, '')) : null;
    return {
      intent: 'LOG_EARNINGS',
      extracted_data: { amount: amtVal },
      reply_message: `Logged earnings of ${amtVal ? amtVal.toLocaleString() : 'amount'}.`
    };
  }

  // Reminders
  // Reminders - unit-aware (km, miles, operating hours)
  if (looksLikeReminder) {
    return {
      intent: 'SET_REMINDER',
      extracted_data: {},
      reply_message: "Service reminder set."
    };
  }

  // Reports
  if (/report|summary|statement|audit/i.test(clean)) {
    return {
      intent: 'REQUEST_REPORT',
      extracted_data: {},
      reply_message: "Generating report summary..."
    };
  }
  if (/\b(support|human|agent|representative|talk to a person|admin intervention|file a complaint|escalat(e|ion)|dispute|help from human|talk to support|contact support|customer care)\b/i.test(clean)) {
    return {
      intent: 'CONTACT_SUPPORT',
      extracted_data: {},
      reply_message: "Please write out a description of your issue in a single paragraph so our support team can assist you."
    };
  }



  if (/register|onboard|add car|add vehicle|new vehicle|can i register/i.test(clean)) {
    const rawPlate = messageText.match(/\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}|\d[A-Z]{3}\d{3})\b/i);
    const candidatePlate = rawPlate && !/^(register|onboard|add car|add vehicle|new vehicle|can i register)$/i.test(rawPlate[0])
      ? rawPlate[0].toUpperCase().trim()
      : null;
    return {
      intent: 'REGISTER_VEHICLE',
      extracted_data: {
        plate_number: candidatePlate
      },
      reply_message: "Sure! Let's get your vehicle onboarded to Saka Fleet."
    };
  }

  if (/what do you do|how does|features|commands|help\b/i.test(clean)) {
    return {
      intent: 'APP_HELP',
      extracted_data: {},
      reply_message: "🚗 *Saka Fleet Features:*\n\n• Track Fuel & Expenses\n• Odometer & Maintenance Reminders\n• Earnings Tracking & Monthly PDF Reports"
    };
  }

  if (/manage vehicle|my cars|my vehicles|vehicle list/i.test(clean)) {
    return {
      intent: 'MANAGE_VEHICLE',
      extracted_data: {},
      reply_message: "Here are your vehicle management options."
    };
  }

  // Check if text looks like a standalone short plate number e.g. "KDA 123A" or "KBC 456X"
  if (clean.length <= 15) {
    const plateCandidate = messageText.match(/\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}|\d[A-Z]{3}\d{3})\b/i);
    if (plateCandidate && plateCandidate[0].length >= 3 && /[A-Z]/i.test(plateCandidate[0]) && /[0-9]/.test(plateCandidate[0])) {
      const formattedPlate = plateCandidate[0].toUpperCase().trim();
      return {
        intent: 'REGISTER_VEHICLE',
        extracted_data: {
          plate_number: formattedPlate
        },
        reply_message: `Got registration plate ${formattedPlate}!`
      };
    }
  }

  return {
    intent: 'GENERAL_CHAT',
    extracted_data: {},
    reply_message: "I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle or fleet today? You can log expenses, update odometer readings, set service reminders, or view reports."
  };
}

/**
 * Canary escalation (Phase 1, precision-tuned in Phase 2/v1.13.0): decide
 * whether a non-quiz conversational turn deserves the premium Tier-2 model.
 * Deterministic and provider-agnostic — when PREMIUM_MODEL_ENABLED is off,
 * resolveTier() downgrades Tier 2 to Tier 1.
 *
 * Thresholds are exported so the canary suite can assert precision and future
 * telemetry (Superadmin `admin ai-stats`) can drive data-based tuning.
 */
export const ESCALATION_RULES = Object.freeze({
  longTurnChars: 160,
  minFactDigits: 3,
  minHistoryTurns: 6
});

const FRUSTRATION_RE = /\b(stuck|broken|not working|complaint|angry|frustrated|terrible|worst|refund|scam|cheat|report you|fed up|useless)\b/i;
const HIGH_STAKES_RE = /\b(assign\s+driver|unassign|remove\s+driver|transfer|sell\s+(my\s+)?vehicle|passbook|ownership|driver\s+licen[cs]e|compliance|otp)\b/i;
const DISPATCH_RE = /\b(book(?:ing)?|dispatch|pickup|pick\s*up|drop\s*off|drop-off|deliver|hire|rent)\b/i;
// Precision-tuned in v1.13.0: 'request' and 'complete' were removed — they
// promoted informational asks ("request a report") to the premium tier.
const ACTION_VERB_RE = /\b(log|set|update|add|register|assign|transfer)\b/i;

export function classifyIntentTier(messageText = '', conversationHistory = []) {
  const clean = String(messageText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return AI_TIERS.ROUTER;
  if (FRUSTRATION_RE.test(clean) || HIGH_STAKES_RE.test(clean) || DISPATCH_RE.test(clean)) {
    return AI_TIERS.CONVERSATIONAL;
  }
  if (clean.length > ESCALATION_RULES.longTurnChars) return AI_TIERS.CONVERSATIONAL;
  const digitCount = (clean.match(/\d/g) || []).length;
  if (digitCount >= ESCALATION_RULES.minFactDigits && ACTION_VERB_RE.test(clean)) return AI_TIERS.CONVERSATIONAL;
  const historyLength = Array.isArray(conversationHistory) ? conversationHistory.length : 0;
  if (historyLength >= ESCALATION_RULES.minHistoryTurns && /^(why|explain|how come)\b/i.test(clean)) return AI_TIERS.CONVERSATIONAL;
  return AI_TIERS.ROUTER;
}

/**
 * Intelligent message parser and intent classifier for Saka Assistant
 */
export async function processSakaMessage(targetLang = 'English', messageText = '', conversationHistory = [], mediaParts = [], providedSupabase = null, activeVehicleContext = null, options = {}) {
  const { maxAiTier = null, ownerId = null, planSummary = null } = options || {};
  const now = new Date();
  const currentLocalDateTime = now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'medium' });
  const currentIsoDate = now.toISOString().split('T')[0];

  const baseCorePrompt = await getSakaCorePrompt(providedSupabase);

  let fleetContextSection = '';
  if (activeVehicleContext) {
    const { activeVehicle, allVehicles = [] } = activeVehicleContext;
    fleetContextSection = `
USER FLEET ROSTER & ACTIVE VEHICLE CONTEXT:
- Total Vehicles in Fleet: ${allVehicles.length}
- Active / Currently Selected Vehicle: ${activeVehicle ? `${activeVehicle.plate_number} (${activeVehicle.make_model || 'Vehicle'}, Fuel: ${activeVehicle.fuel_type || 'Fuel'}, Odometer: ${activeVehicle.current_mileage || activeVehicle.odometer_reading || 0} km)` : 'None'}
- All Fleet Vehicles:
${allVehicles.map((v, i) => `  ${i + 1}. [${activeVehicle?.id === v.id ? 'CURRENTLY ACTIVE' : 'INACTIVE'}] ${v.plate_number} - ${v.make_model || 'Vehicle'} (Fuel: ${v.fuel_type || 'Fuel'}, Odo: ${v.current_mileage || v.odometer_reading || 0} km)`).join('\n')}
`;
  }

  const systemInstruction = `
${baseCorePrompt}

RUNTIME DYNAMIC CONTEXT:
- Current Server Date & Time: ${currentLocalDateTime} (ISO Baseline: ${currentIsoDate})
- User Preferred Language: ${targetLang}
- User Unit System: ${activeVehicleContext?.activeVehicle?.unit_system || 'metric'} (display distances/volumes in this system; store canonical km/litres)
- Global Audience: localize currency, dates and plate examples to the user's country; never assume a region.
${planSummary ? `- Subscription context: ${planSummary} (quote only limits/prices the engine supplied)` : ''}
${fleetContextSection}
`;

  const cleanHistory = normalizeHistory(conversationHistory);
  const intentTier = classifyIntentTier(messageText, conversationHistory);

  const aiResult = await chatCompletion({
    system: systemInstruction,
    messages: [
      ...cleanHistory,
      { role: 'user', content: messageText }
    ],
    jsonMode: true,
    maxTokens: 800,
    temperature: 0.3,
    purpose: 'intent_classify',
    tier: intentTier,
    maxTier: maxAiTier,
    ownerId
  });

  if (aiResult.ok) {
    const parsed = parseJsonSafely(aiResult.text);
    if (parsed && parsed.intent && parsed.reply_message) {
      // Null-safe merge: DeepSeek emits every schema key, frequently as explicit
      // `null`. A raw spread would wipe regex-extracted values (plate, VIN, odometer…),
      // so only non-empty AI values are allowed to override the regex heuristic.
      const regexAttrs = extractVehicleAttributes(messageText);
      const aiAttrs = parsed.extracted_data && typeof parsed.extracted_data === 'object'
        ? parsed.extracted_data
        : {};

      const meaningfulAiAttrs = {};
      for (const [key, value] of Object.entries(aiAttrs)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
        meaningfulAiAttrs[key] = value;
      }

      parsed.extracted_data = { ...regexAttrs, ...meaningfulAiAttrs };
      return parsed;
    }
    console.warn('[sakaAi] DeepSeek returned non-conforming JSON, using regex classifier.');
  } else if (aiResult.error) {
    console.warn('[sakaAi] DeepSeek unavailable, falling back to regex classifier:', aiResult.error?.message || aiResult.error);
  }

  return classifyIntentWithRegex(messageText);
}