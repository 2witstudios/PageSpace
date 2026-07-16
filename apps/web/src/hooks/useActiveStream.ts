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
 * Facade — reconcile a freshly-loaded server message list with this tab's own LOCALLY-STREAMING
 * message, for the surfaces that still write DB history into a useChat array.
 *
 * WHY MERGE AT ALL. A whole-array write landing mid-send hands `useOwnStreamMirror` an array whose
 * newest row is somebody else's message — the previous turn's reply, or another TAB of this same
 * user (`isOwn` is browserSessionId-scoped, so no collaborator is needed). The mirror reads that as
 * the SDK renaming our stream, re-targets onto a finished message, and Stop then aborts an id the
 * server has no stream for: user-scoped, so `not_found`, on which reportAbortOutcome is silent by
 * design, while the generation keeps running its write tools and keeps billing. Merging keeps our
 * own message last, which is the one thing the mirror needs.
 *
 * WHY ONLY WHEN THE STREAM IS IN THE LOCAL ARRAY. A stream this tab is NOT locally producing — one
 * rejoined by the bootstrap after a refresh — renders straight from the pending-streams store, and
 * both renderers drop a store stream whose messageId already appears in `messages`
 * (dedupRemoteStreams / ChatMessagesArea's visibleRemoteStreams). Synthesizing that id INTO
 * `messages` therefore dedupes the live bubble out of the renderer and freezes it at the merged
 * snapshot for the rest of the generation. Merging is for the locally-streaming case only; for a
 * bootstrapped stream a raw write is provably safe, because the mirror never latches while our
 * status is idle and so cannot re-target at all.
 *
 * A one-off `getState()` snapshot, not a subscription: every caller runs this inside an async
 * callback after its fetch resolves, where the current store is exactly what it wants.
 */
export const mergeServerMessagesWithOwnStream = (
  serverMessages: UIMessage[],
  conversationId: string | null,
  /** This chat's current useChat array — the test for "are we the ones producing this stream". */
  localMessages: readonly { id: string }[],
): UIMessage[] => {
  if (!conversationId) return serverMessages;
  const ownStream = Array.from(usePendingStreamsStore.getState().streams.values())
    .find((s) => s.isOwn && s.conversationId === conversationId);
  if (!ownStream) return serverMessages;
  // Not in our array => not locally produced (a bootstrapped rejoin). See above: merging would
  // freeze its bubble, and not merging cannot mislead the mirror.
  if (!localMessages.some((m) => m.id === ownStream.messageId)) return serverMessages;
  return mergeServerAndPending(serverMessages, ownStream.parts, ownStream.messageId, ownStream.startedAt);
};
