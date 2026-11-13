/**
 * Saka Fleet — Amina's learning loop (v1.80.0, Phase 19)
 * -----------------------------------------------------
 * When a human answers an escalated care email, that answer is the most
 * valuable training data the business produces. This module:
 *   1. recognises the human's reply (a `[SFC-<ticketid>]` subject tag) and
 *      routes it into the EXISTING ticket as an internal message — it never
 *      opens a duplicate ticket;
 *   2. extracts ONE reusable, de-identified lesson with `care_learning`;
 *   3. stores it in `care_learnings`, where the investigation prompt reads the
 *      newest ten before triaging any new email.
 *
 * Boundaries: prompt-level hints only. A lesson can never change code, schema,
 * prices, permissions or billing behaviour (rules 16/18/28/46). Never throws.
 */
import { chatCompletion } from './aiClient.js';
import { getCareTicket, appendTicketMessage, auditCareAction, updateCareTicket } from './careConsole.js';
import { logWriteFailure } from './systemErrors.js';

export const CARE_LEARNINGS_TABLE = 'care_learnings';
export const CARE_LEARNING_MAX_ROWS = 10;
export const CARE_LEARNING_MIN_REPLY_CHARS = 20;
export const CARE_INTERNAL_DOMAIN = 'sakafleet.com';

/**
 * Idempotent DDL (rule 50). `support_tickets.ai_draft` keeps Amina's best draft
 * visible to the human even when she escalated; `care_learnings` is the lesson
 * ledger. Run: npm run migrate:care-ai
 */
export const CARE_AI_SQL = `
    ALTER TABLE public.support_tickets
        ADD COLUMN IF NOT EXISTS ai_draft text;
    CREATE TABLE IF NOT EXISTS public.care_learnings (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        ticket_id uuid,
        trigger_context text,
        lesson text,
        created_at timestamp with time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_care_learnings_created
        ON public.care_learnings(created_at DESC);
`;

/**
 * The lesson-extraction prompt. Deliberately strict: one general rule, no
 * personal data, no money outcomes.
 */
export const CARE_LEARNING_SYSTEM_PROMPT = `You are Amina's learning step for Saka Fleet customer care.
You receive the customer's original email and the reply a human support agent wrote.
Extract ONE reusable lesson that would let Amina resolve this class of issue next time WITHOUT a human.
Reply ONLY with JSON:
{ "lesson": "<one actionable sentence, max 400 characters>", "trigger_context": "<short issue pattern, max 200 characters>", "confidence": 0.0-1.0 }

Rules:
- The lesson is a general rule for next time, never customer-specific.
- Never include names, phone numbers, emails, card numbers, passwords, OTPs or ticket ids.
- Never record prices, refund promises or billing outcomes as rules — billing stays human-owned.
- If the human reply contains no reusable rule (e.g. it only promises a refund), return { "lesson": "" }.
- A lesson is PROMPT text only: it can never change code, schema, prices or permissions.`;

/** A sender on the exact sakafleet.com domain (not a subdomain) is internal. */
export function isCareInternalSender(email) {
  const parts = String(email || '').trim().toLowerCase().split('@');
  return parts.length === 2 && Boolean(parts[0]) && parts[1] === CARE_INTERNAL_DOMAIN;
}

/** The routing tag a human reply carries in its subject: `[SFC-ab12cd34]`. */
export function careTicketTag(ticketId) {
  const clean = String(ticketId || '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return clean ? `[SFC-${clean}]` : null;
}

export function extractCareTicketTag(subject) {
  const match = String(subject || '').match(/\[SFC-([a-z0-9]{4,40})\]/i);
  return match ? match[1].toLowerCase() : null;
}

/** Shared JSON reader for every Amina purpose (fences, prose, partial JSON). */
export function parseCareAiJson(raw) {
  if (raw && typeof raw === 'object') {
    // v1.97.7 — chatCompletion returns { ok, text, model, error, stopReason }.
    // Unwrap the model text before parsing; a pre-parsed object (tests, tools)
    // still returns as-is. Live 2026-11-13: both Amina purposes fed the whole
    // wrapper here, so parsed.lesson/parsed.action were always undefined and
    // every real reply silently yielded "no reusable lesson".
    if (typeof raw.text === 'string') return parseCareAiJson(raw.text);
    return raw;
  }
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let direct = null;
  try { direct = JSON.parse(fenced); } catch (err) { direct = null; }
  if (direct) return direct;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(fenced.slice(start, end + 1)); } catch (err) { return null; }
  }
  return null;
}

/** One clean lesson line: no PII, no control noise, bounded. */
export function sanitizeCareLesson(value, max = 500) {
  return String(value || '')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\+\d{7,15}\b/g, '[phone]')
    .replace(/\b\d{9,15}\b/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Newest lessons first; a missing table/column degrades to an empty list (rule 50). */
export async function getRecentCareLearnings(supabase, limit = CARE_LEARNING_MAX_ROWS) {
  if (!supabase) return [];
  const max = Math.min(Math.max(Number(limit) || CARE_LEARNING_MAX_ROWS, 1), 50);
  try {
    const { data, error } = await supabase
      .from(CARE_LEARNINGS_TABLE)
      .select('id, ticket_id, trigger_context, lesson, created_at')
      .order('created_at', { ascending: false })
      .limit(max);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

/** The prompt block Amina reads before triaging. Data, never instructions. */
export function formatCareLearnings(rows = []) {
  const lines = (rows || [])
    .map((row) => String(row.lesson || '').trim())
    .filter(Boolean)
    .slice(0, CARE_LEARNING_MAX_ROWS);
  if (!lines.length) return '- none yet (you are still learning this inbox)';
  return lines.map((lesson, i) => `${i + 1}. ${lesson}`).join('\n');
}

/**
 * Compare the customer's original email with a human reply and store ONE
 * reusable lesson. Never throws; a refused insert is logged, never silent.
 */
export async function extractCareLesson(supabase, { ticket = {}, humanReply = '' } = {}, deps = {}) {
  const aiCall = deps.aiCall || chatCompletion;
  const replyText = String(humanReply || '').trim();
  if (!supabase) return { ok: false, reason: 'no-client' };
  if (replyText.length < CARE_LEARNING_MIN_REPLY_CHARS) return { ok: false, reason: 'reply-too-short' };
  const ticketId = ticket?.id || null;
  try {
    const raw = await aiCall({
      purpose: 'care_learning',
      system: CARE_LEARNING_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          customer_email: ticket.sender_email || ticket.whatsapp_number || null,
          subject: String(ticket.subject || '').slice(0, 200),
          customer_message: String(ticket.message_body || '').slice(0, 1500),
          human_reply: replyText.slice(0, 2500)
        })
      }],
      jsonMode: true,
      maxTokens: 500,
      temperature: 0.1
    });
    const parsed = parseCareAiJson(raw);
    if (!parsed) return { ok: false, reason: 'unparseable' };
    const lesson = sanitizeCareLesson(parsed.lesson, 500);
    if (!lesson) return { ok: false, reason: 'no-reusable-lesson' };
    const triggerContext = sanitizeCareLesson(
      parsed.trigger_context || ticket.subject || ticket.message_body || 'support email',
      200
    );
    const { data, error } = await supabase
      .from(CARE_LEARNINGS_TABLE)
      .insert([{ ticket_id: ticketId, trigger_context: triggerContext, lesson, created_at: new Date().toISOString() }])
      .select('id')
      .maybeSingle();
    if (error) {
      logWriteFailure(supabase, 'careLearning.insert', error);
      return { ok: false, reason: error.message };
    }
    await auditCareAction(supabase, {
      phone: 'AMINA',
      action: 'CARE_TICKET_LEARNED',
      details: { ticketId, lesson: lesson.slice(0, 300) }
    });
    return { ok: true, id: data ? data.id : null, lesson, triggerContext };
  } catch (err) {
    logWriteFailure(supabase, 'careLearning.extractCareLesson', err);
    return { ok: false, reason: err.message };
  }
}

/**
 * A human reply to an escalated ticket → internal thread message + a lesson.
 * Returns null when the mail carries no `[SFC-…]` tag (normal customer mail).
 * Never opens a ticket, never triggers Amina, never throws.
 */
export async function routeCareInternalReply(supabase, { subject = '', text = '', fromEmail = '', bodyAvailable = true } = {}, deps = {}) {
  const tag = extractCareTicketTag(subject);
  if (!tag) return null;
  if (!supabase) return { ok: false, reason: 'no-client', tag };
  try {
    const ticket = await getCareTicket(supabase, tag);
    if (!ticket) return { ok: false, reason: 'ticket-not-found', tag };
    const sender = String(fromEmail || '').toLowerCase() || 'human-agent';
    const bodyArrived = bodyAvailable !== false;
    await appendTicketMessage(supabase, {
      ticketId: ticket.id,
      direction: 'internal',
      channel: 'email',
      body: `👤 Human reply (${sender}): ${String(text || '').slice(0, 3500)}`
    });
    // v1.97.4 — never report a status write that was refused; updateCareTicket
    // logs the reason (rule 50). The lesson + audit still run.
    const updated = await updateCareTicket(supabase, ticket.id, {
      status: 'IN_PROGRESS',
      assigned_to: sender,
      updated_at: new Date().toISOString()
    });
    const learned = await extractCareLesson(supabase, { ticket, humanReply: text }, deps);
    await auditCareAction(supabase, {
      phone: sender,
      action: 'CARE_TICKET_HUMAN_REPLY',
      details: { ticketId: ticket.id, bodyAvailable: bodyArrived, learned: Boolean(learned.ok), lesson: learned.ok ? learned.lesson.slice(0, 200) : null }
    });
    return {
      ok: Boolean(updated.ok),
      ticketId: ticket.id,
      bodyAvailable: bodyArrived,
      learned: Boolean(learned.ok),
      lesson: learned.ok ? learned.lesson : null,
      reason: updated.ok ? null : (updated.error || 'status-write-failed')
    };
  } catch (err) {
    logWriteFailure(supabase, 'careLearning.routeCareInternalReply', err);
    return { ok: false, reason: err.message, tag };
  }
}

export default {
  CARE_LEARNINGS_TABLE,
  CARE_AI_SQL,
  CARE_LEARNING_SYSTEM_PROMPT,
  isCareInternalSender,
  careTicketTag,
  extractCareTicketTag,
  parseCareAiJson,
  sanitizeCareLesson,
  getRecentCareLearnings,
  formatCareLearnings,
  extractCareLesson,
  routeCareInternalReply
};

