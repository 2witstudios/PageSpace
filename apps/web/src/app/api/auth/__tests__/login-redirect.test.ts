import { describe, expect, test, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../login/route';

vi.mock('@pagespace/db', () => ({
  users: { id: 'id', email: 'email' },
  refreshTokens: { id: 'id' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(),
  },
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  generateAccessToken: vi.fn(),
  generateRefreshToken: vi.fn(),
  getRefreshTokenMaxAge: vi.fn(),
  checkRateLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: {
    LOGIN: {},
  },
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

vi.mock('cookie', () => ({
  serialize: vi.fn(() => 'mock-cookie'),
  parse: vi.fn(() => ({ login_csrf: 'valid-csrf-token' })),
}));

// Mock login CSRF validation
vi.mock('../login-csrf/route', () => ({
  validateLoginCSRFToken: vi.fn(() => true),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

import { db, refreshTokens } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import {
  checkRateLimit,
  decodeToken,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
} from '@pagespace/lib/server';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/login redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (checkRateLimit as Mock).mockReturnValue({ allowed: true });
    (bcrypt.compare as Mock).mockResolvedValue(true);
    (generateAccessToken as Mock).mockResolvedValue('access-token');
    (generateRefreshToken as Mock).mockResolvedValue('refresh-token');
    (decodeToken as Mock).mockResolvedValue({
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    (getRefreshTokenMaxAge as Mock).mockReturnValue(60);
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue({
      driveId: 'drive-123',
    });

    (db.query.users.findFirst as Mock).mockResolvedValue({
      id: 'user-123',
      name: 'Test User',
      email: 'test@example.com',
      password: 'hashed-password',
      tokenVersion: 0,
      role: 'user',
    });

    (db.insert as Mock).mockImplementation((table: unknown) => {
      if (table === refreshTokens) {
        return {
          values: vi.fn(() => Promise.resolve(undefined)),
        };
      }

      return {
        values: vi.fn(() => Promise.resolve(undefined)),
      };
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
