import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

// TRANSITIONAL — see the Deletion covenant (pagespace kw69qhfck96jpssdk6w2xtbp):
// this module exists only because useChat remains the transport until
// WorkflowChatTransport lands. It is deleted (not ported) at that swap, along
// with useOwnStreamMirror and every other "TRANSITIONAL" marker in this repo
// (`grep -rn "TRANSITIONAL" apps/web/src` is the deletion gate).

export type OwnStreamMirrorStatus = 'submitted' | 'streaming' | 'ready' | 'error';

export interface PlanOwnStreamMirrorInput {
  status: OwnStreamMirrorStatus;
  /** The own tab's live assistant message (useChat's local state), or undefined when not actively streaming. */
  ownAssistantMessage: { id: string; parts: UIMessagePart[] } | undefined;
  /** The messageId `usePendingStreamsStore` currently mirrors for this tab, or undefined. */
  mirroredMessageId: string | undefined;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string };
  startedAt: string;
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
 * Computes the idempotent `usePendingStreamsStore` ops needed to mirror the
 * own tab's actively-streaming assistant message. Pure — the caller (
 * `useOwnStreamMirror`) applies the returned ops via the store's own
 * (already-idempotent) actions, so calling this repeatedly with the same or
 * stale input is always safe: `addStream` no-ops on an existing id,
 * `setStreamParts` no-ops on a non-advancing `seq`, `removeStream` no-ops on
 * an absent id.
 */
export const planOwnStreamMirror = (input: PlanOwnStreamMirrorInput): OwnStreamMirrorOp[] => {
  const isActive =
    (input.status === 'submitted' || input.status === 'streaming') && input.ownAssistantMessage !== undefined;

  if (!isActive) {
    return input.mirroredMessageId !== undefined
      ? [{ type: 'removeStream', messageId: input.mirroredMessageId }]
      : [];
  }

  const { id, parts } = input.ownAssistantMessage as { id: string; parts: UIMessagePart[] };
  const ops: OwnStreamMirrorOp[] = [];

  if (input.mirroredMessageId !== id) {
    if (input.mirroredMessageId !== undefined) {
      ops.push({ type: 'removeStream', messageId: input.mirroredMessageId });
    }
    ops.push({
      type: 'addStream',
      stream: {
        messageId: id,
        pageId: input.pageId,
        conversationId: input.conversationId,
        triggeredBy: input.triggeredBy,
        isOwn: true,
        startedAt: input.startedAt,
      },
    });
  }

  ops.push({ type: 'setStreamParts', messageId: id, parts, seq: input.seq });

  return ops;
};
