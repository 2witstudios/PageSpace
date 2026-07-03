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
const refreshTokenGrant = vi.fn();
const pollDeviceToken = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: (...args: unknown[]) => ensureOAuthClientRow(...args),
  exchangeAuthorizationCode: (...args: unknown[]) => exchangeAuthorizationCode(...args),
  refreshTokenGrant: (...args: unknown[]) => refreshTokenGrant(...args),
  pollDeviceToken: (...args: unknown[]) => pollDeviceToken(...args),
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

function refreshFields(overrides: Record<string, string | undefined> = {}) {
  return {
    grant_type: 'refresh_token',
    refresh_token: 'raw-refresh-token-value',
    client_id: CLIENT_ID,
    ...overrides,
  };
}

describe('POST /api/oauth/token — refresh_token grant, happy path', () => {
  it('returns the RFC 6749 §5.1 token response shape with a rotated pair', async () => {
    refreshTokenGrant.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account'],
      tokens: okTokens,
    });

    const res = await POST(tokenRequest(refreshFields()) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: okTokens.accessToken,
      token_type: 'Bearer',
      expires_in: 15 * 60,
      refresh_token: okTokens.refreshToken,
      scope: 'account',
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('passes the raw refresh token, resolved clientDbId, and requested scope through to the repository', async () => {
    refreshTokenGrant.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account'],
      tokens: okTokens,
    });

    await POST(tokenRequest(refreshFields({ scope: 'account' })) as never);

    expect(refreshTokenGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: 'raw-refresh-token-value',
        clientDbId: CLIENT_DB_ID,
        requestedScope: 'account',
      }),
    );
  });

  it('passes requestedScope: null when no scope param is present', async () => {
    refreshTokenGrant.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account'],
      tokens: okTokens,
    });

    await POST(tokenRequest(refreshFields()) as never);

    expect(refreshTokenGrant).toHaveBeenCalledWith(expect.objectContaining({ requestedScope: null }));
  });
});

describe('POST /api/oauth/token — refresh_token grant, constant-shape failures (no oracle)', () => {
  const CONSTANT_BODY = { error: 'invalid_grant' };

  it('unknown client_id → constant shape, never calls the repository', async () => {
    const res = await POST(tokenRequest(refreshFields({ client_id: 'evil-client' })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
    expect(refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('unknown/expired/revoked refresh token → constant shape, same as an unknown one', async () => {
    refreshTokenGrant.mockResolvedValue({ outcome: 'invalid_grant' });

    const res = await POST(tokenRequest(refreshFields()) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
  });

  it('reuse of a rotated token (theft) → the SAME constant shape (no "we detected theft" leak)', async () => {
    refreshTokenGrant.mockResolvedValue({ outcome: 'invalid_grant' });

    const res = await POST(tokenRequest(refreshFields()) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CONSTANT_BODY);
  });

  it('missing refresh_token → invalid_request (malformed syntax, distinct from invalid_grant)', async () => {
    const res = await POST(tokenRequest(refreshFields({ refresh_token: undefined })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('missing client_id → invalid_request', async () => {
    const res = await POST(tokenRequest(refreshFields({ client_id: undefined })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('a client_secret presented for the public CLI client → invalid_request, never calls the repository', async () => {
    const res = await POST(tokenRequest(refreshFields({ client_secret: 'anything' })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('scope escalation attempt → invalid_scope (distinguishable — the credential itself was valid)', async () => {
    refreshTokenGrant.mockResolvedValue({ outcome: 'invalid_scope' });

    const res = await POST(tokenRequest(refreshFields({ scope: 'drive:abc123:admin' })) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
  });
});

describe('POST /api/oauth/token — unsupported grant_type', () => {
  it('rejects an unrecognized grant_type', async () => {
    const res = await POST(tokenRequest({ grant_type: 'client_credentials' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_grant_type' });
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(refreshTokenGrant).not.toHaveBeenCalled();
  });
});

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function deviceFields(overrides: Record<string, string | undefined> = {}) {
  return {
    grant_type: DEVICE_GRANT_TYPE,
    device_code: 'raw-device-code-value',
    client_id: CLIENT_ID,
    ...overrides,
  };
}

describe('POST /api/oauth/token — device_code grant, happy path', () => {
  it('returns the RFC 6749 §5.1 token response shape on approval', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'ok', userId: 'user-1', scopes: ['account'], tokens: okTokens });

    const res = await POST(tokenRequest(deviceFields()) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: okTokens.accessToken,
      token_type: 'Bearer',
      expires_in: 15 * 60,
      refresh_token: okTokens.refreshToken,
      scope: 'account',
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('passes the raw device_code and resolved clientDbId through to the repository', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'ok', userId: 'user-1', scopes: ['account'], tokens: okTokens });

    await POST(tokenRequest(deviceFields()) as never);

    expect(pollDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceCode: 'raw-device-code-value', clientDbId: CLIENT_DB_ID }),
    );
  });
});

describe('POST /api/oauth/token — device_code grant, RFC 8628 §3.5 poll outcomes', () => {
  it('authorization_pending → distinct error (the CLI must keep polling)', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'authorization_pending' });
    const res = await POST(tokenRequest(deviceFields()) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'authorization_pending' });
  });

  it('slow_down → distinct error (the CLI must back off its poll interval)', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'slow_down' });
    const res = await POST(tokenRequest(deviceFields()) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'slow_down' });
  });

  it('expired_token → distinct error (the CLI must restart the flow)', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'expired_token' });
    const res = await POST(tokenRequest(deviceFields()) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'expired_token' });
  });

  it('access_denied → distinct error (the user said no)', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'access_denied' });
    const res = await POST(tokenRequest(deviceFields()) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'access_denied' });
  });

  it('unknown device_code (not_found) → invalid_grant, same as an unknown auth code', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'not_found' });
    const res = await POST(tokenRequest(deviceFields()) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });

  it('sets Cache-Control: no-store on every poll outcome', async () => {
    pollDeviceToken.mockResolvedValue({ outcome: 'authorization_pending' });
    const res = await POST(tokenRequest(deviceFields()) as never);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('unknown client_id → invalid_grant, never calls the repository', async () => {
    const res = await POST(tokenRequest(deviceFields({ client_id: 'evil-client' })) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    expect(pollDeviceToken).not.toHaveBeenCalled();
  });

  it('missing device_code → invalid_request', async () => {
    const res = await POST(tokenRequest(deviceFields({ device_code: undefined })) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(pollDeviceToken).not.toHaveBeenCalled();
  });

  it('a client_secret presented for the public CLI client → invalid_request, never calls the repository', async () => {
    const res = await POST(tokenRequest(deviceFields({ client_secret: 'anything' })) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(pollDeviceToken).not.toHaveBeenCalled();
  });
});
