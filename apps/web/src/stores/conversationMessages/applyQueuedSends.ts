import type { UIMessage } from 'ai';

/**
 * The client-side send queue (issue #2676): messages typed while a response is
 * streaming, held until that stream's terminal event, then dispatched one per
 * turn, oldest first.
 *
 * This collection is a sibling of — never a part of — an entry's
 * `optimisticSends`. That separation is load-bearing: `promoteOptimisticSends`
 * promotes EVERYTHING in `optimisticSends` on stream commit, assuming each was
 * POSTed; a queued-but-never-POSTed message placed there would be promoted
 * into confirmed `messages` on somebody else's commit. Queued messages live
 * here until the moment the drain actually dispatches them, at which point the
 * drain's dispatch takes the ordinary optimistic path.
 *
 * The cap is a product decision, not a memory bound: an unbounded queue would
 * let a user pile up an hour of prompts against one slow turn and then fire
 * them all at the model, one per turn, with no way to see the cost. Ten with a
 * visible "full" state is enough to type ahead a reasonable burst.
 */
export const MAX_QUEUED_SENDS = 10;

/**
 * The most entries the queue can HOLD, as opposed to how many the user may
 * enqueue: the enqueue cap plus the one drained entry a rejected dispatch puts
 * back (`applyRequeueQueuedSend`). The user can top the queue back up to the cap
 * while that dispatch is in flight, and a rejection must still land — refusing it
 * would silently lose a prompt the queue already accepted. Enqueue refuses at
 * `MAX_QUEUED_SENDS`, and only one drained dispatch is in flight per
 * conversation, so this bound holds. Every truncation (restore, persist) uses it.
 */
export const MAX_HELD_QUEUED_SENDS = MAX_QUEUED_SENDS + 1;

export type QueuedSendsByConversationId = Record<string, UIMessage[]>;

export interface EnqueueQueuedSendEvent {
  conversationId: string;
  message: UIMessage;
}

/**
 * Appends to the conversation's queue in enqueue order (FIFO).
 *
 * No-ops — returning the SAME map object — when the queue is at
 * `MAX_QUEUED_SENDS`, or when the id already sits in it. The id check is the
 * idempotency backbone: ids are minted once at enqueue time and survive a
 * reload through persistence, so a restored queue re-enqueuing the same
 * entries (or a double dispatch racing a remove) must not duplicate.
 */
export const applyEnqueueQueuedSend = (
  queuedSendsByConversationId: QueuedSendsByConversationId,
  event: EnqueueQueuedSendEvent,
): QueuedSendsByConversationId => {
  const existing = queuedSendsByConversationId[event.conversationId] ?? [];
  if (existing.length >= MAX_QUEUED_SENDS) return queuedSendsByConversationId;
  if (existing.some((m) => m.id === event.message.id)) return queuedSendsByConversationId;

  return {
    ...queuedSendsByConversationId,
    [event.conversationId]: [...existing, event.message],
  };
};

export interface RemoveQueuedSendEvent {
  conversationId: string;
  messageId: string;
}

/**
 * Drops one queued message by id, preserving the order of the rest. No-ops
 * (same map object) when the conversation has no queue or the id is not in it.
 */
export const applyRemoveQueuedSend = (
  queuedSendsByConversationId: QueuedSendsByConversationId,
  event: RemoveQueuedSendEvent,
): QueuedSendsByConversationId => {
  const existing = queuedSendsByConversationId[event.conversationId];
  if (!existing) return queuedSendsByConversationId;
  const next = existing.filter((m) => m.id !== event.messageId);
  if (next.length === existing.length) return queuedSendsByConversationId;

  return {
    ...queuedSendsByConversationId,
    [event.conversationId]: next,
  };
};

/**
 * Drops the OLDEST entry — the one the drain dispatches next. No-ops (same
 * map object) when there is nothing to drop. The popped message is NOT
 * returned here; the store action reads it before shifting.
 */
export const applyShiftQueuedSend = (
  queuedSendsByConversationId: QueuedSendsByConversationId,
  conversationId: string,
): QueuedSendsByConversationId => {
  const existing = queuedSendsByConversationId[conversationId];
  if (!existing || existing.length === 0) return queuedSendsByConversationId;

  return {
    ...queuedSendsByConversationId,
    [conversationId]: existing.slice(1),
  };
};

/**
 * Empties the conversation's queue (tray "Clear all", and the double-ESC
 * interrupt). Unconditional — clearing an already-empty queue is a no-op in
 * effect but still writes an empty list, which is what the persistence layer
 * uses to drop the localStorage key.
 */
export const applyClearQueuedSends = (
  queuedSendsByConversationId: QueuedSendsByConversationId,
  conversationId: string,
): QueuedSendsByConversationId => ({
  ...queuedSendsByConversationId,
  [conversationId]: [],
});

/**
 * Puts a drained entry whose dispatch REJECTED back at the head of the queue, so
 * it is the next one out and the queue's order is unchanged. Bypasses the enqueue
 * cap (see `MAX_HELD_QUEUED_SENDS`) and no-ops (same map object) when the id is
 * already queued, so a racing restore cannot duplicate it.
 */
export const applyRequeueQueuedSend = (
  queuedSendsByConversationId: QueuedSendsByConversationId,
  event: EnqueueQueuedSendEvent,
): QueuedSendsByConversationId => {
  const existing = queuedSendsByConversationId[event.conversationId] ?? [];
  if (existing.some((m) => m.id === event.message.id)) return queuedSendsByConversationId;

  return {
    ...queuedSendsByConversationId,
    [event.conversationId]: [event.message, ...existing].slice(0, MAX_HELD_QUEUED_SENDS),
  };
};

export interface SetQueuedSendsEvent {
  conversationId: string;
  messages: UIMessage[];
}

/**
 * Replaces the conversation's queue wholesale — the restore-on-mount path.
 * Entries arrive exactly as persisted (their ids are the ones minted at
 * enqueue time and must survive untouched, so a re-dispatch after a reload is
 * idempotent against the server's upsert-by-id); anything past the cap is
 * truncated rather than dropped wholesale.
 */
export const applySetQueuedSends = (
  queuedSendsByConversationId: QueuedSendsByConversationId,
  event: SetQueuedSendsEvent,
): QueuedSendsByConversationId => ({
  ...queuedSendsByConversationId,
  [event.conversationId]: event.messages.slice(0, MAX_HELD_QUEUED_SENDS),
});
