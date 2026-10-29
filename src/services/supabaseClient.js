/**
 * Saka Fleet — Resilient Supabase client factory.
 *
 * A single cached client per process (the SDK pools HTTP connections) with a
 * hard timeout on every request so one slow query can never stall the message
 * queue or exhaust concurrency slots.
 */

import { createClient } from '@supabase/supabase-js';

const TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS || 15000);
let cachedClient = null;

function timeoutFetch(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(input, { ...init, signal: init.signal || controller.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * Resolve the service-role key from either env name.
 *
 * `SUPABASE_SERVICE_KEY` is the historical name used throughout this codebase;
 * `SUPABASE_SERVICE_ROLE_KEY` is the name Supabase's dashboard uses. Accepting
 * both avoids the silent failure mode where a correctly supplied key is ignored
 * and every caller degrades to no-op / in-memory mode.
 */
export function resolveServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

export function createResilientClient(url = process.env.SUPABASE_URL, key = resolveServiceKey()) {
  if (!url || !key) return null;
  if (cachedClient) return cachedClient;

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: timeoutFetch }
  });
  return cachedClient;
}

export function getResilientClient() {
  return cachedClient || createResilientClient();
}

export default { createResilientClient, getResilientClient, resolveServiceKey };
