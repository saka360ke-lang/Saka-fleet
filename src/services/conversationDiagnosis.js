import { chatCompletion, parseJsonSafely } from './aiClient.js';
import { isSentinelProposalsEnabled } from './sentinelPolicy.js';
import { formatNairobiDate } from './dateParser.js';

/**
 * Saka Fleet — Conversational Response-Mismatch Diagnosis (v1.55.1)
 * ------------------------------------------------------------------
 * When Sentinel detects a reply that missed the user's ask, this module asks
 * the reasoning tier to inspect the conversation routing map and produce a
 * root cause + minimal change, then saves it as a PROP-* proposal
 * (PENDING_APPROVAL) for superadmin review — never executed autonomously
 * (rules 16/18). Flag-gated off by default.
 */

const PENDING = 'PENDING_APPROVAL';

// Light defense-in-depth mirror of the remediation forbidden paths. The full
// sanitizeRemediationPlan still gates execution; this just keeps a DIAGNOSIS
// from ever pointing at a protected file.
const DIAGNOSIS_FORBIDDEN = /(^|\/)(\.env|\.clinerules|\.github|supabase)(\/|$)|paystack\.js|transfers\.js|githubDispatch\.js|remediation(\.js|_ci\.js)|run_vin_immutability|reset-db|provision_staging|otp|vin_immutability/i;

export function isConversationDiagnosisEnabled() {
  if (!isSentinelProposalsEnabled()) return false;
  return /^(?:on|true|1)$/i.test(String(process.env.CONVERSATION_DIAGNOSIS_ENABLED || 'off'));
}

// Curated routing map so the diagnosis can cite a real file/function without
// ingesting the whole tree.
const ROUTING_MAP = [
  "src/services/quizEngine.js::detectRegistrationCorrection + applyRegistrationCorrection - a free-text instruction (save as draft) must never be stored as a field value.",
  "src/services/subscriptions.js::getEntitlements - the welcome trial grants solo_pro capacity; never tell a trial user they are limited to the Free 1-vehicle cap.",
  "src/services/quizEngine.js::startQuiz / registerVehicleFromQuiz - never reference a vehicle the user did not supply; only the active vehicle.",
  'src/services/entryAnswers.js::detectLedgerCommand — turns "edit/change/delete/my entries/wrong…" into saved-ledger commands.',
  'src/services/entryAnswers.js::resolveLedgerTurn — single ledger decision point (list/select/edit/delete/cancel).',
  'src/services/quizEngine.js::detectQuizStart — intent → quiz flow; REGISTER_VEHICLE only starts when the user has NO vehicle yet.',
  'src/services/quizEngine.js::detectRegistrationCorrection — "edit <field>: value" / "you read X wrong" (registration only).',
  'src/routes/whatsapp/messages.js::isRegisterCommand — regexes that recognise "register / add car / new vehicle".',
  'src/services/documentLens.js::parseDocumentFields — deterministic OCR field extraction (the Document Lens).',
  'src/services/conversationMemory.js::buildConversationMemory — the unsaved-draft block injected into prompts.'
].join('\n');

const SYSTEM = [
  'You are a Saka Fleet conversation diagnostician. A reply missed what the user asked.',
  'Given the friction transcript and the routing map below, identify WHY the reply missed the ask, the ONE file+function most likely responsible, and the minimal change.',
  'Reply with ONLY JSON: { "root_cause": string, "likely_file": string, "minimal_change": string }.',
  'Rules: cite a real path from the routing map (or a specific src/services file); never recommend touching auth/OTP/VIN/payment/schema/CI/.env; keep minimal_change under 160 chars; never claim certainty you do not have.',
  'ROUTING MAP:',
  ROUTING_MAP
].join('\n');

/** Sanitize the model's diagnosis; invalid/forbidden output returns null. */
export function sanitizeConversationDiagnosis(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const rootCause = String(candidate.root_cause || '').trim().slice(0, 300);
  const likelyFile = String(candidate.likely_file || '').trim().slice(0, 120);
  const minimalChange = String(candidate.minimal_change || '').trim().slice(0, 200);
  if (!rootCause || !minimalChange) return null;
  if (likelyFile && DIAGNOSIS_FORBIDDEN.test(likelyFile)) return null;
  return { rootCause, likelyFile: likelyFile || 'src/routes/whatsapp/messages.js', minimalChange };
}

/** Flag-gated, reasoning-tier diagnosis (read-only; never edits code). */
export async function diagnoseConversationMismatch({ snippet = '', frictionType = 'USER_FRUSTRATION' } = {}) {
  if (!isConversationDiagnosisEnabled()) return null;
  const bounded = String(snippet || '').slice(0, 1200);
  if (!bounded.trim()) return null;
  try {
    const result = await chatCompletion({
      system: SYSTEM,
      messages: [{ role: 'user', content: `Friction type: ${frictionType}\nTranscript:\n${bounded}` }],
      jsonMode: true,
      purpose: 'conversation_diagnosis'
    });
    if (!result.ok || !result.text) return null;
    return sanitizeConversationDiagnosis(parseJsonSafely(result.text));
  } catch {
    return null;
  }
}

/** Mint a PROP- code and save the diagnosis as a PENDING_APPROVAL proposal. */
export async function recordConversationProposal({ supabase, phone = null, frictionType = 'USER_FRUSTRATION', snippet = '', diagnosis = null } = {}) {
  if (!isSentinelProposalsEnabled()) return { ok: false, reason: 'proposals_disabled' };
  if (!supabase || !diagnosis) return { ok: false, reason: 'no-diagnosis' };
  try {
    const today = formatNairobiDate();
    const prefix = `PROP-${today}-`;
    const { data: existing } = await supabase.from('remediation_proposals').select('proposal_code').like('proposal_code', `${prefix}%`);
    const numbers = (existing || [])
      .map((row) => Number(String(row.proposal_code || '').replace(prefix, '')))
      .filter((value) => Number.isFinite(value));
    const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
    const code = `${prefix}${String(next).padStart(2, '0')}`;
    const signature = String(snippet || '').slice(0, 120);
    const { data, error } = await supabase.from('remediation_proposals').insert([{
      proposal_code: code,
      title: diagnosis.rootCause.slice(0, 80),
      category: 'conversation',
      root_cause: diagnosis.rootCause,
      proposed_changes: {
        overview: diagnosis.minimalChange,
        source: 'Sentinel conversation diagnosis',
        author_phone: phone || null,
        likely_file: diagnosis.likelyFile,
        friction_type: frictionType,
        changes: [],
        tests: ['test_agent_training.js'],
        rollback: 'Revert the commit via git revert; no data migrations are involved.'
      },
      target_signature: signature,
      risk_level: 'low',
      status: PENDING,
      feedback: 'Sentinel response-mismatch diagnosis — review and implement in a superadmin chat session.'
    }]).select('proposal_code').maybeSingle();
    if (error) return { ok: false, reason: error.message };
    return { ok: true, code: data?.proposal_code || code };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export default { isConversationDiagnosisEnabled, sanitizeConversationDiagnosis, diagnoseConversationMismatch, recordConversationProposal };