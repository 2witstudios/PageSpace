/**
 * Lets an unmounting `useChannelStreamSocket` instance hand off live consumption to a
 * still-mounted sibling on the same channel (review finding, PR #2312, P1 —
 * chatgpt-codex-connector).
 *
 * `startConsume` is claim-gated (`bootstrapConsumerGuard.ts`): only ONE co-mounted
 * instance per channel ever holds the actual SSE join for a given messageId. The
 * subscriber refcount in `channelStreamSubscribers.ts` stops the STORE from being
 * wiped when that instance unmounts and a sibling remains — but does nothing about
 * the live connection itself. Without this, the sibling's copy of the stream just
 * stops receiving new tokens (frozen) the moment the claim-holder goes away, with no
 * repair until the eventual `chat:stream_complete` broadcast.
 *
 * Each mounted instance registers its own re-bootstrap trigger here; an unmounting
 * instance that WAS actively consuming something (non-empty `controllers`) notifies
 * every remaining registered sibling to re-run bootstrap. `runBootstrap` is already
 * idempotent (`claimBootstrapConsumer` + `shouldSkipBootstrappedStream`) and routinely
 * re-run on every mounted instance on reconnect — notifying several siblings at once
 * is the same pattern, not a new risk. Exactly one of them wins the now-released claim.
 */

const rebootstrapCallbacks = new Map<string, Set<() => void>>();

/** Register `callback` (typically `() => bootstrapRef.current?.()`) to run when a sibling on `channelId` hands off consumption. */
export function registerChannelRebootstrap(channelId: string, callback: () => void): void {
  const callbacks = rebootstrapCallbacks.get(channelId) ?? new Set<() => void>();
  callbacks.add(callback);
  rebootstrapCallbacks.set(channelId, callbacks);
}

export function unregisterChannelRebootstrap(channelId: string, callback: () => void): void {
  const callbacks = rebootstrapCallbacks.get(channelId);
  if (!callbacks) return;
  callbacks.delete(callback);
  if (callbacks.size === 0) rebootstrapCallbacks.delete(channelId);
}

/** Notify every remaining registered subscriber on `channelId` to re-bootstrap. Call AFTER unregistering the caller's own callback. */
export function notifyRemainingChannelSubscribers(channelId: string): void {
  const callbacks = rebootstrapCallbacks.get(channelId);
  if (!callbacks) return;
  for (const callback of callbacks) callback();
}

/** Test-only reset; module state otherwise leaks across cases. */
export function resetChannelRebootstrapSignal(): void {
  rebootstrapCallbacks.clear();
}
