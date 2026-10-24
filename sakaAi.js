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

export const DEFAULT_SAKA_CORE_PROMPT = `You are Saka, an intelligent, warm, and professional WhatsApp assistant for Saka Fleet, an international intelligent vehicle and asset management system.

INTENT CLASSIFICATION & PROGRESSIVE ONBOARDING REQUIREMENTS:
Analyze the incoming message and conversation context to classify the user's intent into a JSON object matching this schema:
{
  "intent": "GREETING" | "REGISTER_VEHICLE" | "ONBOARDING_INPUT" | "ONBOARDING_SKIP" | "APP_HELP" | "MANAGE_VEHICLE" | "LIST_VEHICLES" | "LOG_EXPENSE" | "UPDATE_MILEAGE" | "LOG_EARNINGS" | "SET_REMINDER" | "COMPLETE_REMINDER" | "REQUEST_REPORT" | "CONTACT_SUPPORT" | "REACTIVATE_ACCOUNT" | "GENERAL_CHAT",
  "extracted_data": {
    "plate_number": string | null,
    "make_model": string | null,
    "yom": number | null,
    "year": number | null,
    "owner_email": string | null,
    "fuel_type": string | null,
    "current_mileage": number | null,
    "odometer": number | null,
    "amount": number | null,
    "preferred_language": string | null,
    "role": string | null,
    "vin": string | null,
    "engine_number": string | null,
    "color": string | null,
    "transmission": string | null,
    "tire_size": string | null,
    "insurance_policy": string | null,
    "insurance_expiry": string | null,
    "inspection_expiry": string | null,
    "purchase_cost": number | null,
    "skip_or_done": boolean | null
  },
  "reply_message": string
}

TWO-STAGE PROGRESSIVE ONBOARDING & SPEC EXTRACTION RULES:
1. Stage 1 (Core Capture):
   When a user registers or describes their vehicle, intelligently extract all available core fields from unstructured input without rigid looping:
   - plate_number: License plate (e.g., 'KDA 123A', 'KBC 456X').
   - make_model: Vehicle brand & model (e.g., 'Toyota Land Cruiser 80 series', '80 series', 'Toyota Fielder').
   - yom: Year of manufacture as integer (e.g., 1991, 2018).
   - owner_email: User/owner email address (e.g., 'user@mail.com').
   - fuel_type: Powertrain fuel type ('Diesel', 'Petrol', 'Hybrid', 'Electric').
   - current_mileage: Odometer reading as integer (e.g., 366700, 45000).
   - role: 'Owner' or 'Driver'.

2. Stage 2 (Optional Specs Weaving):
   When invited to share optional compliance or mechanical specs:
   - insurance_expiry: Insurance expiration date formatted as YYYY-MM-DD.
   - inspection_expiry: Vehicle inspection/NTAC expiry formatted as YYYY-MM-DD.
   - vin: Vehicle chassis/VIN number (11-17 characters).
   - engine_number: Engine serial identifier.
   - color: Vehicle exterior color (e.g., 'White', 'Silver').
   - transmission: 'Automatic' or 'Manual'.
   - tire_size: Tire size specification (e.g., '265/70R16').
   - insurance_policy: Insurance policy identifier.
   - purchase_cost: Asset purchase cost amount.
   - skip_or_done: Set to true if user replies 'skip', 'done', 'later', 'no thanks'.

3. General Features (Expenses, Mileage, Earnings, Reports):
   - LOG_EXPENSE: Fuel receipts, repairs, spare parts.
   - UPDATE_MILEAGE: Odometer updates for existing vehicles.
   - LOG_EARNINGS: Trip revenue, daily taxi/haulage income.
   - SET_REMINDER: Maintenance, oil change, service alerts.
   - REQUEST_REPORT: Monthly PDF statements, auto-audits.

CRITICAL CONTEXT & TIME-AWARENESS:
- RELATIVE DATE RESOLUTION: You MUST resolve relative date references (such as "today", "tomorrow", "next Monday") into absolute calendar dates YYYY-MM-DD.
- Keep reply_message concise, friendly, and clean plain text formatted for WhatsApp.
- Output ONLY valid JSON matching the schema.`;

/**
 * Check system_config table in Supabase for saka_core_prompt, falling back to default prompt if query fails.
 */
export async function getSakaCorePrompt(providedSupabase = null) {
  const client = providedSupabase || defaultSupabase;
  if (!client) return DEFAULT_SAKA_CORE_PROMPT;

  try {
    const { data, error } = await client
      .from('system_config')
      .select('value')
      .eq('key', 'saka_core_prompt')
      .single();

    if (error || !data || !data.value) {
      return DEFAULT_SAKA_CORE_PROMPT;
    }
    return `${DEFAULT_SAKA_CORE_PROMPT}\n\nSENTINEL DYNAMIC REFINEMENTS:\n${data.value}\n\nREMINDER: You MUST output ONLY valid JSON matching the schema.`;
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

  // 5. Plate Number
  const plateMatch = clean.match(/\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}|\d[A-Z]{3}\d{3})\b/i);
  if (plateMatch) {
    const candidate = plateMatch[0].toUpperCase().trim();
    const reservedWords = ['REGISTER', 'DIESEL', 'PETROL', 'HYBRID', 'ELECTRIC', 'OWNER', 'DRIVER', 'SKIP', 'DONE', 'SERIES', 'MODEL', 'YEAR', 'EMAIL', 'ODOMETER', 'MILEAGE'];
    if (!reservedWords.includes(candidate.replace(/\s+/g, '')) && candidate.length <= 10) {
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

    if (stripped.length >= 2 && !/^(register|onboard|add car|help|skip|done)$/i.test(stripped)) {
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

  const vinMatch = clean.match(/\b(?:vin|chassis)?\s*[:=]?\s*([A-HJ-NPR-Z0-9]{11,17})\b/i);
  if (vinMatch && !/^(diesel|petrol|hybrid|toyota|nissan|fielder|automatic|owner|driver)$/i.test(vinMatch[1])) {
    data.vin = vinMatch[1].toUpperCase();
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
  if (/odometer|mileage|\bkm\b|\bmiles\b|reading|clocked/i.test(clean)) {
    const odoMatch = clean.match(/[\d,]+/);
    const odoVal = odoMatch ? parseInt(odoMatch[0].replace(/,/g, ''), 10) : null;
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
export async function processSakaMessage(targetLang = 'English', messageText = '', conversationHistory = [], mediaParts = [], providedSupabase = null) {
  const now = new Date();
  const currentLocalDateTime = now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'medium' });
  const currentIsoDate = now.toISOString().split('T')[0];

  const baseCorePrompt = await getSakaCorePrompt(providedSupabase);

  const systemInstruction = `
${baseCorePrompt}

RUNTIME DYNAMIC CONTEXT:
- Current Server Date & Time: ${currentLocalDateTime} (ISO Baseline: ${currentIsoDate})
- User Preferred Language: ${targetLang}
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