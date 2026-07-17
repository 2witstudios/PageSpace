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
 * Id collisions (PR 5B): a LIVE stream whose `messageId` matches a cached row
 * renders IN PLACE of that row — but ONLY when the cached row is a DB
 * streaming-placeholder (`status: 'streaming'`; loads carry
 * `includeStreaming=1` so a history rejoin can see an in-flight
 * conversation). Letting the cache win on the placeholder froze the bubble
 * at the snapshot for the rest of the generation — the #2092 failure class,
 * moved into the cache. A colliding row WITHOUT that status is a complete
 * persisted/committed reply and the cache wins: a lingering stream entry
 * whose removal event was lost (socket blip) must never override the full
 * reply with a stale partial (the deleted `mergeServerAndPending` invariant,
 * restored with in-place position semantics). A stream colliding with an
 * `optimisticSends` id is still dropped (an optimistic send is a user
 * message; an assistant stream under that id is a duplicate echo, never
 * fresher content). `messages` are assumed pre-ordered (DB order);
 * `optimisticSends` render in send order after them; non-colliding streams
 * are ordered by `startedAt` among themselves and rendered last.
 *
 * `activeStreams` must already be filtered to this conversation by the
 * caller (`selectChannelRemoteStreams` + conversationId filter) — this
 * function does no channel/conversation filtering of its own.
 */
export const selectRenderedMessages = (
  cacheEntry: ConversationCacheEntry,
  activeStreams: readonly PendingStream[],
): RenderedMessage[] => {
  const streamById = new Map(activeStreams.map((s) => [s.messageId, s]));

  const confirmed: RenderedMessage[] = cacheEntry.messages.map((message) => {
    const liveStream = streamById.get(message.id);
    const isStreamingPlaceholder = (message as UIMessage & { status?: string }).status === 'streaming';
    return liveStream && isStreamingPlaceholder
      ? {
          message: synthesizeAssistantMessage(liveStream.messageId, liveStream.parts, liveStream.startedAt),
          mode: 'streaming' as const,
        }
      : { message, mode: 'confirmed' as const };
  });
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
