/**
 * Saka Fleet — Country Bucket (v1.21.0)
 * -------------------------------------
 * Every user is placed in ONE country bucket, created automatically at
 * onboarding from the WhatsApp number (E.164) and confirmed once. The bucket
 * carries the jurisdiction knowledgebase — vehicle/driver compliance, permits,
 * tax and traffic guidance — plus example texts so submissions are one-liners.
 *
 * Legal content is ENGINE-OWNED: bundled defaults + superadmin-approved
 * overrides in `country_kb`. Saka never invents a rule, and every statement
 * carries its authority, source and verified date.
 */

import { REGIONS, detectCountryFromPhone } from './globalization.js';

export const COUNTRY_KB_VERSION = '2026.10.1';
export const KB_VERIFIED_AT = '2026-10-30';
export const KB_REVIEW_DAYS = 90;
export const JURISDICTION_DISCLAIMER = 'ℹ️ Guidance from official sources — always confirm with your local authority.';

export const ASSET_KINDS = Object.freeze({
  vehicle: { label: 'Car / van', requiresPlate: true, requiresVin: true, meter: 'odometer' },
  motorcycle: { label: 'Motorcycle / boda', requiresPlate: true, requiresVin: true, meter: 'odometer' },
  truck: { label: 'Truck / HGV', requiresPlate: true, requiresVin: true, meter: 'odometer' },
  bus: { label: 'Bus / matatu', requiresPlate: true, requiresVin: true, meter: 'odometer' },
  heavy_equipment: { label: 'Heavy equipment', requiresPlate: false, requiresVin: false, meter: 'hours' },
  machinery: { label: 'Machinery / plant', requiresPlate: false, requiresVin: false, meter: 'hours' },
  generator: { label: 'Generator', requiresPlate: false, requiresVin: false, meter: 'hours' },
  watercraft: { label: 'Boat / watercraft', requiresPlate: false, requiresVin: false, meter: 'hours' }
});

const ASSET_ALIASES = [
  { kind: 'generator', re: /\b(generator|genset|gen set|power ?plant|standby power)\b/i },
  { kind: 'heavy_equipment', re: /\b(excavator|bulldozer|loader|grader|crane|forklift|backhoe|dozer|heavy equipment)\b/i },
  { kind: 'machinery', re: /\b(machinery|machine|tractor|plant|compressor|pump|tiller)\b/i },
  { kind: 'watercraft', re: /\b(boat|vessel|watercraft|ship|ferry|canoe)\b/i },
  { kind: 'motorcycle', re: /\b(motorcycle|motorbike|bike|boda|tuk ?tuk|scooter)\b/i },
  { kind: 'bus', re: /\b(bus|matatu|minibus|coach|daladala)\b/i },
  { kind: 'truck', re: /\b(truck|lorry|hgv|tanker|trailer|pickup|pick-up)\b/i },
  { kind: 'vehicle', re: /\b(car|van|suv|saloon|sedan|vehicle|auto)\b/i }
];

export function normalizeAssetKind(value) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) return 'vehicle';
  if (ASSET_KINDS[clean]) return clean;
  const match = ASSET_ALIASES.find((entry) => entry.re.test(clean));
  return match ? match.kind : 'vehicle';
}

/** Deterministic asset-kind detection from free text. */
export function detectAssetKind(text = '') {
  for (const entry of ASSET_ALIASES) {
    if (entry.re.test(String(text))) return entry.kind;
  }
  return null;
}

export function isRoadAsset(kind) {
  return ASSET_KINDS[normalizeAssetKind(kind)].requiresPlate;
}

export function requiresPlate(kind) {
  return ASSET_KINDS[normalizeAssetKind(kind)].requiresPlate;
}

export function requiresVin(kind) {
  return ASSET_KINDS[normalizeAssetKind(kind)].requiresVin;
}

export function meterForAssetKind(kind) {
  return ASSET_KINDS[normalizeAssetKind(kind)].meter;
}

/** Plate for road assets, serial/model identity for everything else. */
export function assetDisplayName(asset = {}) {
  if (asset.plate_number) return asset.plate_number;
  const serial = asset.serial_number ? ` (SN ${asset.serial_number})` : '';
  return `${asset.make_model || ASSET_KINDS[normalizeAssetKind(asset.asset_kind)].label}${serial}`;
}

function rule(key, category, title, summary, options = {}) {
  return Object.freeze({
    key,
    category,
    title,
    summary,
    example: options.example || null,
    required: options.required !== false,
    renewal: options.renewal || null,
    assetKinds: options.assetKinds || null,
    lawReference: options.lawReference || null,
    fullText: options.fullText || summary
  });
}

/**
 * Bundled jurisdiction knowledgebase. Every entry is conservative, sourced and
 * verified on KB_VERIFIED_AT; superadmin overrides can replace any rule by key.
 */
export const COUNTRY_KB = Object.freeze({
  DEFAULT: {
    country: 'International',
    authority: 'Local transport authority',
    sources: [],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Vehicle insurance', 'Third-party or equivalent cover is required in most jurisdictions.', {
        example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual', lawReference: 'Local insurance act'
      }),
      rule('vehicle_inspection', 'vehicle_compliance', 'Roadworthiness inspection', 'Periodic inspection may be required before renewal.', {
        example: 'Inspection expires 2027-03-15', renewal: 'annual', lawReference: 'Local traffic act'
      }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'A valid licence for the class of vehicle you drive.', {
        example: 'Licence DL-123456 expires 2028-01-31', renewal: 'per licence', lawReference: 'Local traffic act'
      }),
      rule('carry_documents', 'traffic_law', 'Carry your documents', 'Keep your licence and insurance available for checks.', {
        required: false, example: 'Log insurance expires 2027-05-15'
      })
    ]
  },
  KE: {
    country: 'Kenya',
    authority: 'NTSA (National Transport and Safety Authority)',
    sources: [
      { label: 'NTSA', url: 'https://www.ntsa.go.ke' },
      { label: 'Kenya Law', url: 'https://new.kenyalaw.org' }
    ],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'At least third-party cover under the Insurance Act.', {
        example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual', lawReference: 'Insurance (Motor Vehicles Third Party Risks) Act'
      }),
      rule('vehicle_inspection', 'vehicle_compliance', 'NTSA inspection', 'Roadworthiness inspection for public service and older vehicles.', {
        example: 'Inspection expires 2027-03-15', renewal: 'annual', lawReference: 'Traffic Act (Cap 403)'
      }),
      rule('road_service_licence', 'vehicle_compliance', 'Road Service Licence (PSL)', 'Required for public service and commercial vehicles.', {
        example: 'Road service licence RSL-5544 expires 2027-06-30', renewal: 'annual', assetKinds: ['bus', 'truck', 'vehicle'], lawReference: 'Traffic Act (Cap 403)'
      }),
      rule('speed_limiter', 'vehicle_compliance', 'Speed limiter certificate', 'Required for PSV and heavy commercial vehicles.', {
        example: 'Speed limiter SL-7788 expires 2027-04-30', renewal: 'annual', assetKinds: ['bus', 'truck'], lawReference: 'NTSA speed limiter rules'
      }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'Valid NTSA licence for the vehicle class.', {
        example: 'Licence DL-123456 expires 2028-01-31', lawReference: 'Traffic Act (Cap 403)'
      }),
      rule('psv_badge', 'driver_compliance', 'PSV badge', 'Required for public service vehicle drivers.', {
        example: 'PSV badge PSV-8899 expires 2027-02-28', renewal: 'annual', assetKinds: ['bus', 'truck'], lawReference: 'NTSA PSV rules'
      }),
      rule('seatbelt_and_helmet', 'traffic_law', 'Seatbelts and helmets', 'Seatbelts for all occupants; helmets for motorcyclists.', {
        required: false, assetKinds: ['vehicle', 'motorcycle', 'truck', 'bus'], lawReference: 'Traffic Act (Cap 403)'
      })
    ]
  },

  TZ: {
    country: 'Tanzania',
    authority: 'TRA / Tanzania Police Traffic',
    sources: [{ label: 'TRA', url: 'https://www.tra.go.tz' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'Third-party cover required for all motor vehicles.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('vehicle_inspection', 'vehicle_compliance', 'Inspection', 'Periodic roadworthiness inspection.', { example: 'Inspection expires 2027-03-15', renewal: 'annual' }),
      rule('road_licence', 'vehicle_compliance', 'Road licence', 'Annual road licence (road tax).', { example: 'Road licence expires 2027-01-31', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'Valid Tanzanian driving licence.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('psv_licence', 'driver_compliance', 'PSV licence', 'Required for public service vehicles.', { example: 'PSV licence PSV-8899 expires 2027-02-28', renewal: 'annual', assetKinds: ['bus', 'truck'] })
    ]
  },
  UG: {
    country: 'Uganda',
    authority: 'URA / Ministry of Works and Transport',
    sources: [{ label: 'URA', url: 'https://www.ura.go.ug' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'Third-party cover required.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('vehicle_inspection', 'vehicle_compliance', 'Inspection', 'Periodic inspection for roadworthiness.', { example: 'Inspection expires 2027-03-15', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driving permit', 'Valid Ugandan driving permit.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('psv_permit', 'driver_compliance', 'PSV permit', 'Required for public service vehicles.', { example: 'PSV permit PSV-8899 expires 2027-02-28', renewal: 'annual', assetKinds: ['bus', 'truck'] })
    ]
  },
  RW: {
    country: 'Rwanda',
    authority: 'RRA / Rwanda National Police (Traffic)',
    sources: [{ label: 'RRA', url: 'https://www.rra.gov.rw' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'Third-party cover required.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('vehicle_inspection', 'vehicle_compliance', 'Inspection', 'Periodic technical inspection.', { example: 'Inspection expires 2027-03-15', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'Valid Rwandan driving licence.', { example: 'Licence DL-123456 expires 2028-01-31' })
    ]
  },
  NG: {
    country: 'Nigeria',
    authority: 'FRSC / State Motor Licensing Office',
    sources: [{ label: 'FRSC', url: 'https://frsc.gov.ng' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'Third-party insurance required.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('road_worthiness', 'vehicle_compliance', 'Road worthiness certificate', 'Issued after inspection.', { example: 'Road worthiness RWC-4455 expires 2027-04-30', renewal: 'annual' }),
      rule('vehicle_licence', 'vehicle_compliance', 'Vehicle licence', 'Annual vehicle licence/registration.', { example: 'Vehicle licence expires 2027-01-31', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driver licence', 'Valid FRSC-issued licence.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('hackney_permit', 'driver_compliance', 'Hackney permit', 'Required for commercial passenger vehicles.', { example: 'Hackney permit HP-8899 expires 2027-02-28', renewal: 'annual', assetKinds: ['bus', 'truck'] })
    ]
  },
  ZA: {
    country: 'South Africa',
    authority: 'Department of Transport / provincial licensing',
    sources: [{ label: 'Department of Transport', url: 'https://www.transport.gov.za' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Insurance', 'Third-party or comprehensive cover.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('roadworthy', 'vehicle_compliance', 'Roadworthy certificate', 'Required for licensing and transfers.', { example: 'Roadworthy COR-4455 expires 2027-04-30' }),
      rule('licence_disc', 'vehicle_compliance', 'Vehicle licence disc', 'Annual licence disc.', { example: 'Licence disc expires 2027-01-31', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'Valid South African licence.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('pdp', 'driver_compliance', 'Professional Driving Permit (PDP)', 'Required for goods and passenger transport.', { example: 'PDP PDP-8899 expires 2027-02-28', renewal: 'annual', assetKinds: ['bus', 'truck'] })
    ]
  },

  GB: {
    country: 'United Kingdom',
    authority: 'DVLA / DVSA',
    sources: [{ label: 'GOV.UK driving and transport', url: 'https://www.gov.uk/browse/driving' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'At least third-party cover is a legal minimum.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('mot', 'vehicle_compliance', 'MOT certificate', 'Annual test for vehicles over three years old.', { example: 'MOT expires 2027-03-15', renewal: 'annual' }),
      rule('road_tax', 'vehicle_compliance', 'Vehicle tax (VED)', 'Vehicle tax or a valid exemption.', { example: 'Road tax expires 2027-01-31', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'Valid DVLA licence for the vehicle category.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('driver_cpc', 'driver_compliance', 'Driver CPC', 'Required for lorries and buses professionally.', { example: 'Driver CPC expires 2027-02-28', renewal: '5 years', assetKinds: ['truck', 'bus'] })
    ]
  },
  US: {
    country: 'United States',
    authority: 'State DMV / NHTSA',
    sources: [{ label: 'NHTSA', url: 'https://www.nhtsa.gov' }, { label: 'USA.gov vehicle registration', url: 'https://www.usa.gov/vehicle-registration' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Insurance', 'Liability cover required in almost every state.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: '6-12 months' }),
      rule('registration', 'vehicle_compliance', 'Registration', 'State registration renewal.', { example: 'Registration expires 2027-01-31', renewal: 'annual' }),
      rule('inspection', 'vehicle_compliance', 'State inspection / emissions', 'Required in many states.', { example: 'Inspection expires 2027-03-15', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', "Driver's licence", 'State-issued licence; CDL for commercial vehicles.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('cdl', 'driver_compliance', 'Commercial Driver License (CDL)', 'Required for heavy and commercial vehicles.', { example: 'CDL CDL-8899 expires 2027-02-28', assetKinds: ['truck', 'bus'] })
    ]
  },
  CA: {
    country: 'Canada',
    authority: 'Provincial ministry of transportation',
    sources: [{ label: 'Transport Canada', url: 'https://tc.canada.ca' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Insurance', 'Provincial insurance requirements.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('registration', 'vehicle_compliance', 'Registration', 'Provincial registration renewal.', { example: 'Registration expires 2027-01-31', renewal: 'annual' }),
      rule('inspection', 'vehicle_compliance', 'Safety inspection', 'Required where mandated by the province.', { example: 'Inspection expires 2027-03-15', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', "Driver's licence", 'Provincial licence for the vehicle class.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('cdl', 'driver_compliance', 'Commercial driver licence', 'Required for heavy vehicles.', { example: 'CDL CDL-8899 expires 2027-02-28', assetKinds: ['truck', 'bus'] })
    ]
  },

  AE: {
    country: 'United Arab Emirates',
    authority: 'RTA / local traffic department',
    sources: [{ label: 'RTA Dubai', url: 'https://www.rta.ae' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Insurance', 'Comprehensive or third-party cover.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('registration', 'vehicle_compliance', 'Registration (Mulkiya)', 'Annual registration renewal.', { example: 'Mulkiya expires 2027-01-31', renewal: 'annual' }),
      rule('inspection', 'vehicle_compliance', 'Inspection (Tasjeel)', 'Annual technical inspection.', { example: 'Inspection expires 2027-03-15', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'UAE licence for the vehicle class.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('heavy_vehicle_permit', 'driver_compliance', 'Heavy vehicle permit', 'Required for heavy vehicles.', { example: 'Heavy vehicle permit HV-8899 expires 2027-02-28', assetKinds: ['truck', 'bus'] })
    ]
  },
  IN: {
    country: 'India',
    authority: 'Parivahan / State RTO',
    sources: [{ label: 'Parivahan', url: 'https://parivahan.gov.in' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'Third-party cover is mandatory.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('fitness_certificate', 'vehicle_compliance', 'Fitness certificate', 'For commercial vehicles.', { example: 'Fitness FC-4455 expires 2027-04-30', renewal: 'annual', assetKinds: ['truck', 'bus'] }),
      rule('road_tax', 'vehicle_compliance', 'Road tax', 'State road tax as applicable.', { example: 'Road tax expires 2027-01-31', renewal: 'periodic' }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'Valid RTO licence for the class.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('commercial_dl', 'driver_compliance', 'Commercial driving licence', 'Required for commercial vehicles.', { example: 'Commercial DL CDL-8899 expires 2027-02-28', assetKinds: ['truck', 'bus'] })
    ]
  },
  AU: {
    country: 'Australia',
    authority: 'State transport authority',
    sources: [{ label: 'infrastructure.gov.au', url: 'https://www.infrastructure.gov.au' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Compulsory third party insurance', 'CTP cover comes with registration in most states.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('registration', 'vehicle_compliance', 'Registration (rego)', 'State registration renewal.', { example: 'Registration expires 2027-01-31', renewal: 'annual' }),
      rule('roadworthy', 'vehicle_compliance', 'Roadworthy certificate', 'Required for transfers and older vehicles.', { example: 'Roadworthy expires 2027-03-15' }),
      rule('driver_licence', 'driver_compliance', 'Driver licence', 'State licence for the vehicle class.', { example: 'Licence DL-123456 expires 2028-01-31' }),
      rule('hrt_licence', 'driver_compliance', 'Heavy rigid truck licence', 'Required for heavy vehicles.', { example: 'HR licence HR-8899 expires 2027-02-28', assetKinds: ['truck'] })
    ]
  },
  BE: {
    country: 'Belgium',
    authority: 'SPF Mobilité / DIV',
    sources: [{ label: 'Mobilité Belgique', url: 'https://mobilit.belgium.be' }],
    rules: [
      rule('vehicle_insurance', 'vehicle_compliance', 'Motor insurance', 'Third-party cover is mandatory.', { example: 'Insurance ABC-123 expires 2027-05-15', renewal: 'annual' }),
      rule('vehicle_inspection', 'vehicle_compliance', 'Technical inspection', 'Periodic vehicle inspection.', { example: 'Inspection expires 2027-03-15', renewal: 'annual' }),
      rule('road_tax', 'vehicle_compliance', 'Road tax', 'Annual traffic tax.', { example: 'Road tax expires 2027-01-31', renewal: 'annual' }),
      rule('driver_licence', 'driver_compliance', 'Driving licence', 'Belgian licences are issued for life (B category).', { example: 'Licence DL-123456 valid for life', renewal: 'lifetime' })
    ]
  }
});


/** Resolve a user-typed country name/code (e.g. "Kenya", "ke", "+254"). */
export function resolveCountryInput(input = '') {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const byCode = REGIONS.find((region) => region.country_code === upper);
  if (byCode) return byCode;
  const byName = REGIONS.find((region) => region.country.toLowerCase() === raw.toLowerCase());
  if (byName) return byName;
  const partial = REGIONS.find((region) => region.country.toLowerCase().startsWith(raw.toLowerCase()));
  if (partial) return partial;
  if (/^\+\d+/.test(raw)) return detectCountryFromPhone(raw);
  return null;
}

function ruleMatchesAsset(ruleEntry, assetKind) {
  if (!ruleEntry.assetKinds || ruleEntry.assetKinds.length === 0) return true;
  return ruleEntry.assetKinds.includes(normalizeAssetKind(assetKind));
}

/**
 * Resolve the country bucket (bundled + optional superadmin overrides).
 * @param {{ countryCode?: string, assetKind?: string, overrides?: Array }} opts
 */
export function getCountryBucket({ countryCode = 'GLOBAL', assetKind = 'vehicle', overrides = [] } = {}) {
  const code = String(countryCode || 'GLOBAL').toUpperCase();
  const bundle = COUNTRY_KB[code] || null;
  const base = bundle || COUNTRY_KB.DEFAULT;
  const kind = normalizeAssetKind(assetKind);

  const ruleMap = new Map(base.rules.map((entry) => [entry.key, entry]));
  for (const override of Array.isArray(overrides) ? overrides : []) {
    if (!override || override.is_active === false) continue;
    const overrideCode = String(override.country_code || '').toUpperCase();
    if (overrideCode && overrideCode !== code && overrideCode !== 'DEFAULT') continue;
    if (override.asset_kind && normalizeAssetKind(override.asset_kind) !== kind) continue;
    if (override.rule_key) {
      ruleMap.set(override.rule_key, Object.freeze({
        key: override.rule_key,
        category: override.category || 'vehicle_compliance',
        title: override.title || override.rule_key,
        summary: override.summary || '',
        fullText: override.full_text || override.summary || '',
        example: override.example_text || null,
        required: override.required !== false,
        renewal: override.renewal_hint || null,
        assetKinds: override.asset_kind ? [normalizeAssetKind(override.asset_kind)] : null,
        lawReference: override.law_reference || null,
        authority: override.authority || base.authority,
        sources: Array.isArray(override.source_urls) ? override.source_urls : base.sources,
        verifiedAt: override.verified_at || KB_VERIFIED_AT
      }));
    }
  }

  const rules = [...ruleMap.values()].filter((entry) => ruleMatchesAsset(entry, kind));
  return {
    countryCode: code === 'GLOBAL' ? 'GLOBAL' : code,
    country: base.country,
    authority: base.authority,
    assetKind: kind,
    assetLabel: ASSET_KINDS[kind].label,
    meter: ASSET_KINDS[kind].meter,
    rules,
    required: rules.filter((entry) => entry.required),
    optional: rules.filter((entry) => !entry.required),
    examples: rules.filter((entry) => entry.example).map((entry) => ({ key: entry.key, text: entry.example })),
    sources: base.sources,
    verifiedAt: KB_VERIFIED_AT,
    kbVersion: COUNTRY_KB_VERSION,
    fallback: !bundle
  };
}

/** DB-backed bucket (country_kb overrides) — never throws. */
export async function loadCountryBucket(providedSupabase, { countryCode = 'GLOBAL', assetKind = 'vehicle' } = {}) {
  const fallbackBucket = getCountryBucket({ countryCode, assetKind });
  if (!providedSupabase) return fallbackBucket;
  try {
    const { data, error } = await providedSupabase
      .from('country_kb')
      .select('*')
      .eq('is_active', true)
      .limit(500);
    if (error || !Array.isArray(data)) return fallbackBucket;
    return getCountryBucket({ countryCode, assetKind, overrides: data });
  } catch {
    return fallbackBucket;
  }
}


/** Prompt block: engine-owned jurisdiction context (no invented law). */
export function buildJurisdictionContext(bucket) {
  if (!bucket) return '';
  const required = bucket.required.slice(0, 6)
    .map((entry) => `- ${entry.title}${entry.renewal ? ` (${entry.renewal})` : ''}: ${entry.summary}`)
    .join('\n');
  const examples = bucket.examples.slice(0, 4)
    .map((entry) => `- "${entry.text}"`)
    .join('\n');
  return [
    `JURISDICTION CONTEXT (${bucket.country} · ${bucket.assetLabel} · KB ${bucket.kbVersion}, verified ${bucket.verifiedAt}):`,
    `Authority: ${bucket.authority}`,
    required ? `Required documents:\n${required}` : '',
    examples ? `Example submissions the user can send:\n${examples}` : '',
    'Quote only these rules; never invent a law, penalty or deadline. Always add the disclaimer when giving legal guidance.'
  ].filter(Boolean).join('\n');
}

export function formatCountryRulesReply(bucket) {
  const lines = bucket.rules.slice(0, 8).map((entry) => {
    const flag = entry.required ? '✅' : 'ℹ️';
    return `${flag} *${entry.title}* — ${entry.summary}${entry.renewal ? ` _(${entry.renewal})_` : ''}`;
  });
  return [
    `🌍 *${bucket.country} · ${bucket.assetLabel}*`,
    `Authority: ${bucket.authority}`,
    '',
    ...lines,
    '',
    `📚 ${bucket.sources.length ? bucket.sources.map((source) => source.label).join(' · ') : 'Official sources'} · verified ${bucket.verifiedAt}`,
    JURISDICTION_DISCLAIMER
  ].join('\n');
}

export function formatRequiredDocumentsReply(bucket) {
  if (!bucket.required.length) {
    return `✅ Nothing mandatory found for ${bucket.assetLabel} in ${bucket.country} yet.\n\n${JURISDICTION_DISCLAIMER}`;
  }
  const lines = bucket.required.map((entry, index) =>
    `${index + 1}. *${entry.title}*${entry.renewal ? ` — ${entry.renewal}` : ''}\n   📝 _${entry.example || 'Send the number and expiry'}_`);
  const sample = bucket.examples[0]?.text || 'Insurance ABC-123 expires 2027-05-15';
  return [
    `📄 *Required for your ${bucket.assetLabel} in ${bucket.country}*`,
    '',
    ...lines,
    '',
    `Reply with any line and I'll log it (e.g. *"${sample}"*).`,
    JURISDICTION_DISCLAIMER
  ].join('\n');
}

export function formatExampleComplianceReply(bucket, { plate = null } = {}) {
  const example = bucket.examples[0];
  if (!example) return `No example is available for ${bucket.country} yet.\n\n${JURISDICTION_DISCLAIMER}`;
  const platePattern = /\b[A-Z]{2,4}[\s-]?\d{3,4}[A-Z]?\b/;
  let text = example.text;
  if (plate) {
    text = platePattern.test(text) ? text.replace(platePattern, plate) : `For ${plate}: ${text}`;
  }
  return `📝 *Example for ${bucket.country}:*\n\n"${text}"\n\nSend it in your own words — I'll confirm before saving.\n${JURISDICTION_DISCLAIMER}`;
}

export default {
  COUNTRY_KB,
  COUNTRY_KB_VERSION,
  KB_VERIFIED_AT,
  KB_REVIEW_DAYS,
  JURISDICTION_DISCLAIMER,
  ASSET_KINDS,
  normalizeAssetKind,
  detectAssetKind,
  isRoadAsset,
  requiresPlate,
  requiresVin,
  meterForAssetKind,
  assetDisplayName,
  resolveCountryInput,
  getCountryBucket,
  loadCountryBucket,
  buildJurisdictionContext,
  formatCountryRulesReply,
  formatRequiredDocumentsReply,
  formatExampleComplianceReply
};

