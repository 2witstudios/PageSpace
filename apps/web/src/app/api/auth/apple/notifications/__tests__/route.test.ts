import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/apple/apple-notifications', () => ({
  verifyAppleServerNotification: vi.fn(),
  handleAppleServerNotification: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: { API: { maxAttempts: 100, windowMs: 60000 } },
}));
vi.mock('@/lib/auth', () => ({ getClientIP: vi.fn().mockReturnValue('17.0.0.1') }));

import { POST } from '../route';
import { verifyAppleServerNotification, handleAppleServerNotification } from '@pagespace/lib/auth/apple/apple-notifications';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

const notify = (body: unknown) =>
  new Request('https://pagespace.ai/api/auth/apple/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/auth/apple/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 99 });
  });

  it('given a verified consent-revoked notification, should end the user\'s sessions, audit it and answer 200', async () => {
    vi.mocked(verifyAppleServerNotification).mockResolvedValue({ ok: true, event: { type: 'consent-revoked', sub: 'apple-sub-1' } });
    vi.mocked(handleAppleServerNotification).mockResolvedValue({ action: 'sessions_ended', userId: 'user-1' });

    const res = await POST(notify({ payload: 'signed.jwt.value' }));

    expect(res.status).toBe(200);
    expect(verifyAppleServerNotification).toHaveBeenCalledWith('signed.jwt.value');
    expect(handleAppleServerNotification).toHaveBeenCalledWith({ type: 'consent-revoked', sub: 'apple-sub-1' });
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'auth.session.revoked', userId: 'user-1', details: expect.objectContaining({ reason: 'apple_consent-revoked' }) }),
    );
  });

  it('given a notification for an event PageSpace ignores, should still answer 200 so Apple does not retry', async () => {
    vi.mocked(verifyAppleServerNotification).mockResolvedValue({ ok: true, event: { type: 'email-disabled', sub: 'apple-sub-1' } });
    vi.mocked(handleAppleServerNotification).mockResolvedValue({ action: 'ignored' });

    expect((await POST(notify({ payload: 'signed.jwt.value' }))).status).toBe(200);
  });

  it('given a payload that fails verification, should refuse with 400 without acting', async () => {
    vi.mocked(verifyAppleServerNotification).mockResolvedValue({ ok: false, reason: 'JsonWebTokenError' });

    const res = await POST(notify({ payload: 'forged.jwt.value' }));

    expect(res.status).toBe(400);
    expect(handleAppleServerNotification).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'security.suspicious.activity' }),
    );
  });

  it.each([['not json'], [{}], [{ payload: 42 }], [{ payload: 'x'.repeat(20_000) }]])(
    'given a malformed body %#, should refuse with 400 without verifying',
    async (body) => {
      const res = await POST(notify(body));

      expect(res.status).toBe(400);
      expect(verifyAppleServerNotification).not.toHaveBeenCalled();
    },
  );

  it('given the caller is over the rate limit, should answer 429 without verifying', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: false, attemptsRemaining: 0, retryAfter: 60 });

    const res = await POST(notify({ payload: 'signed.jwt.value' }));

    expect(res.status).toBe(429);
    expect(checkDistributedRateLimit).toHaveBeenCalledWith('apple:notifications:ip:17.0.0.1', expect.anything());
    expect(verifyAppleServerNotification).not.toHaveBeenCalled();
  });

  it('given handling throws, should answer 500 so Apple retries', async () => {
    vi.mocked(verifyAppleServerNotification).mockResolvedValue({ ok: true, event: { type: 'consent-revoked', sub: 's' } });
    vi.mocked(handleAppleServerNotification).mockRejectedValue(new Error('db down'));

    expect((await POST(notify({ payload: 'signed.jwt.value' }))).status).toBe(500);
  });
});
