import type { UIMessage } from 'ai';
import { seedEmpty } from './seedEmpty';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyConfirmedMessageEvent {
  conversationId: string;
  message: UIMessage;
}

/**
 * Upserts a confirmed message into `messages` BY ID: replaces an existing
 * entry in place, or appends if absent. An existing row with this id is NOT
 * proof its content is complete — e.g. stream-completion recovery replacing a
 * half-streamed/'streaming'-placeholder snapshot (loaded from the DB while a
 * stream was in flight) with the full, final reply.
 *
 * Deliberately NOT `applyRemoteUserMessage` (which no-ops on an existing id —
 * correct there, since a genuine user message's content never changes after
 * creation, so append-if-absent and upsert-by-id are equivalent for it). This
 * function is for confirming an ASSISTANT reply, whose content can
 * legitimately need to be replaced with a fuller version under the same id.
 *
 * Records the same `pendingMutationsSinceLoad` entry shape `applyRemoteUserMessage`
 * does (best-effort — see `replayPendingMutations`, which replays a
 * `remoteMessage` mutation as append-if-absent, not upsert; a load snapshot
 * racing exactly against this replace can still win with a staler copy in
 * that narrow compound-race window).
 */
export const applyConfirmedMessage = (
  byConversationId: ConversationMessagesById,
  event: ApplyConfirmedMessageEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId] ?? seedEmpty();
  const index = existing.messages.findIndex((m) => m.id === event.message.id);
  const messages =
    index === -1
      ? [...existing.messages, event.message]
      : existing.messages.map((m, i) => (i === index ? event.message : m));

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages,
      optimisticSends: existing.optimisticSends.filter((m) => m.id !== event.message.id),
      pendingMutationsSinceLoad: [
        ...existing.pendingMutationsSinceLoad,
        { type: 'remoteMessage', message: event.message },
      ],
    },
  };
};
