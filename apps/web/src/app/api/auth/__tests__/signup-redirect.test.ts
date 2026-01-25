/**
 * Tests for signup redirect functionality to Getting Started drive
 */

import { describe, expect, test, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../signup/route';

vi.mock('@pagespace/db', () => ({
  users: { id: 'id', email: 'email', tokenVersion: 'tokenVersion', role: 'role' },
  userAiSettings: { userId: 'userId' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(),
  },
  eq: vi.fn((field: string, value: string | number) => ({ field, value })),
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn(),
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
  createNotification: vi.fn(),
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
    SIGNUP: {
      maxAttempts: 3,
      windowMs: 3600000,
      blockDurationMs: 3600000,
      progressiveDelay: false,
    },
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/verification-utils', () => ({
  createVerificationToken: vi.fn(),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@pagespace/lib/email-templates/VerificationEmail', () => ({
  VerificationEmail: () => null,
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

vi.mock('react', () => ({
  default: {
    createElement: vi.fn().mockReturnValue({}),
  },
}));

import { db, users, userAiSettings } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { createNotification } from '@pagespace/lib/server';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/signup redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 3 });
    (bcrypt.hash as Mock).mockResolvedValue('hashed-password');

    (createVerificationToken as Mock).mockResolvedValue('verification-token');
    (createNotification as Mock).mockResolvedValue(undefined);

    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue({
      driveId: 'drive-123',
    });

    (db.query.users.findFirst as Mock).mockResolvedValue(null);

    // Match table by identity to return appropriate mock responses
    (db.insert as Mock).mockImplementation((table: unknown) => {
      if (table === users) {
        return {
          values: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                {
                  id: 'user-123',
                  name: 'Test User',
                  email: 'test@example.com',
                  tokenVersion: 0,
                  role: 'user',
                },
              ])
            ),
          })),
        };
      }

      if (table === userAiSettings) {
        return {
          values: vi.fn(() => Promise.resolve(undefined)),
        };
      }

      return {
        values: vi.fn(() => Promise.resolve(undefined)),
      };
    });
  });

  test('given successful signup, should redirect to Getting Started drive', async () => {
    const request = new Request('http://localhost/api/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Login-CSRF-Token': 'valid-csrf-token',
        'Cookie': 'login_csrf=valid-csrf-token',
      },
      body: JSON.stringify({
        name: 'Test User',
        email: 'test@example.com',
        password: 'Password123456',
        confirmPassword: 'Password123456',
        acceptedTos: true,
      }),
    });

    const response = await POST(request);

    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('user-123');
    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard/drive-123');
    expect(response.headers.get('Location')).toContain('auth=success');
  });

  test('given signup when provisioning returns null, should redirect to default dashboard', async () => {
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);

    const request = new Request('http://localhost/api/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Login-CSRF-Token': 'valid-csrf-token',
        'Cookie': 'login_csrf=valid-csrf-token',
      },
      body: JSON.stringify({
        name: 'Test User',
        email: 'test@example.com',
        password: 'Password123456',
        confirmPassword: 'Password123456',
        acceptedTos: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard');
    expect(response.headers.get('Location')).not.toContain('/dashboard/drive-');
  });

  test('given signup when provisioning throws, should still redirect to dashboard', async () => {
    (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(
      new Error('Provisioning failed')
    );

    const request = new Request('http://localhost/api/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Login-CSRF-Token': 'valid-csrf-token',
        'Cookie': 'login_csrf=valid-csrf-token',
      },
      body: JSON.stringify({
        name: 'Test User',
        email: 'test@example.com',
        password: 'Password123456',
        confirmPassword: 'Password123456',
        acceptedTos: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard');
    expect(response.headers.get('Location')).not.toContain('/dashboard/drive-');
  });
});
