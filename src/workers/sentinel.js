import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

function getSupabase(providedSupabase) {
  if (providedSupabase) return providedSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('Supabase credentials missing in environment');
  }
  return createClient(url, key);
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY missing in environment');
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Ensure Sentinel worker tables exist in Supabase
 */
export async function ensureSentinelTables(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  const requiredTables = ['system_config', 'error_logs', 'conversation_analytics', 'chat_transcripts'];
  const statusMap = {};

  for (const table of requiredTables) {
    const { data, error } = await supabase.from(table).select('*').limit(1);
    if (error && error.message.includes('Could not find the table')) {
      statusMap[table] = 'missing';
    } else {
      statusMap[table] = 'exists';
    }
  }

  // If any table is missing and ACCESS TOKEN is available, run SQL creation
  const missingTables = Object.keys(statusMap).filter(t => statusMap[t] === 'missing');
  if (missingTables.length > 0 && process.env.SUPABASE_ACCESS_TOKEN) {
    try {
      const token = process.env.SUPABASE_ACCESS_TOKEN;
      const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];
      const sql = `
        CREATE TABLE IF NOT EXISTS public.system_config (
            key text PRIMARY KEY,
            value text,
            updated_by text,
            updated_at timestamp with time zone DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS public.error_logs (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            error_message text,
            stack_trace text,
            route text,
            status text DEFAULT 'unresolved',
            ai_diagnosis text,
            created_at timestamp with time zone DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS public.conversation_analytics (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            period_start timestamp with time zone,
            period_end timestamp with time zone,
            insights jsonb,
            prompt_adjustments text,
            created_at timestamp with time zone DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS public.chat_transcripts (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            phone_number text,
            sender text,
            message_text text,
            created_at timestamp with time zone DEFAULT now()
        );
      `;

      await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: sql })
      });
      missingTables.forEach(t => { statusMap[t] = 'created'; });
    } catch (createErr) {
      console.warn('Sentinel table creation notice:', createErr.message);
    }
  }

  return statusMap;
}


/**
 * Health Check Sentinel:
 * Queries recent unresolved rows in error_logs, sends stack traces to Gemini (gemini-1.5-flash / flash-latest)
 * to generate a diagnosis and mitigation suggestion, and updates the row status & ai_diagnosis.
 */
export async function runHealthCheck(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  const ai = getGeminiClient();

  await ensureSentinelTables(supabase);

  // 1. Fetch recent unresolved error logs
  const { data: unresolvedLogs, error } = await supabase
    .from('error_logs')
    .select('*')
    .eq('status', 'unresolved')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[Sentinel HealthCheck] Error fetching error_logs:', error.message);
    throw new Error(`Failed to query error_logs: ${error.message}`);
  }

  if (!unresolvedLogs || unresolvedLogs.length === 0) {
    return {
      status: 'success',
      message: 'No unresolved errors found in error_logs',
      diagnosed_count: 0,
      diagnosed_logs: []
    };
  }

  const candidateModels = Array.from(new Set([
    'gemini-flash-latest',
    'gemini-2.0-flash',
    process.env.GEMINI_MODEL,
    'gemini-1.5-flash',
    'gemini-2.5-flash',
    'gemini-1.5-pro'
  ].filter(Boolean)));

  const diagnosedLogs = [];

  for (const log of unresolvedLogs) {
    const prompt = `You are the Saka Sentinel System Diagnostic Specialist.
Analyze this backend error log from our Node.js / Fastify / Supabase service:

- Route: ${log.route || 'N/A'}
- Error Message: ${log.error_message || 'N/A'}
- Stack Trace:
${log.stack_trace || 'No stack trace provided.'}

Provide:
1. Diagnosis: Root cause analysis of why this error occurred.
2. Recommended Mitigation: Actionable code or operational fixes to resolve and prevent this issue.

Format your answer clearly with 'DIAGNOSIS:' and 'MITIGATION SUGGESTION:'.`;

    let diagnosisText = null;

    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt
        });
        if (response && response.text) {
          diagnosisText = response.text.trim();
          break;
        }
      } catch (gemErr) {
        console.warn(`[Sentinel HealthCheck] Gemini model ${modelName} failed for error ID ${log.id}:`, gemErr.message);
      }
    }

    if (!diagnosisText) {
      diagnosisText = `Diagnosis unavailable. Failed to reach Gemini AI service. Error ID: ${log.id}`;
    }

    // Update row status and diagnosis in error_logs
    const { error: updateErr } = await supabase
      .from('error_logs')
      .update({
        ai_diagnosis: diagnosisText,
        status: 'diagnosed'
      })
      .eq('id', log.id);

    if (updateErr) {
      console.error(`[Sentinel HealthCheck] Failed to update error_log ID ${log.id}:`, updateErr.message);
    } else {
      diagnosedLogs.push({
        id: log.id,
        route: log.route,
        error_message: log.error_message,
        ai_diagnosis: diagnosisText,
        status: 'diagnosed'
      });
    }
  }

  return {
    status: 'success',
    diagnosed_count: diagnosedLogs.length,
    diagnosed_logs: diagnosedLogs
  };
}

/**
 * Conversation Refinement Sentinel:
 * Pulls recent chat transcripts from Supabase, analyzes them with Gemini to detect changing user conversation patterns,
 * slang, or drop-off points, updates conversation_analytics, and updates the saka_core_prompt inside system_config.
 */
export async function runConversationRefinement(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  const ai = getGeminiClient();

  await ensureSentinelTables(supabase);

  // 1. Fetch recent chat transcripts (or support tickets as supplementary source)
  const { data: transcripts } = await supabase
    .from('chat_transcripts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  const { data: supportTickets } = await supabase
    .from('support_tickets')
    .select('whatsapp_number, issue_category, message_body, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  let combinedTranscriptsText = '';

  if (transcripts && transcripts.length > 0) {
    combinedTranscriptsText += '--- RECENT CHAT TRANSCRIPTS ---\n' +
      transcripts.map(t => `[${t.created_at}] ${t.phone_number || 'User'} (${t.sender || 'user'}): ${t.message_text}`).join('\n') + '\n\n';
  }

  if (supportTickets && supportTickets.length > 0) {
    combinedTranscriptsText += '--- RECENT SUPPORT TICKETS ---\n' +
      supportTickets.map(st => `[${st.created_at}] ${st.whatsapp_number} [${st.issue_category}]: ${st.message_body}`).join('\n');
  }

  if (!combinedTranscriptsText.trim()) {
    combinedTranscriptsText = 'No recent user chat transcripts found in database. Analyze baseline interactions for general fleet assistant usability.';
  }

  // 2. Fetch current core prompt from system_config (if available)
  let currentCorePrompt = null;
  const { data: configRow } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'saka_core_prompt')
    .single();

  if (configRow && configRow.value) {
    currentCorePrompt = configRow.value;
  }

  const prompt = `You are Saka Sentinel Worker, an expert AI prompt engineer and conversational analyst for Saka, a WhatsApp-first intelligent vehicle and asset management assistant operating internationally.

Analyze these recent customer conversation transcripts and support inquiries:
${combinedTranscriptsText}

Current System Core Prompt (if set):
${currentCorePrompt || 'Default Saka AI Core Prompt'}

Your Tasks:
1. Detect changing user conversation patterns, local slang/colloquialisms (e.g. Sheng, regional phrasing), or common drop-off points.
2. Formulate concise prompt adjustments to make Saka AI clearer, punchier, and better at entity extraction.
3. Generate a refined, production-ready Saka Core Prompt.

Return strictly a single valid JSON object matching this schema (no markdown asterisks or code fences):
{
  "insights": {
    "user_patterns": ["string"],
    "slang_detected": ["string"],
    "drop_off_points": ["string"],
    "key_improvements": ["string"]
  },
  "prompt_adjustments": "Summary description of prompt refinements made.",
  "updated_saka_core_prompt": "Complete updated Saka core system prompt text."
}`;

  const candidateModels = Array.from(new Set([
    'gemini-flash-latest',
    'gemini-2.0-flash',
    process.env.GEMINI_MODEL,
    'gemini-1.5-flash',
    'gemini-2.5-flash',
    'gemini-1.5-pro'
  ].filter(Boolean)));

  let parsedAnalysis = null;

  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      if (response && response.text) {
        const cleanedJson = response.text
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();

        parsedAnalysis = JSON.parse(cleanedJson);
        if (parsedAnalysis && parsedAnalysis.updated_saka_core_prompt) {
          break;
        }
      }
    } catch (gemErr) {
      console.warn(`[Sentinel ConversationRefinement] Gemini model ${modelName} failed:`, gemErr.message);
    }
  }

  if (!parsedAnalysis || !parsedAnalysis.updated_saka_core_prompt) {
    return {
      status: 'warning',
      message: 'Failed to generate refined prompt with Gemini AI',
      insights: null,
      saka_core_prompt_updated: false
    };
  }

  // 3. Update saka_core_prompt inside system_config
  const nowIso = new Date().toISOString();
  const { error: configErr } = await supabase
    .from('system_config')
    .upsert({
      key: 'saka_core_prompt',
      value: parsedAnalysis.updated_saka_core_prompt,
      updated_by: 'sentinel_worker',
      updated_at: nowIso
    });

  if (configErr) {
    console.error('[Sentinel ConversationRefinement] Failed to upsert system_config:', configErr.message);
  }

  // 4. Record insights inside conversation_analytics
  const periodStart = (transcripts && transcripts.length > 0 && transcripts[transcripts.length - 1].created_at)
    ? transcripts[transcripts.length - 1].created_at
    : new Date(Date.now() - 86400000).toISOString();

  const { error: analyticsErr } = await supabase
    .from('conversation_analytics')
    .insert([{
      period_start: periodStart,
      period_end: nowIso,
      insights: parsedAnalysis.insights || {},
      prompt_adjustments: parsedAnalysis.prompt_adjustments || 'Prompt refined by Sentinel Worker',
      created_at: nowIso
    }]);

  if (analyticsErr) {
    console.error('[Sentinel ConversationRefinement] Failed to insert conversation_analytics:', analyticsErr.message);
  }

  return {
    status: 'success',
    period_start: periodStart,
    period_end: nowIso,
    insights: parsedAnalysis.insights,
    prompt_adjustments: parsedAnalysis.prompt_adjustments,
    saka_core_prompt_updated: !configErr
  };
}


/**
 * Helper to log system error to error_logs table
 */
export async function logSystemError(providedSupabase, error, route = 'unknown') {
  try {
    const supabase = getSupabase(providedSupabase);
    await supabase.from('error_logs').insert([{
      error_message: error.message || String(error),
      stack_trace: error.stack || null,
      route: route,
      status: 'unresolved',
      created_at: new Date().toISOString()
    }]);
  } catch (err) {
    console.error('[Sentinel Helper] Failed to log error to error_logs table:', err.message);
  }
}

/**
 * Helper to log incoming or outgoing chat message to chat_transcripts table
 */
export async function logChatTranscript(providedSupabase, phoneNumber, sender, messageText) {
  try {
    const supabase = getSupabase(providedSupabase);
    await supabase.from('chat_transcripts').insert([{
      phone_number: phoneNumber,
      sender: sender,
      message_text: messageText,
      created_at: new Date().toISOString()
    }]);
  } catch (err) {
    console.error('[Sentinel Helper] Failed to log chat transcript:', err.message);
  }
}

