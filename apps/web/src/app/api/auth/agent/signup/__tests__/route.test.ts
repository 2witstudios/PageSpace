/**
 * POST /api/auth/agent/signup — the agent BROWSER door's registration (Agent
 * Signup Phase 3; ADR 0008 Decisions 4, 10, 11; threat model T1, T2, T13).
 * The pure PoW verifier and signup decision are REAL here (only I/O is
 * mocked), so a mis-wired proof check fails a test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { solvePow, powLeadingZeroBits } from '@pagespace/lib/auth/agent/pow';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  rateLimit: vi.fn(),
  refund: vi.fn(),
  ip: vi.fn(),
  csrf: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
  session: vi.fn(),
  StoreError: class AgentIdentityStoreError extends Error {
    constructor(readonly operation: string, readonly redacted: { errorName: string; code: string | null; constraint: string | null }) {
      super(`Agent identity store failed: ${operation}`);
    }
  },
}));

vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.enabled(),
}));
vi.mock('@/lib/auth', () => ({ getClientIP: () => mocks.ip(), validateLoginCSRFToken: mocks.csrf }));
vi.mock('@/lib/agent-auth/browser-session', () => ({
  startAgentBrowserSession: mocks.session,
  agentRedirectUrl: (next: string | undefined) => (next === '/dashboard/drive-1' ? next : '/dashboard'),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  refundDistributedRateLimitAttempt: mocks.refund,
  DISTRIBUTED_RATE_LIMITS: {
    AGENT_SIGNUP: { maxAttempts: 5, windowMs: 3_600_000 },
    AGENT_SIGNUP_DAILY: { maxAttempts: 10, windowMs: 86_400_000 },
  },
}));
vi.mock('@pagespace/lib/services/agent-identities', () => ({
  AgentIdentityStoreError: mocks.StoreError,
  findAgentSignupChallenge: mocks.find,
  createAgentAccount: mocks.create,
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, api: { error: vi.fn() } } }));

import { POST } from '../route';

const CHALLENGE = 'ps_pow_testchallenge0000000000000000000';
const BITS = 6;
const GOOD_NONCE = solvePow(CHALLENGE, BITS);
const BAD_NONCE = (() => {
  for (let i = 0; ; i += 1) {
    if (powLeadingZeroBits(CHALLENGE, `x${i}`) < BITS) return `x${i}`;
  }
})();
const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';
const CLAIM = 'ps_claim_abcdefghijklmnopqrstuvwxyz012345';

const validBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Browser Agent',
  source: 'computer-use',
  tosAccepted: true,
  pow: { challenge: CHALLENGE, nonce: GOOD_NONCE },
  csrfToken: 'login-csrf',
  platform: 'web',
  deviceId: 'dev-1',
  ...overrides,
});

const signup = (body: unknown, raw = false) =>
  POST(new Request('http://web.local/api/auth/agent/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  }));

const sessionHeaders = () => {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', 'session=ps_sess_x');
  return headers;
};

describe('POST /api/auth/agent/signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.csrf.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 4 });
    mocks.refund.mockResolvedValue(undefined);
    mocks.ip.mockReturnValue('203.0.113.9');
    mocks.find.mockResolvedValue({ found: true, expired: false, consumed: false, difficultyBits: BITS, id: 'chal-1' });
    mocks.create.mockResolvedValue({ ok: true, data: { userId: 'agent-1', email: 'agent-agent-1@agents.pagespace.invalid', secret: SECRET, secretPrefix: SECRET.slice(0, 12), claimToken: CLAIM } });
    mocks.session.mockResolvedValue({ ok: true, csrfToken: 'session-csrf', sessionId: 'sess-1', headers: sessionHeaders(), deviceToken: 'ps_dev_x' });
  });

  describe('given a valid signup', () => {
    it('should create the agent through createAgentAccount with the consumed challenge, the IP and the ToS time', async () => {
      await signup(validBody());
      expect(mocks.find).toHaveBeenCalledWith({ challenge: CHALLENGE, now: expect.any(Date) });
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'Browser Agent', source: 'computer-use', tosAcceptedAt: expect.any(Date), createdByIp: '203.0.113.9', challengeId: 'chal-1', now: expect.any(Date),
      });
    });

    it('should run the session chain for the new agent (tokenVersion 1, the browser device id)', async () => {
      await signup(validBody({ deviceName: 'Chrome' }));
      expect(mocks.session).toHaveBeenCalledWith({
        request: expect.any(Request), userId: 'agent-1', tokenVersion: 1, clientIP: '203.0.113.9', deviceId: 'dev-1', deviceName: 'Chrome',
      });
    });

    it('should return the secret once with the agent id, claim token, CSRF, device token and redirect, with the session cookie and no-store', async () => {
      const response = await signup(validBody());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        agentId: 'agent-1',
        accountType: 'agent',
        secret: SECRET,
        claimToken: CLAIM,
        csrfToken: 'session-csrf',
        deviceToken: 'ps_dev_x',
        redirectUrl: '/dashboard',
      });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toContain('session=ps_sess_x');
    });

    it('given a safe next, should carry it as the redirect', async () => {
      const response = await signup(validBody({ next: '/dashboard/drive-1' }));
      expect((await response.json()).redirectUrl).toBe('/dashboard/drive-1');
    });

    it('given no source, should store a null source', async () => {
      await signup(validBody({ source: undefined }));
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ source: null }));
    });

    it('should audit the signup and the session without the secret or the claim token', async () => {
      await signup(validBody());
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', userId: 'agent-1', resourceType: 'agent_identity' }));
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.login.success', userId: 'agent-1', sessionId: 'sess-1' }));
      const audited = JSON.stringify(mocks.audit.mock.calls);
      expect(audited).not.toContain(SECRET);
      expect(audited).not.toContain(CLAIM);
    });
  });

  describe('given the door is closed', () => {
    it('should 404 before touching CSRF, rate limits or the store', async () => {
      mocks.enabled.mockReturnValue(false);
      const response = await signup(validBody());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(mocks.csrf).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.find).not.toHaveBeenCalled();
    });
  });

  describe('given a bad login-CSRF token', () => {
    it('should 403 before spending a rate-limit attempt or creating anything', async () => {
      mocks.csrf.mockReturnValue(false);
      const response = await signup(validBody());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid_csrf' });
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('given an invalid body', () => {
    it.each([
      ['not JSON', '{nope', true],
      ['no name', validBody({ name: undefined }), false],
      ['an empty name', validBody({ name: '   ' }), false],
      ['an over-long name', validBody({ name: 'n'.repeat(81) }), false],
      ['no pow', validBody({ pow: undefined }), false],
      ['an over-long nonce', validBody({ pow: { challenge: CHALLENGE, nonce: 'n'.repeat(65) } }), false],
      ['no csrfToken', validBody({ csrfToken: undefined }), false],
      ['a desktop platform', validBody({ platform: 'desktop' }), false],
    ])('given %s, should answer one 400 and create nothing', async (_label, body, raw) => {
      const response = await signup(body, raw as boolean);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('given the per-IP limits', () => {
    it('should share the API door buckets so the two doors do not double an IP allowance', async () => {
      await signup(validBody());
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-signup:ip:203.0.113.9', expect.objectContaining({ maxAttempts: 5 }));
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-signup-daily:ip:203.0.113.9', expect.objectContaining({ maxAttempts: 10 }));
    });

    it('given an IPv6 caller, should bucket it by /48 like the API door (security review)', async () => {
      mocks.ip.mockReturnValue('2001:db8:1:2::1');
      await signup(validBody());
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-signup:ip:2001:0db8:0001::/48', expect.objectContaining({ maxAttempts: 5 }));
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-signup-daily:ip:2001:0db8:0001::/48', expect.objectContaining({ maxAttempts: 10 }));
    });

    it('given the hourly limit is hit, should 429 with Retry-After and create nothing', async () => {
      mocks.rateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 120 });
      const response = await signup(validBody());
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'rate_limited', retryAfter: 120 });
      expect(response.headers.get('Retry-After')).toBe('120');
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('given the daily limit is hit, should 429', async () => {
      mocks.rateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, retryAfter: 3600 });
      expect((await signup(validBody())).status).toBe(429);
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('given the proof of work', () => {
    it('given a nonce below the stored difficulty, should 403 pow_invalid and create nothing', async () => {
      const response = await signup(validBody({ pow: { challenge: CHALLENGE, nonce: BAD_NONCE } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'pow_invalid' });
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown', { found: false, expired: false, consumed: false, difficultyBits: 0, id: null }],
      ['expired', { found: true, expired: true, consumed: false, difficultyBits: BITS, id: 'chal-1' }],
      ['consumed', { found: true, expired: false, consumed: true, difficultyBits: BITS, id: 'chal-1' }],
    ])('given an %s challenge, should answer the one 400', async (_label, lookup) => {
      mocks.find.mockResolvedValue(lookup);
      const response = await signup(validBody());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('given ToS not accepted, should answer the one 400 only after the PoW verified', async () => {
      const response = await signup(validBody({ tosAccepted: false }));
      expect(response.status).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('given createAgentAccount refuses', () => {
    it('given the deployment-wide budget is spent, should refund both per-IP attempts and answer the per-IP 429 shape', async () => {
      mocks.create.mockResolvedValue({ ok: false, error: 'signup_budget_exhausted', retryAfterSeconds: 900 });
      const response = await signup(validBody());
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'rate_limited', retryAfter: 900 });
      expect(mocks.refund).toHaveBeenCalledWith('agent-signup:ip:203.0.113.9', 3_600_000);
      expect(mocks.refund).toHaveBeenCalledWith('agent-signup-daily:ip:203.0.113.9', 86_400_000);
      expect(mocks.session).not.toHaveBeenCalled();
    });

    it('given the challenge was consumed concurrently, should answer the one 400 and start no session', async () => {
      mocks.create.mockResolvedValue({ ok: false, error: 'challenge_invalid' });
      const response = await signup(validBody());
      expect(response.status).toBe(400);
      expect(mocks.session).not.toHaveBeenCalled();
    });

    it('given a store failure, should answer 503 temporarily_unavailable', async () => {
      mocks.create.mockRejectedValue(new mocks.StoreError('create_account', { errorName: 'DrizzleQueryError', code: '57P01', constraint: null }));
      const response = await signup(validBody());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
    });
  });

  describe('given the session cannot be started after the account exists', () => {
    it('should still return the secret (it exists nowhere else) and send the agent to sign in', async () => {
      mocks.session.mockResolvedValue({ ok: false });
      const response = await signup(validBody());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        success: true,
        agentId: 'agent-1',
        accountType: 'agent',
        secret: SECRET,
        claimToken: CLAIM,
        sessionStarted: false,
        redirectUrl: '/auth/agent?mode=signin',
      });
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });
  });
});
