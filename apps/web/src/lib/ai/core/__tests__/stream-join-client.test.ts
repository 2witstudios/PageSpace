import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

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

  it('given valid SSE chunks and done sentinel, should call onChunk for each text and return { aborted: false }', async () => {
    stubFetch(encodeLines([
      'data: {"text":"hello"}\n\n',
      'data: {"text":" world"}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const result = await consumeStreamJoin('msg-1', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, 'hello');
    expect(onChunk).toHaveBeenNthCalledWith(2, ' world');
    expect(result).toEqual({ aborted: false });
  });

  it('given done sentinel with aborted: true, should return { aborted: true } without throwing', async () => {
    stubFetch(encodeLines([
      'data: {"text":"partial"}\n\n',
      'data: {"done":true,"aborted":true}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const result = await consumeStreamJoin('msg-2', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledWith('partial');
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
      'data: {"text":"ok"}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const onChunk = vi.fn();
    const result = await consumeStreamJoin('msg-5', AbortSignal.timeout(5000), onChunk);

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith('ok');
    expect(result).toEqual({ aborted: false });
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

  // C1 — encodeURIComponent
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

  // C2 — null body guard
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

  // C5 — partial-chunk buffer
  it('given SSE line split across two read chunks, should buffer and parse correctly', async () => {
    const encoder = new TextEncoder();
    // 'data: {"text":"hello"}\n\n' split mid-JSON across two enqueues
    const halfA = 'data: {"text"';
    const halfB = ':"hello"}\n\ndata: {"done":true,"aborted":false}\n\n';

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

    expect(onChunk).toHaveBeenCalledWith('hello');
    expect(result).toEqual({ aborted: false });
  });
});
