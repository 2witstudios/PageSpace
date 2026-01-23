import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: {
        findFirst: vi.fn(),
      },
      driveMembers: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(),
    delete: vi.fn(),
  },
  drives: {},
  driveMembers: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
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

// Mock activity logger (boundary)
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
  logDriveActivity: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock drive
const mockDrive = (overrides: { id: string; name: string; ownerId?: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.id,
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
});

// Helper to create mock drive member
const mockDriveMember = (overrides: {
  id: string;
  userId: string;
  driveId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}) => ({
  id: overrides.id,
  userId: overrides.userId,
  driveId: overrides.driveId,
  role: overrides.role,
  customRoleId: null,
  invitedBy: null,
  invitedAt: new Date(),
  acceptedAt: new Date(),
  lastAccessedAt: null,
});

describe('POST /api/account/handle-drive', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockNewOwnerId = 'admin_456';

  // Helper to setup update mock
  const setupUpdateMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return whereMock;
  };

  // Helper to setup delete mock
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

    // Setup default drive owned by user
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(
      mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })
    );

    // Setup default admin membership
    vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(
      mockDriveMember({
        id: 'membership_1',
        userId: mockNewOwnerId,
        driveId: mockDriveId,
        role: 'ADMIN',
      })
    );

    // Setup default database operations
    setupUpdateMock();
    setupDeleteMock();

    // Setup default actor info for activity logging
    vi.mocked(getActorInfo).mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
  });

  describe('validation', () => {
    it('should reject request without driveId', async () => {
      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Drive ID and action are required');
    });

    it('should reject request without action', async () => {
      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ driveId: mockDriveId }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Drive ID and action are required');
    });

    it('should reject invalid action', async () => {
      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ driveId: mockDriveId, action: 'archive' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid action. Must be "delete" or "transfer"');
    });

    it('should reject transfer without newOwnerId', async () => {
      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ driveId: mockDriveId, action: 'transfer' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('New owner ID is required for transfer action');
    });
  });

  describe('authentication and authorization', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
        mockAuthError(401)
      );

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ driveId: mockDriveId, action: 'delete' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ driveId: mockDriveId, action: 'delete' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not drive owner', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: 'different_user' })
      );

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ driveId: mockDriveId, action: 'delete' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You are not the owner of this drive');
    });
  });

  describe('transfer action', () => {
    it('should successfully transfer ownership to admin', async () => {
      const updateMock = setupUpdateMock();

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.action).toBe('transfer');
      expect(body.message).toContain('transferred successfully');
      expect(updateMock).toHaveBeenCalled();
      expect(loggers.auth.info).toHaveBeenCalledWith(
        expect.stringContaining('Drive ownership transferred')
      );
    });

    it('should reject transfer when new owner is not an admin', async () => {
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('The new owner must be an admin of the drive');
    });

    it('should reject transfer when new owner is not admin role', async () => {
      // NOTE: The production code uses WHERE clause with role='ADMIN'.
      // Mocks don't evaluate WHERE clauses, so we return undefined to simulate
      // what the database returns when no matching ADMIN record is found.
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('The new owner must be an admin of the drive');
    });

    it('should reject transfer when new owner is in different drive', async () => {
      // NOTE: The production code uses WHERE clause with driveId filter.
      // Mocks don't evaluate WHERE clauses, so we return undefined to simulate
      // what the database returns when no matching record is found for this drive.
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      const response = await POST(request);

      // The query filters by driveId, so this should return null
      expect(response.status).toBe(400);
    });
  });

  describe('delete action', () => {
    it('should successfully delete drive', async () => {
      const deleteMock = setupDeleteMock();

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'delete',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.action).toBe('delete');
      expect(body.message).toContain('deleted successfully');
      expect(deleteMock).toHaveBeenCalled();
      expect(loggers.auth.info).toHaveBeenCalledWith(
        expect.stringContaining('Drive deleted during account deletion preparation')
      );
    });

    it('should not require newOwnerId for delete action', async () => {
      const deleteMock = setupDeleteMock();

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'delete',
          // No newOwnerId
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(deleteMock).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      const whereMock = vi.fn().mockRejectedValue(new Error('Database connection lost'));
      vi.mocked(db.delete).mockReturnValue({ where: whereMock } as unknown as ReturnType<typeof db.delete>);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'delete',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to handle drive');
      expect(loggers.auth.error).toHaveBeenCalled();
    });

    it('should handle transfer database errors', async () => {
      const whereMock = vi.fn().mockRejectedValue(new Error('Update failed'));
      const setMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to handle drive');
    });
  });

  describe('activity logging boundary', () => {
    it('should log ownership_transfer with previous and new ownerId on successful transfer', async () => {
      setupUpdateMock();

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      await POST(request);

      expect(logDriveActivity).toHaveBeenCalledWith(
        mockUserId,
        'ownership_transfer',
        expect.objectContaining({
          id: mockDriveId,
          name: 'Test Drive',
        }),
        expect.objectContaining({
          actorEmail: 'test@example.com',
          previousValues: { ownerId: mockUserId },
          newValues: { ownerId: mockNewOwnerId },
        })
      );
    });

    it('should call getActorInfo with userId on transfer', async () => {
      setupUpdateMock();

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      await POST(request);

      expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
    });

    it('should NOT log activity when authentication fails', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      await POST(request);

      expect(logDriveActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      await POST(request);

      expect(logDriveActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when user is not drive owner', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: 'different_user' })
      );

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      await POST(request);

      expect(logDriveActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when new owner is not admin', async () => {
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'transfer',
          newOwnerId: mockNewOwnerId,
        }),
      });

      await POST(request);

      expect(logDriveActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity for delete action', async () => {
      setupDeleteMock();

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          action: 'delete',
        }),
      });

      await POST(request);

      expect(logDriveActivity).not.toHaveBeenCalled();
    });
  });
});
