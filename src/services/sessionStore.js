/**
 * Saka Fleet — Durable Session Store
 * ----------------------------------
 * Cloud Run scales horizontally, so process memory alone cannot hold
 * onboarding/quiz state across instances or restarts. This store persists the
 * complete session snapshot (conversation session + onboarding + active quiz +
 * OTP state) to the `chat_sessions` table, with the in-memory Maps acting as a
 * hot cache in front of it.
 */

import { runSql, hasSqlAccess } from '../db/sqlRunner.js';

let tableReady = false;

export async function ensureChatSessionsTable(supabase) {
  if (!supabase) return { status: 'no_client' };

  const { error } = await supabase.from('chat_sessions').select('phone_number').limit(1);
  if (!error) {
    tableReady = true;
    return { status: 'exists' };
  }

  if (hasSqlAccess()) {
    try {
      const sql = `
        CREATE TABLE IF NOT EXISTS public.chat_sessions (
            phone_number text PRIMARY KEY,
            state jsonb NOT NULL DEFAULT '{}'::jsonb,
            updated_at timestamp with time zone DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON public.chat_sessions(updated_at DESC);
        ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
      `;
      const result = await runSql(sql, { label: 'ensureChatSessionsTable' });
      if (result.ok) {
        tableReady = true;
        return { status: 'created' };
      }
    } catch (err) {
      console.warn('[sessionStore] Could not create chat_sessions table:', err.message);
    }
  }

  return { status: 'missing' };
}

export async function loadSessionSnapshot(supabase, phone) {
  if (!supabase || !phone) return null;
  try {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('state, updated_at')
      .eq('phone_number', phone)
      .maybeSingle();
    if (error || !data) return null;

    const state = data.state || {};
    const ageMs = Date.now() - new Date(data.updated_at || 0).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) return null;
    return state;
  } catch {
    return null;
  }
}

export async function persistSessionSnapshot(supabase, phone, snapshot = {}) {
  if (!supabase || !phone) return false;
  try {
    const payload = {
      phone_number: phone,
      state: snapshot,
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase
      .from('chat_sessions')
      .upsert([payload], { onConflict: 'phone_number' });
    return !error;
  } catch {
    return false;
  }
}

export async function pruneSessionSnapshots(supabase, days = 7) {
  if (!supabase) return 0;
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('chat_sessions').delete().lt('updated_at', cutoff);
    return error ? 0 : 1;
  } catch {
    return 0;
  }
}

export default {
  ensureChatSessionsTable,
  loadSessionSnapshot,
  persistSessionSnapshot,
  pruneSessionSnapshots
};
