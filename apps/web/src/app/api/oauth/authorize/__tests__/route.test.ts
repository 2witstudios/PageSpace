/**
 * GET/POST /api/oauth/authorize (task hn80whvl8p00jdhv3gt8nlr6).
 *
 * Covers: open-redirect guard (unknown client / unregistered redirect_uri
 * never redirect), error-redirect-after-validated-uri, session gate, CSRF on
 * the consent POST, single-use code hashed at rest, state echoed verbatim.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
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

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { createAuthorizationCode } from '@/lib/repositories/oauth-repository';

const REDIRECT_URI = 'http://127.0.0.1:51234/callback';
const CODE_CHALLENGE = 'a'.repeat(43);

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
});

describe('GET /api/oauth/authorize — open-redirect guard', () => {
  it('renders an error page (never redirects) for an unknown client_id', async () => {
    const res = await GET(getRequest({ client_id: 'evil-client' }) as never);
    expect(res.status).not.toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
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
