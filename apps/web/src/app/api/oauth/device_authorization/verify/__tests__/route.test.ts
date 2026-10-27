/**
 * POST /api/oauth/device_authorization/verify (task mwexjazwha2uhw5bmvc9a7kw).
 * Session-gated user-code lookup for the /activate screen: rate limiting
 * (per session AND per IP), code normalization, and the constant "invalid
 * or expired" collapse for anything that isn't currently pending+unexpired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
  getClientIP: vi.fn().mockReturnValue('203.0.113.7'),
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { OAUTH_VERIFY: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: false } },
}));

const verifyDeviceUserCode = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  verifyDeviceUserCode: (...args: unknown[]) => verifyDeviceUserCode(...args),
}));

const findActiveMcpTokenByIdAndUser = vi.fn();
vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    findDrivesByIds: vi.fn().mockResolvedValue([]),
    findActiveMcpTokenByIdAndUser: (...args: unknown[]) => findActiveMcpTokenByIdAndUser(...args),
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: { query: { driveRoles: { findFirst: vi.fn().mockResolvedValue(undefined) } } },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/members', () => ({ driveRoles: {} }));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const AUTHENTICATED = {
  tokenType: 'session',
  userId: 'user-1',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
  sessionId: 'sess-1',
};

function verifyRequest(body: unknown): Request {
  return new Request('http://web.local/api/oauth/device_authorization/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ALLOWED = { allowed: true, attemptsRemaining: 9 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(AUTHENTICATED as never);
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
});

describe('POST /api/oauth/device_authorization/verify — session gate', () => {
  it('rejects when unauthenticated, never checks rate limits or the repository', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
    } as never);

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);

    expect(res.status).toBe(401);
    expect(checkDistributedRateLimit).not.toHaveBeenCalled();
    expect(verifyDeviceUserCode).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device_authorization/verify — brute-force rate limiting', () => {
  it('blocks when the per-IP limit is exceeded, never reaching the repository', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-device-verify:ip:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);

    expect(res.status).toBe(429);
    expect(verifyDeviceUserCode).not.toHaveBeenCalled();
  });

  it('blocks when the per-session limit is exceeded, never reaching the repository', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-device-verify:session:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);

    expect(res.status).toBe(429);
    expect(verifyDeviceUserCode).not.toHaveBeenCalled();
  });

  it('checks both the IP and the session identity as distinct rate-limit keys', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'not_found' });

    await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);

    const keys = checkDistributedRateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys.some((k) => k.includes('ip:203.0.113.7'))).toBe(true);
    expect(keys.some((k) => k.includes('session:user-1'))).toBe(true);
  });
});

describe('POST /api/oauth/device_authorization/verify — code normalization', () => {
  it('normalizes case and hyphens before looking up the code', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['account'] });

    await POST(verifyRequest({ userCode: 'abcd-efgh' }) as never);

    expect(verifyDeviceUserCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCDEFGH' }));
  });
});

describe('POST /api/oauth/device_authorization/verify — outcomes', () => {
  it('returns invalid_code for an unknown/expired/already-settled code', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'not_found' });

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('returns the client name, first-party flag, and scope narration for a pending code', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['account'] });

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.clientName).toBe('PageSpace CLI');
    expect(body.firstParty).toBe(true);
    expect(body.userCode).toBe('ABCDEFGH');
    expect(body.scopeDescriptions.length).toBeGreaterThan(0);
  });

  it('narrates a manage_keys scope as key-management access with no content access', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['manage_keys'] });

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopeDescriptions).toEqual([expect.stringMatching(/manage.*keys/i)]);
  });

  it('missing userCode → invalid_request', async () => {
    const res = await POST(verifyRequest({}) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });
});


/**
 * The screen must advertise the step-up ceremony for exactly the grants the
 * decision route will REQUIRE one for — both sides read the same
 * `isCredentialEscalatingGrant` predicate, and these cases pin the
 * advertising half. If they drift, the user either runs a ceremony the server
 * ignores or clicks Allow and is rejected after the fact.
 */
describe('POST /api/oauth/device_authorization/verify — step-up advertisement', () => {
  beforeEach(() => {
    findActiveMcpTokenByIdAndUser.mockResolvedValue({ id: 'tok1', name: 'my-key' });
  });

  const ESCALATING: ReadonlyArray<readonly [string, string[]]> = [
    ['a mint grant', ['drive:drv1:member', 'name:remote-key', 'offline_access']],
    ['a re-scope grant', ['update_key:tok1', 'drive:drv1:member']],
    ['an activation grant', ['activate_key:tok1']],
  ];

  for (const [label, scopes] of ESCALATING) {
    it(`advertises step-up for ${label}, bound to this code and scope`, async () => {
      verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes });

      const body = await (await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never)).json();

      expect(body.requiresStepUp).toBe(true);
      expect(body.stepUpActionBinding).toEqual({ userCode: 'ABCDEFGH', scope: scopes.join(' ') });
    });
  }

  it('does not advertise step-up for a plain login grant', async () => {
    verifyDeviceUserCode.mockResolvedValue({
      outcome: 'ok',
      clientId: 'pagespace-cli',
      scopes: ['manage_keys', 'offline_access'],
    });

    const body = await (await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never)).json();

    expect(body.requiresStepUp).toBe(false);
    expect(body.stepUpActionBinding).toBeNull();
  });

  it('names the target key so the user sees WHICH key they are re-scoping', async () => {
    verifyDeviceUserCode.mockResolvedValue({
      outcome: 'ok',
      clientId: 'pagespace-cli',
      scopes: ['update_key:tok1', 'drive:drv1:member'],
    });

    const body = await (await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never)).json();

    expect(findActiveMcpTokenByIdAndUser).toHaveBeenCalledWith('tok1', 'user-1');
    expect(JSON.stringify(body.scopeDescriptions)).toContain('my-key');
  });

  // No oracle: a token id belonging to someone else, revoked, or nonexistent
  // must be indistinguishable from a bad code — otherwise the screen becomes a
  // probe for other users' key ids.
  it('fails closed with invalid_code when the target key is not the verifying user\'s', async () => {
    verifyDeviceUserCode.mockResolvedValue({
      outcome: 'ok',
      clientId: 'pagespace-cli',
      scopes: ['activate_key:tok9'],
    });
    findActiveMcpTokenByIdAndUser.mockResolvedValue(null);

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  // Not merely a parse detail: rendering an empty capability list beneath an
  // Allow button would ask a human to approve something unnarrated.
  it('fails closed rather than rendering an empty consent list for an unparseable scope set', async () => {
    verifyDeviceUserCode.mockResolvedValue({
      outcome: 'ok',
      clientId: 'pagespace-cli',
      scopes: ['not a valid scope!'],
    });

    const res = await POST(verifyRequest({ userCode: 'ABCD-EFGH' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });
});
