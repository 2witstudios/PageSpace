import type { UIMessage } from 'ai';
import type { ConversationCacheEntry } from '@/stores/conversationMessages/seedEmpty';
import type { PendingStream } from '@/stores/usePendingStreamsStore';
import { synthesizeAssistantMessage } from './synthesizeAssistantMessage';

export type RenderedMessageMode = 'confirmed' | 'optimistic' | 'streaming';

export interface RenderedMessage {
  message: UIMessage;
  mode: RenderedMessageMode;
}

/**
 * The store-first render selector (epic architecture decision:
 * `selectRenderedMessages(conversationCache, activeStreams)`). Merges one
 * conversation's cache entry with its live stream mirror into the list a
 * surface renders — merge-at-render, so no effect ordering can blank a live
 * stream.
 *
 * Cache wins on id collision: a stream whose `messageId` already appears in
 * `messages` or `optimisticSends` is dropped, so a stream that has landed
 * (or reconciled into an optimistic send) never double-renders. `messages`
 * are assumed pre-ordered (DB order); `optimisticSends` render in send
 * order after them; remaining streams are ordered by `startedAt` among
 * themselves and rendered last.
 *
 * `activeStreams` must already be filtered to this conversation by the
 * caller (`selectChannelRemoteStreams` + conversationId filter) — this
 * function does no channel/conversation filtering of its own.
 */
export const selectRenderedMessages = (
  cacheEntry: ConversationCacheEntry,
  activeStreams: readonly PendingStream[],
): RenderedMessage[] => {
  const cacheIds = new Set([
    ...cacheEntry.messages.map((m) => m.id),
    ...cacheEntry.optimisticSends.map((m) => m.id),
  ]);

  const confirmed: RenderedMessage[] = cacheEntry.messages.map((message) => ({
    message,
    mode: 'confirmed' as const,
  }));
  const optimistic: RenderedMessage[] = cacheEntry.optimisticSends.map((message) => ({
    message,
    mode: 'optimistic' as const,
  }));

  const streaming: RenderedMessage[] = activeStreams
    .filter((s) => !cacheIds.has(s.messageId))
    .slice()
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    .map((s) => ({
      message: synthesizeAssistantMessage(s.messageId, s.parts, s.startedAt),
      mode: 'streaming' as const,
    }));

  return [...confirmed, ...optimistic, ...streaming];
};
