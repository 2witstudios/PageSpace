import type { ConversationMessagesById } from './seedEmpty';

/**
 * Promotes a conversation's optimistic sends into confirmed `messages`, in
 * send order (F1, PR #2098 review).
 *
 * WHY: the sender's own tab never receives its own chat:user_message
 * broadcast back (own-tab dedup), and `applyConfirmedMessage` reconciles only
 * the ASSISTANT id — so without this, the user's question stayed in
 * `optimisticSends` while the committed reply appended to `messages`, and the
 * selector (confirmed before optimistic) rendered the question BELOW the
 * answer from the moment the stream completed, compounding every turn.
 *
 * WHEN IT IS SOUND: call on this tab's OWN stream commit. An own reply exists
 * only if the send's POST succeeded, and the route persists the user message
 * before generating — so the promoted rows are provably in the DB. A REMOTE
 * reply proves nothing about this tab's sends; callers must not promote for
 * those (ordering is already correct there: an unconfirmed own send IS the
 * newest content and belongs last).
 *
 * Each promoted send is recorded as a `remoteMessage` pending mutation
 * (append-if-absent on replay), so a load snapshot in flight across the
 * promotion cannot drop the rows it predates.
 */
export const promoteOptimisticSends = (
  byConversationId: ConversationMessagesById,
  conversationId: string,
): ConversationMessagesById => {
  const existing = byConversationId[conversationId];
  if (!existing || existing.optimisticSends.length === 0) return byConversationId;

  const confirmedIds = new Set(existing.messages.map((m) => m.id));
  const promoted = existing.optimisticSends.filter((m) => !confirmedIds.has(m.id));

  return {
    ...byConversationId,
    [conversationId]: {
      ...existing,
      messages: [...existing.messages, ...promoted],
      optimisticSends: [],
      pendingMutationsSinceLoad: [
        ...existing.pendingMutationsSinceLoad,
        ...promoted.map((message) => ({ type: 'remoteMessage' as const, message })),
      ],
    },
  };
};
