/**
 * Turning a failed task write into something worth showing the user.
 *
 * Two of the failures this path can produce are diagnostic and must not be
 * flattened into "Failed to update status":
 *
 *   422 SUBTASKS_INCOMPLETE — the server's sub-task completion guard. The
 *       client checks the same rule first, but its counts can be stale, so this
 *       is the case where the toast has to say what is actually blocking.
 *   400 Invalid status — a slug the target list does not define. This is the
 *       tripwire for status vocabulary drift between a list and its sub-lists;
 *       surfacing the server's own message (which names the valid slugs) is the
 *       difference between a bug report and a mystery.
 *
 * Duck-typed rather than importing ApiRequestError so this stays a pure
 * function over plain data and can be tested without the fetch layer.
 */

interface StatusCarryingError {
  status: number;
  body?: unknown;
}

const hasStatus = (e: unknown): e is StatusCarryingError =>
  typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number';

const bodyError = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null;
  const message = (body as { error?: unknown }).error;
  return typeof message === 'string' && message.length > 0 ? message : null;
};

/**
 * A revision conflict on a title write means our view of the page is behind;
 * a rollback would restore data that is already wrong, so callers revalidate
 * instead.
 */
export const isRevisionConflict = (error: unknown): boolean =>
  hasStatus(error) && (error.status === 409 || error.status === 428);

export const taskWriteErrorMessage = (error: unknown, fallback: string): string => {
  if (!hasStatus(error)) return fallback;
  if (error.status === 422 || error.status === 400 || error.status === 403) {
    return bodyError(error.body) ?? fallback;
  }
  return fallback;
};
