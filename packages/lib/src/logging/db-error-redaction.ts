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

export interface RedactedDbError {
  /** Constructor name of the outermost error (`DrizzleQueryError`, `Error`, …), or `unknown`. */
  errorName: string;
  /** SQLSTATE (`23505`) or driver code (`ECONNREFUSED`) from the error or its cause chain. */
  code: string | null;
  /** Violated constraint name, when the driver reports one. */
  constraint: string | null;
}

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
