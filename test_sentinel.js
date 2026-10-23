import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import { runHealthCheck, runConversationRefinement, ensureSentinelTables, logSystemError, logChatTranscript } from './src/workers/sentinel.js';
import { getSakaCorePrompt, processSakaMessage, DEFAULT_SAKA_CORE_PROMPT } from './sakaAi.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function runSentinelTests() {
  console.log('=== STARTING SAKA SENTINEL WORKER INTEGRATION TESTS ===\n');

  // Test 1: Sentinel Schema Validation
  console.log('--- Test 1: Ensuring Sentinel Tables Exist ---');
  const tableStatus = await ensureSentinelTables(supabase);
  console.log('Table Status:', JSON.stringify(tableStatus, null, 2));

  // Test 2: Error Logging & runHealthCheck()
  console.log('\n--- Test 2: Testing Error Logging & runHealthCheck() ---');
  const testError = new Error('Database connection pool exhausted during peak WhatsApp webhook traffic');
  testError.stack = 'Error: Database connection pool exhausted\n    at Pool.acquire (c:/dev/sakafleet/db.js:105:12)\n    at handleWhatsAppWebhook (c:/dev/sakafleet/index.js:802:15)';
  
  await logSystemError(supabase, testError, '/webhook/whatsapp');
  console.log('Logged test error log to error_logs table.');

  const healthCheckResult = await runHealthCheck(supabase);
  console.log('runHealthCheck Result:', JSON.stringify({
    status: healthCheckResult.status,
    diagnosed_count: healthCheckResult.diagnosed_count,
    sample_diagnosis: healthCheckResult.diagnosed_logs?.[0]?.ai_diagnosis?.slice(0, 150) + '...'
  }, null, 2));

  if (healthCheckResult.diagnosed_count < 1) {
    throw new Error('runHealthCheck failed to diagnose unresolved errors');
  }

  // Test 3: Chat Transcript & runConversationRefinement()
  console.log('\n--- Test 3: Testing Chat Transcripts & runConversationRefinement() ---');
  const testPhone = '+254711999888';
  await logChatTranscript(supabase, testPhone, 'user', 'Nipange bro, KDA 123A fuel nimeeka KES 3000 leo ashante');
  await logChatTranscript(supabase, testPhone, 'assistant', 'Logged expense of KES 3000 for vehicle KDA 123A.');
  console.log('Logged test chat transcripts to chat_transcripts table.');

  const refinementResult = await runConversationRefinement(supabase);
  console.log('runConversationRefinement Result:', JSON.stringify({
    status: refinementResult.status,
    insights: refinementResult.insights,
    prompt_adjustments: refinementResult.prompt_adjustments,
    saka_core_prompt_updated: refinementResult.saka_core_prompt_updated
  }, null, 2));

  if (!refinementResult.saka_core_prompt_updated) {
    throw new Error('runConversationRefinement failed to update system_config saka_core_prompt');
  }

  // Test 4: sakaAi Dynamic Prompt Retrieval from Supabase
  console.log('\n--- Test 4: Testing sakaAi.js Dynamic Prompt Retrieval ---');
  const fetchedPrompt = await getSakaCorePrompt(supabase);
  console.log('Fetched prompt from Supabase length:', fetchedPrompt.length);
  console.log('Differs from default baseline prompt:', fetchedPrompt !== DEFAULT_SAKA_CORE_PROMPT);

  const aiResult = await processSakaMessage('Swahili', 'Habari, nataka kuangalia magari yangu', [], [], supabase);
  console.log('Saka AI Response with dynamic prompt:', JSON.stringify(aiResult, null, 2));

  console.log('\n=== ALL SAKA SENTINEL WORKER TESTS PASSED SUCCESSFULLY ===');
}

runSentinelTests().catch(err => {
  console.error('Sentinel Test Failed:', err);
  process.exit(1);
});
