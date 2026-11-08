/**
 * Saka Fleet — Amina, the autonomous care agent (v1.80.0, Phase 19)
 * ----------------------------------------------------------------
 * Every inbound email at support@reports.sakafleet.com becomes a ticket. Amina
 * then INVESTIGATES it (profile, vehicles, recent errors, recent chat, billing
 * mirror) before she decides anything, and only two outcomes exist:
 *
 *   resolve  -> she sends the reply herself (email), marks the ticket RESOLVED
 *               and records the draft + an audit row;
 *   escalate  -> she states exactly what she checked and where she is stuck,
 *               forwards the case to CARE_ESCALATION_EMAIL (default
 *               support@sakafleet.com) with an [SFC-…] subject tag, marks the
 *               ticket ESCALATED, and pings the superadmin.
 *
 * Absolute boundaries: the model only DRAFTS text and PICKS a tool. Every fact,
 * number, status write, email send and audit entry is engine-owned (rules
 * 20/28/46). Billing, refunds, VIN, ledger edits and account actions are
 * pre-gated to a human without spending a single token. Kill switch:
 * CARE_AI_ENABLED (default OFF — the human path stays byte-identical).
 */
import { chatCompletion } from './aiClient.js';
import { sendCareReplyEmail, sendCareEscalationEmail } from './mailer.js';
import { escalateCareToSuperadmin, shouldEscalateCare } from './customerCare.js';
import {
  CARE_STATUS,
  CARE_PRIORITY,
  appendTicketMessage,
  auditCareAction,
  updateCareTicket
} from './careConsole.js';
import {
  CARE_LEARNING_MAX_ROWS,
  getRecentCareLearnings,
  formatCareLearnings,
  parseCareAiJson,
  careTicketTag
} from './careLearning.js';
import { CARE_TOOLS, CARE_TOOL_NAMES, formatCareKnowledge, formatCareTools } from './careKnowledge.js';
import { logWriteFailure } from './systemErrors.js';

export const CARE_AI_MAX_INVESTIGATION_LOOPS = 3;
export const CARE_AI_DEFAULT_CONFIDENCE_FLOOR = 0.7;
export const CARE_AI_DEFAULT_ESCALATION_EMAIL = 'support@sakafleet.com';
export const CARE_AI_MAX_DRAFT_CHARS = 2000;
export const AMINA_NAME = 'Amina';

const TRUTHY = new Set(['on', 'true', '1']);

/** The autonomy gate. Off by default, mirroring every other autonomy switch. */
export function isCareAiEnabled() {
  return TRUTHY.has(String(process.env.CARE_AI_ENABLED || 'off').toLowerCase());
}

export function careConfidenceFloor() {
  const value = Number(process.env.CARE_AI_CONFIDENCE_FLOOR || CARE_AI_DEFAULT_CONFIDENCE_FLOOR);
  if (!Number.isFinite(value)) return CARE_AI_DEFAULT_CONFIDENCE_FLOOR;
  return Math.min(Math.max(value, 0), 1);
}

export function careEscalationEmail() {
  return String(process.env.CARE_ESCALATION_EMAIL || CARE_AI_DEFAULT_ESCALATION_EMAIL).trim();
}

/**
 * Zero-token pre-gate. Money, disputes and dangerous actions never reach the
 * model: they go straight to the human with a named reason (rule 28).
 */
const CARE_MONEY_GATE_RE = /\b(refund|chargeback|charged twice|double charge|duplicate (?:charge|payment)|dispute|reversal|reverse the|invoice|payment failed|failed payment|paystack|billing|overcharged|undercharged)\b/i;
const CARE_DANGER_GATE_RE = /\b(delete my account|erase my data|data deletion|gdpr|legal action|lawyer|sue|police|account takeover|hacked|fraud)\b/i;

export function carePreGate(text = '', priority = 'medium') {
  const body = String(text || '');
  if (CARE_DANGER_GATE_RE.test(body)) return 'dangerous-action';
  if (CARE_MONEY_GATE_RE.test(body)) return 'billing';
  if (String(priority || '').toLowerCase() === CARE_PRIORITY.HIGH) return 'priority-high';
  if (shouldEscalateCare(body, priority)) return 'escalation-keyword';
  return null;
}

function cleanSubject(subject) {
  return String(subject || '(no subject)')
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || '(no subject)';
}

/** Customer-facing reply subject: never carries the internal tag. */
export function careReplySubject(ticket = {}) {
  return `Re: ${cleanSubject(ticket.subject)}`;
}

/** Human-facing escalation subject: always carries the routing tag. */
export function careEscalationSubject(ticket = {}) {
  const tag = careTicketTag(ticket.ticketId) || '[SFC-unknown]';
  return `${tag} Re: ${cleanSubject(ticket.subject)}`;
}

/**
 * Amina's system prompt. Exported verbatim so the training suite can pin the
 * investigation directive (rules 13/52).
 */
export function buildCareInvestigationPrompt({ learnings = [] } = {}) {
  return `You are ${AMINA_NAME}, the autonomous customer-care agent for Saka Fleet.
Saka is a WhatsApp-first fleet and asset assistant (fuel, expenses, reminders, documents, reports, web dashboard, subscriptions) used around the world.

YOUR JOB
1. Read the customer's email and work out what they were trying to do.
2. INVESTIGATE BEFORE YOU DECIDE. You have tools; use them. Never guess when a tool can tell you.
3. Reply ONLY with JSON — exactly one of these shapes:
   { "tool": "<tool name>", "args": { ... } }
   { "action": "reply", "reply": "<the email reply>", "confidence": 0.0-1.0, "reason": "<one line>" }
   { "action": "escalate", "reason": "<what you are stuck on>", "confidence": 0.0-1.0 }

TOOLS (engine-executed; you only choose them)
${formatCareTools(CARE_TOOLS)}

INVESTIGATION DIRECTIVE (absolute)
- A first-instinct answer is NOT enough. If the email mentions a broken flow, a missing record, a wrong number, a stuck quiz or a failed action, you MUST investigate first: check the profile, the recent errors and the recent chat before answering.
- Before you escalate, you must be able to state: "I checked X, Y and Z; I am still stuck on C."
- Escalate ONLY when: (a) the issue involves money, refunds, legal, safety or an account/data action (the engine pre-gates those anyway); (b) after investigating, your confidence is below ${careConfidenceFloor()}; or (c) the fix needs a human (a data change, a billing outcome, a VIN, an account action).
- Never invent numbers, dates, prices, refunds, tiers, ticket states or policy. Never promise an action you cannot take. Never ask for a PIN, OTP, password or card number. Never reveal another customer's data.
- Write in the customer's language and register. Short and warm, one clear next step, no walls of text. Sign as "${AMINA_NAME}, Saka Care".

WHAT SAKA CAN DO (the only facts you may use)
${formatCareKnowledge()}

LEARNED RULES (lessons from past human replies — follow them)
${formatCareLearnings(learnings)}

Remember: you are the last line before a human. Exhaust every tool before you escalate, and when you do escalate, make it effortless for the human by naming exactly what you checked.`;
}

/* ------------------------------------------------------------------ */
/* Investigation tools — engine-executed, read-only, never throw       */
/* ------------------------------------------------------------------ */

function bounded(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function findProfileByEmail(supabase, email) {
  const clean = bounded(email, 200).toLowerCase();
  if (!clean) return null;
  try {
    // `*` avoids the rule-50 profile drift class (optional columns missing).
    const { data } = await supabase.from('profiles').select('*').ilike('email', clean).limit(1);
    return (data && data[0]) || null;
  } catch {
    return null;
  }
}

export async function toolGetProfileContext(supabase, { email = '' } = {}) {
  const profile = await findProfileByEmail(supabase, email);
  if (!profile) return { found: false, email: bounded(email, 200).toLowerCase() };
  let vehicles = [];
  try {
    const { data } = await supabase
      .from('vehicles')
      .select('*')
      .eq('owner_id', profile.id)
      .limit(20);
    vehicles = (data || []).filter((row) => !row.deleted_at);
  } catch { vehicles = []; }
  let trial = null;
  try {
    const { data } = await supabase
      .from('trial_sessions')
      .select('status, tier, started_at, ends_at, activated')
      .eq('owner_id', profile.id)
      .limit(1);
    trial = (data && data[0]) || null;
  } catch { trial = null; }
  return {
    found: true,
    name: profile.full_name || null,
    phone: profile.phone_number || null,
    email: profile.email || null,
    country: profile.country || profile.country_code || null,
    plan: profile.subscription_tier || 'free',
    joinedAt: profile.created_at || null,
    trial: trial ? { status: trial.status, tier: trial.tier, endsAt: trial.ends_at, activated: Boolean(trial.activated) } : null,
    vehicles: vehicles.map((vehicle) => ({
      plate: vehicle.plate_number || null,
      makeModel: vehicle.make_model || null,
      status: vehicle.status || 'ACTIVE',
      odometer: Number(vehicle.current_mileage ?? vehicle.odometer_reading) || null
    }))
  };
}

export async function toolGetRecentErrors(supabase, { phone = '' } = {}) {
  const needle = bounded(phone, 60);
  if (!needle) return { error: 'no-phone' };
  const digits = needle.replace(/[^0-9]/g, '');
  const pattern = digits.length >= 6 ? digits : needle;
  try {
    const { data } = await supabase
      .from('error_logs')
      .select('error_message, route, status, created_at')
      .ilike('error_message', '%' + pattern + '%')
      .order('created_at', { ascending: false })
      .limit(5);
    const rows = data || [];
    return {
      matches: rows.length,
      errors: rows.map((row) => ({
        message: bounded(row.error_message, 240),
        route: row.route || null,
        status: row.status || null,
        at: row.created_at || null
      }))
    };
  } catch (err) {
    return { error: bounded(err.message, 160) };
  }
}

export async function toolGetRecentChat(supabase, { phone = '' } = {}) {
  const clean = String(phone || '').replace(/[^\d+]/g, '');
  if (!clean) return { error: 'no-phone' };
  try {
    const { data } = await supabase
      .from('chat_history')
      .select('role, message, created_at')
      .eq('user_phone', clean)
      .order('created_at', { ascending: false })
      .limit(10);
    const rows = (data || []).slice().reverse();
    return {
      matches: rows.length,
      messages: rows.map((row) => ({
        from: row.role === 'assistant' ? 'saka' : 'user',
        text: bounded(row.message, 300),
        at: row.created_at || null
      }))
    };
  } catch (err) {
    return { error: bounded(err.message, 160) };
  }
}

export async function toolGetPaymentStatus(supabase, { email = '' } = {}) {
  const profile = await findProfileByEmail(supabase, email);
  if (!profile) return { found: false, email: bounded(email, 200).toLowerCase() };
  let subscriptions = [];
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('tier, interval, status, current_period_end, created_at')
      .eq('owner_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(5);
    subscriptions = data || [];
  } catch { subscriptions = []; }
  let events = [];
  try {
    const { data } = await supabase
      .from('paystack_webhook_events')
      .select('event_id, event_type, processed_at, payload')
      .order('processed_at', { ascending: false })
      .limit(20);
    const ownerId = String(profile.id || '').toLowerCase();
    const ownerEmail = String(profile.email || email || '').toLowerCase();
    events = (data || [])
      .filter((row) => {
        const text = JSON.stringify(row.payload || '').toLowerCase();
        return (ownerId && text.includes(ownerId)) || (ownerEmail && text.includes(ownerEmail));
      })
      .slice(0, 5);
  } catch { events = []; }
  return {
    found: true,
    plan: profile.subscription_tier || 'free',
    subscriptionStatus: profile.subscription_status || null,
    trialEndsAt: profile.trial_ends_at || null,
    subscriptions: subscriptions.map((row) => ({
      tier: row.tier || null,
      interval: row.interval || null,
      status: row.status || null,
      currentPeriodEnd: row.current_period_end || null
    })),
    recentEvents: events.map((row) => ({ type: row.event_type || null, at: row.processed_at || null })),
    note: 'Read-only mirror. Refunds, reversals and disputes are human-owned.'
  };
}

export async function executeCareTool(name, args = {}, { supabase } = {}) {
  if (!supabase) return { error: 'no-database' };
  const tool = String(name || '');
  if (!CARE_TOOL_NAMES.includes(tool)) return { error: 'unknown-tool', tool };
  if (tool === 'get_profile_context') return toolGetProfileContext(supabase, args || {});
  if (tool === 'get_recent_errors') return toolGetRecentErrors(supabase, args || {});
  if (tool === 'get_recent_chat') return toolGetRecentChat(supabase, args || {});
  return toolGetPaymentStatus(supabase, args || {});
}

/* ------------------------------------------------------------------ */
/* The investigation loop — up to 3 tool rounds, then a decision       */
/* ------------------------------------------------------------------ */

function summarizeStep(result) {
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return String(text || '').slice(0, 240);
  } catch {
    return '(unreadable result)';
  }
}

/** Context line for the first user message — engine data, never model output. */
export function buildCareContextText(ticket = {}) {
  return [
    'TICKET',
    `- from: ${ticket.fromEmail || 'unknown'}`,
    `- subject: ${bounded(ticket.subject, 200)}`,
    `- category: ${ticket.category || 'other'}`,
    `- priority: ${ticket.priority || 'medium'}`,
    `- email: ${bounded(ticket.text, 3500)}`
  ].join('\n');
}

export async function runCareInvestigation({ supabase, ticket = {}, deps = {} } = {}) {
  const aiCall = deps.aiCall || chatCompletion;
  const steps = [];
  let learnings = [];
  try {
    learnings = await getRecentCareLearnings(supabase, CARE_LEARNING_MAX_ROWS);
  } catch { learnings = []; }
  const system = buildCareInvestigationPrompt({ learnings });
  const messages = [{ role: 'user', content: buildCareContextText(ticket) }];
  for (let loop = 0; loop < CARE_AI_MAX_INVESTIGATION_LOOPS; loop += 1) {
    let raw = null;
    try {
      raw = await aiCall({
        purpose: 'care_investigation',
        system,
        messages,
        jsonMode: true,
        maxTokens: 700,
        temperature: 0.2
      });
    } catch (err) {
      return { action: 'escalate', reason: `investigation call failed: ${bounded(err.message, 120)}`, confidence: 0, steps, draft: null };
    }
    const parsed = parseCareAiJson(raw);
    if (!parsed) {
      messages.push({ role: 'assistant', content: String(raw || '').slice(0, 800) });
      messages.push({ role: 'user', content: 'That was not JSON. Reply with a tool call or a final JSON action.' });
      continue;
    }
    if (parsed.tool) {
      if (!CARE_TOOL_NAMES.includes(String(parsed.tool))) {
        messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
        messages.push({ role: 'user', content: `Unknown tool "${bounded(parsed.tool, 60)}". Use one of: ${CARE_TOOL_NAMES.join(', ')}.` });
        continue;
      }
      const result = await executeCareTool(parsed.tool, parsed.args || {}, { supabase });
      steps.push({ tool: parsed.tool, args: parsed.args || {}, result });
      messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
      messages.push({ role: 'user', content: `TOOL RESULT ${parsed.tool}: ${JSON.stringify(result).slice(0, 1600)}` });
      continue;
    }
    const confidence = Number(parsed.confidence);
    if (parsed.action === 'reply' && parsed.reply) {
      return {
        action: 'reply',
        draft: String(parsed.reply).trim().slice(0, CARE_AI_MAX_DRAFT_CHARS),
        confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
        reason: bounded(parsed.reason, 200),
        steps
      };
    }
    if (parsed.action === 'escalate') {
      return {
        action: 'escalate',
        reason: bounded(parsed.reason, 300) || 'model asked for a human',
        confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
        draft: parsed.reply ? String(parsed.reply).trim().slice(0, CARE_AI_MAX_DRAFT_CHARS) : null,
        steps
      };
    }
    messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
    messages.push({ role: 'user', content: 'Reply with a tool call, or a final {"action":"reply"|"escalate"} JSON.' });
  }
  return { action: 'escalate', reason: `investigation loop limit (${CARE_AI_MAX_INVESTIGATION_LOOPS}) reached without a decision`, confidence: 0, steps, draft: null };
}

/* ------------------------------------------------------------------ */
/* Escalation — named investigation, forwarded, tagged, audited        */
/* ------------------------------------------------------------------ */

/**
 * The human-facing escalation body. It always names what Amina checked and
 * where she stopped, so the human never starts from zero.
 */
export function buildCareEscalationEmail({ ticket = {}, steps = [], reason = '', draft = null } = {}) {
  const investigated = (steps || []).length
    ? steps.map((step) => `${step.tool} → ${summarizeStep(step.result)}`).join('\n  - ')
    : 'no tools were needed (the engine pre-gate sent this straight to a human)';
  const tried = (steps || []).length
    ? `I tried: ${[...new Set(steps.map((step) => step.tool))].join(', ')}.`
    : 'I did not attempt a customer reply.';
  return [
    `${AMINA_NAME} could not resolve this ticket and escalated it.`,
    '',
    `Ticket: ${ticket.ticketId || 'unknown'}`,
    `Customer: ${ticket.fromEmail || 'unknown'}`,
    `Subject: ${cleanSubject(ticket.subject)}`,
    `Category / priority: ${ticket.category || 'other'} / ${ticket.priority || 'medium'}`,
    '',
    'What I investigated:',
    `  - ${investigated}`,
    tried,
    `Where I am stuck: ${reason || 'unspecified'}`,
    ...(draft ? ['', 'Best draft I could prepare (NOT sent to the customer):', draft] : []),
    '',
    'Reply to this email and keep the [SFC-…] tag in the subject — your answer lands on the same ticket and teaches Amina for next time.'
  ].join('\n');
}

/** Status writes degrade on an un-migrated schema (rule 50). */
async function updateTicketSafe(supabase, ticketId, patch = {}) {
  const first = await updateCareTicket(supabase, ticketId, patch);
  if (first.ok || patch.ai_draft === undefined) return first;
  const { ai_draft: _dropped, ...rest } = patch;
  return updateCareTicket(supabase, ticketId, rest);
}

async function escalateCareTicket(supabase, ticket, outcome = {}, deps = {}) {
  const steps = outcome.steps || [];
  const draft = outcome.draft ? String(outcome.draft).slice(0, CARE_AI_MAX_DRAFT_CHARS) : null;
  const reason = String(outcome.reason || 'unspecified').slice(0, 300);
  await updateTicketSafe(supabase, ticket.ticketId, {
    status: CARE_STATUS.ESCALATED,
    priority: CARE_PRIORITY.HIGH,
    ai_draft: draft,
    internal_note: `${AMINA_NAME} investigated (${steps.length} step${steps.length === 1 ? '' : 's'}) and escalated: ${reason}`.slice(0, 900),
    updated_at: new Date().toISOString()
  });
  for (const step of steps) {
    await appendTicketMessage(supabase, {
      ticketId: ticket.ticketId,
      direction: 'internal',
      channel: 'ai',
      body: `${AMINA_NAME} checked ${step.tool} → ${summarizeStep(step.result)}`.slice(0, 900)
    });
  }
  const emailText = buildCareEscalationEmail({ ticket, steps, reason, draft });
  let forwarded = false;
  try {
    forwarded = (await (deps.sendEscalationEmail || sendCareEscalationEmail)({
      to: careEscalationEmail(),
      subject: careEscalationSubject(ticket),
      text: emailText
    })) !== false;
  } catch { forwarded = false; }
  let alerted = false;
  try {
    const ping = await (deps.notifySuperadmin || escalateCareToSuperadmin)({
      phone: ticket.fromEmail,
      text: `${cleanSubject(ticket.subject)}\n\n${emailText}`.slice(0, 1500),
      category: ticket.category,
      priority: CARE_PRIORITY.HIGH
    });
    alerted = Boolean(ping && ping.alerted);
  } catch { alerted = false; }
  await auditCareAction(supabase, {
    phone: 'AMINA',
    action: 'CARE_TICKET_AI_ESCALATED',
    details: { ticketId: ticket.ticketId, reason, tools: steps.map((step) => step.tool), forwarded, alerted }
  });
  await appendTicketMessage(supabase, {
    ticketId: ticket.ticketId,
    direction: 'out',
    channel: 'email',
    body: `Escalated to the human care team: ${reason}`.slice(0, 900)
  });
  return {
    handled: true,
    action: 'escalated',
    reason,
    confidence: outcome.confidence ?? 0,
    tools: steps.map((step) => step.tool),
    forwarded,
    alerted
  };
}

/* ------------------------------------------------------------------ */
/* The entry point the inbound webhook calls                           */
/* ------------------------------------------------------------------ */

/**
 * Triage ONE inbound email ticket. Never throws.
 * Returns { handled, action } where action is
 * 'disabled' | 'skipped' | 'resolved' | 'escalated' | 'error'.
 */
export async function processCareEmail(supabase, ticket = {}, deps = {}) {
  const aiCall = deps.aiCall || chatCompletion;
  if (!supabase || !ticket?.ticketId) return { handled: false, action: 'skipped', reason: 'no-ticket' };
  if (!isCareAiEnabled()) return { handled: false, action: 'disabled', reason: 'CARE_AI_ENABLED is off' };
  if (ticket.humanOwned) return { handled: false, action: 'skipped', reason: 'human owns this ticket' };
  const base = {
    ticketId: ticket.ticketId,
    fromEmail: String(ticket.fromEmail || '').toLowerCase(),
    subject: String(ticket.subject || '(no subject)').slice(0, 300),
    text: String(ticket.text || '').slice(0, 4000),
    category: ticket.category || 'other',
    priority: ticket.priority || 'medium'
  };
  try {
    const preGate = carePreGate(base.text, base.priority);
    if (preGate) {
      return await escalateCareTicket(supabase, base, { steps: [], reason: `pre-gate: ${preGate}`, confidence: 0 }, deps);
    }
    const investigation = await runCareInvestigation({ supabase, ticket: base, deps: { ...deps, aiCall } });
    const floor = careConfidenceFloor();
    if (investigation.action === 'reply' && investigation.draft && investigation.confidence >= floor) {
      let sent = false;
      try {
        sent = (await (deps.sendEmail || sendCareReplyEmail)({
          to: base.fromEmail,
          subject: careReplySubject(base),
          text: investigation.draft
        })) !== false;
      } catch { sent = false; }
      if (!sent) {
        return await escalateCareTicket(supabase, base, { ...investigation, reason: 'reply email could not be sent' }, deps);
      }
      await appendTicketMessage(supabase, {
        ticketId: base.ticketId,
        direction: 'out',
        channel: 'email',
        body: investigation.draft
      });
      await updateTicketSafe(supabase, base.ticketId, {
        status: CARE_STATUS.RESOLVED,
        ai_draft: investigation.draft,
        internal_note: `${AMINA_NAME} resolved this ticket (confidence ${investigation.confidence.toFixed(2)}) after ${investigation.steps.length} investigation step${investigation.steps.length === 1 ? '' : 's'}.`.slice(0, 900),
        updated_at: new Date().toISOString()
      });
      await auditCareAction(supabase, {
        phone: 'AMINA',
        action: 'CARE_TICKET_AI_RESOLVED',
        details: {
          ticketId: base.ticketId,
          confidence: investigation.confidence,
          tools: investigation.steps.map((step) => step.tool)
        }
      });
      return {
        handled: true,
        action: 'resolved',
        confidence: investigation.confidence,
        tools: investigation.steps.map((step) => step.tool),
        reply: investigation.draft
      };
    }
    return await escalateCareTicket(
      supabase,
      base,
      {
        ...investigation,
        // A reply below the floor keeps an EXPLICIT reason (the floor + the
        // model's own doubt), so the human always sees why Amina stopped.
        reason: investigation.action === 'reply'
          ? `confidence ${investigation.confidence} below the ${floor} floor${investigation.reason ? ` (${investigation.reason})` : ''}`
          : (investigation.reason || `confidence below the ${floor} floor`)
      },
      deps
    );
  } catch (err) {
    logWriteFailure(supabase, 'careAi.processCareEmail', err, { ticketId: base.ticketId });
    try {
      await auditCareAction(supabase, {
        phone: 'AMINA',
        action: 'CARE_TICKET_AI_SKIPPED',
        details: { ticketId: base.ticketId, error: String(err.message || '').slice(0, 200) }
      });
    } catch (auditErr) {
      // The skip audit is best-effort, but its own failure still reaches the log.
      logWriteFailure(supabase, 'careAi.auditSkipped', auditErr, { ticketId: base.ticketId });
    }
    return { handled: false, action: 'error', reason: err.message };
  }
}

export default {
  AMINA_NAME,
  CARE_AI_MAX_INVESTIGATION_LOOPS,
  isCareAiEnabled,
  careConfidenceFloor,
  careEscalationEmail,
  carePreGate,
  careReplySubject,
  careEscalationSubject,
  buildCareInvestigationPrompt,
  buildCareContextText,
  buildCareEscalationEmail,
  executeCareTool,
  toolGetProfileContext,
  toolGetRecentErrors,
  toolGetRecentChat,
  toolGetPaymentStatus,
  runCareInvestigation,
  processCareEmail
};






