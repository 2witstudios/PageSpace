import type { UIMessage } from 'ai';
import { seedEmpty } from './seedEmpty';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyRemoteUserMessageEvent {
  conversationId: string;
  message: UIMessage;
}

/**
 * Appends a broadcast user message (e.g. another tab/collaborator's send) to
 * `messages`. No-ops when the id is already confirmed. When the id matches
 * one of our own `optimisticSends` (the broadcast is the echo of our own
 * send), reconciles it out of `optimisticSends` at the same time — the
 * confirmed row now covers it.
 *
 * Bumps `loadGeneration`: a load's DB snapshot is read before this broadcast
 * necessarily landed, so a load already in flight when this arrives must not
 * be allowed to later overwrite `messages` and silently drop it — bumping
 * the generation makes that in-flight `applyLoad` stale (its generation no
 * longer matches) so it gets rejected instead of clobbering this append.
 */
export const applyRemoteUserMessage = (
  byConversationId: ConversationMessagesById,
  event: ApplyRemoteUserMessageEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId] ?? seedEmpty();
  if (existing.messages.some((m) => m.id === event.message.id)) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: [...existing.messages, event.message],
      optimisticSends: existing.optimisticSends.filter((m) => m.id !== event.message.id),
      loadGeneration: existing.loadGeneration + 1,
    },
  };
};
