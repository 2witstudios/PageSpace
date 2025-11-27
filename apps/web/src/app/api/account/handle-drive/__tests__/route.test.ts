import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';

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
  eq: vi.fn((field, value) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args) => ({ args, type: 'and' })),
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

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

describe('POST /api/account/handle-drive', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockNewOwnerId = 'admin_456';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: mockUserId,
      tokenVersion: 0,
    });
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default drive owned by user
    vi.mocked(db.query.drives.findFirst).mockResolvedValue({
      id: mockDriveId,
      ownerId: mockUserId,
      name: 'Test Drive',
    });

    // Setup default admin membership
    vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({
      id: 'membership_1',
      userId: mockNewOwnerId,
      driveId: mockDriveId,
      role: 'ADMIN',
      customRoleId: null,
    });

    // Setup default database operations
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
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
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      });

      const request = new Request('https://example.com/api/account/handle-drive', {
        method: 'POST',
        body: JSON.stringify({ driveId: mockDriveId, action: 'delete' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(null);

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
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({
        id: mockDriveId,
        ownerId: 'different_user',
        name: 'Test Drive',
      });

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
      const updateMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: updateMock,
        }),
      });

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
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(null);

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
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({
        id: 'membership_1',
        userId: mockNewOwnerId,
        driveId: mockDriveId,
        role: 'MEMBER', // Not admin
        customRoleId: null,
      });

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
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({
        id: 'membership_1',
        userId: mockNewOwnerId,
        driveId: 'different_drive', // Different drive
        role: 'ADMIN',
        customRoleId: null,
      });

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
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.delete).mockReturnValue({
        where: deleteMock,
      });

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
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.delete).mockReturnValue({
        where: deleteMock,
      });

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
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Database connection lost')),
      });

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
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('Update failed')),
        }),
      });

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
});
