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

const PARAMS_MARKER = '\nparams: ';
const STACK_FRAME = '\n    at ';

/**
 * Drop the bound values from a Drizzle query error's text (review P3-4). DrizzleQueryError's message
 * is `Failed query: <sql>\nparams: <values>`, and a value may be a secret or span lines, so
 * everything from the params marker to the first stack frame (or the end) is replaced: the SQL
 * shape stays, the values never reach a log line. Text without the marker is returned unchanged.
 */
export function redactQueryParams(text: string): string;
export function redactQueryParams(text: string | undefined): string | undefined;
export function redactQueryParams(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const at = text.indexOf(PARAMS_MARKER);
  if (at < 0) return text;
  const frame = text.indexOf(STACK_FRAME, at);
  return `${text.slice(0, at)}${PARAMS_MARKER}[redacted]${frame < 0 ? '' : text.slice(frame)}`;
}

/**
 * SQLSTATE class 22 (data exception) — review 5407898542 P3-1. Postgres quotes the offending VALUE
 * in these messages (`invalid input syntax for type integer: "<value>"`), so for a bound parameter
 * the message IS the parameter. Its message is withheld; the name and SQLSTATE stay, which is what
 * tells a cast failure from an outage.
 */
export function isValueEchoingCode(code: unknown): boolean {
  return typeof code === 'string' && code.startsWith('22');
}

export const VALUE_ECHO_WITHHELD = 'data exception (message withheld: Postgres quotes the offending value)';

/** An error's message as it may be logged: bound params stripped, a class-22 message withheld. */
export function loggableMessage(error: Error): string {
  return isValueEchoingCode((error as { code?: unknown }).code) ? VALUE_ECHO_WITHHELD : redactQueryParams(error.message);
}

/** An error's stack as it may be logged: its message line(s) replaced as {@link loggableMessage} says. */
export function loggableStack(error: Error): string | undefined {
  if (error.stack === undefined) return undefined;
  if (!isValueEchoingCode((error as { code?: unknown }).code)) return redactQueryParams(error.stack);
  const frame = error.stack.indexOf(STACK_FRAME);
  return `${error.name}: ${VALUE_ECHO_WITHHELD}${frame < 0 ? '' : error.stack.slice(frame)}`;
}

/** The causes under `error`, outermost first (the error itself excluded); [] when there are none. */
export function errorCauseChain(error: unknown, maxDepth = MAX_CAUSE_DEPTH): ErrorCauseLink[] {
  const chain: ErrorCauseLink[] = [];
  const seen = new Set<unknown>([error]);
  let cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  while (cause !== undefined && cause !== null && chain.length < maxDepth && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof Error) {
      const code = (cause as { code?: unknown }).code;
      chain.push({ name: cause.name, message: loggableMessage(cause), ...(typeof code === 'string' ? { code } : {}) });
      cause = (cause as { cause?: unknown }).cause;
    } else {
      chain.push({ name: 'NonError', message: redactQueryParams(String(cause)) });
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
 * one, messages PII-scrubbed as the logger scrubs an Error's own, stripped of bound query params, and
 * withheld for a value-echoing SQLSTATE class 22.
 */
export function errorLogFields(error: unknown): { error: string; cause?: ErrorCauseLink[] } {
  const message = error instanceof Error ? loggableMessage(error) : redactQueryParams(String(error));
  const cause = errorCauseChain(error).map((link) => ({ ...link, message: scrubPII(link.message) ?? '[scrub_failed]' }));
  return { error: scrubPII(message) ?? '[scrub_failed]', ...(cause.length > 0 ? { cause } : {}) };
}
