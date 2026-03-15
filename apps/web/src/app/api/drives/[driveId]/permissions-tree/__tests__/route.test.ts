import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for GET /api/drives/[driveId]/permissions-tree
//
// The route has no service-seam abstraction, so we mock at the DB layer
// and the auth boundary.
// ============================================================================

// ---------- hoisted mocks ----------

const {
  mockDriveResults,
  mockAdminResults,
  mockPagesResults,
  mockPermResults,
  DRIVES_TABLE,
  PAGES_TABLE,
  PAGE_PERMISSIONS_TABLE,
  DRIVE_MEMBERS_TABLE,
} = vi.hoisted(() => ({
  mockDriveResults: { value: [] as Record<string, unknown>[] },
  mockAdminResults: { value: [] as Record<string, unknown>[] },
  mockPagesResults: { value: [] as Record<string, unknown>[] },
  mockPermResults: { value: [] as Record<string, unknown>[] },
  DRIVES_TABLE: Symbol('drives'),
  PAGES_TABLE: Symbol('pages'),
  PAGE_PERMISSIONS_TABLE: Symbol('pagePermissions'),
  DRIVE_MEMBERS_TABLE: Symbol('driveMembers'),
}));

// ---------- vi.mock declarations ----------

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((_col: unknown, _val: unknown) => ({ type: 'eq' }));
  const and = vi.fn((..._args: unknown[]) => ({ type: 'and' }));

  const createChain = (resolveRef: { value: Record<string, unknown>[] }) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolveRef.value));
    // Also make the chain thenable for queries without .limit()
    Object.defineProperty(chain, 'then', {
      value: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(resolveRef.value).then(resolve, reject),
      writable: true,
      configurable: true,
    });
    return chain;
  };

  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const outerChain: Record<string, unknown> = {};
        outerChain.from = vi.fn().mockImplementation((table: unknown) => {
          if (table === DRIVES_TABLE) return createChain(mockDriveResults);
          if (table === DRIVE_MEMBERS_TABLE) return createChain(mockAdminResults);
          if (table === PAGES_TABLE) return createChain(mockPagesResults);
          if (table === PAGE_PERMISSIONS_TABLE) return createChain(mockPermResults);
          return createChain({ value: [] });
        });
        return outerChain;
      }),
    },
    drives: DRIVES_TABLE,
    pages: PAGES_TABLE,
    pagePermissions: PAGE_PERMISSIONS_TABLE,
    driveMembers: DRIVE_MEMBERS_TABLE,
    eq,
    and,
  };
});

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

// ---------- imports (after mocks) ----------

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

// ---------- helpers ----------

interface VerifiedUser {
  id: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
  authTransport: 'cookie' | 'bearer';
}

const mockUser = (id = 'user_123'): VerifiedUser => ({
  id,
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
  authTransport: 'cookie',
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

const createRequest = (driveId = 'drive_abc', queryParams = '') =>
  new Request(`https://example.com/api/drives/${driveId}/permissions-tree${queryParams}`);

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/drives/[driveId]/permissions-tree', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockDrive = {
    id: mockDriveId,
    name: 'Test Drive',
    slug: 'test-drive',
    ownerId: mockUserId,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue(mockUser(mockUserId));

    // Default: drive found, user is owner
    mockDriveResults.value = [mockDrive];

    // Default: no admin membership
    mockAdminResults.value = [];

    // Default: no pages
    mockPagesResults.value = [];

    // Default: no permissions
    mockPermResults.value = [];
  });

  // ---------- Authentication ----------

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should call verifyAuth with request', async () => {
      const request = createRequest();
      await GET(request, createContext(mockDriveId));

      expect(verifyAuth).toHaveBeenCalledWith(request);
    });
  });

  // ---------- Drive lookup ----------

  describe('drive lookup', () => {
    it('should return 404 when drive not found', async () => {
      mockDriveResults.value = [];

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });
  });

  // ---------- Authorization ----------

  describe('authorization', () => {
    it('should return 403 when user is not owner and not admin', async () => {
      mockDriveResults.value = [{ ...mockDrive, ownerId: 'other_user' }];
      mockAdminResults.value = [];

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can view permission tree');
    });

    it('should allow access when user is owner', async () => {
      mockDriveResults.value = [mockDrive];

      const response = await GET(createRequest(), createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should allow access when user is admin (not owner)', async () => {
      mockDriveResults.value = [{ ...mockDrive, ownerId: 'other_user' }];
      mockAdminResults.value = [{ id: 'membership_1' }];

      const response = await GET(createRequest(), createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  // ---------- Response contract ----------

  describe('response contract', () => {
    it('should return tree structure with drive info and totalPages', async () => {
      mockPagesResults.value = [];

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.drive).toEqual({
        id: mockDriveId,
        name: 'Test Drive',
        slug: 'test-drive',
        ownerId: mockUserId,
      });
      expect(body.pages).toEqual([]);
      expect(body.totalPages).toBe(0);
    });

    it('should build correct tree structure from flat pages', async () => {
      mockPagesResults.value = [
        { id: 'p1', title: 'Root', type: 'page', parentId: null, position: 0, isTrashed: false },
        { id: 'p2', title: 'Child', type: 'page', parentId: 'p1', position: 1, isTrashed: false },
      ];

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.totalPages).toBe(2);
      expect(body.pages).toHaveLength(1);
      expect(body.pages[0].id).toBe('p1');
      expect(body.pages[0].title).toBe('Root');
      expect(body.pages[0].children).toHaveLength(1);
      expect(body.pages[0].children[0].id).toBe('p2');
      expect(body.pages[0].children[0].title).toBe('Child');
      expect(body.pages[0].children[0].children).toEqual([]);
    });

    it('should sort children by position', async () => {
      mockPagesResults.value = [
        { id: 'p1', title: 'Root', type: 'page', parentId: null, position: 0, isTrashed: false },
        { id: 'p3', title: 'Second', type: 'page', parentId: 'p1', position: 2, isTrashed: false },
        { id: 'p2', title: 'First', type: 'page', parentId: 'p1', position: 1, isTrashed: false },
      ];

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(body.pages[0].children[0].title).toBe('First');
      expect(body.pages[0].children[1].title).toBe('Second');
    });

    it('should include type and position fields in page nodes', async () => {
      mockPagesResults.value = [
        { id: 'p1', title: 'Page', type: 'document', parentId: null, position: 5, isTrashed: false },
      ];

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(body.pages[0].type).toBe('document');
      expect(body.pages[0].position).toBe(5);
    });
  });

  // ---------- Permissions ----------

  describe('permissions for targetUserId', () => {
    it('should include existing permissions when targetUserId is provided', async () => {
      mockPagesResults.value = [
        { id: 'p1', title: 'Root', type: 'page', parentId: null, position: 0, isTrashed: false },
      ];
      mockPermResults.value = [
        { pageId: 'p1', canView: true, canEdit: true, canShare: false },
      ];

      const response = await GET(
        createRequest(mockDriveId, '?userId=target_user'),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.pages[0].currentPermissions).toEqual({
        canView: true,
        canEdit: true,
        canShare: false,
      });
    });

    it('should return default permissions when targetUserId is provided but page has no permissions', async () => {
      mockPagesResults.value = [
        { id: 'p1', title: 'Root', type: 'page', parentId: null, position: 0, isTrashed: false },
      ];
      mockPermResults.value = [];

      const response = await GET(
        createRequest(mockDriveId, '?userId=target_user'),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(body.pages[0].currentPermissions).toEqual({
        canView: false,
        canEdit: false,
        canShare: false,
      });
    });

    it('should return default permissions when no targetUserId is provided', async () => {
      mockPagesResults.value = [
        { id: 'p1', title: 'Root', type: 'page', parentId: null, position: 0, isTrashed: false },
      ];

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(body.pages[0].currentPermissions).toEqual({
        canView: false,
        canEdit: false,
        canShare: false,
      });
    });

    it('should map permissions correctly for multiple pages', async () => {
      mockPagesResults.value = [
        { id: 'p1', title: 'Page1', type: 'page', parentId: null, position: 0, isTrashed: false },
        { id: 'p2', title: 'Page2', type: 'page', parentId: null, position: 1, isTrashed: false },
      ];
      mockPermResults.value = [
        { pageId: 'p2', canView: true, canEdit: false, canShare: true },
      ];

      const response = await GET(
        createRequest(mockDriveId, '?userId=target_user'),
        createContext(mockDriveId)
      );
      const body = await response.json();

      // p1 has no permissions
      expect(body.pages[0].currentPermissions).toEqual({
        canView: false,
        canEdit: false,
        canShare: false,
      });
      // p2 has specific permissions
      expect(body.pages[1].currentPermissions).toEqual({
        canView: true,
        canEdit: false,
        canShare: true,
      });
    });
  });

  // ---------- Error handling ----------

  describe('error handling', () => {
    it('should return 500 when an error is thrown', async () => {
      vi.mocked(verifyAuth).mockRejectedValue(new Error('DB error'));

      const response = await GET(createRequest(), createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch permission tree');
    });

    it('should log error when an error is thrown', async () => {
      const error = new Error('DB error');
      vi.mocked(verifyAuth).mockRejectedValue(error);

      await GET(createRequest(), createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching permission tree:', error);
    });
  });
});
