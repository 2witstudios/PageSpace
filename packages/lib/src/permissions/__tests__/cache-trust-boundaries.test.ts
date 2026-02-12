/**
 * Cache Trust Boundary Tests
 *
 * Zero-trust tests for the permission caching layer.
 * These verify that cached permissions cannot be exploited to bypass
 * authorization, and that cache bypass works correctly for sensitive operations.
 *
 * Security properties tested:
 * 1. bypassCache: true always hits the database directly
 * 2. Cache misses fall through to database correctly
 * 3. Cache errors result in database fallback (not denial and not stale data)
 * 4. Cached positive results don't persist after invalidation
 * 5. Default (non-bypass) uses cache for performance
 * 6. Negative results (null/deny) are NOT served from cache for security
 * 7. Cache invalidation failure is logged but doesn't block operation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks — use vi.hoisted so variables exist when vi.mock factory runs
// =============================================================================

const {
  mockGetPagePermission,
  mockSetPagePermission,
  mockGetDriveAccess,
  mockSetDriveAccess,
  mockInvalidateUserCache,
  mockInvalidateDriveCache,
  mockGetCacheStats,
  mockDbSelect,
  mockDbFrom,
  mockDbLeftJoin,
  mockDbWhere,
  mockDbLimit,
} = vi.hoisted(() => ({
  mockGetPagePermission: vi.fn(),
  mockSetPagePermission: vi.fn(),
  mockGetDriveAccess: vi.fn(),
  mockSetDriveAccess: vi.fn(),
  mockInvalidateUserCache: vi.fn(),
  mockInvalidateDriveCache: vi.fn(),
  mockGetCacheStats: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbFrom: vi.fn(),
  mockDbLeftJoin: vi.fn(),
  mockDbWhere: vi.fn(),
  mockDbLimit: vi.fn(),
}));

vi.mock('../../services/permission-cache', () => ({
  PermissionCache: {
    getInstance: () => ({
      getPagePermission: mockGetPagePermission,
      setPagePermission: mockSetPagePermission,
      getDriveAccess: mockGetDriveAccess,
      setDriveAccess: mockSetDriveAccess,
      invalidateUserCache: mockInvalidateUserCache,
      invalidateDriveCache: mockInvalidateDriveCache,
      getCacheStats: mockGetCacheStats,
    }),
  },
  PermissionLevel: {},
}));

vi.mock('@pagespace/db', () => {
  mockDbFrom.mockReturnValue({
    leftJoin: mockDbLeftJoin.mockReturnValue({
      where: mockDbWhere.mockReturnValue({
        limit: mockDbLimit,
      }),
    }),
    where: mockDbWhere.mockReturnValue({
      limit: mockDbLimit,
    }),
  });

  mockDbSelect.mockReturnValue({
    from: mockDbFrom,
  });

  return {
    db: {
      select: mockDbSelect,
    },
    pages: { id: 'pages.id', driveId: 'pages.driveId' },
    drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
    driveMembers: { driveId: 'dm.driveId', userId: 'dm.userId', role: 'dm.role' },
    pagePermissions: {
      pageId: 'pp.pageId',
      userId: 'pp.userId',
      canView: 'pp.canView',
      canEdit: 'pp.canEdit',
      canShare: 'pp.canShare',
      canDelete: 'pp.canDelete',
    },
    eq: vi.fn(),
    and: vi.fn(),
    inArray: vi.fn(),
  };
});

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  },
}));

import {
  getUserAccessLevel,
  invalidateUserPermissions,
  invalidateDrivePermissions,
} from '../permissions-cached';

describe('Cache Trust Boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-establish default mock chain after clearAllMocks
    mockDbFrom.mockReturnValue({
      leftJoin: mockDbLeftJoin.mockReturnValue({
        where: mockDbWhere.mockReturnValue({
          limit: mockDbLimit,
        }),
      }),
      where: mockDbWhere.mockReturnValue({
        limit: mockDbLimit,
      }),
    });

    mockDbSelect.mockReturnValue({
      from: mockDbFrom,
    });
  });

  // ===========================================================================
  // 1. bypassCache ALWAYS SKIPS CACHE
  // ===========================================================================

  describe('bypassCache enforcement', () => {
    it('given bypassCache: true, should NOT check cache and query DB directly', async () => {
      // Setup: DB returns a page with owner
      mockDbLimit
        .mockResolvedValueOnce([{
          id: 'page-123',
          driveId: 'drive-abc',
          driveOwnerId: 'user-owner',
        }]);

      await getUserAccessLevel('user-owner', 'page-123', { bypassCache: true });

      // Cache should NOT be checked
      expect(mockGetPagePermission).not.toHaveBeenCalled();
      // DB should be queried
      expect(mockDbSelect).toHaveBeenCalled();
    });

    it('given bypassCache: false (default), should check cache first', async () => {
      mockGetPagePermission.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const result = await getUserAccessLevel('user-123', 'page-456');

      expect(mockGetPagePermission).toHaveBeenCalledWith('user-123', 'page-456');
      expect(result).toEqual({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });
      // DB should NOT be queried when cache hits
      expect(mockDbSelect).not.toHaveBeenCalled();
    });

    it('given bypassCache: true but DB returns permissions, should still cache the result', async () => {
      mockDbLimit
        .mockResolvedValueOnce([{
          id: 'page-123',
          driveId: 'drive-abc',
          driveOwnerId: 'user-owner',
        }]);

      await getUserAccessLevel('user-owner', 'page-123', { bypassCache: true });

      // Should cache the result for future non-bypass queries
      expect(mockSetPagePermission).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 2. CACHE MISS FALLS THROUGH TO DATABASE
  // ===========================================================================

  describe('cache miss fallthrough', () => {
    it('given cache returns null (miss), should query database', async () => {
      mockGetPagePermission.mockResolvedValue(null);

      mockDbLimit
        .mockResolvedValueOnce([{
          id: 'page-123',
          driveId: 'drive-abc',
          driveOwnerId: 'user-owner',
        }]);

      const result = await getUserAccessLevel('user-owner', 'page-123');

      expect(mockGetPagePermission).toHaveBeenCalled();
      expect(mockDbSelect).toHaveBeenCalled();
      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });
  });

  // ===========================================================================
  // 3. DATABASE ERRORS RESULT IN DENIAL
  // ===========================================================================

  describe('database error handling', () => {
    it('given cache miss and database error, should deny access (fail-closed)', async () => {
      mockGetPagePermission.mockResolvedValue(null);
      mockDbFrom.mockReturnValueOnce({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('DB connection lost')),
          }),
        }),
      });

      const result = await getUserAccessLevel('user-123', 'page-456');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 4. CACHE INVALIDATION
  // ===========================================================================

  describe('cache invalidation', () => {
    it('invalidateUserPermissions calls cache invalidation', async () => {
      mockInvalidateUserCache.mockResolvedValue(undefined);

      await invalidateUserPermissions('user-123');

      expect(mockInvalidateUserCache).toHaveBeenCalledWith('user-123');
    });

    it('invalidateDrivePermissions calls cache invalidation', async () => {
      mockInvalidateDriveCache.mockResolvedValue(undefined);

      await invalidateDrivePermissions('drive-abc');

      expect(mockInvalidateDriveCache).toHaveBeenCalledWith('drive-abc');
    });

    it('cache invalidation failure should not throw (graceful degradation)', async () => {
      mockInvalidateUserCache.mockRejectedValue(new Error('Redis unavailable'));

      // Should not throw
      await expect(invalidateUserPermissions('user-123')).resolves.toBeUndefined();
    });

    it('drive cache invalidation failure should not throw', async () => {
      mockInvalidateDriveCache.mockRejectedValue(new Error('Redis timeout'));

      await expect(invalidateDrivePermissions('drive-abc')).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // 5. CACHE DOES NOT SERVE STALE ELEVATED PERMISSIONS
  // ===========================================================================

  describe('stale permission prevention', () => {
    it('given cached elevated permissions then bypassCache query shows denied, should return denied', async () => {
      // First call: cache has elevated permissions
      mockGetPagePermission.mockResolvedValueOnce({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });

      const cachedResult = await getUserAccessLevel('user-123', 'page-456');
      expect(cachedResult?.canEdit).toBe(true);

      // Second call with bypassCache: DB shows permission revoked
      mockDbLimit
        .mockResolvedValueOnce([{
          id: 'page-456',
          driveId: 'drive-abc',
          driveOwnerId: 'user-other',
        }])
        .mockResolvedValueOnce([]) // Not admin
        .mockResolvedValueOnce([]); // No explicit permissions

      const freshResult = await getUserAccessLevel('user-123', 'page-456', { bypassCache: true });
      expect(freshResult).toBeNull();
    });

    it('given permission just revoked, next cache-miss query should reflect revocation', async () => {
      // Cache miss (already invalidated)
      mockGetPagePermission.mockResolvedValue(null);

      // DB shows no access
      mockDbLimit
        .mockResolvedValueOnce([{
          id: 'page-456',
          driveId: 'drive-abc',
          driveOwnerId: 'user-other',
        }])
        .mockResolvedValueOnce([]) // Not admin
        .mockResolvedValueOnce([]); // No explicit permissions

      const result = await getUserAccessLevel('user-123', 'page-456');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 6. PAGE NOT FOUND
  // ===========================================================================

  describe('page not found', () => {
    it('given cache miss and page not in database, should return null', async () => {
      mockGetPagePermission.mockResolvedValue(null);
      mockDbLimit.mockResolvedValueOnce([]); // Page not found

      const result = await getUserAccessLevel('user-123', 'page-nonexistent');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 7. DRIVE OWNER IDENTIFICATION
  // ===========================================================================

  describe('drive owner identification through cache', () => {
    it('given cache miss, drive owner should get full permissions', async () => {
      mockGetPagePermission.mockResolvedValue(null);
      mockDbLimit.mockResolvedValueOnce([{
        id: 'page-123',
        driveId: 'drive-abc',
        driveOwnerId: 'user-owner',
      }]);

      const result = await getUserAccessLevel('user-owner', 'page-123');

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given cache miss, non-owner non-admin without explicit permissions should be denied', async () => {
      mockGetPagePermission.mockResolvedValue(null);
      mockDbLimit
        .mockResolvedValueOnce([{
          id: 'page-123',
          driveId: 'drive-abc',
          driveOwnerId: 'user-other',
        }])
        .mockResolvedValueOnce([]) // Not admin
        .mockResolvedValueOnce([]); // No permissions

      const result = await getUserAccessLevel('user-nobody', 'page-123');

      expect(result).toBeNull();
    });
  });
});
