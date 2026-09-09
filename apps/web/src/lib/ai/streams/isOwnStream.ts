/**
 * Is this stream the CURRENT USER's?
 *
 * WHY THIS COMPARES `userId` AND NOT `browserSessionId`.
 *
 * A stream is a server-owned entity belonging to a USER, not to a tab. `browserSessionId`
 * names one tab (it lives in `sessionStorage`), so keying ownership on it meant the same
 * account in a second tab — or on a phone, or on a second monitor — classified its OWN
 * in-flight generation as somebody else's. The consequences were not cosmetic: `isOwn`
 * drives whether the Stop button renders and whether the reply is presented as the user's
 * own, so the second tab showed a stream it could watch but not stop, attributed to nobody.
 *
 * The server has always sent the answer. `triggeredBy.userId` rides every
 * `chat:stream_start` and every `/active-streams` row, and the join re-authorizes with
 * `canAccessConversation` regardless — so trusting it here widens nothing.
 *
 * WHAT `browserSessionId` IS STILL FOR: naming a TAB, for genuinely tab-local concerns —
 * the user-message echo dedup, where the originating tab has already appended the message
 * locally and must ignore its own broadcast. That is `isOwnTabEcho`, and it is the only
 * remaining caller. Never use it to decide whose stream something is.
 *
 * FAILS CLOSED on an unknown local identity. Before auth hydrates, `localUserId` is
 * undefined; claiming ownership then would render a stranger's stream on a shared page as
 * the viewer's own, complete with a Stop button that aborts someone else's generation.
 * An empty string is treated the same way — it is the unresolved-identity placeholder the
 * surfaces pass while `useAuth` is still loading, never a real account.
 */
export const isOwnStream = (
  triggeredBy: { userId: string },
  localUserId: string | undefined | null,
): boolean => {
  if (!localUserId) return false;
  return triggeredBy.userId === localUserId;
};
