/**
 * GET /api/agent/challenge — Agent Signup Phase 2 leaf 1 (ADR 0007 Decision 10,
 * threat model T1/T2/T13). Issues a single-use proof-of-work challenge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  rateLimit: vi.fn(),
  issue: vi.fn(),
  audit: vi.fn(),
  powBits: { value: 20 },
}));

vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.enabled(),
}));
vi.mock('@/lib/auth', () => ({ getClientIP: () => '203.0.113.7' }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: { AGENT_CHALLENGE: { maxAttempts: 30, windowMs: 300_000 } },
}));
vi.mock('@pagespace/lib/services/agent-identities', () => ({ issueAgentSignupChallenge: mocks.issue }));
vi.mock('@pagespace/lib/auth/agent/pow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/agent/pow')>();
  return {
    ...actual,
    get POW_DIFFICULTY_BITS() { return mocks.powBits.value; },
  };
});
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } }));

import { GET } from '../route';

const challengeRequest = () => new Request('http://web.local/api/agent/challenge', { method: 'GET' });

describe('GET /api/agent/challenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.powBits.value = 20;
    mocks.enabled.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 29 });
    mocks.issue.mockResolvedValue({ challenge: 'ps_pow_abc123', expiresAt: new Date('2026-09-21T00:05:00Z') });
  });

  it('given an open door, should issue a challenge with the difficulty, the TTL and the exact hash input', async () => {
    const response = await GET(challengeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challenge: 'ps_pow_abc123',
      difficulty_bits: 20,
      expires_in: 300,
      algorithm: 'sha3-256',
      input: 'ps_pow_abc123:<nonce>',
    });
  });

  it('should persist the challenge with the caller IP, the configured difficulty and a 5-minute TTL', async () => {
    await GET(challengeRequest());
    // No caller IP reaches the store: redemption is not IP-bound (Phase 2b).
    expect(mocks.issue).toHaveBeenCalledWith({ difficultyBits: 20, ttlMs: 300_000, now: expect.any(Date) });
  });

  it('should never be cached', async () => {
    const response = await GET(challengeRequest());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should audit the issued challenge without the plaintext challenge', async () => {
    await GET(challengeRequest());
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', resourceType: 'agent_signup_challenge' }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('ps_pow_abc123');
  });

  it('given the per-IP AGENT_CHALLENGE limit is exhausted, should answer 429 with Retry-After and issue nothing', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    const response = await GET(challengeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('120');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'rate_limited', retryAfter: 120 });
    expect(mocks.rateLimit).toHaveBeenCalledWith('agent-challenge:ip:203.0.113.7', { maxAttempts: 30, windowMs: 300_000 });
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'security.rate.limited' }));
  });

  it('given a disabled deployment, should answer 404 before rate limiting or issuing anything', async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await GET(challengeRequest());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason: 'agent_signup_disabled' }) }));
  });

  it('given a difficulty outside policy (misconfigured env), should refuse with 503 and issue nothing', async () => {
    mocks.powBits.value = 0;
    const response = await GET(challengeRequest());
    expect(response.status).toBe(503);
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalled();
  });
});
