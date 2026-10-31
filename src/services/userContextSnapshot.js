import { getTierLabel } from './subscriptionTiers.js';

/**
 * Saka Fleet — User Context Snapshot (v1.27.0).
 *
 * Builds the REALTIME facts about ONE user that Saka needs to answer any
 * question about their own data: plan state, vehicles, this month's spending,
 * upcoming reminders. Every number is computed here — the model never does
 * arithmetic on money, dates or distances.
 *
 * Contract: never throws. A missing table or a failed query simply removes that
 * fact line; the reply is composed from whatever is available.
 */

const MAX_VEHICLES = 8;
const MAX_REMINDERS = 4;

function money(amount, currency) {
  const value = Number(amount) || 0;
  return `${currency || 'USD'} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function number(value) {
  return (Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function monthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function daysUntil(dateLike, now = new Date()) {
  const due = new Date(dateLike);
  if (Number.isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

function vehicleLabel(vehicle) {
  const parts = [vehicle.make_model, vehicle.plate_number].filter(Boolean);
  const mileage = Number(vehicle.current_mileage || 0);
  const mileageText = mileage > 0 ? `${number(mileage)} km` : null;
  const fuel = vehicle.fuel_type ? String(vehicle.fuel_type) : null;
  return [parts.join(' · ') || 'vehicle', mileageText, fuel].filter(Boolean).join(', ');
}

/**
 * @returns {Promise<{lines: string[], data: object}>}
 */
export async function buildUserContextSnapshot({ supabase, profile = null, vehicles = [], currency = 'USD', now = new Date() } = {}) {
  const lines = [];
  const data = {
    profileId: profile?.id || null,
    name: profile?.full_name || null,
    vehicles: [],
    month: null,
    reminders: []
  };

  try {
    const name = profile?.full_name && !/^whatsapp user$/i.test(String(profile.full_name))
      ? String(profile.full_name)
      : null;
    if (name) lines.push(`Name: ${name}.`);

    const tierKey = profile?.subscription_tier || 'free';
    const status = profile?.subscription_status || null;
    const trialStarted = profile?.trial_started_at || null;
    lines.push(`Plan: ${getTierLabel(tierKey)}${status ? ` (${String(status).toLowerCase()})` : ''}.`);
    if (trialStarted) lines.push(`Welcome trial started: ${String(trialStarted).slice(0, 10)}.`);

    let roster = Array.isArray(vehicles) ? vehicles.filter(Boolean) : [];
    if (!roster.length && supabase && profile?.id) {
      const { data: rows } = await supabase
        .from('vehicles')
        .select('id,plate_number,make_model,current_mileage,fuel_type,status,deleted_at')
        .eq('owner_id', profile.id)
        .is('deleted_at', null)
        .limit(MAX_VEHICLES);
      roster = Array.isArray(rows) ? rows : [];
    }
    data.vehicles = roster.map((vehicle) => ({
      id: vehicle.id,
      plate: vehicle.plate_number || null,
      label: vehicleLabel(vehicle),
      mileage: Number(vehicle.current_mileage || 0)
    }));
    if (data.vehicles.length) {
      lines.push(`Vehicles on file (${data.vehicles.length}): ${data.vehicles.map((v) => v.label).join('; ')}.`);
    } else {
      lines.push('Vehicles on file: none yet.');
    }

    const vehicleIds = data.vehicles.map((v) => v.id).filter(Boolean);
    if (supabase && vehicleIds.length) {
      const monthStart = monthStartIso(now);

      try {
        const { data: expenses } = await supabase
          .from('expense_logs')
          .select('amount,fuel_liters,expense_type,created_at,vehicle_id')
          .in('vehicle_id', vehicleIds)
          .gte('created_at', monthStart)
          .limit(500);
        const rows = Array.isArray(expenses) ? expenses : [];
        if (rows.length) {
          const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
          const litres = rows.reduce((sum, row) => sum + (Number(row.fuel_liters) || 0), 0);
          const fuelFills = rows.filter((row) => /fuel|diesel|petrol/i.test(String(row.expense_type || ''))).length;
          data.month = { entries: rows.length, total, litres, fuelFills };
          lines.push(
            `This month so far: ${rows.length} expense entr${rows.length === 1 ? 'y' : 'ies'}, ` +
            `${money(total, currency)} total, ${number(litres)} L of fuel across ${fuelFills} fuel log${fuelFills === 1 ? '' : 's'}.`
          );
        } else {
          lines.push('This month so far: no expenses logged yet.');
        }
      } catch { /* expenses are optional facts */ }

      try {
        const { data: reminders } = await supabase
          .from('reminders')
          .select('reminder_type,due_date,status,vehicle_id')
          .in('vehicle_id', vehicleIds)
          .eq('status', 'active')
          .limit(50);
        const rows = (Array.isArray(reminders) ? reminders : [])
          .filter((row) => row.due_date)
          .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
          .slice(0, MAX_REMINDERS);
        data.reminders = rows.map((row) => ({
          type: row.reminder_type || 'reminder',
          dueDate: row.due_date,
          daysLeft: daysUntil(row.due_date, now)
        }));
        if (data.reminders.length) {
          const text = data.reminders
            .map((r) => `${r.type} due ${String(r.dueDate).slice(0, 10)}${r.daysLeft === null ? '' : r.daysLeft < 0 ? ` (${Math.abs(r.daysLeft)} days overdue)` : ` (in ${r.daysLeft} days)`}`)
            .join('; ');
          lines.push(`Upcoming reminders: ${text}.`);
        } else {
          lines.push('Upcoming reminders: none active.');
        }
      } catch { /* reminders are optional facts */ }
    }
  } catch {
    // Never throw: a partial snapshot is still useful.
  }

  return { lines, data };
}

export default { buildUserContextSnapshot };
