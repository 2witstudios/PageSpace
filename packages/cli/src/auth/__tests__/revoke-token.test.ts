import { describe, expect, it } from 'vitest';
import { createRevokeToken } from '@pagespace/cli';

const PARAMS = {
  host: 'https://pagespace.ai',
  refreshToken: 'ps_rt_test-refresh-token',
  clientId: 'pagespace-cli',
};

describe('createRevokeToken', () => {
  it('POSTs a form-encoded revocation request to /api/oauth/revoke', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, json: async () => null };
    }) as unknown as typeof fetch;

    const result = await createRevokeToken(fetchImpl)(PARAMS);

    expect(capturedUrl).toBe('https://pagespace.ai/api/oauth/revoke');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get('token')).toBe(PARAMS.refreshToken);
    expect(body.get('client_id')).toBe(PARAMS.clientId);

    expect(result).toEqual({ outcome: 'revoked' });
  });

  it('tolerates a trailing slash on the host', async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => null };
    }) as unknown as typeof fetch;

    await createRevokeToken(fetchImpl)({ ...PARAMS, host: 'https://pagespace.ai/' });

    expect(capturedUrl).toBe('https://pagespace.ai/api/oauth/revoke');
  });

  it('treats a 429 rate-limited response as a transient failure, never as revoked', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate_limited', retryAfter: 30 }),
    })) as unknown as typeof fetch;

    const result = await createRevokeToken(fetchImpl)(PARAMS);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.message).toContain('30');
    }
  });

  it('treats a 5xx response as a transient failure', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;

    const result = await createRevokeToken(fetchImpl)(PARAMS);

    expect(result).toEqual({ outcome: 'failed', message: 'http_503' });
  });

  it('treats a network failure as a transient failure, never throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const result = await createRevokeToken(fetchImpl)(PARAMS);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.message).toContain('ECONNRESET');
    }
  });

  it('never includes the refresh token in a failure message', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;

    const result = await createRevokeToken(fetchImpl)(PARAMS);

    expect(JSON.stringify(result)).not.toContain(PARAMS.refreshToken);
  });
});
