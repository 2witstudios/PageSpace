/**
 * Single-writer guard for the Global Assistant's stop-streaming slot — the twin of
 * `shouldClaimAgentStopSlot`, which had this guard while the global side claimed
 * unconditionally and silently overwrote whatever was there.
 *
 * The bootstrap sweep calls `onOwnStreamBootstrap` once per own in-flight stream, so two live
 * own streams (send in A → New Chat → send in B → reload) both arrive in a single loop — and
 * often while the surface's conversation identity is still unresolved. An unconditional claim
 * let the second destroy the first: the first's finalize was then dropped (the claim no longer
 * named its messageId) and there is no re-claim protocol, so the conversation actually on
 * screen could be left with a live stream and NO Stop button and no streaming indicator, for
 * the rest of the session.
 *
 * Precedence:
 *   1. A claim for the stream we already hold is idempotent — re-claiming is always fine.
 *   2. A stream that EXACTLY matches the resolved conversation is authoritative: it may take
 *      the slot from a claim made in ignorance (identity still unknown when it was made).
 *   3. Otherwise, first writer wins. A later stream may not evict an equally-good incumbent.
 *
 * `activeConversationId === null` means "this surface has not resolved its conversation yet",
 * NOT "this surface has no conversation" — the distinction is the whole reason the tolerant
 * claim exists, and collapsing the two is what made the original bug possible.
 */
export const shouldClaimGlobalStopSlot = ({
  incomingMessageId,
  incomingConversationId,
  heldMessageId,
  heldConversationId,
  activeConversationId,
}: {
  incomingMessageId: string;
  incomingConversationId: string;
  /** The messageId of the stream currently holding the slot, or null if the slot is free. */
  heldMessageId: string | null;
  /** The conversation the incumbent claim named, or null if it never knew. */
  heldConversationId: string | null;
  /** The conversation this surface is showing, or null if not yet resolved. */
  activeConversationId: string | null;
}): boolean => {
  // A known mismatch is never ours to claim: it would light the Stop button, and disable the
  // composer, for a stream the user is not looking at.
  if (activeConversationId !== null && incomingConversationId !== activeConversationId) {
    return false;
  }
  // Free slot, or a re-claim of the stream we already hold.
  if (heldMessageId === null || heldMessageId === incomingMessageId) return true;

  // Contested. We may only evict an incumbent that is strictly less certain than we are.
  const weAreExact = activeConversationId !== null; // guaranteed by the mismatch check above
  const incumbentIsExact = heldConversationId === activeConversationId;
  return weAreExact && !incumbentIsExact;
};
