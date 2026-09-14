/**
 * The device-authorization door is FIRST-PARTY ONLY (point guard ruling on
 * Phase 1a leaf 3). It resolves `client_id` against the static registry, never
 * `resolveClient`, because it never runs `validateAuthorizeRequest` — and so
 * never runs the per-client scope cap (`scopeSetFitsCap`). A registered
 * third-party client that could start a device flow would get the device grant
 * with NO cap. Enabling third-party device flow requires wiring the cap first;
 * this test fails the moment the lookup widens without it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const THIRD_PARTY = {
  clientId: 'app_swipesend',
  name: 'SwipeSend',
  type: 'public' as const,
  redirectUris: ['https://swipesend.app/auth/pagespace/callback'],
  // The row even lists the device grant — it must not matter.
  allowedGrantTypes: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
  allowedScopes: ['profile', 'drive:member', 'offline_access'],
  firstParty: false,
  verified: true,
};

const resolveClient = vi.fn();
const resolveClientDbId = vi.fn();
const ensureOAuthClientRow = vi.fn();
const createDeviceAuthorization = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  resolveClient: (...args: unknown[]) => resolveClient(...args),
  resolveClientDbId: (...args: unknown[]) => resolveClientDbId(...args),
  ensureOAuthClientRow: (...args: unknown[]) => ensureOAuthClientRow(...args),
  createDeviceAuthorization: (...args: unknown[]) => createDeviceAuthorization(...args),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getClientIP: vi.fn().mockReturnValue('203.0.113.14') }));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { OAUTH_DEVICE_INIT: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: false } },
}));

import { POST } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  checkDistributedRateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 9 });
  resolveClient.mockResolvedValue(THIRD_PARTY);
  resolveClientDbId.mockResolvedValue('db-row-1');
  ensureOAuthClientRow.mockResolvedValue('db-row-1');
});

describe('POST /api/oauth/device_authorization — first-party only', () => {
  it('answers a DB-registered third-party client_id with invalid_client, even when its row lists the device_code grant', async () => {
    const res = await POST(
      new Request('http://web.local/api/oauth/device_authorization', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'app_swipesend', scope: 'profile offline_access' }).toString(),
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_client' });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
  });
});
