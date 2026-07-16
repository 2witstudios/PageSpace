import type { PendingStreamsMap } from '@/stores/pendingStreams/applyAddStream';

/**
 * The three facts the stop/streaming machinery needs about a conversation's live stream.
 *
 * A PROJECTION of the store entry, deliberately not the entry itself: `parts` grows on every
 * token, so handing consumers the entry would give them a new reference per token. Every field
 * here is a primitive and fixed for the stream's life, so a shallow-compared selector over this
 * is stable from the stream's first chunk to its last.
 */
export interface ActiveStream {
  /** The stable, server-issued assistant messageId — the name an abort should use. */
  messageId: string;
  /** The conversation the stream was started in. Latched by the store at stream_start. */
  conversationId: string;
  /** Whether this browser context started it (own-mirrored or own-bootstrapped). */
  isOwn: boolean;
}

/**
 * Answers "is a stream live for this conversation, and what is its identity" by READING
 * `usePendingStreamsStore` — replacing three parallel projections of the same fact: the
 * GlobalChatContext stop-slot claim protocol, the dashboard store's
 * `streamingAgentIds`/`agentStops` slots, and GlobalAssistantView's four direct-writer sync
 * effects.
 *
 * WHY A SELECTOR AND NOT A SLOT.
 *
 * Every one of those mechanisms had to decide WHO was allowed to answer, because a slot holds
 * one answer and several co-mounted surfaces wanted to write it. That decision is what
 * `shouldClaimGlobalStopSlot`/`shouldClaimAgentStopSlot` existed for, and getting it wrong
 * produced the whole "slot belongs to somebody else" bug family — including the known gap at
 * useAgentChannelMultiplayer:110-116, where a surface that declined a claim never re-claimed
 * the slot once it was freed, leaving a live stream with no Stop button at all.
 *
 * Selectors don't claim. Any number of surfaces can read this concurrently and all get the same
 * answer, so that entire class is fixed by construction.
 *
 * WHY THE STORE ENTRY IS THE HELD IDENTITY (what `holdForStream` used to do with refs).
 *
 * `useChat` only rebuilds its Chat when its `id` changes, and every surface here passes a
 * constant id — so switching conversation mid-stream does NOT abort the running POST. The
 * stream keeps running while the surface moves out from under it. `holdForStream` handled that
 * by latching the stream's conversation/messageId into refs on the first streaming render and
 * holding them.
 *
 * The store entry already IS that latch: `{messageId, conversationId, isOwn}` is written once at
 * stream_start — by the socket for bootstrapped/remote streams, and by `useOwnStreamMirror` for
 * this tab's own local POST, which latches the identity on the RISING EDGE of the send (see that
 * hook: reading the surface's live conversation there recorded a stream under wherever the user
 * had since navigated). Neither follows the surface afterwards. Reading it back by conversation
 * therefore gives the STREAM's identity, not the surface's — which is exactly what Stop must name.
 *
 * SCOPE. By page AND conversation, following PR 4's `useActiveStream` facade rather than the
 * board's `selectActiveStream(conversationId)` shorthand: a channel carries every conversation
 * on it, and both callers already hold their channel id (the global channel id, or the agent's
 * page id). Scoping to both keeps the read inside the channel the surface is actually attached
 * to. See the board note on leaf 5.5.2.
 */
export const selectActiveStream = (
  streams: PendingStreamsMap,
  { pageId, conversationId }: { pageId: string | null; conversationId: string | null },
): ActiveStream | undefined => {
  if (!pageId || !conversationId) return undefined;

  let remote: ActiveStream | undefined;

  for (const stream of streams.values()) {
    if (stream.pageId !== pageId) continue;
    if (stream.conversationId !== conversationId) continue;

    const projected: ActiveStream = {
      messageId: stream.messageId,
      conversationId: stream.conversationId,
      isOwn: stream.isOwn,
    };

    // Own wins outright, whatever the insertion order: ours is the one whose local fetch we can
    // also cancel, and on a shared conversation a remote stream must never be what this tab's
    // Stop button names.
    if (stream.isOwn) return projected;
    remote ??= projected;
  }

  return remote;
};
