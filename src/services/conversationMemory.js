/**
 * Saka Fleet — Conversation Working Memory (v1.55.0)
 * ---------------------------------------------------
 * Saka's answer to "you can't see what I just told you": the submitted-but-
 * UNSAVED draft (collected quiz answers, extra notes, pending field) is exposed
 * to the AI on conversational turns, not only inside the quiz renderers. Pure
 * and dependency-free so it can be injected anywhere without import cycles.
 * Never surfaces secrets (OTP/PIN/token).
 */

const SECRET_KEYS = new Set(['otp', 'otp_code', 'code', 'pin', 'token', 'qr_passbook_token']);

const FIELD_LABELS = {
  plate_number: 'registration number', vin: 'VIN', make_model: 'make & model',
  yom: 'year of manufacture', year: 'year', fuel_type: 'fuel', color: 'colour',
  current_mileage: 'odometer', odometer: 'odometer', odometer_reading: 'odometer',
  operating_hours: 'operating hours', amount: 'amount', fuel_liters: 'fuel litres',
  liters: 'litres', fill_type: 'fill type', expense_type: 'expense type',
  earning_type: 'earning type', notes: 'notes', vendor: 'vendor', date: 'date',
  insurance_expiry: 'insurance expiry', inspection_expiry: 'inspection expiry',
  insurance_policy: 'insurance policy', compliance_type: 'compliance type',
  compliance_number: 'compliance number', compliance_expiry: 'compliance expiry',
  driver_phone: 'driver phone', owner_email: 'email', full_name: 'name',
  preferred_language: 'language', unit_system: 'units', engine_number: 'engine number',
  transmission: 'transmission', tire_size: 'tire size', purchase_cost: 'purchase cost',
  purchase_date: 'purchase date', vehicle_id: 'vehicle', vehicle: 'vehicle'
};

function labelFor(key) {
  return FIELD_LABELS[key] || String(key).replace(/[_-]+/g, ' ');
}

function renderValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const parts = value.map(renderValue).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    if (value.label != null) return String(value.label);
    if (value.canonicalValue != null) return String(value.canonicalValue);
    try { return JSON.stringify(value); } catch { return null; }
  }
  const text = String(value).trim();
  return text || null;
}

/**
 * Build a compact, secret-free "working memory" block for the model.
 * Returns '' when there is no active draft (zero prompt cost in idle chat).
 */
export function buildConversationMemory({ quiz = null, pendingLabel = null, activeVehicle = null } = {}) {
  if (!quiz) return '';
  const flowLabel = String(quiz.flow || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const lines = [`In-progress ${flowLabel} draft (NOT saved yet):`];

  const answers = (quiz.answers && typeof quiz.answers === 'object') ? quiz.answers : {};
  const collected = [];
  for (const [key, value] of Object.entries(answers)) {
    if (SECRET_KEYS.has(key)) continue;
    const shown = renderValue(value);
    if (shown === null) continue;
    collected.push(`${labelFor(key)}: ${shown.slice(0, 60)}`);
  }
  if (collected.length) lines.push(...collected.map((line) => `- ${line}`));
  else lines.push('- (nothing collected yet)');

  if (pendingLabel) lines.push(`- still needs: ${pendingLabel}`);

  if (Array.isArray(quiz.extraNotes) && quiz.extraNotes.length) {
    lines.push(`- extra notes: ${quiz.extraNotes.map((note) => String(note).slice(0, 60)).join('; ')}`);
  }

  if (activeVehicle?.plate_number) lines.push(`- active vehicle: ${activeVehicle.plate_number}`);

  return lines.join('\n');
}

export default { buildConversationMemory };