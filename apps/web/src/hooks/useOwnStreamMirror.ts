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
 * bookkeeping (`seq`, the currently-mirrored id, when the stream started)
 * that a pure function cannot own itself, and applies the resulting ops via
 * the store's own idempotent actions.
 */
export const useOwnStreamMirror = ({
  status,
  ownAssistantMessage,
  pageId,
  conversationId,
  triggeredBy,
}: UseOwnStreamMirrorInput): void => {
  const seqRef = useRef(0);
  const mirroredIdRef = useRef<string | undefined>(undefined);
  const startedAtRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (ownAssistantMessage && mirroredIdRef.current !== ownAssistantMessage.id) {
      startedAtRef.current = new Date().toISOString();
    }
    seqRef.current += 1;

    const ops = planOwnStreamMirror({
      status,
      ownAssistantMessage,
      mirroredMessageId: mirroredIdRef.current,
      pageId,
      conversationId,
      triggeredBy,
      startedAt: startedAtRef.current ?? new Date().toISOString(),
      seq: seqRef.current,
    });

    const store = usePendingStreamsStore.getState();
    for (const op of ops) {
      if (op.type === 'addStream') store.addStream(op.stream);
      else if (op.type === 'setStreamParts') store.setStreamParts(op.messageId, op.parts, op.seq);
      else store.removeStream(op.messageId);
    }

    mirroredIdRef.current = ownAssistantMessage?.id;
  }, [status, ownAssistantMessage, pageId, conversationId, triggeredBy]);
};
