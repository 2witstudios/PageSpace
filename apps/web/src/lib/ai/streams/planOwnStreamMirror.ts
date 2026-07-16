import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

// TRANSITIONAL — see the Deletion covenant (pagespace kw69qhfck96jpssdk6w2xtbp):
// this module exists only because useChat remains the transport until
// WorkflowChatTransport lands. It is deleted (not ported) at that swap, along
// with useOwnStreamMirror and every other "TRANSITIONAL" marker in this repo
// (`grep -rn "TRANSITIONAL" apps/web/src` is the deletion gate).

export type OwnStreamMirrorStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * Everything about a stream that is fixed the moment the user hits Send, LATCHED by the caller at
 * the rising edge of the send and handed to this planner as one value.
 *
 * It is a parameter rather than something derived here because a pure function cannot see when the
 * send happened — only the caller (`useOwnStreamMirror`) can. See `planOwnStreamMirror` for why
 * reading these live is a billing bug.
 */
export interface OwnStreamIdentity {
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string };
  startedAt: string;
}

export interface PlanOwnStreamMirrorInput {
  status: OwnStreamMirrorStatus;
  /** The own tab's live assistant message (useChat's local state), or undefined. */
  ownAssistantMessage: { id: string; parts: UIMessagePart[] } | undefined;
  /** The messageId this mirror latched for the CURRENT send, or undefined if it hasn't yet. */
  mirroredMessageId: string | undefined;
  /**
   * Whether `mirroredMessageId` is still PRESENT in the store. Ignored until an id is latched.
   *
   * The store is not this mirror's private state — `useChannelStreamSocket`'s cleanup calls
   * `clearPageStreams(channelId)` on every re-run of its effect, and a routine `auth:refreshed`
   * mints a new socket, so an ordinary token refresh wipes the channel mid-stream. See the
   * re-assert branch below.
   */
  mirroredEntryExists: boolean;
  /** Latched at the rising edge of this send — never read live. */
  streamIdentity: OwnStreamIdentity;
  /** Caller-tracked monotonic counter, bumped once per mirror tick — threaded into `setStreamParts`'s `seq` gate. */
  seq: number;
}

export type OwnStreamMirrorOp =
  | {
      type: 'addStream';
      stream: {
        messageId: string;
        pageId: string;
        conversationId: string;
        triggeredBy: { userId: string; displayName: string };
        isOwn: true;
        startedAt: string;
      };
    }
  | { type: 'setStreamParts'; messageId: string; parts: UIMessagePart[]; seq: number }
  | { type: 'removeStream'; messageId: string };

/**
 * Is this tab's own local request in flight?
 *
 * The STATUS alone answers this — deliberately NOT "is there an assistant message on screen".
 * Those are different questions, and conflating them cost a live stream twice:
 *
 *  - An external `setMessages()` (a surface loading another conversation's history, or clearing
 *    the array on agent deselect) empties or replaces the array mid-send. Reading the array as
 *    liveness turned that into "the stream ended" and removed a stream still generating
 *    server-side — where a local stop would not have stopped it anyway.
 *  - useChat retains the completed assistant message in local history after a stream finishes, so
 *    the array still says "assistant message present" long after 'ready'. That is why 'ready' and
 *    'error' end the send here regardless of what the array holds.
 */
export const isOwnStreamSending = (status: OwnStreamMirrorStatus): boolean =>
  status === 'submitted' || status === 'streaming';

/**
 * Computes the idempotent `usePendingStreamsStore` ops needed to mirror the own tab's actively
 * streaming assistant message. Pure — the caller (`useOwnStreamMirror`) applies the returned ops
 * via the store's own (already-idempotent) actions, so calling this repeatedly with the same or
 * stale input is always safe: `addStream` no-ops on an existing id, `setStreamParts` no-ops on a
 * non-advancing `seq`, `removeStream` no-ops on an absent id.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT TRUST, because the store entry it writes IS what every
 * surface's Stop button and streaming indicator read (PR 5A deleted the `holdForStream` refs that
 * used to hold this identity separately). Get either wrong and Stop names the wrong stream — or
 * nothing — while the real generation keeps running its write tools and keeps BILLING, with the
 * UI showing Send.
 *
 * 1. THE SURFACE'S CURRENT CONVERSATION. `useChat`'s id is constant per surface, so switching
 *    conversation mid-flight does NOT abort the POST: the stream keeps running while the surface
 *    moves out from under it. A send in C followed by a switch to D inside the 0.5-3s TTFB window
 *    would otherwise record C's stream under D. Hence `streamIdentity`, latched at the send.
 *
 * 2. A CHANGE OF ASSISTANT MESSAGE ID MID-SEND. Within one send the mirrored id is latched, and a
 *    DIFFERENT id means the array moved under us (a surface's load-on-select calling
 *    `setMessages(<other conversation's history>)`, whose last entry is typically an assistant
 *    message), not that a new stream started — a new stream needs a new send, which passes through
 *    'ready' and clears the latch. Re-targeting would remove OUR live stream and add a PHANTOM one
 *    on a message that finished long ago, whose Stop reports not_found and is silent by design.
 */
export const planOwnStreamMirror = (input: PlanOwnStreamMirrorInput): OwnStreamMirrorOp[] => {
  // The send is over: release whatever this mirror latched. The local read is what this entry
  // represents, and it has ended.
  if (!isOwnStreamSending(input.status)) {
    return input.mirroredMessageId !== undefined
      ? [{ type: 'removeStream', messageId: input.mirroredMessageId }]
      : [];
  }

  // Sending, but the SDK has not pushed the assistant message yet (the whole submitted window), or
  // something cleared the array under us. Either way there is nothing new to write — and nothing
  // to remove, because the send is still in flight.
  if (!input.ownAssistantMessage) return [];

  const { id, parts } = input.ownAssistantMessage;

  // The array moved under us — see (2) above. Hold what we latched, and do NOT adopt this message
  // even if the store has no entry: absent + different id is still not ours.
  if (input.mirroredMessageId !== undefined && input.mirroredMessageId !== id) return [];

  // Either the first assistant message of this send, or our own latched one whose entry has since
  // been wiped from the store by someone else (clearPageStreams on a socket swap — see
  // `mirroredEntryExists`). Both want the same thing: assert the stream, under the identity
  // latched when the user hit Send.
  //
  // Re-asserting is free in the normal case — `applyAddStream` no-ops on an id that is present —
  // and it is the only way back for a wiped entry, because `applySetStreamParts` no-ops when the
  // entry is absent, so a parts-only write would silently do nothing for the rest of the send.
  //
  // Nothing else restores it: the socket's DB bootstrap re-runs after the wipe but DECLINES its
  // own consuming stream by design (`shouldAttachStream({isOwn, isConsuming})` — attaching would
  // render every token twice), so the one entry that needs restoring is exactly the one bootstrap
  // will not restore.
  //
  // KNOWN, ACCEPTED INTERACTION: `chat:stream_complete` removes the entry with no isOwn skip
  // (useChannelStreamSocket), and it can land while this tab's useChat is still draining the tail
  // of the response body — i.e. still 'streaming'. This branch then re-adds the entry for that
  // tail, and the falling edge removes it again when the local read ends. That is bounded by the
  // tail and is not a phantom: while the local chat is still delivering content, the stream IS
  // live for this tab, which is exactly what the entry means.
  if (input.mirroredMessageId === undefined || !input.mirroredEntryExists) {
    return [
      {
        type: 'addStream',
        stream: {
          messageId: id,
          pageId: input.streamIdentity.pageId,
          conversationId: input.streamIdentity.conversationId,
          triggeredBy: input.streamIdentity.triggeredBy,
          isOwn: true,
          startedAt: input.streamIdentity.startedAt,
        },
      },
      { type: 'setStreamParts', messageId: id, parts, seq: input.seq },
    ];
  }

  return [{ type: 'setStreamParts', messageId: id, parts, seq: input.seq }];
};
