import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Saka Fleet - one-time surgical rectification (v1.57.0).
 * Rule 15: the superadmin is superadmin-only. If a superadmin phone was ever
 * assigned as a driver (and a Fleet Driver profile was minted), cancel the
 * assignment, release any vehicle link, normalise the profile and audit it.
 * Idempotent: safe to run repeatedly.
 *
 * Run: node scripts/rectify_superadmin_driver.js
 */

function normalize(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  return digits ? "+" + digits : "";
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const adminPhone = normalize(process.env.SUPERADMIN_PHONE);
  if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY missing"); process.exit(1); }
  if (!adminPhone) { console.error("SUPERADMIN_PHONE missing"); process.exit(1); }
  const supabase = createClient(url, key);
  const isoNow = new Date().toISOString();
  const summary = { adminPhone, profileId: null, assignmentsCancelled: 0, vehiclesReleased: 0, profileNormalised: false };

  const { data: profile } = await supabase.from("profiles").select("id").eq("phone_number", adminPhone).maybeSingle();
  summary.profileId = profile ? profile.id : null;

  const { data: rows } = await supabase.from("driver_assignments").select("id,status").eq("driver_phone", adminPhone);
  for (const row of rows || []) {
    if (["CANCELLED", "REJECTED", "EXPIRED"].includes(row.status)) continue;
    const { error } = await supabase.from("driver_assignments").update({
      status: "CANCELLED", cancelled_reason: "superadmin_cannot_be_driver", cancelled_at: isoNow
    }).eq("id", row.id);
    if (!error) summary.assignmentsCancelled += 1;
  }

  if (profile && profile.id) {
    const { data: vrows } = await supabase.from("vehicles").select("id").eq("assigned_driver_id", profile.id);
    for (const v of vrows || []) {
      const { error } = await supabase.from("vehicles").update({ assigned_driver_id: null }).eq("id", v.id);
      if (!error) summary.vehiclesReleased += 1;
    }
    const { error: perr } = await supabase.from("profiles").update({ full_name: "Superadmin", driver_profile_pending: false }).eq("id", profile.id);
    summary.profileNormalised = !perr;
  }

  try {
    await supabase.from("admin_audit_logs").insert([{ admin_phone: adminPhone, action: "SUPERADMIN_DRIVER_RECTIFIED", details: summary }]);
  } catch { }

  console.log("RECTIFY " + JSON.stringify(summary));
}

main().then(() => process.exit(0)).catch((e) => { console.error("rectify failed: " + e.message); process.exit(1); });