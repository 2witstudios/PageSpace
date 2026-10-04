/**
 * error-cause — the `.cause` chain of a thrown error, for logs (pk862snl).
 *
 * Drizzle wraps every driver failure in its own "Failed query: …" error and puts the real one
 * (the pg error, with its SQLSTATE `code`) on `.cause`. A log that keeps only the outer message
 * makes a Postgres "too many clients" FATAL look exactly like a dropped settle. The logger walks
 * this chain for every Error it is handed, so a catch that passes the Error object keeps it.
 *
 * Pure: no I/O, no clock.
 */

import { scrubPII } from '../compliance/pii-scrubber';

export interface ErrorCauseLink {
  name: string;
  message: string;
  /** A driver's error code when it has one — Postgres' SQLSTATE (e.g. '53300'). */
  code?: string;
}

const MAX_CAUSE_DEPTH = 5;

/** The causes under `error`, outermost first (the error itself excluded); [] when there are none. */
export function errorCauseChain(error: unknown, maxDepth = MAX_CAUSE_DEPTH): ErrorCauseLink[] {
  const chain: ErrorCauseLink[] = [];
  const seen = new Set<unknown>([error]);
  let cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  while (cause !== undefined && cause !== null && chain.length < maxDepth && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof Error) {
      const code = (cause as { code?: unknown }).code;
      chain.push({ name: cause.name, message: cause.message, ...(typeof code === 'string' ? { code } : {}) });
      cause = (cause as { cause?: unknown }).cause;
    } else {
      chain.push({ name: 'NonError', message: String(cause) });
      break;
    }
  }
  return chain;
}

/** The chain as "Caused by: name: message [code]" lines, to append to a stack. '' for no chain. */
export function formatCauseChain(chain: readonly ErrorCauseLink[]): string {
  return chain.map((link) => `Caused by: ${link.name}: ${link.message}${link.code ? ` [${link.code}]` : ''}`).join('\n');
}

/**
 * The metadata a catch logs for `error` at any level (warn and debug take no Error argument):
 * the message under the `error` key every caller already used, plus the cause chain when there is
 * one, messages PII-scrubbed as the logger scrubs an Error's own.
 */
export function errorLogFields(error: unknown): { error: string; cause?: ErrorCauseLink[] } {
  const message = error instanceof Error ? error.message : String(error);
  const cause = errorCauseChain(error).map((link) => ({ ...link, message: scrubPII(link.message) ?? '[scrub_failed]' }));
  return { error: scrubPII(message) ?? '[scrub_failed]', ...(cause.length > 0 ? { cause } : {}) };
}
