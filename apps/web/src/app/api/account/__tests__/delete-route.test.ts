import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import type { ServiceTokenClaims } from '@pagespace/lib/auth-utils';

// Mock dependencies - use inline mock factory to avoid hoisting issues
vi.mock('@pagespace/db', () => {
  const whereMock = vi.fn().mockResolvedValue([{ count: 0 }]);
  const innerJoinMock = vi.fn().mockReturnValue({ where: whereMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock, innerJoin: innerJoinMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockReturnValue({ where: deleteWhereMock });

  return {
    db: {
      query: {
        users: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
        drives: {
          findMany: vi.fn(),
        },
      },
      select: selectMock,
      delete: deleteMock,
    },
    users: {},
    drives: {},
    driveMembers: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values, type: 'sql' })),
  };
});

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/auth-utils', () => ({
  createServiceToken: vi.fn(),
  verifyServiceToken: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createServiceToken, verifyServiceToken } from '@pagespace/lib/auth-utils';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock user matching the actual schema
const mockUser = (overrides: { id: string; email: string; image?: string | null }) => ({
  id: overrides.id,
  name: 'Test User',
  email: overrides.email,
  emailVerified: null as Date | null,
  image: overrides.image ?? null,
  password: null as string | null,
  googleId: null as string | null,
  provider: 'email' as const,
  role: 'user' as const,
  tokenVersion: 0,
  currentAiProvider: 'pagespace',
  currentAiModel: 'glm-4.5-air',
  storageUsedBytes: 0,
  activeUploads: 0,
  lastStorageCalculated: null as Date | null,
  stripeCustomerId: null as string | null,
  subscriptionTier: 'free',
  tosAcceptedAt: null as Date | null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Helper to create mock drive
const mockDrive = (overrides: { id: string; name: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.id,
  ownerId: 'user_123',
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
});

// Helper to create mock ServiceTokenClaims
const mockServiceClaims = (userId: string): ServiceTokenClaims => ({
  sub: userId,
  service: 'web',
  scopes: ['avatars:write'],
  userId,
  tenantId: userId,
  tokenType: 'service',
  jti: 'mock-jti',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 120,
});

describe('DELETE /api/account', () => {
  const mockUserId = 'user_123';
  const mockUserEmail = 'test@example.com';
  const mockDriveId1 = 'drive_solo';
  const mockDriveId2 = 'drive_multi';

  // Helper to setup select mock with specific count
  const setupSelectMock = (count: number) => {
    const whereMock = vi.fn().mockResolvedValue([{ count }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup delete mock with tracking
  const setupDeleteMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: whereMock } as unknown as ReturnType<typeof db.delete>);
    return whereMock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      mockWebAuth(mockUserId)
    );
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default user
    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      mockUser({ id: mockUserId, email: mockUserEmail })
    );

    // Setup default: no drives
    vi.mocked(db.query.drives.findMany).mockResolvedValue([]);

    // Setup default database operations
    setupSelectMock(0);
    setupDeleteMock();
  });

  it('should reject when email confirmation does not match', async () => {
    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: 'wrong@example.com' }),
    });

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Email confirmation does not match your account email');
  });

  it('should reject when email confirmation is empty', async () => {
    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: '' }),
    });

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Email confirmation does not match your account email');
  });

  it('should accept email confirmation with different case', async () => {
    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: 'TEST@EXAMPLE.COM' }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(200);
  });

  it('should return 404 when user not found', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      mockAuthError(401)
    );

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(401);
  });

  it('should auto-delete solo drives before account deletion', async () => {
    // Setup: user owns one solo drive (1 member)
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: mockDriveId1, name: 'Solo Drive' }),
    ]);

    // Mock member count query to return 1 (solo)
    setupSelectMock(1);

    const deleteMock = setupDeleteMock();

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledTimes(2); // Once for drive, once for user
    expect(loggers.auth.info).toHaveBeenCalledWith(
      expect.stringContaining('Auto-deleted 1 solo drives')
    );
  });

  it('should block deletion when multi-member drives exist', async () => {
    // Setup: user owns one multi-member drive (3 members)
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: mockDriveId2, name: 'Team Drive' }),
    ]);

    // Mock member count query to return 3 (multi-member)
    setupSelectMock(3);

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('must transfer ownership or delete');
    expect(body.multiMemberDrives).toContain('Team Drive');
  });

  it('should delete user avatar via processor service', async () => {
    const mockToken = 'mock-service-token';
    vi.mocked(createServiceToken).mockResolvedValue(mockToken);
    vi.mocked(verifyServiceToken).mockResolvedValue(mockServiceClaims(mockUserId));

    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      mockUser({ id: mockUserId, email: mockUserEmail, image: '/avatars/user_123.jpg' })
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    await DELETE(request);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/avatar/'),
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: `Bearer ${mockToken}`,
        }),
      })
    );
  });

  it('should not delete avatar for external URLs', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      mockUser({ id: mockUserId, email: mockUserEmail, image: 'https://example.com/avatar.jpg' })
    );

    global.fetch = vi.fn();

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    await DELETE(request);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should continue deletion if avatar deletion fails', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      mockUser({ id: mockUserId, email: mockUserEmail, image: '/avatars/user_123.jpg' })
    );

    vi.mocked(createServiceToken).mockRejectedValue(new Error('Token creation failed'));

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);

    // Should still succeed despite avatar deletion failure
    expect(response.status).toBe(200);
    expect(loggers.auth.error).toHaveBeenCalledWith(
      expect.stringContaining('avatar'),
      expect.any(Error)
    );
  });

  it('should delete user from database', async () => {
    const deleteMock = setupDeleteMock();

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(200);
    expect(deleteMock).toHaveBeenCalled();
    expect(loggers.auth.info).toHaveBeenCalledWith(
      expect.stringContaining('User account deleted')
    );
  });

  it('should handle database errors gracefully', async () => {
    const whereMock = vi.fn().mockRejectedValue(new Error('Database connection lost'));
    vi.mocked(db.delete).mockReturnValue({ where: whereMock } as unknown as ReturnType<typeof db.delete>);

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to delete account');
    expect(loggers.auth.error).toHaveBeenCalled();
  });

  it('should handle multiple solo drives correctly', async () => {
    // Setup: user owns 3 solo drives
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: 'drive_1', name: 'Solo 1' }),
      mockDrive({ id: 'drive_2', name: 'Solo 2' }),
      mockDrive({ id: 'drive_3', name: 'Solo 3' }),
    ]);

    setupSelectMock(1);
    const deleteMock = setupDeleteMock();

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledTimes(4); // 3 drives + 1 user
    expect(loggers.auth.info).toHaveBeenCalledWith(
      expect.stringContaining('Auto-deleted 3 solo drives')
    );
  });

  it('should trim and lowercase email confirmation', async () => {
    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: '  TEST@EXAMPLE.COM  ' }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(200);
  });
});
