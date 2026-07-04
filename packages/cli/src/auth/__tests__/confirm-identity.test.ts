import { describe, expect, it } from 'vitest';
import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';
import { whoamiOperation } from '@pagespace/cli';

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
