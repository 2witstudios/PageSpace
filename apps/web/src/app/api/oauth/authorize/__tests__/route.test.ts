/**
 * GET/POST /api/oauth/authorize (task hn80whvl8p00jdhv3gt8nlr6).
 *
 * Covers: open-redirect guard (unknown client / unregistered redirect_uri
 * never redirect), error-redirect-after-validated-uri, session gate, CSRF on
 * the consent POST, single-use code hashed at rest, state echoed verbatim.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: vi.fn().mockResolvedValue('client-db-id-1'),
  createAuthorizationCode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn().mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' }),
}));

vi.mock('@pagespace/lib/permissions/membership-queries', () => ({
  getMemberCustomRoleId: vi.fn().mockResolvedValue(null),
  customRoleBelongsToDrive: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  consumeStepUpGrant: vi.fn(),
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createAuthorizationCode } from '@/lib/repositories/oauth-repository';
import { consumeStepUpGrant } from '@pagespace/lib/auth/step-up-service';
import { nextConfig } from '../../../../../../next.config';

const REDIRECT_URI = 'http://127.0.0.1:51234/callback';
const CODE_CHALLENGE = 'a'.repeat(43);
const ALLOWED = { allowed: true, attemptsRemaining: 19 };

function authorizeUrl(overrides: Record<string, string | undefined> = {}): string {
  const params: Record<string, string> = {
    client_id: 'pagespace-cli',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'account',
    state: 'xyz123',
    ...overrides,
  };
  const url = new URL('http://web.local/api/oauth/authorize');
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function getRequest(overrides: Record<string, string | undefined> = {}): Request {
  return new Request(authorizeUrl(overrides), { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
  vi.mocked(consumeStepUpGrant).mockResolvedValue({ ok: true });
});

describe('GET /api/oauth/authorize — per-IP rate limiting', () => {
  it('blocks with 429 when the per-IP limit is exceeded, never checking auth', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-authorize:ip:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await GET(getRequest() as never);

    expect(res.status).toBe(429);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
  });

  it('audits the rate-limit trip', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-authorize:ip:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    await GET(getRequest() as never);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'security.rate.limited' }),
    );
  });

  it('checks the IP dimension keyed by client IP', async () => {
    await GET(getRequest({ client_id: 'evil-client' }) as never);

    const keys = checkDistributedRateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys.some((k) => k.includes('ip:203.0.113.9'))).toBe(true);
  });
});

describe('GET /api/oauth/authorize — open-redirect guard', () => {
  it('renders an error page (never redirects) for an unknown client_id', async () => {
    const res = await GET(getRequest({ client_id: 'evil-client' }) as never);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('location')).toBeNull();
    const body = await res.text();
    expect(body).toMatch(/error/i);
  });

  it('renders an error page (never redirects) for an unregistered redirect_uri', async () => {
    const res = await GET(getRequest({ redirect_uri: 'http://evil.example.com/callback' }) as never);
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('renders an error page (never redirects) for a substring/prefix-attack redirect_uri', async () => {
    const res = await GET(getRequest({ redirect_uri: `${REDIRECT_URI}.evil.com` }) as never);
    expect(res.headers.get('location')).toBeNull();
  });

  it('renders an error page (never redirects) for a wrong-path loopback redirect_uri', async () => {
    const res = await GET(getRequest({ redirect_uri: 'http://127.0.0.1:51234/not-callback' }) as never);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('GET /api/oauth/authorize — redirect-with-error (redirect_uri already validated)', () => {
  it('redirects to redirect_uri with error=invalid_request for plain PKCE', async () => {
    const res = await GET(getRequest({ code_challenge_method: 'plain' }) as never);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:51234/callback');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('xyz123');
  });

  it('redirects to redirect_uri with error=invalid_scope for an unknown scope', async () => {
    const res = await GET(getRequest({ scope: 'nonsense_scope' }) as never);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
  });

  it('omits the state param entirely when the request had no state', async () => {
    const res = await GET(getRequest({ scope: 'nonsense_scope', state: undefined }) as never);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.has('state')).toBe(false);
  });
});

describe('GET /api/oauth/authorize — session gate', () => {
  it('redirects to signin, preserving the full authorize request, when unauthenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(null, { status: 401 }),
    } as never);

    const res = await GET(getRequest() as never);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/auth/signin');
    const next = location.searchParams.get('next')!;
    expect(next).toContain('/oauth/consent');
    expect(decodeURIComponent(next)).toContain('client_id=pagespace-cli');
    expect(decodeURIComponent(next)).toContain('state=xyz123');
  });

  it('uses forwarded public origin for signin redirects instead of internal standalone bind host', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(null, { status: 401 }),
    } as never);

    const res = await GET(new NextRequest(authorizeUrl(), {
      headers: {
        host: '[::]:3000',
        'x-forwarded-host': 'pagespace.ai',
        'x-forwarded-proto': 'https',
      },
    }));

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://pagespace.ai');
    expect(location.pathname).toBe('/auth/signin');
    expect(location.href).not.toContain('[::]');
  });

  it('redirects to the consent screen, preserving the full authorize request, when authenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      tokenType: 'session',
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      sessionId: 'sess-1',
    } as never);

    const res = await GET(getRequest() as never);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/oauth/consent');
    expect(location.searchParams.get('client_id')).toBe('pagespace-cli');
    expect(location.searchParams.get('state')).toBe('xyz123');
  });

  it('uses forwarded public origin for consent redirects instead of internal standalone bind host', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      tokenType: 'session',
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      sessionId: 'sess-1',
    } as never);

    const res = await GET(new NextRequest(authorizeUrl(), {
      headers: {
        host: '[::]:3000',
        'x-forwarded-host': 'pagespace.ai',
        'x-forwarded-proto': 'https',
      },
    }));

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://pagespace.ai');
    expect(location.pathname).toBe('/oauth/consent');
    expect(location.href).not.toContain('[::]');
  });
});

describe('GET /api/oauth/authorize — loopback redirect_uri normalization', () => {
  const cliAuthorizeUrl =
    'http://web.local/api/oauth/authorize?response_type=code&client_id=pagespace-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A53397%2Fcallback&code_challenge=uWhtGkQARlvr1Drqj_gD3BMeFu9Q6V96GY7RWuH1Aks&code_challenge_method=S256&scope=account+offline_access&state=x';

  it('keeps middleware URL normalization disabled in Next config', () => {
    expect(nextConfig.skipMiddlewareUrlNormalize).toBe(true);
  });

  it('preserves 127.0.0.1 in encoded redirect_uri query params under the NextRequest flag', () => {
    const previous = process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
    process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = '1';

    try {
      const req = new NextRequest(cliAuthorizeUrl);

      expect(req.url).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A53397%2Fcallback');
      expect(req.url).not.toContain('redirect_uri=http%3A%2F%2Flocalhost%3A53397%2Fcallback');
    } finally {
      if (previous === undefined) {
        delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
      } else {
        process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = previous;
      }
    }
  });

  it('redirects unauthenticated CLI authorization requests to signin instead of rejecting the redirect_uri', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(null, { status: 401 }),
    } as never);

    const previous = process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
    process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = '1';

    try {
      const res = await GET(new NextRequest(cliAuthorizeUrl));

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/auth/signin');
      const next = decodeURIComponent(location.searchParams.get('next')!);
      expect(next).toContain('redirect_uri=http://127.0.0.1:53397/callback');
      expect(next).not.toContain('redirect_uri=http://localhost:53397/callback');
    } finally {
      if (previous === undefined) {
        delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
      } else {
        process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = previous;
      }
    }
  });
});

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://web.local/api/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const approvalBody = {
  clientId: 'pagespace-cli',
  redirectUri: REDIRECT_URI,
  responseType: 'code',
  codeChallenge: CODE_CHALLENGE,
  codeChallengeMethod: 'S256',
  scope: 'account',
  state: 'xyz123',
  action: 'approve',
  stepUpToken: 'ps_stepup_test',
};

describe('POST /api/oauth/authorize — consent CSRF', () => {
  it('rejects the consent decision when CSRF/session auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }),
    } as never);

    const res = await POST(postRequest(approvalBody) as never);
    expect(res.status).toBe(403);
    expect(vi.mocked(createAuthorizationCode)).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/authorize — per-user/per-client rate limiting', () => {
  beforeEach(() => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      tokenType: 'session',
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      sessionId: 'sess-1',
    } as never);
  });

  it('blocks with 429 when the per-user limit is exceeded, never minting a code', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-authorize:user:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(postRequest(approvalBody) as never);

    expect(res.status).toBe(429);
    expect(vi.mocked(createAuthorizationCode)).not.toHaveBeenCalled();
  });

  it('blocks with 429 when the per-client limit is exceeded, never minting a code', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-authorize:client:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(postRequest(approvalBody) as never);

    expect(res.status).toBe(429);
    expect(vi.mocked(createAuthorizationCode)).not.toHaveBeenCalled();
  });

  it('checks both the user and client dimensions', async () => {
    await POST(postRequest(approvalBody) as never);

    const keys = checkDistributedRateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys.some((k) => k.includes('user:user-1'))).toBe(true);
    expect(keys.some((k) => k.includes('client:pagespace-cli'))).toBe(true);
  });

  it('audits the rate-limit trip', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-authorize:user:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    await POST(postRequest(approvalBody) as never);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'security.rate.limited', userId: 'user-1' }),
    );
  });
});

describe('POST /api/oauth/authorize — approve', () => {
  beforeEach(() => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      tokenType: 'session',
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      sessionId: 'sess-1',
    } as never);
  });

  it('issues a single-use code hashed at rest and echoes state verbatim in the redirect target', async () => {
    const res = await POST(postRequest(approvalBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    const location = new URL(json.redirectUri);
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:51234/callback');
    expect(location.searchParams.get('state')).toBe('xyz123');
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    expect(vi.mocked(createAuthorizationCode)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createAuthorizationCode).mock.calls[0][0] as { codeHash: string };
    expect(call.codeHash).not.toBe(code);
    expect(call.codeHash).toMatch(/^[0-9a-f]{64}$/); // SHA3-256 hex digest, never the plaintext code
  });

  it('denial redirects with error=access_denied and echoes state verbatim, without minting a code', async () => {
    const res = await POST(postRequest({ ...approvalBody, action: 'deny' }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    const location = new URL(json.redirectUri);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('xyz123');
    expect(vi.mocked(createAuthorizationCode)).not.toHaveBeenCalled();
  });

  it('never redirects for a tampered unregistered redirect_uri, even on approval', async () => {
    const res = await POST(postRequest({ ...approvalBody, redirectUri: 'http://evil.example.com/callback' }) as never);
    expect(res.status).toBe(400);
    expect(vi.mocked(createAuthorizationCode)).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/authorize — step-up gate (Phase 8: bearer-OAuth minting escalation fix)', () => {
  beforeEach(() => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      tokenType: 'session',
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      sessionId: 'sess-1',
    } as never);
  });

  it('returns 401 when stepUpToken is missing, never minting a code', async () => {
    const { stepUpToken: _omit, ...withoutStepUp } = approvalBody;
    const res = await POST(postRequest(withoutStepUp) as never);

    expect(res.status).toBe(401);
    expect(vi.mocked(createAuthorizationCode)).not.toHaveBeenCalled();
  });

  it('returns 401 when the step-up grant fails to consume, never minting a code', async () => {
    vi.mocked(consumeStepUpGrant).mockResolvedValue({ ok: false, error: { code: 'STEP_UP_REQUIRED' } } as never);

    const res = await POST(postRequest(approvalBody) as never);

    expect(res.status).toBe(401);
    expect(vi.mocked(createAuthorizationCode)).not.toHaveBeenCalled();
  });

  it('consumes the step-up grant bound to client_id + redirect_uri + scope + state', async () => {
    await POST(postRequest(approvalBody) as never);

    expect(consumeStepUpGrant).toHaveBeenCalledWith({
      userId: 'user-1',
      token: 'ps_stepup_test',
      actionBinding: {
        clientId: 'pagespace-cli',
        redirectUri: REDIRECT_URI,
        scope: 'account',
        state: 'xyz123',
      },
    });
  });

  it('denial never requires a step-up token', async () => {
    const { stepUpToken: _omit, ...withoutStepUp } = approvalBody;
    const res = await POST(postRequest({ ...withoutStepUp, action: 'deny' }) as never);

    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });
});
