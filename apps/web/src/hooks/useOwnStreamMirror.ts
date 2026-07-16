import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import {
  planOwnStreamMirror,
  isOwnStreamSending,
  type OwnStreamIdentity,
  type OwnStreamMirrorStatus,
} from '@/lib/ai/streams/planOwnStreamMirror';

// TRANSITIONAL — see the Deletion covenant (pagespace kw69qhfck96jpssdk6w2xtbp):
// this hook exists only because useChat remains the transport until
// WorkflowChatTransport lands, at which point the transport adapter feeds
// usePendingStreamsStore directly and this hook is deleted (not ported).
// Deletion gate: `grep -rn "TRANSITIONAL" apps/web/src` must return zero.

export interface UseOwnStreamMirrorInput {
  status: OwnStreamMirrorStatus;
  /**
   * This chat's ENTIRE message array (useChat's local state) — not a pre-picked message.
   *
   * The hook selects its own stream out of it, because "which message is mine" is exactly what
   * callers kept getting wrong: taking `messages[last]` when it is an assistant works only until
   * something else appends. On a shared conversation something else does — `chat:stream_complete`
   * carries no own-stream filter, so AiChatView appends a COLLABORATOR's finished message after
   * ours, same conversation, surface unmoved. Once an id is latched the hook finds our message BY
   * THAT ID, so a foreign message can land anywhere without displacing our stream.
   */
  ownMessages: readonly { id: string; role: string; parts: UIMessage['parts'] }[];
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string };
}

/**
 * Applies `planOwnStreamMirror`'s ops to `usePendingStreamsStore` on every relevant change. All the
 * decision logic lives in the pure, exhaustively tested `planOwnStreamMirror` — this hook owns only
 * the per-tab mutable bookkeeping a pure function cannot: WHEN the send started, and what was true
 * at that instant.
 *
 * MOUNT ONE PER useChat INSTANCE, never one for a "mode-selected" pair. A mirror is bound to a
 * chat; pointing it at whichever chat is on screen makes a mode switch silently repoint it, and it
 * then releases the stream it had been mirroring.
 *
 * WHY THE IDENTITY IS LATCHED HERE.
 *
 * `pageId`/`conversationId` arrive as LIVE props — they follow the surface. The stream does not:
 * useChat's id is constant, so switching conversation mid-flight does not abort the POST. Passing
 * them straight through recorded a stream under wherever the surface had wandered to by the time
 * the first chunk landed (a real 0.5-3s window). The store entry is what every Stop button reads
 * post-PR-5A, so that mis-naming means Stop aborts the wrong conversation or nothing at all while
 * the generation keeps running its write tools and keeps billing.
 *
 * So: latch on the RISING EDGE of the send — the moment status becomes submitted/streaming, which
 * is the moment the user hit Send and the surface is still, by construction, on the conversation
 * being sent to. Hold it for the send; release on the falling edge.
 */
export const useOwnStreamMirror = ({
  status,
  ownMessages,
  pageId,
  conversationId,
  triggeredBy,
}: UseOwnStreamMirrorInput): void => {
  const mirroredIdRef = useRef<string | undefined>(undefined);
  const identityRef = useRef<OwnStreamIdentity | undefined>(undefined);
  // The content we last mirrored for the latched id. Needed only to restore a wiped entry after the
  // message has left the surface's array, where `ownAssistantMessage` can no longer supply it.
  const lastPartsRef = useRef<UIMessage['parts']>([]);

  // Read inside the effect without making the effect depend on them: they are captured only on the
  // rising edge, so a later change must NOT re-run anything — that is the point of latching.
  const liveRef = useRef({ pageId, conversationId, triggeredBy });
  liveRef.current = { pageId, conversationId, triggeredBy };

  // SUBSCRIBE to our own entry's presence, rather than reading it once per useChat tick.
  //
  // The store is shared and a third party can wipe our live entry — `useChannelStreamSocket`'s
  // cleanup runs `clearPageStreams(channelId)` whenever its effect re-runs, and both a token
  // refresh and a reconnect after a network blip mint a new socket. Driving the repair off useChat
  // ticks meant the wipe went unrepaired until the NEXT part arrived, which during a tool call is
  // tens of seconds of no parts at all: `activeStream` undefined and the pendingSend long handed
  // off, so the UI showed Send while the generation ran its write tools and billed, and Stop
  // resolved to 'none'. The wipe itself has to drive the re-assert.
  const mirroredEntryExists = usePendingStreamsStore((state) => {
    const id = mirroredIdRef.current;
    return id !== undefined && state.streams.has(id);
  });

  useEffect(() => {
    const sending = isOwnStreamSending(status);

    // WHICH MESSAGE IS MINE. Once an id is latched, ours is the one carrying it — wherever it sits
    // in the array. Only before the first latch (or after our message has genuinely left the array,
    // e.g. the SDK replacing it to adopt the server-issued id) do we fall back to "the last message
    // if it is an assistant's", which is the only way to discover a stream we have not seen yet.
    const latchedId = mirroredIdRef.current;
    const latchedMessage = latchedId !== undefined
      ? ownMessages.find((m) => m.id === latchedId)
      : undefined;
    const lastMessage = ownMessages[ownMessages.length - 1];
    const lastAssistant = lastMessage?.role === 'assistant' ? lastMessage : undefined;
    const ownAssistantMessage = latchedMessage ?? lastAssistant;

    // Rising edge — the send. Capture what is true right now, and hold it.
    if (sending && identityRef.current === undefined) {
      const live = liveRef.current;
      identityRef.current = {
        pageId: live.pageId,
        conversationId: live.conversationId,
        triggeredBy: live.triggeredBy,
        startedAt: new Date().toISOString(),
      };
    }

    const identity = identityRef.current;
    // Not sending and never latched: nothing to write, nothing to release.
    if (identity === undefined) return;

    const store = usePendingStreamsStore.getState();
    // seq = max(wall-clock millis, storedLastSeq + 1): wall-clock alone can repeat within the same
    // millisecond (two mirror ticks for fast local streams, or a tick right at a remount), and
    // applySetStreamParts drops any write with seq <= lastSeq — a repeat would silently lose that
    // chunk. Reading the store's current lastSeq as a floor and requiring strictly-greater
    // guarantees monotonic progress regardless of clock resolution, while still being immune to
    // this hook remounting mid-stream (unlike a local incrementing ref, which would restart at 0/1
    // and have every write from the new instance rejected as stale against the previous instance's
    // already-higher lastSeq).
    const relevantId = ownAssistantMessage?.id ?? mirroredIdRef.current;
    const storedLastSeq = (relevantId && store.streams.get(relevantId)?.lastSeq) || 0;
    const seq = Math.max(Date.now(), storedLastSeq + 1);

    // Has the surface moved off the conversation this stream was sent from? That is what tells an
    // external setMessages() (a load-on-select for ANOTHER conversation) apart from the SDK
    // adopting the server-issued id for THIS stream. See planOwnStreamMirror (2).
    const surfaceStillOnStreamConversation = liveRef.current.conversationId === identity.conversationId;

    const ops = planOwnStreamMirror({
      status,
      ownAssistantMessage,
      surfaceStillOnStreamConversation,
      mirroredMessageId: mirroredIdRef.current,
      mirroredEntryExists,
      streamIdentity: identity,
      lastMirroredParts: lastPartsRef.current,
      seq,
    });

    // Latch the first assistant id of this send BEFORE applying the ops, and only the first: a
    // later DIFFERENT id means an external setMessages() replaced the array, not that a new stream
    // began (see planOwnStreamMirror). Holding the first is what keeps the live stream's entry
    // intact.
    //
    // BEFORE, because the ops below write to the store, and the `mirroredEntryExists` subscription
    // above reads this ref when the store notifies. Setting it afterwards meant the notification
    // from our own addStream was evaluated against a still-undefined ref, resolved to `false`
    // (unchanged), and never re-rendered — so the subscription latched at `false` for the whole
    // send and a later wipe could not re-run this effect. Ordering IS the subscription here.
    // Latch the first assistant id of this send — and re-latch when the SDK renames OUR stream
    // (same conversation, new server-issued id: planOwnStreamMirror (2b)). An id change while the
    // surface has MOVED is the array shifting under us, not a rename, and must not re-latch.
    if (
      sending &&
      ownAssistantMessage !== undefined &&
      (mirroredIdRef.current === undefined || surfaceStillOnStreamConversation)
    ) {
      mirroredIdRef.current = ownAssistantMessage.id;
    }
    // Retain the latched stream's content while the array still shows it.
    if (sending && ownAssistantMessage !== undefined && ownAssistantMessage.id === mirroredIdRef.current) {
      lastPartsRef.current = ownAssistantMessage.parts;
    }

    for (const op of ops) {
      if (op.type === 'addStream') store.addStream(op.stream);
      else if (op.type === 'setStreamParts') store.setStreamParts(op.messageId, op.parts, op.seq);
      else store.removeStream(op.messageId);
    }

    if (!sending) {
      // Falling edge — the send is over. Release both latches so the NEXT send starts clean: a
      // continuation reusing this same server-issued id (a real SDK behavior, pinned in
      // sdkServerIdAdoption.test.ts) must be able to re-mirror rather than look "already mirrored"
      // against an entry that has just been removed.
      mirroredIdRef.current = undefined;
      identityRef.current = undefined;
      lastPartsRef.current = [];
      return;
    }

    // Depends on `ownMessages` (useChat replaces the array on every genuine update — its
    // ReactChatState clones on write) and on `mirroredEntryExists` (so a third-party wipe of our
    // entry drives its own repair). NOT on pageId/conversationId/triggeredBy: those are latched on
    // the rising edge above and read through liveRef, so a surface that moves mid-stream must not
    // re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, ownMessages, mirroredEntryExists]);
};
