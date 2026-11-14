/**
 * Saka Fleet — vehicle-write guard (v1.97.8)
 * ------------------------------------------
 * ONE rule for every write that references a vehicle row: a vehicle that no
 * longer exists must never produce a false "Saved", a raw foreign-key error or
 * a dead-end. The write reports `missingVehicle: true`, the engine states that
 * nothing was written, and registration starts (or a single explicit next step
 * is offered where no session is available).
 *
 * Pure module (no DB calls, never throws) so every lane — quiz, quick-log,
 * receipts, reminders, odometer readings — can share it (rule 51).
 */
import { VEHICLE_GONE_COPY } from './flowKnowledge.js';

/** PostgreSQL foreign-key violation code. */
export const FK_VIOLATION_CODE = '23503';

/**
 * True when a PostgREST / pg error means "the vehicle row referenced by this
 * write does not exist". Deliberately narrow: only vehicle-keyed FK failures
 * and vehicle-labelled 23503 errors qualify — a schema-drift or network error
 * must keep its own handling (rule 50).
 */
export function isMissingVehicleError(error) {
  if (!error) return false;
  const code = String(error.code || error.error?.code || '');
  const message = String(
    error.message || error.details || error.hint || error.error?.message || error.error || ''
  );
  if (!message) return false;
  const mentionsVehicle = /vehicle_id|vehicles?_id_fkey|vehicle_id_fkey/i.test(message);
  if (mentionsVehicle && (code === FK_VIOLATION_CODE || /foreign key/i.test(message))) return true;
  if (code === FK_VIOLATION_CODE && /\bvehicle/i.test(message)) return true;
  return false;
}

/** Engine-owned copy for a write whose vehicle is gone (single source). */
export const MISSING_VEHICLE_NOTICE = VEHICLE_GONE_COPY.notice;
export const MISSING_VEHICLE_REGISTER_LEAD = VEHICLE_GONE_COPY.registerLead;
export const MISSING_VEHICLE_NEXT_STEP = VEHICLE_GONE_COPY.nextStep;

/** One-paragraph notice + the single next step (lanes without quiz state). */
export function missingVehicleReply() {
  return `${MISSING_VEHICLE_NOTICE}\n\n${MISSING_VEHICLE_NEXT_STEP}`;
}

export default {
  FK_VIOLATION_CODE,
  isMissingVehicleError,
  MISSING_VEHICLE_NOTICE,
  MISSING_VEHICLE_REGISTER_LEAD,
  MISSING_VEHICLE_NEXT_STEP,
  missingVehicleReply
};
