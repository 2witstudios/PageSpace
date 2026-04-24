import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock at the service seam level
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email' },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/repositories/account-repository', () => ({
  accountRepository: {
    findById: vi.fn(),
    getOwnedDrives: vi.fn(),
    getDriveMemberCount: vi.fn(),
    deleteDrive: vi.fn(),
    deleteUser: vi.fn(),
  },
}));
vi.mock('@pagespace/lib/repositories/activity-log-repository', () => ({
  activityLogRepository: {
    anonymizeForUser: vi.fn(),
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/validators/email', () => {
  const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return {
    isValidEmail: (email: string) => {
      if (!email || email.length > 254) return false;
      if (!EMAIL_PATTERN.test(email)) return false;
      return email.slice(email.lastIndexOf('@') + 1).includes('.');
    },
  };
});
vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createUserServiceToken: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/ai-usage-purge', () => ({
  deleteAiUsageLogsForUser: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/monitoring-purge', () => ({
  deleteMonitoringDataForUser: vi.fn(),
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
import { db } from '@pagespace/db/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
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
    });
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

  it('should return 400 when both name and email are missing', async () => {
    // Arrange
    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(400);
    expect(body.error).toBe('At least one of name or email is required');
  });

  it('should accept a partial PATCH with only name and not overwrite email', async () => {
    // Arrange
    const updatedUser = {
      id: mockUserId,
      name: 'Updated Name',
      email: 'existing@example.com',
      image: null,
    };
    const returningMock = vi.fn().mockResolvedValue([updatedUser]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated Name' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body.name).toBe('Updated Name');
    expect(setMock).toHaveBeenCalledWith({ name: 'Updated Name' });
  });

  it('should accept a partial PATCH with only email and not overwrite name', async () => {
    // Arrange
    vi.mocked(db.query.users.findFirst).mockResolvedValue(null as never);

    const updatedUser = {
      id: mockUserId,
      name: 'Existing Name',
      email: 'new@example.com',
      image: null,
    };
    const returningMock = vi.fn().mockResolvedValue([updatedUser]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    const request = new Request('https://example.com/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ email: 'new@example.com' }),
    });

    // Act
    const response = await PATCH(request);
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body.email).toBe('new@example.com');
    expect(setMock).toHaveBeenCalledWith({ email: 'new@example.com' });
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
    const errorCallArgs = vi.mocked(loggers.auth.error).mock.calls[0];
    expect(errorCallArgs[0]).toContain('Profile update error');
    expect(errorCallArgs[1]).toBeInstanceOf(Error);
    expect((errorCallArgs[1] as Error).message).toBe('DB error');
  });
});
