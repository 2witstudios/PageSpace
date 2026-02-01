/**
 * HTTP Executor Tests
 *
 * Tests for HTTP request execution with retry logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Types for HTTP execution
interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

interface ExecuteOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

interface ExecuteResult {
  success: boolean;
  response?: HttpResponse;
  error?: string;
  retries?: number;
}

// Mock fetch for testing
const mockFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

// Helper to create mock Response
const createMockResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response => {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 429 ? 'Too Many Requests' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
  return response;
};

// Inline executor for testing
const executeHttpRequest = async (
  request: HttpRequest,
  options: ExecuteOptions = {},
  fetchFn = mockFetch as unknown as typeof fetch
): Promise<ExecuteResult> => {
  const { timeoutMs = 30000, maxRetries = 3, retryDelayMs = 1000 } = options;
  let lastError: string | undefined;
  let retryCount = 0;

  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;

        // 4xx responses don't retry
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            body = await response.text();
          }

          return {
            success: false,
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body,
              durationMs,
            },
            error: `HTTP ${response.status}: ${response.statusText}`,
            retries: retryCount,
          };
        }

        // 429 retry with Retry-After
        if (response.status === 429) {
          retryCount++;
          const retryAfter = response.headers.get('Retry-After');
          const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : retryDelayMs * Math.pow(2, attempt);

          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          return {
            success: false,
            error: 'Rate limit exceeded',
            retries: retryCount,
          };
        }

        // 5xx retry with backoff
        if (response.status >= 500) {
          retryCount++;
          lastError = `HTTP ${response.status}: ${response.statusText}`;

          if (attempt < maxRetries) {
            const delayMs = retryDelayMs * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          return {
            success: false,
            error: lastError,
            retries: retryCount,
          };
        }

        // Success
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text();
        }

        return {
          success: true,
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body,
            durationMs,
          },
          retries: retryCount,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === 'AbortError') {
          return {
            success: false,
            error: 'Request timeout',
            retries: retryCount,
          };
        }

        throw error;
      }
    } catch (error) {
      retryCount++;
      lastError = error instanceof Error ? error.message : 'Network error';

      if (attempt < maxRetries) {
        const delayMs = retryDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return {
        success: false,
        error: lastError,
        retries: retryCount,
      };
    }
  }

  return {
    success: false,
    error: lastError || 'Max retries exceeded',
    retries: retryCount,
  };
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

    const resultPromise = executeHttpRequest(request, { maxRetries: 0 });
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

    const resultPromise = executeHttpRequest(request, { maxRetries: 0 });
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

    const resultPromise = executeHttpRequest(request, { maxRetries: 3 });
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
    });

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

    const resultPromise = executeHttpRequest(request, { maxRetries: 2 });

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
    });

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    expect(result.retries).toBe(3); // Each failed attempt increments retry count
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
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
  });
});
