import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
  drives: {},
  driveMembers: {},
  users: {},
  userProfiles: {},
  pagePermissions: {},
  pages: {},
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
}));

vi.mock('@pagespace/lib', () => ({
  createDriveNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveMemberEvent: vi.fn().mockResolvedValue(undefined),
  createDriveMemberEventPayload: vi.fn((driveId, userId, event, data) => ({ driveId, userId, event, data })),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { createDriveNotification } from '@pagespace/lib';
import { broadcastDriveMemberEvent } from '@/lib/websocket';
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
}) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.slug ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
});

// Helper to create mock member with user data
const mockMemberWithUser = (overrides: {
  id?: string;
  userId: string;
  driveId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}) => ({
  id: overrides.id ?? 'mem_' + overrides.userId,
  userId: overrides.userId,
  role: overrides.role,
  customRoleId: null,
  invitedAt: new Date('2024-01-01'),
  acceptedAt: new Date('2024-01-01'),
  user: {
    id: overrides.userId,
    email: `${overrides.userId}@example.com`,
    name: `User ${overrides.userId}`,
  },
  profile: {
    username: overrides.userId,
    displayName: `User ${overrides.userId}`,
    avatarUrl: null,
  },
});

// Create mock context
const createContext = (driveId: string, userId: string) => ({
  params: Promise.resolve({ driveId, userId }),
});

describe('GET /api/drives/[driveId]/members/[userId]', () => {
  const mockCurrentUserId = 'user_123';
  const mockTargetUserId = 'user_456';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockCurrentUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  const setupSelectMock = (responses: unknown[][]) => {
    let callIndex = 0;
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(async () => {
            const result = responses[callIndex] || [];
            callIndex++;
            return result;
          }),
        }),
        leftJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(async () => {
                const result = responses[callIndex] || [];
                callIndex++;
                return result;
              }),
            }),
          }),
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(responses[callIndex] || []),
        }),
      })),
    } as unknown as ReturnType<typeof db.select>));
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([[]]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      // Drive owned by different user, and no admin membership
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })],
        [], // No admin membership
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can manage member settings');
    });
  });

  describe('happy path', () => {
    it('should return member details when user is owner', async () => {
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockCurrentUserId })],
        [mockMemberWithUser({ userId: mockTargetUserId, driveId: mockDriveId, role: 'MEMBER' })],
        [], // permissions
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.member).toBeDefined();
      expect(body.member.userId).toBe(mockTargetUserId);
    });

    it('should return member with drive info', async () => {
      const drive = mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockCurrentUserId });
      setupSelectMock([
        [drive],
        [mockMemberWithUser({ userId: mockTargetUserId, driveId: mockDriveId, role: 'ADMIN' })],
        [],
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.member.drive).toMatchObject({
        id: mockDriveId,
        name: 'Test Drive',
        ownerId: mockCurrentUserId,
      });
    });

    it('should return 404 when member not found', async () => {
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockCurrentUserId })],
        [], // No member
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Member not found');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database error');
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch member details');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});

describe('PATCH /api/drives/[driveId]/members/[userId]', () => {
  const mockCurrentUserId = 'user_123';
  const mockTargetUserId = 'user_456';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockCurrentUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  // More flexible mock that handles different query patterns
  const setupSelectMock = (responses: unknown[][]) => {
    let callIndex = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const getCurrentAndIncrement = async () => {
        const result = responses[callIndex] || [];
        callIndex++;
        return result;
      };

      // Create a mock that handles both .limit() and direct .where() resolution
      const whereMock = vi.fn().mockImplementation(() => {
        // Return both a promise (for queries without limit) and limit method
        const result = getCurrentAndIncrement();
        return {
          limit: vi.fn().mockImplementation(() => result),
          then: (resolve: (value: unknown) => void) => result.then(resolve),
          catch: (reject: (error: unknown) => void) => result.catch(reject),
        };
      });

      return {
        from: vi.fn().mockImplementation(() => ({
          where: whereMock,
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(async () => {
              const result = responses[callIndex] || [];
              callIndex++;
              return result;
            }),
          }),
        })),
      } as unknown as ReturnType<typeof db.select>;
    });
  };

  const setupUpdateMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock };
  };

  const setupDeleteMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: whereMock } as unknown as ReturnType<typeof db.delete>);
    return { whereMock };
  };

  const setupInsertMock = () => {
    const valuesMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);
    return { valuesMock };
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should reject request without permissions array', async () => {
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockCurrentUserId })],
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions data');
    });

    it('should reject invalid role', async () => {
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockCurrentUserId })],
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'SUPERADMIN', permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid role');
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([[]]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })],
        [], // No admin membership
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can manage member settings');
    });

    it('should return 404 when member not found', async () => {
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockCurrentUserId })],
        [], // No member found
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Member not found');
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      setupUpdateMock();
      setupDeleteMock();
      setupInsertMock();
    });

    it('should update member role and send notification', async () => {
      const member = { id: 'mem_1', userId: mockTargetUserId, role: 'MEMBER' };
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockCurrentUserId })],
        [member],
        [], // drive pages
        [], // existing permissions
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(createDriveNotification).toHaveBeenCalledWith(
        mockTargetUserId,
        mockDriveId,
        'role_changed',
        'ADMIN',
        mockCurrentUserId
      );
      expect(broadcastDriveMemberEvent).toHaveBeenCalled();
    });

    it('should update permissions for valid page IDs', async () => {
      const member = { id: 'mem_1', userId: mockTargetUserId, role: 'MEMBER' };
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockCurrentUserId })],
        [member],
        [{ id: 'page_1' }, { id: 'page_2' }], // drive pages
        [], // existing permissions
      ]);

      setupInsertMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          permissions: [
            { pageId: 'page_1', canView: true, canEdit: true, canShare: false },
            { pageId: 'page_2', canView: true, canEdit: false, canShare: false },
          ],
        }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsUpdated).toBe(2);
    });

    it('should filter out invalid page IDs', async () => {
      const member = { id: 'mem_1', userId: mockTargetUserId, role: 'MEMBER' };
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockCurrentUserId })],
        [member],
        [{ id: 'page_1' }], // Only page_1 is valid
        [],
      ]);

      setupInsertMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          permissions: [
            { pageId: 'page_1', canView: true, canEdit: false, canShare: false },
            { pageId: 'invalid_page', canView: true, canEdit: false, canShare: false },
          ],
        }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsUpdated).toBe(1);
    });

    it('should not insert permissions with all false values', async () => {
      const member = { id: 'mem_1', userId: mockTargetUserId, role: 'MEMBER' };
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockCurrentUserId })],
        [member],
        [{ id: 'page_1' }],
        [],
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          permissions: [
            { pageId: 'page_1', canView: false, canEdit: false, canShare: false },
          ],
        }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsUpdated).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when update fails', async () => {
      setupSelectMock([
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockCurrentUserId })],
        [{ id: 'mem_1', userId: mockTargetUserId, role: 'MEMBER' }],
        [],
        [],
      ]);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Update failed')),
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update member permissions');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
