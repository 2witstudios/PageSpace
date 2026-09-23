/**
 * POST /api/agent/identity — Agent Signup Phase 2 leaf 3 (ADR 0007 Decisions 4,
 * 10, 11; threat model T1, T2, T13). The pure PoW verifier and signup decision
 * are REAL here (only I/O is mocked), so a mis-wired proof check fails a test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { solvePow, powLeadingZeroBits } from '@pagespace/lib/auth/agent/pow';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  rateLimit: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
  // Stands in for the lib class so the route's instanceof check sees the same constructor.
  StoreError: class AgentIdentityStoreError extends Error {
    constructor(readonly operation: string, readonly redacted: { errorName: string; code: string | null; constraint: string | null }) {
      super(`Agent identity store failed: ${operation}`);
    }
  },
}));

vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.enabled(),
  agentIssuer: () => 'https://pagespace.test',
}));
vi.mock('@/lib/auth', () => ({ getClientIP: () => '203.0.113.9' }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
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
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } }));

import { POST } from '../route';

const CHALLENGE = 'ps_pow_testchallenge0000000000000000000';
const BITS = 6;
const GOOD_NONCE = solvePow(CHALLENGE, BITS);
// A nonce whose digest has FEWER than BITS leading zero bits.
const BAD_NONCE = (() => {
  for (let i = 0; ; i += 1) {
    if (powLeadingZeroBits(CHALLENGE, `x${i}`) < BITS) return `x${i}`;
  }
})();
const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';
const CLAIM = 'ps_claim_abcdefghijklmnopqrstuvwxyz012345';

const validBody = (overrides: Record<string, unknown> = {}) => ({
  type: 'anonymous',
  name: 'Scratch Agent',
  source: 'claude-code',
  capabilities: ['shell'],
  tos_accepted: true,
  pow: { challenge: CHALLENGE, nonce: GOOD_NONCE },
  ...overrides,
});

const register = (body: unknown, raw = false) =>
  POST(new Request('http://web.local/api/agent/identity', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  }));

const INVALID = { error: 'invalid_request' };

describe('POST /api/agent/identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 4 });
    mocks.find.mockResolvedValue({ found: true, expired: false, consumed: false, difficultyBits: BITS, id: 'chal-1' });
    mocks.create.mockResolvedValue({ ok: true, data: { userId: 'agent-1', email: 'agent-agent-1@agents.pagespace.invalid', secret: SECRET, secretPrefix: SECRET.slice(0, 12), claimToken: CLAIM } });
  });

  describe('given a valid registration', () => {
    it('should create the account and return the auth.md identity response', async () => {
      const response = await register(validBody());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        identity_assertion: SECRET,
        agent_id: 'agent-1',
        claim_token: CLAIM,
        account_type: 'agent',
        token_endpoint: 'https://pagespace.test/api/oauth/token',
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: 'pagespace-agent',
        claim_endpoint: 'https://pagespace.test/api/agent/claim',
      });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('should create the agent with the consumed challenge id, the caller IP and the ToS acceptance time', async () => {
      await register(validBody());
      expect(mocks.find).toHaveBeenCalledWith({ challenge: CHALLENGE, now: expect.any(Date) });
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'Scratch Agent', source: 'claude-code', tosAcceptedAt: expect.any(Date), createdByIp: '203.0.113.9', challengeId: 'chal-1', now: expect.any(Date),
      });
    });

    it('given no name, should create the agent with a default display name and a null source', async () => {
      await register(validBody({ name: undefined, source: undefined }));
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Agent', source: null }));
    });

    it('should audit the registration without the secret, its hash or the claim token', async () => {
      await register(validBody());
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', userId: 'agent-1', resourceType: 'agent_identity', resourceId: 'agent-1' }));
      const audited = JSON.stringify(mocks.audit.mock.calls);
      expect(audited).not.toContain(SECRET);
      expect(audited).not.toContain(CLAIM);
    });
  });

  describe('given the deployment-wide signup budget is spent (Phase 2b)', () => {
    it('should answer the same 429 body a per-IP limit does, with the retry hint, and audit it as a global-window refusal', async () => {
      mocks.create.mockResolvedValue({ ok: false, error: 'signup_budget_exhausted', retryAfterSeconds: 1200 });

      const response = await register(validBody());

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'rate_limited', retryAfter: 1200 });
      expect(response.headers.get('Retry-After')).toBe('1200');
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        eventType: 'security.rate.limited',
        details: expect.objectContaining({ agentAuthEvent: 'signup_rate_limited', window: 'global' }),
      }));
    });

    it('should refuse every caller once spent, whatever client IP each request reports', async () => {
      mocks.create.mockResolvedValue({ ok: false, error: 'signup_budget_exhausted', retryAfterSeconds: 60 });

      const statuses = await Promise.all(Array.from({ length: 5 }, () => register(validBody()).then((r) => r.status)));

      expect(statuses).toEqual([429, 429, 429, 429, 429]);
    });
  });

  describe('given the identity store fails (Phase 2b: no hash reaches a log)', () => {
    it('should answer 503 temporarily_unavailable and audit only the operation and the pg code', async () => {
      mocks.create.mockRejectedValue(new mocks.StoreError('create_account', { errorName: 'DrizzleQueryError', code: '23505', constraint: 'agent_identities_secretHash_unique' }));

      const response = await register(validBody());

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        eventType: 'auth.login.failure',
        details: { agentAuthEvent: 'signup_refused', reason: 'store_failed', operation: 'create_account', code: '23505' },
      }));
    });

    it('given any other error, should not swallow it', async () => {
      mocks.create.mockRejectedValue(new TypeError('bug'));

      await expect(register(validBody())).rejects.toThrow('bug');
    });
  });

  describe('given a proof-of-work that does not meet the challenge difficulty', () => {
    it('should answer 403 pow_invalid and create nothing', async () => {
      const response = await register(validBody({ pow: { challenge: CHALLENGE, nonce: BAD_NONCE } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'pow_invalid' });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.login.failure', details: expect.objectContaining({ reason: 'pow_invalid' }) }));
    });

    it('should verify against the difficulty STORED on the challenge, not a lower one the caller implies', async () => {
      // A nonce good for 6 bits is refused when the row says 30.
      mocks.find.mockResolvedValue({ found: true, expired: false, consumed: false, difficultyBits: 30, id: 'chal-1' });
      const response = await register(validBody());
      expect(response.status).toBe(403);
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('every other failure is the same 400 body', () => {
    it.each([
      ['an unknown challenge', { found: false, expired: false, consumed: false, difficultyBits: 0, id: null }],
      ['an expired challenge', { found: true, expired: true, consumed: false, difficultyBits: BITS, id: 'chal-1' }],
      ['a consumed (replayed) challenge', { found: true, expired: false, consumed: true, difficultyBits: BITS, id: 'chal-1' }],
    ])('given %s, should answer 400 invalid_request and create nothing', async (_label, lookup) => {
      mocks.find.mockResolvedValue(lookup);
      const response = await register(validBody());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID);
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('given the challenge was consumed by a racing request between lookup and insert, should answer the same 400', async () => {
      mocks.create.mockResolvedValue({ ok: false, error: 'challenge_invalid' });
      const response = await register(validBody());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID);
    });

    it('given tos_accepted false, should answer the same 400 and create nothing', async () => {
      const response = await register(validBody({ tos_accepted: false }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID);
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-anonymous type', { type: 'workload' }],
      ['a missing pow', { pow: undefined }],
      ['a missing tos_accepted', { tos_accepted: undefined }],
      ['a name over 80 characters', { name: 'n'.repeat(81) }],
      ['a source over 120 characters', { source: 's'.repeat(121) }],
      ['more than 10 capabilities', { capabilities: Array.from({ length: 11 }, (_, i) => `c${i}`) }],
      ['a capability over 40 characters', { capabilities: ['c'.repeat(41)] }],
      ['an over-long nonce', { pow: { challenge: CHALLENGE, nonce: 'n'.repeat(65) } }],
      ['a non-string challenge', { pow: { challenge: 42, nonce: GOOD_NONCE } }],
    ])('given %s, should answer the same 400 before touching the challenge', async (_label, overrides) => {
      const response = await register(validBody(overrides));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID);
      expect(mocks.find).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('given a body that is not JSON, should answer the same 400', async () => {
      const response = await register('{not json', true);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID);
    });

    it('should audit a validation failure', async () => {
      await register(validBody({ type: 'workload' }));
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.login.failure', details: expect.objectContaining({ reason: 'invalid_request' }) }));
    });
  });

  describe('rate limits (per IP)', () => {
    it('should check AGENT_SIGNUP and AGENT_SIGNUP_DAILY keyed on the caller IP', async () => {
      await register(validBody());
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-signup:ip:203.0.113.9', { maxAttempts: 5, windowMs: 3_600_000 });
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-signup-daily:ip:203.0.113.9', { maxAttempts: 10, windowMs: 86_400_000 });
    });

    it.each([
      ['the hourly limit', 'agent-signup:ip:'],
      ['the daily limit', 'agent-signup-daily:ip:'],
    ])('given %s is exhausted, should answer 429 with Retry-After and create nothing', async (_label, keyPrefix) => {
      mocks.rateLimit.mockImplementation(async (key: string) => (key.startsWith(keyPrefix) ? { allowed: false, retryAfter: 60 } : { allowed: true }));
      const response = await register(validBody());
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(await response.json()).toEqual({ error: 'rate_limited', retryAfter: 60 });
      expect(mocks.find).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'security.rate.limited' }));
    });
  });

  describe('given a disabled deployment', () => {
    it('should answer 404 before rate limiting, parsing or touching the challenge', async () => {
      mocks.enabled.mockReturnValue(false);
      const response = await register(validBody());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.find).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });
});
