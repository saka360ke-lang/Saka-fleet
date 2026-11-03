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
    reminders: [],
    relationship: null,
    memory: null
  };

  try {
    const name = profile?.full_name && !/^whatsapp user$/i.test(String(profile.full_name))
      ? String(profile.full_name)
      : null;
    if (name) lines.push(`Name: ${name}.`);

    // v1.53.2 — the user's own verification state is their data: answer
    // "is my profile verified?" with a definitive YES + the masked email.
    const email = profile?.email ? String(profile.email).trim() : null;
    const emailVerified = profile?.email_verified === true;
    data.email = email || null;
    data.emailVerified = emailVerified;
    if (email) {
      const masked = email.replace(/^(.{2})[^@]*/, '$1…');
      lines.push(`Email: ${masked} (${emailVerified ? 'verified ✅' : 'NOT verified yet'}).`);
    }

    const tierKey = profile?.subscription_tier || 'free';
    const status = profile?.subscription_status || null;
    const trialStarted = profile?.trial_started_at || null;
    lines.push(`Plan: ${getTierLabel(tierKey)}${status ? ` (${String(status).toLowerCase()})` : ''}.`);
    if (trialStarted) lines.push(`Welcome trial started: ${String(trialStarted).slice(0, 10)}.`);

    let roster = Array.isArray(vehicles) ? vehicles.filter(Boolean) : [];
    if (!roster.length && supabase && profile?.id) {
      const { data: rows } = await supabase
        .from('vehicles')
        .select('id,plate_number,make_model,current_mileage,fuel_type,status,deleted_at,insurance_expiry,inspection_expiry,yom,asset_kind,vin')
        .eq('owner_id', profile.id)
        .is('deleted_at', null)
        .limit(MAX_VEHICLES);
      roster = Array.isArray(rows) ? rows : [];
    }
    data.vehicles = roster.map((vehicle) => ({
      id: vehicle.id,
      plate: vehicle.plate_number || null,
      label: vehicleLabel(vehicle),
      mileage: Number(vehicle.current_mileage || 0),
      insuranceExpiry: vehicle.insurance_expiry || null,
      inspectionExpiry: vehicle.inspection_expiry || null,
      yom: vehicle.yom || null,
      vin: vehicle.vin || null
    }));
    if (data.vehicles.length) {
      lines.push(`Vehicles on file (${data.vehicles.length}): ${data.vehicles.map((v) => v.label).join('; ')}.`);
    } else {
      lines.push('Vehicles on file: none yet.');
    }

    // v1.52.0 — expiry dates, trial end and driver compliance are the user's
    // OWN data and must ride in every snapshot so Saka can always answer
    // "when does my insurance expire?" from the facts — never with a refusal.
    const expiryNotes = [];
    for (const vehicle of data.vehicles) {
      if (vehicle.insuranceExpiry) {
        const days = daysUntil(vehicle.insuranceExpiry, now);
        expiryNotes.push(`${vehicle.plate || vehicle.label} insurance expires ${String(vehicle.insuranceExpiry).slice(0, 10)}${days === null ? '' : days < 0 ? ` (${Math.abs(days)} days overdue)` : ` (in ${days} days)`}`);
      }
      if (vehicle.inspectionExpiry) {
        const days = daysUntil(vehicle.inspectionExpiry, now);
        expiryNotes.push(`${vehicle.plate || vehicle.label} inspection due ${String(vehicle.inspectionExpiry).slice(0, 10)}${days === null ? '' : days < 0 ? ` (${Math.abs(days)} days overdue)` : ` (in ${days} days)`}`);
      }
    }
    if (expiryNotes.length) lines.push(`Expiry dates: ${expiryNotes.join('; ')}.`);

    const trialEnds = profile?.trial_ends_at || null;
    if (trialEnds) {
      const days = daysUntil(trialEnds, now);
      lines.push(`Trial ends: ${String(trialEnds).slice(0, 10)}${days === null ? '' : ` (${Math.max(0, days)} day${days === 1 ? '' : 's'} left)`}.`);
    }

    const complianceType = profile?.compliance_type || null;
    const complianceExpiry = profile?.compliance_expiry || null;
    if (complianceType || complianceExpiry) {
      const days = complianceExpiry ? daysUntil(complianceExpiry, now) : null;
      lines.push(`Your compliance: ${[complianceType, complianceExpiry ? `expires ${String(complianceExpiry).slice(0, 10)}` : null].filter(Boolean).join(' ')}${days === null ? '' : days < 0 ? ` (${Math.abs(days)} days overdue)` : ` (in ${days} days)`}.`);
    }

    // v1.54.0 — ANSWER LAW v2: every commonly-missing field carries its ONE
    // populate step (engine-owned). Saka names the missing field AND the
    // single step to fill it — never an access refusal, never an invented step.
    const populateSteps = [];
    if (!data.vehicles.length) {
      populateSteps.push('vehicle — reply "register vehicle" or send the registration certificate photo');
    } else {
      if (!data.vehicles.some((v) => v.insuranceExpiry)) populateSteps.push('insurance expiry — send the insurance certificate photo, or type "my insurance expires <date>"');
      if (!data.vehicles.some((v) => v.inspectionExpiry)) populateSteps.push('inspection expiry — type "inspection due <date>" or send the inspection certificate photo');
      if (data.vehicles.some((v) => !v.mileage)) populateSteps.push('odometer — type "my odometer is <number> km"');
    }
    if (!complianceType && !complianceExpiry) populateSteps.push('driver licence — type "my licence expires <date>" with the licence number');
    if (!email) populateSteps.push('email — add it to your profile at https://app.sakafleet.com');
    if (populateSteps.length) {
      data.populateSteps = populateSteps.slice(0, 4);
      lines.push(`Missing (each has one fill step): ${data.populateSteps.join(' | ')}.`);
    }

    // v1.28.0 — lightweight per-user memory (no schema change): the details a
    // human assistant would naturally remember about a returning owner.
    const createdAt = profile?.created_at ? Date.parse(profile.created_at) : NaN;
    const ageDays = Number.isFinite(createdAt) ? Math.floor((now.getTime() - createdAt) / 86400000) : null;
    const relationship = ageDays !== null && ageDays >= 30
      ? 'veteran'
      : ageDays !== null && ageDays >= 7
        ? 'regular'
        : data.vehicles.length ? 'newcomer' : 'stranger';
    data.relationship = relationship;
    data.memory = {
      name: data.name,
      language: profile?.preferred_language || null,
      units: profile?.unit_system || null,
      timezone: profile?.timezone || null,
      relationship,
      preferredPlate: data.vehicles[0]?.plate || null
    };
    lines.push(`Relationship: ${relationship}${ageDays === null ? '' : ` (account ${ageDays} day${ageDays === 1 ? '' : 's'} old)`}.`);
    if (data.memory.language) lines.push(`Preferred language: ${data.memory.language}.`);
    if (data.memory.units) lines.push(`Preferred units: ${data.memory.units}.`);
    if (data.memory.timezone) lines.push(`Timezone: ${data.memory.timezone}.`);

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

      // v1.54.0 — ANSWER LAW v2: the recent ledger rides the snapshot so
      // "what did I log yesterday?" is answerable from facts in every
      // composed turn. Bounded (3 rows per side) to keep the prompt lean.
      try {
        const ledgerRows = [];
        const { data: recentExpenses } = await supabase
          .from('expense_logs')
          .select('amount,expense_type,created_at,vehicle_id')
          .in('vehicle_id', vehicleIds)
          .order('created_at', { ascending: false })
          .limit(3);
        const { data: recentEarnings } = await supabase
          .from('private_earnings')
          .select('revenue_amount,earning_type,created_at,vehicle_id')
          .in('vehicle_id', vehicleIds)
          .order('created_at', { ascending: false })
          .limit(3);
        const plateFor = (vehicleId) => data.vehicles.find((v) => v.id === vehicleId)?.plate || null;
        for (const row of (Array.isArray(recentExpenses) ? recentExpenses : [])) {
          const plate = plateFor(row.vehicle_id);
          ledgerRows.push(`${String(row.created_at || '').slice(0, 10)} ${row.expense_type || 'expense'} ${money(row.amount, currency)}${plate ? ` (${plate})` : ''}`);
        }
        for (const row of (Array.isArray(recentEarnings) ? recentEarnings : [])) {
          const plate = plateFor(row.vehicle_id);
          ledgerRows.push(`${String(row.created_at || '').slice(0, 10)} earned ${money(row.revenue_amount, currency)} ${row.earning_type || ''}${plate ? ` (${plate})` : ''}`.trim());
        }
        if (ledgerRows.length) {
          data.ledger = ledgerRows.slice(0, 5);
          lines.push(`Recent logs: ${ledgerRows.slice(0, 5).join('; ')}.`);
        } else {
          data.ledger = [];
          lines.push('Recent logs: none yet.');
        }
      } catch { /* ledger rows are optional facts */ }
    }
  } catch {
    // Never throw: a partial snapshot is still useful.
  }

  return { lines, data };
}

/**
 * v1.54.0 — convenience wrapper: the snapshot rendered as compact composer
 * facts. Capped so data-sensitive composed turns (complaint recovery,
 * friction apology, support escalation) carry the user's own data without
 * blowing the prompt budget. Never throws.
 */
export async function buildUserFactsLines({ supabase, profile = null, vehicles = [], currency = 'USD', maxLines = 10 } = {}) {
  try {
    const snapshot = await buildUserContextSnapshot({ supabase, profile, vehicles, currency });
    const cap = Math.max(1, Math.min(20, Number(maxLines) || 10));
    return snapshot.lines.slice(0, cap).join('\n');
  } catch {
    return '';
  }
}

export default { buildUserContextSnapshot, buildUserFactsLines };
