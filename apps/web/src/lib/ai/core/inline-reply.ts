/**
 * A COMPLETE reply delivered on the response body, with nothing streaming behind it.
 *
 * The `/help` short-circuit is the one producer today. It answers from code with no model call,
 * so it builds no stream lifecycle, opens no channel and broadcasts no `chat:stream_start` —
 * `page-chat-turn.ts` makes that choice deliberately rather than replicating the live-stream
 * protocol for an already-complete synthetic reply. The server marks the response
 * `X-Stream-Mode: inline` so the client can tell it apart from an old server's streamed body,
 * which is otherwise byte-identical in shape. See `STREAM_MODE_INLINE`.
 *
 * WHY THIS IS NOT A STREAM SESSION. There is nothing to subscribe to: no channel, no
 * `/stream-join`, no `ai_stream_sessions` row. Opening a session for it produces a 404 join, a
 * fruitless poll, and an empty bubble over a locked composer until both give up. And there is
 * nothing to WAIT for either — the whole reply arrives in this body, and the server persisted
 * it before responding. So it is read to the end and committed as what it already is: a
 * finished assistant message.
 */

import type { UIMessage, UIMessageChunk } from 'ai';
import { createPartsFolder } from '@/lib/ai/streams/foldChunksToParts';

type UIMessagePart = UIMessage['parts'][number];

export interface InlineReply {
  messageId: string;
  parts: UIMessagePart[];
}

/**
 * Read an inline reply to completion.
 *
 * Resolves `null` when the body ended without ever naming its message, which the caller must
 * treat as a failed send rather than an empty success — the same rule the legacy handshake
 * follows, and for the same reason.
 *
 * Frames are folded by the SAME reduction the live path uses (`createPartsFolder`), so an
 * inline reply and a streamed one produce identical parts and render identically.
 */
export const readInlineReply = async (response: Response): Promise<InlineReply | null> => {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const folder = createPartsFolder();
  let buffer = '';
  let messageId: string | undefined;

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

        let chunk: UIMessageChunk;
        try {
          chunk = JSON.parse(payload) as UIMessageChunk;
        } catch {
          continue; // A malformed SSE line; the rest of the reply is still worth having.
        }
        if (typeof (chunk as { type?: unknown }).type !== 'string') continue;

        if (chunk.type === 'start') {
          const declared = (chunk as { messageId?: unknown }).messageId;
          // Only the first `start` names the reply — a later one would mean the array shifted,
          // which an inline body cannot express.
          if (messageId === undefined && typeof declared === 'string' && declared.length > 0) {
            messageId = declared;
          }
          continue;
        }
        // Awaited one frame at a time: the fold reconstructs partially-streamed tool input, and
        // firing those concurrently would read `folder.parts` at whatever depth the scheduler
        // happened to reach.
        await folder.push(chunk);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!messageId) return null;
  return { messageId, parts: folder.parts };
};
