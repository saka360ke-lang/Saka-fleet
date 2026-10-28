import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { fetchCloudRunLogs } from '../services/sentinelCloudLogs.js';

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
  const requiredTables = [
    'system_config',
    'error_logs',
    'conversation_analytics',
    'chat_transcripts',
    'chat_friction_logs',
    'saka_dynamic_rules'
  ];
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
        CREATE TABLE IF NOT EXISTS public.chat_friction_logs (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            user_phone text,
            session_id text,
            friction_type text,
            transcript_snippet text,
            detected_at timestamp with time zone DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS public.saka_dynamic_rules (
            id serial PRIMARY KEY,
            rule_key text UNIQUE,
            rule_description text,
            patch_instruction text,
            is_active boolean DEFAULT true,
            created_at timestamp with time zone DEFAULT now(),
            updated_at timestamp with time zone DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_friction_logs_phone ON public.chat_friction_logs(user_phone, detected_at DESC);
        CREATE INDEX IF NOT EXISTS idx_dynamic_rules_active ON public.saka_dynamic_rules(is_active);
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
 * Queries recent unresolved rows in error_logs, sends stack traces to Gemini (gemini-3.8-flash / flash-latest)
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
    'gemini-3.8-flash',
    process.env.GEMINI_MODEL,
    'gemini-flash-latest'
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
    'gemini-3.8-flash',
    process.env.GEMINI_MODEL,
    'gemini-flash-latest'
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


// In-memory deduplication cache for Cloud Run alerts to avoid flooding Superadmin
const recentlyAlertedLogHashes = new Map();
const CLOUD_RUN_ALERT_TTL = 15 * 60 * 1000; // 15 minutes

export async function scanCloudRunAnomalies(providedSupabase) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  if (!superadminPhone) return;

  const logs = await fetchCloudRunLogs(5);
  if (!logs || logs.length === 0) return;

  const supabase = getSupabase(providedSupabase);
  await ensureSentinelTables(supabase);

  // Clean up old deduplication entries
  const now = Date.now();
  for (const [hash, timestamp] of recentlyAlertedLogHashes.entries()) {
    if (now - timestamp > CLOUD_RUN_ALERT_TTL) {
      recentlyAlertedLogHashes.delete(hash);
    }
  }

  for (const log of logs) {
    // Generate a simple hash of the log text and status to deduplicate
    const hashStr = `${log.severity}-${log.httpRequest?.status || 'no-status'}-${(log.text || '').substring(0, 50)}`;
    
    if (recentlyAlertedLogHashes.has(hashStr)) continue;

    const isError = log.severity === 'ERROR' || log.severity === 'CRITICAL';
    const isTimeoutRisk = (log.httpRequest?.latency >= 5) || (log.httpRequest?.status >= 500);

    if (isError || isTimeoutRisk) {
      recentlyAlertedLogHashes.set(hashStr, now);

      const snippet = `[Cloud Run Alert] Severity: ${log.severity} | Status: ${log.httpRequest?.status || 'N/A'} | Latency: ${log.httpRequest?.latency || 0}s\nMessage: ${log.text || 'No message'}`;
      
      // Log to chat_friction_logs
      try {
        await supabase.from('chat_friction_logs').insert([{
          user_phone: superadminPhone,
          session_id: 'cloud_run_saka_fleet',
          friction_type: 'SYSTEM_ERROR',
          transcript_snippet: snippet,
          detected_at: new Date().toISOString()
        }]);
      } catch (e) {
        console.warn('[scanCloudRunAnomalies] Could not insert to chat_friction_logs:', e.message);
      }

      // Log to error_logs
      try {
        await supabase.from('error_logs').insert([{
          error_message: log.text || 'Cloud Run Log Alert',
          stack_trace: JSON.stringify(log),
          route: log.httpRequest?.requestUrl || 'system',
          status: 'unresolved',
          created_at: new Date().toISOString()
        }]);
      } catch (e) {
        console.warn('[scanCloudRunAnomalies] Could not insert to error_logs:', e.message);
      }

      // Send WhatsApp Alert
      const metaPhoneId = process.env.META_PHONE_NUMBER_ID;
      const metaToken = process.env.META_WHATSAPP_TOKEN;
      if (metaPhoneId && metaToken) {
        const cleanPhone = superadminPhone.replace(/[^\d]/g, '');
        const waMessage = `🚨 *Sentinel Cloud Run Error Alert* ⚠️\n\n• *Service:* saka-fleet\n• *Severity:* ${log.severity}\n• *Latency / Status:* ${log.httpRequest?.status || 'N/A'} (${log.httpRequest?.latency || 0}s)\n• *Timestamp:* ${new Date(log.timestamp).toLocaleString()}\n• *Snippet:* "${(log.text || '').substring(0, 200)}"\n\n_Logged to chat_friction_logs. Text 'admin alerts' for full diagnostic._`;
        
        try {
          await fetch(`https://graph.facebook.com/v17.0/${metaPhoneId}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${metaToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: cleanPhone,
              type: 'text',
              text: { body: waMessage }
            })
          });
        } catch (waErr) {
          console.error('[scanCloudRunAnomalies] WhatsApp alert failed:', waErr.message);
        }
      }
    }
  }
}


/**
 * Sentinel Autonomous Conversational Optimization Loop:
 * Scans recent chat logs for friction signatures (looping prompts 3+ times,
 * user frustration keywords, intent ambiguity), logs to chat_friction_logs,
 * and calls gemini-3.8-flash under the Function Boundary Lock to upsert
 * active micro-rule patches in saka_dynamic_rules.
 */
export async function evaluateConversationalFriction(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  const ai = getGeminiClient();

  await ensureSentinelTables(supabase);

  // 1. Fetch recent chat history
  let { data: messages, error } = await supabase
    .from('chat_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error || !messages || messages.length === 0) {
    const { data: transcripts } = await supabase
      .from('chat_transcripts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (transcripts && transcripts.length > 0) {
      messages = transcripts.map(t => ({
        user_phone: t.phone_number,
        role: t.sender === 'user' ? 'user' : 'assistant',
        message: t.message_text,
        created_at: t.created_at
      }));
    }
  }

  if (!messages || messages.length === 0) {
    return {
      status: 'success',
      message: 'No recent chat messages to analyze for friction.',
      friction_detected: 0,
      patches_created: 0,
      patches: []
    };
  }

  // 2. Group messages by user_phone
  const userChats = new Map();
  for (const m of messages) {
    const phone = m.user_phone;
    if (!phone) continue;
    if (!userChats.has(phone)) userChats.set(phone, []);
    userChats.get(phone).push(m);
  }

  const frustrationRegex = /\b(stuck|looping|loop|broken|bug|wrong|repeating|stop asking|already gave|already told|help me|stupid|not working|why are you|confused|frustrated|ridiculous)\b/i;
  const detectedFrictions = [];

  for (const [phone, chatList] of userChats.entries()) {
    chatList.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    let botRepeatCount = 1;
    let lastBotMsg = null;
    let userRepeatCount = 1;
    let lastUserMsg = null;

    for (let i = 0; i < chatList.length; i++) {
      const item = chatList[i];
      const normText = (item.message || '').trim().toLowerCase().replace(/\s+/g, ' ');

      if (item.role === 'assistant' || item.role === 'model') {
        if (lastBotMsg && normText.length > 10 && normText === lastBotMsg) {
          botRepeatCount++;
          if (botRepeatCount >= 3) {
            const snippet = chatList.slice(Math.max(0, i - 5), i + 1)
              .map(c => `[${c.role}]: ${c.message}`).join('\n');
            detectedFrictions.push({ phone, type: 'LOOPING_PROMPTS', snippet, reason: 'Assistant repeated same prompt 3+ times.' });
            break;
          }
        } else {
          lastBotMsg = normText;
          botRepeatCount = 1;
        }
      } else if (item.role === 'user') {
        if (lastUserMsg && normText.length > 5 && normText === lastUserMsg) {
          userRepeatCount++;
          if (userRepeatCount >= 3) {
            const snippet = chatList.slice(Math.max(0, i - 5), i + 1)
              .map(c => `[${c.role}]: ${c.message}`).join('\n');
            detectedFrictions.push({ phone, type: 'LOOPING_PROMPTS', snippet, reason: 'User repeated identical message 3+ times.' });
            break;
          }
        } else {
          lastUserMsg = normText;
          userRepeatCount = 1;
        }

        if (frustrationRegex.test(item.message || '')) {
          const snippet = chatList.slice(Math.max(0, i - 4), i + 2)
            .map(c => `[${c.role}]: ${c.message}`).join('\n');
          detectedFrictions.push({ phone, type: 'USER_FRUSTRATION', snippet, reason: `User expressed frustration: "${item.message.slice(0, 80)}"` });
          break;
        }
      }
    }

    const fallbackMatches = chatList.filter(c =>
      (c.role === 'assistant' || c.role === 'model') &&
      /I am your Saka Fleet WhatsApp assistant\. How can I help/i.test(c.message || '')
    );
    if (fallbackMatches.length >= 3) {
      const snippet = chatList.slice(-6).map(c => `[${c.role}]: ${c.message}`).join('\n');
      detectedFrictions.push({ phone, type: 'INTENT_AMBIGUITY', snippet, reason: 'Assistant fell back to generic greeting 3+ times.' });
    }
  }

  if (detectedFrictions.length === 0) {
    return {
      status: 'success',
      message: 'No conversational friction signatures detected in recent logs.',
      friction_detected: 0,
      patches_created: 0,
      patches: []
    };
  }

  return await processFrictionPatches(supabase, ai, detectedFrictions);
}

async function processFrictionPatches(supabase, ai, detectedFrictions) {
  const candidateModels = Array.from(new Set([
    'gemini-3.8-flash',
    process.env.GEMINI_MODEL,
    'gemini-flash-latest'
  ].filter(Boolean)));

  const patches = [];

  for (const friction of detectedFrictions) {
    try {
      await supabase.from('chat_friction_logs').insert([{
        user_phone: friction.phone,
        session_id: `session_${friction.phone.replace(/[^\d]/g, '')}`,
        friction_type: friction.type,
        transcript_snippet: friction.snippet,
        detected_at: new Date().toISOString()
      }]);
    } catch (logErr) {
      console.warn('[Sentinel Friction Log Warning]:', logErr.message);
    }

    const optimizerPrompt = `You are the Saka Sentinel Micro-Rule Optimizer for Saka Fleet's conversational assistant.

CRITICAL FUNCTION BOUNDARY LOCK:
- You are ONLY permitted to formulate behavioral hints, tone adjustments, phrasing modifications, or clarification flows.
- You CANNOT alter or recommend changing core hardcoded rules, database structures, VIN locks, OTP email verification, or security checks.
- If friction stems from an immutable requirement (e.g., VIN chassis or OTP code), formulate a behavioral hint on how Saka can explain the requirement more clearly, warmly, and concisely to the user.

Conversational Friction Incident:
- User Phone: ${friction.phone}
- Friction Type: ${friction.type}
- Detection Context: ${friction.reason}
- Transcript Snippet:
${friction.snippet}

Tasks:
1. Identify the phrasing confusion or friction cause.
2. Produce a unique, descriptive snake_case rule_key (e.g., "clarify_vin_entry", "soothe_frustrated_user", "rephrase_mileage_prompt").
3. Formulate a concise patch_instruction (1-2 sentences) to inject into the Saka Assistant runtime system prompt as behavioral guidance.

Output ONLY valid JSON matching this schema:
{
  "rule_key": "string",
  "rule_description": "string",
  "patch_instruction": "string"
}`;

    let parsedPatch = null;

    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [{ role: 'user', parts: [{ text: optimizerPrompt }] }],
          config: { responseMimeType: 'application/json' }
        });

        if (response && response.text) {
          const cleaned = response.text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
          parsedPatch = JSON.parse(cleaned);
          if (parsedPatch && parsedPatch.rule_key && parsedPatch.patch_instruction) {
            break;
          }
        }
      } catch (gemErr) {
        console.warn(`[Sentinel evaluateConversationalFriction] Gemini ${modelName} error:`, gemErr.message);
      }
    }

    if (!parsedPatch || !parsedPatch.rule_key || !parsedPatch.patch_instruction) {
      const suffix = (friction.phone || 'user').replace(/[^\d]/g, '').slice(-4) || 'patch';
      if (friction.type === 'USER_FRUSTRATION') {
        parsedPatch = {
          rule_key: `soothe_frustration_${suffix}`,
          rule_description: 'Acknowledge user frustration and clarify questions concisely',
          patch_instruction: 'When user seems frustrated or confused, warmly acknowledge their input and state requirements clearly with concrete examples.'
        };
      } else if (friction.type === 'LOOPING_PROMPTS') {
        parsedPatch = {
          rule_key: `break_loop_${suffix}`,
          rule_description: 'Avoid repetitive prompt loops by guiding the user',
          patch_instruction: 'Avoid asking for the same information repeatedly; offer assistance or suggest typing in their vehicle details in one message.'
        };
      } else {
        parsedPatch = {
          rule_key: `clarify_intent_${suffix}`,
          rule_description: 'Disambiguate conversational inputs with numbered options',
          patch_instruction: 'When intent is ambiguous, present clear numbered menu options to help user navigate.'
        };
      }
    }

    if (parsedPatch && parsedPatch.rule_key && parsedPatch.patch_instruction) {
      const sanitizedKey = parsedPatch.rule_key.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 50);
      const instruction = parsedPatch.patch_instruction.trim();

      const violatesLock = /\b(bypass vin|ignore vin|skip otp|disable auth|drop table|modify schema)\b/i.test(instruction);
      if (!violatesLock) {
        const nowIso = new Date().toISOString();
        const { error: upsertErr } = await supabase
          .from('saka_dynamic_rules')
          .upsert({
            rule_key: sanitizedKey,
            rule_description: parsedPatch.rule_description || 'Sentinel-generated friction mitigation',
            patch_instruction: instruction,
            is_active: true,
            updated_at: nowIso
          }, { onConflict: 'rule_key' });

        if (!upsertErr) {
          patches.push({
            rule_key: sanitizedKey,
            rule_description: parsedPatch.rule_description,
            patch_instruction: instruction,
            friction_type: friction.type
          });
        } else {
          console.error('[Sentinel Dynamic Rule Upsert Error]:', upsertErr.message);
        }
      }
    }
  }

  return {
    status: 'success',
    friction_detected: detectedFrictions.length,
    patches_created: patches.length,
    patches
  };
}

export async function generateWeeklyFeaturePlan(providedSupabase) {
  const supabase = getSupabase(providedSupabase);
  const ai = getGeminiClient();

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Ingest Weekly Transcripts
  const { data: recentTranscripts } = await supabase
    .from('chat_transcripts')
    .select('message_text')
    .eq('sender', 'user')
    .gte('created_at', oneWeekAgo)
    .limit(150);

  const { data: recentFriction } = await supabase
    .from('chat_friction_logs')
    .select('transcript_snippet, friction_type')
    .gte('detected_at', oneWeekAgo)
    .limit(50);

  if (!recentTranscripts || recentTranscripts.length < 5) {
    return { status: 'success', message: 'Not enough conversation data this week to synthesize a meaningful feature blueprint.' };
  }

  const rawCorpus = recentTranscripts.map(t => t.message_text).join('\n') + '\n' + 
                    (recentFriction || []).map(f => `[${f.friction_type}] ${f.transcript_snippet}`).join('\n');

  const horizonPrompt = `You are Sentinel Horizon, the evolutionary architect for Saka Fleet. 
Analyze the following raw WhatsApp chat transcripts and friction logs from the past week.
Identify recurring driver pain points, unhandled intents, feature requests, or slang that Saka doesn't yet support perfectly.

Synthesize the single most valuable feature proposal to make Saka Fleet the #1 vehicle management companion for everyday drivers.

Output ONLY valid JSON matching this schema:
{
  "proposal_code": "FEAT-2026-WXX-XX",
  "title": "string",
  "target_persona": "string",
  "driver_value_proposition": "string",
  "evidence_quotes": "string",
  "technical_spec": "string",
  "impact_score": number (1-10)
}

RAW CHAT DATA:
${rawCorpus.slice(0, 15000)}`;

  let parsedProposal = null;
  const candidateModels = ['gemini-3.8-flash', process.env.GEMINI_MODEL, 'gemini-flash-latest'].filter(Boolean);

  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: horizonPrompt }] }],
        config: { responseMimeType: 'application/json' }
      });
      if (response && response.text) {
        const cleaned = response.text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
        parsedProposal = JSON.parse(cleaned);
        if (parsedProposal && parsedProposal.proposal_code) break;
      }
    } catch (e) {
      console.warn(`[Sentinel Horizon] Model ${modelName} failed:`, e.message);
    }
  }

  if (!parsedProposal || !parsedProposal.proposal_code) {
    return { status: 'error', message: 'Failed to synthesize feature plan from AI.' };
  }

  // 2. Insert into Supabase
  try {
    await supabase.from('weekly_feature_proposals').insert([{
      proposal_code: parsedProposal.proposal_code,
      title: parsedProposal.title,
      target_persona: parsedProposal.target_persona,
      driver_value_proposition: parsedProposal.driver_value_proposition,
      evidence_quotes: parsedProposal.evidence_quotes,
      technical_spec: parsedProposal.technical_spec,
      impact_score: parsedProposal.impact_score
    }]);
  } catch (err) {
    console.error('[Sentinel Horizon] DB Insert Error:', err.message);
    return { status: 'error', message: 'Synthesized plan but failed to save to database.' };
  }

  // 3. Dispatch to Superadmin
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  if (superadminPhone) {
    const waMsg = `🌟 *Saka Sentinel Horizon — Weekly Feature Evolution* 🚀\n\nAnalyzed ${recentTranscripts.length} driver exchanges this week.\nTop Driver Feature Opportunity:\n\n💡 *${parsedProposal.title}*\n• *Why:* ${parsedProposal.evidence_quotes.substring(0, 100)}...\n• *Driver Value:* ${parsedProposal.driver_value_proposition}\n• *Impact:* ${parsedProposal.impact_score}/10\n\n_Text "admin proposals" to review._`;
    try {
      const token = process.env.META_WHATSAPP_TOKEN;
      const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
      const cleanPhone = superadminPhone.replace(/[^\d]/g, '');
      if (token && phoneNumberId && cleanPhone) {
        await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: cleanPhone, type: 'text', text: { body: waMsg } })
        });
      }
    } catch {}
  }

  return { status: 'success', message: `✅ Sentinel Horizon generated blueprint: ${parsedProposal.title}` };
}



