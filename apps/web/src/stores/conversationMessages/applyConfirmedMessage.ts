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
 * Records a `confirmedMessage` pending mutation — distinct from
 * `applyRemoteUserMessage`'s `remoteMessage` entry. `replayPendingMutations`
 * replays `remoteMessage` as append-if-absent (correct there: a genuine user
 * message's content never changes, so a load snapshot that already has the id
 * already has the right content). This function's content CAN legitimately
 * need to replace a load snapshot's copy (the load may have read a
 * 'streaming'-placeholder or partial row while this confirmation was in
 * flight), so its replay upserts by id instead.
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
        { type: 'confirmedMessage', message: event.message },
      ],
    },
  };
};
