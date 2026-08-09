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

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('203.0.113.13'),
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { OAUTH_DEVICE_INIT: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: false } },
}));

import { POST } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

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

const ALLOWED = { allowed: true, attemptsRemaining: 9 };

beforeEach(() => {
  vi.clearAllMocks();
  ensureOAuthClientRow.mockResolvedValue(CLIENT_DB_ID);
  createDeviceAuthorization.mockResolvedValue(undefined);
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
});

describe('POST /api/oauth/device_authorization — per-IP rate limiting', () => {
  it('blocks with 429 when the per-IP limit is exceeded, never persisting a device code', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 300 });

    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);

    expect(res.status).toBe(429);
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
  });

  it('sets Cache-Control: no-store on the rate-limited response', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 300 });

    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('checks the IP dimension keyed by client IP', async () => {
    await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);

    const keys = checkDistributedRateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys.some((k) => k.includes('ip:203.0.113.13'))).toBe(true);
  });

  it('audits the rate-limit trip', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 300 });

    await POST(deviceAuthRequest({ client_id: CLIENT_ID }) as never);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'security.rate.limited' }),
    );
  });
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

  it('accepts an update_key scope — key re-scoping now redeems over the device grant, so a remote machine can edit a key without a local browser', async () => {
    const res = await POST(
      deviceAuthRequest({ client_id: CLIENT_ID, scope: 'update_key:tok123 drive:drv1:member' }) as never,
    );
    expect(res.status).toBe(200);
    expect(createDeviceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: expect.arrayContaining(['update_key:tok123']) }),
    );
  });

  it('accepts an activate_key scope — the `keys use` approval ceremony also works headlessly', async () => {
    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID, scope: 'activate_key:tok123' }) as never);
    expect(res.status).toBe(200);
    expect(createDeviceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: expect.arrayContaining(['activate_key:tok123']) }),
    );
  });

  it('accepts a named mint scope — `keys create --device`', async () => {
    const res = await POST(
      deviceAuthRequest({ client_id: CLIENT_ID, scope: 'drive:drv1:member name:remote-key offline_access' }) as never,
    );
    expect(res.status).toBe(200);
    expect(createDeviceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: expect.arrayContaining(['name:remote-key']) }),
    );
  });

  it('rejects a mint scope with no name — an unnamed key would redeem to a generic placeholder the user cannot identify', async () => {
    const res = await POST(
      deviceAuthRequest({ client_id: CLIENT_ID, scope: 'drive:drv1:member offline_access' }) as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
  });

  it('still rejects an all_drives scope outright — a device-minted all_drives token lands in the ambiguous allowedDriveIds: [] shape', async () => {
    const res = await POST(deviceAuthRequest({ client_id: CLIENT_ID, scope: 'all_drives offline_access' }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
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
