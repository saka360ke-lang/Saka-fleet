import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chatCompletion, generateText, parseJsonSafely } from '../src/services/aiClient.js';
import { installAiUsageSink } from '../src/services/aiUsageLog.js';

// v1.61.15 — diagnostic calls are AI traffic too: log them when a database is
// configured (rules 20/21). Without Supabase the check still runs, unlogged.
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  installAiUsageSink(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  }));
}

async function run() {
  console.log('=== DEEPSEEK CONNECTIVITY CHECK ===\n');

  // 1. Plain text
  const plain = await generateText({
    prompt: 'Reply with exactly: SAKA_DEEPSEEK_OK',
    maxTokens: 20,
    temperature: 0
  });
  console.log('1) Plain text:', plain ? plain.trim() : '(null)');
  if (!plain || !plain.includes('SAKA_DEEPSEEK_OK')) {
    throw new Error('Plain-text DeepSeek call failed');
  }

  // 2. JSON mode with system prompt
  const jsonRes = await chatCompletion({
    system: 'You are a fleet assistant. Output only valid JSON.',
    messages: [{ role: 'user', content: 'Classify "Logged 30L fuel KES 5500" into an intent JSON with keys intent and reply_message.' }],
    jsonMode: true,
    maxTokens: 200,
    temperature: 0
  });
  console.log('2) JSON mode ok:', jsonRes.ok, '| model:', jsonRes.model);
  const parsed = parseJsonSafely(jsonRes.text);
  console.log('   Parsed:', JSON.stringify(parsed));
  if (!parsed || !parsed.intent) {
    throw new Error('JSON-mode DeepSeek call failed');
  }

  // 3. Conversation history handling
  const histRes = await chatCompletion({
    system: 'You are a terse assistant. Output only valid JSON.',
    messages: [
      { role: 'user', content: 'My plate is KAS 628T.' },
      { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: 'Which plate did I just mention? Reply as JSON with key plate.' }
    ],
    jsonMode: true,
    maxTokens: 100,
    temperature: 0
  });
  const histParsed = parseJsonSafely(histRes.text);
  console.log('3) History-aware response:', JSON.stringify(histParsed));
  if (!histParsed || !JSON.stringify(histParsed).includes('KAS')) {
    throw new Error('DeepSeek did not retain conversation history');
  }

  console.log('\n🎉 DEEPSEEK INTEGRATION VERIFIED');
}

run().catch((err) => {
  console.error('❌ DeepSeek check failed:', err.message);
  process.exit(1);
});
