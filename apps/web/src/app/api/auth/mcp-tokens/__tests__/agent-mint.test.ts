/**
 * POST /api/auth/mcp-tokens by an AI agent (ADR 0007 Decision 6 — "agents mint
 * mcp_ keys through the existing manage_keys paths"; Agent Signup Phase 2).
 *
 * The only bearer credential that may mint here is the agent's own
 * account-scoped access token minted by the pagespace-agent jwt-bearer grant
 * (`classifyCallerCredential`, REAL here). Every other OAuth token keeps the
 * refusal this route has always given a bearer. The minted key is scoped by the
 * SAME `validateDriveScopeAccess` call the session path uses, for the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), issuance: vi.fn(), validate: vi.fn(), create: vi.fn(), rateLimit: vi.fn(), audit: vi.fn(), guarded: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mocks.auth,
  isAuthError: (value: unknown) => Boolean((value as { error?: unknown })?.error),
  isScopedOAuthAuth: () => false,
  isManageKeysOnly: () => false,
  getBearerToken: (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
}));
vi.mock('@/lib/repositories/oauth-repository', () => ({ findAccessTokenIssuance: mocks.issuance }));
vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: { createMcpTokenWithDriveScopes: mocks.create, createAgentMcpTokenGuarded: mocks.guarded, findDrivesByIds: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({ validateDriveScopeAccess: mocks.validate }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: { AGENT_KEY_MINT: { maxAttempts: 10, windowMs: 3_600_000 } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn().mockResolvedValue({}), logTokenActivity: vi.fn() }));
vi.mock('@pagespace/lib/auth/token-utils', () => ({ generateToken: () => ({ token: 'mcp_newkey', hash: 'h', tokenPrefix: 'mcp_new' }) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), info: vi.fn() } } }));

import { POST } from '../route';

const OAUTH_REFUSAL = { error: 'OAuth tokens are not permitted for this endpoint' };
const NO_SCOPE_PROBLEMS = { invalidDriveIds: [], unauthorizedRoles: [], invalidCustomRoles: [], unauthorizedCustomRoles: [] };

const agentAuth = { userId: 'agent-1', tokenType: 'oauth', tokenId: 'at-1', role: 'user', tokenVersion: 7, scopes: { account: true } };
const mint = (body: unknown = { name: 'agent key' }) =>
  POST(new NextRequest('http://localhost/api/auth/mcp-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ps_at_abc' },
    body: JSON.stringify(body),
  }));

describe('POST /api/auth/mcp-tokens — agent bearer path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(agentAuth);
    mocks.issuance.mockResolvedValue({ clientId: 'pagespace-agent', accountType: 'agent' });
    mocks.validate.mockResolvedValue(NO_SCOPE_PROBLEMS);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.create.mockResolvedValue({ id: 'k1', name: 'agent key', createdAt: new Date() });
    mocks.guarded.mockImplementation(async (row: Record<string, unknown>) => ({ ok: true, token: await mocks.create(row) }));
  });

  it('should authenticate session (CSRF-checked) or oauth — CSRF applies to sessions only', async () => {
    await mint();
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['session', 'oauth'], requireCSRF: true });
  });

  describe("given the agent's own pagespace-agent account token", () => {
    it('should mint a key for the agent itself and return it once', async () => {
      const response = await mint();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'k1', token: 'mcp_newkey' });
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'agent-1', isScoped: false, drives: [] }));
      expect(mocks.issuance).toHaveBeenCalledWith('at-1');
    });

    it('should audit the mint with method agent', async () => {
      await mint();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', userId: 'agent-1', details: expect.objectContaining({ tokenType: 'mcp', method: 'agent' }) }));
    });

    it('should scope a drive-scoped key through the SAME validateDriveScopeAccess the session path uses, for the agent', async () => {
      await mint({ name: 'k', drives: [{ id: 'd1', role: 'MEMBER' }] });
      expect(mocks.validate).toHaveBeenCalledWith([{ id: 'd1', role: 'MEMBER', customRoleId: undefined }], 'agent-1');
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'agent-1', isScoped: true }));
    });

    it('given a drive the agent cannot access, should refuse 403, mint nothing, and audit', async () => {
      mocks.validate.mockResolvedValue({ ...NO_SCOPE_PROBLEMS, invalidDriveIds: ['someone-elses'] });
      const response = await mint({ name: 'k', drives: [{ id: 'someone-elses' }] });
      expect(response.status).toBe(403);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ method: 'agent', reason: 'invalid_drive_scope' }) }));
    });

    it('given ADMIN on a drive where the agent is not admin, should refuse 403 and mint nothing', async () => {
      mocks.validate.mockResolvedValue({ ...NO_SCOPE_PROBLEMS, unauthorizedRoles: ['d1'] });
      const response = await mint({ name: 'k', drives: [{ id: 'd1', role: 'ADMIN' }] });
      expect(response.status).toBe(403);
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('should mint through the guarded path with the caller\'s tokenVersion and the cap of 20', async () => {
      await mint();
      expect(mocks.guarded).toHaveBeenCalledWith(expect.objectContaining({ userId: 'agent-1' }), { expectedTokenVersion: 7, maxLiveKeys: 20 });
    });

    it('given the agent already holds the maximum number of live keys, should refuse 409 and audit', async () => {
      mocks.guarded.mockResolvedValue({ ok: false, reason: 'key_limit_reached' });
      const response = await mint();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'key_limit_reached', limit: 20 });
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ method: 'agent', reason: 'live_key_limit' }) }));
    });

    it('given the credentials were revoked while the request was in flight, should answer the dead-bearer 401 and audit', async () => {
      mocks.guarded.mockResolvedValue({ ok: false, reason: 'credentials_revoked' });
      const response = await mint();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(OAUTH_REFUSAL);
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ method: 'agent', reason: 'credentials_revoked' }) }));
    });

    it('given the per-agent AGENT_KEY_MINT limit is exhausted, should answer 429, mint nothing, and audit', async () => {
      mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfter: 600 });
      const response = await mint();
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('600');
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-key-mint:user:agent-1', { maxAttempts: 10, windowMs: 3_600_000 });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'security.rate.limited', details: expect.objectContaining({ method: 'agent' }) }));
    });
  });

  describe('every other OAuth token keeps the refusal this route has always given a bearer', () => {
    it.each([
      ["the same agent's account token minted for ANOTHER client", { clientId: 'pagespace-cli', accountType: 'agent' }, agentAuth],
      ["a HUMAN's account-scoped token", { clientId: 'pagespace-cli', accountType: 'human' }, { ...agentAuth, userId: 'human-1' }],
      ["a human's token even if minted for pagespace-agent", { clientId: 'pagespace-agent', accountType: 'human' }, { ...agentAuth, userId: 'human-1' }],
    ])('given %s, should answer the unchanged 401 and mint nothing', async (_label, issuance, auth) => {
      mocks.auth.mockResolvedValue(auth);
      mocks.issuance.mockResolvedValue(issuance);
      const response = await mint();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(OAUTH_REFUSAL);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ method: 'agent', reason: 'not_agent_grant_credential' }) }));
    });

    it('given a narrow (non-account) agent token, should answer the unchanged 401 without even looking up the issuance', async () => {
      mocks.auth.mockResolvedValue({ ...agentAuth, scopes: { account: false } });
      const response = await mint();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(OAUTH_REFUSAL);
      expect(mocks.issuance).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('given an INVALID ps_at_ bearer, should answer the same unchanged 401 (no new oracle on token validity)', async () => {
      mocks.auth.mockResolvedValue({ error: new Response(JSON.stringify({ error: 'Invalid or expired OAuth token' }), { status: 401 }) });
      const response = await mint();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(OAUTH_REFUSAL);
    });
  });
});
