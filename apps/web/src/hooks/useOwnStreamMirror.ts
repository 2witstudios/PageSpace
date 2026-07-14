import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { planOwnStreamMirror, type OwnStreamMirrorStatus } from '@/lib/ai/streams/planOwnStreamMirror';

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
 * Applies `planOwnStreamMirror`'s ops to `usePendingStreamsStore` on every
 * relevant change. All the decision logic lives in the pure, exhaustively
 * tested `planOwnStreamMirror` — this hook only tracks the per-tab mutable
 * bookkeeping (the currently-mirrored id, when the stream started) that a
 * pure function cannot own itself, and applies the resulting ops via the
 * store's own idempotent actions.
 */
export const useOwnStreamMirror = ({
  status,
  ownAssistantMessage,
  pageId,
  conversationId,
  triggeredBy,
}: UseOwnStreamMirrorInput): void => {
  const mirroredIdRef = useRef<string | undefined>(undefined);
  const startedAtRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (ownAssistantMessage && mirroredIdRef.current !== ownAssistantMessage.id) {
      startedAtRef.current = new Date().toISOString();
    }

    const store = usePendingStreamsStore.getState();
    // seq = max(wall-clock millis, storedLastSeq + 1): wall-clock alone can
    // repeat within the same millisecond (two mirror ticks for fast local
    // streams, or a tick right at a remount), and applySetStreamParts drops
    // any write with seq <= lastSeq — a repeat would silently lose that
    // chunk. Reading the store's current lastSeq as a floor and requiring
    // strictly-greater guarantees monotonic progress regardless of clock
    // resolution, while still being immune to this hook remounting mid-
    // stream (unlike a local incrementing ref, which would restart at 0/1
    // and have every write from the new instance rejected as stale against
    // the previous instance's already-higher lastSeq).
    const relevantId = ownAssistantMessage?.id ?? mirroredIdRef.current;
    const storedLastSeq = (relevantId && store.streams.get(relevantId)?.lastSeq) || 0;
    const seq = Math.max(Date.now(), storedLastSeq + 1);

    const ops = planOwnStreamMirror({
      status,
      ownAssistantMessage,
      mirroredMessageId: mirroredIdRef.current,
      pageId,
      conversationId,
      triggeredBy,
      startedAt: startedAtRef.current ?? new Date().toISOString(),
      seq,
    });

    for (const op of ops) {
      if (op.type === 'addStream') store.addStream(op.stream);
      else if (op.type === 'setStreamParts') store.setStreamParts(op.messageId, op.parts, op.seq);
      else store.removeStream(op.messageId);
    }

    mirroredIdRef.current = ownAssistantMessage?.id;
    // Deliberately depend on ownAssistantMessage's id/parts and triggeredBy's
    // fields rather than the objects themselves: a caller building these from
    // useChat's live message will construct a fresh `{id, parts}` wrapper on
    // every render even when content hasn't changed, and useChat only
    // replaces `parts` with a new array reference on a genuine content update
    // (ai/dist/index.mjs's ReactChatState.replaceMessage clones on write) —
    // depending on the object itself would re-run this effect (and bump seq,
    // triggering a store write) on every unrelated parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, ownAssistantMessage?.id, ownAssistantMessage?.parts, pageId, conversationId, triggeredBy.userId, triggeredBy.displayName]);
};
