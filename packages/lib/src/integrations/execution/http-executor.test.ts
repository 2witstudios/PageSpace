/**
 * HTTP Executor Tests
 *
 * Tests for HTTP request execution with retry logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHttpRequest, type HttpRequest } from './http-executor';

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
});
