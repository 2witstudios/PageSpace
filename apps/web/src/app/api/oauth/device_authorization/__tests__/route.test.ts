/**
 * POST /api/oauth/device_authorization (task mwexjazwha2uhw5bmvc9a7kw).
 * RFC 8628 §3.1-3.2: form-encoding enforcement, unknown client rejection,
 * scope grammar validation, the response shape, and hashed storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const ensureOAuthClientRow = vi.fn();
const createDeviceAuthorization = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: (...args: unknown[]) => ensureOAuthClientRow(...args),
  createDeviceAuthorization: (...args: unknown[]) => createDeviceAuthorization(...args),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { POST } from '../route';

const CLIENT_ID = 'pagespace-cli';
const CLIENT_DB_ID = 'client-db-id-1';

function deviceAuthRequest(fields: Record<string, string | undefined>, contentType = 'application/x-www-form-urlencoded'): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  return new Request('http://web.local/api/oauth/device_authorization', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body.toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureOAuthClientRow.mockResolvedValue(CLIENT_DB_ID);
  createDeviceAuthorization.mockResolvedValue(undefined);
});

describe('POST /api/oauth/device_authorization — form-encoding enforcement', () => {
  it('rejects a JSON content-type with invalid_request', async () => {
    const req = new Request('http://web.local/api/oauth/device_authorization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });

    const res = await POST(req as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device_authorization — client validation', () => {
  it('missing client_id → invalid_request', async () => {
    const res = await POST(deviceAuthRequest({}) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
  });

  it('unknown client_id → invalid_client', async () => {
    const res = await POST(deviceAuthRequest({ client_id: 'evil-client' }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_client' });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device_authorization — scope validation', () => {
  it('malformed scope → invalid_scope, never persists', async () => {
    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID, scope: 'not a real scope!' }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
  });

  it('accepts a well-formed scope and forwards the parsed set to the repository', async () => {
    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID, scope: 'account offline_access' }) as never);
    expect(res.status).toBe(200);
    expect(createDeviceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['account', 'offline_access'] }),
    );
  });
});

describe('POST /api/oauth/device_authorization — happy path', () => {
  it('returns the RFC 8628 §3.2 response shape', async () => {
    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      verification_uri: expect.stringContaining('/activate'),
      verification_uri_complete: expect.stringContaining('/activate?user_code='),
      expires_in: expect.any(Number),
      interval: expect.any(Number),
    });
  });

  it('sets Cache-Control: no-store (the response carries secrets)', async () => {
    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('persists only hashed device_code and user_code — never the raw values', async () => {
    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);
    const body = await res.json();

    expect(createDeviceAuthorization).toHaveBeenCalledTimes(1);
    const call = createDeviceAuthorization.mock.calls[0][0];
    expect(call.deviceCodeHash).not.toBe(body.device_code);
    expect(call.userCodeHash).not.toBe(body.user_code);
    expect(call.clientDbId).toBe(CLIENT_DB_ID);
  });

  it('resolves the client DB row before minting codes', async () => {
    await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);
    expect(ensureOAuthClientRow).toHaveBeenCalledWith(expect.objectContaining({ clientId: CLIENT_ID }));
  });
});
