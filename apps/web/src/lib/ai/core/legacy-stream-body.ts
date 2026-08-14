/**
 * THE FALLBACK PATH — reading a generation off the POST response body, as the client always
 * did before detached mode.
 *
 * This exists for exactly one situation: a NEW CLIENT talking to an OLD SERVER, which does
 * not know `X-Stream-Mode` and answers `text/event-stream` regardless. That is not a corner
 * case, it is the normal state of a rolling deploy, and it is what makes the client safe to
 * ship FIRST — the half of the rollout that would otherwise have to go second.
 *
 * WHAT IT IS NOT. It is not a second rendering path. It folds the same SDK frames with the
 * same reduction (`createPartsFolder`) and writes them to the same store entry with the same
 * replace semantics as `consumeStreamJoin`, so a surface cannot tell which transport served
 * it. The `#1182` fork this whole epic exists to close was two channels carrying DIFFERENT
 * data; this is one reduction reachable by two routes, which is a different thing entirely.
 *
 * WHERE THE messageId COMES FROM HERE, AND WHY IT IS ALLOWED TO COME FROM A FRAME.
 *
 * A body read always starts at the beginning of the stream, so the SDK's `start` chunk — the
 * one carrying the server-issued assistant message id — is guaranteed to arrive, and is the
 * FIRST thing to arrive. That is the precise condition under which reading the id off frame
 * content is sound, and it is the condition a mid-seq join can never satisfy (see
 * `detached-stream-mode.ts` for the two-bubble bug that follows from ignoring the
 * difference). So: here, from the frame; there, from the envelope. Neither guesses.
 *
 * Until that `start` frame lands there is no store key, so nothing is written. That window is
 * covered by `useSendHandoff`'s pendingSend, exactly as it was before.
 *
 * THIS PATH DIES with the last server that does not send envelopes. It is deliberately small
 * and deliberately dumb so that deleting it is a one-file operation.
 */

import type { UIMessage, UIMessageChunk } from 'ai';
import { createPartsFolder } from '@/lib/ai/streams/foldChunksToParts';

type UIMessagePart = UIMessage['parts'][number];

export interface LegacyStreamBodyHandlers {
  /**
   * The stream named itself. Fires exactly once, on the `start` chunk, before any parts.
   *
   * The caller uses this to open its store entry — which is why it is a separate callback
   * rather than being folded into `onParts`: the entry (and the editing-store registration
   * derived from it) must exist from the stream's first instant, not from its first token.
   */
  onStart: (messageId: string) => void;
  /** The full folded parts array, with a monotonic seq for the store's write gate. */
  onParts: (messageId: string, parts: UIMessagePart[], seq: number) => void;
}

/**
 * Read an AI SDK UI-message-stream response body to completion.
 *
 * Resolves with the messageId the stream declared, or undefined if it ended without ever
 * declaring one (an immediate error, or a truncated response) — which the caller must treat
 * as "nothing was rendered", not as a completed empty reply.
 *
 * Never rejects on a malformed line. The wire is SSE and a single unparseable frame is not a
 * reason to discard a reply the user can already see; the same tolerance `consumeStreamJoin`
 * applies, for the same reason.
 */
export const consumeLegacyStreamBody = async (
  response: Response,
  handlers: LegacyStreamBodyHandlers,
): Promise<string | undefined> => {
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const folder = createPartsFolder();
  let buffer = '';
  let messageId: string | undefined;
  // Monotonic per stream. `applySetStreamParts` drops any write whose seq is not strictly
  // greater than the stored one, so this counts FRAMES rather than reusing a wall clock —
  // two frames inside one millisecond would otherwise silently lose the second.
  let seq = 0;

  // AWAITED, one frame at a time. `push` is async because the fold reconstructs
  // partially-streamed tool input with `parsePartialJson`, and firing those off without
  // awaiting would interleave them: `folder.parts` would be read at whatever depth the
  // scheduler happened to have reached, and the store's monotonic seq gate would then DROP
  // the correctly-ordered write that arrived after a later one won the race. Frames are
  // ordered on the wire and must stay ordered through the fold.
  const handleChunk = async (chunk: UIMessageChunk): Promise<void> => {
    if (chunk.type === 'start') {
      const declared = (chunk as { messageId?: unknown }).messageId;
      // Only the FIRST `start` names the stream. The SDK can emit a continuation that reuses
      // the id, and a later one that changed it would mean the array shifted under us — not
      // something a body read can express, and re-keying the store mid-stream would strand
      // the entry the caller already opened.
      if (messageId === undefined && typeof declared === 'string' && declared.length > 0) {
        messageId = declared;
        handlers.onStart(messageId);
      }
      return;
    }
    if (messageId === undefined) return;
    await folder.push(chunk);
    seq += 1;
    handlers.onParts(messageId, folder.parts, seq);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice('data: '.length).trim();
        if (payload.length === 0 || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as UIMessageChunk;
          // Trust the shape only as far as it is used — the fold dispatches on `type`.
          if (typeof (parsed as { type?: unknown }).type === 'string') await handleChunk(parsed);
        } catch {
          // A malformed SSE line. Skip it; the reply so far stays on screen.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return messageId;
};
