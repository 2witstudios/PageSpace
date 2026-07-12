/**
 * Tracks which channels this browser context is currently consuming an AI stream body
 * for, over the HTTP POST response (i.e. via `useChat`'s fetch).
 *
 * This is the ONLY thing that makes a live `chat:stream_start` event uninteresting to
 * the tab that triggered it: if `useChat` is already reading the tokens off the POST
 * body, joining the server multicast as well would render every token twice.
 *
 * The critical property is what happens on a reload: this is module state, so it is
 * **empty in a freshly-loaded document**. A reloaded tab is therefore no longer "the
 * originator" of anything and attaches to its own in-flight server stream like any
 * other subscriber. (The previous mechanism keyed off `getBrowserSessionId()`, which
 * reads `sessionStorage` and *survives* the reload — so a reloaded tab classified
 * itself as the originator forever and dropped its own stream on the floor.)
 *
 * REFCOUNTED, not a plain Set. Two surfaces can be co-mounted on the same channel and
 * both be streaming: GlobalAssistantView (agent mode) and SidebarChatTab (agent mode)
 * share `selectedAgent.id` as their channel while holding independent `useChat`
 * instances. With a Set, whichever response body finished first would clear the flag
 * for the other — which is still reading its own body — and the next reconnect
 * bootstrap would attach it to the multicast for a stream it is already rendering,
 * double-rendering every remaining token.
 *
 * Marked synchronously before the POST leaves the client and released exactly once
 * when the response body finishes — see `createStreamTrackingFetch`. Deliberately NOT
 * derived from `getActiveStreamId({chatId})`, which is only populated once the POST
 * response *headers* land and can lose the race against the server's
 * `broadcastAiStreamStart`.
 */
const consumerCounts = new Map<string, number>();

export const markChannelConsuming = (channelId: string): void => {
  consumerCounts.set(channelId, (consumerCounts.get(channelId) ?? 0) + 1);
};

/**
 * Release one consumer. The caller must guarantee exactly one release per mark —
 * `createStreamTrackingFetch` does, via a once-only guard on the response body.
 */
export const unmarkChannelConsuming = (channelId: string): void => {
  const next = (consumerCounts.get(channelId) ?? 0) - 1;
  if (next > 0) {
    consumerCounts.set(channelId, next);
    return;
  }
  consumerCounts.delete(channelId);
};

export const isChannelConsuming = (channelId: string): boolean =>
  (consumerCounts.get(channelId) ?? 0) > 0;

/** Test-only reset; module state otherwise leaks across cases. */
export const resetConsumingChannels = (): void => {
  consumerCounts.clear();
};
