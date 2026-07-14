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

    const ops = planOwnStreamMirror({
      status,
      ownAssistantMessage,
      mirroredMessageId: mirroredIdRef.current,
      pageId,
      conversationId,
      triggeredBy,
      startedAt: startedAtRef.current ?? new Date().toISOString(),
      // Date.now() rather than a local incrementing ref: the store's
      // `lastSeq` gate (applySetStreamParts) is keyed globally per messageId
      // and survives across this hook remounting mid-stream (e.g. a parent
      // re-key or Suspense reset while the same message is still streaming).
      // A per-mount ref would restart at 0/1 on remount and have every write
      // rejected as stale (seq <= the previous mount's already-higher
      // lastSeq), freezing the mirrored stream until it ends. Wall-clock
      // millis are monotonic across the whole process, independent of any
      // single component instance's lifecycle.
      seq: Date.now(),
    });

    const store = usePendingStreamsStore.getState();
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
