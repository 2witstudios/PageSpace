/**
 * THE OLD-SERVER HANDSHAKE — read exactly enough of a legacy response body to learn what the
 * server just admitted, then get out of the way.
 *
 * ── WHY NOT READ THE WHOLE BODY, AND WHY NOT NONE OF IT ───────────────────────────────────
 *
 * Both extremes are wrong here, and this PR shipped each of them in turn before landing on the
 * middle.
 *
 * READING ALL OF IT made the tab TWO WRITERS on one store entry. The "old server" in a rolling
 * deploy is the previous deploy, which already broadcasts `chat:stream_start` and already
 * serves `/api/ai/chat/stream-join/[messageId]` — so `useChannelStreamSocket` opens a registry
 * session for the same messageId and subscribes to it regardless. Two writers with independent
 * counters, and `applySetStreamParts` silently drops whichever falls behind; when the join's
 * end sentinel landed first it removed the entry outright and the tail of the reply never
 * rendered. The old `consumingChannels` mark existed to keep exactly these two apart.
 *
 * READING NONE OF IT left a GAP where there used to be an overlap. The send resolved the
 * instant the POST returned, `useSendHandoff` saw `status: 'ready'` with no store entry and
 * cleared its pendingSend — so between the POST resolving and the socket broadcast arriving
 * (a separate hop: web → realtime → tab) the composer flipped back to Send, Stop was disarmed,
 * and no bubble existed. `broadcastAiStreamStart` is fire-and-forget with a swallowed catch, so
 * if it never arrived the reply was invisible until a reload. That is strictly worse than the
 * double-writer it replaced.
 *
 * So: read until the `start` frame, which is the first thing the SDK emits and the only thing
 * the client cannot get anywhere else — the server-issued assistant messageId. Announce the
 * session with it, exactly as the detached path announces one from its envelope. Then cancel.
 * One writer (the registry's join, replaying from seq 0), and no window where the send has
 * resolved but nothing is on screen.
 *
 * ── CANCELLING IS SAFE, AND THAT IS LOAD-BEARING ──────────────────────────────────────────
 *
 * The response is subscriber #0 on a channel the PUMP owns (PR #2408). `subscribeReadable`'s
 * `cancel()` detaches that one subscriber and clears its pending buffer; it does not touch the
 * pump, and no `request.signal` is wired into the generation. So abandoning the body costs
 * nothing — the frames we stop reading are still in the ring, and the join replays them from
 * seq 0.
 */

import type { UIMessageChunk } from 'ai';

/**
 * Read a legacy SSE body up to and including its `start` frame.
 *
 * Resolves with the server-issued assistant messageId, or `undefined` if the stream ended
 * without ever naming one — which the caller must treat as a FAILED send rather than a
 * completed empty reply. A body that errors before `start` (a provider auth failure, a
 * truncated response) is exactly that case, and reporting it as success is how a send comes to
 * clear the composer while rendering nothing.
 *
 * Always releases the body before returning, on every path.
 */
export const readLegacyStreamStart = async (response: Response): Promise<string | undefined> => {
  const body = response.body;
  if (!body) return undefined;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return undefined;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice('data: '.length).trim();
        if (payload.length === 0 || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as UIMessageChunk;
          if (chunk.type !== 'start') continue;
          const messageId = (chunk as { messageId?: unknown }).messageId;
          if (typeof messageId === 'string' && messageId.length > 0) return messageId;
        } catch {
          // A malformed SSE line before `start`. Skip it — the frame we want may still come.
        }
      }
    }
  } finally {
    // Releases the lock and detaches subscriber #0 whether we found the id, ran out of body, or
    // threw. `cancel` rejects on an already-errored stream, which is not something the caller
    // can act on and must not mask the real outcome.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
