/**
 * Shared vocabulary for the Files tab's "there's nothing browsable here"
 * states (Machine Files Manager epic).
 *
 * The files route reports why a scope (root Sprite or branch checkout)
 * couldn't be reached with a typed `reason` (see `machine-files-runtime.ts` /
 * `route.ts`), and BOTH surfaces of the tab have to speak about it: the
 * sidebar (which can't list files) and the main pane (which can't read the
 * open file). They live in separate modules and the tab imports the pane, so
 * this copy lives here rather than in either one — importing it back out of
 * FilesTab would be a cycle.
 *
 * The user-facing rule this encodes: NEVER render the route's internal phrasing
 * ("Branch machine vanished") at a person. A scope that isn't reachable is a
 * state of the world, not an error message.
 */

/**
 * The route's absence reasons — a scope we cannot reach a filesystem for.
 *
 * Note what is NOT here: `file_not_found`/`dir_not_found`. A missing file or
 * folder is a fact about one path inside a scope that IS reachable; these
 * three are facts about the scope itself (no checkout, checkout reclaimed,
 * machine never started). The route keeps the tokens distinct precisely so a
 * client cannot tell a reader "this path is gone" when the whole scope is.
 */
export type FilesAbsentReason = 'not_found' | 'vanished' | 'not_started';

export const FILES_ABSENT_COPY: Record<FilesAbsentReason, { title: string; description: string }> = {
  // Covers both of the route's 404 sources for branch scope: no
  // `machine_branches` row at all, and a row whose Sprite has no
  // `/workspace/repo` yet (never cloned).
  not_found: {
    title: "This branch hasn't been checked out yet",
    description: 'Open a terminal on this branch to clone it, then check again.',
  },
  vanished: {
    title: 'This branch checkout is gone',
    description: 'Its sandbox was reclaimed. Open a terminal on the branch to check it out again.',
  },
  // Root scope only: no `machine_branches` row exists to distinguish "this
  // machine's Sprite never started" from "it's gone" the way branch scope
  // can — so this is deliberately coarser than `not_found`/`vanished`.
  not_started: {
    title: "This machine hasn't been started yet",
    description: 'Open the Terminal tab to start it, then check again.',
  },
};

/** Narrows an unknown response body's `reason` to one we have copy for. */
export const asAbsentReason = (reason: unknown): FilesAbsentReason | null =>
  reason === 'not_found' || reason === 'vanished' || reason === 'not_started' ? reason : null;

/** `{ error, reason }` off a files-route failure body, without trusting its shape. */
export const readErrorBody = (body: unknown): { error: string | null; reason: unknown } => {
  if (body === null || typeof body !== 'object') return { error: null, reason: undefined };
  const record = body as Record<string, unknown>;
  return {
    error: typeof record.error === 'string' && record.error.length > 0 ? record.error : null,
    reason: record.reason,
  };
};
