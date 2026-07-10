import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
}));
vi.mock('@pagespace/lib/security/client-ip', () => ({
  getClientIP: vi.fn().mockReturnValue('203.0.113.7'),
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { PASSKEY_AUTH: { maxAttempts: 10, windowMs: 900_000, progressiveDelay: false } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

const verifyWebauthnStepUp = vi.fn();
vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  verifyWebauthnStepUp: (...args: unknown[]) => verifyWebauthnStepUp(...args),
}));

import { POST } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const AUTHENTICATED = { tokenType: 'session', userId: 'user-1', role: 'user', tokenVersion: 0, sessionId: 'sess-1' };
const ALLOWED = { allowed: true, attemptsRemaining: 9 };

function verifyRequest(body: unknown): Request {
  return new Request('http://web.local/api/auth/step-up/webauthn/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  response: { id: 'cred-1' },
  expectedChallenge: 'server-challenge',
  actionBinding: { name: 'My Token' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(AUTHENTICATED as never);
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
});

describe('POST /api/auth/step-up/webauthn/verify', () => {
  it('rejects when session auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    } as never);

    const res = await POST(verifyRequest(VALID_BODY) as never);

    expect(res.status).toBe(401);
    expect(verifyWebauthnStepUp).not.toHaveBeenCalled();
  });

  it('rejects when rate limited', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });

    const res = await POST(verifyRequest(VALID_BODY) as never);

    expect(res.status).toBe(429);
  });

  it('returns a generic 401 for any ceremony failure (no oracle)', async () => {
    verifyWebauthnStepUp.mockResolvedValue({ ok: false, error: { code: 'STEP_UP_INVALID' } });

    const res = await POST(verifyRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('step_up_invalid');
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('returns the step-up token on success, scoped to the authenticated userId', async () => {
    verifyWebauthnStepUp.mockResolvedValue({ ok: true, data: { stepUpToken: 'ps_stepup_abc' } });

    const res = await POST(verifyRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stepUpToken).toBe('ps_stepup_abc');
    expect(verifyWebauthnStepUp).toHaveBeenCalledWith({
      userId: 'user-1',
      response: VALID_BODY.response,
      expectedChallenge: VALID_BODY.expectedChallenge,
      actionBinding: VALID_BODY.actionBinding,
    });
  });

  it('returns 400 on a malformed body', async () => {
    const res = await POST(verifyRequest({}) as never);
    expect(res.status).toBe(400);
    expect(verifyWebauthnStepUp).not.toHaveBeenCalled();
  });
});
