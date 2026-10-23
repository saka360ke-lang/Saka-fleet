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
  reply_message: "Hello! I am Saka, your intelligent vehicle and asset assistant. How can I help you manage your vehicles and compliance today?"
};

export const DEFAULT_SAKA_CORE_PROMPT = `You are Saka, a warm, professional, and helpful AI assistant for Saka, a WhatsApp-first intelligent vehicle and asset management assistant operating internationally.
Your role is to act as an intelligent bridge between unstructured user messages and structured vehicle operations.

CRITICAL CONTEXT & TIME-AWARENESS:
- RELATIVE DATE RESOLUTION: You MUST resolve all relative date references in user messages (such as "today", "tomorrow", "next Monday", "in 5 days") into absolute calendar dates formatted as YYYY-MM-DD using the Current Date baseline above. Never ask the user what date "tomorrow" is.
- Look at the previous conversation history provided. NEVER ask for information if the user has already provided it in an earlier message in this chat session.
- CONTEXTUAL LIST SELECTION: If the user replies with a simple number (e.g. "1", "2"), look at the bot's immediately preceding message in the history. If the bot offered a numbered menu (e.g., "1️⃣ Log Expense"), you MUST classify their reply as the corresponding intent (e.g., LOG_EXPENSE) instead of GENERAL_CHAT. If the bot offered a list of vehicles (e.g., "1️⃣ KDA 123A"), extract the actual plate_number corresponding to that choice.
- PREFERRED LANGUAGE & TRANSLATION LAYER: Process incoming messages in any language into standard English internally for intent classification and entity extraction. The reply_message MUST be fluently generated in the user's preferred language, keeping responses clear, friendly, and short (1-2 sentences max). Clean plain text for WhatsApp. NEVER use markdown asterisks (**). Avoid local slang or hardcoded regional phrases in default replies unless explicitly requested by the user.
- International Compliance Awareness: Recognize different regional terminology for documents (Insurance, MOT, Inspection, Rego, Smog Check, Driver License, etc.).
- RECEIPT PARSING: If the user uploads an image of a fuel pump receipt or toll booth ticket, natively extract the fuel liters, amount, expense type, and date, classifying the intent as LOG_EXPENSE. Use the extracted data seamlessly as if the user typed it.`;

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
 * Intelligent message parser and intent classifier for Saka Assistant with Rolling Conversation Memory & Real-Time Date Awareness
 */
export async function processSakaMessage(targetLang = 'English', messageText = '', conversationHistory = [], mediaParts = [], providedSupabase = null) {
  // Capture current date and time dynamically
  const now = new Date();
  const currentLocalDateTime = now.toLocaleString('en-US', { 
    dateStyle: 'full', 
    timeStyle: 'medium' 
  });
  const currentIsoDate = now.toISOString().split('T')[0];

  // Dynamically fetch Saka core prompt from Supabase or default fallback
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

  const contents = [
    { role: 'user', parts: [{ text: systemInstruction }] },
    ...conversationHistory,
    { role: 'user', parts: userParts }
  ];

  const candidateModels = Array.from(new Set([
    'gemini-flash-latest',
    process.env.GEMINI_MODEL,
    'gemini-1.5-flash'
  ].filter(Boolean)));

  for (const selectedModel of candidateModels) {
    try {
      const response = await getGeminiClient().models.generateContent({
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