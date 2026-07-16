import { useShallow } from 'zustand/react/shallow';
import { usePendingStreamsStore, type PendingStream } from '@/stores/usePendingStreamsStore';
import { selectChannelRemoteStreams } from '@/lib/ai/streams/selectChannelRemoteStreams';
import { selectActiveStream, type ActiveStream } from '@/lib/ai/streams/selectActiveStream';
import { mergeServerAndPending } from '@/lib/ai/streams/mergeServerAndPending';
import type { UIMessage } from 'ai';

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
 * Facade — a conversation's live stream identity `{messageId, conversationId, isOwn}`, or
 * undefined when nothing is live for it. THE read that replaces the stop-slot claim protocols
 * (PR 5A): see `selectActiveStream` for why a selector cannot have the "slot belongs to somebody
 * else" bugs the slots had.
 *
 * `useShallow` is what makes this stable per-token: `selectActiveStream` projects three
 * primitives out of a store entry whose `parts` array grows on every chunk, so consumers
 * (the Stop button, the composer's disabled state, the AISelector) re-render when the stream
 * STARTS and ENDS, not on every token.
 */
export const useConversationActiveStream = (
  pageId: string | null,
  conversationId: string | null,
): ActiveStream | undefined =>
  usePendingStreamsStore(
    useShallow((state) => selectActiveStream(state.streams, { pageId, conversationId })),
  );

/**
 * Imperative facade counterpart to `useActiveStream`, for event handlers (socket
 * callbacks) that need a one-off snapshot of a specific stream by messageId rather
 * than a reactive subscription — e.g. `chat:stream_complete`, which names the
 * completed stream's id directly. Keeps that one `getState()` reach-in inside the
 * facade module instead of the component.
 */
export const getActiveStreamById = (messageId: string): PendingStream | undefined =>
  usePendingStreamsStore.getState().streams.get(messageId);

/**
 * Facade — reconcile a freshly-loaded server message list with this tab's own in-flight stream,
 * for the surfaces that still write DB history into a useChat array.
 *
 * Two things break when a whole-array write lands mid-stream, and merging fixes both:
 *
 *  - The live bubble disappears (the DB does not have a finished row for a stream still running).
 *  - Worse, `useOwnStreamMirror` reads that array to find its own live stream. If the array's
 *    newest row is some OTHER assistant message — the previous turn's reply, or another TAB of
 *    this same user (`isOwn` is browserSessionId-scoped, so no collaborator is needed) — the
 *    mirror reads it as the SDK renaming our stream, re-targets onto a finished message, and Stop
 *    then aborts an id the server has no stream for: user-scoped, so `not_found`, on which
 *    reportAbortOutcome is silent by design, while the generation keeps running its write tools
 *    and keeps billing.
 *
 * Merging is strictly better than skipping the write: skipping keeps the live bubble but drops
 * whatever the load was for (an undo the user just confirmed, a cross-tab edit), which on a
 * destructive action reads as "it didn't work". This applies the server's truth AND keeps our own
 * stream last, which is what the mirror needs.
 *
 * A one-off `getState()` snapshot, not a subscription: every caller runs this inside an async
 * callback after its fetch resolves, where the current store is exactly what it wants.
 */
export const mergeServerMessagesWithOwnStream = (
  serverMessages: UIMessage[],
  conversationId: string | null,
): UIMessage[] => {
  if (!conversationId) return serverMessages;
  const ownStream = Array.from(usePendingStreamsStore.getState().streams.values())
    .find((s) => s.isOwn && s.conversationId === conversationId);
  return ownStream
    ? mergeServerAndPending(serverMessages, ownStream.parts, ownStream.messageId, ownStream.startedAt)
    : serverMessages;
};
