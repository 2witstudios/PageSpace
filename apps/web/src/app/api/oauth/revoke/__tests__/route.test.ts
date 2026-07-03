/**
 * POST /api/oauth/revoke — RFC 7009 token revocation (task
 * qyqgrjbvntpsdh578k0yiwgr). Zero-trust posture: an unknown, foreign, or
 * already-revoked token is INDISTINGUISHABLE from a successful revocation —
 * revocation endpoints never confirm token existence (no oracle), while
 * form-level malformed requests (missing token/client_id) still get a
 * distinct invalid_request, matching the token endpoint's precedent for
 * malformed-syntax vs credential-shaped rejections.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const ensureOAuthClientRow = vi.fn();
const revokeOAuthToken = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: (...args: unknown[]) => ensureOAuthClientRow(...args),
  revokeOAuthToken: (...args: unknown[]) => revokeOAuthToken(...args),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { POST } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const CLIENT_ID = 'pagespace-cli';
const CLIENT_DB_ID = 'client-db-id-1';

function revokeRequest(fields: Record<string, string | undefined>, contentType = 'application/x-www-form-urlencoded'): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  return new Request('http://web.local/api/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body.toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureOAuthClientRow.mockResolvedValue(CLIENT_DB_ID);
  revokeOAuthToken.mockResolvedValue(undefined);
});

describe('POST /api/oauth/revoke — form-encoding enforcement', () => {
  it('rejects a JSON content-type with invalid_request', async () => {
    const req = new Request('http://web.local/api/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'ps_at_x', client_id: CLIENT_ID }),
    });

    const res = await POST(req as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(revokeOAuthToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/revoke — happy path', () => {
  it('revokes a refresh token and returns 200 with an empty body', async () => {
    const res = await POST(
      revokeRequest({ token: 'ps_rt_' + 'a'.repeat(43), client_id: CLIENT_ID }) as never,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(revokeOAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'ps_rt_' + 'a'.repeat(43), clientDbId: CLIENT_DB_ID }),
    );
  });

  it('revokes an access token and returns 200 with an empty body', async () => {
    const res = await POST(
      revokeRequest({ token: 'ps_at_' + 'b'.repeat(43), client_id: CLIENT_ID }) as never,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(revokeOAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'ps_at_' + 'b'.repeat(43), clientDbId: CLIENT_DB_ID }),
    );
  });

  it('sets Cache-Control: no-store', async () => {
    const res = await POST(revokeRequest({ token: 'ps_at_' + 'c'.repeat(43), client_id: CLIENT_ID }) as never);

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('honors token_type_hint when present without changing the outcome', async () => {
    const res = await POST(
      revokeRequest({ token: 'ps_at_' + 'd'.repeat(43), client_id: CLIENT_ID, token_type_hint: 'access_token' }) as never,
    );

    expect(res.status).toBe(200);
    expect(revokeOAuthToken).toHaveBeenCalled();
  });
});

describe('POST /api/oauth/revoke — no oracle (unknown/foreign/already-revoked → 200)', () => {
  it('an unknown token still returns 200, empty body', async () => {
    const res = await POST(revokeRequest({ token: 'ps_at_' + 'e'.repeat(43), client_id: CLIENT_ID }) as never);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('a garbage/malformed token value (not ps_at_/ps_rt_ shaped) still returns 200', async () => {
    const res = await POST(revokeRequest({ token: 'totally-not-a-token', client_id: CLIENT_ID }) as never);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(revokeOAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'totally-not-a-token' }),
    );
  });

  it('an unknown client_id still returns 200, empty body — same as an unknown token', async () => {
    const res = await POST(revokeRequest({ token: 'ps_at_' + 'f'.repeat(43), client_id: 'evil-client' }) as never);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(revokeOAuthToken).not.toHaveBeenCalled();
  });

  it('a repository no-op (already revoked / foreign to this client) still returns 200', async () => {
    revokeOAuthToken.mockResolvedValue(undefined);

    const res = await POST(revokeRequest({ token: 'ps_rt_' + 'g'.repeat(43), client_id: CLIENT_ID }) as never);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('POST /api/oauth/revoke — malformed request (invalid_request, distinguishable from a credential rejection)', () => {
  it('missing token → invalid_request, never calls the repository', async () => {
    const res = await POST(revokeRequest({ client_id: CLIENT_ID }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(revokeOAuthToken).not.toHaveBeenCalled();
  });

  it('missing client_id → invalid_request, never calls the repository', async () => {
    const res = await POST(revokeRequest({ token: 'ps_at_' + 'h'.repeat(43) }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(revokeOAuthToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/revoke — audit logging', () => {
  it('audits a successful revocation', async () => {
    await POST(revokeRequest({ token: 'ps_at_' + 'i'.repeat(43), client_id: CLIENT_ID }) as never);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'auth.token.revoked' }),
    );
  });
});
