import type { ConversationMessagesById } from './seedEmpty';
import { nextWatermark } from '@/lib/realtime/conversation-apply';

export interface AdvanceRevEvent {
  conversationId: string;
  /** The post-write rev of the event that was just APPLIED to this entry. */
  rev: number;
}

/**
 * Advances a conversation entry's rev watermark after an event's payload has
 * been written into the cache (Agent-Session SSoT epic, Phase 2).
 *
 * Monotonic via `nextWatermark`, and a NO-OP for a conversation with no entry:
 * the watermark is a statement about what THIS cache holds, and materializing an
 * entry here would claim currency for a message list that was never loaded.
 * Subscribe-on-open means any conversation a surface is showing already has one.
 */
export const advanceRev = (
  byConversationId: ConversationMessagesById,
  event: AdvanceRevEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;
  const rev = nextWatermark(existing.rev, event.rev);
  if (rev === existing.rev) return byConversationId;
  return {
    ...byConversationId,
    [event.conversationId]: { ...existing, rev },
  };
};
