import fs from 'node:fs';
import { extractPdfText } from './pdfTextExtractor.js';
import { COUNTRY_KB_VERSION, KB_REVIEW_DAYS } from './countryBucket.js';

/**
 * Saka Fleet — Country KB ingest & review pipeline (v1.21.1)
 * ---------------------------------------------------------
 * Official-source harvesting for the Country Bucket knowledgebase.
 *
 * HARD RULES (permanent):
 *  - Only allow-listed official hosts in `src/data/kb_sources.json` are fetched.
 *  - Ingest writes DRAFT rows only (`is_active=false`, `verified_at=null`).
 *  - Nothing becomes live guidance until a superadmin approves it (ADMIN_KB
 *    audit), matching the "legal rules are never auto-changed" boundary.
 *  - Everything degrades to a clear error; ingest never throws.
 */

const SOURCES_URL = new URL('../data/kb_sources.json', import.meta.url);
const MAX_SOURCE_BYTES = Number(process.env.KB_MAX_SOURCE_BYTES || 2_000_000);
const FETCH_TIMEOUT_MS = Number(process.env.KB_FETCH_TIMEOUT_MS || 20000);

let registryCache = null;

export function loadKbSourceRegistry() {
  if (registryCache) return registryCache;
  try {
    registryCache = JSON.parse(fs.readFileSync(SOURCES_URL, 'utf8'));
  } catch {
    registryCache = { version: COUNTRY_KB_VERSION, countries: [] };
  }
  return registryCache;
}

export function listKbCountries() {
  return loadKbSourceRegistry().countries.map((entry) => entry.country_code);
}

export function getKbSources(countryCode = '') {
  const code = String(countryCode || '').toUpperCase();
  const entry = loadKbSourceRegistry().countries.find((row) => row.country_code === code);
  return entry || null;
}

/** Verified vs pending legislation for one country (pending is never fetched). */
export function getKbLegislation(countryCode = '') {
  const entry = getKbSources(countryCode);
  const legislation = entry?.legislation || [];
  return {
    verified: legislation.filter((row) => row.status === 'verified' && row.url),
    pending: legislation.filter((row) => row.status !== 'verified' || !row.url)
  };
}

/** Fetch order per country: verified legislation first, then authority pages. */
export function collectCountrySources(country = {}) {
  const legislation = (country.legislation || [])
    .filter((row) => row.status === 'verified' && row.url)
    .map((row) => ({ label: row.label, url: row.url, lawReference: row.law_name || null, kind: 'legislation' }));
  const authority = (country.sources || [])
    .filter((row) => row.url)
    .map((row) => ({ label: row.label, url: row.url, lawReference: null, kind: 'authority' }));
  return [...legislation, ...authority];
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function allowedHosts() {
  const hosts = new Set();
  for (const country of loadKbSourceRegistry().countries) {
    const urls = [
      ...(country.sources || []).map((source) => source.url),
      ...(country.legislation || []).filter((row) => row.status === 'verified').map((row) => row.url)
    ];
    for (const url of urls) {
      const host = hostOf(url);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

function baseDomain(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

/** HTTPS + official-host allow-list. Never fetch anything else. */
export function isAllowedSourceUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = baseDomain(parsed.hostname);
    return [...allowedHosts()].some((allowed) => {
      const base = baseDomain(allowed);
      return host === base || host.endsWith(`.${base}`);
    });
  } catch {
    return false;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function stripHtmlToText(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+|#\d+);/gi, (match, name) => ENTITIES[name.toLowerCase()] || ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch one official source and return plain text (HTML) or PDF text.
 * @returns {Promise<{ text: string|null, contentType: string|null, error: string|null }>}
 */
export async function fetchSourceDocument(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!isAllowedSourceUrl(url)) {
    return { text: null, contentType: null, error: 'Source is not on the official allow-list' };
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'SakaFleet-KB/1.0 (+https://sakafleet.com)' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    });
    if (!res.ok) return { text: null, contentType: null, error: `HTTP ${res.status}` };
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_SOURCE_BYTES) {
      return { text: null, contentType, error: 'Source exceeds the size limit' };
    }
    if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      const pdf = extractPdfText(buffer);
      return { text: pdf.text, contentType: 'application/pdf', error: pdf.error };
    }
    const text = stripHtmlToText(buffer.toString('utf8'));
    if (!text || text.length < 40) {
      return { text: null, contentType, error: 'No readable text on the page' };
    }
    return { text: text.slice(0, 200000), contentType, error: null };
  } catch (err) {
    return { text: null, contentType: null, error: `Fetch failed: ${err.message}` };
  }
}

export const RULE_PATTERNS = Object.freeze([
  { key: 'vehicle_insurance', category: 'vehicle_compliance', title: 'Motor insurance', re: /\b(insurance|third[- ]party|cover note)\b/i, renewal: 'annual', example: 'Insurance ABC-123 expires 2027-05-15' },
  { key: 'vehicle_inspection', category: 'vehicle_compliance', title: 'Inspection / roadworthiness', re: /\b(inspection|roadworth|fitness certificate|mot\b)/i, renewal: 'annual', example: 'Inspection expires 2027-03-15' },
  { key: 'road_service_licence', category: 'vehicle_compliance', title: 'Road service licence / permit', re: /\b(road service licen[cs]e|transport licen[cs]e|operating permit|psl\b)/i, renewal: 'annual', example: 'Road service licence RSL-5544 expires 2027-06-30' },
  { key: 'road_tax', category: 'vehicle_compliance', title: 'Road tax / licence disc', re: /\b(road tax|vehicle tax|licence disc|rego\b)/i, renewal: 'annual', example: 'Road tax expires 2027-01-31' },
  { key: 'speed_limiter', category: 'vehicle_compliance', title: 'Speed limiter certificate', re: /\b(speed limiter|speed governor)\b/i, renewal: 'annual', assetKinds: ['bus', 'truck'], example: 'Speed limiter SL-7788 expires 2027-04-30' },
  { key: 'driver_licence', category: 'driver_compliance', title: 'Driving licence', re: /\b(driving licen[cs]e|driver'?s? licen[cs]e|driving permit)\b/i, example: 'Licence DL-123456 expires 2028-01-31' },
  { key: 'psv_badge', category: 'driver_compliance', title: 'PSV / professional driving permit', re: /\b(psv|pdp|hackney|badge)\b/i, renewal: 'annual', assetKinds: ['bus', 'truck'], example: 'PSV badge PSV-8899 expires 2027-02-28' }
]);

const SUMMARY_NOISE_RE = /(cookie|cookies|javascript|browser|feedback|privacy|terms and conditions|all rights reserved|sign in|skip to|menu|search|©)/i;
const SUMMARY_OBLIGATION_RE = /\b(must|mandatory|required|requirement|shall|need|renew|valid|expire|penalty)\b/i;

function summarySentence(text, pattern) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25 && sentence.length <= 320);
  const relevant = sentences
    .filter((sentence) => pattern.test(sentence) && !SUMMARY_NOISE_RE.test(sentence))
    .map((sentence) => ({
      sentence,
      score: (SUMMARY_OBLIGATION_RE.test(sentence) ? 2 : 0)
        + (/\b(must|required|shall|mandatory)\b/i.test(sentence) ? 1 : 0)
    }))
    .sort((a, b) => b.score - a.score);
  return relevant.length && relevant[0].score > 0 ? relevant[0].sentence : null;
}

/**
 * Deterministically turn one official page into DRAFT rules (never active).
 * @returns {Array<object>} draft rows ready for `country_kb`
 */
export function buildDraftRules({ countryCode, authority, sourceUrl, text, lawReference = null } = {}) {
  const drafts = [];
  if (!countryCode || !text) return drafts;
  for (const pattern of RULE_PATTERNS) {
    const summary = summarySentence(text, pattern.re);
    if (!summary) continue;
    drafts.push({
      country_code: String(countryCode).toUpperCase(),
      region_code: null,
      asset_kind: pattern.assetKinds ? pattern.assetKinds[0] : null,
      category: pattern.category,
      rule_key: pattern.key,
      title: pattern.title,
      summary: summary.slice(0, 240),
      full_text: summary,
      example_text: pattern.example,
      required: true,
      renewal_hint: pattern.renewal || null,
      law_reference: lawReference || null,
      authority: authority || null,
      source_urls: [sourceUrl],
      verified_at: null,
      version: COUNTRY_KB_VERSION,
      curated_by: 'ingest-draft',
      is_active: false
    });
  }
  return drafts;
}

/**
 * Fetch allow-listed sources and persist DRAFT rows. Existing drafts are
 * refreshed; ACTIVE rows are never overwritten.
 */
export async function runKbIngest(providedSupabase, { countries = null, dryRun = true, fetchImpl = null } = {}) {
  const registry = loadKbSourceRegistry();
  const targets = (countries && countries.length
    ? registry.countries.filter((row) => countries.map((c) => c.toUpperCase()).includes(row.country_code))
    : registry.countries);
  const report = {
    dryRun,
    countries: 0,
    sources: 0,
    drafts: 0,
    skipped: 0,
    errors: [],
    pendingLegislation: [],
    rows: []
  };

  for (const country of targets) {
    report.countries += 1;
    const pending = getKbLegislation(country.country_code).pending;
    for (const item of pending) {
      report.pendingLegislation.push({ country_code: country.country_code, law_name: item.law_name || item.label });
    }
    const collected = [];
    // Verified legislation is fetched first so its rules win the per-key dedupe
    // and every draft inherits the exact law reference.
    for (const source of collectCountrySources(country)) {
      report.sources += 1;
      const fetched = fetchImpl
        ? await fetchImpl(source.url)
        : await fetchSourceDocument(source.url);
      if (!fetched?.text) {
        report.errors.push(`${country.country_code} ${source.label}: ${fetched?.error || 'no text'}`);
        continue;
      }
      const drafts = buildDraftRules({
        countryCode: country.country_code,
        authority: country.authority,
        sourceUrl: source.url,
        text: fetched.text,
        lawReference: source.lawReference
      });
      if (!drafts.length) { report.skipped += 1; continue; }
      collected.push(...drafts);
    }
    // One draft per rule key per country (first official source wins).
    const unique = new Map();
    for (const draft of collected) if (!unique.has(draft.rule_key)) unique.set(draft.rule_key, draft);
    for (const draft of unique.values()) {
      report.rows.push(draft);
      report.drafts += 1;
      if (dryRun || !providedSupabase) continue;
      try {
        const existing = await providedSupabase
          .from('country_kb')
          .select('id,is_active')
          .eq('country_code', draft.country_code)
          .eq('rule_key', draft.rule_key)
          .limit(1);
        const row = Array.isArray(existing.data) ? existing.data[0] : null;
        if (row?.is_active) continue; // never overwrite approved guidance
        if (row?.id) {
          await providedSupabase.from('country_kb').update(draft).eq('id', row.id);
        } else {
          await providedSupabase.from('country_kb').insert([draft]);
        }
      } catch (err) {
        report.errors.push(`${draft.country_code} ${draft.rule_key}: ${err.message}`);
      }
    }
  }
  return report;
}


/** Draft queue (is_active=false). Never throws. */
export async function listKbDrafts(providedSupabase, { countryCode = null, limit = 20 } = {}) {
  if (!providedSupabase) return { ok: false, rows: [], error: 'No database client' };
  try {
    let query = providedSupabase
      .from('country_kb')
      .select('id,country_code,rule_key,title,summary,source_urls,curated_by,created_at')
      .eq('is_active', false)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 20, 1), 50));
    if (countryCode) query = query.eq('country_code', String(countryCode).toUpperCase());
    const { data, error } = await query;
    if (error) return { ok: false, rows: [], error: error.message };
    return { ok: true, rows: data || [], error: null };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}

/** Approve one draft: it becomes live with a verified date + superadmin audit. */
export async function approveKbRule(providedSupabase, id, { adminPhone = 'SUPERADMIN', audit = null } = {}) {
  if (!providedSupabase) return { ok: false, error: 'No database client' };
  if (!id) return { ok: false, error: 'Missing rule id' };
  try {
    const existing = await providedSupabase
      .from('country_kb')
      .select('id,country_code,rule_key,title,is_active')
      .eq('id', id)
      .maybeSingle();
    if (existing.error) return { ok: false, error: existing.error.message };
    if (!existing.data) return { ok: false, error: 'Rule not found' };
    if (existing.data.is_active) return { ok: false, error: 'Rule is already active' };

    const today = new Date().toISOString().slice(0, 10);
    const update = await providedSupabase
      .from('country_kb')
      .update({
        is_active: true,
        verified_at: today,
        curated_by: 'superadmin',
        version: COUNTRY_KB_VERSION,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);
    if (update.error) return { ok: false, error: update.error.message };

    if (typeof audit === 'function') {
      await audit(adminPhone, 'ADMIN_KB_APPROVE', {
        rule_id: id,
        country_code: existing.data.country_code,
        rule_key: existing.data.rule_key,
        verified_at: today
      });
    }
    return { ok: true, rule: { ...existing.data, verified_at: today }, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Reject (delete) one draft. Active rules can never be rejected here. */
export async function rejectKbRule(providedSupabase, id, { adminPhone = 'SUPERADMIN', audit = null } = {}) {
  if (!providedSupabase) return { ok: false, error: 'No database client' };
  if (!id) return { ok: false, error: 'Missing rule id' };
  try {
    const existing = await providedSupabase
      .from('country_kb')
      .select('id,country_code,rule_key,is_active')
      .eq('id', id)
      .maybeSingle();
    if (existing.error) return { ok: false, error: existing.error.message };
    if (!existing.data) return { ok: false, error: 'Rule not found' };
    if (existing.data.is_active) return { ok: false, error: 'Active rules must be edited, not deleted' };
    const removal = await providedSupabase.from('country_kb').delete().eq('id', id);
    if (removal.error) return { ok: false, error: removal.error.message };
    if (typeof audit === 'function') {
      await audit(adminPhone, 'ADMIN_KB_REJECT', {
        rule_id: id,
        country_code: existing.data.country_code,
        rule_key: existing.data.rule_key
      });
    }
    return { ok: true, rule: existing.data, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Active rules whose verified date is missing or older than the review window. */
export async function getKbStaleRules(providedSupabase, { days = KB_REVIEW_DAYS, limit = 50 } = {}) {
  if (!providedSupabase) return { ok: false, rows: [], error: 'No database client' };
  try {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { data, error } = await providedSupabase
      .from('country_kb')
      .select('id,country_code,rule_key,title,verified_at')
      .eq('is_active', true)
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 100));
    if (error) return { ok: false, rows: [], error: error.message };
    const stale = (data || []).filter((row) => !row.verified_at || String(row.verified_at) < cutoff);
    return { ok: true, rows: stale, error: null };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}

export function formatKbQueueReply(drafts = []) {
  if (!drafts.length) {
    return '📚 *Country KB queue is clear.*\n\nRun `npm run kb:ingest -- --apply` to fetch official sources into drafts, then review them here.';
  }
  const lines = drafts.slice(0, 8).map((row, index) =>
    `${index + 1}. *${row.country_code} · ${row.title}*\n   \`${row.id}\``);
  return `📚 *Country KB drafts (${drafts.length})*\n\n${lines.join('\n')}\n\nReply *admin kb approve <id>* to publish, or *admin kb reject <id>* to discard. Nothing is live until approved.`;
}

export function formatKbStaleReply(rows = []) {
  if (!rows.length) return `✅ *Country KB is fresh* — every active rule was verified within ${KB_REVIEW_DAYS} days.`;
  const lines = rows.slice(0, 10).map((row) => `• *${row.country_code}* · ${row.title} — verified ${row.verified_at || 'never'}`);
  return `⏰ *Country KB review due (${rows.length})*\n\n${lines.join('\n')}\n\nRe-check the official source, then ingest + approve. Legal rules are never auto-changed.`;
}

export default {
  loadKbSourceRegistry,
  listKbCountries,
  getKbSources,
  getKbLegislation,
  collectCountrySources,
  allowedHosts,
  isAllowedSourceUrl,
  stripHtmlToText,
  fetchSourceDocument,
  buildDraftRules,
  runKbIngest,
  listKbDrafts,
  approveKbRule,
  rejectKbRule,
  getKbStaleRules,
  formatKbQueueReply,
  formatKbStaleReply,
  RULE_PATTERNS
};

