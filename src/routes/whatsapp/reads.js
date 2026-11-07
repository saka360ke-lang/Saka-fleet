/**
 * Saka Fleet - WhatsApp read dispatch (Phase 5B-3 of the whatsapp.js split, v1.68.0).
 * -----------------------------------------------------------------------------------
 * The one call site of the Phase 3 read registry (`src/services/readCommands.js`):
 * the processor builds the shared `readCtx` snapshot, this module dispatches it and
 * returns the claimed lane's complete `aiResult` (or null when no lane claims the turn).
 *
 * BOUNDARY CONTRACT (section 190): reads.js is a leaf route module. It may import from
 * src/services/* but NEVER from ./messages.js. It takes state as arguments and returns
 * data; the one sanctioned mutation is the quiz park - `abandonQuiz()` from the quiz
 * engine service runs BEFORE `render()` exactly as it did inline (the lane's render ctx
 * carries the session, so the abandoned draft must be gone first).
 *
 * The processor keeps: the readCtx build (one shared parse), the post-hoc
 * `readCtx.recordSpec` fix, the receipt-delete write lane, the fast-quiz regex lane and
 * the AI fallback - none of them belong to the registry contract.
 */

import { resolveReadCommand } from '../../services/readCommands.js';
import { abandonQuiz } from '../../services/quizEngine.js';

/**
 * Dispatch one turn through the read command registry.
 *
 * @param {object} args
 * @param {string} args.commandText  trimmed message text (the registry's input)
 * @param {object} args.readCtx      the processor's one-per-turn read snapshot
 * @param {boolean} args.quizForFastPath  an active quiz owns the turn
 * @param {boolean} args.quizPhaseLocked  a PIN/account-OTP phase is locked
 * @param {object} args.session      live session (park mutation target)
 * @returns {Promise<object|null>}   the complete aiResult, or null when no lane claims
 */
export async function dispatchReadTurn({ commandText, readCtx, quizForFastPath, quizPhaseLocked, session }) {
  const readLane = resolveReadCommand(commandText, readCtx);
  if (!readLane) return null;
  if (readLane.parksNow && quizForFastPath && !quizPhaseLocked) {
    abandonQuiz(session, { reason: readLane.abandonReason });
  }
  return await readLane.render(readCtx);
}
