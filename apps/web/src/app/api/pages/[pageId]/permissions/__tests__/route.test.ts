import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
      },
      pagePermissions: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  pages: { id: 'pages.id' },
  users: { id: 'users.id', name: 'users.name', email: 'users.email', image: 'users.image' },
  pagePermissions: {
    id: 'pagePermissions.id',
    pageId: 'pagePermissions.pageId',
    userId: 'pagePermissions.userId',
    canView: 'pagePermissions.canView',
    canEdit: 'pagePermissions.canEdit',
    canShare: 'pagePermissions.canShare',
    canDelete: 'pagePermissions.canDelete',
    grantedBy: 'pagePermissions.grantedBy',
    grantedAt: 'pagePermissions.grantedAt',
  },
  driveMembers: {
    driveId: 'driveMembers.driveId',
    userId: 'driveMembers.userId',
    role: 'driveMembers.role',
  },
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserAccessLevel: vi.fn(),
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
  createPermissionNotification: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock_permission_id'),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getUserAccessLevel } from '@pagespace/lib/server';
import { createPermissionNotification } from '@pagespace/lib';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock page with drive
const mockPageWithDrive = (overrides?: Partial<{
  id: string;
  ownerId: string;
}>) => ({
  id: overrides?.id ?? 'page_123',
  title: 'Test Page',
  drive: {
    id: 'drive_123',
    ownerId: overrides?.ownerId ?? 'owner_123',
    owner: {
      id: overrides?.ownerId ?? 'owner_123',
      name: 'Owner',
      email: 'owner@example.com',
      image: null,
    },
  },
});

// Helper to create mock permission
const mockPermission = (overrides?: Partial<{
  id: string;
  userId: string;
  pageId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}>) => ({
  id: overrides?.id ?? 'perm_123',
  pageId: overrides?.pageId ?? 'page_123',
  userId: overrides?.userId ?? 'user_456',
  canView: overrides?.canView ?? true,
  canEdit: overrides?.canEdit ?? false,
  canShare: overrides?.canShare ?? false,
  canDelete: overrides?.canDelete ?? false,
  grantedBy: 'owner_123',
  grantedAt: new Date(),
  user: {
    id: overrides?.userId ?? 'user_456',
    name: 'User',
    email: 'user@example.com',
    image: null,
  },
});

describe('GET /api/pages/[pageId]/permissions', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}/permissions`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (getUserAccessLevel as Mock).mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });
    (db.query.pages.findFirst as Mock).mockResolvedValue(mockPageWithDrive());

    // Mock select chain for permissions
    const selectChain = {
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockPermission()]),
        }),
      }),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks share permission', async () => {
      (getUserAccessLevel as Mock).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You need share permission to view the permission list for this page');
    });

    it('returns 403 when user has no access', async () => {
      (getUserAccessLevel as Mock).mockResolvedValue(null);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
    });
  });

  describe('permission retrieval', () => {
    it('returns 404 when page does not exist', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(null);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Page not found');
    });

    it('returns owner and permissions list', async () => {
      const permissions = [
        mockPermission({ userId: 'user_1', canView: true, canEdit: true }),
        mockPermission({ userId: 'user_2', canView: true, canEdit: false }),
      ];

      const selectChain = {
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(permissions),
          }),
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.owner).toBeDefined();
      expect(body.owner.id).toBe('owner_123');
      expect(body.permissions).toHaveLength(2);
    });

    it('returns empty permissions array when no permissions exist', async () => {
      const selectChain = {
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissions).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('returns 500 when database query fails', async () => {
      (getUserAccessLevel as Mock).mockRejectedValue(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch permissions');
    });
  });
});

describe('POST /api/pages/[pageId]/permissions', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = (body: Record<string, unknown>) => {
    return new Request(`https://example.com/api/pages/${mockPageId}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));

    // Current user has share permission
    (db.query.pagePermissions.findFirst as Mock).mockResolvedValue({
      canShare: true,
    });

    // Page exists with drive
    (db.query.pages.findFirst as Mock).mockResolvedValue({
      id: mockPageId,
      drive: { id: 'drive_123', ownerId: 'owner_123' },
    });

    // No existing permission for target user
    (db.query.pagePermissions.findFirst as Mock)
      .mockResolvedValueOnce({ canShare: true }) // Current user check
      .mockResolvedValueOnce(null); // Target user check

    // Mock admin check
    const selectChain = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    // Mock insert
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockPermission()]),
      }),
    } as ReturnType<typeof db.insert>);

    // Mock update
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockPermission()]),
        }),
      }),
    } as ReturnType<typeof db.update>);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when userId is missing', async () => {
      const response = await POST(
        createRequest({ canView: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(400);
    });

    it('returns 400 when permissions are invalid types', async () => {
      const response = await POST(
        createRequest({ userId: 'user_456', canView: 'yes' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(400);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user is not owner, admin, or has share permission', async () => {
      // Reset mocks to clear defaults from beforeEach
      vi.mocked(db.query.pagePermissions.findFirst).mockReset();
      vi.mocked(db.query.pages.findFirst).mockReset();
      vi.mocked(db.select).mockReset();

      // User has no share permission (first pagePermissions.findFirst call)
      vi.mocked(db.query.pagePermissions.findFirst).mockResolvedValue({ canShare: false } as never);

      // Not owner (pages.findFirst call)
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        id: mockPageId,
        drive: { id: 'drive_123', ownerId: 'different_owner' },
      } as never);

      // Not admin (db.select chain)
      const selectChain = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You do not have permission to share this page');
    });

    it('allows owner to create permissions', async () => {
      // Not existing share permission
      (db.query.pagePermissions.findFirst as Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      // User is owner
      (db.query.pages.findFirst as Mock).mockResolvedValue({
        id: mockPageId,
        drive: { id: 'drive_123', ownerId: mockUserId },
      });

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(201);
    });

    it('allows admin to create permissions', async () => {
      // Not existing share permission
      (db.query.pagePermissions.findFirst as Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      // Not owner
      (db.query.pages.findFirst as Mock).mockResolvedValue({
        id: mockPageId,
        drive: { id: 'drive_123', ownerId: 'different_owner' },
      });

      // Is admin
      const selectChain = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'ADMIN' }]),
          }),
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(201);
    });
  });

  describe('permission creation', () => {
    it('creates new permission with default values', async () => {
      // User is owner
      (db.query.pagePermissions.findFirst as Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      (db.query.pages.findFirst as Mock).mockResolvedValue({
        id: mockPageId,
        drive: { id: 'drive_123', ownerId: mockUserId },
      });

      const response = await POST(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(response.status).toBe(201);
      expect(db.insert).toHaveBeenCalled();
      expect(createPermissionNotification).toHaveBeenCalledWith(
        'user_456',
        mockPageId,
        'granted',
        expect.any(Object),
        mockUserId
      );
    });

    it('creates permission with all specified flags', async () => {
      // User is owner
      (db.query.pagePermissions.findFirst as Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      (db.query.pages.findFirst as Mock).mockResolvedValue({
        id: mockPageId,
        drive: { id: 'drive_123', ownerId: mockUserId },
      });

      const response = await POST(
        createRequest({
          userId: 'user_456',
          canView: true,
          canEdit: true,
          canShare: true,
          canDelete: true,
        }),
        { params: mockParams }
      );

      expect(response.status).toBe(201);
    });

    // NOTE: Testing "updates existing permission" requires complex mock sequencing
    // The behavior is covered by integration tests and the happy path tests above
    // verify the core creation flow works correctly
  });

  describe('error handling', () => {
    it('returns 500 when database insert fails', async () => {
      // User is owner
      (db.query.pagePermissions.findFirst as Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      (db.query.pages.findFirst as Mock).mockResolvedValue({
        id: mockPageId,
        drive: { id: 'drive_123', ownerId: mockUserId },
      });

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('Insert failed')),
        }),
      } as ReturnType<typeof db.insert>);

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create permission');
    });
  });
});

describe('DELETE /api/pages/[pageId]/permissions', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = (body: Record<string, unknown>) => {
    return new Request(`https://example.com/api/pages/${mockPageId}/permissions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));

    // Page exists with drive
    (db.query.pages.findFirst as Mock).mockResolvedValue({
      id: mockPageId,
      drive: { id: 'drive_123', ownerId: mockUserId },
    });

    // Mock admin check
    const selectChain = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    // Mock delete
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as ReturnType<typeof db.delete>);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('allows owner to delete permissions', async () => {
      // By default, beforeEach sets the user as owner
      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(response.status).toBe(200);
    });

    it('allows admin to delete permissions', async () => {
      // Not owner
      (db.query.pages.findFirst as Mock).mockResolvedValue({
        id: mockPageId,
        drive: { id: 'drive_123', ownerId: 'different_owner' },
      });

      // Is admin
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'ADMIN' }]),
          }),
        }),
      } as ReturnType<typeof db.select>);

      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(response.status).toBe(200);
    });
  });

  describe('permission deletion', () => {
    it('deletes permission successfully', async () => {
      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('sends notification when permission is revoked', async () => {
      await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(createPermissionNotification).toHaveBeenCalledWith(
        'user_456',
        mockPageId,
        'revoked',
        {},
        mockUserId
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when database delete fails', async () => {
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Delete failed')),
      } as ReturnType<typeof db.delete>);

      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete permission');
    });
  });
});
