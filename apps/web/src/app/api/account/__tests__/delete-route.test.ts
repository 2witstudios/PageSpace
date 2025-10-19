import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DELETE } from '../route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
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
    select: vi.fn(),
    delete: vi.fn(),
  },
  users: {},
  drives: {},
  driveMembers: {},
  eq: vi.fn((field, value) => ({ field, value, type: 'eq' })),
  sql: vi.fn((strings, ...values) => ({ strings, values, type: 'sql' })),
}));

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

describe('DELETE /api/account', () => {
  const mockUserId = 'user_123';
  const mockUserEmail = 'test@example.com';
  const mockDriveId1 = 'drive_solo';
  const mockDriveId2 = 'drive_multi';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: mockUserId,
      tokenVersion: 0,
    });
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default user
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      email: mockUserEmail,
      image: null,
    });

    // Setup default: no drives
    vi.mocked(db.query.drives.findMany).mockResolvedValue([]);

    // Setup default database operations
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      }),
    });
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
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
    vi.mocked(db.query.users.findFirst).mockResolvedValue(null);

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
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

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
      { id: mockDriveId1, name: 'Solo Drive' },
    ]);

    // Mock member count query to return 1 (solo)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      }),
    });

    const deleteMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({
      where: deleteMock,
    });

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
      { id: mockDriveId2, name: 'Team Drive' },
    ]);

    // Mock member count query to return 3 (multi-member)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 3 }]),
      }),
    });

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
    vi.mocked(verifyServiceToken).mockResolvedValue({
      service: 'web',
      scopes: ['avatars:write'],
      userId: mockUserId,
      tenantId: mockUserId,
      iat: Date.now(),
      exp: Date.now() + 120000,
    });

    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      email: mockUserEmail,
      image: '/avatars/user_123.jpg', // Local file
    });

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
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      email: mockUserEmail,
      image: 'https://example.com/avatar.jpg', // External URL
    });

    global.fetch = vi.fn();

    const request = new Request('https://example.com/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ emailConfirmation: mockUserEmail }),
    });

    await DELETE(request);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should continue deletion if avatar deletion fails', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      email: mockUserEmail,
      image: '/avatars/user_123.jpg',
    });

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
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({
      where: deleteMock,
    });

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
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockRejectedValue(new Error('Database connection lost')),
    });

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
      { id: 'drive_1', name: 'Solo 1' },
      { id: 'drive_2', name: 'Solo 2' },
      { id: 'drive_3', name: 'Solo 3' },
    ]);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      }),
    });

    const deleteMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({
      where: deleteMock,
    });

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
