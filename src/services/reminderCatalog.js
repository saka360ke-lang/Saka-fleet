/**
 * Saka Fleet — Reminder Catalog (v1.31.0)
 * --------------------------------------
 * One deterministic registry for every maintenance / compliance reminder Saka
 * accepts, across all eight asset kinds. The category layer stays
 * `EXPIRY_CATEGORIES` (maintenanceReminders.js); this module adds the concrete
 * reminder TYPES (oil change, filters, brakes, hydraulic service, hull service,
 * PSL, speed limiter…) with aliases, the meter they use and an asset-kind menu.
 */

import { EXPIRY_CATEGORIES, detectExpiryCategory } from './maintenanceReminders.js';

const ALL_KINDS = Object.freeze(['vehicle', 'motorcycle', 'truck', 'bus', 'heavy_equipment', 'machinery', 'generator', 'watercraft']);
const ROAD_KINDS = Object.freeze(['vehicle', 'motorcycle', 'truck', 'bus']);
const HOURS_KINDS = Object.freeze(['heavy_equipment', 'machinery', 'generator', 'watercraft']);

/** Reminder types: value, category, aliases, applicable kinds, meter, menu flag. */
export const REMINDER_TYPES = Object.freeze([
  {
    value: 'Oil change', category: 'maintenance', kinds: ROAD_KINDS, meter: 'distance', menu: true,
    aliases: ['oil change', 'engine oil change', 'engine oil', 'oil', 'oil service']
  },
  {
    value: 'Service', category: 'maintenance', kinds: ALL_KINDS, meter: 'any', menu: true,
    aliases: ['service', 'servicing', 'maintenance', 'tune up', 'tune-up', 'checkup', 'check up', 'check-up']
  },
  {
    value: 'Fuel filter', category: 'maintenance', kinds: ROAD_KINDS, meter: 'distance', menu: false,
    aliases: ['fuel filter', 'diesel filter', 'petrol filter']
  },
  {
    value: 'Air filter', category: 'maintenance', kinds: ROAD_KINDS, meter: 'distance', menu: false,
    aliases: ['air filter', 'air cleaner']
  },
  {
    value: 'Brake pads', category: 'maintenance', kinds: ROAD_KINDS, meter: 'distance', menu: false,
    aliases: ['brake pads', 'brake pad', 'brake service', 'brakes']
  },
  {
    value: 'Tyres', category: 'maintenance', kinds: ROAD_KINDS, meter: 'distance', menu: false,
    aliases: ['tyre change', 'tyre rotation', 'tyre replacement', 'tire change', 'tire rotation', 'tyres', 'tires', 'puncture repair', 'wheel alignment']
  },
  {
    value: 'Battery', category: 'maintenance', kinds: ALL_KINDS, meter: 'date', menu: false,
    aliases: ['battery replacement', 'battery change', 'battery check']
  },
  {
    value: 'Timing belt', category: 'maintenance', kinds: ROAD_KINDS, meter: 'distance', menu: false,
    aliases: ['timing belt', 'cam belt']
  },
  {
    value: 'Hydraulic service', category: 'maintenance', kinds: HOURS_KINDS, meter: 'hours', menu: true,
    aliases: ['hydraulic service', 'hydraulic oil change', 'hydraulic oil', 'hydraulic filter', 'hydraulics']
  },
  {
    value: 'Undercarriage', category: 'maintenance', kinds: ['heavy_equipment', 'machinery'], meter: 'hours', menu: false,
    aliases: ['undercarriage', 'track tension', 'track service', 'tracks']
  },
  {
    value: 'Generator service', category: 'maintenance', kinds: ['generator'], meter: 'hours', menu: true,
    aliases: ['generator service', 'genset service', 'generator maintenance']
  },
  {
    value: 'Hull service', category: 'maintenance', kinds: ['watercraft'], meter: 'date', menu: true,
    aliases: ['hull service', 'hull cleaning', 'anti fouling', 'antifouling']
  },
  {
    value: 'Engine service', category: 'maintenance', kinds: HOURS_KINDS, meter: 'hours', menu: true,
    aliases: ['engine service', 'engine overhaul', 'engine hours service']
  },
  {
    value: 'Insurance Renewal', category: 'insurance', kinds: ALL_KINDS, meter: 'date', menu: true,
    aliases: ['insurance renewal', 'insurance', 'insure', 'policy renewal', 'cover note']
  },
  {
    value: 'Inspection', category: 'inspection', kinds: ALL_KINDS, meter: 'date', menu: true,
    aliases: ['inspection', 'mot', 'ntac', 'ntsa', 'roadworthiness', 'road worthy', 'safety check', 'tasjeel', 'tuv inspection', 'itv', 'apk', 'shaken', 'puspakom']
  },
  {
    value: 'Road License', category: 'licensing', kinds: ROAD_KINDS, meter: 'date', menu: true,
    aliases: ['road license', 'road licence', 'road tax', 'vehicle licence', 'vehicle license', 'registration renewal', 'rego', 'licence disc']
  },
  {
    value: 'Road Service Licence', category: 'licensing', kinds: ROAD_KINDS, meter: 'date', menu: false,
    aliases: ['road service licence', 'road service license', 'psl', 'public service vehicle licence', 'public service vehicle license']
  },
  {
    value: 'Driver License', category: 'driver_license', kinds: ALL_KINDS, meter: 'date', menu: true,
    aliases: ['driver license', 'driver licence', 'drivers license', 'drivers licence', 'driving license', 'driving licence', 'dl renewal']
  },
  {
    value: 'Permit', category: 'permit', kinds: ALL_KINDS, meter: 'date', menu: true,
    aliases: ['permit', 'transport permit', 'operator permit', 'route permit', 'special permit', 'speed limiter', 'speed governor']
  },
  {
    value: 'Deadline', category: 'deadline', kinds: ALL_KINDS, meter: 'date', menu: false,
    aliases: ['deadline']
  },
  {
    value: 'Other', category: 'other', kinds: ALL_KINDS, meter: 'any', menu: true,
    aliases: ['other']
  }
]);

export const REMINDER_TYPE_VALUES = Object.freeze(REMINDER_TYPES.map((type) => type.value));

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

/** Reminder menu for an asset kind (max 8, always with an Other escape). */
export function reminderTypeChoices(assetKind = 'vehicle') {
  const kind = normalizeKind(assetKind);
  const other = REMINDER_TYPES.find((type) => type.value === 'Other');
  const menu = REMINDER_TYPES
    .filter((type) => type.menu && type.value !== 'Other' && type.kinds.includes(kind))
    .slice(0, 7);
  if (other && other.kinds.includes(kind)) menu.push(other);
  return menu.map((type) => ({ value: type.value, aliases: [...type.aliases] }));
}

export function reminderTypeMenu(assetKind = 'vehicle') {
  return reminderTypeChoices(assetKind).map((choice) => choice.value).join(' · ');
}

// Longest alias first: "fuel filter" beats "oil", "hydraulic service" beats "service".
const ALIAS_MATCHERS = (() => {
  const entries = [];
  for (const type of REMINDER_TYPES) {
    for (const alias of type.aliases) entries.push({ alias: alias.toLowerCase(), value: type.value });
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return entries.map((entry) => ({
    ...entry,
    re: new RegExp(`(?:^|[^a-z0-9])${entry.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i')
  }));
})();

/** Free text → canonical reminder type (longest alias wins). Null when unknown. */
export function resolveReminderType(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const exact = REMINDER_TYPES.find((type) => type.value.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.value;
  for (const matcher of ALIAS_MATCHERS) {
    if (matcher.re.test(clean)) return matcher.value;
  }
  return null;
}

export function normalizeReminderType(value, { fallback = null } = {}) {
  return resolveReminderType(value) || fallback;
}

export function hasReminderTypeMarker(text) {
  return resolveReminderType(text) !== null;
}

/** Canonical reminder type → compliance category (catalog first, aliases second). */
export function reminderCategoryOf(value) {
  const resolved = resolveReminderType(value);
  if (!resolved) return null;
  const type = REMINDER_TYPES.find((entry) => entry.value === resolved);
  if (type?.category && EXPIRY_CATEGORIES[type.category]) return type.category;
  return detectExpiryCategory(resolved, 'other');
}

/** Meter the reminder type typically uses (distance, hours, date, any). */
export function reminderMeterOf(value) {
  const resolved = resolveReminderType(value);
  return REMINDER_TYPES.find((entry) => entry.value === resolved)?.meter || 'any';
}

export function reminderTypesForAssetKind(assetKind = 'vehicle') {
  const kind = normalizeKind(assetKind);
  return REMINDER_TYPES.filter((type) => type.kinds.includes(kind)).map((type) => type.value);
}

export default {
  REMINDER_TYPES,
  REMINDER_TYPE_VALUES,
  reminderTypeChoices,
  reminderTypeMenu,
  resolveReminderType,
  normalizeReminderType,
  hasReminderTypeMarker,
  reminderCategoryOf,
  reminderMeterOf,
  reminderTypesForAssetKind
};
