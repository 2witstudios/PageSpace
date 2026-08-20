import type { UIMessage, UIMessageChunk } from 'ai';
import { createPartsFolder } from '@/lib/ai/streams/foldChunksToParts';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Thrown when the SSE join itself fails (non-ok response). Carries the HTTP status
 * structurally — not just embedded in the message string — so a caller can distinguish a 404
 * (the common, benign "this stream lives on another web instance" case, where the poll
 * fallback in `stream-join-poll-fallback.ts` applies) from a genuine denial (403) or a server
 * error, which should not be retried the same way.
 */
export class StreamJoinError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'StreamJoinError';
  }
}

/**
 * SSE wire protocol (paired with `apps/web/src/app/api/ai/chat/stream-join/[messageId]/route.ts`):
 *   data: {"seq": <n>, "chunk": <UIMessageChunk>}   — one raw SDK frame, in seq order
 *   data: {"done": true, "aborted": <bool>}          — end sentinel
 *   data: {"done": true, "resumeFromSeq": <n>}       — cursor too old; reseed from n
 *   data: {"done": true, "aborted": <bool>, "reload": true}
 *                                                    — what you have is INCOMPLETE and there is
 *                                                      no seq to resume from. Reload the durable
 *                                                      message.
 *
 * `reload` and `resumeFromSeq` are deliberately different answers and must not be collapsed.
 * `resumeFromSeq` says "ask again from here" — the content exists, this connection just cannot
 * serve it from the cursor given. `reload` says the SOURCE cannot serve the rest at all: a
 * cross-instance follower found the durable frame log released (the stream ended and retention
 * deleted it) or holed. There is nowhere to resume from, and the durably-persisted message is
 * the only complete copy.
 *
 * The frames are the SDK's own `UIMessageChunk`s, and they are folded here by the SAME
 * reduction the server uses, so a joiner's view is the SDK's view rather than a re-derivation.
 * That is the whole point of the change: the previous wire carried `chunkToPart`'s four-case
 * projection, so anything a joiner saw was missing reasoning, files, sources, step boundaries
 * and the routes' own data parts.
 *
 * `onParts` receives the FULL folded parts array plus the seq it reflects, so the caller writes
 * it with replace semantics. There is no skip-count to get wrong: the cursor is `fromSeq`, and
 * the server sends exactly what comes after it.
 */
export async function consumeStreamJoin(
  messageId: string,
  signal: AbortSignal,
  onParts: (parts: UIMessagePart[], seq: number) => void,
  fromSeq = 0,
): Promise<{ aborted: boolean; resumeFromSeq?: number; reload?: boolean }> {
  let response: Response;
  try {
    response = await fetch(
      `/api/ai/chat/stream-join/${encodeURIComponent(messageId)}?fromSeq=${fromSeq}`,
      {
        credentials: 'include',
        signal,
      },
    );
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return { aborted: true };
    }
    throw err;
  }

  if (!response.ok) {
    throw new StreamJoinError(`Stream join failed with status ${response.status}`, response.status);
  }

  if (!response.body) {
    throw new Error(`Stream join response has no body (status ${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // One folder per subscription, fed in seq order — the incremental form of the same
  // reduction the server's checkpoint uses.
  const folder = createPartsFolder();

  try {
    while (true) {
      if (signal.aborted) {
        return { aborted: true };
      }

      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (readErr) {
        if (signal.aborted) return { aborted: true };
        throw readErr;
      }

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice('data: '.length);
        try {
          const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          if (parsed.done) {
            return {
              aborted: (parsed.aborted as boolean | undefined) ?? false,
              resumeFromSeq: parsed.resumeFromSeq as number | undefined,
              reload: parsed.reload === true,
            };
          }
          const chunk = parsed.chunk as UIMessageChunk | undefined;
          const seq = parsed.seq as number | undefined;
          // Trust the shape only as far as it is used: a frame needs a string `type` for the
          // fold to dispatch on, and a numeric seq for the caller's monotonic write gate.
          if (chunk && typeof (chunk as { type?: unknown }).type === 'string' && typeof seq === 'number') {
            await folder.push(chunk);
            onParts(folder.parts, seq);
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { aborted: false };
}
