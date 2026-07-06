import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('203.0.113.7'),
}));

vi.mock('@/lib/auth/auth-helpers', () => ({
  isSafeNextPath: vi.fn(),
  SIGNIN_NEXT_ALLOWED_PREFIXES: ['/oauth/consent'],
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { OAUTH_VERIFY: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: false } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

const verifyMagicLinkToken = vi.fn();
vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  verifyMagicLinkToken: (...args: unknown[]) => verifyMagicLinkToken(...args),
}));

const completeMagicLinkStepUp = vi.fn();
vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  completeMagicLinkStepUp: (...args: unknown[]) => completeMagicLinkStepUp(...args),
}));

vi.mock('@pagespace/lib/auth/step-up-decisions', () => ({
  parseMagicLinkStepUpNext: vi.fn(),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  resolveAppUrl: () => 'https://app.pagespace.ai',
}));

import { GET } from '../route';
import { isSafeNextPath } from '@/lib/auth/auth-helpers';
import { parseMagicLinkStepUpNext } from '@pagespace/lib/auth/step-up-decisions';

const ALLOWED = { allowed: true, attemptsRemaining: 9 };

function verifyReq(token: string): Request {
  return new Request(`http://web.local/api/auth/step-up/magic-link/verify?token=${encodeURIComponent(token)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
});

describe('GET /api/auth/step-up/magic-link/verify', () => {
  it('rejects when rate limited', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });

    const res = await GET(verifyReq('ps_magic_x') as never);

    expect(res.status).toBe(400);
    expect(verifyMagicLinkToken).not.toHaveBeenCalled();
  });

  it('renders a failure page when the magic link itself is invalid/expired/used', async () => {
    verifyMagicLinkToken.mockResolvedValue({ ok: false, error: { code: 'TOKEN_EXPIRED' } });

    const res = await GET(verifyReq('ps_magic_x') as never);

    expect(res.status).toBe(400);
    expect(completeMagicLinkStepUp).not.toHaveBeenCalled();
  });

  it('renders a failure page when the token is not a step-up link', async () => {
    verifyMagicLinkToken.mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: JSON.stringify({ platform: 'desktop' }) },
    });
    completeMagicLinkStepUp.mockResolvedValue({ ok: false, error: { code: 'STEP_UP_INVALID' } });

    const res = await GET(verifyReq('ps_magic_x') as never);

    expect(res.status).toBe(400);
  });

  it('redirects to a safe next path with the step-up token in the URL fragment, never the query string', async () => {
    verifyMagicLinkToken.mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: JSON.stringify({ purpose: 'step_up' }) },
    });
    completeMagicLinkStepUp.mockResolvedValue({ ok: true, data: { stepUpToken: 'ps_stepup_abc' } });
    vi.mocked(parseMagicLinkStepUpNext).mockReturnValue('/oauth/consent?client_id=x');
    vi.mocked(isSafeNextPath).mockReturnValue(true);

    const res = await GET(verifyReq('ps_magic_x') as never);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/oauth/consent');
    expect(location.searchParams.get('client_id')).toBe('x');
    // Fragments never leave the browser, so the bearer-like single-use token
    // can't land in server/proxy access logs the way a query param would.
    expect(location.hash).toBe('#step_up_token=ps_stepup_abc');
    expect(location.search).not.toContain('step_up_token');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('marks every response no-store — success page, failure page, and redirect alike', async () => {
    verifyMagicLinkToken.mockResolvedValue({ ok: false, error: { code: 'TOKEN_EXPIRED' } });
    const failure = await GET(verifyReq('ps_magic_x') as never);
    expect(failure.headers.get('cache-control')).toContain('no-store');

    verifyMagicLinkToken.mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: JSON.stringify({ purpose: 'step_up' }) },
    });
    completeMagicLinkStepUp.mockResolvedValue({ ok: true, data: { stepUpToken: 'ps_stepup_abc' } });
    vi.mocked(parseMagicLinkStepUpNext).mockReturnValue(null);
    const success = await GET(verifyReq('ps_magic_x') as never);
    expect(success.headers.get('cache-control')).toContain('no-store');
  });

  it('renders a plain success page (no redirect) when next is missing or unsafe', async () => {
    verifyMagicLinkToken.mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: JSON.stringify({ purpose: 'step_up' }) },
    });
    completeMagicLinkStepUp.mockResolvedValue({ ok: true, data: { stepUpToken: 'ps_stepup_abc' } });
    vi.mocked(parseMagicLinkStepUpNext).mockReturnValue(null);

    const res = await GET(verifyReq('ps_magic_x') as never);

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('returns 400 when the token query param is missing', async () => {
    const res = await GET(new Request('http://web.local/api/auth/step-up/magic-link/verify') as never);
    expect(res.status).toBe(400);
    expect(verifyMagicLinkToken).not.toHaveBeenCalled();
  });
});
