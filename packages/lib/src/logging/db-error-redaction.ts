/**
 * Redact a database error down to fields that can never carry a bound value.
 *
 * drizzle-orm 0.45.2 wraps every driver failure as `DrizzleQueryError`, whose
 * message is `Failed query: ${query}\nparams: ${params}` — the bound
 * parameters, verbatim. The pg error on `.cause` is no safer: a unique
 * violation's `detail` echoes the duplicate key (`Key ("secretHash")=(…)`).
 * So a caught query error that is logged, or rethrown to a framework that logs
 * it, writes whatever the query bound — credential hashes included — into the
 * log. Log `redactDbError(error)` instead: the error class, the SQLSTATE /
 * driver code and the constraint name, each accepted only when it has the
 * shape of an identifier.
 *
 * @module @pagespace/lib/logging/db-error-redaction
 */

// A type alias, not an interface, so it is assignable to the logger's `LogInput` record.
export type RedactedDbError = {
  /** Constructor name of the outermost error (`DrizzleQueryError`, `Error`, …), or `unknown`. */
  errorName: string;
  /** SQLSTATE (`23505`) or driver code (`ECONNREFUSED`) from the error or its cause chain. */
  code: string | null;
  /** Violated constraint name, when the driver reports one. */
  constraint: string | null;
};

const MAX_CAUSE_DEPTH = 5;
const CODE_SHAPE = /^[A-Z0-9_]{1,32}$/;
const CONSTRAINT_SHAPE = /^[A-Za-z0-9_.]{1,128}$/;

function shaped(value: unknown, shape: RegExp): string | null {
  return typeof value === 'string' && shape.test(value) ? value : null;
}

export function redactDbError(error: unknown): RedactedDbError {
  if (!(error instanceof Error)) return { errorName: 'unknown', code: null, constraint: null };

  let code: string | null = null;
  let constraint: string | null = null;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const fields = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    code ??= shaped(fields.code, CODE_SHAPE);
    constraint ??= shaped(fields.constraint, CONSTRAINT_SHAPE);
    current = fields.cause;
  }

  const errorName = shaped(error.constructor?.name, CONSTRAINT_SHAPE) ?? 'Error';
  return { errorName, code, constraint };
}

/**
 * A Postgres SQLSTATE: five characters, digits and capitals, always containing a
 * digit (`23505`, `57014`, `XX000`). Node's own codes (`ERR_INVALID_ARG_TYPE`,
 * `ABORT_ERR`) and errnos (`EPIPE`, `ECONNREFUSED`) never match.
 */
const SQLSTATE_SHAPE = /^(?=[A-Z0-9]*\d)[A-Z0-9]{5}$/;

/**
 * Is this a database failure — a drizzle query error, or an error whose cause
 * chain carries a Postgres SQLSTATE? A caller uses it to decide between
 * answering "temporarily unavailable" (and logging `redactDbError`) and
 * rethrowing a genuine code bug so the request-error hook still reports it.
 * Every Node builtin error carries a SCREAMING_SNAKE `code`; none is a SQLSTATE.
 */
export function isDatabaseError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error && current.constructor?.name === 'DrizzleQueryError') return true;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE_SHAPE.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
