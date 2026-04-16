import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  getTokenPrefix: vi.fn((t: string) => t.slice(0, 8)),
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_token'),
    validateSession: vi.fn().mockResolvedValue({ sessionId: 'sid_123' }),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  validateDeviceToken: vi.fn().mockResolvedValue({
    id: 'dt_1',
    userId: 'user_1',
    deviceId: 'device_123',
    platform: 'web',
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  }),
  updateDeviceTokenActivity: vi.fn().mockResolvedValue(undefined),
  generateDeviceToken: vi.fn().mockReturnValue('new_device_token'),
  generateCSRFToken: vi.fn().mockReturnValue('csrf_token'),
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: { REFRESH: { maxAttempts: 10, windowMs: 60000 } },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn().mockResolvedValue({ id: 'user_1', email: 'test@example.com' }),
  },
}));

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {},
}));

vi.mock('@pagespace/db/transactions/auth-transactions', () => ({
  atomicDeviceTokenRotation: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  appendSessionCookie: vi.fn(),
}));

import { POST } from '../refresh/route';
import { validateDeviceToken } from '@pagespace/lib/server';
import { sessionService } from '@pagespace/lib/auth';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/auth/device/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('device refresh deviceId propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_mock_token');
    vi.mocked(sessionService.validateSession).mockResolvedValue({ sessionId: 'sid_123' } as never);
  });

  it('given device refresh for web platform, should pass deviceId to createSession', async () => {
    vi.mocked(validateDeviceToken).mockResolvedValueOnce({
      id: 'dt_1',
      userId: 'user_1',
      deviceId: 'device_123',
      platform: 'web',
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    } as never);

    const req = makeRequest({
      deviceToken: 'valid_token',
      deviceId: 'device_123',
      userAgent: 'test-agent',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(sessionService.createSession).toHaveBeenCalledOnce();
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device_123',
        createdByService: 'device-refresh',
      })
    );
  });

  it('given device refresh for non-web platform, should pass deviceId to createSession', async () => {
    vi.mocked(validateDeviceToken).mockResolvedValueOnce({
      id: 'dt_1',
      userId: 'user_1',
      deviceId: 'device_456',
      platform: 'mobile',
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    } as never);

    const req = makeRequest({
      deviceToken: 'valid_token',
      deviceId: 'device_456',
      userAgent: 'mobile-agent',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(sessionService.createSession).toHaveBeenCalledOnce();
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device_456',
        expiresInMs: 90 * 24 * 60 * 60 * 1000,
        createdByService: 'device-refresh',
      })
    );
  });

  it('given device refresh with deviceId "device_123", should create session where deviceId equals "device_123"', async () => {
    vi.mocked(validateDeviceToken).mockResolvedValueOnce({
      id: 'dt_1',
      userId: 'user_1',
      deviceId: 'device_123',
      platform: 'web',
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    } as never);

    const req = makeRequest({
      deviceToken: 'valid_token',
      deviceId: 'device_123',
    });

    await POST(req);

    const callArgs = vi.mocked(sessionService.createSession).mock.calls[0][0];
    expect(callArgs.deviceId).toBe('device_123');
  });
});
