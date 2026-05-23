/**
 * Module-level registry that prevents two co-mounted useChannelStreamSocket
 * instances from both consuming the same bootstrapped in-flight stream.
 *
 * On a page reload mid-stream, both the middle panel and sidebar call the
 * bootstrap API and find the same in-flight messageId. Without this guard,
 * both would call startConsume, doubling appendPart calls and producing
 * corrupted ghost text in usePendingStreamsStore.
 *
 * The claim is released on SSE resolve/reject and on unmount so that a
 * remounted surface can take over if the original consumer navigates away.
 */
const activeConsumers = new Set<string>();

export function claimBootstrapConsumer(messageId: string): boolean {
  if (activeConsumers.has(messageId)) return false;
  activeConsumers.add(messageId);
  return true;
}

export function releaseBootstrapConsumer(messageId: string): void {
  activeConsumers.delete(messageId);
}
