/**
 * `RegisteredClient.allowedGrantTypes` (`packages/lib/src/auth/oauth/clients.ts:19`)
 * is defined but was never enforced at the token endpoint — any registered
 * client could use any grant regardless of its declared allow-list. This
 * suite mocks the static client registry with a deliberately restricted
 * client (unlike the real first-party CLI, which allows all three) to
 * exercise the enforcement in isolation from `route.test.ts`, which relies on
 * the real (unrestricted) registry throughout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const RESTRICTED_CLIENT_ID = 'restricted-client';
const RESTRICTED_CLIENT = {
  clientId: RESTRICTED_CLIENT_ID,
  name: 'Restricted Client',
  type: 'public' as const,
  redirectUris: ['http://127.0.0.1/callback'],
  allowedGrantTypes: ['authorization_code'] as const,
  firstParty: false,
};

vi.mock('@pagespace/lib/auth/oauth/clients', () => ({
  getRegisteredClient: (clientId: string) => (clientId === RESTRICTED_CLIENT_ID ? RESTRICTED_CLIENT : null),
}));

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

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/client-ip', () => ({
  getClientIP: vi.fn().mockReturnValue('203.0.113.11'),
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: {
    OAUTH_TOKEN_EXCHANGE: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: true },
    OAUTH_DEVICE_POLL: { maxAttempts: 100, windowMs: 300_000, progressiveDelay: false },
  },
}));

import { POST } from '../route';

const ALLOWED = { allowed: true, attemptsRemaining: 9 };

function tokenRequest(fields: Record<string, string | undefined>): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  return new Request('http://web.local/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureOAuthClientRow.mockResolvedValue('restricted-client-db-id');
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
});

describe('POST /api/oauth/token — allowedGrantTypes enforcement', () => {
  it('rejects a refresh_token grant for a client whose allowedGrantTypes excludes it, never calling the repository', async () => {
    const res = await POST(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: 'raw-refresh-token-value',
        client_id: RESTRICTED_CLIENT_ID,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    expect(refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('rejects a device_code grant for a client whose allowedGrantTypes excludes it, never calling the repository', async () => {
    const res = await POST(
      tokenRequest({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'raw-device-code-value',
        client_id: RESTRICTED_CLIENT_ID,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    expect(pollDeviceToken).not.toHaveBeenCalled();
  });

  it('allows the grant type the client IS registered for', async () => {
    exchangeAuthorizationCode.mockResolvedValue({
      outcome: 'ok',
      userId: 'user-1',
      scopes: ['account'],
      tokens: {
        accessToken: 'ps_at_' + 'a'.repeat(43),
        refreshToken: undefined,
        accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        familyId: 'family-1',
        familyExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await POST(
      tokenRequest({
        grant_type: 'authorization_code',
        code: 'raw-code-value',
        redirect_uri: 'http://127.0.0.1/callback',
        client_id: RESTRICTED_CLIENT_ID,
        code_verifier: 'a'.repeat(43),
      }) as never,
    );

    expect(res.status).toBe(200);
    expect(exchangeAuthorizationCode).toHaveBeenCalled();
  });
});
