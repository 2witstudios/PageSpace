/**
 * Tests for login redirect functionality to Getting Started drive
 */

import { describe, expect, test, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../login/route';

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByEmail: vi.fn(),
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
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
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logAuthEvent: vi.fn(),
  logSecurityEvent: vi.fn(),
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

vi.mock('cookie', () => ({
  serialize: vi.fn(() => 'mock-cookie'),
  parse: vi.fn(() => ({ login_csrf: 'valid-csrf-token' })),
}));

// Mock login CSRF validation
vi.mock('@/lib/auth/login-csrf-utils', () => ({
  validateLoginCSRFToken: vi.fn(() => true),
}));

// Mock client IP extraction
vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn(() => true),
  getClientIP: vi.fn().mockReturnValue('unknown'),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

import bcrypt from 'bcryptjs';
import { authRepository } from '@/lib/repositories/auth-repository';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/login redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    (bcrypt.compare as Mock).mockResolvedValue(true);
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue({
      driveId: 'drive-123',
    });

    vi.mocked(authRepository.findUserByEmail).mockResolvedValue({
      id: 'user-123',
      name: 'Test User',
      email: 'test@example.com',
      password: '$2a$12$hashedpassword',
      tokenVersion: 0,
      adminRoleVersion: 0,
      role: 'user',
      provider: 'email',
      image: null,
      googleId: null,
      emailVerified: null,
      currentAiProvider: 'pagespace',
      currentAiModel: 'glm-4.5-air',
      storageUsedBytes: 0,
      activeUploads: 0,
      lastStorageCalculated: null,
      stripeCustomerId: null,
      subscriptionTier: 'free',
      tosAcceptedAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  test('given user has no drives, should return redirectTo Getting Started drive', async () => {
    const request = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Login-CSRF-Token': 'valid-csrf-token',
        'Cookie': 'login_csrf=valid-csrf-token',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'Password123456',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.redirectTo).toContain('/dashboard/drive-123');
  });

  test('given user already has drives, should not include redirectTo', async () => {
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);

    const request = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Login-CSRF-Token': 'valid-csrf-token',
        'Cookie': 'login_csrf=valid-csrf-token',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'Password123456',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.redirectTo).toBeUndefined();
  });

  test('given provisioning throws error, should still return 200 without redirectTo', async () => {
    (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(new Error('DB error'));

    const request = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Login-CSRF-Token': 'valid-csrf-token',
        'Cookie': 'login_csrf=valid-csrf-token',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'Password123456',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.redirectTo).toBeUndefined();
  });
});
