/**
 * Saka Fleet — Expense Catalog (v1.30.0)
 * -------------------------------------
 * One deterministic registry for every expense Saka accepts, across every asset
 * kind (vehicle, motorcycle, truck, bus, heavy equipment, machinery, generator,
 * watercraft). It replaces the three private classifiers that used to live in
 * fleetReports/reportLedger/reportMetrics and is the single source of truth for
 * the quiz menu, quick-path detection, report categories and ledger badges.
 *
 * Canonical values already stored in expense_logs ('Fuel', 'Maintenance',
 * 'Insurance', 'Tolls', 'Other') are preserved exactly; everything else is
 * additive. Resolution is longest-alias-first, so "fuel filter" is Parts while
 * "fuel" is Fuel, and "oil change" is Maintenance while "hydraulic oil" is
 * Consumables.
 */

const ALL_KINDS = Object.freeze(['vehicle', 'motorcycle', 'truck', 'bus', 'heavy_equipment', 'machinery', 'generator', 'watercraft']);
const ROAD_KINDS = Object.freeze(['vehicle', 'motorcycle', 'truck', 'bus']);
const HOURS_KINDS = Object.freeze(['heavy_equipment', 'machinery', 'generator', 'watercraft']);

/** Report-level categories: label, ledger badge text and semantic tone. */
export const EXPENSE_CATEGORIES = Object.freeze({
  fuel: { label: 'Fuel & energy', badge: 'FUEL', tone: 'brand' },
  maintenance: { label: 'Service & maintenance', badge: 'SERVICE', tone: 'warn' },
  parts: { label: 'Parts & filters', badge: 'PARTS', tone: 'warn' },
  tyres: { label: 'Tyres & wheels', badge: 'TYRES', tone: 'warn' },
  repairs: { label: 'Repairs', badge: 'REPAIRS', tone: 'warn' },
  bodywork: { label: 'Bodywork & paint', badge: 'BODY', tone: 'warn' },
  washing: { label: 'Washing & cleaning', badge: 'WASH', tone: 'neutral' },
  parking: { label: 'Parking', badge: 'PARKING', tone: 'negative' },
  tolls: { label: 'Tolls & road fees', badge: 'TOLLS', tone: 'negative' },
  fines: { label: 'Fines & penalties', badge: 'FINES', tone: 'negative' },
  compliance: { label: 'Insurance & licences', badge: 'COMPLIANCE', tone: 'warn' },
  accessories: { label: 'Accessories', badge: 'ACCESSORY', tone: 'neutral' },
  subscriptions: { label: 'Tracking & subscriptions', badge: 'SUBS', tone: 'negative' },
  towing: { label: 'Towing & recovery', badge: 'TOWING', tone: 'negative' },
  wages: { label: 'Crew wages', badge: 'WAGES', tone: 'negative' },
  consumables: { label: 'Consumables & fluids', badge: 'FLUIDS', tone: 'warn' },
  berthing: { label: 'Mooring & berthing', badge: 'MOORING', tone: 'negative' },
  // v1.59.7 — types that used to land in Insurance or Other (live audit).
  security: { label: 'Security', badge: 'SECURITY', tone: 'negative' },
  loading: { label: 'Loading & offloading', badge: 'LOADING', tone: 'negative' },
  weighbridge: { label: 'Weighbridge', badge: 'WEIGHBRIDGE', tone: 'negative' },
  hire: { label: 'Hire & rental', badge: 'HIRE', tone: 'negative' },
  route: { label: 'Route & stage fees', badge: 'ROUTE', tone: 'negative' },
  other: { label: 'Other', badge: 'OTHER', tone: 'neutral' }
});

export const EXPENSE_CATEGORY_KEYS = Object.freeze(Object.keys(EXPENSE_CATEGORIES));

/**
 * Canonical expense types. `menu` types appear in the WhatsApp quiz (max 8 per
 * asset kind); every type is still reachable by free text through its aliases.
 */
export const EXPENSE_TYPES = Object.freeze([
  {
    value: 'Fuel', category: 'fuel', kinds: ALL_KINDS, menu: true, odometerMode: 'fuel',
    aliases: ['fuel', 'fuels', 'fuelling', 'fueling', 'refuel', 'refuelling', 'refueling', 'diesel', 'petrol', 'gasoline', 'gas', 'cng', 'lpg', 'top up', 'top-up', 'topped up', 'full tank']
  },
  {
    value: 'Charging', category: 'fuel', kinds: ROAD_KINDS, menu: true, electric: true, odometerMode: 'optional',
    aliases: ['charging', 'charge', 'recharge', 'electricity', 'kwh', 'ev charge', 'charger']
  },
  {
    value: 'Maintenance', category: 'maintenance', kinds: ALL_KINDS, menu: true, odometerMode: 'optional',
    aliases: ['maintenance', 'service', 'servicing', 'oil change', 'engine oil', 'tune up', 'tune-up', 'checkup', 'check up', 'check-up', 'ac service', 'aircon service', 'greasing', 'lubrication', 'oil']
  },
  {
    value: 'Parts', category: 'parts', kinds: ALL_KINDS, menu: true, odometerMode: 'optional',
    aliases: ['parts', 'part', 'spare part', 'spare parts', 'spares', 'spare', 'filter', 'filters', 'oil filter', 'air filter', 'fuel filter', 'battery', 'batteries', 'brake pad', 'brake pads', 'brakes', 'brake disc', 'bulb', 'bulbs', 'wiper', 'wipers', 'belt', 'belts', 'alternator', 'starter', 'spark plug', 'spark plugs', 'mirror', 'horn']
  },
  {
    value: 'Tyres', category: 'tyres', kinds: ROAD_KINDS, menu: true, odometerMode: 'optional',
    aliases: ['tyre', 'tyres', 'tire', 'tires', 'puncture', 'tube', 'tubeless', 'tyre rotation', 'tire rotation', 'alignment', 'wheel alignment', 'balancing', 'tread', 'rims']
  },
  {
    value: 'Repairs', category: 'repairs', kinds: ALL_KINDS, menu: true, odometerMode: 'optional',
    aliases: ['repair', 'repairs', 'mechanic', 'workshop', 'engine repair', 'engine', 'gearbox', 'clutch', 'transmission', 'suspension', 'shock absorber', 'shocks', 'radiator', 'exhaust', 'electrical', 'wiring', 'overhaul', 'differential', 'axle', 'turbo', 'injector', 'pump', 'bearing', 'seal', 'welding', 'injector pump']
  },
  {
    value: 'Bodywork & Paint', category: 'bodywork', kinds: ROAD_KINDS, menu: false, odometerMode: 'never',
    aliases: ['bodywork', 'body work', 'paint', 'respray', 'dent', 'dents', 'bumper', 'windscreen', 'windshield', 'glass', 'panel beating', 'panel', 'rust']
  },
  {
    value: 'Washing', category: 'washing', kinds: ROAD_KINDS, menu: false, odometerMode: 'never',
    aliases: ['washing', 'wash', 'carwash', 'car wash', 'cleaning', 'detailing', 'valet', 'polish']
  },
  {
    value: 'Parking', category: 'parking', kinds: ROAD_KINDS, menu: true, odometerMode: 'never',
    aliases: ['parking', 'parking fee', 'parking fees', 'parking charge', 'parking charges']
  },
  {
    value: 'Tolls', category: 'tolls', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['toll', 'tolls', 'toll fee', 'toll fees', 'gate fee', 'gate fees', 'road fee', 'road fees', 'expressway', 'highway fee']
  },
  {
    value: 'Fines', category: 'fines', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['fine', 'fines', 'penalty', 'penalties', 'ticket', 'tickets', 'offence', 'offense', 'citation', 'court']
  },
  {
    value: 'Insurance', category: 'compliance', kinds: ALL_KINDS, menu: true, odometerMode: 'never',
    aliases: ['insurance', 'insurer', 'policy', 'policy number', 'premium', 'comprehensive cover', 'third party', 'cover note', 'cover']
  },
  {
    // v1.59.7 — licences/permissions split out of Insurance (live audit: "renewed
    // my licence" was being typed as Insurance). Same compliance category.
    value: 'Licences & Permits', category: 'compliance', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['licence', 'license', 'road licence', 'road license', 'driving licence', 'driving license', 'permit', 'permits', 'inspection', 'mot', 'renewal', 'renewals', 'sticker', 'speed limiter', 'psv licence', 'psv', 'pdp', 'badge', 'compliance']
  },
  {
    value: 'Accessories', category: 'accessories', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['accessory', 'accessories', 'bullbar', 'bull bar', 'winch', 'snorkel', 'roof rack', 'lift kit', 'dashcam', 'dash cam', 'radio', 'stereo', 'seat cover', 'seat covers', 'mats', 'tracker device', 'gps']
  },
  {
    value: 'Subscriptions', category: 'subscriptions', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['subscription', 'subscriptions', 'tracking fee', 'tracking subscription', 'telematics', 'security subscription', 'airtime', 'data bundle', 'sim card', 'software subscription']
  },
  {
    value: 'Towing & Recovery', category: 'towing', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['towing', 'tow', 'tow truck', 'recovery', 'breakdown', 'jump start', 'breakdown recovery']
  },
  {
    value: 'Crew Wages', category: 'wages', kinds: HOURS_KINDS, menu: true, odometerMode: 'never',
    aliases: ['wages', 'wage', 'salary', 'salaries', 'crew', 'driver allowance', 'allowance', 'operator wages', 'operator pay', 'staff', 'labour', 'labor']
  },
  {
    value: 'Consumables', category: 'consumables', kinds: HOURS_KINDS, menu: true, odometerMode: 'optional',
    aliases: ['consumables', 'consumable', 'hydraulic oil', 'hydraulic fluid', 'coolant', 'antifreeze', 'grease', 'lubricant', 'urea', 'adblue', 'def fluid', 'distilled water', 'battery water', 'gear oil', 'transmission fluid', 'brake fluid']
  },
  {
    value: 'Mooring & Berthing', category: 'berthing', kinds: ['watercraft'], menu: false, odometerMode: 'never',
    aliases: ['mooring', 'berthing', 'harbour', 'harbor', 'marina', 'slipway', 'dock', 'docking', 'anchorage', 'port fee', 'port fees']
  },
  {
    // v1.59.7 — live audit: these real fleet spends had no home and fell in Other.
    value: 'Security', category: 'security', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['security', 'askari', 'guard', 'guards', 'watchman', 'night guard', 'security fee', 'security fees', 'security guard']
  },
  {
    value: 'Loading & Offloading', category: 'loading', kinds: ['truck', 'bus', 'heavy_equipment', 'machinery', 'watercraft'], menu: false, odometerMode: 'never',
    aliases: ['loading', 'offloading', 'off-loading', 'off loading', 'loading fee', 'loading fees', 'loading charges', 'loader', 'loaders', 'cartage', 'turnboy']
  },
  {
    value: 'Weighbridge', category: 'weighbridge', kinds: ['truck'], menu: false, odometerMode: 'never',
    aliases: ['weighbridge', 'weigh bridge', 'weighing fee', 'weighing fees', 'scale fee', 'scale fees']
  },
  {
    value: 'Hire & Rental', category: 'hire', kinds: ALL_KINDS, menu: false, odometerMode: 'never',
    aliases: ['hire', 'rental', 'rent', 'hired', 'car hire', 'equipment hire', 'lease', 'leasing', 'charter']
  },
  {
    value: 'Route & Stage Fees', category: 'route', kinds: ['bus', 'motorcycle', 'truck'], menu: false, odometerMode: 'never',
    aliases: ['stage fee', 'stage fees', 'route fee', 'route fees', 'county fee', 'county fees', 'matatu fee', 'terminus fee', 'route charge']
  },
  {
    value: 'Other', category: 'other', kinds: ALL_KINDS, menu: true, odometerMode: 'never',
    aliases: ['other', 'others', 'misc', 'miscellaneous', 'sundry', 'sundries']
  }
]);

function normalizeKind(assetKind) {
  const clean = String(assetKind || 'vehicle').toLowerCase().replace(/[\s-]+/g, '_');
  if (clean === 'car' || clean === 'van' || clean === 'suv' || clean === 'pickup') return 'vehicle';
  if (clean === 'bike' || clean === 'motorbike' || clean === 'boda') return 'motorcycle';
  if (clean === 'lorry') return 'truck';
  if (clean === 'matatu' || clean === 'minibus') return 'bus';
  if (clean === 'excavator' || clean === 'heavy' || clean === 'equipment') return 'heavy_equipment';
  if (clean === 'genset') return 'generator';
  if (clean === 'boat' || clean === 'vessel' || clean === 'ship') return 'watercraft';
  return ALL_KINDS.includes(clean) ? clean : 'vehicle';
}

function isElectric(fuelType) {
  return /^(?:electric|ev|bev)$/i.test(String(fuelType || '').trim());
}

/**
 * Quiz menu for the asset kind (v1.59.7 — five real choices + "Other", so the
 * question stays WhatsApp-short; every other type is still reachable by free
 * text through its aliases).
 */
const MENU_PRIORITY = Object.freeze({
  road: ['Fuel', 'Charging', 'Maintenance', 'Parts', 'Tyres', 'Repairs'],
  hours: ['Fuel', 'Maintenance', 'Parts', 'Repairs', 'Consumables', 'Crew Wages']
});

export function expenseTypeChoices(assetKind = 'vehicle', { fuelType = null } = {}) {
  const kind = normalizeKind(assetKind);
  const electric = isElectric(fuelType);
  const eligible = EXPENSE_TYPES.filter((type) => {
    if (!type.menu || type.value === 'Other') return false;
    if (!type.kinds.includes(kind)) return false;
    if (type.value === 'Fuel' && electric) return false;
    if (type.electric && !electric) return false;
    return true;
  });
  const priority = MENU_PRIORITY[HOURS_KINDS.includes(kind) ? 'hours' : 'road'] || [];
  const ranked = [
    ...priority.map((value) => eligible.find((type) => type.value === value)).filter(Boolean),
    ...eligible.filter((type) => !priority.includes(type.value))
  ];
  const other = EXPENSE_TYPES.find((type) => type.value === 'Other');
  return [...ranked.slice(0, 5), other]
    .map((type) => ({ value: type.value, aliases: [...type.aliases] }));
}

/** One-line menu copy for prompts and hints. */
export function expenseTypeMenu(assetKind = 'vehicle', options = {}) {
  return expenseTypeChoices(assetKind, options).map((choice) => choice.value).join(' · ');
}

// Longest alias first: "fuel filter" must beat "fuel", "oil change" must beat "oil".
const ALIAS_INDEX = (() => {
  const entries = [];
  for (const type of EXPENSE_TYPES) {
    for (const alias of type.aliases) entries.push({ alias: alias.toLowerCase(), value: type.value });
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return entries;
})();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALIAS_MATCHERS = ALIAS_INDEX.map((entry) => ({
  ...entry,
  re: new RegExp(`(?:^|[^a-z0-9])${escapeRegex(entry.alias)}(?:[^a-z0-9]|$)`, 'i')
}));

/** Free text → canonical expense type (longest alias wins). Null when unknown. */
export function resolveExpenseType(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  const exact = EXPENSE_TYPES.find((type) => type.value.toLowerCase() === lower);
  if (exact) return exact.value;
  if (EXPENSE_CATEGORIES[lower]) {
    const byCategory = EXPENSE_TYPES.find((type) => type.category === lower);
    if (byCategory) return byCategory.value;
  }
  for (const matcher of ALIAS_MATCHERS) {
    if (matcher.re.test(clean)) return matcher.value;
  }
  return null;
}

/** Write-time normaliser: never returns null (falls back to Other). */
export function normalizeExpenseType(value, { fallback = 'Other' } = {}) {
  return resolveExpenseType(value) || fallback;
}

/** Does this text name any known expense type? (quick-path marker) */
export function hasExpenseTypeMarker(text) {
  return resolveExpenseType(text) !== null;
}

/** Canonical type → report category key. */
export function expenseCategoryOf(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (EXPENSE_CATEGORIES[clean]) return clean;
  const resolved = resolveExpenseType(value);
  if (resolved) {
    const type = EXPENSE_TYPES.find((entry) => entry.value === resolved);
    if (type) return type.category;
  }
  return 'other';
}

export function expenseCategoryLabel(category) {
  return EXPENSE_CATEGORIES[category]?.label || EXPENSE_CATEGORIES.other.label;
}

export function expenseCategoryBadge(category) {
  return EXPENSE_CATEGORIES[category]?.badge || EXPENSE_CATEGORIES.other.badge;
}

export function expenseCategoryTone(category) {
  return EXPENSE_CATEGORIES[category]?.tone || EXPENSE_CATEGORIES.other.tone;
}

/** Types that apply to an asset kind (used by tests and bespoke menus). */
export function expenseTypesForAssetKind(assetKind = 'vehicle') {
  const kind = normalizeKind(assetKind);
  return EXPENSE_TYPES.filter((type) => type.kinds.includes(kind)).map((type) => type.value);
}

/* ============================================================
 * v1.93.0 (Phase 30, P2-11) — asset-kind guard
 * ------------------------------------------------------------
 * The quiz menu already filters by `kinds`, but free text (and the CSV
 * import) could still name an expense that cannot exist on the asset
 * ("tyres" on a generator). This is the ONE write-time gate used by the
 * quiz, the quick-log lane and the CSV import: it refuses the write with
 * warm copy that always names a valid alternative, and `Other` stays the
 * honest escape hatch.
 * ============================================================ */

/** Human plural for warm refusal copy (never shame, rule 31). */
const KIND_PLURALS = Object.freeze({
  vehicle: 'Cars',
  motorcycle: 'Motorcycles',
  truck: 'Trucks',
  bus: 'Buses',
  heavy_equipment: 'Heavy equipment',
  machinery: 'Machines',
  generator: 'Generators',
  watercraft: 'Boats'
});

/**
 * Curated, deterministic nearest alternative per type x kind. A curated pair
 * is only a preference — the validator always answers with a type that is on
 * the kind's own menu.
 */
const KIND_TYPE_ALTERNATIVES = Object.freeze({
  Tyres: { heavy_equipment: 'Parts', machinery: 'Parts', generator: 'Consumables', watercraft: 'Parts' },
  Charging: { heavy_equipment: 'Fuel', machinery: 'Fuel', generator: 'Fuel', watercraft: 'Fuel' },
  'Mooring & Berthing': { vehicle: 'Parking', motorcycle: 'Parking', truck: 'Parking', bus: 'Parking', heavy_equipment: 'Hire & Rental', machinery: 'Hire & Rental', generator: 'Hire & Rental' },
  Weighbridge: { vehicle: 'Other', motorcycle: 'Other', bus: 'Other', heavy_equipment: 'Other', machinery: 'Other', generator: 'Other', watercraft: 'Other' },
  'Route & Stage Fees': { vehicle: 'Parking', heavy_equipment: 'Loading & Offloading', machinery: 'Loading & Offloading', generator: 'Other', watercraft: 'Loading & Offloading' },
  'Loading & Offloading': { vehicle: 'Other', motorcycle: 'Other' },
  'Crew Wages': { vehicle: 'Other', motorcycle: 'Other', truck: 'Other', bus: 'Other' },
  Consumables: { vehicle: 'Parts', motorcycle: 'Parts', truck: 'Parts', bus: 'Parts' }
});

/** Plural noun for an asset kind, used in warm copy. Never empty. */
export function expenseKindNoun(assetKind = 'vehicle') {
  return KIND_PLURALS[normalizeKind(assetKind)] || KIND_PLURALS.vehicle;
}

/**
 * A valid replacement type for a refused one: curated pair first, then a
 * same-category sibling on the kind's menu, then the kind's first menu type.
 * Never null — every asset kind has a menu with at least `Other`.
 */
export function nearestKindType(expenseType, assetKind = 'vehicle') {
  const kind = normalizeKind(assetKind);
  const resolved = resolveExpenseType(expenseType) || String(expenseType || '').trim();
  const type = EXPENSE_TYPES.find((entry) => entry.value === resolved) || null;
  const curated = type ? KIND_TYPE_ALTERNATIVES[type.value]?.[kind] : null;
  if (curated) return curated;
  const sameCategory = type
    ? EXPENSE_TYPES.find((entry) => entry.kinds.includes(kind)
      && entry.category === type.category
      && entry.value !== type.value
      && entry.value !== 'Other')
    : null;
  if (sameCategory) return sameCategory.value;
  return expenseTypeChoices(kind)[0]?.value || 'Other';
}

/**
 * Does this expense type exist for this asset kind?
 * `Other` and unknown free text are always allowed (the caller decides what
 * unknown text means); a mismatch returns the warm engine-owned copy plus the
 * suggested valid type. Pure, never throws.
 */
export function validateExpenseTypeForAssetKind(expenseType, assetKind = 'vehicle') {
  const kind = normalizeKind(assetKind);
  const resolved = resolveExpenseType(expenseType);
  if (!resolved || resolved === 'Other') return { ok: true, type: resolved || 'Other', kind };
  const type = EXPENSE_TYPES.find((entry) => entry.value === resolved) || null;
  if (!type) return { ok: true, type: resolved, kind };
  if (type.kinds.includes(kind)) return { ok: true, type: resolved, kind };
  const suggestion = nearestKindType(resolved, kind);
  const message = `${expenseKindNoun(kind)} don't have ${resolved.toLowerCase()} — did you mean ${suggestion}? Reply *${suggestion}* or pick another type.`;
  return { ok: false, type: resolved, kind, suggestion, message };
}

/* ============================================================
 * Odometer / hour-meter policy (v1.39.0)
 * ------------------------------------------------------------
 * Research-backed reading tiers (see SAKA_FLEET_ARCHITECTURE.md §85):
 *   'fuel'     — Fuel: REQUIRED on full-tank fills (the reading anchors the
 *                brim-to-brim km/L segment); optional on top-ups.
 *   'optional' — Service events (Maintenance/Parts/Tyres/Repairs/Charging/
 *                Consumables): asked with a Skip escape, because distance or
 *                hour based service intervals want the reading but a skipped
 *                one never blocks the log.
 *   'never'    — Parking, tolls, fines, washing, insurance, accessories,
 *                subscriptions, towing, wages, mooring, bodywork, other:
 *                the reading adds no signal — asking is pure friction.
 * Hours-led assets (heavy equipment, machinery, generators, watercraft)
 * substitute the ENGINE HOURS meter wherever a reading is collected.
 * ============================================================ */

export const ODOMETER_MODES = Object.freeze(['fuel', 'optional', 'never']);

/** Canonical odometer mode for an expense type (falls back to 'never'). */
export function odometerModeForType(expenseType) {
  const resolved = resolveExpenseType(expenseType) || String(expenseType || '').trim();
  const type = EXPENSE_TYPES.find((entry) => entry.value === resolved);
  return ODOMETER_MODES.includes(type?.odometerMode) ? type.odometerMode : 'never';
}

/** Road assets read kilometres; machines/generators/boats read engine hours. */
export function isHoursLedKind(assetKind) {
  return HOURS_KINDS.includes(normalizeKind(assetKind));
}

/** A fill answer counts as a full tank when the user said full/brim. */
export function isFullFillAnswer(fillType) {
  return /full|brim/i.test(String(fillType || ''));
}


export default {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_TYPES,
  expenseTypeChoices,
  expenseTypeMenu,
  resolveExpenseType,
  normalizeExpenseType,
  hasExpenseTypeMarker,
  expenseCategoryOf,
  expenseCategoryLabel,
  expenseCategoryBadge,
  expenseCategoryTone,
  expenseTypesForAssetKind,
  expenseKindNoun,
  nearestKindType,
  validateExpenseTypeForAssetKind
};
