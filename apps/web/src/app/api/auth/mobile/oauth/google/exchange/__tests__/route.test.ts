/**
 * Contract tests for POST /api/auth/mobile/oauth/google/exchange
 *
 * Focused on the Home-drive provisioning obligation: every signup/login path
 * must call provisionHomeDriveIfNeeded, and a provisioning failure must never
 * fail the authentication itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/oauth-utils', () => ({
  verifyOAuthIdToken: vi.fn(),
  createOrLinkOAuthUser: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
}));

vi.mock('@pagespace/lib/auth/device-auth-utils', () => ({
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({ deviceToken: 'mock-device-token' }),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    updateUser: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000 },
    OAUTH_VERIFY: { maxAttempts: 10, windowMs: 300000 },
  },
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    }),
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/security/client-ip', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  createSessionCookie: vi.fn().mockReturnValue('session=mock'),
}));

vi.mock('@/lib/auth/google-avatar', () => ({
  resolveGoogleAvatarImage: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/onboarding/home-drive', () => ({
  provisionHomeDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'home-drive-1', created: true }),
}));

import { POST } from '../route';
import { verifyOAuthIdToken, createOrLinkOAuthUser } from '@pagespace/lib/auth/oauth-utils';
import { provisionHomeDriveIfNeeded } from '@/lib/onboarding/home-drive';

const mockUser = {
  id: 'user-123',
  email: 'mobile@example.com',
  name: 'Mobile User',
  image: null,
  provider: 'google',
  role: 'user',
  emailVerified: new Date(),
  tokenVersion: 0,
};

function makeRequest() {
  return new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      idToken: 'valid-google-id-token',
      deviceId: 'device-abc',
      platform: 'ios',
    }),
  });
}

describe('POST /api/auth/mobile/oauth/google/exchange — Home drive provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyOAuthIdToken).mockResolvedValue({
      success: true,
      userInfo: {
        providerId: 'google-sub-1',
        email: 'mobile@example.com',
        emailVerified: true,
        name: 'Mobile User',
        picture: undefined,
        provider: 'google' as never,
      },
    } as never);
    vi.mocked(createOrLinkOAuthUser).mockResolvedValue({ status: 'linked', user: mockUser } as never);
    vi.mocked(provisionHomeDriveIfNeeded).mockResolvedValue({ driveId: 'home-drive-1', created: true });
  });

  it('provisions a Home drive for the authenticated user', async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(provisionHomeDriveIfNeeded).toHaveBeenCalledWith(mockUser.id);
  });

  it('still returns 200 when provisioning fails (lazy retry on next login)', async () => {
    vi.mocked(provisionHomeDriveIfNeeded).mockRejectedValueOnce(new Error('db down'));

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionToken).toBe('ps_sess_mock_token');
  });

  it('does not provision when token verification fails', async () => {
    vi.mocked(verifyOAuthIdToken).mockResolvedValue({ success: false, error: 'bad token' } as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(provisionHomeDriveIfNeeded).not.toHaveBeenCalled();
  });

  it('does not provision when the account link is rejected (unverified email collision)', async () => {
    vi.mocked(createOrLinkOAuthUser).mockResolvedValue({ status: 'rejected', reason: 'unverified_email_conflict' } as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
    expect(provisionHomeDriveIfNeeded).not.toHaveBeenCalled();
  });
});
