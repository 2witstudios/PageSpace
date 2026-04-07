/**
 * Tests for desktop platform handling in POST /api/auth/login
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn().mockResolvedValue(true) },
}));

vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-sid',
      userId: 'user-1',
      type: 'user',
      scopes: ['*'],
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf'),
  SESSION_DURATION_MS: 604800000,
  isAccountLockedByEmail: vi.fn().mockResolvedValue({ isLocked: false }),
  recordFailedLoginAttemptByEmail: vi.fn(),
  resetFailedLoginAttempts: vi.fn().mockResolvedValue(undefined),
  createDesktopSession: vi.fn().mockResolvedValue({
    sessionToken: 'ps_sess_desktop',
    csrfToken: 'csrf-desktop',
    deviceToken: 'ps_dev_desktop',
  }),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true, attemptsRemaining: 4 }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: { LOGIN: { maxAttempts: 10, windowMs: 900000 } },
}));

vi.mock('cookie', () => ({
  parse: vi.fn().mockReturnValue({ login_csrf: 'csrf-cookie' }),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  logAuthEvent: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({ trackAuthEvent: vi.fn() }));
vi.mock('@pagespace/lib/audit', () => ({
  securityAudit: {
    logEvent: vi.fn().mockResolvedValue(undefined),
    logAuthSuccess: vi.fn().mockResolvedValue(undefined),
    logAuthFailure: vi.fn().mockResolvedValue(undefined),
    logTokenCreated: vi.fn().mockResolvedValue(undefined),
  },
  maskEmail: vi.fn((e: string) => e),
}));

vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn().mockReturnValue(true),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ created: false }),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByEmail: vi.fn().mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      password: '$2a$12$hash',
      tokenVersion: 0,
    }),
  },
}));

import { POST } from '../route';
import { createDesktopSession } from '@pagespace/lib/auth';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

const createRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-login-csrf-token': 'csrf-cookie',
      'cookie': 'login_csrf=csrf-cookie',
    },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/login - desktop platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns desktopTokens when platform is desktop', async () => {
    const response = await POST(createRequest({
      email: 'test@example.com',
      password: 'password123',
      platform: 'desktop',
      deviceId: 'dev-123',
      deviceName: 'My Mac',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.desktopTokens).toEqual({
      sessionToken: 'ps_sess_desktop',
      csrfToken: 'csrf-desktop',
      deviceToken: 'ps_dev_desktop',
    });
  });

  it('calls createDesktopSession with correct params', async () => {
    await POST(createRequest({
      email: 'test@example.com',
      password: 'password123',
      platform: 'desktop',
      deviceId: 'dev-123',
      deviceName: 'My Mac',
    }));

    expect(createDesktopSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      deviceId: 'dev-123',
      deviceName: 'My Mac',
      provider: 'password',
    }));
  });

  it('does not call createDesktopSession for web platform', async () => {
    await POST(createRequest({
      email: 'test@example.com',
      password: 'password123',
    }));

    expect(createDesktopSession).not.toHaveBeenCalled();
  });

  it('calls provisionGettingStartedDriveIfNeeded for desktop login', async () => {
    await POST(createRequest({
      email: 'test@example.com',
      password: 'password123',
      platform: 'desktop',
      deviceId: 'dev-123',
    }));

    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('user-1');
  });

  it('includes redirectTo when drive is provisioned', async () => {
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
      created: true,
      driveId: 'drive-abc',
    });

    const response = await POST(createRequest({
      email: 'test@example.com',
      password: 'password123',
      platform: 'desktop',
      deviceId: 'dev-123',
    }));
    const body = await response.json();

    expect(body.redirectTo).toBe('/dashboard/drive-abc');
  });

  it('returns 400 if desktop platform but no deviceId', async () => {
    const response = await POST(createRequest({
      email: 'test@example.com',
      password: 'password123',
      platform: 'desktop',
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('deviceId');
  });
});
