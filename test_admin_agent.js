import {
  ADMIN_AGENT_TOOLS,
  buildAdminToolPrompt,
  buildAdminSynthesisPrompt,
  clampAdminAgentHours,
  classifyAdminToolRequest,
  executeAdminAgentTool,
  processAdminMessage,
  handleSuperadminFlow
} from './src/services/superadmin.js';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { runWithCleanup } from './scripts/testCleanup.js';

/**
 * Saka Fleet — Admin AI Agent tests (v1.78.0, Phase 17, section 206).
 * ------------------------------------------------------------------
 * Fully offline (injected `generate` + mock Supabase + injected health check):
 * registry/prompt consistency, tool classification, engine tool execution,
 * synthesis, deterministic fallbacks, audits, and the handleSuperadminFlow
 * seam (natural language → agent; static commands still win with ZERO tokens;
 * inactive session / non-superadmin phone never reach the model).
 */

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const ADMIN_PHONE = '+254700000001';
const NON_ADMIN_PHONE = '+254700000009';

/** Deterministic fake generate: one responder per purpose, records every call. */
function makeGenerate(map) {
  const calls = [];
  const fn = async (opts = {}) => {
    calls.push(opts);
    const responder = map[opts.purpose];
    if (typeof responder === 'function') return responder(opts);
    return responder === undefined ? '' : responder;
  };
  fn.calls = calls;
  return fn;
}
const promptsFor = (generate, purpose) => generate.calls.filter((call) => call.purpose === purpose).map((call) => call.prompt);

function sessionMock(extra = {}) {
  return createMockSupabase({
    superadmin_sessions: [{ phone_number: ADMIN_PHONE, is_active: true, last_active_at: new Date().toISOString() }],
    admin_audit_logs: [],
    ...extra
  });
}

async function runTests() {
  const savedAdmin = process.env.SUPERADMIN_PHONE;
  process.env.SUPERADMIN_PHONE = ADMIN_PHONE;
  try {
    console.log('=== SAKA FLEET — ADMIN AI AGENT TESTS (v1.78.0) ===\n');

    console.log('--- Test 1: tool registry ---');
    check(Object.isFrozen(ADMIN_AGENT_TOOLS), 'the tool registry is frozen');
    check(ADMIN_AGENT_TOOLS.length === 3, 'exactly three tools ship');
    check(ADMIN_AGENT_TOOLS.map((tool) => tool.name).join(',') === 'get_system_health,get_ai_usage,get_open_proposals', 'the tool names are the locked contract');
    check(ADMIN_AGENT_TOOLS.every((tool) => tool.description && Array.isArray(tool.args)), 'every tool declares a description and its args');

    console.log('\n--- Test 2: prompts are generated from the registry ---');
    const toolPrompt = buildAdminToolPrompt('how many tokens did we use today?');
    check(ADMIN_AGENT_TOOLS.every((tool) => toolPrompt.includes(tool.name)), 'the router prompt names every registered tool (no drift)');
    check(toolPrompt.includes('Return ONLY JSON') && toolPrompt.includes('Never answer the question yourself'), 'the router may only pick a tool, never answer');
    check(buildAdminToolPrompt('x'.repeat(5000)).length < 1500, 'the question is truncated (bounded prompt)');
    const synthesisPrompt = buildAdminSynthesisPrompt('tell me usage', 'get_ai_usage', 'Requests: 42');
    check(synthesisPrompt.includes('Use ONLY the FACTS') && synthesisPrompt.includes('verbatim') && synthesisPrompt.includes('never invent'), 'the synthesis prompt forbids invented numbers');
    check(synthesisPrompt.includes('FACTS (tool: get_ai_usage):') && synthesisPrompt.includes('Requests: 42'), 'the engine facts ride the synthesis prompt verbatim');

    console.log('\n--- Test 3: classification ---');
    const happy = makeGenerate({ admin_tool_call: '{"tool":"get_ai_usage","hours":48}' });
    const decision = await classifyAdminToolRequest('tokens yesterday?', { generate: happy });
    check(decision.tool === 'get_ai_usage' && decision.hours === 48, 'a valid JSON answer picks the tool + window');
    check(happy.calls[0].purpose === 'admin_tool_call' && happy.calls[0].jsonMode === true, 'the router call is purpose-tagged + jsonMode');
    check((await classifyAdminToolRequest('x', { generate: makeGenerate({ admin_tool_call: '{"tool":"get_ai_usage","hours":999}' }) })).hours === 168, 'hours clamp to the 168h registry ceiling');
    check((await classifyAdminToolRequest('x', { generate: makeGenerate({ admin_tool_call: '{"tool":"get_ai_usage","hours":0}' }) })).hours === 24, 'hours 0 falls back to the 24h default');
    check(clampAdminAgentHours('abc') === 24 && clampAdminAgentHours(2.6) === 3, 'clamp handles garbage and rounds');
    check((await classifyAdminToolRequest('x', { generate: makeGenerate({ admin_tool_call: '{"tool":"drop_database"}' }) })).tool === 'none', 'an unregistered tool degrades to none');
    check((await classifyAdminToolRequest('x', { generate: makeGenerate({ admin_tool_call: 'not json' }) })).tool === 'none', 'garbage degrades to none');
    check((await classifyAdminToolRequest('x', { generate: makeGenerate({ admin_tool_call: '' }) })).tool === 'none', 'an empty completion degrades to none');
    const throwing = async () => { throw new Error('provider down'); };
    check((await classifyAdminToolRequest('x', { generate: throwing })).tool === 'none', 'a provider failure never throws (none)');

    console.log('\n--- Test 4: AI-usage tool (engine digest → synthesis) ---');
    const usageMock = sessionMock();
    const usageGenerate = makeGenerate({
      admin_tool_call: '{"tool":"get_ai_usage","hours":24}',
      admin_synthesis: '💸 AI used 0 calls in the last 24h — nothing to pay for.'
    });
    const usageRes = await processAdminMessage(usageMock.client, ADMIN_PHONE, 'how many tokens did we use today?', { generate: usageGenerate });
    check(usageRes.reply === '💸 AI used 0 calls in the last 24h — nothing to pay for.' && usageRes.synthesized === true, 'the synthesized reply is the answer');
    check(usageRes.tool === 'get_ai_usage' && usageRes.ok === true, 'the engine executed the real ai-stats handler');
    const usageSynthesis = promptsFor(usageGenerate, 'admin_synthesis')[0] || '';
    check(usageSynthesis.includes('Saka AI Telemetry') && usageSynthesis.includes('how many tokens did we use today?'), 'the synthesis prompt carries the REAL deterministic digest + the question');
    check(usageMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_AI_TOOL' && row.details?.tool === 'get_ai_usage' && row.details?.ok === true), 'ADMIN_AI_TOOL audited the execution');
    check(usageMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_AI_AGENT' && row.details?.tool === 'get_ai_usage' && row.details?.fallback === null), 'ADMIN_AI_AGENT audited the turn');

    console.log('\n--- Test 5: synthesis failure degrades to the deterministic digest ---');
    const fallbackMock = sessionMock();
    const fallbackGenerate = makeGenerate({ admin_tool_call: '{"tool":"get_ai_usage","hours":24}', admin_synthesis: '' });
    const fallbackRes = await processAdminMessage(fallbackMock.client, ADMIN_PHONE, 'ai spend?', { generate: fallbackGenerate });
    check(fallbackRes.reply.includes('Saka AI Telemetry') && fallbackRes.synthesized === false, 'an empty synthesis falls back to the deterministic digest (never worse)');
    check(fallbackMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_AI_AGENT' && row.details?.fallback === 'deterministic_tool_reply'), 'the fallback is named in the audit');

    console.log('\n--- Test 6: no tool → the clarify reply (deterministic) ---');
    const clarifyMock = sessionMock();
    const clarifyGenerate = makeGenerate({ admin_tool_call: '{"tool":"none"}' });
    const clarifyRes = await processAdminMessage(clarifyMock.client, ADMIN_PHONE, 'tell me a joke', { generate: clarifyGenerate });
    check(/not sure which admin action/.test(clarifyRes.reply) && clarifyRes.tool === 'none', 'an out-of-scope message keeps the did-you-mean clarify');
    check(clarifyMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_AI_AGENT' && row.details?.tool === 'none' && row.details?.fallback === 'clarify'), 'the clarify turn is audited');
    check(promptsFor(clarifyGenerate, 'admin_synthesis').length === 0, 'no synthesis call is spent when no tool is picked');

    console.log('\n--- Test 7: proposals tool reads the real backlog ---');
    const proposalMock = sessionMock({
      remediation_proposals: [{ proposal_code: 'PROP-2026-11-08-01', title: 'Convo fix', status: 'PENDING_APPROVAL', risk_level: 'low', created_at: '2026-11-08T05:00:00Z' }]
    });
    const proposalGenerate = makeGenerate({ admin_tool_call: '{"tool":"get_open_proposals"}', admin_synthesis: 'One pending fix: PROP-2026-11-08-01.' });
    const proposalRes = await processAdminMessage(proposalMock.client, ADMIN_PHONE, 'anything pending?', { generate: proposalGenerate });
    check(proposalRes.ok === true && proposalRes.reply.includes('PROP-2026-11-08-01'), 'the reply comes from the live proposal row');
    check((promptsFor(proposalGenerate, 'admin_synthesis')[0] || '').includes('PROP-2026-11-08-01'), 'the proposal code reached the model through the FACTS block (engine-owned)');

    console.log('\n--- Test 8: health tool uses the shared facts ---');
    const healthMock = sessionMock();
    const healthGenerate = makeGenerate({ admin_tool_call: '{"tool":"get_system_health"}', admin_synthesis: 'All systems go.' });
    const healthRes = await processAdminMessage(healthMock.client, ADMIN_PHONE, 'is everything okay?', {
      generate: healthGenerate,
      healthCheck: async () => ({ status: 'healthy', diagnosed_count: 2 })
    });
    check(healthRes.ok === true && healthRes.reply === 'All systems go.', 'the health question is answered from collectHealthFacts');
    const healthPrompt = promptsFor(healthGenerate, 'admin_synthesis')[0] || '';
    check(healthPrompt.includes('Database Connection: Connected & Operational') && healthPrompt.includes('AI Diagnosed Errors in Last Run: 2'), 'the shared health telemetry reached the model verbatim');

    console.log('\n--- Test 9: unknown tool execution is rejected ---');
    const unknownExec = await executeAdminAgentTool(sessionMock().client, 'delete_everything');
    check(unknownExec.ok === false, 'the executor refuses unknown tools (defence in depth)');

    console.log('\n--- Test 10: handleSuperadminFlow seam ---');
    const hookMock = sessionMock();
    const hookGenerate = makeGenerate({ admin_tool_call: '{"tool":"get_ai_usage","hours":24}', admin_synthesis: 'We spent nothing on AI today.' });
    const hookRes = await handleSuperadminFlow(hookMock.client, ADMIN_PHONE, 'how many tokens did we use today?', { generate: hookGenerate });
    check(hookRes.isSuperadmin === true && hookRes.reply === 'We spent nothing on AI today.', 'a natural-language admin question reaches the agent');
    check(hookGenerate.calls.map((call) => call.purpose).join(',') === 'admin_tool_call,admin_synthesis', 'exactly two purpose-tagged calls per agent turn');

    const inactiveMock = createMockSupabase({
      superadmin_sessions: [{ phone_number: ADMIN_PHONE, is_active: false, last_active_at: new Date().toISOString() }],
      admin_audit_logs: []
    });
    const inactiveGenerate = makeGenerate({});
    const inactiveRes = await handleSuperadminFlow(inactiveMock.client, ADMIN_PHONE, 'how many tokens did we use today?', { generate: inactiveGenerate });
    check(inactiveRes.isSuperadmin === true && /adminstart/.test(inactiveRes.reply), 'an inactive session is asked to adminstart (agent never runs)');
    check(inactiveGenerate.calls.length === 0, 'no token is spent without an active session');

    const statsMock = sessionMock();
    let statsCalls = 0;
    const statsGenerate = async () => { statsCalls += 1; throw new Error('static commands must never call the model'); };
    const statsRes = await handleSuperadminFlow(statsMock.client, ADMIN_PHONE, 'admin ai-stats', { generate: statsGenerate });
    check(statsRes.isSuperadmin === true && statsRes.reply.includes('Saka AI Telemetry'), 'the static command still wins its own turn');
    check(statsCalls === 0, 'the static command spent ZERO tokens (precedence preserved)');

    const strangerGenerate = makeGenerate({});
    const strangerRes = await handleSuperadminFlow(sessionMock().client, NON_ADMIN_PHONE, 'how many tokens did we use today?', { generate: strangerGenerate });
    check(strangerRes.isSuperadmin === false && strangerGenerate.calls.length === 0, 'a non-superadmin phone never reaches the agent');

    console.log(`\n🎉 ALL ${passed} ADMIN AGENT ASSERTIONS PASSED`);

  } finally {
    if (savedAdmin === undefined) delete process.env.SUPERADMIN_PHONE;
    else process.env.SUPERADMIN_PHONE = savedAdmin;
  }
}

runWithCleanup({ testFn: runTests });
