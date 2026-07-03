/**
 * POST /api/oauth/device_authorization/decision (task
 * mwexjazwha2uhw5bmvc9a7kw). CSRF-protected approve/deny for the /activate
 * screen: session + CSRF gate, per-session/IP rate limiting, code
 * normalization, and single-settlement passthrough from
 * `decideDeviceApproval` (task 4).
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

const recordDeviceApproval = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  recordDeviceApproval: (...args: unknown[]) => recordDeviceApproval(...args),
}));

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

function decisionRequest(body: unknown): Request {
  return new Request('http://web.local/api/oauth/device_authorization/decision', {
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

describe('POST /api/oauth/device_authorization/decision — CSRF/session gate', () => {
  it('rejects when CSRF/session auth fails, never records a decision', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }),
    } as never);

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(403);
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });

  it('requires requireCSRF: true on the authentication call', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireCSRF: true }),
    );
  });
});

describe('POST /api/oauth/device_authorization/decision — brute-force rate limiting', () => {
  it('blocks when the per-IP limit is exceeded, never recording a decision', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-device-decide:ip:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(429);
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });

  it('blocks when the per-session limit is exceeded, never recording a decision', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-device-decide:session:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(429);
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device_authorization/decision — code normalization', () => {
  it('normalizes case and hyphens before recording the decision', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    await POST(decisionRequest({ userCode: 'abcd-efgh', action: 'approve' }) as never);

    expect(recordDeviceApproval).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCDEFGH' }));
  });
});

describe('POST /api/oauth/device_authorization/decision — outcomes', () => {
  it('approve → { ok: true, action: "approved" }', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'approved' });
  });

  it('deny → { ok: true, action: "denied" } (a legitimate outcome, not an error)', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'denied' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'deny' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'denied' });
  });

  it('unknown code → invalid_code', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'not_found' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('already-settled code (single-settlement) → invalid_code', async () => {
    recordDeviceApproval.mockResolvedValue({
      outcome: 'invalid',
      decision: { status: 'already_settled', existingStatus: 'approved' },
    });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('expired code → invalid_code', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'invalid', decision: { status: 'expired' } });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('invalid action value → invalid_request', async () => {
    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'destroy' }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });
});
