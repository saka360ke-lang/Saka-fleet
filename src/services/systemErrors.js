/**
 * Saka Fleet — shared system-error logging (v1.61.12)
 * ---------------------------------------------------
 * `error_logs` is the single incident ledger. It used to live only in the
 * Sentinel worker, so services that must not import the worker (quizEngine,
 * onboarding) silently swallowed refused writes — live 2026-11-05: a machinery
 * registration failed twice, the user was told "that's on our side", and
 * `error_logs` stayed empty (rule 50).
 *
 * Every module may import THIS file; `sentinel.js` re-exports the same function
 * so existing call sites keep working. Never throws.
 */
import { createClient } from '@supabase/supabase-js';

function resolveSupabase(providedSupabase) {
  if (providedSupabase) return providedSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials missing in environment');
  return createClient(url, key);
}

/**
 * Log one incident to `error_logs`. Identical (route, message) pairs roll up for
 * `ERROR_ROLLUP_HOURS` (24) so a storm can never drown Sentinel's diagnosis.
 * `context` is folded into the message (the table has no JSON column) and capped.
 */
export async function logSystemError(providedSupabase, error, route = 'unknown', context = null) {
  try {
    const base = error?.message || (typeof error === 'string' ? error : '');
    const contextText = context && typeof context === 'object'
      ? Object.entries(context)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
        .join(' ')
      : '';
    const message = String(contextText ? `${base} [${contextText}]` : base).slice(0, 900);
    // Ignore empty/serialized-empty errors and benign status codes — observability noise.
    if (!message || message === '{}' || message === 'undefined' || message === 'null') return null;
    if (error?.statusCode && Number(error.statusCode) < 400) return null;

    const supabase = resolveSupabase(providedSupabase);
    const rollupHours = Math.max(1, Number(process.env.ERROR_ROLLUP_HOURS || 24));
    const cutoff = new Date(Date.now() - rollupHours * 60 * 60 * 1000).toISOString();
    try {
      const existing = await supabase
        .from('error_logs')
        .select('id')
        .eq('route', route)
        .eq('error_message', message)
        .gte('created_at', cutoff)
        .limit(1);
      if ((existing.data || []).length) return existing.data[0].id;
    } catch { /* fall through to a fresh insert */ }
    const { data } = await supabase.from('error_logs').insert([{
      error_message: message,
      stack_trace: error?.stack || null,
      route,
      status: 'unresolved',
      created_at: new Date().toISOString()
    }]).select('id').maybeSingle();
    return data ? data.id : null;
  } catch (err) {
    console.error('[systemErrors] Failed to log error to error_logs table:', err.message);
    return null;
  }
}

/**
 * Fire-and-forget wrapper for catches inside data paths: the failure reaches
 * `error_logs` without ever blocking the caller. Never throws.
 */
export function logWriteFailure(providedSupabase, route, error, context = null) {
  try {
    logSystemError(providedSupabase, error, route, context).catch(function () {});
  } catch { /* logging must never block the caller */ }
}

export default { logSystemError, logWriteFailure };
