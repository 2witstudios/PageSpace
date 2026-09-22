/**
 * Rate limiting for the pagespace-agent token grants (jwt-bearer and its
 * refresh_token grant). Every agent shares `client_id=pagespace-agent`, so a
 * per-client bucket would be ONE platform-wide bucket that a single IP could
 * exhaust to lock every agent out. Agents are limited per IP (AGENT_TOKEN_IP,
 * 60/5min) and per presented credential (AGENT_TOKEN_CREDENTIAL, 10/5min).
 *
 * The limiter here is a COUNTING fake that honours each config's maxAttempts,
 * so which bucket the route chooses is what these tests observe.
 * pagespace-cli keeps its per-client bucket unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  exchangeAgentAssertion: vi.fn(),
  refreshTokenGrant: vi.fn(),
}));

vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: vi.fn().mockResolvedValue('client-db'),
  exchangeAuthorizationCode: vi.fn(),
  refreshTokenGrant: mocks.refreshTokenGrant,
  pollDeviceToken: vi.fn(),
  exchangeAgentAssertion: mocks.exchangeAgentAssertion,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/onboarding/home-drive', () => ({ provisionHomeDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'home', created: false }) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(), logTokenActivity: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getClientIP: (req: Request) => req.headers.get('x-test-ip') ?? 'unknown' }));
vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => true,
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: async (key: string, config: { maxAttempts: number; windowMs: number }) => {
    const count = (mocks.counts.get(key) ?? 0) + 1;
    mocks.counts.set(key, count);
    return count <= config.maxAttempts ? { allowed: true } : { allowed: false, retryAfter: config.windowMs / 1000 };
  },
  DISTRIBUTED_RATE_LIMITS: {
    OAUTH_TOKEN_EXCHANGE: { maxAttempts: 10, windowMs: 300_000 },
    OAUTH_DEVICE_POLL: { maxAttempts: 100, windowMs: 300_000 },
    AGENT_TOKEN_IP: { maxAttempts: 60, windowMs: 300_000 },
    AGENT_TOKEN_CREDENTIAL: { maxAttempts: 10, windowMs: 300_000 },
  },
}));

import { POST } from '../route';

const JWT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const secret = (n: number) => `ps_agent_${String(n).padStart(32, '0')}`;
const refresh = (n: number) => `ps_rt_${String(n).padStart(43, '0')}`;
const tokens = { accessToken: 'ps_at_x', refreshToken: 'ps_rt_y', familyId: 'f' };

function post(ip: string, fields: Record<string, string>) {
  return POST(new Request('http://web.local/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-ip': ip },
    body: new URLSearchParams(fields).toString(),
  }) as never);
}
const exchange = (ip: string, n: number) => post(ip, { grant_type: JWT, assertion: secret(n), client_id: 'pagespace-agent' });
const refreshAs = (ip: string, n: number, clientId = 'pagespace-agent') => post(ip, { grant_type: 'refresh_token', refresh_token: refresh(n), client_id: clientId });

const RATE_LIMITED = { error: 'rate_limited', retryAfter: 300 };

describe('pagespace-agent token grants — per-IP and per-credential buckets', () => {
  beforeEach(() => {
    mocks.counts.clear();
    mocks.exchangeAgentAssertion.mockReset().mockResolvedValue({ outcome: 'ok', userId: 'agent', scopes: ['account', 'offline_access'], tokens });
    mocks.refreshTokenGrant.mockReset().mockResolvedValue({ outcome: 'ok', userId: 'agent', scopes: ['account', 'offline_access'], tokens });
  });

  it('given one abusive IP hammering with many secrets, should not starve distinct agents on other IPs', async () => {
    for (let i = 0; i < 80; i += 1) await exchange('198.51.100.1', 1000 + i);
    for (let n = 0; n < 30; n += 1) {
      const response = await exchange(`203.0.113.${n}`, n);
      expect(response.status).toBe(200);
    }
  });

  it('given one IP exceeding 60 requests, should refuse it while another IP still succeeds', async () => {
    for (let i = 0; i < 60; i += 1) expect((await exchange('198.51.100.2', i)).status).toBe(200);
    const refused = await exchange('198.51.100.2', 999);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual(RATE_LIMITED);
    expect((await exchange('198.51.100.3', 999)).status).toBe(200);
  });

  it('given one credential exceeding 10 requests, should refuse it while another credential from the same IP succeeds', async () => {
    for (let i = 0; i < 10; i += 1) expect((await exchange('198.51.100.4', 7)).status).toBe(200);
    const refused = await exchange('198.51.100.4', 7);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual(RATE_LIMITED);
    expect((await exchange('198.51.100.4', 8)).status).toBe(200);
  });

  it('should refuse with the identical shape whichever bucket tripped, before any DB lookup', async () => {
    for (let i = 0; i < 61; i += 1) await exchange('198.51.100.5', 2000 + i);
    const byIp = await exchange('198.51.100.5', 3000);
    for (let i = 0; i < 11; i += 1) await exchange('198.51.100.6', 4000);
    mocks.exchangeAgentAssertion.mockClear();
    const byCredential = await exchange('198.51.100.6', 4000);
    expect(byIp.status).toBe(byCredential.status);
    expect(await byIp.json()).toEqual(await byCredential.json());
    expect(byCredential.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
  });

  it('should never persist the raw secret as a bucket key', async () => {
    await exchange('198.51.100.7', 42);
    expect([...mocks.counts.keys()].some((k) => k.includes(secret(42)))).toBe(false);
  });

  describe("the agent client's refresh_token grant", () => {
    it('given one abusive IP, should not starve agents refreshing from other IPs', async () => {
      for (let i = 0; i < 80; i += 1) await refreshAs('198.51.100.8', 1000 + i);
      for (let n = 0; n < 30; n += 1) expect((await refreshAs(`192.0.2.${n}`, n)).status).toBe(200);
    });

    it('given one refresh token exceeding 10, should refuse it while another from the same IP succeeds', async () => {
      for (let i = 0; i < 10; i += 1) expect((await refreshAs('198.51.100.9', 5)).status).toBe(200);
      const refused = await refreshAs('198.51.100.9', 5);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual(RATE_LIMITED);
      expect(mocks.refreshTokenGrant).toHaveBeenCalledTimes(10);
      expect((await refreshAs('198.51.100.9', 6)).status).toBe(200);
      expect([...mocks.counts.keys()].some((k) => k.includes(refresh(5)))).toBe(false);
    });
  });

  describe('pagespace-cli is unchanged', () => {
    it('should keep its per-client bucket: 10 CLI refreshes from different IPs exhaust it', async () => {
      for (let n = 0; n < 10; n += 1) expect((await refreshAs(`203.0.113.${n}`, n, 'pagespace-cli')).status).toBe(200);
      expect((await refreshAs('203.0.113.200', 99, 'pagespace-cli')).status).toBe(429);
      expect(mocks.counts.get('oauth-token:exchange:client:pagespace-cli')).toBe(11);
    });
  });
});
