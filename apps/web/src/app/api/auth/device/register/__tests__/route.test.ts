import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: { error?: unknown }) => 'error' in result),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  createWebDeviceToken: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    REFRESH: { maxAttempts: 10, windowMs: 300000 },
  },
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn(),
  },
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, createWebDeviceToken } from '@/lib/auth';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { authRepository } from '@/lib/repositories/auth-repository';

function createRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/auth/device/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/device/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'user-123',
      type: 'session' as const,
      tokenVersion: 0,
      adminRoleVersion: 0,
      scopes: ['*'],
      sessionId: 'session-123',
      expiresAt: new Date(Date.now() + 86400000),
    } as never);

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      retryAfter: undefined,
      attemptsRemaining: 9,
    });

    vi.mocked(authRepository.findUserById).mockResolvedValue({
      id: 'user-123',
      tokenVersion: 0,
    } as never);

    vi.mocked(createWebDeviceToken).mockResolvedValue('ps_dev_mock_device_token');
  });

  it('returns 200 with deviceToken on success', async () => {
    const response = await POST(createRequest({ deviceId: 'device-abc', deviceName: 'Chrome' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deviceToken).toBe('ps_dev_mock_device_token');
  });

  it('returns 401 when unauthenticated', async () => {
    const errorResponse = Response.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: errorResponse as never });

    const response = await POST(createRequest({ deviceId: 'device-abc' }));

    expect(response.status).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    const response = await POST(createRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid request');
  });

  it('returns 400 when deviceId exceeds max length', async () => {
    const longId = 'a'.repeat(129);
    const response = await POST(createRequest({ deviceId: longId }));

    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: false,
      retryAfter: 300,
      attemptsRemaining: 0,
    });

    const response = await POST(createRequest({ deviceId: 'device-abc' }));

    expect(response.status).toBe(429);
  });

  it('returns 404 when user not found', async () => {
    vi.mocked(authRepository.findUserById).mockResolvedValue(undefined as never);

    const response = await POST(createRequest({ deviceId: 'device-abc' }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('calls createWebDeviceToken with correct params', async () => {
    await POST(createRequest({ deviceId: 'device-abc', deviceName: 'Firefox' }));

    expect(createWebDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        deviceId: 'device-abc',
        tokenVersion: 0,
      }),
    );
  });
});
