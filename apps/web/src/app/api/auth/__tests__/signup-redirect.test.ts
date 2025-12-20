import { describe, expect, test, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../signup/route';

vi.mock('@pagespace/db', () => ({
  users: { id: 'id', email: 'email', tokenVersion: 'tokenVersion', role: 'role' },
  userAiSettings: { userId: 'userId' },
  refreshTokens: { id: 'id' },
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

vi.mock('@pagespace/lib/server', () => ({
  generateAccessToken: vi.fn(),
  generateRefreshToken: vi.fn(),
  getRefreshTokenMaxAge: vi.fn(),
  checkRateLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: {
    SIGNUP: {},
  },
  createNotification: vi.fn(),
  decodeToken: vi.fn(),
  validateOrCreateDeviceToken: vi.fn(),
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logAuthEvent: vi.fn(),
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

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

import { db, users, userAiSettings, refreshTokens } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import {
  checkRateLimit,
  createNotification,
  decodeToken,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
} from '@pagespace/lib/server';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/signup redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (checkRateLimit as Mock).mockReturnValue({ allowed: true });
    (bcrypt.hash as Mock).mockResolvedValue('hashed-password');
    (generateAccessToken as Mock).mockResolvedValue('access-token');
    (generateRefreshToken as Mock).mockResolvedValue('refresh-token');
    (decodeToken as Mock).mockResolvedValue({
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    (getRefreshTokenMaxAge as Mock).mockReturnValue(60);

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

      if (table === userAiSettings || table === refreshTokens) {
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
    // Arrange
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

    // Act
    const response = await POST(request);

    // Assert
    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('user-123');
    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard/drive-123');
    expect(response.headers.get('Location')).toContain('auth=success');
  });

  test('given signup when provisioning returns null, should redirect to default dashboard', async () => {
    // Arrange
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

    // Act
    const response = await POST(request);

    // Assert
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard');
    expect(response.headers.get('Location')).not.toContain('/dashboard/drive-');
  });

  test('given signup when provisioning throws, should still redirect to dashboard', async () => {
    // Arrange
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

    // Act
    const response = await POST(request);

    // Assert
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard');
    expect(response.headers.get('Location')).not.toContain('/dashboard/drive-');
  });
});
