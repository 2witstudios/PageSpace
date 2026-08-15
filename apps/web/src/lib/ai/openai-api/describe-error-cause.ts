/**
 * Flatten the driver diagnostics a database error hides under `cause`.
 *
 * Drizzle wraps a failed statement as `Error: Failed query: insert into
 * "messages" (...)` and hangs the real driver error off `cause`. The wrapper
 * names no constraint, so a logged foreign-key violation reads as an anonymous
 * insert failure — #2414 took a by-hand schema read to identify, when the
 * `cause` was already carrying `code: '23503'` and
 * `messages_conversationId_conversations_id_fk` outright. The logger serializes
 * an Error's name/message/stack and stops there, so the fields have to be
 * lifted into metadata to survive.
 *
 * Returns `undefined` when the error carries nothing worth logging, so callers
 * can spread it into log metadata unconditionally.
 */
export interface ErrorCauseDetail {
  /** Index signature so the whole shape satisfies the logger's `LogInput`. */
  [key: string]: string | undefined;
  causeMessage?: string;
  /** Postgres SQLSTATE, e.g. '23503' for foreign_key_violation. */
  causeCode?: string;
  causeConstraint?: string;
  causeDetail?: string;
  causeTable?: string;
}

const FIELDS = [
  ['message', 'causeMessage'],
  ['code', 'causeCode'],
  ['constraint', 'causeConstraint'],
  ['detail', 'causeDetail'],
  ['table', 'causeTable'],
] as const;

export function describeErrorCause(error: unknown): ErrorCauseDetail | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;

  const raw = cause as Record<string, unknown>;
  const detail: ErrorCauseDetail = {};
  for (const [from, to] of FIELDS) {
    const value = raw[from];
    if (typeof value === 'string' && value !== '') detail[to] = value;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}
