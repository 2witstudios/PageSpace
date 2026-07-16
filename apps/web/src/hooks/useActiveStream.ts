import { useShallow } from 'zustand/react/shallow';
import { usePendingStreamsStore, type PendingStream } from '@/stores/usePendingStreamsStore';
import { selectChannelRemoteStreams } from '@/lib/ai/streams/selectChannelRemoteStreams';

const EMPTY_STREAMS: PendingStream[] = [];

export interface ActiveStreamState {
  /** Every live stream (own + remote) attached to this page's conversation. */
  streams: PendingStream[];
  /** This tab's own live assistant messageId, or undefined when not streaming. */
  ownStreamMessageId: string | undefined;
}

/**
 * Facade — the sanctioned way for a component to read a conversation's live
 * stream state (see PR 4 board: container-agnostic consumer rule). Do not
 * call `usePendingStreamsStore` directly from a component; this hook is the
 * only place that reaches into the store's internals.
 *
 * Scoped by BOTH pageId and conversationId (reusing `selectChannelRemoteStreams`,
 * agent-mode branch) rather than conversationId alone: a page's socket channel
 * carries every conversation on that page, so a stream read that skipped the
 * page scope would leak another user's private conversation on a shared page.
 */
export const useActiveStream = (
  pageId: string,
  conversationId: string | null,
): ActiveStreamState => {
  const streams = usePendingStreamsStore(
    useShallow((state) =>
      conversationId === null
        ? EMPTY_STREAMS
        : selectChannelRemoteStreams(state, {
            selectedAgent: { id: pageId },
            agentConversationId: conversationId,
            globalChannelId: null,
            globalConversationId: null,
          }),
    ),
  );

  const ownStreamMessageId = usePendingStreamsStore((state) =>
    conversationId === null
      ? undefined
      : state.getOwnStreams(pageId).find((s) => s.conversationId === conversationId)?.messageId,
  );

  return { streams, ownStreamMessageId };
};

/**
 * Imperative facade counterpart to `useActiveStream`, for event handlers (socket
 * callbacks) that need a one-off snapshot of a specific stream by messageId rather
 * than a reactive subscription — e.g. `chat:stream_complete`, which names the
 * completed stream's id directly. Keeps that one `getState()` reach-in inside the
 * facade module instead of the component.
 */
export const getActiveStreamById = (messageId: string): PendingStream | undefined =>
  usePendingStreamsStore.getState().streams.get(messageId);
