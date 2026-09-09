/**
 * Did THIS TAB cause the event now coming back over the socket?
 *
 * The one legitimate use of `browserSessionId`: an echo filter. When this tab sends a
 * message, edits one, deletes one, or renames a conversation, it has already applied that
 * change to its own state; the server then broadcasts it to the whole room, including back
 * here. Without this the tab would apply its own change twice.
 *
 * DELIBERATELY NOT `isOwnStream`. The two questions look alike and are not:
 *
 *   - "is this stream mine?" is about a USER, and must be true in every tab and on every
 *     device that account is signed in to — see `isOwnStream`.
 *   - "did this tab already do this?" is about a TAB, and must be false in the user's other
 *     tabs, because those tabs have NOT applied the change and do need the broadcast.
 *
 * Answering the first with this predicate is the bug `isOwnStream` documents. Answering the
 * second with `userId` would be the mirror of it: the user's other tab would drop every
 * event it actually needed and silently stop updating.
 *
 * FAILS OPEN on an unknown session id, which is the safe direction here: a missed echo
 * filter costs a de-duplicated re-apply (every consumer dedups by message id anyway), while
 * a spurious filter drops a real remote event and the tab goes quietly stale.
 */
export const isOwnTabEcho = (
  triggeredBy: { browserSessionId: string },
  localBrowserSessionId: string,
): boolean => {
  if (!localBrowserSessionId) return false;
  return triggeredBy.browserSessionId === localBrowserSessionId;
};
