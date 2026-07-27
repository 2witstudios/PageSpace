/**
 * Error classification helpers for activity logging.
 *
 * Kept as a standalone pure module so it can be exercised without the
 * database mocks that `activity-logger.ts` requires.
 */

/** Postgres `foreign_key_violation`. */
const FK_VIOLATION_CODE = '23503';

/** The FK that links `activity_logs.pageId` to `pages.id`. */
const PAGE_ID_CONSTRAINT = 'activity_logs_pageId_pages_id_fk';

/**
 * How many `.cause` links to follow. Drizzle wraps the driver error exactly
 * one level deep ("Failed query: …" with the pg error under `.cause`); a small
 * fixed budget absorbs any extra wrapping without walking an unbounded chain.
 */
const MAX_CAUSE_DEPTH = 5;

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
  cause?: unknown;
}

/** Read the pg error fields off a value, or null if it can't carry them. */
function asPgErrorFields(value: unknown): PgErrorFields | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as PgErrorFields;
}

/** True when this single link is an `activity_logs.pageId` FK violation. */
function isPageIdFkLink(fields: PgErrorFields): boolean {
  if (fields.code !== FK_VIOLATION_CODE) return false;
  if (fields.constraint === PAGE_ID_CONSTRAINT) return true;
  return typeof fields.detail === 'string' && fields.detail.includes('pageId');
}

/**
 * Detect a foreign key violation on `activity_logs.pageId`, including when the
 * driver error is nested under `.cause`.
 *
 * Drizzle throws a wrapper `Error: Failed query: insert into "activity_logs" …`
 * and hangs the real pg error (with `code` / `constraint` / `detail`) off its
 * `cause`, so a top-level-only check never matches in production.
 *
 * Walks up to {@link MAX_CAUSE_DEPTH} cause links and tolerates cyclic chains.
 */
export function isPageIdForeignKeyError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    const fields = asPgErrorFields(current);
    if (!fields) return false;
    if (seen.has(fields as object)) return false;
    seen.add(fields as object);

    if (isPageIdFkLink(fields)) return true;
    current = fields.cause;
  }

  return false;
}
