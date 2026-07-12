import { useCallback } from 'react';
import { abortActiveStream, reportAbortOutcome } from '@/lib/ai/core/client';

/**
 * Returns a memoized stop function: stop reading locally, then stop the SERVER-side generation —
 * which is the only one of the two that actually stops anything.
 *
 * WHAT IT NAMES.
 *
 * `conversationId` is what makes this able to stop anything at all in the windows that matter.
 * The `chatId` lookup is a client-side map (`activeStreams`) populated only once the response
 * HEADERS land — and a real agent send spends 0.5-3 seconds before that (auth, rate limit, DB
 * reads, context assembly, connecting to the provider). The same map is also torn down by the
 * surfaces' own conversation-change cleanups, which fire on a mid-stream switch. So on the two
 * paths a user is most likely to take — Stop right after Send, and Stop after switching
 * conversation — the map was EMPTY, the abort was a guaranteed no-op, and this cancelled the
 * local fetch and returned.
 *
 * The conversationId is the one name the client holds from t=0. Pass the STREAM's conversation,
 * held from when it started — never the live one — so a mid-stream switch still names the
 * generation that is actually running.
 *
 * WHAT ORDER IT RUNS IN, which is the opposite of what it looks like.
 *
 * This used to `await abortActiveStream(...)` inside a `try` and call `chatStop()` in a `finally`,
 * to guarantee the local stop ran even if the server call failed. But the server abort is no
 * longer instant: when the generation lives on another web instance, it now marks the stream and
 * WAITS to find out whether the owner actually stopped it. Awaiting that first would leave the
 * Stop button visibly hung for seconds, with tokens still rendering underneath it.
 *
 * So the local stop goes first. It is synchronous and purely local, and running it before the
 * await guarantees it strictly harder than the `finally` ever did.
 *
 * The server call is then awaited only to decide whether the user must be TOLD something.
 * `chatStop()` alone stops nothing on the server: streams are deliberately server-owned and
 * survive a client disconnect, so a stream we failed to abort is still generating, still calling
 * write tools, and still billing — even though this UI now says "Send".
 */
export function useChatStop(
  chatId: string | null,
  chatStop: () => void,
  conversationId?: string | null,
): () => Promise<void> {
  return useCallback(async () => {
    // Stops this client reading. Stops NOTHING on the server.
    chatStop();

    // No transport key, but we may still know which conversation is generating.
    const streamKey = chatId ?? conversationId;
    if (!streamKey) return;

    reportAbortOutcome(await abortActiveStream({ chatId: streamKey, conversationId }));
  }, [chatId, chatStop, conversationId]);
}
