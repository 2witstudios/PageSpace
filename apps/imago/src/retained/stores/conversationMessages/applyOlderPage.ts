import type { UIMessage } from 'ai';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyOlderPageEvent {
  conversationId: string;
  /** The generation captured before the fetch (beginServerSnapshot) — stale-load guard. */
  generation: number;
  /** The older page, oldest-first, as returned by the route. */
  messages: UIMessage[];
  hasMoreOlder: boolean;
  nextCursor: string | null;
}

/**
 * Prepends a "load older" page (epic leaf 6.6, scroll-to-top) onto a
 * conversation's confirmed messages. Dedups by id against the existing set —
 * a message can arrive via socket edit/undo while the older-page fetch was in
 * flight — and advances olderCursor/hasMoreOlder from the response.
 * `optimisticSends` and live stream entries (a separate store) are untouched.
 * No-op for a generation superseded by a newer `startLoad` (a full reload —
 * e.g. a conversation switch — mid-fetch).
 */
export const applyOlderPage = (
  byConversationId: ConversationMessagesById,
  event: ApplyOlderPageEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing || event.generation !== existing.loadGeneration) return byConversationId;

  const existingIds = new Set(existing.messages.map((m) => m.id));
  const dedupedOlder = event.messages.filter((m) => !existingIds.has(m.id));

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: [...dedupedOlder, ...existing.messages],
      olderCursor: event.nextCursor,
      hasMoreOlder: event.hasMoreOlder,
      isLoadingOlder: false,
    },
  };
};
