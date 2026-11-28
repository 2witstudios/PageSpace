/**
 * Settings → Agents API (Agent Signup Phase 4; ADR 0008 Decisions 8, 14):
 *   GET  /api/account/agents                    — the agents the signed-in human owns
 *   POST /api/account/agents/[agentId]/revoke   — revokeAgent (tokenVersion bump + mcp_ keys)
 *   POST /api/account/agents/[agentId]/unlink   — release it, with a fresh claim token
 * Session only; the owner rule is the frozen agentSecretActor (the rotate rule);
 * anyone else, an unknown id and a non-agent all answer the same 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  doorOpen: vi.fn(),
  list: vi.fn(),
  unlink: vi.fn(),
  revoke: vi.fn(),
  summary: vi.fn(),
  StoreError: class AgentIdentityStoreError extends Error {
    constructor(readonly operation: string, readonly redacted: { errorName: string; code: string | null; constraint: string | null }) {
      super(`Agent identity store failed: ${operation}`);
    }
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mocks.auth(...args),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => mocks.rateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { AGENT_OWNER_MANAGE: { maxAttempts: 30, windowMs: 300_000 } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.doorOpen(),
}));
vi.mock('@pagespace/lib/services/agent-ownership', () => ({ listOwnedAgents: mocks.list, unlinkAgent: mocks.unlink }));
vi.mock('@pagespace/lib/services/agent-identities', () => ({
  AgentIdentityStoreError: mocks.StoreError,
  revokeAgent: mocks.revoke,
  getAgentIdentitySummary: mocks.summary,
}));
vi.mock('@/lib/repositories/oauth-repository', () => ({ findAccessTokenIssuance: vi.fn() }));

import { GET } from '../route';
import { POST as REVOKE } from '../[agentId]/revoke/route';
import { POST as UNLINK } from '../[agentId]/unlink/route';

const SESSION = { tokenType: 'session', userId: 'human-1', role: 'user', tokenVersion: 0, adminRoleVersion: 0, sessionId: 's1' };
const ctx = (agentId: string) => ({ params: Promise.resolve({ agentId }) });
const post = (url: string) => new Request(`https://pagespace.test${url}`, { method: 'POST' });

describe('Settings → Agents API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(SESSION);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.doorOpen.mockReturnValue(true);
    mocks.summary.mockResolvedValue({ ownerUserId: 'human-1', claimedAt: new Date(), source: 'codex' });
    mocks.revoke.mockResolvedValue({ revoked: true });
    mocks.unlink.mockResolvedValue({ ok: true });
    mocks.list.mockResolvedValue([
      { agentUserId: 'agent-1', name: 'Scratch', source: 'codex', createdAt: new Date('2026-10-01T00:00:00Z'), claimedAt: new Date('2026-10-02T00:00:00Z'), lastActiveAt: new Date('2026-11-20T00:00:00Z'), revokedAt: null },
    ]);
  });

  describe('GET /api/account/agents', () => {
    it("lists the signed-in human's agents with name, source and last active", async () => {
      const res = await GET(new Request('https://pagespace.test/api/account/agents'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        agents: [{ id: 'agent-1', name: 'Scratch', source: 'codex', createdAt: '2026-10-01T00:00:00.000Z', claimedAt: '2026-10-02T00:00:00.000Z', lastActiveAt: '2026-11-20T00:00:00.000Z', revokedAt: null }],
      });
      expect(mocks.list).toHaveBeenCalledWith('human-1');
      expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['session'], requireCSRF: false });
    });

    it('given the door is closed, should 404', async () => {
      mocks.doorOpen.mockReturnValue(false);
      expect((await GET(new Request('https://pagespace.test/api/account/agents'))).status).toBe(404);
    });

    it('given the owner bucket is spent, should 429', async () => {
      mocks.rateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 9 });
      expect((await GET(new Request('https://pagespace.test/api/account/agents'))).status).toBe(429);
      expect(mocks.list).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/account/agents/[agentId]/revoke', () => {
    it('given the owner, should revoke (live tokens and keys die) and audit auth.agent.revoked', async () => {
      const res = await REVOKE(post('/api/account/agents/agent-1/revoke'), ctx('agent-1'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true });
      expect(mocks.revoke).toHaveBeenCalledWith({ userId: 'agent-1', now: expect.any(Date) });
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.agent.revoked', userId: 'human-1', resourceType: 'agent_identity', resourceId: 'agent-1' }));
      // A state change from the browser: CSRF is required.
      expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['session'], requireCSRF: true });
    });

    it.each([
      ['someone else owns it', { ownerUserId: 'human-2', claimedAt: new Date(), source: null }],
      ['it is unclaimed', { ownerUserId: null, claimedAt: null, source: null }],
      ['it is not an agent', null],
    ])('given %s, should 404 and revoke nothing', async (_label, summary) => {
      mocks.summary.mockResolvedValue(summary);
      const res = await REVOKE(post('/api/account/agents/agent-1/revoke'), ctx('agent-1'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
      expect(mocks.revoke).not.toHaveBeenCalled();
    });

    it('given an already revoked agent, should 404 like any other', async () => {
      mocks.revoke.mockResolvedValue({ revoked: false });
      expect((await REVOKE(post('/api/account/agents/agent-1/revoke'), ctx('agent-1'))).status).toBe(404);
    });

    it('given a store failure, should answer a constant 503', async () => {
      mocks.revoke.mockRejectedValue(new mocks.StoreError('revoke_agent', { errorName: 'DrizzleQueryError', code: '57P01', constraint: null }));
      const res = await REVOKE(post('/api/account/agents/agent-1/revoke'), ctx('agent-1'));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    });
  });

  describe('POST /api/account/agents/[agentId]/unlink', () => {
    // Security review: unlink used to hand the former owner a fresh claim
    // token — a credential that could re-claim the agent and poll its tokens.
    it('given the owner, should release the agent and hand back NOTHING secret', async () => {
      const res = await UNLINK(post('/api/account/agents/agent-1/unlink'), ctx('agent-1'));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ unlinked: true });
      expect(mocks.unlink).toHaveBeenCalledWith({ ownerUserId: 'human-1', agentUserId: 'agent-1', now: expect.any(Date) });
    });

    it('given not the owner, should 404 and change nothing', async () => {
      mocks.summary.mockResolvedValue({ ownerUserId: 'human-2', claimedAt: new Date(), source: null });
      expect((await UNLINK(post('/api/account/agents/agent-1/unlink'), ctx('agent-1'))).status).toBe(404);
      expect(mocks.unlink).not.toHaveBeenCalled();
    });

    it('given the store says it is no longer theirs (a race), should 404', async () => {
      mocks.unlink.mockResolvedValue({ ok: false });
      expect((await UNLINK(post('/api/account/agents/agent-1/unlink'), ctx('agent-1'))).status).toBe(404);
    });
  });
});
