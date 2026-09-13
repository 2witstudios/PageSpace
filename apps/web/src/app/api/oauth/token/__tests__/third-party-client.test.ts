/**
 * Token endpoint × DB-backed third-party clients (Phase 1a leaf 3, ADR 0004
 * Decisions 1-2). The route resolves the client through `resolveClient`
 * (static first, then an enabled `oauth_clients` row) and takes the FK id from
 * `resolveClientDbId`. Every rejection keeps the constant shape: an unknown
 * client, a disabled one, and one that vanished mid-request look identical.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const THIRD_PARTY = {
  clientId: 'app_swipesend',
  name: 'SwipeSend',
  type: 'public' as const,
  redirectUris: ['https://swipesend.app/auth/pagespace/callback'],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],
  allowedScopes: ['profile', 'drive:member', 'offline_access'],
  firstParty: false,
  verified: false,
};

const resolveClient = vi.fn();
const resolveClientDbId = vi.fn();
const exchangeAuthorizationCode = vi.fn();
const refreshTokenGrant = vi.fn();
const pollDeviceToken = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  resolveClient: (...args: unknown[]) => resolveClient(...args),
  resolveClientDbId: (...args: unknown[]) => resolveClientDbId(...args),
  ensureOAuthClientRow: vi.fn(),
  exchangeAuthorizationCode: (...args: unknown[]) => exchangeAuthorizationCode(...args),
  refreshTokenGrant: (...args: unknown[]) => refreshTokenGrant(...args),
  pollDeviceToken: (...args: unknown[]) => pollDeviceToken(...args),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(), logTokenActivity: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getClientIP: vi.fn().mockReturnValue('203.0.113.12') }));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: {
    OAUTH_TOKEN_EXCHANGE: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: true },
    OAUTH_DEVICE_POLL: { maxAttempts: 100, windowMs: 300_000, progressiveDelay: false },
  },
}));

import { POST } from '../route';

function tokenRequest(fields: Record<string, string>): Request {
  return new Request('http://web.local/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

const CODE_GRANT = {
  grant_type: 'authorization_code',
  code: 'raw-code-value',
  redirect_uri: 'https://swipesend.app/auth/pagespace/callback',
  client_id: 'app_swipesend',
  code_verifier: 'a'.repeat(43),
};

const TOKENS = {
  accessToken: 'ps_at_' + 'a'.repeat(43),
  refreshToken: 'ps_rt_' + 'b'.repeat(43),
  accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
  familyId: 'family-1',
  familyExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
};

beforeEach(() => {
  vi.clearAllMocks();
  checkDistributedRateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 9 });
  resolveClient.mockImplementation(async (id: string) => (id === THIRD_PARTY.clientId ? THIRD_PARTY : null));
  resolveClientDbId.mockResolvedValue('db-row-1');
});

describe('POST /api/oauth/token — DB-backed third-party client', () => {
  it('resolves the client through resolveClient and exchanges against its own row id', async () => {
    exchangeAuthorizationCode.mockResolvedValue({ outcome: 'ok', userId: 'user-1', scopes: ['profile'], tokens: TOKENS });

    const res = await POST(tokenRequest(CODE_GRANT) as never);

    expect(res.status).toBe(200);
    expect(resolveClient).toHaveBeenCalledWith('app_swipesend');
    expect(resolveClientDbId).toHaveBeenCalledWith(THIRD_PARTY);
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({ clientDbId: 'db-row-1' }));
  });

  it('rejects any client_secret on a public client with invalid_request, never calling the repository', async () => {
    const res = await POST(tokenRequest({ ...CODE_GRANT, client_secret: 'shh' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('rejects a client_secret as invalid_request even on a grant the client is not allowed', async () => {
    const res = await POST(
      tokenRequest({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'raw-device-code',
        client_id: 'app_swipesend',
        client_secret: 'shh',
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('rejects a grant type outside allowedGrantTypes with invalid_grant', async () => {
    const res = await POST(
      tokenRequest({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'raw-device-code',
        client_id: 'app_swipesend',
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    expect(pollDeviceToken).not.toHaveBeenCalled();
  });

  it('answers an unknown client, a disabled client, and a client whose row vanished with the identical rejection', async () => {
    const unknown = await POST(tokenRequest({ ...CODE_GRANT, client_id: 'app_nope' }) as never);

    resolveClient.mockResolvedValueOnce(null); // disabled: resolveClient cannot tell it from unknown
    const disabled = await POST(tokenRequest(CODE_GRANT) as never);

    resolveClientDbId.mockResolvedValueOnce(null); // disabled between resolution and issuance
    const vanished = await POST(tokenRequest(CODE_GRANT) as never);

    for (const res of [unknown, disabled, vanished]) {
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    const bodies = await Promise.all([unknown.json(), disabled.json(), vanished.json()]);
    expect(bodies).toEqual([{ error: 'invalid_grant' }, { error: 'invalid_grant' }, { error: 'invalid_grant' }]);
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });
});
