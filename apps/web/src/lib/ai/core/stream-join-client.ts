import type { UIMessage } from 'ai';
import { isValidPartFrame } from '@/lib/ai/streams/isValidPartFrame';

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
 *   data: {"part": <UIMessagePart>}\n\n      — one accumulated part per frame
 *   data: {"done": true, "aborted": <bool>}\n\n  — end sentinel
 * Anything else (legacy `{text:...}` frames, malformed JSON, frames missing
 * required fields) is silently skipped — `isValidPartFrame` is the gate.
 */
export async function consumeStreamJoin(
  messageId: string,
  signal: AbortSignal,
  onChunk: (part: UIMessagePart) => void,
): Promise<{ aborted: boolean }> {
  let response: Response;
  try {
    response = await fetch(`/api/ai/chat/stream-join/${encodeURIComponent(messageId)}`, {
      credentials: 'include',
      signal,
    });
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
            return { aborted: (parsed.aborted as boolean | undefined) ?? false };
          }
          if (isValidPartFrame(parsed.part)) {
            onChunk(parsed.part);
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
