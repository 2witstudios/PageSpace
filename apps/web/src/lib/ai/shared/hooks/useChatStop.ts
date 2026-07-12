import { useCallback } from 'react';
import { abortActiveStream, reportAbortOutcome } from '@/lib/ai/core/client';

/**
 * Returns a memoized stop function: stop reading locally, then stop the SERVER-side generation —
 * which is the only one of the two that actually stops anything.
 *
 * ORDER MATTERS, and it is the opposite of what it looks like.
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
 * The server call is then awaited only to decide whether the user needs to be TOLD something.
 * `chatStop()` alone stops nothing on the server: streams are deliberately server-owned and
 * survive a client disconnect, so a stream we failed to abort is still generating, still calling
 * write tools, and still billing — even though this UI now says "Send".
 */
export function useChatStop(
  chatId: string | null,
  chatStop: () => void
): () => Promise<void> {
  return useCallback(async () => {
    chatStop();

    if (!chatId) return;

    reportAbortOutcome(await abortActiveStream({ chatId }));
  }, [chatId, chatStop]);
}
