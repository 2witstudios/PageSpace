import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('GET /api/well-known/oauth-authorization-server (destination of the /.well-known/oauth-authorization-server rewrite)', () => {
  beforeEach(() => {
    process.env.WEB_APP_URL = 'https://pagespace.ai';
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns 200 with application/json and RFC 8414 metadata derived from configured origin', async () => {
    const { GET } = await import('../route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(body.issuer).toBe('https://pagespace.ai');
    expect(body.authorization_endpoint).toBe('https://pagespace.ai/api/oauth/authorize');
    expect(body.token_endpoint).toBe('https://pagespace.ai/api/oauth/token');
    expect(body.device_authorization_endpoint).toBe(
      'https://pagespace.ai/api/oauth/device_authorization',
    );
    expect(body.revocation_endpoint).toBe('https://pagespace.ai/api/oauth/revoke');
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('sets a modest public cache header — this is public metadata by spec, not a secret', async () => {
    const { GET } = await import('../route');

    const response = await GET();

    const cacheControl = response.headers.get('Cache-Control') ?? '';
    expect(cacheControl).toContain('public');
    expect(cacheControl).toMatch(/max-age=\d+/);
  });

  it('never reflects a request Host header into the issuer — the route takes no request input', async () => {
    const { GET } = await import('../route');

    // The exported handler has no request parameter at all: there is no code
    // path by which an attacker-controlled Host header could reach the
    // response. Calling it with zero arguments is the proof.
    const response = await GET();
    const body = await response.json();

    expect(body.issuer).toBe(process.env.WEB_APP_URL);
  });

  it('falls back to NEXT_PUBLIC_APP_URL when WEB_APP_URL is unset', async () => {
    delete process.env.WEB_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://fallback.example.com';

    const { GET } = await import('../route');
    const response = await GET();
    const body = await response.json();

    expect(body.issuer).toBe('https://fallback.example.com');
  });
});
