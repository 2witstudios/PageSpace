import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';
import { CONFIRM_IDENTITY_TIMEOUT_MS, confirmIdentity, whoamiOperation } from '@pagespace/cli';

describe('whoamiOperation', () => {
  it('is a GET against /api/auth/me carrying the access token as a Bearer header', async () => {
    let capturedAuth: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization ?? null;
      return new Response(JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new PageSpaceClient({
      baseUrl: 'https://pagespace.ai',
      auth: new StaticTokenProvider('ps_at_test-token'),
      fetch: fetchImpl,
      skipVersionCheck: true,
    });

    const result = await client.invoke(whoamiOperation, {});

    expect(whoamiOperation.method).toBe('GET');
    expect(whoamiOperation.path).toBe('/api/auth/me');
    expect(capturedAuth).toBe('Bearer ps_at_test-token');
    expect(result).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });
});

describe('confirmIdentity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bounds its wait to ~3s with zero retries against a server that never responds', async () => {
    let callCount = 0;
    const neverRespondingFetch = (async (_url: string, init?: RequestInit) => {
      callCount += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', neverRespondingFetch);

    const start = Date.now();
    await expect(confirmIdentity({ host: 'https://pagespace.ai', accessToken: 'ps_at_test-token' })).rejects.toThrow();
    const elapsedMs = Date.now() - start;

    // Zero retries: exactly one attempt, not up to 3 (the SDK default).
    expect(callCount).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(CONFIRM_IDENTITY_TIMEOUT_MS - 100);
    expect(elapsedMs).toBeLessThan(CONFIRM_IDENTITY_TIMEOUT_MS + 2_000);
  }, 8_000);
});
