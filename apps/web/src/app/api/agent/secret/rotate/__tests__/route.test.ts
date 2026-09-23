/**
 * POST /api/agent/secret/rotate — Agent Signup Phase 2 leaf 6 (ADR 0007
 * Decision 14; threat model §3, T11). The agent itself (session or its own
 * ps_at_) or its owner may rotate; anyone else gets the same 404 as a
 * non-agent. The new secret is returned once and never audited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), summary: vi.fn(), rotate: vi.fn(), audit: vi.fn(), tokenClient: vi.fn(), rateLimit: vi.fn(),
  StoreError: class AgentIdentityStoreError extends Error {
    constructor(readonly operation: string, readonly redacted: { errorName: string; code: string | null; constraint: string | null }) {
      super(`Agent identity store failed: ${operation}`);
    }
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mocks.auth,
  isAuthError: (value: unknown) => Boolean((value as { error?: unknown })?.error),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@/lib/repositories/oauth-repository', () => ({ findAccessTokenIssuance: mocks.tokenClient }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: { AGENT_SECRET_ROTATE: { maxAttempts: 5, windowMs: 3_600_000 } },
}));
vi.mock('@pagespace/lib/services/agent-identities', () => ({
  AgentIdentityStoreError: mocks.StoreError,
  getAgentIdentitySummary: mocks.summary,
  rotateAgentSecret: mocks.rotate,
}));

import { POST } from '../route';

const NEW_SECRET = 'ps_agent_newnewnewnewnewnewnewnewnewnewne';
const rotateRequest = (body?: unknown, raw?: string) =>
  new Request('http://web.local/api/agent/secret/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });

const NOT_FOUND = { error: 'not_found' };

describe('POST /api/agent/secret/rotate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: 'agent-1', tokenType: 'oauth', tokenId: 'at-1', scopes: { account: true } });
    mocks.tokenClient.mockResolvedValue({ clientId: 'pagespace-agent', accountType: 'agent' });
    mocks.summary.mockImplementation(async (userId: string) => (userId === 'agent-1' ? { ownerUserId: 'human-1', claimedAt: new Date(), source: 'codex' } : null));
    mocks.rotate.mockResolvedValue({ ok: true, data: { secret: NEW_SECRET, secretPrefix: NEW_SECRET.slice(0, 12), secretVersion: 2 } });
    mocks.rateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 4 });
  });

  describe('rotation rate limit (Phase 2b: AGENT_SECRET_ROTATE)', () => {
    it('given the agent rotating itself, should spend the agent\'s own self bucket', async () => {
      await POST(rotateRequest({}));
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-secret-rotate:self:agent-1', { maxAttempts: 5, windowMs: 3_600_000 });
    });

    it('given the owner rotating from a session, should spend a separate owner bucket for that agent', async () => {
      mocks.auth.mockResolvedValue({ userId: 'human-1', tokenType: 'session', sessionId: 's-1' });
      await POST(rotateRequest({ agentId: 'agent-1' }));
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-secret-rotate:owner:agent-1', expect.anything());
    });

    it('given the bucket is spent, should answer 429, rotate nothing, and audit the refusal', async () => {
      mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfter: 1800 });

      const response = await POST(rotateRequest({ revokeExistingTokens: true }));

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'rate_limited', retryAfter: 1800 });
      expect(mocks.rotate).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        eventType: 'security.rate.limited',
        details: { agentAuthEvent: 'secret_rotate_rate_limited', actor: 'self' },
      }));
    });

    it('given a caller who is neither the agent nor its owner, should 404 without touching any bucket (no one can drain another agent\'s budget)', async () => {
      mocks.auth.mockResolvedValue({ userId: 'stranger-1', tokenType: 'session', sessionId: 's-2' });
      const response = await POST(rotateRequest({ agentId: 'agent-1' }));
      expect(response.status).toBe(404);
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    });
  });

  describe('given the identity store fails (Phase 2b: no hash reaches a log)', () => {
    it('should answer 503 temporarily_unavailable and audit only the pg code', async () => {
      mocks.rotate.mockRejectedValue(new mocks.StoreError('rotate_secret', { errorName: 'DrizzleQueryError', code: '23505', constraint: 'agent_identities_secretHash_unique' }));

      const response = await POST(rotateRequest({}));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: { reason: 'store_failed', agentAuthEvent: 'secret_rotate_refused', operation: 'rotate_secret', code: '23505' },
      }));
    });

    it('given the ownership lookup itself fails (before the rotation), should also answer the constant 503, not a raw 500', async () => {
      mocks.summary.mockRejectedValue(new mocks.StoreError('get_identity_summary', { errorName: 'DrizzleQueryError', code: '57014', constraint: null }));

      const response = await POST(rotateRequest({}));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(mocks.rotate).not.toHaveBeenCalled();
    });

    it('given a non-store error, should rethrow it', async () => {
      mocks.summary.mockRejectedValue(new TypeError('bug'));
      await expect(POST(rotateRequest({}))).rejects.toThrow('bug');
    });
  });

  it('should authenticate with a session (CSRF-checked) or an OAuth access token', async () => {
    await POST(rotateRequest({}));
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['session', 'oauth'], requireCSRF: true });
  });

  describe('given the agent itself', () => {
    it('should rotate and return the new secret once, no-store', async () => {
      const response = await POST(rotateRequest({}));
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ identity_assertion: NEW_SECRET, agent_id: 'agent-1', secret_version: 2, revoked_existing_tokens: false });
      expect(mocks.rotate).toHaveBeenCalledWith({ userId: 'agent-1', revokeTokens: false });
    });

    it('given no body at all, should rotate with the defaults', async () => {
      const response = await POST(rotateRequest());
      expect(response.status).toBe(200);
      expect(mocks.rotate).toHaveBeenCalledWith({ userId: 'agent-1', revokeTokens: false });
    });

    it('given revokeExistingTokens, should rotate AND bump tokenVersion', async () => {
      const response = await POST(rotateRequest({ revokeExistingTokens: true }));
      expect(mocks.rotate).toHaveBeenCalledWith({ userId: 'agent-1', revokeTokens: true });
      expect((await response.json()).revoked_existing_tokens).toBe(true);
    });

    it('should audit the rotation without the new secret', async () => {
      await POST(rotateRequest({}));
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.updated', userId: 'agent-1', resourceType: 'agent_identity', resourceId: 'agent-1', details: expect.objectContaining({ agentAuthEvent: 'secret_rotated', actor: 'self' }) }));
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(NEW_SECRET);
    });
  });

  describe("given the agent's owner", () => {
    it('should rotate the named agent', async () => {
      mocks.auth.mockResolvedValue({ userId: 'human-1', tokenType: 'session' });
      const response = await POST(rotateRequest({ agentId: 'agent-1', revokeExistingTokens: true }));
      expect(response.status).toBe(200);
      expect(mocks.rotate).toHaveBeenCalledWith({ userId: 'agent-1', revokeTokens: true });
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'human-1', resourceId: 'agent-1', details: expect.objectContaining({ actor: 'owner' }) }));
    });
  });

  describe('credential strength (rotation is key management)', () => {
    it("given the owner presenting an OAuth access token (even account-scoped), should answer the same 404 and rotate nothing", async () => {
      mocks.auth.mockResolvedValue({ userId: 'human-1', tokenType: 'oauth', scopes: { account: true } });
      const response = await POST(rotateRequest({ agentId: 'agent-1' }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(NOT_FOUND);
      expect(mocks.rotate).not.toHaveBeenCalled();
    });

    it('given the agent presenting a narrowly scoped (non-account) access token, should answer 404 and rotate nothing', async () => {
      mocks.auth.mockResolvedValue({ userId: 'agent-1', tokenType: 'oauth', scopes: { account: false } });
      const response = await POST(rotateRequest({}));
      expect(response.status).toBe(404);
      expect(mocks.rotate).not.toHaveBeenCalled();
    });

    it("given the agent's account-scoped token issued to ANOTHER client, should answer 404 (only the jwt-bearer grant's token manages the secret)", async () => {
      mocks.tokenClient.mockResolvedValue({ clientId: 'pagespace-cli', accountType: 'agent' });
      const response = await POST(rotateRequest({}));
      expect(response.status).toBe(404);
      expect(mocks.rotate).not.toHaveBeenCalled();
      expect(mocks.tokenClient).toHaveBeenCalledWith('at-1');
    });

    it('given the agent with a browser session, should rotate', async () => {
      mocks.auth.mockResolvedValue({ userId: 'agent-1', tokenType: 'session' });
      expect((await POST(rotateRequest({}))).status).toBe(200);
    });
  });

  describe('given anyone else, the same 404', () => {
    it.each([
      ['a stranger naming an agent', { userId: 'stranger' }, { agentId: 'agent-1' }],
      ['a human with no agent identity rotating "self"', { userId: 'human-2' }, {}],
      ['a caller naming an id that is not an agent', { userId: 'human-1' }, { agentId: 'not-an-agent' }],
    ])('given %s, should answer 404 and rotate nothing', async (_label, caller, body) => {
      mocks.auth.mockResolvedValue({ ...caller, tokenType: 'session' });
      const response = await POST(rotateRequest(body));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(NOT_FOUND);
      expect(mocks.rotate).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied' }));
    });

    it('given a revoked agent (rotation finds no live identity), should answer the same 404', async () => {
      mocks.rotate.mockResolvedValue({ ok: false, error: 'not_found' });
      const response = await POST(rotateRequest({}));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(NOT_FOUND);
    });
  });

  describe('input validation', () => {
    it.each([
      ['a non-boolean revokeExistingTokens', { revokeExistingTokens: 'yes' }],
      ['an empty agentId', { agentId: '' }],
      ['an over-long agentId', { agentId: 'a'.repeat(65) }],
    ])('given %s, should answer 400 and rotate nothing', async (_label, body) => {
      const response = await POST(rotateRequest(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(mocks.rotate).not.toHaveBeenCalled();
    });

    it('given malformed JSON, should answer 400', async () => {
      const response = await POST(rotateRequest(undefined, '{nope'));
      expect(response.status).toBe(400);
    });
  });

  it('given no credential, should return the auth error and audit it', async () => {
    mocks.auth.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const response = await POST(rotateRequest({}));
    expect(response.status).toBe(401);
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied' }));
  });
});
