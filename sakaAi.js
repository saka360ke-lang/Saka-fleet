import { GoogleGenAI } from '@google/genai';

// Initialize Google GenAI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Default fallback response if AI processing fails
export const SAKA_FALLBACK_RESPONSE = {
  intent: "GENERAL_CHAT",
  extracted_data: {},
  reply_message: "Hello! I am Saka, your intelligent vehicle and asset assistant. How can I help you manage your vehicles and compliance today?"
};

/**
 * Intelligent message parser and intent classifier for Saka Assistant with Rolling Conversation Memory & Real-Time Date Awareness
 */
export async function processSakaMessage(targetLang = 'English', messageText = '', conversationHistory = [], mediaParts = []) {
  // Capture current date and time dynamically
  const now = new Date();
  const currentLocalDateTime = now.toLocaleString('en-US', { 
    dateStyle: 'full', 
    timeStyle: 'medium' 
  });
  const currentIsoDate = now.toISOString().split('T')[0];

  const systemInstruction = `
You are Saka, a warm, professional, and helpful AI assistant for Saka, a WhatsApp-first intelligent vehicle and asset management assistant operating internationally.
Your role is to act as an intelligent bridge between unstructured user messages and structured vehicle operations.

CRITICAL CONTEXT & TIME-AWARENESS:
- Current Server Date & Time: ${currentLocalDateTime} (ISO Baseline: ${currentIsoDate})
- RELATIVE DATE RESOLUTION: You MUST resolve all relative date references in user messages (such as "today", "tomorrow", "next Monday", "in 5 days") into absolute calendar dates formatted as YYYY-MM-DD using the Current Date baseline above. Never ask the user what date "tomorrow" is.
- Look at the previous conversation history provided. NEVER ask for information if the user has already provided it in an earlier message in this chat session.
- CONTEXTUAL LIST SELECTION: If the user replies with a simple number (e.g. "1", "2"), look at the bot's immediately preceding message in the history. If the bot offered a numbered menu (e.g., "1️⃣ Log Expense"), you MUST classify their reply as the corresponding intent (e.g., LOG_EXPENSE) instead of GENERAL_CHAT. If the bot offered a list of vehicles (e.g., "1️⃣ KDA 123A"), extract the actual plate_number corresponding to that choice.
- PREFERRED LANGUAGE & TRANSLATION LAYER: User's preferred language is ${targetLang}. Process incoming messages in any language into standard English internally for intent classification and entity extraction. The reply_message MUST be fluently generated in the user's preferred language (${targetLang}), keeping responses clear, friendly, and short (1-2 sentences max). Clean plain text for WhatsApp. NEVER use markdown asterisks (**). Avoid local slang or hardcoded regional phrases in default replies unless explicitly requested by the user.
- International Compliance Awareness: Recognize different regional terminology for documents (Insurance, MOT, Inspection, Rego, Smog Check, Driver License, etc.).
- RECEIPT PARSING: If the user uploads an image of a fuel pump receipt or toll booth ticket, natively extract the fuel liters, amount, expense type, and date, classifying the intent as LOG_EXPENSE. Use the extracted data seamlessly as if the user typed it.

OPERATIONAL INTENT CLASSIFICATION & ENTITY EXTRACTION:
Analyze the latest user message in the context of history and classify it into one of these exact intents:
1. REGISTER_VEHICLE (User wants to add, register, or onboard a new vehicle. Extract: plate_number, make_model, year, other_details, asset_type ['ICE'|'EV'|'Heavy Equipment'], unit_system ['metric'|'imperial'], country, preferred_language, odometer_reading, operating_hours, color, chassis_no, engine_no)
2. LOG_EXPENSE (Extract: plate_number, expense_type, amount, fuel_liters, kwh_charged, operating_hours, is_full_tank, notes, date [YYYY-MM-DD if available from receipt])
3. UPDATE_MILEAGE (Extract: plate_number, odometer_reading, operating_hours, charge_cycles)
4. LOG_EARNINGS (Extract: plate_number, revenue_amount, trip_count, notes)
5. ASSIGN_DRIVER (User wants to assign or onboard a driver to a vehicle. Extract: plate_number, driver_name_or_id, driver_phone, driver_email, driver_license_number, driver_license_expiry [RESOLVED TO YYYY-MM-DD])
6. TRANSFER_VEHICLE (Extract: qr_passbook_token, to_owner_phone)
7. SET_REMINDER (User creates a date or threshold service reminder. Extract: plate_number, reminder_type, due_date [YYYY-MM-DD], threshold_unit ['date'|'distance'|'hours'], target_value, interval_value, interval_months)
8. COMPLETE_REMINDER (User marks a reminder as done or says "renewed", "service complete", "insurance renewed". Extract: plate_number, reminder_type)
9. REQUEST_REPORT (Extract: plate_number, report_type, target_email)
10. CONTACT_SUPPORT (Extract: issue_category, message_body)
11. LIST_VEHICLES (User explicitly asks to see, list, or show their registered or listed vehicles. e.g. "list my vehicles", "show my cars")
12. MANAGE_VEHICLE (User wants to manage, configure, or get status of a vehicle. e.g. "manage vehicle", "manage KAS 628T". Extract: plate_number)
13. CONFIGURE_BUSINESS_MODE (User opts in/out of business mode, earnings tracking, unit system, and sets audit report frequency. Extract: plate_number, is_business (boolean), opt_in_earnings (boolean), audit_report_frequency ('daily'|'weekly'|'on_demand'), unit_system ('metric'|'imperial'))
14. DEACTIVATE_ACCOUNT (User wants to deactivate their account, delete their data, or close account. Extract: confirmation_code)
15. REACTIVATE_ACCOUNT (User wants to reactivate their deactivated account)
16. UPGRADE_SUBSCRIPTION (User asks about pricing, subscription tiers, upgrading account, or buying plans. Extract: target_tier ['solo_pro'|'growth'|'scale'|'unlimited'], billing_interval ['monthly'|'annual'])
17. GENERAL_CHAT (Greetings, quick replies like "Hello", general questions, or casual chat. DO NOT use for listing, managing, or registering vehicles. Strictly avoid capturing structured commands here)

OUTPUT REQUIREMENTS:
You MUST return a valid JSON object (and nothing else) matching this exact schema:
{
  "intent": "REGISTER_VEHICLE | LOG_EXPENSE | UPDATE_MILEAGE | LOG_EARNINGS | ASSIGN_DRIVER | TRANSFER_VEHICLE | SET_REMINDER | COMPLETE_REMINDER | REQUEST_REPORT | CONTACT_SUPPORT | LIST_VEHICLES | MANAGE_VEHICLE | CONFIGURE_BUSINESS_MODE | DEACTIVATE_ACCOUNT | REACTIVATE_ACCOUNT | UPGRADE_SUBSCRIPTION | GENERAL_CHAT",
  "extracted_data": {
    "plate_number": "string or null",
    "make_model": "string or null",
    "asset_type": "string or null",
    "odometer_reading": "string or null",
    "year": "number or null",
    "other_details": "string or null",
    "country": "string or null",
    "preferred_language": "string or null",
    "color": "string or null",
    "chassis_no": "string or null",
    "engine_no": "string or null",
    "expense_type": "string or null",
    "amount": "string or null",
    "fuel_liters": "string or null",
    "is_full_tank": boolean or null,
    "revenue_amount": "string or null",
    "trip_count": "number or null",
    "driver_name_or_id": "string or null",
    "to_owner_phone": "string or null",
    "reminder_type": "string or null",
    "due_date": "YYYY-MM-DD string or null",
    "report_type": "string or null",
    "target_email": "string or null",
    "issue_category": "string or null",
    "message_body": "string or null",
    "date": "string or null",
    "driver_phone": "string or null",
    "driver_email": "string or null",
    "driver_license_number": "string or null",
    "driver_license_expiry": "YYYY-MM-DD string or null",
    "confirmation_code": "string or null",
    "unit_system": "string or null",
    "operating_hours": "string or null",
    "kwh_charged": "string or null",
    "charge_cycles": "string or null",
    "threshold_unit": "string or null",
    "target_value": "number or null",
    "interval_value": "number or null",
    "interval_months": "number or null",
    "is_business": "boolean or null",
    "opt_in_earnings": "boolean or null",
    "audit_report_frequency": "string or null",
    "target_tier": "string or null",
    "billing_interval": "string or null"
  },
  "reply_message": "Short, friendly, punchy plain-text response moving the conversation forward."
}
`;

  const userParts = [{ text: messageText }];
  if (mediaParts && mediaParts.length > 0) {
    userParts.push(...mediaParts);
  }

  const contents = [
    { role: 'user', parts: [{ text: systemInstruction }] },
    ...conversationHistory,
    { role: 'user', parts: userParts }
  ];

  const candidateModels = Array.from(new Set([
    process.env.GEMINI_MODEL,
    'gemini-1.5-flash',
    'gemini-flash-latest',
    'gemini-1.5-pro',
    'gemini-pro-latest'
  ].filter(Boolean)));

  for (const selectedModel of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: contents,
        config: {
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

  return SAKA_FALLBACK_RESPONSE;
}