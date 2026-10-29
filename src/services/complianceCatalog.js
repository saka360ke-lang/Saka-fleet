/**
 * Saka Fleet — Compliance Catalog Service (v1.9.1)
 * ------------------------------------------------
 * Region-aware compliance requirements for driver onboarding:
 *   - `minimal`: the mandatory item a driver must hold (valid at assignment).
 *   - `additional`: optional, asset-aware items Saka keeps collecting so it can
 *     remind the driver before they expire (PSV badge, CPC, plant cards…).
 *
 * The catalog is a LIVING asset:
 *   1. Bundled defaults ship with every code release (`CATALOG_VERSION`).
 *   2. Superadmin/Sentinel overrides live in `compliance_catalog` (effective-dated).
 *   3. `reviewComplianceCatalog()` flags stale entries for human review — legal
 *      rules are NEVER auto-changed by AI.
 *
 * Resolution order: active DB override (effective today) -> bundled default.
 */

import { extractDatePhrase, zonedDateTimeToUtcIso, diffCalendarDays, SYSTEM_TIMEZONE } from './dateParser.js';

export const COMPLIANCE_CATALOG_VERSION = '2026.10.1';
export const CATALOG_REVIEW_DAYS = 180;
export const DEFAULT_CATALOG_COUNTRY = 'DEFAULT';

const DRIVER_LICENSE_ALIASES = ['driver license', 'driver licence', 'drivers license', 'drivers licence', 'driving licence', 'driving license', 'dl'];

function normalizeAssetType(assetType) {
  return String(assetType || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function item(type, label, { lifetimeAllowed = false, aliases = [], assetTypes = null } = {}) {
  return Object.freeze({
    type,
    label,
    lifetimeAllowed: Boolean(lifetimeAllowed),
    aliases,
    assetTypes
  });
}

/**
 * Bundled catalog. `lifetimeAllowed` reflects economies that issue the item
 * without an expiry (e.g. Belgian driving licences). Everywhere else the expiry
 * date is mandatory and must be in the future at assignment time.
 */
export const COUNTRY_COMPLIANCE_CATALOG = Object.freeze({
  DEFAULT: {
    minimal: item('driver_license', 'Driver licence', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: []
  },
  KE: {
    minimal: item('driver_license', 'Driver licence (NTSA)', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: [
      item('psv_badge', 'PSV badge', { aliases: ['psv badge', 'psv'], assetTypes: ['PSV', 'BUS', 'MATATU', 'MINIBUS'] })
    ]
  },
  TZ: {
    minimal: item('driver_license', 'Driving licence (TRA)', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: [item('psv_badge', 'PSV licence', { aliases: ['psv'], assetTypes: ['PSV', 'BUS', 'MINIBUS'] })]
  },
  UG: {
    minimal: item('driver_license', 'Driving permit (URA)', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: [item('psv_badge', 'PSV permit', { aliases: ['psv'], assetTypes: ['PSV', 'BUS', 'MINIBUS'] })]
  },
  RW: {
    minimal: item('driver_license', 'Driving licence (RRA)', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: []
  },
  NG: {
    minimal: item('driver_license', 'Driver licence (FRSC)', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: [item('hackney_permit', 'Hackney permit', { aliases: ['hackney'], assetTypes: ['PSV', 'BUS', 'TAXI'] })]
  },
  ZA: {
    minimal: item('driver_license', 'Driving licence', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: [
      item('pdp', 'Professional Driving Permit (PDP)', { aliases: ['pdp', 'professional driving permit'], assetTypes: ['PSV', 'BUS', 'TRUCK', 'HGV'] })
    ]
  },
  GB: {
    minimal: item('driver_license', 'Driver licence (DVLA)', { aliases: [...DRIVER_LICENSE_ALIASES, 'dvla'] }),
    additional: [
      item('driver_cpc', 'Driver CPC', { aliases: ['cpc', 'driver cpc'], assetTypes: ['HGV', 'LGV', 'TRUCK', 'BUS', 'PSV'] }),
      item('plant_card', 'CPCS plant operator card', { aliases: ['cpcs', 'plant card', 'operator card'], assetTypes: ['EXCAVATOR', 'HEAVY_EQUIPMENT', 'MACHINERY', 'PLANT'] })
    ]
  },
  US: {
    minimal: item('driver_license', "Driver's licence (state DMV)", { aliases: [...DRIVER_LICENSE_ALIASES, 'dmv'] }),
    additional: [
      item('cdl', 'Commercial Driver License (CDL)', { aliases: ['cdl', 'commercial license'], assetTypes: ['TRUCK', 'HGV', 'BUS', 'PSV'] }),
      item('operator_cert', 'Heavy equipment operator certification', { aliases: ['operator cert', 'excavator cert'], assetTypes: ['EXCAVATOR', 'HEAVY_EQUIPMENT', 'MACHINERY', 'PLANT'] })
    ]
  },
  CA: {
    minimal: item('driver_license', "Driver's licence", { aliases: DRIVER_LICENSE_ALIASES }),
    additional: [
      item('cdl', 'Commercial driver licence', { aliases: ['cdl'], assetTypes: ['TRUCK', 'HGV', 'BUS'] }),
      item('operator_cert', 'Heavy equipment operator certificate', { aliases: ['operator cert'], assetTypes: ['EXCAVATOR', 'HEAVY_EQUIPMENT', 'MACHINERY'] })
    ]
  },
  AE: {
    minimal: item('driver_license', 'Driver licence (RTA)', { aliases: [...DRIVER_LICENSE_ALIASES, 'rta'] }),
    additional: [
      item('heavy_vehicle_permit', 'Heavy vehicle permit', { aliases: ['heavy vehicle permit'], assetTypes: ['TRUCK', 'HGV', 'BUS'] })
    ]
  },
  IN: {
    minimal: item('driver_license', 'Driving licence (RTO)', { aliases: [...DRIVER_LICENSE_ALIASES, 'rto'] }),
    additional: [
      item('commercial_dl', 'Commercial driving licence', { aliases: ['commercial dl'], assetTypes: ['PSV', 'TRUCK', 'BUS'] })
    ]
  },
  AU: {
    minimal: item('driver_license', 'Driver licence', { aliases: DRIVER_LICENSE_ALIASES }),
    additional: [
      item('hrt_licence', 'Heavy rigid truck licence', { aliases: ['hrt', 'heavy rigid'], assetTypes: ['TRUCK', 'HGV'] }),
      item('white_card', 'Construction white card', { aliases: ['white card'], assetTypes: ['EXCAVATOR', 'HEAVY_EQUIPMENT', 'MACHINERY', 'PLANT'] })
    ]
  },
  BE: {
    // Belgian driving licences are issued for life — the economy where a
    // lifetime minimal compliance is valid.
    minimal: item('driver_license', 'Driving licence (Belgium)', { lifetimeAllowed: true, aliases: DRIVER_LICENSE_ALIASES }),
    additional: []
  },
  DE: { minimal: item('driver_license', 'Führerschein', { aliases: [...DRIVER_LICENSE_ALIASES, 'fuhrerschein'] }), additional: [] },
  FR: { minimal: item('driver_license', 'Permis de conduire', { aliases: [...DRIVER_LICENSE_ALIASES, 'permis'] }), additional: [] },
  ES: { minimal: item('driver_license', 'Permiso de conducir', { aliases: [...DRIVER_LICENSE_ALIASES, 'permiso'] }), additional: [] },
  IT: { minimal: item('driver_license', 'Patente di guida', { aliases: [...DRIVER_LICENSE_ALIASES, 'patente'] }), additional: [] },
  NL: { minimal: item('driver_license', 'Rijbewijs', { aliases: [...DRIVER_LICENSE_ALIASES, 'rijbewijs'] }), additional: [] },
  BR: { minimal: item('driver_license', 'CNH', { aliases: [...DRIVER_LICENSE_ALIASES, 'cnh'] }), additional: [] },
  PH: { minimal: item('driver_license', "Driver's licence (LTO)", { aliases: [...DRIVER_LICENSE_ALIASES, 'lto'] }), additional: [] }
});

/** Category used by the universal reminder engine for a compliance type. */
export function complianceCategory(type) {
  const clean = String(type || '').toLowerCase();
  if (['driver_license', 'driver_licence', 'cdl', 'commercial_dl', 'hrt_licence', 'driver_cpc'].includes(clean)) return 'driver_license';
  if (['psv_badge', 'pdp', 'hackney_permit', 'heavy_vehicle_permit', 'operator_cert', 'plant_card', 'white_card'].includes(clean)) return 'permit';
  return 'other';
}

/** Resolve the bundled catalog for a country + asset type (sync, no I/O). */
export function resolveBundledCatalog({ countryCode = 'GLOBAL', assetType = null } = {}) {
  const code = String(countryCode || 'GLOBAL').toUpperCase();
  const entry = COUNTRY_COMPLIANCE_CATALOG[code] || COUNTRY_COMPLIANCE_CATALOG[DEFAULT_CATALOG_COUNTRY];
  const normalizedAsset = normalizeAssetType(assetType);
  const additional = (entry.additional || []).filter((it) => {
    if (!it.assetTypes || it.assetTypes.length === 0) return true;
    return Boolean(normalizedAsset) && it.assetTypes.includes(normalizedAsset);
  });
  return {
    countryCode: code,
    minimal: entry.minimal,
    additional,
    catalogVersion: COMPLIANCE_CATALOG_VERSION,
    source: 'bundled'
  };
}

function normalizeCatalogItem(raw, fallback = null) {
  const source = raw && typeof raw === 'object' ? raw : fallback;
  if (!source || !source.type) return fallback;
  return {
    type: String(source.type),
    label: String(source.label || source.type),
    lifetimeAllowed: Boolean(source.lifetime_allowed ?? source.lifetimeAllowed),
    aliases: Array.isArray(source.aliases) ? source.aliases.map(String) : [],
    assetTypes: Array.isArray(source.asset_types ?? source.assetTypes) ? (source.asset_types ?? source.assetTypes).map(String) : null
  };
}

function resolveCatalogRow(row, { countryCode, assetType }) {
  const fallback = resolveBundledCatalog({ countryCode, assetType });
  const minimal = normalizeCatalogItem(row?.minimal, fallback.minimal) || fallback.minimal;
  const rawAdditional = Array.isArray(row?.additional) ? row.additional : fallback.additional;
  const normalizedAsset = normalizeAssetType(assetType);
  const additional = rawAdditional
    .map((it) => normalizeCatalogItem(it))
    .filter((it) => {
      if (!it) return false;
      if (!it.assetTypes || it.assetTypes.length === 0) return true;
      return Boolean(normalizedAsset) && it.assetTypes.includes(normalizedAsset);
    });
  return {
    countryCode: String(countryCode || 'GLOBAL').toUpperCase(),
    minimal,
    additional,
    catalogVersion: row?.catalog_version || COMPLIANCE_CATALOG_VERSION,
    source: 'override',
    effectiveFrom: row?.effective_from || null,
    nextReviewAt: row?.next_review_at || null
  };
}

function isCatalogRowEffective(row, now = new Date()) {
  if (!row || row.is_active === false) return false;
  if (!row.effective_from) return true;
  const today = new Date(now).toISOString().slice(0, 10);
  return String(row.effective_from).slice(0, 10) <= today;
}


const catalogCache = new Map();
const CATALOG_CACHE_TTL_MS = Number(process.env.COMPLIANCE_CATALOG_CACHE_MS || 60 * 60 * 1000);

export function clearComplianceCatalogCache() {
  catalogCache.clear();
}

/**
 * Resolve the live catalog: active DB override effective today, else bundled.
 */
export async function getComplianceCatalog({ supabase = null, countryCode = 'GLOBAL', assetType = null, now = new Date() } = {}) {
  const code = String(countryCode || 'GLOBAL').toUpperCase();
  const cacheKey = `${code}:${normalizeAssetType(assetType)}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let resolved = resolveBundledCatalog({ countryCode: code, assetType });
  if (supabase) {
    try {
      const { data } = await supabase
        .from('compliance_catalog')
        .select('*')
        .eq('country_code', code)
        .limit(1);
      const row = Array.isArray(data) ? data[0] : data;
      if (row && isCatalogRowEffective(row, now)) {
        resolved = resolveCatalogRow(row, { countryCode: code, assetType });
      }
    } catch {
      // Fall back to bundled defaults when the table is unavailable.
    }
  }

  catalogCache.set(cacheKey, { value: resolved, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS });
  return resolved;
}

/** Human-readable requirement line for prompts / confirmations. */
export function describeComplianceRequirement(catalog) {
  if (!catalog?.minimal) return 'Driver licence';
  const extras = (catalog.additional || []).map((it) => it.label);
  return extras.length > 0
    ? `${catalog.minimal.label} (mandatory) + optional: ${extras.join(', ')}`
    : `${catalog.minimal.label} (mandatory)`;
}


/**
 * Parse a natural compliance submission, e.g.
 *   "DL-1234567 expires 15 Dec 2028"
 *   "PSV 445566 valid for life"
 * Returns { ok, number, expiry, lifetime, daysLeft, expired } or null.
 */
export function parseComplianceItem(text, {
  countryCode = 'GLOBAL',
  locale = 'en-US',
  now = new Date(),
  timeZone = SYSTEM_TIMEZONE,
  catalogItem = null
} = {}) {
  const clean = String(text || '').trim();
  if (!clean || /^(skip|later|none|no|n\/a)$/i.test(clean)) return null;

  const lifetime = /\b(lifetime|for life|no expiry|never expires|non[- ]expiring|permanent)\b/i.test(clean);
  const extracted = lifetime ? null : extractDatePhrase(clean, { countryCode, locale, now });

  let number = null;
  if (extracted?.ok) {
    const withoutDates = clean
      .replace(new RegExp(extracted.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ')
      .replace(/\b(19|20)\d{2}\b/g, ' ');
    const match = withoutDates.match(/\b((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{2,23})\b/i);
    number = match ? match[1].toUpperCase() : null;
  } else if (lifetime) {
    const withoutLifetime = clean.replace(/\b(lifetime|for life|no expiry|never expires|non[- ]expiring|permanent)\b/gi, ' ');
    const match = withoutLifetime.match(/\b((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{2,23})\b/i);
    number = match ? match[1].toUpperCase() : null;
  }
  if (!number || /^(19|20)\d{2}$/.test(number)) return null;

  if (lifetime) {
    return {
      ok: true,
      number,
      expiry: null,
      dueAt: null,
      lifetime: true,
      daysLeft: null,
      expired: false,
      timeZone,
      catalogItem
    };
  }

  if (!extracted?.ok) return null;
  const daysLeft = diffCalendarDays(now, extracted.localDate);
  return {
    ok: true,
    number,
    expiry: extracted.localDate,
    dueAt: zonedDateTimeToUtcIso(extracted.localDate, timeZone),
    lifetime: false,
    daysLeft,
    expired: daysLeft !== null && daysLeft < 0,
    timeZone,
    catalogItem,
    phrase: extracted.phrase,
    confidence: extracted.confidence
  };
}


/**
 * Seed missing bundled catalog rows. Idempotent; called at startup.
 */
export async function ensureComplianceCatalog({ supabase, now = new Date() } = {}) {
  if (!supabase) return { ok: false, seeded: 0 };
  const { data: existing, error } = await supabase.from('compliance_catalog').select('country_code').limit(500);
  if (error) return { ok: false, seeded: 0, error: error.message };

  const have = new Set((existing || []).map((row) => String(row.country_code).toUpperCase()));
  const today = new Date(now).toISOString().slice(0, 10);
  const nextReview = new Date(new Date(now).getTime() + CATALOG_REVIEW_DAYS * 86400000).toISOString().slice(0, 10);
  let seeded = 0;

  for (const [code, entry] of Object.entries(COUNTRY_COMPLIANCE_CATALOG)) {
    if (have.has(code)) continue;
    const { error: insertErr } = await supabase.from('compliance_catalog').insert([{
      country_code: code,
      minimal: entry.minimal,
      additional: entry.additional,
      lifetime_allowed: entry.minimal.lifetimeAllowed,
      effective_from: today,
      reviewed_at: new Date(now).toISOString(),
      next_review_at: nextReview,
      source: 'bundled',
      catalog_version: COMPLIANCE_CATALOG_VERSION,
      is_active: true
    }]);
    if (!insertErr) seeded += 1;
  }

  clearComplianceCatalogCache();
  return { ok: true, seeded, catalogVersion: COMPLIANCE_CATALOG_VERSION };
}

/**
 * Sentinel weekly review: flag catalog entries whose review date has passed.
 * This NEVER changes legal rules — it only asks a human to re-verify them.
 */
export async function reviewComplianceCatalog({ supabase, now = new Date() } = {}) {
  if (!supabase) return { ok: false, total: 0, stale: [] };
  const { data, error } = await supabase
    .from('compliance_catalog')
    .select('*')
    .eq('is_active', true)
    .limit(500);
  if (error) return { ok: false, total: 0, stale: [], error: error.message };

  const today = new Date(now).toISOString().slice(0, 10);
  const stale = (data || [])
    .filter((row) => row.next_review_at && String(row.next_review_at).slice(0, 10) <= today)
    .map((row) => ({
      countryCode: row.country_code,
      nextReviewAt: row.next_review_at,
      catalogVersion: row.catalog_version || null,
      source: row.source || 'bundled'
    }));

  return { ok: true, total: (data || []).length, stale, catalogVersion: COMPLIANCE_CATALOG_VERSION };
}

/**
 * Superadmin/Sentinel override (effective-dated). Only explicit admin action
 * may change compliance rules; AI never auto-applies legal changes.
 */
export async function upsertComplianceCatalogEntry({
  supabase,
  countryCode,
  minimal,
  additional = [],
  effectiveFrom = null,
  now = new Date()
} = {}) {
  if (!supabase) return { ok: false, error: 'Database unavailable.' };
  if (!countryCode || !minimal?.type || !minimal?.label) {
    return { ok: false, error: 'countryCode and a minimal { type, label } are required.' };
  }

  const code = String(countryCode).toUpperCase();
  const today = new Date(now).toISOString().slice(0, 10);
  const nextReview = new Date(new Date(now).getTime() + CATALOG_REVIEW_DAYS * 86400000).toISOString().slice(0, 10);
  const row = {
    country_code: code,
    minimal,
    additional,
    lifetime_allowed: Boolean(minimal.lifetimeAllowed ?? minimal.lifetime_allowed),
    effective_from: effectiveFrom || today,
    reviewed_at: new Date(now).toISOString(),
    next_review_at: nextReview,
    source: 'override',
    catalog_version: COMPLIANCE_CATALOG_VERSION,
    is_active: true
  };

  const { data: existing } = await supabase.from('compliance_catalog').select('id').eq('country_code', code).limit(1);
  const found = Array.isArray(existing) ? existing[0] : existing;

  if (found?.id) {
    const { error } = await supabase.from('compliance_catalog').update(row).eq('id', found.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from('compliance_catalog').insert([row]);
    if (error) return { ok: false, error: error.message };
  }

  clearComplianceCatalogCache();
  return { ok: true, countryCode: code, catalogVersion: COMPLIANCE_CATALOG_VERSION };
}

export default {
  COMPLIANCE_CATALOG_VERSION,
  COUNTRY_COMPLIANCE_CATALOG,
  complianceCategory,
  resolveBundledCatalog,
  getComplianceCatalog,
  describeComplianceRequirement,
  parseComplianceItem,
  ensureComplianceCatalog,
  reviewComplianceCatalog,
  upsertComplianceCatalogEntry,
  clearComplianceCatalogCache
};

