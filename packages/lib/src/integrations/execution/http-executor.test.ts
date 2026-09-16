/**
 * HTTP Executor Tests
 *
 * Tests for HTTP request execution with retry logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHttpRequest, type HttpRequest } from './http-executor';
import type { PinnedFetch } from './pinned-fetch';
import type { IntegrationTargetDecision } from '../validation/validate-base-url';

// The executor resolves every hostname before connecting; existing cases use
// hostnames, so resolve them to a public address.
vi.mock('dns', () => ({
  promises: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  },
}));

const PUBLIC = '93.184.216.34';
const allowAll = async (): Promise<IntegrationTargetDecision> => ({ ok: true, address: PUBLIC });

// Mock fetch for testing
const mockFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

// Helper to create mock Response
const createMockResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response => {
  const contentType = typeof body === 'object' ? 'application/json' : 'text/plain';
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 429 ? 'Too Many Requests' : 'Error',
    headers: new Headers({ 'content-type': contentType, ...headers }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
  return response;
};

describe('executeHttpRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('given valid request, should execute and return response', async () => {
    const mockResponse = createMockResponse(200, { data: 'test' });
    mockFetch.mockResolvedValue(mockResponse);

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, { maxRetries: 0 }, mockFetch as unknown as PinnedFetch);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(result.response?.body).toEqual({ data: 'test' });
  });

  it('given POST request with body, should send body', async () => {
    const mockResponse = createMockResponse(201, { id: '123' });
    mockFetch.mockResolvedValue(mockResponse);

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Test"}',
    };

    const resultPromise = executeHttpRequest(request, { maxRetries: 0 }, mockFetch as unknown as PinnedFetch);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        method: 'POST',
        body: '{"title":"Test"}',
      })
    );
  });

  it('given 4xx response, should not retry and return error', async () => {
    const mockResponse = createMockResponse(404, { error: 'Not found' });
    mockFetch.mockResolvedValue(mockResponse);

    const request: HttpRequest = {
      url: 'https://api.example.com/missing',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, { maxRetries: 3 }, mockFetch as unknown as PinnedFetch);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
    expect(result.retries).toBe(0); // No retries for 4xx
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('given 5xx response, should retry with backoff', async () => {
    const mock500 = createMockResponse(500, { error: 'Server error' });
    const mock200 = createMockResponse(200, { data: 'success' });

    mockFetch
      .mockResolvedValueOnce(mock500)
      .mockResolvedValueOnce(mock500)
      .mockResolvedValueOnce(mock200);

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, {
      maxRetries: 3,
      retryDelayMs: 100,
    }, mockFetch as unknown as PinnedFetch);

    // Advance through retries
    await vi.advanceTimersByTimeAsync(100); // First retry delay
    await vi.advanceTimersByTimeAsync(200); // Second retry delay
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.retries).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('given 429 response, should retry with Retry-After header', async () => {
    const mock429 = createMockResponse(429, { error: 'Too many requests' }, { 'Retry-After': '2' });
    const mock200 = createMockResponse(200, { data: 'success' });

    mockFetch
      .mockResolvedValueOnce(mock429)
      .mockResolvedValueOnce(mock200);

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, { maxRetries: 2 }, mockFetch as unknown as PinnedFetch);

    // Advance through Retry-After delay (2 seconds)
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
  });

  it('given max retries exceeded, should return last error', async () => {
    const mockError = createMockResponse(500, { error: 'Server error' });
    mockFetch.mockResolvedValue(mockError);

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, {
      maxRetries: 2,
      retryDelayMs: 100,
    }, mockFetch as unknown as PinnedFetch);

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    expect(result.retries).toBe(2); // Only actual retries are counted
    expect(mockFetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('given network error, should retry with backoff', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(createMockResponse(200, { data: 'success' }));

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, {
      maxRetries: 2,
      retryDelayMs: 100,
    }, mockFetch as unknown as PinnedFetch);

    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
  });

  it('given timeout (AbortError), should return timeout error without retrying', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, {
      maxRetries: 3,
      timeoutMs: 100,
    }, mockFetch as unknown as PinnedFetch);

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('Request timeout');
    expect(result.errorType).toBe('timeout');
    expect(result.retries).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('given network errors exhausting all retries, should return final network error', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, {
      maxRetries: 2,
      retryDelayMs: 50,
    }, mockFetch as unknown as PinnedFetch);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
    expect(result.errorType).toBe('network');
    expect(result.retries).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('given 429 response exhausting retries, should return rate limit error', async () => {
    const mock429 = createMockResponse(429, { error: 'Too many requests' });
    mockFetch.mockResolvedValue(mock429);

    const request: HttpRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
    };

    const resultPromise = executeHttpRequest(request, {
      maxRetries: 1,
      retryDelayMs: 50,
    }, mockFetch as unknown as PinnedFetch);

    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('Rate limit exceeded');
    expect(result.errorType).toBe('rate_limit');
    expect(result.retries).toBe(1);
  });
});

describe('executeHttpRequest target guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const withLocation = (status: number, location: string): Response =>
    createMockResponse(status, '', { location });

  it('given the target validator rejects, should not fetch and return blocked_target', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));
    const validateTarget = vi.fn(async (): Promise<IntegrationTargetDecision> => ({ ok: false, reason: 'blocked' }));

    const result = await executeHttpRequest(
      { url: 'http://10.0.0.5/hook', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 3 },
      mockFetch as unknown as PinnedFetch,
      validateTarget
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
    expect(result.retries).toBe(0);
  });

  it('given an http:// target on a public host, should refuse before any request and never fall back to http (default validator)', async () => {
    const { promises: dns } = await import('dns');
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    const result = await executeHttpRequest(
      { url: 'http://93.184.216.34/hook', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
    expect(result.error).toMatch(/HTTPS/i);
  });

  it('given a stored override resolving to a private address, should refuse before any request (default validator)', async () => {
    const { promises: dns } = await import('dns');
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: '10.9.8.7', family: 4 }] as never);
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    const result = await executeHttpRequest(
      { url: 'https://hooks.corp.example/hook', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
  });

  it('should fetch with redirect: manual so the runtime never follows on its own', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    await executeHttpRequest(
      { url: 'https://api.example.com/data', method: 'GET' },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      allowAll
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('given a redirect to another origin, should not follow it and should not send credentials there', async () => {
    mockFetch.mockResolvedValueOnce(withLocation(302, 'https://evil.example/collect'));
    mockFetch.mockResolvedValue(createMockResponse(200, { leaked: true }));

    const result = await executeHttpRequest(
      { url: 'https://api.example.com/data', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      allowAll
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/data');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('redirect_blocked');
    expect(result.response).toBeUndefined();
  });

  it('given a redirect to a private address on the same host name, should re-validate the hop and refuse', async () => {
    // Same origin but the validator (DNS re-resolution) now says private: rebinding mid-request.
    const validateTarget = vi
      .fn<() => Promise<IntegrationTargetDecision>>()
      .mockResolvedValueOnce({ ok: true, address: PUBLIC })
      .mockResolvedValueOnce({ ok: false, reason: 'rebound' });
    mockFetch.mockResolvedValueOnce(withLocation(302, '/moved'));
    mockFetch.mockResolvedValue(createMockResponse(200, { leaked: true }));

    const result = await executeHttpRequest(
      { url: 'https://api.example.com/data', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      validateTarget
    );

    expect(validateTarget).toHaveBeenCalledTimes(2);
    expect(validateTarget).toHaveBeenLastCalledWith('https://api.example.com/moved', expect.any(AbortSignal));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
  });

  it('given a same-origin redirect, should follow it once with the same headers', async () => {
    mockFetch.mockResolvedValueOnce(withLocation(301, '/v2/data'));
    mockFetch.mockResolvedValueOnce(createMockResponse(200, { moved: true }));

    const result = await executeHttpRequest(
      { url: 'https://api.example.com/data', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      allowAll
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.example.com/v2/data');
    expect(mockFetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({ headers: { Authorization: 'Bearer s3cret' } })
    );
    expect(result.success).toBe(true);
    expect(result.response?.body).toEqual({ moved: true });
  });

  it('given a 303 same-origin redirect of a POST, should replay as GET without the body', async () => {
    mockFetch.mockResolvedValueOnce(withLocation(303, '/result'));
    mockFetch.mockResolvedValueOnce(createMockResponse(200, { done: true }));

    await executeHttpRequest(
      { url: 'https://api.example.com/jobs', method: 'POST', body: '{"a":1}' },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      allowAll
    );

    expect(mockFetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: 'GET', body: undefined })
    );
  });

  it('given a POST rewritten to GET by a 303, should drop body headers (any case) and keep the rest', async () => {
    mockFetch.mockResolvedValueOnce(withLocation(303, '/result'));
    mockFetch.mockResolvedValueOnce(createMockResponse(200, { done: true }));

    await executeHttpRequest(
      {
        url: 'https://api.example.com/jobs',
        method: 'POST',
        body: '{"a":1}',
        headers: {
          Authorization: 'Bearer s3cret',
          'Content-Length': '7',
          'content-type': 'application/json',
          'Content-Encoding': 'identity',
          'Content-Language': 'en',
          'Content-Location': '/jobs/1',
          Accept: 'application/json',
        },
      },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      allowAll
    );

    const actual = { first: mockFetch.mock.calls[0][1].headers, second: mockFetch.mock.calls[1][1].headers };
    const expected = {
      first: {
        Authorization: 'Bearer s3cret',
        'Content-Length': '7',
        'content-type': 'application/json',
        'Content-Encoding': 'identity',
        'Content-Language': 'en',
        'Content-Location': '/jobs/1',
        Accept: 'application/json',
      },
      second: { Authorization: 'Bearer s3cret', Accept: 'application/json' },
    };
    expect(actual).toEqual(expected);
  });

  it('given a 307 that preserves the method and body, should keep the body headers', async () => {
    mockFetch.mockResolvedValueOnce(withLocation(307, '/jobs-v2'));
    mockFetch.mockResolvedValueOnce(createMockResponse(200, { done: true }));
    const headers = { Authorization: 'Bearer s3cret', 'Content-Length': '7', 'Content-Type': 'application/json' };

    await executeHttpRequest(
      { url: 'https://api.example.com/jobs', method: 'POST', body: '{"a":1}', headers },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      allowAll
    );

    const actual = mockFetch.mock.calls[1][1];
    const expected = expect.objectContaining({ method: 'POST', body: '{"a":1}', headers });
    expect(actual).toEqual(expected);
  });

  it('given an endless same-origin redirect chain, should stop after the hop limit', async () => {
    mockFetch.mockResolvedValue(withLocation(302, '/loop'));

    const result = await executeHttpRequest(
      { url: 'https://api.example.com/loop', method: 'GET' },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      allowAll
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('redirect_blocked');
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe('executeHttpRequest connection pinning and validation deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass the validated address to the fetch as the pinned connect address', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    await executeHttpRequest(
      { url: 'https://api.example.com/data', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      async () => ({ ok: true, address: '140.82.112.6' })
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({ pinnedAddress: '140.82.112.6' })
    );
  });

  it('given DNS that flips public→private between lookups, should connect to the validated public address only', async () => {
    const { promises: dns } = await import('dns');
    vi.mocked(dns.lookup)
      .mockResolvedValueOnce([{ address: PUBLIC, family: 4 }] as never)
      .mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    const result = await executeHttpRequest(
      { url: 'https://rebinder.example/data', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch
    );

    expect(result.success).toBe(true);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ pinnedAddress: PUBLIC }));
  });

  it('should hand the request abort signal to the target validator', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));
    const validateTarget = vi.fn(allowAll);

    await executeHttpRequest(
      { url: 'https://api.example.com/data', method: 'GET' },
      { maxRetries: 0 },
      mockFetch as unknown as PinnedFetch,
      validateTarget
    );

    expect(validateTarget).toHaveBeenCalledWith('https://api.example.com/data', expect.any(AbortSignal));
  });

  it('given a DNS lookup that never completes, should return timeout within timeoutMs and never fetch', async () => {
    const { promises: dns } = await import('dns');
    vi.mocked(dns.lookup).mockReturnValue(new Promise(() => undefined) as never);
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    const outcome = await Promise.race([
      executeHttpRequest(
        { url: 'https://stuck-dns.example/data', method: 'GET' },
        { maxRetries: 0, timeoutMs: 50 },
        mockFetch as unknown as PinnedFetch
      ),
      new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), 500)),
    ]);

    expect(outcome).not.toBe('HUNG');
    expect(outcome).toMatchObject({ success: false, errorType: 'timeout' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
