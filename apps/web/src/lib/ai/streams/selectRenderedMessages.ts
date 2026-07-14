import type { UIMessage } from 'ai';
import type { ConversationCacheEntry } from '@/stores/conversationMessages/seedEmpty';
import type { PendingStream } from '@/stores/usePendingStreamsStore';
import { synthesizeAssistantMessage } from './synthesizeAssistantMessage';
import { dedupRemoteStreams } from './dedupRemoteStreams';

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
 * `messages` or `optimisticSends` is dropped (reuses `dedupRemoteStreams`),
 * so a stream that has landed (or reconciled into an optimistic send) never
 * double-renders. `messages` are assumed pre-ordered (DB order);
 * `optimisticSends` render in send order after them; remaining streams are
 * ordered by `startedAt` among themselves and rendered last.
 *
 * Doesn't reuse `mergeServerAndPending` for the streaming tail: that helper
 * is single-stream (one `pendingMessageId`), but this selector must support
 * N concurrent streams per conversation (own + remote + bootstrapped, per
 * the epic's `usePendingStreamsStore` reshape) — it bottoms out at the same
 * `synthesizeAssistantMessage` primitive `mergeServerAndPending` itself
 * delegates to, recomposed with a sort for the multi-stream case.
 *
 * `activeStreams` must already be filtered to this conversation by the
 * caller (`selectChannelRemoteStreams` + conversationId filter) — this
 * function does no channel/conversation filtering of its own.
 */
export const selectRenderedMessages = (
  cacheEntry: ConversationCacheEntry,
  activeStreams: readonly PendingStream[],
): RenderedMessage[] => {
  const confirmed: RenderedMessage[] = cacheEntry.messages.map((message) => ({
    message,
    mode: 'confirmed' as const,
  }));
  const optimistic: RenderedMessage[] = cacheEntry.optimisticSends.map((message) => ({
    message,
    mode: 'optimistic' as const,
  }));

  const streaming: RenderedMessage[] = dedupRemoteStreams(activeStreams, [
    ...cacheEntry.messages,
    ...cacheEntry.optimisticSends,
  ])
    .slice()
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    .map((s) => ({
      message: synthesizeAssistantMessage(s.messageId, s.parts, s.startedAt),
      mode: 'streaming' as const,
    }));

  return [...confirmed, ...optimistic, ...streaming];
};
