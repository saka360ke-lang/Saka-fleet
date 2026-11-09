/**
 * Saka Fleet — the ONE global Fastify error handler (v1.90.0, Phase 28B)
 * ----------------------------------------------------------------------
 * The pre-1.90.0 handler echoed `error.message` straight to the caller. Stack
 * traces never leaked, but internal database/provider text did (column names,
 * constraint text, provider errors). The client now receives ONE plain line;
 * the full error keeps flowing to `fastify.log` and `error_logs` untouched, so
 * debugging never loses detail (rule 50: the failure is reported, not hidden).
 *
 * `error.name` is preserved for callers that branch on it (e.g. ValidationError)
 * and `error.statusCode` is preserved for 4xx paths raised by Fastify itself.
 */

export const GENERIC_ERROR_MESSAGE = 'Something went wrong on our side. Please try again in a moment.';

/**
 * Build the handler with its two existing collaborators injected so a suite can
 * prove the logging path without booting the server or the database.
 */
export function buildErrorHandler({ supabase, log = console, logSystemError } = {}) {
  if (typeof logSystemError !== 'function') throw new Error('buildErrorHandler requires logSystemError');
  return async function sakaErrorHandler(error, request, reply) {
    log.error(error);
    const route = request?.raw?.url || request?.routerPath || request?.url || 'unknown';
    await logSystemError(supabase, error, route);
    return reply.status(error?.statusCode || 500).send({
      error: error?.name || 'InternalServerError',
      message: GENERIC_ERROR_MESSAGE
    });
  };
}

export default { buildErrorHandler, GENERIC_ERROR_MESSAGE };
