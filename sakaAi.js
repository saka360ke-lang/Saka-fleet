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

INTENT CLASSIFICATION REQUIREMENTS:
Analyze the incoming message and classify the user's intent into a JSON object matching this schema:
{
  "intent": "GREETING" | "REGISTER_VEHICLE" | "APP_HELP" | "MANAGE_VEHICLE" | "LIST_VEHICLES" | "LOG_EXPENSE" | "UPDATE_MILEAGE" | "LOG_EARNINGS" | "SET_REMINDER" | "COMPLETE_REMINDER" | "REQUEST_REPORT" | "CONTACT_SUPPORT" | "REACTIVATE_ACCOUNT" | "GENERAL_CHAT",
  "extracted_data": {
    "plate_number": string | null,
    "make_model": string | null,
    "year": number | null,
    "amount": number | null,
    "odometer": number | null,
    "preferred_language": string | null,
    "role": string | null
  },
  "reply_message": string
}

INTENT RULES & CLASSIFICATION:
1. GREETING:
   - User says "Hi", "Hello", "Hey", "Habari", "Mambo", "Greetings".
   - Set intent: "GREETING".
   - Reply: Explain that Saka Fleet tracks vehicle processes, compliance, expenses, and maintenance directly on WhatsApp, and prompt them to start onboarding by typing their vehicle plate number (e.g., KDA 123A) or "Register".

2. REGISTER_VEHICLE:
   - User asks "Can I register my vehicle?", "Add car", "Register", "Onboard", "New vehicle", or provides a registration plate number for onboarding.
   - Set intent: "REGISTER_VEHICLE".
   - Extract any plate number or make/model present.

3. APP_HELP:
   - User asks "What do you do?", "How does this work?", "Help", "Features", "Commands".
   - Set intent: "APP_HELP".
   - Briefly summarize Saka Fleet capabilities (expenses, mileage, compliance reminders, automated reports) and invite them to register their vehicle.

4. MANAGE_VEHICLE / LIST_VEHICLES:
   - User asks "Manage vehicle", "My cars", "Vehicle list".
   - Set intent: "MANAGE_VEHICLE" or "LIST_VEHICLES".

5. LOG_EXPENSE, UPDATE_MILEAGE, LOG_EARNINGS, SET_REMINDER, REQUEST_REPORT, CONTACT_SUPPORT:
   - Classify accurately according to user action.

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
    return data.value;
  } catch (err) {
    console.warn('[sakaAi] Failed to fetch saka_core_prompt from Supabase, falling back to default:', err.message);
    return DEFAULT_SAKA_CORE_PROMPT;
  }
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

  // Odometer / Mileage Update
  if (/odometer|mileage|\bkm\b|\bmiles\b|reading|clocked/i.test(clean)) {
    const odoMatch = clean.match(/[\d,]+/);
    const odoVal = odoMatch ? parseInt(odoMatch[0].replace(/,/g, ''), 10) : null;
    return {
      intent: 'UPDATE_MILEAGE',
      extracted_data: { odometer: odoVal },
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
    const plateMatch = messageText.match(/\b[A-Z0-9-]{3,10}\b/i);
    return {
      intent: 'REGISTER_VEHICLE',
      extracted_data: {
        plate_number: plateMatch ? plateMatch[0].toUpperCase() : null
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
        return parsed;
      }
    } catch (err) {
      console.warn(`Saka AI generation attempt with model '${selectedModel}' failed:`, err.message);
    }
  }

  return classifyIntentWithRegex(messageText);
}