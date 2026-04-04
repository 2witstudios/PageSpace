import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleFetchProxyRequest, resetActiveRequests } from '../fetch-proxy-handler';
import type { FetchProxyRequest } from '../../shared/fetch-proxy-types';
import { FETCH_PROXY_CHUNK_SIZE, FETCH_PROXY_TIMEOUT_MS, FETCH_PROXY_MAX_CONCURRENT } from '../../shared/fetch-proxy-types';

/** Helper to create a readable stream from a Uint8Array */
function createReadableStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (data.length > 0) {
        controller.enqueue(data);
      }
      controller.close();
    },
  });
}

/** Helper to create a mock Response */
function createMockResponse(
  body: Uint8Array | null,
  init?: { status?: number; statusText?: string; headers?: Record<string, string> }
): Response {
  const status = init?.status ?? 200;
  const statusText = init?.statusText ?? 'OK';
  const headers = new Headers(init?.headers ?? { 'content-type': 'application/json' });

  return {
    status,
    statusText,
    headers,
    body: body ? createReadableStream(body) : null,
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

describe('handleFetchProxyRequest', () => {
  const sentMessages: Record<string, unknown>[] = [];
  let mockFetch: ReturnType<typeof vi.fn>;

  const sendMessage = (msg: Record<string, unknown>) => {
    sentMessages.push(msg);
  };

  beforeEach(() => {
    sentMessages.length = 0;
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    resetActiveRequests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseRequest: FetchProxyRequest = {
    type: 'fetch_request',
    id: 'req-1',
    url: 'http://localhost:11434/api/chat',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model: 'llama3' })).toString('base64'),
  };

  it('should send start + chunk + end for a successful response', async () => {
    const body = new TextEncoder().encode('{"response":"hello"}');
    mockFetch.mockResolvedValueOnce(createMockResponse(body));

    await handleFetchProxyRequest(baseRequest, sendMessage);

    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[0]).toMatchObject({
      type: 'fetch_response_start',
      id: 'req-1',
      status: 200,
      statusText: 'OK',
    });
    expect(sentMessages[1]).toMatchObject({
      type: 'fetch_response_chunk',
      id: 'req-1',
    });
    const decoded = Buffer.from(sentMessages[1].chunk as string, 'base64').toString();
    expect(decoded).toBe('{"response":"hello"}');
    expect(sentMessages[2]).toMatchObject({
      type: 'fetch_response_end',
      id: 'req-1',
    });
  });

  it('should send error immediately for disallowed URLs', async () => {
    const blockedRequest: FetchProxyRequest = {
      ...baseRequest,
      url: 'https://api.openai.com/v1/chat',
    };

    await handleFetchProxyRequest(blockedRequest, sendMessage);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      type: 'fetch_response_error',
      id: 'req-1',
      error: 'URL not allowed for proxy',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should send error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    await handleFetchProxyRequest(baseRequest, sendMessage);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      type: 'fetch_response_error',
      id: 'req-1',
      error: 'connect ECONNREFUSED 127.0.0.1:11434',
    });
  });

  it('should send start + end with no chunks for empty body', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse(null, { status: 204, statusText: 'No Content' }));

    await handleFetchProxyRequest(baseRequest, sendMessage);

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toMatchObject({
      type: 'fetch_response_start',
      id: 'req-1',
      status: 204,
    });
    expect(sentMessages[1]).toMatchObject({
      type: 'fetch_response_end',
      id: 'req-1',
    });
  });

  it('should split large responses into 64KB chunks', async () => {
    const size = FETCH_PROXY_CHUNK_SIZE * 2 + 1000;
    const largeBody = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      largeBody[i] = i % 256;
    }
    mockFetch.mockResolvedValueOnce(createMockResponse(largeBody));

    await handleFetchProxyRequest(baseRequest, sendMessage);

    // start + 3 chunks + end = 5 messages
    expect(sentMessages).toHaveLength(5);
    expect(sentMessages[0]).toMatchObject({ type: 'fetch_response_start' });
    expect(sentMessages[1]).toMatchObject({ type: 'fetch_response_chunk' });
    expect(sentMessages[2]).toMatchObject({ type: 'fetch_response_chunk' });
    expect(sentMessages[3]).toMatchObject({ type: 'fetch_response_chunk' });
    expect(sentMessages[4]).toMatchObject({ type: 'fetch_response_end' });

    const chunk1 = Buffer.from(sentMessages[1].chunk as string, 'base64');
    const chunk2 = Buffer.from(sentMessages[2].chunk as string, 'base64');
    const chunk3 = Buffer.from(sentMessages[3].chunk as string, 'base64');

    expect(chunk1.length).toBe(FETCH_PROXY_CHUNK_SIZE);
    expect(chunk2.length).toBe(FETCH_PROXY_CHUNK_SIZE);
    expect(chunk3.length).toBe(1000);
    expect(chunk1.length + chunk2.length + chunk3.length).toBe(size);
  });

  it('should pass correct fetch options including decoded body', async () => {
    const body = new TextEncoder().encode('ok');
    mockFetch.mockResolvedValueOnce(createMockResponse(body));

    await handleFetchProxyRequest(baseRequest, sendMessage);

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toBe('http://localhost:11434/api/chat');
    const options = fetchCall[1] as RequestInit;
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    expect(options.body).toEqual(Buffer.from(baseRequest.body!, 'base64'));
  });

  it('should pass undefined body when request has no body', async () => {
    const body = new TextEncoder().encode('ok');
    mockFetch.mockResolvedValueOnce(createMockResponse(body));

    const getRequest: FetchProxyRequest = {
      type: 'fetch_request',
      id: 'req-2',
      url: 'http://localhost:11434/api/tags',
      method: 'GET',
      headers: {},
    };

    await handleFetchProxyRequest(getRequest, sendMessage);

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toBe('http://localhost:11434/api/tags');
    const options = fetchCall[1] as RequestInit;
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
  });

  it('should pass an AbortSignal with timeout to fetch', async () => {
    const body = new TextEncoder().encode('ok');
    mockFetch.mockResolvedValueOnce(createMockResponse(body));

    await handleFetchProxyRequest(baseRequest, sendMessage);

    const fetchCall = mockFetch.mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('should send error when fetch times out', async () => {
    const abortError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    mockFetch.mockRejectedValueOnce(abortError);

    await handleFetchProxyRequest(baseRequest, sendMessage);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      type: 'fetch_response_error',
      id: 'req-1',
    });
    expect((sentMessages[0].error as string)).toContain('aborted');
  });

  it('should reject requests beyond the concurrency limit', async () => {
    // Fill up the concurrent request slots with hanging fetches
    const hangingFetches: Array<{ resolve: (v: Response) => void }> = [];
    for (let i = 0; i < FETCH_PROXY_MAX_CONCURRENT; i++) {
      mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
        hangingFetches.push({ resolve });
      }));
    }

    // Launch max concurrent requests (don't await — they hang)
    const pending = Array.from({ length: FETCH_PROXY_MAX_CONCURRENT }, (_, i) =>
      handleFetchProxyRequest(
        { ...baseRequest, id: `req-${i}` },
        sendMessage
      )
    );

    // The next request should be rejected immediately
    await handleFetchProxyRequest(
      { ...baseRequest, id: 'req-overflow' },
      sendMessage
    );

    const overflowMsg = sentMessages.find((m) => m.id === 'req-overflow');
    expect(overflowMsg).toMatchObject({
      type: 'fetch_response_error',
      id: 'req-overflow',
      error: expect.stringContaining('Too many concurrent'),
    });

    // Clean up: resolve hanging fetches so pending promises settle
    const dummyResponse = createMockResponse(null, { status: 200 });
    hangingFetches.forEach((h) => h.resolve(dummyResponse));
    await Promise.all(pending);
  });

  it('should allow new requests after previous ones complete', async () => {
    // Fill up slots
    for (let i = 0; i < FETCH_PROXY_MAX_CONCURRENT; i++) {
      const body = new TextEncoder().encode('ok');
      mockFetch.mockResolvedValueOnce(createMockResponse(body));
      await handleFetchProxyRequest(
        { ...baseRequest, id: `req-${i}` },
        sendMessage
      );
    }

    // Should still accept new requests after previous ones completed
    sentMessages.length = 0;
    const body = new TextEncoder().encode('ok');
    mockFetch.mockResolvedValueOnce(createMockResponse(body));

    await handleFetchProxyRequest(
      { ...baseRequest, id: 'req-after' },
      sendMessage
    );

    expect(sentMessages[0]).toMatchObject({
      type: 'fetch_response_start',
      id: 'req-after',
    });
  });
});
