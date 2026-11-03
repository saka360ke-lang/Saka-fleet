/**
 * Saka Fleet — current odometer / mileage answers (v1.56.0)
 * ----------------------------------------------------------
 * "What is the current mileage / odometer reading?" must answer from the
 * VEHICLE record (vehicles.current_mileage, or operating hours for hours-led
 * assets), never from the expense ledger. Live 2026-11-03: these questions
 * returned an expense summary or "no odometer on file" while the vehicle had
 * a real reading. Pure + testable.
 */

/** True when the message asks for the CURRENT reading (not a write). */
export function isOdometerQuestion(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  // A write/log command is never the read question.
  if (/^\s*(?:log|logged|record|recorded|add|update|set|change|switch|register)\b/i.test(t)) return false;
  return /\b(?:current|latest|last|what(?:'s|\s+is)?|how\s+many)\b[^.!?]{0,30}\b(?:odo(?:meter)?(?:\s+reading)?|mileage|km(?:\s+reading)?|kilomet(?:er|re)s?)\b/i.test(t);
}

/** Deterministic answer from the vehicle record. */
export function buildOdometerAnswer(vehicle = null) {
  if (!vehicle) return 'No vehicle is registered yet — register one and I will track its odometer.';
  const plate = vehicle.plate_number || 'your vehicle';
  const hoursLed = /^(?:heavy_equipment|machinery|generator|watercraft)$/i.test(String(vehicle.asset_kind || ''));
  const mileage = Number(vehicle.current_mileage || vehicle.odometer_reading || 0);
  const hours = Number(vehicle.operating_hours || 0);
  if (hoursLed) {
    return hours > 0
      ? `🔢 *${plate}* — current meter reading: *${hours.toLocaleString()} h*.`
      : `🔢 *${plate}* has no operating-hours reading on file yet. Send it like: _hours 1,240_.`;
  }
  return mileage > 0
    ? `🔢 *${plate}* — current odometer: *${mileage.toLocaleString()} km*.`
    : `🔢 *${plate}* has no odometer reading on file yet. Send it like: _odometer 367,410 km_.`;
}

export default { isOdometerQuestion, buildOdometerAnswer };