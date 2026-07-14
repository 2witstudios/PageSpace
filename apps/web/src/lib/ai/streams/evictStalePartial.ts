import { isValidPartFrame } from './isValidPartFrame';

/**
 * Whether the server's checkpoint for a live stream has anything the bootstrap could actually
 * render — i.e. whether it is safe to evict the local partial in favour of it.
 *
 * Counted with `isValidPartFrame`, the SAME predicate the bootstrap seeds with: it is the
 * post-filter count that becomes `skipReplayCount`, and a `skipReplayCount` of 0 is exactly what
 * makes a failed SSE join drop the stream entirely. A raw `parts.length > 0` would call a
 * checkpoint of malformed frames "safe" while it in fact seeds nothing.
 *
 * Exported so callers can decide whether to write at all, without having to reproduce the rule.
 */
export const canEvictStalePartial = (serverParts: readonly unknown[] | undefined): boolean =>
  (serverParts ?? []).filter(isValidPartFrame).length > 0;

/**
 * Drops the half-streamed assistant bubble useChat is still holding for a run we are about to
 * rejoin — but only when the server has something to render in its place.
 *
 * WHY IT MUST BE DROPPED. `Chat.stop()` documents that it "keeps the generated tokens", and a
 * dropped fetch leaves them too, so `messages` still holds an assistant message whose id IS the
 * live stream's messageId (the server mints ONE id and uses it for the stream registry row, the
 * UI message, and the DB row alike). The rejoin re-adds that same stream to the pending store, and
 * both surfaces drop a pending stream whose messageId already appears in `messages`
 * (dedupRemoteStreams / ChatMessagesArea.visibleRemoteStreams). Leave the stale bubble in place
 * and the rejoined stream is filtered straight back out — not one token of it renders, and the
 * user sits in front of a frozen partial reply.
 *
 * WHY ONLY WHEN THE SERVER HAS PARTS. `serverParts` is the stream registry's DEBOUNCED checkpoint,
 * persisted every N parts, so it is empty for a stream that is only a few parts old. It is also
 * what the bootstrap seeds from — after the same isValidPartFrame filter — and a seed of zero
 * parts is exactly what makes a failed SSE join drop the stream entirely (the documented
 * multi-instance case, where the multicast lives in another process). Evict against an empty
 * checkpoint and lose the join, and the user is left with NOTHING: strictly worse than the frozen
 * partial. So the same predicate the bootstrap seeds with decides whether it is safe to evict.
 *
 * Returns `messages` unchanged (same reference) when it is not safe, so callers can pass this
 * straight to a setMessages updater without forcing a needless write.
 */
export const evictStalePartial = <T extends { id: string }>(
  messages: T[],
  liveMessageId: string,
  serverParts: readonly unknown[] | undefined,
): T[] => {
  // Self-guarding, so the rule holds even if a caller forgets to ask canEvictStalePartial first.
  if (!canEvictStalePartial(serverParts)) return messages;
  return messages.filter((m) => m.id !== liveMessageId);
};
