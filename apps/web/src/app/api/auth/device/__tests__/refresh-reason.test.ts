import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  getTokenPrefix: vi.fn((t: string) => t.slice(0, 8)),
}));
vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_token'),
    validateSession: vi.fn().mockResolvedValue({ sessionId: 'sid_123' }),
    revokeSessionByHash: vi.fn().mockResolvedValue(undefined),
    expireSessionByHashSoon: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@pagespace/lib/auth/device-auth-utils', () => ({
  validateDeviceToken: vi.fn(),
  updateDeviceTokenActivity: vi.fn().mockResolvedValue(undefined),
  generateDeviceToken: vi.fn().mockReturnValue('new_device_token'),
}));
vi.mock('@pagespace/lib/auth/token-lifecycle-policy', () => ({
  shouldAllowDeviceRefresh: vi.fn().mockReturnValue({ ok: true }),
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('csrf_token'),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: { REFRESH: { maxAttempts: 10, windowMs: 60000 } },
}));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({ trackAuthEvent: vi.fn() }));
vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn().mockResolvedValue({ id: 'user_1', email: 'test@example.com' }),
  },
}));
vi.mock('@pagespace/db/transactions/auth-transactions', () => ({
  atomicDeviceTokenRotation: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  appendSessionCookie: vi.fn(),
  getSessionFromCookies: vi.fn(() => null),
}));

import { POST } from '../refresh/route';
import { validateDeviceToken } from '@pagespace/lib/auth/device-auth-utils';
import { shouldAllowDeviceRefresh } from '@pagespace/lib/auth/token-lifecycle-policy';
import { atomicDeviceTokenRotation } from '@pagespace/db/transactions/auth-transactions';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/auth/device/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validRecord = {
  id: 'dt_1',
  userId: 'user_1',
  deviceId: 'device_123',
  platform: 'desktop',
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
};

describe('device refresh 401 reason codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAllowDeviceRefresh).mockReturnValue({ ok: true });
  });

  it('invalid/expired device token → reason "invalid_device_token"', async () => {
    vi.mocked(validateDeviceToken).mockResolvedValueOnce(null as never);

    const res = await POST(makeRequest({ deviceToken: 'bad', deviceId: 'device_123' }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.reason).toBe('invalid_device_token');
  });

  it('unknown stored deviceId → reason "unknown_stored_device"', async () => {
    vi.mocked(validateDeviceToken).mockResolvedValueOnce(validRecord as never);
    vi.mocked(shouldAllowDeviceRefresh).mockReturnValueOnce({ ok: false, reason: 'unknown_stored_device' });

    const res = await POST(makeRequest({ deviceToken: 'valid', deviceId: 'device_123' }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.reason).toBe('unknown_stored_device');
  });

  it('device mismatch → reason "device_id_mismatch"', async () => {
    vi.mocked(validateDeviceToken).mockResolvedValueOnce(validRecord as never);
    vi.mocked(shouldAllowDeviceRefresh).mockReturnValueOnce({ ok: false, reason: 'device_mismatch' });

    const res = await POST(makeRequest({ deviceToken: 'valid', deviceId: 'other_device' }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.reason).toBe('device_id_mismatch');
  });

  it('rotation failure → reason "rotation_failed"', async () => {
    // Token within 60d of expiry so rotation is attempted, then fails.
    vi.mocked(validateDeviceToken).mockResolvedValueOnce({
      ...validRecord,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    } as never);
    vi.mocked(atomicDeviceTokenRotation).mockResolvedValueOnce({
      success: false,
      error: 'Device token already rotated',
    } as never);

    const res = await POST(makeRequest({ deviceToken: 'valid', deviceId: 'device_123' }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.reason).toBe('rotation_failed');
  });
});
