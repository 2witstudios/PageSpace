import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
  getClientIP: vi.fn().mockReturnValue('203.0.113.7'),
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { PASSKEY_OPTIONS: { maxAttempts: 30, windowMs: 900_000, progressiveDelay: false } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));

const beginWebauthnStepUp = vi.fn();
vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  beginWebauthnStepUp: (...args: unknown[]) => beginWebauthnStepUp(...args),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const AUTHENTICATED = { tokenType: 'session', userId: 'user-1', role: 'user', tokenVersion: 0, sessionId: 'sess-1' };
const ALLOWED = { allowed: true, attemptsRemaining: 29 };

function optionsRequest(body: unknown): Request {
  return new Request('http://web.local/api/auth/step-up/webauthn/options', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(AUTHENTICATED as never);
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
});

describe('POST /api/auth/step-up/webauthn/options', () => {
  it('rejects when session auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    } as never);

    const res = await POST(optionsRequest({ actionBinding: { name: 'My Token' } }) as never);

    expect(res.status).toBe(401);
    expect(beginWebauthnStepUp).not.toHaveBeenCalled();
  });

  it('rejects when rate limited', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });

    const res = await POST(optionsRequest({ actionBinding: { name: 'My Token' } }) as never);

    expect(res.status).toBe(429);
    expect(beginWebauthnStepUp).not.toHaveBeenCalled();
  });

  it('returns 404 no_passkey when the user has no registered passkey', async () => {
    beginWebauthnStepUp.mockResolvedValue({ ok: false, error: { code: 'NO_PASSKEY' } });

    const res = await POST(optionsRequest({ actionBinding: { name: 'My Token' } }) as never);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('no_passkey');
  });

  it('returns options + challengeId on success, scoped to the authenticated userId', async () => {
    beginWebauthnStepUp.mockResolvedValue({
      ok: true,
      data: { options: { challenge: 'c1' }, challengeId: 'chal-1' },
    });

    const res = await POST(optionsRequest({ actionBinding: { name: 'My Token' } }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.challengeId).toBe('chal-1');
    expect(beginWebauthnStepUp).toHaveBeenCalledWith({ userId: 'user-1', actionBinding: { name: 'My Token' } });
  });

  it('returns 400 on a malformed body', async () => {
    const res = await POST(optionsRequest({}) as never);
    expect(res.status).toBe(400);
    expect(beginWebauthnStepUp).not.toHaveBeenCalled();
  });
});
