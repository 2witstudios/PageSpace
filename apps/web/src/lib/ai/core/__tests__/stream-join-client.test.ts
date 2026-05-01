import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const text = (text: string) => ({ type: 'text' as const, text });

describe('consumeStreamJoin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function encodeLines(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });
  }

  function stubFetch(body: ReadableStream<Uint8Array>, ok = true, status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok, status, body }),
    );
  }

  it('given valid part frames and done sentinel, should call onChunk for each part and return { aborted: false }', async () => {
    stubFetch(encodeLines([
      'data: {"part":{"type":"text","text":"hello"}}\n\n',
      'data: {"part":{"type":"text","text":" world"}}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const result = await consumeStreamJoin('msg-1', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, text('hello'));
    expect(onChunk).toHaveBeenNthCalledWith(2, text(' world'));
    expect(result).toEqual({ aborted: false });
  });

  it('given a tool part frame, should pass the full tool object through to onChunk', async () => {
    const tool = {
      type: 'tool-list_pages',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      state: 'output-available',
      input: { driveId: 'd1' },
      output: { pages: [] },
    };
    stubFetch(encodeLines([
      `data: ${JSON.stringify({ part: tool })}\n\n`,
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    await consumeStreamJoin('msg-tool', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledWith(tool);
  });

  it('given done sentinel with aborted: true, should return { aborted: true } without throwing', async () => {
    stubFetch(encodeLines([
      'data: {"part":{"type":"text","text":"partial"}}\n\n',
      'data: {"done":true,"aborted":true}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const result = await consumeStreamJoin('msg-2', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledWith(text('partial'));
    expect(result).toEqual({ aborted: true });
  });

  it('given signal is already aborted, should return { aborted: true } without calling onChunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
    );

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const result = await consumeStreamJoin('msg-3', controller.signal, onChunk);

    expect(result).toEqual({ aborted: true });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('given non-2xx response, should throw an error with the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, body: encodeLines([]) }),
    );

    const { consumeStreamJoin } = await import('../stream-join-client');

    await expect(
      consumeStreamJoin('msg-4', AbortSignal.timeout(5000), vi.fn()),
    ).rejects.toThrow('403');
  });

  it('given malformed SSE lines, should skip them and continue processing', async () => {
    stubFetch(encodeLines([
      'data: not-json\n\n',
      'comment: ignored\n\n',
      'data: {"part":{"type":"text","text":"ok"}}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const result = await consumeStreamJoin('msg-5', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(text('ok'));
    expect(result).toEqual({ aborted: false });
  });

  it('given a legacy {text:...} frame from an old server, should skip it (no part field present)', async () => {
    stubFetch(encodeLines([
      'data: {"text":"legacy"}\n\n',
      'data: {"part":{"type":"text","text":"current"}}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    await consumeStreamJoin('msg-mixed', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(text('current'));
  });

  it('given fetch call, should include credentials and the correct URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: encodeLines(['data: {"done":true,"aborted":false}\n\n']),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { consumeStreamJoin } = await import('../stream-join-client');
    await consumeStreamJoin('msg-xyz', AbortSignal.timeout(5000), vi.fn());

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/ai/chat/stream-join/msg-xyz',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('given messageId with special characters, should URL-encode it in the request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: encodeLines(['data: {"done":true,"aborted":false}\n\n']),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { consumeStreamJoin } = await import('../stream-join-client');
    await consumeStreamJoin('msg/with spaces', AbortSignal.timeout(5000), vi.fn());

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/ai/chat/stream-join/msg%2Fwith%20spaces',
      expect.any(Object),
    );
  });

  it('given a 2xx response with a null body, should throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }),
    );

    const { consumeStreamJoin } = await import('../stream-join-client');

    await expect(
      consumeStreamJoin('msg-null', AbortSignal.timeout(5000), vi.fn()),
    ).rejects.toThrow();
  });

  it('given an SSE line split across two read chunks, should buffer and parse correctly', async () => {
    const encoder = new TextEncoder();
    const halfA = 'data: {"part":{"type":"text"';
    const halfB = ',"text":"hello"}}\n\ndata: {"done":true,"aborted":false}\n\n';

    stubFetch(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(halfA));
        controller.enqueue(encoder.encode(halfB));
        controller.close();
      },
    }));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const result = await consumeStreamJoin('msg-split', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledWith(text('hello'));
    expect(result).toEqual({ aborted: false });
  });
});
