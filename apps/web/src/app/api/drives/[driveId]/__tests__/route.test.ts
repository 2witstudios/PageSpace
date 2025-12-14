import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import { z } from 'zod';

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
    select: vi.fn(),
    update: vi.fn(),
  },
  drives: {},
  driveMembers: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn((driveId, event, data) => ({ driveId, event, data })),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { broadcastDriveEvent } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

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

// Helper to create mock drive
const mockDrive = (overrides: {
  id: string;
  name: string;
  ownerId?: string;
  slug?: string;
  isTrashed?: boolean;
}) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.slug ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: overrides.isTrashed ?? false,
  trashedAt: null,
  drivePrompt: null,
});

// Helper to create mock drive member
const mockDriveMember = (overrides: {
  userId: string;
  driveId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}) => ({
  id: 'membership_' + overrides.userId,
  userId: overrides.userId,
  driveId: overrides.driveId,
  role: overrides.role,
  customRoleId: null,
  invitedBy: null,
  invitedAt: new Date(),
  acceptedAt: new Date(),
  lastAccessedAt: null,
});

// Create mock context
const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

describe('GET /api/drives/[driveId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    vi.mocked(db.query.drives.findFirst).mockResolvedValue(
      mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })
    );
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })
      );
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied');
    });
  });

  describe('happy path', () => {
    it('should return drive with isOwned=true when user is owner', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe(mockDriveId);
      expect(body.isOwned).toBe(true);
      expect(body.isMember).toBe(false);
    });

    it('should return drive with isMember=true when user is member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Shared Drive', ownerId: 'other_user' })
      );
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(
        mockDriveMember({ userId: mockUserId, driveId: mockDriveId, role: 'MEMBER' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.isOwned).toBe(false);
      expect(body.isMember).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.drives.findFirst).mockRejectedValue(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch drive');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});

describe('PATCH /api/drives/[driveId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  const setupSelectMock = (results: unknown[]) => {
    const limitMock = vi.fn().mockResolvedValue(results);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
    return { whereMock, limitMock };
  };

  const setupUpdateMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    vi.mocked(db.query.drives.findFirst).mockResolvedValue(
      mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })
    );

    setupUpdateMock();
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })
      );
      setupSelectMock([]); // No admin membership found

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can update drive settings');
    });

    it('should allow admin to update drive', async () => {
      vi.mocked(db.query.drives.findFirst)
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Shared Drive', ownerId: 'other_user' }))
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Updated Name', ownerId: 'other_user' }));

      // Return admin membership
      setupSelectMock([mockDriveMember({ userId: mockUserId, driveId: mockDriveId, role: 'ADMIN' })]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated Name' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('validation', () => {
    it('should reject invalid drivePrompt (too long)', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ drivePrompt: 'a'.repeat(10001) }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('should accept valid optional fields', async () => {
      vi.mocked(db.query.drives.findFirst)
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId }))
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'New Name',
          aiProvider: 'openai',
          aiModel: 'gpt-4',
          drivePrompt: 'Custom instructions',
        }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('happy path', () => {
    it('should update drive name and regenerate slug', async () => {
      vi.mocked(db.query.drives.findFirst)
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Old Name', ownerId: mockUserId }))
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'New Name', slug: 'new-name', ownerId: mockUserId }));

      const { setMock } = setupUpdateMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(setMock).toHaveBeenCalled();
      expect(body.name).toBe('New Name');
    });

    it('should broadcast drive updated event when name changes', async () => {
      vi.mocked(db.query.drives.findFirst)
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Old', ownerId: mockUserId }))
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'New', ownerId: mockUserId }));

      setupUpdateMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(broadcastDriveEvent).toHaveBeenCalled();
    });

    it('should not broadcast event when only AI settings change', async () => {
      vi.mocked(db.query.drives.findFirst)
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId }))
        .mockResolvedValueOnce(mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId }));

      setupUpdateMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ aiProvider: 'openai' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(broadcastDriveEvent).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when update fails', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Update failed')),
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update drive');
    });
  });
});

describe('DELETE /api/drives/[driveId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  const setupSelectMock = (results: unknown[]) => {
    const limitMock = vi.fn().mockResolvedValue(results);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
    return { whereMock, limitMock };
  };

  const setupUpdateMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    vi.mocked(db.query.drives.findFirst).mockResolvedValue(
      mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })
    );

    setupUpdateMock();
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })
      );
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can delete drives');
    });

    it('should allow admin to soft-delete drive', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ id: mockDriveId, name: 'Shared Drive', ownerId: 'other_user' })
      );
      setupSelectMock([mockDriveMember({ userId: mockUserId, driveId: mockDriveId, role: 'ADMIN' })]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('happy path', () => {
    it('should soft-delete drive by setting isTrashed=true', async () => {
      const { setMock } = setupUpdateMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          isTrashed: true,
        })
      );
    });

    it('should broadcast drive deleted event', async () => {
      setupUpdateMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId));

      expect(broadcastDriveEvent).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when update fails', async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Update failed')),
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete drive');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
