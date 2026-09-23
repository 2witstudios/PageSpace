/**
 * POST /api/oauth/token — the jwt-bearer grant (Agent Signup Phase 2 leaf 4;
 * ADR 0007 Decisions 5-6, threat model T3/T4). The real static client
 * registry and the real scope resolver are used, so a client or scope check
 * that is mis-wired fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { createHash } from 'crypto';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  ensureOAuthClientRow: vi.fn(),
  exchangeAgentAssertion: vi.fn(),
  refreshTokenGrant: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  doorOpen: vi.fn(),
  provision: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: mocks.ensureOAuthClientRow,
  exchangeAuthorizationCode: vi.fn(),
  refreshTokenGrant: mocks.refreshTokenGrant,
  pollDeviceToken: vi.fn(),
  exchangeAgentAssertion: mocks.exchangeAgentAssertion,
  findRefreshTokenFamilyId: vi.fn().mockResolvedValue('family-1'),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/onboarding/home-drive', () => ({ provisionHomeDriveIfNeeded: mocks.provision }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: mocks.logError, info: vi.fn(), warn: vi.fn() }, api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(), logTokenActivity: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getClientIP: () => '203.0.113.21' }));
vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.doorOpen(),
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: {
    OAUTH_TOKEN_EXCHANGE: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: true },
    OAUTH_DEVICE_POLL: { maxAttempts: 100, windowMs: 300_000 },
    AGENT_TOKEN_IP: { maxAttempts: 60, windowMs: 300_000 },
    AGENT_TOKEN_CREDENTIAL: { maxAttempts: 10, windowMs: 300_000 },
  },
}));

import { POST } from '../route';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';

const GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';
const INVALID_GRANT = { error: 'invalid_grant' };

const tokens = {
  accessToken: 'ps_at_' + 'a'.repeat(43),
  refreshToken: 'ps_rt_' + 'b'.repeat(43),
  familyId: 'family-1',
};

function tokenRequest(fields: Record<string, string | undefined>): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  return new Request('http://web.local/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

const fields = (overrides: Record<string, string | undefined> = {}) => ({
  grant_type: GRANT, assertion: SECRET, client_id: 'pagespace-agent', ...overrides,
});

describe('POST /api/oauth/token — jwt-bearer (agent assertion) grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.doorOpen.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.ensureOAuthClientRow.mockResolvedValue('client-db-agent');
    mocks.exchangeAgentAssertion.mockResolvedValue({ outcome: 'ok', userId: 'agent-1', scopes: ['account', 'offline_access'], tokens });
    mocks.provision.mockResolvedValue({ driveId: 'home-1', created: false });
  });

  describe('given a live agent secret presented by pagespace-agent', () => {
    it('should answer the standard token response with the default account offline_access scope', async () => {
      const response = await POST(tokenRequest(fields()) as never);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({
        access_token: tokens.accessToken, token_type: 'Bearer', expires_in: expect.any(Number), refresh_token: tokens.refreshToken, scope: 'account offline_access',
      });
      expect(mocks.exchangeAgentAssertion).toHaveBeenCalledWith({ assertion: SECRET, clientDbId: 'client-db-agent', scopes: ['account', 'offline_access'], now: expect.any(Date) });
    });

    it('should audit the exchange for the agent without the secret', async () => {
      await POST(tokenRequest(fields()) as never);
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', userId: 'agent-1', details: expect.objectContaining({ clientId: 'pagespace-agent', oauthEvent: 'agent_assertion_exchanged' }) }));
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(SECRET);
    });

    it('should apply the token-exchange rate limit before the secret is looked up', async () => {
      // The IP bucket passes; the per-credential bucket (checked second) refuses.
      mocks.rateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, retryAfter: 30 });
      const response = await POST(tokenRequest(fields()) as never);
      expect(response.status).toBe(429);
      expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
      expect(mocks.rateLimit).toHaveBeenCalledWith('agent-token:ip:203.0.113.21', { maxAttempts: 60, windowMs: 300_000 });
      expect(mocks.rateLimit).toHaveBeenCalledWith(expect.stringMatching(/^agent-token:credential:[0-9a-f]{20}$/), { maxAttempts: 10, windowMs: 300_000 });
    });
  });

  describe('given the store fails mid-grant (Phase 2b: no hash reaches a log)', () => {
    it('should answer a constant 503 and log only the redacted class, code and constraint — never the bound secret hash', async () => {
      const secretHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      mocks.exchangeAgentAssertion.mockRejectedValue(new DrizzleQueryError(
        'select "userId" from "agent_identities" where "secretHash" = $1',
        [secretHash],
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      ));

      const response = await POST(tokenRequest(fields()) as never);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(mocks.logError).toHaveBeenCalledWith('OAuth token request failed', { errorName: 'DrizzleQueryError', code: '57014', constraint: null });
      expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(secretHash);
    });
  });

  describe('given a non-database bug mid-grant', () => {
    // Every Node builtin error carries a SCREAMING_SNAKE `code`; a plain
    // TypeError would pass vacuously, so use the real code-bearing shape.
    it('given a real Node builtin error (it carries a code), should rethrow it untouched so Sentry still sees the bug', async () => {
      let builtin: unknown;
      try {
        createHash('sha3-256').update(undefined as unknown as string);
      } catch (error) {
        builtin = error;
      }
      expect((builtin as { code?: string }).code).toBe('ERR_INVALID_ARG_TYPE');
      mocks.exchangeAgentAssertion.mockRejectedValue(builtin);

      await expect(POST(tokenRequest(fields()) as never)).rejects.toBe(builtin);
      expect(mocks.logError).not.toHaveBeenCalledWith('OAuth token request failed', expect.anything());
    });

    it('given a lib identity-store failure (already redacted), should answer 503 like the identity door', async () => {
      mocks.exchangeAgentAssertion.mockRejectedValue(new AgentIdentityStoreError('verify_secret', { errorName: 'DrizzleQueryError', code: '57014', constraint: null }));

      const response = await POST(tokenRequest(fields()) as never);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
    });
  });

  describe('Home drive recovery (the sign-in retry createAgentAccount relies on)', () => {
    it('given a successful exchange, should re-run the idempotent Home-drive provisioning for the agent', async () => {
      await POST(tokenRequest(fields()) as never);
      expect(mocks.provision).toHaveBeenCalledWith('agent-1');
    });

    it('given provisioning fails, should still issue the tokens and log the failure', async () => {
      mocks.provision.mockRejectedValue(new Error('db blip'));
      const response = await POST(tokenRequest(fields()) as never);
      expect(response.status).toBe(200);
      expect(mocks.logError).toHaveBeenCalled();
    });

    it('given a refused secret, should not provision anything', async () => {
      mocks.exchangeAgentAssertion.mockResolvedValue({ outcome: 'revoked', userId: 'agent-1' });
      await POST(tokenRequest(fields()) as never);
      expect(mocks.provision).not.toHaveBeenCalled();
    });
  });

  describe('every failure is the same invalid_grant body', () => {
    it.each([['not_found'], ['revoked'], ['suspended'], ['locked']])('given a %s secret, should answer invalid_grant', async (outcome) => {
      mocks.exchangeAgentAssertion.mockResolvedValue({ outcome, userId: outcome === 'not_found' ? null : 'agent-1' });
      const response = await POST(tokenRequest(fields()) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID_GRANT);
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ oauthEvent: 'agent_assertion_rejected', outcome }) }));
    });

    it('given an unknown client_id, should answer invalid_grant without looking the secret up', async () => {
      const response = await POST(tokenRequest(fields({ client_id: 'not-a-client' })) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID_GRANT);
      expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: { oauthEvent: 'agent_assertion_client_rejected' } }));
    });

    it.each([
      ['a drive scope', 'drive:abc123'],
      ['all_drives', 'all_drives'],
      ['manage_keys', 'manage_keys'],
      ['a key-shaped scope', 'drive:abc123 name:k'],
      ['activate_key', 'activate_key:abc123'],
      ['a malformed scope', 'account nonsense'],
    ])('given %s, should answer invalid_grant and never exchange the secret', async (_label, scope) => {
      const response = await POST(tokenRequest(fields({ scope })) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID_GRANT);
      expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ oauthEvent: 'agent_assertion_scope_refused' }) }));
    });

    it('given scope=account, should exchange for account only', async () => {
      mocks.exchangeAgentAssertion.mockResolvedValue({ outcome: 'ok', userId: 'agent-1', scopes: ['account'], tokens: { ...tokens, refreshToken: undefined } });
      const response = await POST(tokenRequest(fields({ scope: 'account' })) as never);
      expect(response.status).toBe(200);
      expect(mocks.exchangeAgentAssertion).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['account'] }));
      expect(await response.json()).not.toHaveProperty('refresh_token');
    });
  });

  describe('client binding (the grant belongs to pagespace-agent only)', () => {
    it('given pagespace-cli presents an agent secret, should answer unauthorized_client and never look the secret up', async () => {
      const response = await POST(tokenRequest(fields({ client_id: 'pagespace-cli' })) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'unauthorized_client' });
      expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ clientId: 'pagespace-cli', oauthEvent: 'agent_assertion_unauthorized_client' }) }));
    });

    it('given a client_secret alongside the public agent client, should answer invalid_request', async () => {
      const response = await POST(tokenRequest(fields({ client_secret: 'nope' })) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
    });

    it.each([['assertion'], ['client_id']])('given no %s, should answer invalid_request', async (missing) => {
      const response = await POST(tokenRequest(fields({ [missing]: undefined })) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: { oauthEvent: 'agent_assertion_invalid_request' } }));
    });
  });

  describe('given the agent door is closed on this deployment', () => {
    it('should answer unsupported_grant_type and never look the secret up', async () => {
      mocks.doorOpen.mockReturnValue(false);
      const response = await POST(tokenRequest(fields()) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'unsupported_grant_type' });
      expect(mocks.exchangeAgentAssertion).not.toHaveBeenCalled();
    });
  });

  describe('the refresh token from this grant', () => {
    it('should rotate through the existing refresh_token grant for pagespace-agent unchanged', async () => {
      mocks.refreshTokenGrant.mockResolvedValue({ outcome: 'ok', userId: 'agent-1', scopes: ['account', 'offline_access'], tokens });
      const response = await POST(tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: 'pagespace-agent' }) as never);
      expect(response.status).toBe(200);
      expect(mocks.refreshTokenGrant).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: tokens.refreshToken, clientDbId: 'client-db-agent' }));
    });
  });
});
