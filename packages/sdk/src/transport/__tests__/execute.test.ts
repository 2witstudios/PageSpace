import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, TimeoutError } from '../../errors.js';
import { executeRequest } from '../execute.js';
import type { RequestDescriptor } from '../types.js';

const descriptor: RequestDescriptor = {
  method: 'GET',
  url: 'https://pagespace.ai/api/widgets/w1',
  headers: { 'X-PageSpace-API-Version': '1.0.0' },
  body: undefined,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('executeRequest — success', () => {
  it('resolves with status, headers, and bodyText from the injected fetch', async () => {
    const response = new Response('{"ok":true}', { status: 200, headers: { 'X-Test': '1' } });
    const fetchMock = vi.fn(async () => response);

    const result = await executeRequest(descriptor, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 1000,
      abortFactory: () => new AbortController(),
    });

    expect(result.status).toBe(200);
    expect(result.headers.get('X-Test')).toBe('1');
    expect(result.bodyText).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      descriptor.url,
      expect.objectContaining({ method: 'GET', headers: descriptor.headers }),
    );
  });
});

describe('executeRequest — timeout', () => {
  it('maps an abort triggered by the timeout to TimeoutError, using a fake abort factory', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );

    const promise = executeRequest(descriptor, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 30,
      abortFactory: () => controller,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });

  it('sets timeoutMs on the thrown TimeoutError', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );

    const promise = executeRequest(descriptor, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 30,
      abortFactory: () => controller,
    });
    const assertion = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30);
    const error = (await assertion) as TimeoutError;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.timeoutMs).toBe(30);
  });
});

describe('executeRequest — network failure', () => {
  it('maps a non-abort fetch rejection to NetworkError, preserving the cause', async () => {
    const original = new Error('getaddrinfo ENOTFOUND pagespace.ai');
    const fetchMock = vi.fn(async () => {
      throw original;
    });

    const promise = executeRequest(descriptor, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 1000,
      abortFactory: () => new AbortController(),
    });

    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    const error = (await promise.catch((e: unknown) => e)) as NetworkError;
    expect(error.cause).toBe(original);
  });
});
