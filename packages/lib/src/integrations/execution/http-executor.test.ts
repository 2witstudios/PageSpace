/**
 * HTTP Executor Tests
 *
 * Tests for HTTP request execution with retry logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHttpRequest, type HttpRequest } from './http-executor';
import type { IntegrationTargetDecision } from '../validation/validate-base-url';

// The executor resolves every hostname before connecting; existing cases use
// hostnames, so resolve them to a public address.
vi.mock('dns', () => ({
  promises: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  },
}));

const allowAll = async (): Promise<IntegrationTargetDecision> => ({ ok: true });

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

    const resultPromise = executeHttpRequest(request, { maxRetries: 0 }, mockFetch as unknown as typeof fetch);
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

    const resultPromise = executeHttpRequest(request, { maxRetries: 0 }, mockFetch as unknown as typeof fetch);
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

    const resultPromise = executeHttpRequest(request, { maxRetries: 3 }, mockFetch as unknown as typeof fetch);
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
    }, mockFetch as unknown as typeof fetch);

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

    const resultPromise = executeHttpRequest(request, { maxRetries: 2 }, mockFetch as unknown as typeof fetch);

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
    }, mockFetch as unknown as typeof fetch);

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
    }, mockFetch as unknown as typeof fetch);

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
    }, mockFetch as unknown as typeof fetch);

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
    }, mockFetch as unknown as typeof fetch);

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
    }, mockFetch as unknown as typeof fetch);

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
      mockFetch as unknown as typeof fetch,
      validateTarget
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
    expect(result.retries).toBe(0);
  });

  it('given a stored override resolving to a private address, should refuse before any request (default validator)', async () => {
    const { promises: dns } = await import('dns');
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: '10.9.8.7', family: 4 }] as never);
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    const result = await executeHttpRequest(
      { url: 'https://hooks.corp.example/hook', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as typeof fetch
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
      mockFetch as unknown as typeof fetch,
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
      mockFetch as unknown as typeof fetch,
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
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'rebound' });
    mockFetch.mockResolvedValueOnce(withLocation(302, '/moved'));
    mockFetch.mockResolvedValue(createMockResponse(200, { leaked: true }));

    const result = await executeHttpRequest(
      { url: 'https://api.example.com/data', method: 'GET', headers: { Authorization: 'Bearer s3cret' } },
      { maxRetries: 0 },
      mockFetch as unknown as typeof fetch,
      validateTarget
    );

    expect(validateTarget).toHaveBeenCalledTimes(2);
    expect(validateTarget).toHaveBeenLastCalledWith('https://api.example.com/moved');
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
      mockFetch as unknown as typeof fetch,
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
      mockFetch as unknown as typeof fetch,
      allowAll
    );

    expect(mockFetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: 'GET', body: undefined })
    );
  });

  it('given an endless same-origin redirect chain, should stop after the hop limit', async () => {
    mockFetch.mockResolvedValue(withLocation(302, '/loop'));

    const result = await executeHttpRequest(
      { url: 'https://api.example.com/loop', method: 'GET' },
      { maxRetries: 0 },
      mockFetch as unknown as typeof fetch,
      allowAll
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('redirect_blocked');
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
