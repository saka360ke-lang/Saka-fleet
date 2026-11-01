import { hasSqlAccess, runSql } from '../db/sqlRunner.js';

/**
 * Saka Fleet — Earning Catalog (v1.31.0)
 * --------------------------------------
 * Earnings were a bare amount; owners and drivers could not say WHAT the money
 * came from. This registry gives `private_earnings.earning_type` a canonical,
 * alias-resolved vocabulary across road, machine and watercraft work, and keeps
 * every resolver pure (no DB, no AI) except the fail-soft schema ensure.
 */

export const EARNING_TYPES = Object.freeze([
  {
    value: 'Trip fares', menu: true,
    aliases: ['trip fares', 'trip fare', 'fares', 'fare', 'passenger fares', 'passengers', 'matatu', 'boda', 'ride', 'rides', 'taxi']
  },
  {
    value: 'Daily takings', menu: true,
    aliases: ['daily takings', 'takings', 'daily collection', 'daily collections', 'collections', 'daily earnings', 'day earnings', 'today', 'cash collected']
  },
  {
    value: 'Cargo & freight', menu: true,
    aliases: ['cargo and freight', 'cargo & freight', 'cargo', 'freight', 'haulage', 'load', 'loads', 'delivery', 'deliveries']
  },
  {
    value: 'Vehicle hire', menu: true,
    aliases: ['vehicle hire', 'car hire', 'vehicle rental', 'hire', 'rental', 'rent', 'lease', 'leasing']
  },
  {
    value: 'Equipment hire', menu: true,
    aliases: ['equipment hire', 'generator hire', 'machine hire', 'plant hire', 'crane hire', 'equipment rental', 'generator rental', 'machine rental']
  },
  {
    value: 'Contract & charter', menu: true,
    aliases: ['contract and charter', 'contract & charter', 'contract', 'contracts', 'charter', 'tender', 'project', 'school contract']
  },
  {
    value: 'Transport service', menu: true,
    aliases: ['transport service', 'transport', 'shuttle', 'school run', 'staff transport', 'courier']
  },
  {
    value: 'Other', menu: false,
    aliases: ['other', 'misc', 'miscellaneous', 'income', 'revenue', 'earnings', 'earned', 'sundry']
  }
]);

export const EARNING_TYPE_VALUES = Object.freeze(EARNING_TYPES.map((type) => type.value));

/** Quiz menu (max 6 + Other is reachable by free text). */
export function earningTypeChoices() {
  return EARNING_TYPES.filter((type) => type.menu).slice(0, 6).map((type) => ({ value: type.value, aliases: [...type.aliases] }));
}

export function earningTypeMenu() {
  return EARNING_TYPES.map((type) => type.value).join(' · ');
}

// Longest alias first: "equipment hire" beats "hire", "vehicle hire" beats "rental".
const ALIAS_MATCHERS = (() => {
  const entries = [];
  for (const type of EARNING_TYPES) {
    for (const alias of type.aliases) entries.push({ alias: alias.toLowerCase(), value: type.value });
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return entries.map((entry) => ({
    ...entry,
    re: new RegExp(`(?:^|[^a-z0-9])${entry.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i')
  }));
})();

/** Free text → canonical earning type (longest alias wins). Null when unknown. */
export function resolveEarningType(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const exact = EARNING_TYPES.find((type) => type.value.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.value;
  for (const matcher of ALIAS_MATCHERS) {
    if (matcher.re.test(clean)) return matcher.value;
  }
  return null;
}

export function normalizeEarningType(value, { fallback = null } = {}) {
  return resolveEarningType(value) || fallback;
}

export function hasEarningTypeMarker(text) {
  return resolveEarningType(text) !== null;
}

export const EARNING_TYPE_SQL = `
    ALTER TABLE public.private_earnings ADD COLUMN IF NOT EXISTS earning_type text;
    ALTER TABLE public.private_earnings ADD COLUMN IF NOT EXISTS notes text;
    CREATE INDEX IF NOT EXISTS idx_private_earnings_vehicle_type
        ON public.private_earnings(vehicle_id, earning_type);
    -- v1.31.0 — createExpiryReminder writes updated_at; the live table lacked it.
    ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
`;

/** Ensure the earning-type column exists (fail-soft; DDL needs a SQL transport). */
export async function ensureEarningTypeSchema(providedSupabase) {
  if (!providedSupabase) return { ok: false, status: 'no-client' };
  try {
    const { error } = await providedSupabase.from('private_earnings').select('earning_type').limit(1);
    if (!error) return { ok: true, status: 'exists' };
    if (!/earning_type|column/i.test(error.message || '')) return { ok: false, status: 'error', error: error.message };
    if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
    const result = await runSql(EARNING_TYPE_SQL, { label: 'ensureEarningTypeSchema' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

export default {
  EARNING_TYPES,
  EARNING_TYPE_VALUES,
  earningTypeChoices,
  earningTypeMenu,
  resolveEarningType,
  normalizeEarningType,
  hasEarningTypeMarker,
  EARNING_TYPE_SQL,
  ensureEarningTypeSchema
};
