import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock at the service seam level
vi.mock('@pagespace/db', () => ({
  users: { id: 'id', email: 'email' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(),
  },
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
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
  accountRepository: {
    findById: vi.fn(),
    getOwnedDrives: vi.fn(),
    getDriveMemberCount: vi.fn(),
    deleteDrive: vi.fn(),
    deleteUser: vi.fn(),
  },
  activityLogRepository: {
    anonymizeForUser: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  createUserServiceToken: vi.fn(),
  deleteAiUsageLogsForUser: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/anonymize', () => ({
  createAnonymizedActorEmail: vi.fn(() => 'deleted_user_abc123'),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
  logUserActivity: vi.fn(),
}));

import { GET, PATCH } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('GET /api/account', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('should return 401 when not authenticated', async () => {
    // Arrange
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/account', { method: 'GET' });

    // Act
    const response = await GET(request);

    // Assert
    expect(response.status).toBe(401);
  });

  it('should return 401 when user not found', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);

    const request = new Request('https://example.com/api/account', { method: 'GET' });

    // Act
    const response = await GET(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(401);
    expect(body.error).toBe('Invalid token version');
  });

  it('should return 401 when token version does not match', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      name: 'Test User',
      email: 'test@example.com',
      image: null,
      password: 'hashed-password',
      tokenVersion: 999,
    } as never);

    const request = new Request('https://example.com/api/account', { method: 'GET' });

    // Act
    const response = await GET(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(401);
    expect(body.error).toBe('Invalid token version');
  });

  it('should return user profile when authenticated and valid', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      name: 'Test User',
      email: 'test@example.com',
      image: '/avatars/user.jpg',
      password: 'hashed-password',
      tokenVersion: 0,
    } as never);

    const request = new Request('https://example.com/api/account', { method: 'GET' });

    // Act
    const response = await GET(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: mockUserId,
      name: 'Test User',
      email: 'test@example.com',
      image: '/avatars/user.jpg',
      hasPassword: true,
    });
  });

  it('should return hasPassword false when user has no password', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      name: 'Test User',
      email: 'test@example.com',
      image: null,
      password: null,
      tokenVersion: 0,
    } as never);

    const request = new Request('https://example.com/api/account', { method: 'GET' });

    // Act
    const response = await GET(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body.hasPassword).toBe(false);
  });
});

describe('PATCH /api/account', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('should return 401 when not authenticated', async () => {
    // Arrange
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Test', email: 'test@example.com' }),
    });

    // Act
    const response = await PATCH(request);

    // Assert
    expect(response.status).toBe(401);
  });

  it('should return 400 when name is missing', async () => {
    // Arrange
    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ email: 'test@example.com' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(400);
    expect(body.error).toBe('Name and email are required');
  });

  it('should return 400 when email is missing', async () => {
    // Arrange
    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Test User' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(400);
    expect(body.error).toBe('Name and email are required');
  });

  it('should return 400 when email format is invalid', async () => {
    // Arrange
    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Test User', email: 'not-an-email' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid email format');
  });

  it('should return 400 when email is already in use by another user', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: 'different_user',
      email: 'taken@example.com',
    } as never);

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Test User', email: 'taken@example.com' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(400);
    expect(body.error).toBe('Email is already in use');
  });

  it('should allow updating when email belongs to the current user', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      email: 'test@example.com',
    } as never);

    const returningMock = vi.fn().mockResolvedValue([{
      id: mockUserId,
      name: 'Updated Name',
      email: 'test@example.com',
      image: null,
    }]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated Name', email: 'test@example.com' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body.name).toBe('Updated Name');
  });

  it('should return 500 when update returns no result', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue(null as never);

    const returningMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Test User', email: 'new@example.com' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to update user');
  });

  it('should return 200 with updated user on success', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue(null as never);

    const updatedUser = {
      id: mockUserId,
      name: 'Updated Name',
      email: 'updated@example.com',
      image: '/avatar.jpg',
    };
    const returningMock = vi.fn().mockResolvedValue([updatedUser]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated Name', email: 'updated@example.com' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: mockUserId,
      name: 'Updated Name',
      email: 'updated@example.com',
      image: '/avatar.jpg',
    });
  });

  it('should return 500 when database throws', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockRejectedValueOnce(new Error('DB error'));

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Test', email: 'test@example.com' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to update profile');
    expect(loggers.auth.error).toHaveBeenCalledWith(
      expect.stringContaining('Profile update error'),
      expect.objectContaining({ message: 'DB error' })
    );
  });
});
