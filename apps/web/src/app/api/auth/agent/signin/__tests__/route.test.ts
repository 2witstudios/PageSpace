/**
 * POST /api/auth/agent/signin — sign in at the browser door with an agent
 * secret (Agent Signup Phase 3; ADR 0008; threat model T3). The decision and
 * its wire collapse are REAL (`decideAgentSignin` runs inside the mocked
 * service's return shape; `collapseAgentSigninDecision` is not mocked), so an
 * oracle between refusal reasons fails a test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  rateLimit: vi.fn(),
  ip: vi.fn(),
  csrf: vi.fn(),
  verify: vi.fn(),
  audit: vi.fn(),
  session: vi.fn(),
  recordFailure: vi.fn(),
  resetFailures: vi.fn(),
  findUser: vi.fn(),
  revokeSessions: vi.fn(),
  provision: vi.fn(),
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
vi.mock('@/lib/auth', () => ({
  getClientIP: () => mocks.ip(),
  validateLoginCSRFToken: mocks.csrf,
  revokeSessionsForLogin: mocks.revokeSessions,
}));
vi.mock('@/lib/agent-auth/browser-session', () => ({
  startAgentBrowserSession: mocks.session,
  agentRedirectUrl: (next: string | undefined) => (next === '/dashboard/drive-1' ? next : '/dashboard'),
}));
vi.mock('@/lib/repositories/auth-repository', () => ({ authRepository: { findUserById: mocks.findUser } }));
vi.mock('@pagespace/lib/auth/account-lockout', () => ({
  recordFailedLoginAttempt: mocks.recordFailure,
  resetFailedLoginAttempts: mocks.resetFailures,
}));
vi.mock('@pagespace/lib/onboarding/home-drive', () => ({ provisionHomeDriveIfNeeded: mocks.provision }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: { AGENT_SIGNIN: { maxAttempts: 5, windowMs: 900_000 } },
}));
vi.mock('@pagespace/lib/services/agent-identities', () => ({
  AgentIdentityStoreError: mocks.StoreError,
  verifyAgentSecret: mocks.verify,
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } }));

import { POST } from '../route';

const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';

const validBody = (overrides: Record<string, unknown> = {}) => ({
  secret: SECRET,
  csrfToken: 'login-csrf',
  deviceId: 'dev-1',
  ...overrides,
});

const signin = (body: unknown, raw = false) =>
  POST(new Request('http://web.local/api/auth/agent/signin', {
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

describe('POST /api/auth/agent/signin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.csrf.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 4 });
    mocks.ip.mockReturnValue('203.0.113.9');
    mocks.verify.mockResolvedValue({ decision: { status: 'ok' }, userId: 'agent-1' });
    mocks.findUser.mockResolvedValue({ id: 'agent-1', tokenVersion: 4, accountType: 'agent' });
    mocks.revokeSessions.mockResolvedValue(0);
    mocks.provision.mockResolvedValue({ driveId: 'home-1', created: false });
    mocks.session.mockResolvedValue({ ok: true, csrfToken: 'session-csrf', sessionId: 'sess-1', headers: sessionHeaders(), deviceToken: 'ps_dev_x' });
  });

  describe('given a valid secret', () => {
    it('should verify the secret (looked up by its hash in the service) and run the session chain with the agent tokenVersion', async () => {
      const response = await signin(validBody({ deviceName: 'Chrome' }));
      expect(mocks.verify).toHaveBeenCalledWith({ secret: SECRET, now: expect.any(Date) });
      expect(mocks.session).toHaveBeenCalledWith({
        request: expect.any(Request), userId: 'agent-1', tokenVersion: 4, clientIP: '203.0.113.9', deviceId: 'dev-1', deviceName: 'Chrome',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, agentId: 'agent-1', accountType: 'agent', csrfToken: 'session-csrf', deviceToken: 'ps_dev_x', redirectUrl: '/dashboard' });
      expect(response.headers.get('set-cookie')).toContain('session=ps_sess_x');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('should never echo the secret back', async () => {
      const response = await signin(validBody());
      expect(JSON.stringify(await response.json())).not.toContain(SECRET);
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(SECRET);
    });

    it('should clear the account lockout counters, scope prior-session revocation to this device and provision the home drive', async () => {
      await signin(validBody());
      expect(mocks.resetFailures).toHaveBeenCalledWith('agent-1');
      expect(mocks.revokeSessions).toHaveBeenCalledWith('agent-1', 'dev-1', 'agent_secret_login', 'agent_secret');
      expect(mocks.provision).toHaveBeenCalledWith('agent-1');
    });

    it('given a safe next, should redirect there', async () => {
      const response = await signin(validBody({ next: '/dashboard/drive-1' }));
      expect((await response.json()).redirectUrl).toBe('/dashboard/drive-1');
    });

    it('given home-drive provisioning fails, should still sign in', async () => {
      mocks.provision.mockRejectedValue(new Error('db'));
      expect((await signin(validBody())).status).toBe(200);
    });

    it('should audit the login success', async () => {
      await signin(validBody());
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.login.success', userId: 'agent-1', sessionId: 'sess-1', details: expect.objectContaining({ method: 'agent_secret' }) }));
    });

    it('given the session cannot be started, should 503 without a cookie', async () => {
      mocks.session.mockResolvedValue({ ok: false });
      const response = await signin(validBody());
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('given a refused secret (threat model T3: one constant 401)', () => {
    const CASES = [
      ['unknown', { decision: { status: 'not_found' }, userId: null }],
      ['revoked', { decision: { status: 'revoked' }, userId: 'agent-1' }],
      ['suspended', { decision: { status: 'suspended' }, userId: 'agent-1' }],
      ['locked', { decision: { status: 'locked' }, userId: 'agent-1' }],
    ] as const;

    it.each(CASES)('given a %s agent, should answer the identical 401 body and start no session', async (_label, verified) => {
      mocks.verify.mockResolvedValue(verified);
      const response = await signin(validBody());
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_credentials' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(mocks.session).not.toHaveBeenCalled();
    });

    it('given every refusal, the response bodies and headers should be byte-identical', async () => {
      const bodies = new Set<string>();
      for (const [, verified] of CASES) {
        mocks.verify.mockResolvedValue(verified);
        const response = await signin(validBody());
        bodies.add(`${response.status}|${await response.text()}|${response.headers.get('Cache-Control')}`);
      }
      expect(bodies.size).toBe(1);
    });

    it('given a malformed secret, should answer the same 401 (the service refuses it without a lookup)', async () => {
      mocks.verify.mockResolvedValue({ decision: { status: 'not_found' }, userId: null });
      const response = await signin(validBody({ secret: 'not-a-secret' }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_credentials' });
    });

    it.each([['revoked'], ['suspended'], ['locked']])('given a %s agent, should increment its lockout counter', async (status) => {
      mocks.verify.mockResolvedValue({ decision: { status }, userId: 'agent-1' });
      await signin(validBody());
      expect(mocks.recordFailure).toHaveBeenCalledWith('agent-1');
      expect(mocks.resetFailures).not.toHaveBeenCalled();
    });

    it('given an unknown secret, should have no account to lock', async () => {
      mocks.verify.mockResolvedValue({ decision: { status: 'not_found' }, userId: null });
      await signin(validBody());
      expect(mocks.recordFailure).not.toHaveBeenCalled();
    });

    it('should audit the real reason internally', async () => {
      mocks.verify.mockResolvedValue({ decision: { status: 'revoked' }, userId: 'agent-1' });
      await signin(validBody());
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.login.failure', details: expect.objectContaining({ reason: 'revoked' }) }));
    });
  });

  describe('given the door is closed', () => {
    it('should 404 before CSRF, rate limits or any lookup', async () => {
      mocks.enabled.mockReturnValue(false);
      const response = await signin(validBody());
      expect(response.status).toBe(404);
      expect(mocks.csrf).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.verify).not.toHaveBeenCalled();
    });
  });

  describe('given a bad login-CSRF token', () => {
    it('should 403 before spending an attempt or looking anything up', async () => {
      mocks.csrf.mockReturnValue(false);
      const response = await signin(validBody());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid_csrf' });
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.verify).not.toHaveBeenCalled();
    });
  });

  describe('given an invalid body', () => {
    it.each([
      ['not JSON', '{nope', true],
      ['no secret', validBody({ secret: undefined }), false],
      ['an over-long secret', validBody({ secret: 's'.repeat(257) }), false],
      ['no csrfToken', validBody({ csrfToken: undefined }), false],
    ])('given %s, should answer 400', async (_label, body, raw) => {
      const response = await signin(body, raw as boolean);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(mocks.verify).not.toHaveBeenCalled();
    });
  });

  describe('given the AGENT_SIGNIN per-IP limit', () => {
    it('should key the bucket on the caller address', async () => {
      await signin(validBody());
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-signin:ip:203.0.113.9', expect.objectContaining({ maxAttempts: 5 }));
    });

    it('given the limit is hit, should 429 before any lookup', async () => {
      mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfter: 600 });
      const response = await signin(validBody());
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('600');
      expect(mocks.verify).not.toHaveBeenCalled();
    });

    it('given a success, should NOT reset the IP bucket (one valid secret must not buy unlimited guesses)', async () => {
      const { DISTRIBUTED_RATE_LIMITS } = await import('@pagespace/lib/security/distributed-rate-limit');
      expect(Object.keys(DISTRIBUTED_RATE_LIMITS)).toEqual(['AGENT_SIGNIN']);
      await signin(validBody());
      // The mocked module exposes no reset function; the route importing one would fail to load.
      expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    });
  });

  describe('given a store failure', () => {
    it('should 503 temporarily_unavailable', async () => {
      mocks.verify.mockRejectedValue(new mocks.StoreError('verify_secret', { errorName: 'DrizzleQueryError', code: '57P01', constraint: null }));
      const response = await signin(validBody());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
    });
  });
});
