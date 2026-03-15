import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock at the service seam level
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(),
  },
  users: { id: 'id', password: 'password', tokenVersion: 'tokenVersion' },
  deviceTokens: { userId: 'userId', revokedAt: 'revokedAt' },
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((a) => ({ isNull: a })),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  BCRYPT_COST: 12,
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ userId: 'user-1', email: 'test@example.com' }),
  logUserActivity: vi.fn(),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import bcrypt from 'bcryptjs';

// Test helpers
const mockSessionAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockDbUpdateChain = () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.update = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.update).mockImplementation(chain.update as never);
  return chain;
};

describe('POST /api/account/password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1', 5));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));

      expect(response.status).toBe(401);
    });

    it('calls authenticateRequestWithOptions with session-only and CSRF', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        password: '$2a$12$hash',
        tokenVersion: 5,
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(bcrypt.hash).mockResolvedValue('$2a$12$newhash' as never);
      mockDbUpdateChain();

      const request = createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('input validation', () => {
    it('returns 400 when currentPassword is missing', async () => {
      const response = await POST(createRequest({
        newPassword: 'newPassword1234',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Current and new password are required');
    });

    it('returns 400 when newPassword is missing', async () => {
      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Current and new password are required');
    });

    it('returns 400 when both passwords are missing', async () => {
      const response = await POST(createRequest({}));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Current and new password are required');
    });

    it('returns 400 when newPassword is shorter than 12 characters', async () => {
      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'short',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Password must be at least 12 characters long');
    });
  });

  describe('user verification', () => {
    it('returns 401 when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid token version');
    });

    it('returns 401 when tokenVersion does not match', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        password: '$2a$12$hash',
        tokenVersion: 99,
      });

      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid token version');
    });

    it('returns 400 when user has no password set', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        password: null,
        tokenVersion: 5,
      });

      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('User does not have a password set');
    });
  });

  describe('password verification', () => {
    it('returns 400 when current password is incorrect', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        password: '$2a$12$hash',
        tokenVersion: 5,
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const response = await POST(createRequest({
        currentPassword: 'wrongPassword1',
        newPassword: 'newPassword1234',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Current password is incorrect');
    });
  });

  describe('successful password change', () => {
    beforeEach(() => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        password: '$2a$12$oldhash',
        tokenVersion: 5,
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(bcrypt.hash).mockResolvedValue('$2a$12$newhash' as never);
      mockDbUpdateChain();
    });

    it('returns success message', async () => {
      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Password changed successfully. Please log in again with your new password.');
    });

    it('hashes the new password with BCRYPT_COST', async () => {
      await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));

      expect(bcrypt.hash).toHaveBeenCalledWith('newPassword1234', 12);
    });

    it('updates password and increments tokenVersion', async () => {
      const chain = mockDbUpdateChain();

      await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));

      // First call updates users, second revokes device tokens
      expect(chain.update).toHaveBeenCalledTimes(2);
      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          password: '$2a$12$newhash',
          tokenVersion: 6,
        })
      );
    });

    it('revokes all active device tokens', async () => {
      const frozenDate = new Date('2025-01-15T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(frozenDate);

      try {
        const chain = mockDbUpdateChain();

        await POST(createRequest({
          currentPassword: 'oldPassword123',
          newPassword: 'newPassword1234',
        }));

        // Second db.update call should revoke device tokens
        expect(chain.set).toHaveBeenCalledWith({
          revokedAt: frozenDate,
          revokedReason: 'token_version_bump_password_change',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      vi.mocked(db.query.users.findFirst).mockRejectedValueOnce(new Error('DB error'));

      const response = await POST(createRequest({
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword1234',
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to change password');
    });
  });
});
