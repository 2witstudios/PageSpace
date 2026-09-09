/**
 * Merging a server-confirmed message into a list that may still hold the
 * optimistic row that produced it.
 *
 * This lives in one place on purpose. The channel and DM surfaces each grew
 * their own reconcile strategy, and that divergence is what let a bug survive
 * on one surface while the other looked fine: the channel view dropped EVERY
 * pending row on the first confirmation, while the DM page matched rows by
 * comparing (content, fileId) — which cannot tell two attachment-only messages
 * apart, because both have empty content.
 *
 * Both now match on a nonce the sender mints and the server echoes back on the
 * response and the broadcast, so one confirmation retires exactly one pending
 * row.
 */

interface OptimisticallySent {
  /** Optimistic rows carry a `temp-` prefixed id until the server confirms. */
  id: string;
  /** Set on an in-flight send and echoed back by the server. Never stored. */
  clientNonce?: string;
}

const isPending = (row: OptimisticallySent) => row.id.startsWith('temp-');

/**
 * Replace the pending row this message confirms, or append it if there is
 * none (which is the case for every other viewer in the channel).
 *
 * A message with no nonce, or whose nonce matches nothing, is appended unless
 * it is already present — so a re-delivered socket event is a no-op rather
 * than a duplicate.
 */
export function reconcileOptimistic<T extends OptimisticallySent>(prev: T[], message: T): T[] {
  const pendingIndex = message.clientNonce
    ? prev.findIndex((row) => isPending(row) && row.clientNonce === message.clientNonce)
    : -1;

  if (pendingIndex !== -1) {
    // Replace in place, so the message keeps its position in the stream rather
    // than jumping to the end. Any copy that already arrived by another route
    // (a refetch, say) is dropped in the same pass.
    return prev.reduce<T[]>((next, current, index) => {
      if (index !== pendingIndex && current.id === message.id) return next;
      next.push(index === pendingIndex ? message : current);
      return next;
    }, []);
  }

  if (prev.some((row) => row.id === message.id)) return prev;
  return [...prev, message];
}
