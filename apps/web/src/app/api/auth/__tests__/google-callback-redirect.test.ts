/**
 * Tests for Google OAuth callback redirect to Getting Started drive
 */

import { describe, expect, test, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { GET } from '../google/callback/route';

function createSignedState(data: Record<string, unknown>): string {
  const withTimestamp = { timestamp: Date.now(), ...data };
  const payload = JSON.stringify(withTimestamp);
  const sig = crypto.createHmac('sha256', 'test-oauth-state-secret').update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ data: withTimestamp, sig })).toString('base64');
}
const defaultState = createSignedState({ returnUrl: '/dashboard', platform: 'web' });

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({
      tokens: {
        id_token: 'mock-id-token',
      },
    }),
    verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-id',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
        email_verified: true,
      }),
    }),
  })),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByGoogleIdOrEmail: vi.fn(),
    findUserById: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
  },
}));

// Mock session service from @pagespace/lib/auth
vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  createExchangeCode: vi.fn().mockResolvedValue('mock-exchange-code'),
  consumePKCEVerifier: vi.fn().mockResolvedValue(null),
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
  createDeviceTokenHandoffCookie: vi.fn().mockReturnValue('ps_device_token=mock; Path=/; Max-Age=60'),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    security: {
      warn: vi.fn(),
    },
  },
  auditRequest: vi.fn(),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'mock-device-token',
    deviceTokenRecordId: 'device-record-id',
  }),
  maskEmail: (email: string) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  },
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: {
      maxAttempts: 5,
      windowMs: 900000,
      blockDurationMs: 900000,
      progressiveDelay: true,
    },
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

vi.mock('@/lib/auth/google-avatar', () => ({
  resolveGoogleAvatarImage: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    getClientIP: vi.fn(() => '127.0.0.1'),
    revokeSessionsForLogin: vi.fn().mockResolvedValue(0),
    createWebDeviceToken: vi.fn().mockResolvedValue('ps_dev_mock_token'),
    isSafeReturnUrl: actual.isSafeReturnUrl,
  };
});

import { authRepository } from '@/lib/repositories/auth-repository';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/google/callback redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret';

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
      driveId: 'drive-123',
      created: true,
    });

    vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(null);
    vi.mocked(authRepository.findUserById).mockResolvedValue(null);
    vi.mocked(authRepository.createUser).mockResolvedValue({
      id: 'user-123',
      name: 'Test User',
      email: 'test@example.com',
      googleId: 'google-id',
      tokenVersion: 0,
      role: 'user',
    } as never);
    vi.mocked(authRepository.updateUser).mockResolvedValue(undefined);
  });

  test('given new user, should redirect to Getting Started drive', async () => {
    const request = new Request(
      `http://localhost/api/auth/google/callback?code=valid-code&state=${encodeURIComponent(defaultState)}`,
      { method: 'GET' }
    );

    const response = await GET(request);

    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('user-123');
    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toContain('/dashboard/drive-123');
    expect(response.headers.get('Location')).toContain('auth=success');
  });

  test('given existing user with drives, should redirect to default dashboard', async () => {
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
      driveId: 'existing-drive',
      created: false,
    });
    vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue({
      id: 'user-123',
      name: 'Existing User',
      email: 'test@example.com',
      googleId: 'google-id',
      tokenVersion: 0,
      role: 'user',
    } as never);

    const request = new Request(
      `http://localhost/api/auth/google/callback?code=valid-code&state=${encodeURIComponent(defaultState)}`,
      { method: 'GET' }
    );

    const response = await GET(request);

    expect(response.headers.get('Location')).toContain('/dashboard');
    expect(response.headers.get('Location')).not.toContain('/dashboard/drive-');
  });

  test('given provisioning throws error, should still redirect successfully', async () => {
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(new Error('DB error'));

    const request = new Request(
      `http://localhost/api/auth/google/callback?code=valid-code&state=${encodeURIComponent(defaultState)}`,
      { method: 'GET' }
    );

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toContain('/dashboard');
  });
});
