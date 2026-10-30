/**
 * Saka Fleet — VEHICLE Compliance Service (v1.16.0)
 * -------------------------------------------------
 * CLEAR SEPARATION (permanent):
 *   - DRIVER compliance  -> `driver_compliances` + driver catalog
 *                           (licences, PSV badges, CPC, PDP, operator cards).
 *   - VEHICLE compliance -> `vehicle_compliances` + vehicle catalog
 *                           (insurance, inspection/MOT, road service licence,
 *                            road tax, speed-limiter certificate, …).
 *
 * A vehicle can carry MANY asset permits; a driver can carry MANY personal
 * credentials. They never share a table, a catalog or a gate.
 *
 * One paragraph can carry several vehicle items at once:
 *   "Insurance policy ABC-123 expires 2027-05-15, PSL 445566 expires 30 Nov 2026"
 * -> both are parsed and saved in a single turn.
 *
 * Legacy `vehicles.insurance_expiry` / `inspection_expiry` stay dual-written so
 * reports and the universal expiry ladder never break.
 */

import { parseComplianceItem } from './complianceCatalog.js';
import { createExpiryReminder, buildExpirySpecFromDate, daysUntilDue } from './maintenanceReminders.js';
import { SYSTEM_TIMEZONE } from './dateParser.js';

export const VEHICLE_COMPLIANCE_CATALOG_VERSION = '2026.16.1';

function vItem(type, label, aliases = [], { lifetimeAllowed = false, assetTypes = null } = {}) {
  return Object.freeze({ type, label, aliases, lifetimeAllowed, assetTypes });
}

/**
 * Region-aware VEHICLE (asset) compliance catalog. Bundled defaults ship with
 * every release; a superadmin override can be layered later exactly like the
 * driver catalog. These items belong to the VEHICLE, never to a driver.
 */
export const VEHICLE_COMPLIANCE_CATALOG = Object.freeze({
  DEFAULT: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('inspection', 'Inspection', ['inspection', 'roadworthy', 'fitness', 'mot']),
      vItem('road_tax', 'Road tax', ['road tax', 'vehicle tax', 'ved'])
    ]
  },
  KE: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('inspection', 'Inspection (NTSA)', ['inspection', 'ntac', 'ntsa inspection']),
      vItem('road_service_licence', 'Road Service Licence (PSL)', ['road service', 'psl', 'road service licence', 'road service license']),
      vItem('speed_limiter', 'Speed limiter certificate', ['speed limiter', 'speed governor'], { assetTypes: ['PSV', 'BUS', 'MATATU', 'MINIBUS', 'TRUCK', 'HGV'] })
    ]
  },
  TZ: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('inspection', 'Inspection (TRA)', ['inspection', 'roadworthy']),
      vItem('road_tax', 'Road licence', ['road licence', 'road license', 'road tax'])
    ]
  },
  UG: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy']),
      vItem('inspection', 'Inspection (URA)', ['inspection', 'roadworthy'])
    ]
  },
  RW: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy']),
      vItem('inspection', 'Inspection (RRA)', ['inspection', 'roadworthy'])
    ]
  },
  NG: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy']),
      vItem('road_worthiness', 'Road worthiness certificate', ['road worthiness', 'roadworthiness', 'roadworthy']),
      vItem('vehicle_licence', 'Vehicle licence', ['vehicle licence', 'vehicle license', 'road tax'])
    ]
  },
  ZA: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('roadworthy', 'Roadworthy certificate', ['roadworthy', 'cor']),
      vItem('licence_disc', 'Vehicle licence disc', ['licence disc', 'license disc', 'vehicle licence'])
    ]
  },
  GB: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('mot', 'MOT certificate', ['mot', 'inspection']),
      vItem('road_tax', 'Road tax (VED)', ['road tax', 'ved', 'vehicle tax'])
    ]
  },
  US: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('registration', 'Registration', ['registration', 'tags', 'plate renewal']),
      vItem('inspection', 'State inspection', ['inspection', 'emissions', 'smog'])
    ]
  },
  CA: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('registration', 'Registration', ['registration', 'plate sticker']),
      vItem('inspection', 'Safety inspection', ['inspection', 'safety'])
    ]
  },
  AE: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy']),
      vItem('registration', 'Registration (Mulkiya)', ['registration', 'mulkiya']),
      vItem('inspection', 'Inspection (Tasjeel)', ['inspection', 'tasjeel'])
    ]
  },
  IN: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy']),
      vItem('fitness_certificate', 'Fitness certificate', ['fitness', 'fitness certificate']),
      vItem('road_tax', 'Road tax', ['road tax', 'vehicle tax'])
    ]
  },
  AU: {
    items: [
      vItem('insurance', 'Insurance', ['insurance', 'insured', 'policy', 'cover']),
      vItem('registration', 'Registration', ['registration', 'rego']),
      vItem('roadworthy', 'Roadworthy certificate', ['roadworthy', 'pink slip'])
    ]
  }
});

const LEGACY_COLUMN_BY_TYPE = Object.freeze({
  insurance: 'insurance_expiry',
  inspection: 'inspection_expiry'
});

const CATEGORY_BY_TYPE = Object.freeze({
  insurance: 'insurance',
  inspection: 'inspection',
  mot: 'inspection',
  roadworthy: 'inspection',
  road_service_licence: 'licensing',
  road_tax: 'licensing',
  licence_disc: 'licensing',
  vehicle_licence: 'licensing',
  registration: 'licensing',
  speed_limiter: 'permit',
  road_worthiness: 'inspection',
  fitness_certificate: 'inspection'
});

function normalizeAssetType(assetType) {
  return String(assetType || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Sync resolver for the vehicle catalog (bundled defaults + asset filtering). */
export function resolveVehicleComplianceCatalog({ countryCode = 'GLOBAL', assetType = null } = {}) {
  const code = String(countryCode || 'GLOBAL').toUpperCase();
  const entry = VEHICLE_COMPLIANCE_CATALOG[code] || VEHICLE_COMPLIANCE_CATALOG.DEFAULT;
  const normalizedAsset = normalizeAssetType(assetType);
  const items = (entry.items || []).filter((item) => {
    if (!item.assetTypes || item.assetTypes.length === 0) return true;
    return Boolean(normalizedAsset) && item.assetTypes.includes(normalizedAsset);
  });
  return {
    countryCode: code,
    items,
    catalogVersion: VEHICLE_COMPLIANCE_CATALOG_VERSION,
    scope: 'vehicle'
  };
}

/** Category for the universal reminder ladder. */
export function vehicleComplianceCategory(type) {
  return CATEGORY_BY_TYPE[String(type || '').toLowerCase()] || 'other';
}

/**
 * Parse ONE paragraph into every vehicle compliance item it mentions.
 * Item segments are sliced from the text so several items never steal each
 * other's numbers/dates.
 * @returns {Array<{item:object, parsed:object, segment:string}>}
 */
export function parseVehicleComplianceParagraph(text, {
  countryCode = 'GLOBAL',
  assetType = null,
  locale = 'en-US',
  timeZone = SYSTEM_TIMEZONE,
  now = new Date()
} = {}) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const lower = clean.toLowerCase();
  const catalog = resolveVehicleComplianceCatalog({ countryCode, assetType });

  const matches = [];
  for (const item of catalog.items) {
    const aliases = [item.type.replace(/_/g, ' '), item.label, ...(item.aliases || [])];
    let best = -1;
    for (const alias of aliases) {
      const idx = lower.indexOf(String(alias).toLowerCase());
      if (idx >= 0 && (best === -1 || idx < best)) best = idx;
    }
    if (best >= 0) matches.push({ item, index: best });
  }
  if (matches.length === 0) return [];
  matches.sort((a, b) => a.index - b.index);

  const results = [];
  const seen = new Set();
  for (let i = 0; i < matches.length; i += 1) {
    const entry = matches[i];
    if (seen.has(entry.item.type)) continue;
    const start = entry.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : clean.length;
    const segment = clean.slice(start, end).replace(/^[,;.\s]+/, ' ').trim();
    const parsed = parseComplianceItem(segment, { countryCode, locale, now, timeZone, catalogItem: entry.item });
    if (parsed?.ok) {
      seen.add(entry.item.type);
      results.push({ item: entry.item, parsed, segment });
    }
  }
  return results;
}

/**
 * Upsert a vehicle compliance record, keep the legacy insurance/inspection
 * columns in sync and create/refresh the linked expiry reminder.
 */
export async function submitVehicleCompliance({
  supabase,
  vehicle,
  item,
  parsed,
  countryCode = 'GLOBAL',
  assetType = null,
  ownerId = null,
  timeZone = SYSTEM_TIMEZONE,
  now = new Date()
} = {}) {
  if (!supabase || !vehicle?.id || !item?.type || !parsed?.ok) {
    return { ok: false, error: 'vehicle, item and a parsed compliance are required.' };
  }

  const isoNow = new Date(now).toISOString();
  const expiry = parsed.lifetime ? null : (parsed.expiry || null);
  const row = {
    vehicle_id: vehicle.id,
    type: item.type,
    label: item.label,
    number: parsed.number || null,
    expiry,
    lifetime: Boolean(parsed.lifetime),
    country_code: String(countryCode || 'GLOBAL').toUpperCase(),
    asset_type: assetType || null,
    verified_at: isoNow,
    updated_at: isoNow
  };

  const { data: existing } = await supabase
    .from('vehicle_compliances')
    .select('id')
    .eq('vehicle_id', vehicle.id)
    .eq('type', item.type)
    .maybeSingle();

  const savedResult = existing?.id
    ? await supabase.from('vehicle_compliances').update(row).eq('id', existing.id).select().single()
    : await supabase.from('vehicle_compliances').insert([row]).select().single();
  if (savedResult.error) return { ok: false, error: savedResult.error.message };
  const saved = savedResult.data || row;

  // Legacy dual-write for the two column-backed items (reports/reminders).
  const legacyColumn = LEGACY_COLUMN_BY_TYPE[item.type];
  if (legacyColumn) {
    try {
      await supabase.from('vehicles').update({ [legacyColumn]: expiry, updated_at: isoNow }).eq('id', vehicle.id);
    } catch (syncErr) {
      console.warn('[vehicleCompliance] Legacy column sync skipped:', syncErr.message);
    }
  }

  let reminder = null;
  if (!parsed.lifetime && expiry) {
    const spec = buildExpirySpecFromDate(expiry, { timeZone });
    if (spec.ok) {
      reminder = await createExpiryReminder({
        supabase,
        vehicle,
        profileId: ownerId,
        reminderType: item.label,
        category: vehicleComplianceCategory(item.type),
        spec,
        timeZone,
        linkedColumn: legacyColumn ? `vehicles.${legacyColumn}` : `vehicle_compliances:${item.type}`,
        subjectType: 'vehicle_compliance',
        subjectId: vehicle.id
      });
      if (reminder?.ok && reminder.reminderId && saved?.id) {
        await supabase.from('vehicle_compliances').update({ reminder_id: reminder.reminderId }).eq('id', saved.id);
      }
    }
  }

  return { ok: true, compliance: saved, reminder };
}

/** Current vehicle compliance state (catalog items + stored extras). */
export async function getVehicleComplianceStatus({
  supabase,
  vehicle,
  countryCode = 'GLOBAL',
  assetType = null,
  now = new Date()
} = {}) {
  if (!supabase || !vehicle?.id) return { ok: false, items: [], missing: [] };
  const catalog = resolveVehicleComplianceCatalog({ countryCode, assetType });
  const { data } = await supabase.from('vehicle_compliances').select('*').eq('vehicle_id', vehicle.id).limit(100);
  const records = Array.isArray(data) ? data : [];

  const evaluate = (item, record) => {
    if (!record) {
      return { type: item.type, label: item.label, status: 'missing', valid: false, lifetime: false, expiry: null, daysLeft: null, number: null };
    }
    const lifetime = record.lifetime === true;
    const expiry = record.expiry ? String(record.expiry).slice(0, 10) : null;
    const daysLeft = expiry ? daysUntilDue(expiry, now) : null;
    const valid = lifetime ? item.lifetimeAllowed !== false : (daysLeft !== null && daysLeft >= 0);
    return {
      type: item.type,
      label: item.label,
      status: valid ? 'valid' : (daysLeft !== null && daysLeft < 0 ? 'expired' : 'invalid'),
      valid,
      lifetime,
      expiry,
      daysLeft,
      number: record.number || null
    };
  };

  const items = catalog.items.map((item) => evaluate(item, records.find((row) => String(row.type) === String(item.type))));

  // Stored permits outside the regional catalog remain visible.
  for (const record of records) {
    if (items.some((item) => item.type === record.type)) continue;
    items.push(evaluate({ type: record.type, label: record.label || record.type }, record));
  }

  return {
    ok: true,
    items,
    missing: items.filter((item) => item.status === 'missing').map((item) => item.label),
    catalogVersion: catalog.catalogVersion,
    scope: 'vehicle'
  };
}

/** Deterministic vehicle-compliance block for reports (never mixed with driver items). */
export function buildVehicleComplianceReportText({ plate, status }) {
  const items = status?.items || [];
  if (items.length === 0) return `🛡️ Vehicle compliance — ${plate || 'Vehicle'}: no catalog items.`;
  const lines = items.map((item) => {
    if (item.status === 'missing') return `• ${item.label}: not on file`;
    if (item.lifetime) return `• ${item.label}: valid for life`;
    const days = Number.isFinite(item.daysLeft) ? ` (${item.daysLeft} day(s) left)` : '';
    return `• ${item.label}: ${item.status === 'expired' ? 'EXPIRED' : 'valid'} ${item.expiry}${days}`;
  });
  return `🛡️ *Vehicle compliance — ${plate || 'Vehicle'}*\n${lines.join('\n')}`;
}

export default {
  VEHICLE_COMPLIANCE_CATALOG_VERSION,
  VEHICLE_COMPLIANCE_CATALOG,
  resolveVehicleComplianceCatalog,
  vehicleComplianceCategory,
  parseVehicleComplianceParagraph,
  submitVehicleCompliance,
  getVehicleComplianceStatus,
  buildVehicleComplianceReportText
};

