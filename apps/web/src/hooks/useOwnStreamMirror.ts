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
  /** The own tab's live assistant message (useChat's local state), or undefined when not actively streaming. */
  ownAssistantMessage: { id: string; parts: UIMessage['parts'] } | undefined;
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
  ownAssistantMessage,
  pageId,
  conversationId,
  triggeredBy,
}: UseOwnStreamMirrorInput): void => {
  const mirroredIdRef = useRef<string | undefined>(undefined);
  const identityRef = useRef<OwnStreamIdentity | undefined>(undefined);

  // Read inside the effect without making the effect depend on them: they are captured only on the
  // rising edge, so a later change must NOT re-run anything — that is the point of latching.
  const liveRef = useRef({ pageId, conversationId, triggeredBy });
  liveRef.current = { pageId, conversationId, triggeredBy };

  useEffect(() => {
    const sending = isOwnStreamSending(status);

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

    const ops = planOwnStreamMirror({
      status,
      ownAssistantMessage,
      mirroredMessageId: mirroredIdRef.current,
      streamIdentity: identity,
      seq,
    });

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
      return;
    }

    // Latch the first assistant id of this send, and only the first: a later DIFFERENT id means an
    // external setMessages() replaced the array, not that a new stream began (see
    // planOwnStreamMirror). Holding the first is what keeps the live stream's entry intact.
    if (mirroredIdRef.current === undefined && ownAssistantMessage !== undefined) {
      mirroredIdRef.current = ownAssistantMessage.id;
    }
    // Deliberately depends on ownAssistantMessage's id/parts and NOT on pageId/conversationId/
    // triggeredBy: those are latched on the rising edge above and read through liveRef, so a
    // surface that moves mid-stream must not re-run this. Depending on the message OBJECT is also
    // avoided — a caller building `{id, parts}` from useChat's live message constructs a fresh
    // wrapper every render, while useChat only replaces `parts` with a new array reference on a
    // genuine content update (ai/dist/index.mjs's ReactChatState.replaceMessage clones on write).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, ownAssistantMessage?.id, ownAssistantMessage?.parts]);
};
