/**
 * Tracks which (channel, conversation) pairs this browser context is currently consuming an AI
 * stream body for, over the HTTP POST response (i.e. via `useChat`'s fetch).
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
 * SCOPED PER CONVERSATION, not per channel. Concurrent streams across conversations are a
 * supported feature, and multiple conversations share one channel (every global conversation
 * lives on the user's personal channel; every page-agent conversation lives on the page's
 * channel). A channel-wide mark meant that while conversation B's POST was being read, the
 * socket also declined to attach conversation A's still-running own stream — and since the AI
 * SDK's `Chat` cannot consume two response bodies at once, nothing else could render A. The
 * send handoff (`useConversationSendHandoff`) relies on the socket attaching the handed-off
 * conversation's stream, which is only possible when "consuming" names the conversation
 * actually being read, not the whole channel.
 *
 * `conversationId: undefined` on a mark is the channel-wide sentinel — the pre-scoping
 * semantics, kept for callers whose POST body carries no conversationId. A sentinel mark makes
 * EVERY conversation on the channel report consuming; an undefined conversationId on the
 * `isChannelConsuming` side likewise matches ANY live mark on the channel. Both directions are
 * deliberately conservative: the failure mode of over-reporting is a briefly missing attach,
 * the failure mode of under-reporting is every token rendered twice.
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

/**
 * Inner-map key for a mark that names no conversation (channel-wide, pre-scoping semantics).
 * The NUL prefix keeps it outside the conversation-id namespace.
 */
const CHANNEL_WIDE = '\u0000channel-wide';

/** channelId → (conversationId | CHANNEL_WIDE) → refcount. */
const consumerCounts = new Map<string, Map<string, number>>();

export const markChannelConsuming = (channelId: string, conversationId?: string): void => {
  const key = conversationId ?? CHANNEL_WIDE;
  const channel = consumerCounts.get(channelId) ?? new Map<string, number>();
  channel.set(key, (channel.get(key) ?? 0) + 1);
  consumerCounts.set(channelId, channel);
};

/**
 * Release one consumer. The caller must guarantee exactly one release per mark, WITH THE SAME
 * `conversationId` the mark used — `createStreamTrackingFetch` does, via a once-only guard on
 * the response body and a conversationId captured from the request body at mark time.
 */
export const unmarkChannelConsuming = (channelId: string, conversationId?: string): void => {
  const key = conversationId ?? CHANNEL_WIDE;
  const channel = consumerCounts.get(channelId);
  if (!channel) return;
  const next = (channel.get(key) ?? 0) - 1;
  if (next > 0) {
    channel.set(key, next);
    return;
  }
  channel.delete(key);
  if (channel.size === 0) consumerCounts.delete(channelId);
};

/**
 * Is this browser context reading a POST body for this conversation (or one that could be it)?
 *
 * True when the exact (channel, conversation) pair is marked, when a channel-wide sentinel mark
 * exists, or — when the caller itself has no conversationId to ask about — when ANY mark on the
 * channel is live. See the module docblock for why the fuzzy directions are conservative.
 */
export const isChannelConsuming = (channelId: string, conversationId?: string): boolean => {
  const channel = consumerCounts.get(channelId);
  if (!channel) return false;
  if ((channel.get(CHANNEL_WIDE) ?? 0) > 0) return true;
  if (conversationId === undefined) return channel.size > 0;
  return (channel.get(conversationId) ?? 0) > 0;
};

/** Test-only reset; module state otherwise leaks across cases. */
export const resetConsumingChannels = (): void => {
  consumerCounts.clear();
};
