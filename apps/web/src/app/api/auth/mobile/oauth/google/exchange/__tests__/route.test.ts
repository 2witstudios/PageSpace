/**
 * Contract tests for the post-login pending invitation acceptance hook on
 * POST /api/auth/mobile/oauth/google/exchange.
 *
 * This route did not previously have a test file; the tests below cover the
 * Epic 3 contract (helper invocation, helper failure → revoke + 500, helper
 * success → response unchanged). Other behaviours of the route remain covered
 * via integration paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'oauth-user-1',
      type: 'user',
      scopes: ['*'],
      userRole: 'user',
      tokenVersion: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
}));

vi.mock('@pagespace/lib/auth/device-auth-utils', () => ({
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'ps_dev_mock',
    deviceTokenRecordId: 'dt-1',
    isNew: true,
  }),
}));

vi.mock('@pagespace/lib/auth/oauth-utils', () => ({
  verifyOAuthIdToken: vi.fn().mockResolvedValue({
    success: true,
    userInfo: {
      provider: 'google',
      providerId: 'google-sub-1',
      email: 'test@example.com',
      name: 'Test User',
      picture: null,
      emailVerified: true,
    },
  }),
  createOrLinkOAuthUser: vi.fn().mockResolvedValue({
    id: 'oauth-user-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    provider: 'google',
    role: 'user',
    tokenVersion: 0,
    emailVerified: new Date(),
  }),
}));

vi.mock('@pagespace/lib/auth/oauth-types', () => ({
  OAuthProvider: { GOOGLE: 'google', APPLE: 'apple' },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 5,
  }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900_000, progressiveDelay: true },
    OAUTH_VERIFY: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: false },
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/mask-email', () => ({
  maskEmail: vi.fn((email: string) => `${email.slice(0, 2)}***@${email.split('@')[1] || '***'}`),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    updateUser: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  createSessionCookie: vi.fn().mockReturnValue('ps_session=mock; Path=/'),
}));

vi.mock('@/lib/auth/google-avatar', () => ({
  resolveGoogleAvatarImage: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/auth/post-login-pending-acceptance', () => ({
  acceptUserPendingInvitations: vi.fn().mockResolvedValue([]),
}));

import { POST } from '../route';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { acceptUserPendingInvitations } from '@/lib/auth/post-login-pending-acceptance';

const validPayload = {
  idToken: 'valid-id-token',
  deviceId: 'mobile-device-1',
  platform: 'ios',
  deviceName: 'iPhone 15',
  appVersion: '1.0.0',
};

const createRequest = (body: Record<string, unknown> = validPayload) =>
  new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'PageSpace-iOS/1.0',
    },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/mobile/oauth/google/exchange — post-login pending invite acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acceptUserPendingInvitations).mockResolvedValue([]);
  });

  it('given a successful exchange, calls acceptUserPendingInvitations after createSession with the resolved userId', async () => {
    await POST(createRequest());

    expect(acceptUserPendingInvitations).toHaveBeenCalledWith('oauth-user-1');
    const acceptOrder = vi.mocked(acceptUserPendingInvitations).mock.invocationCallOrder[0];
    const sessionOrder = vi.mocked(sessionService.createSession).mock.invocationCallOrder[0];
    expect(acceptOrder).toBeGreaterThan(sessionOrder);
  });

  it('given the helper throws, revokes the just-created session and returns 500', async () => {
    vi.mocked(acceptUserPendingInvitations).mockRejectedValueOnce(new Error('db down'));

    const response = await POST(createRequest());

    expect(response.status).toBe(500);
    expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
      'oauth-user-1',
      'pending_invite_acceptance_failed'
    );
  });

  it('given the helper resolves, the original response is unchanged', async () => {
    vi.mocked(acceptUserPendingInvitations).mockResolvedValueOnce([
      { driveId: 'drive_a', driveName: 'Alpha', role: 'MEMBER' },
    ]);

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user.id).toBe('oauth-user-1');
  });
});
