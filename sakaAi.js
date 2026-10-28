import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

// Lazy Gemini Client Initializer
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing in environment');
  return new GoogleGenAI({ apiKey });
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

export const DEFAULT_SAKA_CORE_PROMPT = `You are Saka, an intelligent autonomous agent and WhatsApp fleet operating assistant for Saka Fleet.
You sit directly between the user and the fleet database: collecting, parsing, logging information to the database, and retrieving specific analytics and data requested by the user.

INTENT CLASSIFICATION & AGENT ACTIONS:
Analyze the incoming message, conversation context, and user fleet roster to classify the user's intent into a JSON object matching this schema:
{
  "intent": "GREETING" | "ACTION_DISCOVERY" | "TRANSFER_PASSBOOK" | "APPLY_COUPON" | "REGISTER_VEHICLE" | "ONBOARDING_INPUT" | "ONBOARDING_SKIP" | "VERIFY_OTP" | "RESEND_OTP" | "UPDATE_EMAIL" | "APP_HELP" | "MANAGE_VEHICLE" | "LIST_VEHICLES" | "SWITCH_VEHICLE" | "QUERY_FUEL_EFFICIENCY" | "QUERY_FLEET_SUMMARY" | "LOG_EXPENSE" | "UPDATE_MILEAGE" | "LOG_EARNINGS" | "SET_REMINDER" | "COMPLETE_REMINDER" | "REQUEST_REPORT" | "CONTACT_SUPPORT" | "REACTIVATE_ACCOUNT" | "GENERAL_CHAT" | "ASSIGN_DRIVER" | "UNASSIGN_DRIVER",
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
    "amount": number | null,
    "fuel_liters": number | null,
    "liters": number | null,
    "expense_type": string | null,
    "notes": string | null,
    "preferred_language": string | null,
    "role": string | null,
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
    "skip_or_done": boolean | null
  },
  "reply_message": string
}

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

5. DRIVER ASSIGNMENT:
   - ASSIGN_DRIVER: Triggered when a user asks to assign a driver to a vehicle. (e.g. "Assign driver +254711223344", "assign KAS to driver +254700000000").
   - UNASSIGN_DRIVER: Triggered when user asks to remove/unassign a driver.
   - Driver assignments ARE natively supported on WhatsApp. Do NOT tell the user to use a web portal. Extract the target vehicle plate into "plate_number" and the driver's phone into "driver_phone".

4. TWO-STAGE PROGRESSIVE ONBOARDING:
   - Stage 1 Core: plate_number, make_model, yom, fuel_type, current_mileage, vin (immutable chassis number), owner_email, otp_code, role ('Owner' | 'Driver').
   - Stage 2 Optional: insurance_expiry, inspection_expiry, engine_number, color, transmission, tire_size, purchase_cost, custom_attributes.

CRITICAL CONTEXT & TIME-AWARENESS:
- Resolve relative date references (such as "today", "tomorrow", "next Monday") into absolute calendar dates YYYY-MM-DD.
- Keep reply_message concise, friendly, and clean plain text formatted for WhatsApp.
- Output ONLY valid JSON matching the schema.`;

/**
 * Check system_config and active dynamic micro-rules in Supabase,
 * dynamically injecting active patches (is_active = TRUE) as behavioral hints.
 */
export async function getSakaCorePrompt(providedSupabase = null) {
  const client = providedSupabase || defaultSupabase;
  let basePrompt = DEFAULT_SAKA_CORE_PROMPT;
  if (!client) return basePrompt;

  try {
    const { data: configData } = await client
      .from('system_config')
      .select('value')
      .eq('key', 'saka_core_prompt')
      .maybeSingle();

    if (configData && configData.value) {
      basePrompt = `${basePrompt}\n\nSENTINEL PROMPT REFINEMENT:\n${configData.value}`;
    }

    // Inject active dynamic micro-rules at runtime
    const { data: dynamicRules, error: rulesErr } = await client
      .from('saka_dynamic_rules')
      .select('rule_key, patch_instruction')
      .eq('is_active', true);

    if (!rulesErr && dynamicRules && dynamicRules.length > 0) {
      const activePatches = dynamicRules
        .map(r => `• [${r.rule_key}]: ${r.patch_instruction}`)
        .join('\n');
      basePrompt = `${basePrompt}\n\nACTIVE SENTINEL DYNAMIC MICRO-RULES (BEHAVIORAL HINTS):\n${activePatches}`;
    }

    return `${basePrompt}\n\nREMINDER: You MUST output ONLY valid JSON matching the schema.`;
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
      reply_message: "🔔 *Set Service Reminder*\n\nPlease reply with your service reminder details (e.g. *\"Remind oil change in 5000 km\"*)."
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

  // Odometer / Mileage Update (when not part of a broader vehicle profile)
  // Fuel/expense wording takes priority so "Logged 30L fuel at 50350 km for KES 5500" is not misread as an odometer update.
  const looksLikeExpense = /fuel|expense|spent|refuel|liter|litres|liters|receipt|repair|oil change|maintenance|paid|cost/i.test(clean);
  if (!looksLikeExpense && /odometer|mileage|\bkm\b|\bmiles\b|reading|clocked/i.test(clean)) {
    const odoVal = attrs.odometer || attrs.current_mileage || null;
    return {
      intent: 'UPDATE_MILEAGE',
      extracted_data: { odometer: odoVal, current_mileage: odoVal },
      reply_message: `Updated odometer reading to ${odoVal ? odoVal.toLocaleString() : 'new reading'}.`
    };
  }

  // Expense / Fuel Logging
  if (/fuel|expense|spent|kes|usd|gbp|eur|cost|paid|refuel|liter|litres|receipt|repair|oil change|maintenance/i.test(clean)) {
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
  if (/remind|reminder|service in|due in|alert/i.test(clean)) {
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
 * Intelligent message parser and intent classifier for Saka Assistant
 */
export async function processSakaMessage(targetLang = 'English', messageText = '', conversationHistory = [], mediaParts = [], providedSupabase = null, activeVehicleContext = null) {
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
${fleetContextSection}
`;

  const userParts = [{ text: messageText }];
  if (mediaParts && mediaParts.length > 0) {
    userParts.push(...mediaParts);
  }

  const cleanHistory = [];
  if (Array.isArray(conversationHistory)) {
    for (const item of conversationHistory) {
      if (item && item.role && item.parts) {
        cleanHistory.push(item);
      }
    }
  }

  const candidateModels = Array.from(new Set([
    'gemini-3.8-flash',
    process.env.GEMINI_MODEL,
    'gemini-flash-latest'
  ].filter(Boolean)));

  for (const selectedModel of candidateModels) {
    try {
      const response = await getGeminiClient().models.generateContent({
        model: selectedModel,
        contents: [
          ...cleanHistory,
          { role: 'user', parts: userParts }
        ],
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: 'application/json',
        }
      });

      const rawText = response.text ? response.text.trim() : '';
      const cleanedJsonText = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/, '');

      const parsed = JSON.parse(cleanedJsonText);
      if (parsed && parsed.intent && parsed.reply_message) {
        const regexAttrs = extractVehicleAttributes(messageText);
        parsed.extracted_data = {
          ...regexAttrs,
          ...(parsed.extracted_data || {})
        };
        return parsed;
      }
    } catch (err) {
      console.warn(`Saka AI generation attempt with model '${selectedModel}' failed:`, err.message);
    }
  }

  return classifyIntentWithRegex(messageText);
}