// A /api/ai/chat answer the test drives frame by frame: the AI SDK UI message
// stream on an SSE body, as apps/web's createUIMessageStreamResponse writes it.

import type { UIMessageChunk } from 'ai';

export type FakeTurnStream = {
  /** The response to hand back from the fake route; its body stays open until `close`. */
  readonly response: () => Response;
  /** Writes one chunk as an SSE `data:` frame. */
  readonly push: (chunk: UIMessageChunk) => void;
  /** Ends the body the way the server does: `[DONE]`, then close. */
  readonly close: () => void;
  /** Whether the reader went away (the body was cancelled). */
  readonly cancelled: () => boolean;
};

export const fakeTurnStream = (): FakeTurnStream => {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      wasCancelled = true;
    },
  });
  const write = (text: string) => {
    if (!closed) controller?.enqueue(encoder.encode(text));
  };
  return {
    response: () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      }),
    push: (chunk) => write(`data: ${JSON.stringify(chunk)}\n\n`),
    close: () => {
      write('data: [DONE]\n\n');
      if (!closed) controller?.close();
      closed = true;
    },
    cancelled: () => wasCancelled,
  };
};
