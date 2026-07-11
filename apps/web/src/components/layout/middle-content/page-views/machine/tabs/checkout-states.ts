/**
 * Shared vocabulary for the Code tab's "the checkout isn't there" states
 * (Machine page rebuild, Phase 3).
 *
 * The files route reports why a branch checkout couldn't be reached with a typed
 * `reason` (see `machine-files-runtime.ts` / `route.ts`), and BOTH surfaces of
 * the tab have to speak about it: the sidebar (which can't list files) and the
 * main pane (which can't read the open file). They live in separate modules and
 * the tab imports the pane, so this copy lives here rather than in either one —
 * importing it back out of CodeTab would be a cycle.
 *
 * The user-facing rule this encodes: NEVER render the route's internal phrasing
 * ("Branch machine vanished") at a person. A checkout that isn't there is a
 * state of the world, not an error message.
 */

/**
 * The route's absence reasons — a branch we cannot reach a checkout for.
 *
 * Note what is NOT here: `file_not_found`. A missing FILE is a fact about one
 * path inside a checkout that exists; these two are facts about the checkout
 * itself. The route keeps the tokens distinct precisely so a client cannot tell
 * a reader "this file is gone" when the whole branch is.
 */
export type CheckoutAbsentReason = 'not_found' | 'vanished';

export const CHECKOUT_ABSENT_COPY: Record<CheckoutAbsentReason, { title: string; description: string }> = {
  // Covers both of the route's 404 sources: no `machine_branches` row at all,
  // and a row whose Sprite has no `/workspace/repo` yet (never cloned).
  not_found: {
    title: "This branch hasn't been checked out yet",
    description: 'Open a terminal on this branch to clone it, then check again.',
  },
  vanished: {
    title: 'This branch checkout is gone',
    description: 'Its sandbox was reclaimed. Open a terminal on the branch to check it out again.',
  },
};

/** Narrows an unknown response body's `reason` to one we have copy for. */
export const asAbsentReason = (reason: unknown): CheckoutAbsentReason | null =>
  reason === 'not_found' || reason === 'vanished' ? reason : null;

/** `{ error, reason }` off a files-route failure body, without trusting its shape. */
export const readErrorBody = (body: unknown): { error: string | null; reason: unknown } => {
  if (body === null || typeof body !== 'object') return { error: null, reason: undefined };
  const record = body as Record<string, unknown>;
  return {
    error: typeof record.error === 'string' && record.error.length > 0 ? record.error : null,
    reason: record.reason,
  };
};
