import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
}));

// The real predicate + allowlist from the implementation leaf (url-utils), not
// a stub: mocking isSafeNextPath is exactly how the consent-URL regression
// below shipped unnoticed. Only the Node-only parts of the auth-helpers barrel
// ('server-only', the '@/lib/auth' graph) are kept out of the test.
vi.mock('@/lib/auth/auth-helpers', () => import('@/lib/auth/url-utils'));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { MAGIC_LINK: { maxAttempts: 3, windowMs: 900_000, progressiveDelay: true } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

const requestMagicLinkStepUp = vi.fn();
vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  requestMagicLinkStepUp: (...args: unknown[]) => requestMagicLinkStepUp(...args),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

// The exact `next` the consent page sends during `pagespace login`: its own
// URL, whose query embeds the CLI's percent-encoded loopback redirect_uri.
const CLI_CONSENT_URL =
  '/oauth/consent?client_id=psc_cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A51739%2Fcallback' +
  '&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
  '&code_challenge_method=S256&scope=drive.read+drive.write&state=xyzABC123';

const AUTHENTICATED = { tokenType: 'session', userId: 'user-1', role: 'user', tokenVersion: 0, sessionId: 'sess-1' };
const ALLOWED = { allowed: true, attemptsRemaining: 2 };

function requestReq(body: unknown): Request {
  return new Request('http://web.local/api/auth/step-up/magic-link/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(AUTHENTICATED as never);
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
  requestMagicLinkStepUp.mockResolvedValue({ ok: true });
});

describe('POST /api/auth/step-up/magic-link/request', () => {
  it('rejects when session auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    } as never);

    const res = await POST(requestReq({ actionBinding: { clientId: 'cli-1' } }) as never);

    expect(res.status).toBe(401);
    expect(requestMagicLinkStepUp).not.toHaveBeenCalled();
  });

  it('rejects when rate limited', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 60 });

    const res = await POST(requestReq({ actionBinding: { clientId: 'cli-1' } }) as never);

    expect(res.status).toBe(429);
  });

  it('drops an unsafe next path rather than passing it through (real predicate)', async () => {
    await POST(requestReq({ actionBinding: { clientId: 'cli-1' }, next: 'https://evil.example.com' }) as never);

    expect(requestMagicLinkStepUp).toHaveBeenCalledWith(
      expect.objectContaining({ next: undefined }),
    );
  });

  it('passes a safe next path through', async () => {
    await POST(requestReq({ actionBinding: { clientId: 'cli-1' }, next: '/oauth/consent?client_id=x' }) as never);

    expect(requestMagicLinkStepUp).toHaveBeenCalledWith(
      expect.objectContaining({ next: '/oauth/consent?client_id=x' }),
    );
  });

  it('stores the CLI consent URL — encoded loopback redirect_uri and all — as next (regression)', async () => {
    await POST(requestReq({ actionBinding: { clientId: 'psc_cli' }, next: CLI_CONSENT_URL }) as never);

    expect(requestMagicLinkStepUp).toHaveBeenCalledWith(
      expect.objectContaining({ next: CLI_CONSENT_URL }),
    );
  });

  it('returns 200 ok on success without leaking internals', async () => {
    const res = await POST(requestReq({ actionBinding: { clientId: 'cli-1' } }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('returns 500 on a service failure', async () => {
    requestMagicLinkStepUp.mockResolvedValue({ ok: false, error: { code: 'USER_NOT_FOUND' } });

    const res = await POST(requestReq({ actionBinding: { clientId: 'cli-1' } }) as never);

    expect(res.status).toBe(500);
  });

  it('returns 400 on a malformed body', async () => {
    const res = await POST(requestReq({}) as never);
    expect(res.status).toBe(400);
    expect(requestMagicLinkStepUp).not.toHaveBeenCalled();
  });
});
