/**
 * Saka Fleet — Driver Compliance Catalog (v1.31.0)
 * ------------------------------------------------
 * The driver-side companion to the vehicle compliance catalogs: a deterministic
 * registry of the documents a professional driver carries across Saka's
 * markets. Used for labels, onboarding choices and report wording; the
 * submitted rows still live in `driver_compliances`.
 */

export const DRIVER_COMPLIANCE_TYPES = Object.freeze([
  { value: 'driving_licence', label: 'Driving Licence', aliases: ['driving licence', 'driving license', 'driver licence', 'driver license', 'licence', 'license', 'dl'] },
  { value: 'psv_badge', label: 'PSV Badge', aliases: ['psv badge', 'psv', 'public service vehicle badge', 'badge'] },
  { value: 'pdp', label: 'PDP (Professional Driving Permit)', aliases: ['pdp', 'professional driving permit', 'professional permit'] },
  { value: 'cpc', label: 'CPC (Certificate of Professional Competence)', aliases: ['cpc', 'certificate of professional competence', 'driver cpc'] },
  // v1.85.0 (Phase 24) — the professional items the rest of the world issues.
  { value: 'commercial_licence', label: 'Commercial Licence (CDL)', aliases: ['commercial licence', 'commercial license', 'cdl', 'commercial driving licence', 'commercial driving license', 'class a cdl'] },
  { value: 'driver_card', label: 'Driver Qualification Card', aliases: ['driver card', 'driver qualification card', 'dqc', 'driver cpc card'] },
  { value: 'heavy_vehicle_permit', label: 'Heavy Vehicle Permit', aliases: ['heavy vehicle permit', 'heavy permit', 'hvp'] },
  { value: 'hrt_licence', label: 'Heavy Rigid Truck Licence', aliases: ['hrt', 'heavy rigid', 'heavy rigid truck licence', 'hr licence'] },
  { value: 'white_card', label: 'Construction White Card', aliases: ['white card', 'construction induction', 'white card certificate'] },
  { value: 'operator_card', label: 'Operator Card', aliases: ['operator card', 'operator licence', 'operator license'] },
  { value: 'medical_certificate', label: 'Medical Certificate', aliases: ['medical certificate', 'medical', 'fitness certificate', 'medical fitness'] },
  { value: 'defensive_driving', label: 'Defensive Driving Certificate', aliases: ['defensive driving', 'defensive driving certificate', 'defensive'] },
  { value: 'other', label: 'Other Document', aliases: ['other', 'document', 'certificate'] }
]);

export const DRIVER_COMPLIANCE_VALUES = Object.freeze(DRIVER_COMPLIANCE_TYPES.map((type) => type.value));

const ALIAS_MATCHERS = (() => {
  const entries = [];
  for (const type of DRIVER_COMPLIANCE_TYPES) {
    for (const alias of type.aliases) entries.push({ alias: alias.toLowerCase(), value: type.value });
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return entries.map((entry) => ({
    ...entry,
    re: new RegExp(`(?:^|[^a-z0-9])${entry.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i')
  }));
})();

export function resolveDriverComplianceType(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const exact = DRIVER_COMPLIANCE_TYPES.find((type) => type.value.toLowerCase() === clean.toLowerCase()
    || type.label.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.value;
  for (const matcher of ALIAS_MATCHERS) {
    if (matcher.re.test(clean)) return matcher.value;
  }
  return null;
}

export function normalizeDriverComplianceType(value, { fallback = 'other' } = {}) {
  return resolveDriverComplianceType(value) || fallback;
}

export function driverComplianceLabel(value) {
  const resolved = resolveDriverComplianceType(value) || 'other';
  return DRIVER_COMPLIANCE_TYPES.find((type) => type.value === resolved)?.label || 'Other Document';
}

/**
 * v1.85.0 (Phase 24) — the professional set follows the COUNTRY's real documents
 * (mirrors COUNTRY_KB + complianceCatalog): East Africa keeps PSV/PDP/CPC, the
 * UK/ Belgium the CPC + driver qualification card, North America the CDL, the
 * Gulf/India the heavy-vehicle permit, Australia the HR licence + white card.
 */
export const PROFESSIONAL_DRIVER_ITEMS = Object.freeze({
  KE: ['psv_badge', 'pdp', 'cpc'],
  TZ: ['psv_badge', 'pdp', 'cpc'],
  UG: ['psv_badge', 'pdp', 'cpc'],
  RW: ['psv_badge', 'pdp', 'cpc'],
  NG: ['psv_badge', 'pdp', 'cpc'],
  ZA: ['psv_badge', 'pdp', 'cpc'],
  GB: ['cpc', 'driver_card', 'operator_card'],
  BE: ['cpc', 'driver_card'],
  US: ['commercial_licence'],
  CA: ['commercial_licence'],
  AE: ['heavy_vehicle_permit'],
  IN: ['heavy_vehicle_permit'],
  AU: ['hrt_licence', 'white_card']
});

/** Onboarding menu: licence first, then the local professional extras. */
export function driverComplianceChoices({ countryCode = 'GLOBAL' } = {}) {
  const code = String(countryCode || 'GLOBAL').toUpperCase();
  const professional = PROFESSIONAL_DRIVER_ITEMS[code] || ['operator_card'];
  const values = ['driving_licence', ...professional, 'medical_certificate', 'other'];
  return values.map((value) => {
    const type = DRIVER_COMPLIANCE_TYPES.find((entry) => entry.value === value);
    return { value: type.value, label: type.label, aliases: [...type.aliases] };
  });
}

export default {
  DRIVER_COMPLIANCE_TYPES,
  DRIVER_COMPLIANCE_VALUES,
  PROFESSIONAL_DRIVER_ITEMS,
  resolveDriverComplianceType,
  normalizeDriverComplianceType,
  driverComplianceLabel,
  driverComplianceChoices
};
