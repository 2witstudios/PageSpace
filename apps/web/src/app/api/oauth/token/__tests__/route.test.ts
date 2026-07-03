/**
 * POST /api/oauth/token — authorization_code + PKCE grant (task
 * suty9f9jbha82c0831e9rjec). Covers: form-encoding enforcement, the RFC
 * 6749 §5.1 happy-path shape, every rejection collapsing to the same
 * constant-shape body, Cache-Control: no-store, and the public-client
 * confusion guard (no client secret accepted).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const ensureOAuthClientRow = vi.fn();
const exchangeAuthorizationCode = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: (...args: unknown[]) => ensureOAuthClientRow(...args),
  exchangeAuthorizationCode: (...args: unknown[]) => exchangeAuthorizationCode(...args),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { POST } from '../route';

const REDIRECT_URI = 'http://127.0.0.1:51234/callback';
const CLIENT_ID = 'pagespace-cli';
const CLIENT_DB_ID = 'client-db-id-1';

function tokenRequest(fields: Record<string, string | undefined>, contentType = 'application/x-www-form-urlencoded'): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  return new Request('http://web.local/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body.toString(),
  });
}

function validFields(overrides: Record<string, string | undefined> = {}) {
  return {
    grant_type: 'authorization_code',
    code: 'raw-code-value',
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: 'a'.repeat(43),
    ...overrides,
  };
}

const okTokens = {
  accessToken: 'ps_at_' + 'a'.repeat(43),
  refreshToken: 'ps_rt_' + 'b'.repeat(43),
  accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
  refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  familyId: 'family-1',
  familyExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
};

beforeEach(() => {
  vi.clearAllMocks();
  ensureOAuthClientRow.mockResolvedValue(CLIENT_DB_ID);
});

describe('POST /api/oauth/token — form-encoding enforcement', () => {
  it('rejects a JSON content-type with invalid_request', async () => {
    const req = new Request('http://web.local/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validFields()),
    });

    const res = await POST(req as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('never reaches the repository when content-type is not form-urlencoded', async () => {
    const req = new Request('http://web.local/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validFields()),
    });

    await POST(req as never);

    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/token — happy path', () => {
  it('returns the RFC 6749 §5.1 token response shape', async () => {
    exchangeAuthorizationCode.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account', 'offline_access'],
      tokens: okTokens,
    });

    const res = await POST(tokenRequest(validFields()) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: okTokens.accessToken,
      token_type: 'Bearer',
      expires_in: 15 * 60,
      refresh_token: okTokens.refreshToken,
      scope: 'account offline_access',
    });
  });

  it('sets Cache-Control: no-store', async () => {
    exchangeAuthorizationCode.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account'],
      tokens: okTokens,
    });

    const res = await POST(tokenRequest(validFields()) as never);

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('passes the raw code, redirect_uri, code_verifier, and resolved clientDbId through to the repository', async () => {
    exchangeAuthorizationCode.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account'],
      tokens: okTokens,
    });

    await POST(tokenRequest(validFields()) as never);

    expect(exchangeAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'raw-code-value',
        redirectUri: REDIRECT_URI,
        codeVerifier: 'a'.repeat(43),
        clientDbId: CLIENT_DB_ID,
      }),
    );
  });
});

describe('POST /api/oauth/token — constant-shape failures (no oracle)', () => {
  const CONSTANT_BODY = { error: 'invalid_grant' };

  it('unknown client_id → constant shape, no-store, never calls the repository', async () => {
    const res = await POST(tokenRequest(validFields({ client_id: 'evil-client' })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('unknown/expired/already-consumed code (not_found) → constant shape', async () => {
    exchangeAuthorizationCode.mockResolvedValue({ outcome: 'not_found' });

    const res = await POST(tokenRequest(validFields()) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
  });

  it('expired code → the SAME constant shape as unknown code', async () => {
    exchangeAuthorizationCode.mockResolvedValue({ outcome: 'rejected', decision: { status: 'expired' } });

    const res = await POST(tokenRequest(validFields()) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
  });

  it('redirect_mismatch → the SAME constant shape', async () => {
    exchangeAuthorizationCode.mockResolvedValue({ outcome: 'rejected', decision: { status: 'redirect_mismatch' } });

    const res = await POST(tokenRequest(validFields()) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
  });

  it('pkce_failed → the SAME constant shape', async () => {
    exchangeAuthorizationCode.mockResolvedValue({ outcome: 'rejected', decision: { status: 'pkce_failed' } });

    const res = await POST(tokenRequest(validFields()) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
  });

  it('already_consumed (reuse) → the SAME constant shape (no "you already used this" leak)', async () => {
    exchangeAuthorizationCode.mockResolvedValue({
      outcome: 'rejected',
      decision: { status: 'already_consumed', revokeIssuedTokens: true },
    });

    const res = await POST(tokenRequest(validFields()) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
  });

  it('missing required fields → invalid_request (malformed syntax, distinct from invalid_grant)', async () => {
    const res = await POST(tokenRequest(validFields({ code_verifier: undefined })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/token — public client confusion guard', () => {
  it('rejects a request presenting a client_secret for the public CLI client', async () => {
    const res = await POST(tokenRequest(validFields({ client_secret: 'anything' })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('accepts the same request with no client_secret present', async () => {
    exchangeAuthorizationCode.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account'],
      tokens: okTokens,
    });

    const res = await POST(tokenRequest(validFields()) as never);

    expect(res.status).toBe(200);
  });
});
