/**
 * Tracks how many `useChannelStreamSocket` instances are currently subscribed to each
 * channel, so its cleanup can call `usePendingStreamsStore.clearPageStreams(channelId)`
 * only when the LAST subscriber for that channel goes away — not on every subscriber's
 * own unmount/dep-change.
 *
 * Right sidebar / global-assistant surfaces are effectively singletons (one
 * `GlobalChatProvider` mount for the whole session, at most one subscriber per
 * channel), so this was invisible there. Agent panes are not: the same agent can be
 * open in multiple panes at once by design (`select-pane-agent.ts`), each mounting its
 * own `useChannelStreamSocket` instance on the same channelId. Without this, closing
 * or reassigning ONE such pane wiped every stream on that channel — including a
 * sibling pane's still-mid-generation own stream.
 *
 * Same refcounted-Map shape as `consumingChannels.ts`/`bootstrapConsumerGuard.ts`
 * (sibling problems, same codebase, same pattern) — module-level state, no production
 * reset on logout (logout is a soft `router.push`, not a hard reload). Harmless here:
 * the count tracks "how many subscriber instances are mounted," not "which user," so
 * it stays correct across a user switch in the same tab.
 */

const subscriberCounts = new Map<string, number>();

export function registerChannelStreamSubscriber(channelId: string): void {
  subscriberCounts.set(channelId, (subscriberCounts.get(channelId) ?? 0) + 1);
}

/** Returns true iff this was the last subscriber for `channelId` (count reached 0). */
export function unregisterChannelStreamSubscriber(channelId: string): boolean {
  const next = (subscriberCounts.get(channelId) ?? 0) - 1;
  if (next > 0) {
    subscriberCounts.set(channelId, next);
    return false;
  }
  subscriberCounts.delete(channelId);
  return true;
}

export function getChannelStreamSubscriberCount(channelId: string): number {
  return subscriberCounts.get(channelId) ?? 0;
}

/** Test-only reset; module state otherwise leaks across cases. */
export function resetChannelStreamSubscribers(): void {
  subscriberCounts.clear();
}
