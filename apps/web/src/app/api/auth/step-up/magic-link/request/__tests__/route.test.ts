import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
}));

vi.mock('@/lib/auth/auth-helpers', () => ({
  isSafeNextPath: vi.fn(),
  SIGNIN_NEXT_ALLOWED_PREFIXES: ['/oauth/consent'],
}));

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
import { isSafeNextPath } from '@/lib/auth/auth-helpers';

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
  vi.mocked(isSafeNextPath).mockReturnValue(true);
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

  it('drops an unsafe next path rather than passing it through', async () => {
    vi.mocked(isSafeNextPath).mockReturnValue(false);

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
