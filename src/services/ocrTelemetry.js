import crypto from 'crypto';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';

/**
 * Saka Fleet — OCR request telemetry (v1.32.1)
 * --------------------------------------------
 * Vision is a paid provider call and the 2026-11-01 audit showed that OCR
 * failures left no durable trace (two photo turns died after the ack). Every
 * media turn now writes exactly one row here, BEFORE any crash-prone branch,
 * so a dead turn is still diagnosable and countable.
 *
 * Rules:
 *  - Never throws; telemetry must never break a chat turn.
 *  - No document text is stored — only metadata, hashes and outcomes.
 *  - Global audience: country_code comes from the WhatsApp number (E.164).
 */

export const OCR_REQUESTS_TABLE = 'ocr_requests';

export const OCR_REQUESTS_SQL = `
    CREATE TABLE IF NOT EXISTS public.ocr_requests (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        media_id text,
        phone text,
        country_code text,
        mime_type text,
        provider text,
        document_kind text,
        status text,
        confidence numeric,
        attempts integer,
        latency_ms integer,
        error text,
        created_at timestamp with time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ocr_requests_created ON public.ocr_requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ocr_requests_status ON public.ocr_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ocr_requests_media ON public.ocr_requests(media_id);
`;

/** Stable content hash for duplicate-upload detection (normalised whitespace). */
export function buildOcrTextSha(text = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Ensure the table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureOcrRequestsTable(providedSupabase) {
  if (!providedSupabase) return { ok: false, status: 'no-client' };
  const { error } = await providedSupabase.from(OCR_REQUESTS_TABLE).select('id').limit(1);
  if (!error) return { ok: true, status: 'exists' };
  if (!/could not find the table|does not exist|schema cache/i.test(error.message || '')) {
    return { ok: false, status: 'error', error: error.message };
  }
  if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
  try {
    const result = await runSql(OCR_REQUESTS_SQL, { label: 'ensureOcrRequestsTable' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

/**
 * One row per OCR attempt. `status` is one of:
 * read | low_confidence | failed | paused | pdf_text | pdf_scanned | unsupported
 */
export async function recordOcrRequest(providedSupabase, {
  mediaId = null,
  phone = null,
  countryCode = null,
  mimeType = null,
  provider = null,
  documentKind = null,
  status = 'failed',
  confidence = null,
  attempts = null,
  latencyMs = null,
  error = null
} = {}) {
  if (!providedSupabase) return { ok: false, error: 'no-client' };
  try {
    const { error: insertError } = await providedSupabase.from(OCR_REQUESTS_TABLE).insert([{
      media_id: mediaId ? String(mediaId) : null,
      phone: phone ? String(phone) : null,
      country_code: countryCode ? String(countryCode).toUpperCase() : null,
      mime_type: mimeType || null,
      provider: provider || null,
      document_kind: documentKind || null,
      status,
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
      attempts: Number.isFinite(Number(attempts)) ? Number(attempts) : null,
      latency_ms: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
      error: error ? String(error).slice(0, 500) : null
    }]);
    if (insertError) return { ok: false, error: insertError.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Deterministic digest for `admin ocr-stats` (zero tokens). Window 1–168 h.
 * Reads at most 2000 rows; never throws.
 */
export async function getOcrUsageSummary(providedSupabase, hours = 24) {
  const windowHours = Math.min(168, Math.max(1, Number(hours) || 24));
  const summary = {
    ok: false,
    hours: windowHours,
    total: 0,
    byStatus: {},
    byKind: {},
    byCountry: {},
    byProvider: {},
    avgConfidence: null,
    avgLatencyMs: null,
    error: null
  };
  if (!providedSupabase) { summary.error = 'no-client'; return summary; }
  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await providedSupabase
      .from(OCR_REQUESTS_TABLE)
      .select('status, document_kind, country_code, provider, confidence, latency_ms')
      .gte('created_at', cutoff)
      .limit(2000);
    if (error) { summary.error = error.message; return summary; }
    const rows = data || [];
    let confidenceSum = 0;
    let confidenceCount = 0;
    let latencySum = 0;
    let latencyCount = 0;
    for (const row of rows) {
      summary.total += 1;
      const status = row.status || 'unknown';
      summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;
      const kind = row.document_kind || 'unknown';
      summary.byKind[kind] = (summary.byKind[kind] || 0) + 1;
      const country = row.country_code || 'GLOBAL';
      summary.byCountry[country] = (summary.byCountry[country] || 0) + 1;
      const provider = row.provider || 'unknown';
      summary.byProvider[provider] = (summary.byProvider[provider] || 0) + 1;
      const conf = Number(row.confidence);
      if (Number.isFinite(conf) && conf > 0) { confidenceSum += conf; confidenceCount += 1; }
      const latency = Number(row.latency_ms);
      if (Number.isFinite(latency) && latency >= 0) { latencySum += latency; latencyCount += 1; }
    }
    summary.avgConfidence = confidenceCount ? confidenceSum / confidenceCount : null;
    summary.avgLatencyMs = latencyCount ? Math.round(latencySum / latencyCount) : null;
    summary.ok = true;
    return summary;
  } catch (err) {
    summary.error = err.message;
    return summary;
  }
}

/**
 * v1.54.2 — pure per-country roll-up over ocr_requests rows (testable,
 * zero tokens). Flags a country when its unusable-read rate or
 * low-confidence rate crosses the thresholds with enough samples.
 */
export function summarizeOcrCountryRows(rows = [], {
  minRows = 5,
  failRate = 0.25,
  lowConfidenceRate = 0.3
} = {}) {
  const stats = {
    countryCode: null,
    total: 0,
    byStatus: {},
    byKind: {},
    failed: 0,
    lowConfidence: 0,
    avgConfidence: null,
    watch: false,
    reason: null
  };
  const usable = Array.isArray(rows) ? rows : [];
  stats.total = usable.length;
  if (!usable.length) return stats;
  stats.countryCode = usable[0]?.country_code || null;
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const row of usable) {
    const status = String(row.status || 'unknown');
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    const kind = String(row.document_kind || 'unknown');
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    if (status === 'failed' || status === 'pdf_scanned' || status === 'unsupported') stats.failed += 1;
    if (status === 'low_confidence') stats.lowConfidence += 1;
    const conf = Number(row.confidence);
    if (Number.isFinite(conf) && conf > 0) { confidenceSum += conf; confidenceCount += 1; }
  }
  stats.avgConfidence = confidenceCount ? confidenceSum / confidenceCount : null;
  const minimum = Math.max(1, Number(minRows) || 5);
  if (stats.total >= minimum) {
    if (stats.total > 0 && stats.failed / stats.total >= (Number(failRate) || 0.25)) {
      stats.watch = true;
      stats.reason = 'unusable-read rate';
    } else if (stats.total > 0 && stats.lowConfidence / stats.total >= (Number(lowConfidenceRate) || 0.3)) {
      stats.watch = true;
      stats.reason = 'low-confidence rate';
    }
  }
  return stats;
}

/**
 * v1.54.2 — one country's OCR telemetry digest (the signal that decides
 * whether the next country parsing profile is worth writing). 1–168 h
 * window, 2000-row cap, never throws.
 */
export async function getOcrCountryProfileStats(providedSupabase, {
  countryCode = null,
  hours = 168,
  minRows = 5,
  failRate = 0.25,
  lowConfidenceRate = 0.3
} = {}) {
  const stats = { ok: false, hours: Math.min(168, Math.max(1, Number(hours) || 168)), error: null };
  if (!providedSupabase) { stats.error = 'no-client'; return stats; }
  if (!countryCode) { stats.error = 'missing-country'; return stats; }
  try {
    const cutoff = new Date(Date.now() - stats.hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await providedSupabase
      .from(OCR_REQUESTS_TABLE)
      .select('status, document_kind, country_code, confidence')
      .eq('country_code', String(countryCode).toUpperCase())
      .gte('created_at', cutoff)
      .limit(2000);
    if (error) { stats.error = error.message; return stats; }
    const summary = summarizeOcrCountryRows(data || [], { minRows, failRate, lowConfidenceRate });
    Object.assign(stats, summary, { ok: true });
    return stats;
  } catch (err) {
    stats.error = err.message;
    return stats;
  }
}

/**
 * v1.54.2 — OCR country watchlist: every country whose document reads cross
 * the thresholds inside the window, newest-activity countries first. This is
 * the data-driven signal for strengthening country parsing profiles — never
 * pushing one country's rules globally (rule 36).
 */
export async function getOcrCountryWatchlist(providedSupabase, {
  hours = 168,
  minRows = 5,
  failRate = 0.25,
  lowConfidenceRate = 0.3
} = {}) {
  if (!providedSupabase) return [];
  const windowHours = Math.min(168, Math.max(1, Number(hours) || 168));
  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await providedSupabase
      .from(OCR_REQUESTS_TABLE)
      .select('status, document_kind, country_code, confidence')
      .gte('created_at', cutoff)
      .limit(2000);
    if (error || !Array.isArray(data) || !data.length) return [];
    const buckets = new Map();
    for (const row of data) {
      const code = String(row.country_code || 'GLOBAL').toUpperCase();
      if (!buckets.has(code)) buckets.set(code, []);
      buckets.get(code).push(row);
    }
    return [...buckets.entries()]
      .map(([countryCode, rows]) => summarizeOcrCountryRows(rows, { minRows, failRate, lowConfidenceRate }))
      .filter((summary) => summary.watch)
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  } catch {
    return [];
  }
}

export default { recordOcrRequest, ensureOcrRequestsTable, buildOcrTextSha, getOcrUsageSummary, summarizeOcrCountryRows, getOcrCountryProfileStats, getOcrCountryWatchlist, OCR_REQUESTS_SQL };
