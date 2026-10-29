import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Saka Fleet - Read-Only Log, Chat & Schema Audit (v1.8)
 * -------------------------------------------------------
 * Cross-references Superadmin Cloud Run alerts with system logs, webhooks,
 * chat records and reminder/vehicle schema so false-positive noise and real
 * regressions are separated quickly.
 *
 * READ-ONLY: this script only issues SELECT queries. It never writes, updates
 * or deletes data, so it is safe to run against production at any time.
 *
 * Usage:
 *   node scripts/audit_logs.js
 *   node scripts/audit_logs.js --json     # machine-readable output
 */

const LIMIT = Number(process.env.AUDIT_LIMIT || 25);

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
  return createClient(url, key);
}

const supabase = getClient();

async function readTable(table, columns = '*', { order = 'created_at', limit = LIMIT } = {}) {
  try {
    let query = supabase.from(table).select(columns);
    if (order) query = query.order(order, { ascending: false });
    if (limit) query = query.limit(limit);
    const { data, error } = await query;
    if (error) return { table, ok: false, error: error.message, rows: [] };
    return { table, ok: true, rows: data || [] };
  } catch (err) {
    return { table, ok: false, error: err.message, rows: [] };
  }
}

function countMatches(rows, predicate) {
  return (rows || []).filter(predicate).length;
}

async function main() {
  const asJson = process.argv.includes('--json');

  const [errors, friction, analytics, transcripts, sessions, reminders, vehicles, profiles] = await Promise.all([
    readTable('error_logs', 'id,error_message,route,status,created_at', { limit: LIMIT }),
    readTable('chat_friction_logs', 'friction_type,transcript_snippet,user_phone,detected_at', { order: 'detected_at', limit: LIMIT }),
    readTable('conversation_analytics', 'id,period_start,period_end,insights,created_at', { limit: 5 }),
    readTable('chat_transcripts', 'phone_number,sender,message_text,created_at', { limit: 10 }),
    readTable('chat_sessions', 'phone_number,state,updated_at', { order: 'updated_at', limit: 10 }),
    readTable('reminders', '*', { limit: 50 }),
    readTable('vehicles', 'id,plate_number,current_mileage,odometer_reading,operating_hours,unit_system,status', { order: 'created_at', limit: 50 }),
    readTable('profiles', 'id,phone_number,unit_system,subscription_tier,is_active', { order: 'created_at', limit: 25 })
  ]);

  const frictionTypes = {};
  for (const row of friction.rows) {
    const key = row.friction_type || 'UNKNOWN';
    frictionTypes[key] = (frictionTypes[key] || 0) + 1;
  }

  const cloudRunFalsePositives = countMatches(friction.rows, (r) =>
    String(r.friction_type) === 'SYSTEM_ERROR' &&
    /Severity:\s*(INFO|NOTICE|DEBUG)/i.test(String(r.transcript_snippet || '')) &&
    /Status:\s*[123]\d\d/i.test(String(r.transcript_snippet || ''))
  );

  const emptyErrorPayloads = countMatches(errors.rows, (r) =>
    ['{}', '', 'undefined', 'null'].includes(String(r.error_message || '').trim())
  );

  const structuredReminders = countMatches(reminders.rows, (r) =>
    ['distance', 'hours'].includes(String(r.threshold_unit || '').toLowerCase())
  );

  const legacyTextReminders = countMatches(reminders.rows, (r) =>
    !['distance', 'hours', 'date'].includes(String(r.threshold_unit || '').toLowerCase()) &&
    /\b(km|miles?|hours?)\b/i.test(String(r.reminder_type || ''))
  );

  const hoursTracked = countMatches(vehicles.rows, (v) => Number(v.operating_hours || 0) > 0);
  const imperialVehicles = countMatches(vehicles.rows, (v) => String(v.unit_system || '').toLowerCase() === 'imperial');

  const recommendations = [];
  if (emptyErrorPayloads > 0) {
    recommendations.push('error_logs contains empty "{}" payloads: verify the Cloud Run INFO/200 benign filter (v1.8 scanCloudRunAnomalies).');
  }
  if (cloudRunFalsePositives > 0) {
    recommendations.push('chat_friction_logs shows INFO/2xx Cloud Run entries logged as SYSTEM_ERROR: redeploy with the v1.8 benign-filter fix.');
  }
  if (legacyTextReminders > 0) {
    recommendations.push('Reminders exist with thresholds only in reminder_type text: recreate them through set_reminder so remaining km/mi/hours are tracked.');
  }
  if (reminders.rows.length > 0 && structuredReminders === 0) {
    recommendations.push('No structured threshold reminders yet: ensure the v1.8 reminder columns exist and create a reminder via WhatsApp.');
  }
  if (vehicles.rows.length > 0 && hoursTracked === 0) {
    recommendations.push('No vehicle has operating hours recorded: operating-hour reminders cannot fire until readings are logged.');
  }
  if (recommendations.length === 0) {
    recommendations.push('No anomalies detected in the sampled window.');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: { rowsPerTable: LIMIT },
    tables: {
      error_logs: { ok: errors.ok, error: errors.error, sampled: errors.rows.length, emptyPayloads: emptyErrorPayloads },
      chat_friction_logs: { ok: friction.ok, error: friction.error, sampled: friction.rows.length, types: frictionTypes, cloudRunFalsePositives },
      conversation_analytics: { ok: analytics.ok, error: analytics.error, sampled: analytics.rows.length },
      chat_transcripts: { ok: transcripts.ok, error: transcripts.error, sampled: transcripts.rows.length },
      chat_sessions: { ok: sessions.ok, error: sessions.error, sampled: sessions.rows.length },
      reminders: { ok: reminders.ok, error: reminders.error, sampled: reminders.rows.length, structured: structuredReminders, legacyTextOnly: legacyTextReminders },
      vehicles: { ok: vehicles.ok, error: vehicles.error, sampled: vehicles.rows.length, withOperatingHours: hoursTracked, imperial: imperialVehicles },
      profiles: { ok: profiles.ok, error: profiles.error, sampled: profiles.rows.length }
    },
    recent: {
      errors: errors.rows,
      friction: friction.rows,
      sessions: sessions.rows
    },
    recommendations
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== Saka Fleet Log & Chat Audit (read-only) ===');
  console.log(`Generated: ${report.generatedAt}`);
  for (const [name, info] of Object.entries(report.tables)) {
    const status = info.ok ? `ok (sampled ${info.sampled})` : `ERROR: ${info.error}`;
    const extra = [];
    if (name === 'error_logs' && info.emptyPayloads) extra.push(`empty payloads: ${info.emptyPayloads}`);
    if (name === 'chat_friction_logs' && info.cloudRunFalsePositives) extra.push(`INFO/2xx false positives: ${info.cloudRunFalsePositives}`);
    if (name === 'chat_friction_logs' && Object.keys(info.types || {}).length) extra.push(`types: ${JSON.stringify(info.types)}`);
    if (name === 'reminders') extra.push(`structured: ${info.structured}, legacy text-only: ${info.legacyTextOnly}`);
    if (name === 'vehicles') extra.push(`with hours: ${info.withOperatingHours}, imperial: ${info.imperial}`);
    console.log(`- ${name}: ${status}${extra.length ? ` | ${extra.join(' | ')}` : ''}`);
  }
  console.log('\nRecommendations:');
  for (const rec of report.recommendations) console.log(`  * ${rec}`);
  console.log('');
}

main().catch((err) => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});

