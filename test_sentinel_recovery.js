import { monitorActiveConversations } from './src/workers/sentinel.js';

/**
 * Targeted suite: Sentinel real-time conversation stall recovery.
 * Fully mocked Supabase + Meta fetch — no database rows or WhatsApp messages.
 */

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}

const PHONE = '+254700000001';
const OLD_TS = new Date(Date.now() - 40 * 60 * 1000).toISOString();

function makeSupabase(state) {
  const rowRef = {
    rows: [{ phone_number: PHONE, state, updated_at: OLD_TS }]
  };
  const inserts = { transcripts: [], friction: [] };
  const updates = [];

  const client = {
    from(table) {
      if (table === 'chat_sessions') {
        return {
          select: () => ({
            lt: () => ({
              order: () => ({
                limit: async () => ({ data: rowRef.rows, error: null })
              })
            })
          }),
          update: (patch) => ({
            eq: async () => {
              updates.push(patch);
              rowRef.rows = rowRef.rows.map((r) => ({ ...r, state: patch.state, updated_at: patch.updated_at }));
              return { error: null };
            }
          })
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { preferred_language: 'English', unit_system: 'metric' }, error: null })
            })
          })
        };
      }
      if (table === 'chat_transcripts') {
        return { insert: async (rows) => { inserts.transcripts.push(...rows); return { error: null }; } };
      }
      if (table === 'chat_friction_logs') {
        return { insert: async (rows) => { inserts.friction.push(...rows); return { error: null }; } };
      }
      return {};
    }
  };

  return { client, inserts, updates, rowRef };
}

const activeQuizState = {
  session: {
    quiz: {
      flow: 'log_expense',
      phase: 'question',
      answers: { expense_type: 'Fuel' }
    }
  },
  recovery: {}
};

const originalFetch = global.fetch;
const originalKey = process.env.DEEPSEEK_API_KEY;

async function run() {
  // Force deterministic fallback text instead of a real DeepSeek call.
  process.env.DEEPSEEK_API_KEY = '';
  process.env.META_PHONE_NUMBER_ID = '1234567890';
  process.env.META_WHATSAPP_TOKEN = 'test-token';
  process.env.SENTINEL_STALL_MINUTES = '15';
  process.env.SENTINEL_MAX_NUDGES = '2';

  const sentBodies = [];
  global.fetch = async (url, init) => {
    sentBodies.push({ url: String(url), body: JSON.parse(init?.body || '{}') });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  console.log('--- Test 1: stalled active quiz receives one recovery nudge ---');
  const first = makeSupabase(activeQuizState);
  const result = await monitorActiveConversations(first.client);

  assert(result.status === 'success', 'Monitor completes successfully');
  assert(result.nudged === 1, 'Exactly one stalled session is nudged');
  assert(sentBodies.length === 1, 'One WhatsApp nudge dispatched');
  assert(sentBodies[0].url.includes('graph.facebook.com'), 'Nudge uses the Meta Graph API');
  assert(sentBodies[0].body.to === '254700000001', 'Nudge targets the stalled phone');
  assert(typeof sentBodies[0].body.text?.body === 'string' && sentBodies[0].body.text.body.length > 10, 'Nudge text is present');
  assert(first.inserts.friction.length === 1, 'CONVERSATION_STALL friction logged');
  assert(first.inserts.friction[0].friction_type === 'CONVERSATION_STALL', 'Friction type is CONVERSATION_STALL');
  assert(first.updates.length === 1, 'Session snapshot updated with recovery state');
  assert(first.updates[0].state.recovery.nudges === 1, 'Recovery nudge counter incremented');
  assert(first.inserts.transcripts.length === 1, 'Nudge is recorded in chat_transcripts');

  console.log('\n--- Test 2: nudge is rate-limited within the stall window ---');
  const second = makeSupabase(first.rowRef.rows[0].state);
  const result2 = await monitorActiveConversations(second.client);
  assert(result2.nudged === 0, 'No second nudge inside the stall window');
  assert(sentBodies.length === 1, 'No additional WhatsApp message sent');

  console.log('\n--- Test 3: max nudges respected ---');
  const capped = makeSupabase({
    ...activeQuizState,
    recovery: { nudges: 2, lastNudgedAt: OLD_TS }
  });
  const result3 = await monitorActiveConversations(capped.client);
  assert(result3.nudged === 0, 'Sessions at the nudge cap are skipped');

  console.log('\n--- Test 4: sessions without an active quiz are ignored ---');
  const idle = makeSupabase({ session: { history: [] }, recovery: {} });
  const result4 = await monitorActiveConversations(idle.client);
  assert(result4.nudged === 0, 'Idle sessions are not nudged');

  console.log(`\n🎉 ALL SENTINEL RECOVERY TESTS PASSED (${passed} assertions).`);
}

run()
  .catch((err) => {
    global.fetch = originalFetch;
    process.env.DEEPSEEK_API_KEY = originalKey;
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
