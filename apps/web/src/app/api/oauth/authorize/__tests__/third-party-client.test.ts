/**
 * Authorize endpoint × DB-backed third-party clients (Phase 1a leaf 3, ADR 0004
 * Decisions 2 and 7). GET and POST resolve through `resolveClient`; a request
 * beyond the client's `allowedScopes` cap is `invalid_scope` BEFORE the
 * consent screen is reached (GET) and before any code is minted or step-up
 * grant burned (POST).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
  getClientIP: vi.fn().mockReturnValue('203.0.113.9'),
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { OAUTH_AUTHORIZE: { maxAttempts: 20, windowMs: 300_000, progressiveDelay: false } },
}));

const resolveClient = vi.fn();
const resolveClientDbId = vi.fn();
const ensureOAuthClientRow = vi.fn();
const createAuthorizationCode = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  resolveClient: (...args: unknown[]) => resolveClient(...args),
  resolveClientDbId: (...args: unknown[]) => resolveClientDbId(...args),
  ensureOAuthClientRow: (...args: unknown[]) => ensureOAuthClientRow(...args),
  createAuthorizationCode: (...args: unknown[]) => createAuthorizationCode(...args),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn().mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' }),
}));
vi.mock('@pagespace/lib/permissions/membership-queries', () => ({
  getMemberCustomRoleId: vi.fn().mockResolvedValue(null),
  customRoleBelongsToDrive: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
const consumeStepUpGrant = vi.fn();
vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  consumeStepUpGrant: (...args: unknown[]) => consumeStepUpGrant(...args),
}));
vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: { findActiveMcpTokenByIdAndUser: vi.fn() },
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const REDIRECT_URI = 'https://swipesend.app/auth/pagespace/callback';
const THIRD_PARTY = {
  clientId: 'app_swipesend',
  name: 'SwipeSend',
  type: 'public' as const,
  redirectUris: [REDIRECT_URI],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],
  allowedScopes: ['profile', 'offline_access'],
  firstParty: false,
  verified: false,
};

const SESSION = { tokenType: 'session', userId: 'user-1', role: 'user', tokenVersion: 0, adminRoleVersion: 0, sessionId: 's' };

function getRequest(scope: string, clientId = 'app_swipesend'): Request {
  const url = new URL('http://web.local/api/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    scope,
    state: 'xyz123',
  }).toString();
  return new Request(url, { method: 'GET' });
}

function postRequest(scope: string, extra: Record<string, unknown> = {}): Request {
  return new Request('http://web.local/api/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'app_swipesend',
      redirectUri: REDIRECT_URI,
      responseType: 'code',
      codeChallenge: 'a'.repeat(43),
      codeChallengeMethod: 'S256',
      scope,
      state: 'xyz123',
      action: 'approve',
      ...extra,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_APP_URL = 'https://pagespace.ai';
  checkDistributedRateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 19 });
  resolveClient.mockImplementation(async (id: string) => (id === THIRD_PARTY.clientId ? THIRD_PARTY : null));
  resolveClientDbId.mockResolvedValue('db-row-1');
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(SESSION as never);
});

afterEach(() => {
  delete process.env.WEB_APP_URL;
});

describe('GET /api/oauth/authorize — third-party client', () => {
  it('sends a signed-in user to consent for a request inside the cap', async () => {
    const res = await GET(getRequest('profile offline_access') as never);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/oauth/consent?');
    expect(resolveClient).toHaveBeenCalledWith('app_swipesend');
  });

  it('redirects with error=invalid_scope for a scope beyond the cap, never reaching consent', async () => {
    const res = await GET(getRequest('profile drive:abc123:member') as never);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('xyz123');
  });

  it('renders the same no-redirect error page for an unknown and a disabled client', async () => {
    const unknown = await GET(getRequest('profile', 'app_nope') as never);
    resolveClient.mockResolvedValueOnce(null);
    const disabled = await GET(getRequest('profile') as never);

    expect(unknown.status).toBe(400);
    expect(disabled.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    expect(await disabled.text()).toBe(await unknown.text());
  });
});

describe('POST /api/oauth/authorize — third-party client', () => {
  it('approves profile with no step-up and mints the code against the client\'s own row id', async () => {
    const res = await POST(postRequest('profile') as never);

    expect(res.status).toBe(200);
    expect(new URL((await res.json()).redirectUri).searchParams.get('code')).toBeTruthy();
    expect(resolveClientDbId).toHaveBeenCalledWith(THIRD_PARTY);
    expect(ensureOAuthClientRow).not.toHaveBeenCalled();
    expect(createAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({ clientDbId: 'db-row-1' }));
  });

  it('rejects a scope beyond the cap as invalid_scope without minting a code or burning a step-up grant', async () => {
    const res = await POST(postRequest('profile drive:abc123:member', { stepUpToken: 'ps_stepup_test' }) as never);

    expect(res.status).toBe(200);
    expect(new URL((await res.json()).redirectUri).searchParams.get('error')).toBe('invalid_scope');
    expect(createAuthorizationCode).not.toHaveBeenCalled();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('refuses with invalid_client when the client row vanished between resolution and issuance', async () => {
    resolveClientDbId.mockResolvedValue(null);

    const res = await POST(postRequest('profile') as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_client' });
    expect(createAuthorizationCode).not.toHaveBeenCalled();
  });
});
