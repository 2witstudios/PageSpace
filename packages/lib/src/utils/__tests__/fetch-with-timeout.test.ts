import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchWithTimeout,
  DEFAULT_TIMEOUT_MS,
  TimeoutError,
  TIMEOUTS,
} from '../fetch-with-timeout';

describe('fetch-with-timeout', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('DEFAULT_TIMEOUT_MS', () => {
    it('should have a sensible default timeout', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(30000);
    });
  });

  describe('TIMEOUTS', () => {
    it('should have predefined timeout values', () => {
      expect(TIMEOUTS.SHORT).toBe(5000);
      expect(TIMEOUTS.MEDIUM).toBe(15000);
      expect(TIMEOUTS.DEFAULT).toBe(30000);
      expect(TIMEOUTS.LONG).toBe(60000);
      expect(TIMEOUTS.EXTENDED).toBe(120000);
    });
  });

  describe('fetchWithTimeout', () => {
    it('given successful response, should return response', async () => {
      const mockResponse = new Response(JSON.stringify({ data: 'test' }), {
        status: 200,
      });

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const response = await fetchWithTimeout('https://api.example.com/data');

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('given request options, should pass them through', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      await fetchWithTimeout('https://api.example.com/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
        timeout: 10000,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ test: true }),
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('given fetch error, should propagate the error', async () => {
      const networkError = new Error('Network error');
      global.fetch = vi.fn().mockRejectedValue(networkError);

      await expect(
        fetchWithTimeout('https://api.example.com/data')
      ).rejects.toThrow('Network error');
    });

    it('given abort error, should throw TimeoutError', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      global.fetch = vi.fn().mockRejectedValue(abortError);

      await expect(
        fetchWithTimeout('https://api.example.com/data', { timeout: 100 })
      ).rejects.toThrow(TimeoutError);
    });

    it('given abort error, should include URL in error message', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      global.fetch = vi.fn().mockRejectedValue(abortError);

      try {
        await fetchWithTimeout('https://api.example.com/slow', { timeout: 100 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TimeoutError);
        expect((error as Error).message).toContain('https://api.example.com/slow');
        expect((error as Error).message).toContain('100ms');
      }
    });

    it('given zero timeout, should use default timeout', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const response = await fetchWithTimeout('https://api.example.com/data', {
        timeout: 0,
      });

      expect(response.status).toBe(200);
    });

    it('given negative timeout, should use default timeout', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const response = await fetchWithTimeout('https://api.example.com/data', {
        timeout: -1000,
      });

      expect(response.status).toBe(200);
    });
  });

  describe('TimeoutError', () => {
    it('should be an instance of Error', () => {
      const error = new TimeoutError('Test timeout');
      expect(error).toBeInstanceOf(Error);
    });

    it('should have correct name', () => {
      const error = new TimeoutError('Test timeout');
      expect(error.name).toBe('TimeoutError');
    });

    it('should preserve message', () => {
      const error = new TimeoutError('Request timed out after 5000ms');
      expect(error.message).toBe('Request timed out after 5000ms');
    });

    it('should have stack trace', () => {
      const error = new TimeoutError('Test timeout');
      expect(error.stack).toBeDefined();
    });
  });
});
