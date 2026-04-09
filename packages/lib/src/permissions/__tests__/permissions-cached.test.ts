import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetPagePermission = vi.fn();
const mockSetPagePermission = vi.fn();
const mockGetDriveAccess = vi.fn();
const mockSetDriveAccess = vi.fn();
const mockGetBatchPagePermissions = vi.fn();
const mockInvalidateUserCache = vi.fn();
const mockInvalidateDriveCache = vi.fn();
const mockGetCacheStats = vi.fn();

vi.mock('../../services/permission-cache', () => ({
  PermissionCache: {
    getInstance: () => ({
      getPagePermission: mockGetPagePermission,
      setPagePermission: mockSetPagePermission,
      getDriveAccess: mockGetDriveAccess,
      setDriveAccess: mockSetDriveAccess,
      getBatchPagePermissions: mockGetBatchPagePermissions,
      invalidateUserCache: mockInvalidateUserCache,
      invalidateDriveCache: mockInvalidateDriveCache,
      getCacheStats: mockGetCacheStats,
    }),
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id', ownerId: 'ownerId' },
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role', id: 'id' },
  pagePermissions: {
    pageId: 'pageId', userId: 'userId', canView: 'canView', canEdit: 'canEdit',
    canShare: 'canShare', canDelete: 'canDelete', expiresAt: 'expiresAt', id: 'id',
  },
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: { a, b } })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: { a, b } })),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    security: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  getUserAccessLevel,
  getUserDriveAccess,
  getUserDrivePermissions,
  getBatchPagePermissions,
  canUserViewPage,
  canUserEditPage,
  canUserSharePage,
  canUserDeletePage,
  invalidateUserPermissions,
  invalidateDrivePermissions,
  getPermissionCacheStats,
} from '../permissions-cached';
import { db } from '@pagespace/db';
import { loggers } from '../../logging/logger-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-123';
const OTHER_USER = 'user-456';
const PAGE_ID = 'page-abc';
const DRIVE_ID = 'drive-xyz';

/**
 * Build a chainable db.select mock.
 *
 * Each call to db.select() returns { from }, from returns { leftJoin, where },
 * leftJoin returns { leftJoin, where }, and where returns { limit }.
 *
 * For sequential calls, pass an array of row-arrays — one per db.select() call.
 */
function mockSelectChain(rowSets: unknown[][]) {
  for (const rows of rowSets) {
    const limitFn = vi.fn().mockResolvedValue(rows);
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn().mockReturnValue({
      where: whereFn,
      leftJoin: undefined as ReturnType<typeof vi.fn> | undefined,
    });
    // Allow chaining leftJoin -> leftJoin -> where
    leftJoinFn.mockReturnValue({ where: whereFn, leftJoin: leftJoinFn });
    const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });

    vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);
  }
}

/** Shorthand to mock a single db.select that throws */
function mockSelectThrow(error: Error) {
  const limitFn = vi.fn().mockRejectedValue(error);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn().mockReturnValue({ where: whereFn, leftJoin: undefined as ReturnType<typeof vi.fn> | undefined });
  leftJoinFn.mockReturnValue({ where: whereFn, leftJoin: leftJoinFn });
  const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
  vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPagePermission.mockResolvedValue(null);
  mockSetPagePermission.mockResolvedValue(undefined);
  mockGetDriveAccess.mockResolvedValue(null);
  mockSetDriveAccess.mockResolvedValue(undefined);
  mockGetBatchPagePermissions.mockResolvedValue(new Map());
  mockInvalidateUserCache.mockResolvedValue(undefined);
  mockInvalidateDriveCache.mockResolvedValue(undefined);
});

// ===========================================================================
// getUserAccessLevel
// ===========================================================================
describe('getUserAccessLevel', () => {
  // -------------------------------------------------------------------------
  // Cache hit
  // -------------------------------------------------------------------------
  describe('cache hit', () => {
    it('returns cached permissions without querying the database', async () => {
      const cached = { canView: true, canEdit: false, canShare: false, canDelete: false };
      mockGetPagePermission.mockResolvedValue(cached);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toEqual(cached);
      expect(mockGetPagePermission).toHaveBeenCalledWith(USER_ID, PAGE_ID);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('logs debug on cache hit when silent=false', async () => {
      const cached = { canView: true, canEdit: true, canShare: true, canDelete: true };
      mockGetPagePermission.mockResolvedValue(cached);

      await getUserAccessLevel(USER_ID, PAGE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cache hit'),
      );
    });

    it('does not log on cache hit when silent=true (default)', async () => {
      mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: true });

      await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(loggers.api.debug).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // bypassCache
  // -------------------------------------------------------------------------
  describe('bypassCache', () => {
    it('skips cache lookup when bypassCache=true', async () => {
      // Even with a cached value, it should not be used
      mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: true });

      // Set up DB to return page owned by user
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: USER_ID }],
      ]);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID, { bypassCache: true });

      expect(mockGetPagePermission).not.toHaveBeenCalled();
      expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - owner
  // -------------------------------------------------------------------------
  describe('cache miss - owner', () => {
    it('returns full access when user is drive owner', async () => {
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: USER_ID }],
      ]);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
      expect(mockSetPagePermission).toHaveBeenCalledWith(
        USER_ID, PAGE_ID, DRIVE_ID,
        { canView: true, canEdit: true, canShare: true, canDelete: true },
        true, 60,
      );
    });

    it('logs owner debug when silent=false', async () => {
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: USER_ID }],
      ]);

      await getUserAccessLevel(USER_ID, PAGE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cache miss'),
      );
      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('drive owner'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - admin
  // -------------------------------------------------------------------------
  describe('cache miss - admin', () => {
    it('returns full access when user is drive admin', async () => {
      // Page query: not owner
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: OTHER_USER }],
      ]);
      // Admin membership query: found
      mockSelectChain([
        [{ id: 'member-1' }],
      ]);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
      expect(mockSetPagePermission).toHaveBeenCalledWith(
        USER_ID, PAGE_ID, DRIVE_ID,
        { canView: true, canEdit: true, canShare: true, canDelete: true },
        false, 60,
      );
    });

    it('logs admin debug when silent=false', async () => {
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: OTHER_USER }],
      ]);
      mockSelectChain([
        [{ id: 'member-1' }],
      ]);

      await getUserAccessLevel(USER_ID, PAGE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('drive admin'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - explicit permissions
  // -------------------------------------------------------------------------
  describe('cache miss - explicit permissions', () => {
    it('returns explicit page permissions for a non-owner, non-admin user', async () => {
      // Page query: not owner
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: OTHER_USER }],
      ]);
      // Admin check: not admin
      mockSelectChain([[]]);
      // Explicit permissions
      mockSelectChain([
        [{ canView: true, canEdit: true, canShare: false, canDelete: false }],
      ]);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
      expect(mockSetPagePermission).toHaveBeenCalledWith(
        USER_ID, PAGE_ID, DRIVE_ID,
        { canView: true, canEdit: true, canShare: false, canDelete: false },
        false, 60,
      );
    });

    it('logs explicit permissions debug when silent=false', async () => {
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);
      mockSelectChain([
        [{ canView: true, canEdit: false, canShare: false, canDelete: false }],
      ]);

      await getUserAccessLevel(USER_ID, PAGE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('explicit permissions'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - no permissions
  // -------------------------------------------------------------------------
  describe('cache miss - no permissions', () => {
    it('returns null when no explicit permissions are found (expired or absent)', async () => {
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);
      mockSelectChain([[]]);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toBeNull();
      // Should NOT cache a null result
      expect(mockSetPagePermission).not.toHaveBeenCalled();
    });

    it('logs no permissions debug when silent=false', async () => {
      mockSelectChain([
        [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);
      mockSelectChain([[]]);

      await getUserAccessLevel(USER_ID, PAGE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('No explicit permissions'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - page not found
  // -------------------------------------------------------------------------
  describe('cache miss - page not found', () => {
    it('returns null when the page does not exist', async () => {
      mockSelectChain([[]]);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toBeNull();
    });

    it('logs page not found debug when silent=false', async () => {
      mockSelectChain([[]]);

      await getUserAccessLevel(USER_ID, PAGE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Page not found'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - page has no driveId (admin check skipped)
  // -------------------------------------------------------------------------
  describe('cache miss - page has null driveId', () => {
    it('skips admin check when driveId is null and falls through to explicit permissions', async () => {
      // Page with null driveId, not owner
      mockSelectChain([
        [{ id: PAGE_ID, driveId: null, driveOwnerId: OTHER_USER }],
      ]);
      // No admin check should happen (driveId is falsy)
      // Explicit permissions query
      mockSelectChain([
        [{ canView: true, canEdit: false, canShare: false, canDelete: false }],
      ]);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
      // db.select called twice: page query + explicit permissions (no admin check)
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('returns null and logs error when database throws', async () => {
      mockSelectThrow(new Error('Connection lost'));

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toBeNull();
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking user access level'),
        expect.objectContaining({
          userId: USER_ID,
          pageId: PAGE_ID,
          error: 'Connection lost',
        }),
      );
    });

    it('handles non-Error thrown values', async () => {
      const limitFn = vi.fn().mockRejectedValue('string error');
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn, leftJoin: vi.fn() });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getUserAccessLevel(USER_ID, PAGE_ID);

      expect(result).toBeNull();
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.stringContaining('Error'),
        expect.objectContaining({ error: 'string error' }),
      );
    });
  });
});

// ===========================================================================
// getUserDriveAccess
// ===========================================================================
describe('getUserDriveAccess', () => {
  // -------------------------------------------------------------------------
  // Cache hit
  // -------------------------------------------------------------------------
  describe('cache hit', () => {
    it('returns cached drive access without querying the database', async () => {
      mockGetDriveAccess.mockResolvedValue({ hasAccess: true });

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(true);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns false from cache when access is denied', async () => {
      mockGetDriveAccess.mockResolvedValue({ hasAccess: false });

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(false);
    });

    it('logs cache hit when silent=false (verbose)', async () => {
      mockGetDriveAccess.mockResolvedValue({ hasAccess: true });

      await getUserDriveAccess(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cache hit'),
      );
    });

    it('does not log cache hit when silent=true', async () => {
      mockGetDriveAccess.mockResolvedValue({ hasAccess: true });

      await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(loggers.api.debug).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // bypassCache
  // -------------------------------------------------------------------------
  describe('bypassCache', () => {
    it('skips cache lookup when bypassCache=true', async () => {
      mockGetDriveAccess.mockResolvedValue({ hasAccess: true });
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: USER_ID }],
      ]);

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID, { bypassCache: true });

      expect(mockGetDriveAccess).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - drive not found
  // -------------------------------------------------------------------------
  describe('cache miss - drive not found', () => {
    it('returns false and caches negative result when drive is not found', async () => {
      mockSelectChain([[]]);

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(false);
      expect(mockSetDriveAccess).toHaveBeenCalledWith(USER_ID, DRIVE_ID, false, false, 60);
    });

    it('logs drive not found when silent=false', async () => {
      mockSelectChain([[]]);

      await getUserDriveAccess(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Drive not found'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - owner
  // -------------------------------------------------------------------------
  describe('cache miss - owner', () => {
    it('returns true and caches positive result when user is drive owner', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: USER_ID }],
      ]);

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(true);
      expect(mockSetDriveAccess).toHaveBeenCalledWith(USER_ID, DRIVE_ID, true, true, 60);
    });

    it('logs owner access when silent=false', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: USER_ID }],
      ]);

      await getUserDriveAccess(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('drive owner'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - member
  // -------------------------------------------------------------------------
  describe('cache miss - member', () => {
    it('returns true and caches when user is a drive member', async () => {
      // Drive query: not owner
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      // Membership query: found
      mockSelectChain([
        [{ id: 'member-1' }],
      ]);

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(true);
      expect(mockSetDriveAccess).toHaveBeenCalledWith(USER_ID, DRIVE_ID, true, false, 60);
    });

    it('logs member access when silent=false', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([
        [{ id: 'member-1' }],
      ]);

      await getUserDriveAccess(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('drive member'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - page-level permissions
  // -------------------------------------------------------------------------
  describe('cache miss - page permissions', () => {
    it('returns true when user has page-level permissions within the drive', async () => {
      // Drive: not owner
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      // Membership: not member
      mockSelectChain([[]]);
      // Page access: found
      mockSelectChain([
        [{ id: 'perm-1' }],
      ]);

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(true);
      expect(mockSetDriveAccess).toHaveBeenCalledWith(USER_ID, DRIVE_ID, true, false, 60);
    });

    it('logs page access check when silent=false', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);
      mockSelectChain([
        [{ id: 'perm-1' }],
      ]);

      await getUserDriveAccess(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Page access check result: true'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cache miss - no access
  // -------------------------------------------------------------------------
  describe('cache miss - no access', () => {
    it('returns false when user has no access at all', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);
      mockSelectChain([[]]);

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(false);
      expect(mockSetDriveAccess).toHaveBeenCalledWith(USER_ID, DRIVE_ID, false, false, 60);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('returns false and logs error when database throws', async () => {
      mockSelectThrow(new Error('DB timeout'));

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(false);
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking user drive access'),
        expect.objectContaining({
          userId: USER_ID,
          driveId: DRIVE_ID,
          error: 'DB timeout',
        }),
      );
    });

    it('handles non-Error thrown values', async () => {
      const limitFn = vi.fn().mockRejectedValue(42);
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: vi.fn().mockReturnValue({ where: whereFn }), where: whereFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getUserDriveAccess(USER_ID, DRIVE_ID);

      expect(result).toBe(false);
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: '42' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Verbose logging path
  // -------------------------------------------------------------------------
  describe('verbose logging', () => {
    it('logs cache miss message when silent=false', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: USER_ID }],
      ]);

      await getUserDriveAccess(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cache miss'),
      );
    });

    it('logs membership check when silent=false and user is not owner', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);
      mockSelectChain([[]]);

      await getUserDriveAccess(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Checking drive membership'),
      );
      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('not a drive member'),
      );
    });
  });
});

// ===========================================================================
// getUserDrivePermissions
// ===========================================================================
describe('getUserDrivePermissions', () => {
  // -------------------------------------------------------------------------
  // Drive not found
  // -------------------------------------------------------------------------
  describe('drive not found', () => {
    it('returns null when the drive does not exist', async () => {
      mockSelectChain([[]]);

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toBeNull();
    });

    it('logs drive not found when silent=false', async () => {
      mockSelectChain([[]]);

      await getUserDrivePermissions(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Drive not found'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Owner
  // -------------------------------------------------------------------------
  describe('owner', () => {
    it('returns full owner permissions', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: USER_ID }],
      ]);

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toEqual({
        hasAccess: true,
        isOwner: true,
        isAdmin: false,
        isMember: false,
        canEdit: true,
      });
    });

    it('logs owner debug when silent=false', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: USER_ID }],
      ]);

      await getUserDrivePermissions(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('drive owner'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Admin member
  // -------------------------------------------------------------------------
  describe('admin member', () => {
    it('returns admin permissions', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([
        [{ role: 'ADMIN' }],
      ]);

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toEqual({
        hasAccess: true,
        isOwner: false,
        isAdmin: true,
        isMember: true,
        canEdit: true,
      });
    });

    it('logs admin role when silent=false', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([
        [{ role: 'ADMIN' }],
      ]);

      await getUserDrivePermissions(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('role: ADMIN'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Regular member (MEMBER role - can edit)
  // -------------------------------------------------------------------------
  describe('regular member', () => {
    it('returns member permissions with canEdit=true for MEMBER role', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([
        [{ role: 'MEMBER' }],
      ]);

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toEqual({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Viewer (VIEWER role - cannot edit)
  // -------------------------------------------------------------------------
  describe('viewer', () => {
    it('returns viewer permissions with canEdit=false for VIEWER role', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([
        [{ role: 'VIEWER' }],
      ]);

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toEqual({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // No membership
  // -------------------------------------------------------------------------
  describe('no membership', () => {
    it('returns null when user has no drive-level membership', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toBeNull();
    });

    it('logs no membership when silent=false', async () => {
      mockSelectChain([
        [{ id: DRIVE_ID, ownerId: OTHER_USER }],
      ]);
      mockSelectChain([[]]);

      await getUserDrivePermissions(USER_ID, DRIVE_ID, { silent: false });

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('no drive-level membership'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('returns null and logs error when database throws', async () => {
      mockSelectThrow(new Error('Query failed'));

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toBeNull();
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking drive permissions'),
        expect.objectContaining({
          userId: USER_ID,
          driveId: DRIVE_ID,
          error: 'Query failed',
        }),
      );
    });

    it('handles non-Error thrown values', async () => {
      const limitFn = vi.fn().mockRejectedValue('unexpected');
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn, leftJoin: vi.fn().mockReturnValue({ where: whereFn }) });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getUserDrivePermissions(USER_ID, DRIVE_ID);

      expect(result).toBeNull();
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: 'unexpected' }),
      );
    });
  });
});

// ===========================================================================
// getBatchPagePermissions
// ===========================================================================
describe('getBatchPagePermissions', () => {
  // -------------------------------------------------------------------------
  // Empty pageIds
  // -------------------------------------------------------------------------
  describe('empty pageIds', () => {
    it('returns empty map immediately without checking cache or DB', async () => {
      const result = await getBatchPagePermissions(USER_ID, []);

      expect(result).toEqual(new Map());
      expect(mockGetBatchPagePermissions).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // All cached
  // -------------------------------------------------------------------------
  describe('all cached', () => {
    it('returns all results from cache without querying the database', async () => {
      const cached = new Map([
        ['page-1', { canView: true, canEdit: true, canShare: false, canDelete: false }],
        ['page-2', { canView: true, canEdit: false, canShare: false, canDelete: false }],
      ]);
      mockGetBatchPagePermissions.mockResolvedValue(cached);

      const result = await getBatchPagePermissions(USER_ID, ['page-1', 'page-2']);

      expect(result.size).toBe(2);
      expect(result.get('page-1')).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
      expect(result.get('page-2')).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
      expect(db.select).not.toHaveBeenCalled();
      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('All 2 permissions found in cache'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Mixed cached/uncached
  // -------------------------------------------------------------------------
  describe('mixed cached and uncached', () => {
    it('retrieves cached results and queries DB for uncached pages', async () => {
      const cached = new Map([
        ['page-1', { canView: true, canEdit: true, canShare: true, canDelete: true }],
      ]);
      mockGetBatchPagePermissions.mockResolvedValue(cached);

      // DB query for uncached page-2 (owner)
      const limitFn = vi.fn().mockResolvedValue([
        {
          pageId: 'page-2', driveId: DRIVE_ID, driveOwnerId: USER_ID,
          permissionCanView: null, permissionCanEdit: null,
          permissionCanShare: null, permissionCanDelete: null,
        },
      ]);
      const whereFn = vi.fn().mockReturnValue(limitFn());
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      // Mock the where to resolve to the db rows
      whereFn.mockResolvedValue([
        {
          pageId: 'page-2', driveId: DRIVE_ID, driveOwnerId: USER_ID,
          permissionCanView: null, permissionCanEdit: null,
          permissionCanShare: null, permissionCanDelete: null,
        },
      ]);

      const result = await getBatchPagePermissions(USER_ID, ['page-1', 'page-2']);

      // page-1 from cache, page-2 from DB as owner
      expect(result.size).toBe(2);
      expect(result.get('page-1')).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
      expect(result.get('page-2')).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
    });
  });

  // -------------------------------------------------------------------------
  // All uncached - owner
  // -------------------------------------------------------------------------
  describe('all uncached - owner', () => {
    it('returns full permissions for pages owned by the user', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      // Set up DB to return owner pages
      const dbRows = [
        {
          pageId: 'page-1', driveId: DRIVE_ID, driveOwnerId: USER_ID,
          permissionCanView: null, permissionCanEdit: null,
          permissionCanShare: null, permissionCanDelete: null,
        },
      ];
      const whereFn = vi.fn().mockResolvedValue(dbRows);
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getBatchPagePermissions(USER_ID, ['page-1']);

      expect(result.get('page-1')).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
      expect(mockSetPagePermission).toHaveBeenCalledWith(
        USER_ID, 'page-1', DRIVE_ID,
        { canView: true, canEdit: true, canShare: true, canDelete: true },
        true, 60,
      );
    });
  });

  // -------------------------------------------------------------------------
  // All uncached - explicit permissions
  // -------------------------------------------------------------------------
  describe('all uncached - explicit permissions', () => {
    it('returns explicit permissions when user is not owner', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const dbRows = [
        {
          pageId: 'page-1', driveId: DRIVE_ID, driveOwnerId: OTHER_USER,
          permissionCanView: true, permissionCanEdit: false,
          permissionCanShare: false, permissionCanDelete: false,
        },
      ];
      const whereFn = vi.fn().mockResolvedValue(dbRows);
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getBatchPagePermissions(USER_ID, ['page-1']);

      expect(result.get('page-1')).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
      expect(mockSetPagePermission).toHaveBeenCalledWith(
        USER_ID, 'page-1', DRIVE_ID,
        { canView: true, canEdit: false, canShare: false, canDelete: false },
        false, 60,
      );
    });
  });

  // -------------------------------------------------------------------------
  // All uncached - no permissions (continue branch)
  // -------------------------------------------------------------------------
  describe('all uncached - no permissions (continue branch)', () => {
    it('skips pages where permissionCanView is null and user is not owner', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const dbRows = [
        {
          pageId: 'page-1', driveId: DRIVE_ID, driveOwnerId: OTHER_USER,
          permissionCanView: null, permissionCanEdit: null,
          permissionCanShare: null, permissionCanDelete: null,
        },
      ];
      const whereFn = vi.fn().mockResolvedValue(dbRows);
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getBatchPagePermissions(USER_ID, ['page-1']);

      expect(result.size).toBe(0);
      expect(mockSetPagePermission).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('returns partial results and logs error when database throws', async () => {
      // page-1 is cached
      const cached = new Map([
        ['page-1', { canView: true, canEdit: true, canShare: true, canDelete: true }],
      ]);
      mockGetBatchPagePermissions.mockResolvedValue(cached);

      // DB query for page-2 fails
      const whereFn = vi.fn().mockRejectedValue(new Error('Batch query failed'));
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getBatchPagePermissions(USER_ID, ['page-1', 'page-2']);

      // Should still have the cached page-1
      expect(result.size).toBe(1);
      expect(result.get('page-1')).toBeDefined();
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in batch permission check'),
        expect.objectContaining({
          userId: USER_ID,
          pageCount: 2,
          error: 'Batch query failed',
        }),
      );
    });

    it('handles non-Error thrown values in catch block', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const whereFn = vi.fn().mockRejectedValue('string error');
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getBatchPagePermissions(USER_ID, ['page-1']);

      expect(result.size).toBe(0);
      expect(loggers.api.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in batch permission check'),
        expect.objectContaining({ error: 'string error' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Explicit permissions with falsy values
  // -------------------------------------------------------------------------
  describe('explicit permissions with falsy values', () => {
    it('uses false fallback for falsy permission values (|| false branch)', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const dbRows = [
        {
          pageId: 'page-1', driveId: DRIVE_ID, driveOwnerId: OTHER_USER,
          permissionCanView: false, permissionCanEdit: false,
          permissionCanShare: false, permissionCanDelete: false,
        },
      ];
      const whereFn = vi.fn().mockResolvedValue(dbRows);
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      const result = await getBatchPagePermissions(USER_ID, ['page-1']);

      expect(result.get('page-1')).toEqual({ canView: false, canEdit: false, canShare: false, canDelete: false });
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------
  describe('logging', () => {
    it('logs the count of cached vs uncached results', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const dbRows = [
        {
          pageId: 'page-1', driveId: DRIVE_ID, driveOwnerId: USER_ID,
          permissionCanView: null, permissionCanEdit: null,
          permissionCanShare: null, permissionCanDelete: null,
        },
      ];
      const whereFn = vi.fn().mockResolvedValue(dbRows);
      const leftJoinFn: ReturnType<typeof vi.fn> = vi.fn();
      leftJoinFn.mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      vi.mocked(db.select).mockReturnValueOnce({ from: fromFn } as unknown as ReturnType<typeof db.select>);

      await getBatchPagePermissions(USER_ID, ['page-1']);

      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Found 0 cached, querying 1 from database'),
      );
      expect(loggers.api.debug).toHaveBeenCalledWith(
        expect.stringContaining('Processed 1 permissions from database'),
      );
    });
  });
});

// ===========================================================================
// canUserViewPage / canUserEditPage / canUserSharePage / canUserDeletePage
// ===========================================================================
describe('canUserViewPage', () => {
  it('returns true when user has view access', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: false, canShare: false, canDelete: false });

    const result = await canUserViewPage(USER_ID, PAGE_ID);

    expect(result).toBe(true);
  });

  it('returns false when getUserAccessLevel returns null', async () => {
    mockSelectChain([[]]);

    const result = await canUserViewPage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });

  it('returns false when canView is false', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: false, canEdit: false, canShare: false, canDelete: false });

    const result = await canUserViewPage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });

  it('passes bypassCache option through', async () => {
    mockSelectChain([
      [{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: USER_ID }],
    ]);

    await canUserViewPage(USER_ID, PAGE_ID, { bypassCache: true });

    expect(mockGetPagePermission).not.toHaveBeenCalled();
  });
});

describe('canUserEditPage', () => {
  it('returns true when user has edit access', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: true, canShare: false, canDelete: false });

    const result = await canUserEditPage(USER_ID, PAGE_ID);

    expect(result).toBe(true);
  });

  it('returns false when canEdit is false', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: false, canShare: false, canDelete: false });

    const result = await canUserEditPage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });

  it('returns false when getUserAccessLevel returns null', async () => {
    mockSelectChain([[]]);

    const result = await canUserEditPage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });
});

describe('canUserSharePage', () => {
  it('returns true when user has share access', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: false });

    const result = await canUserSharePage(USER_ID, PAGE_ID);

    expect(result).toBe(true);
  });

  it('returns false when canShare is false', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: true, canShare: false, canDelete: false });

    const result = await canUserSharePage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });

  it('returns false when getUserAccessLevel returns null', async () => {
    mockSelectChain([[]]);

    const result = await canUserSharePage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });
});

describe('canUserDeletePage', () => {
  it('returns true when user has delete access', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: true });

    const result = await canUserDeletePage(USER_ID, PAGE_ID);

    expect(result).toBe(true);
  });

  it('returns false when canDelete is false', async () => {
    mockGetPagePermission.mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: false });

    const result = await canUserDeletePage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });

  it('returns false when getUserAccessLevel returns null', async () => {
    mockSelectChain([[]]);

    const result = await canUserDeletePage(USER_ID, PAGE_ID);

    expect(result).toBe(false);
  });
});

// ===========================================================================
// invalidateUserPermissions
// ===========================================================================
describe('invalidateUserPermissions', () => {
  it('calls invalidateUserCache and logs success', async () => {
    await invalidateUserPermissions(USER_ID);

    expect(mockInvalidateUserCache).toHaveBeenCalledWith(USER_ID);
    expect(loggers.security.info).toHaveBeenCalledWith(
      expect.stringContaining('Invalidated cache for user'),
      expect.objectContaining({ userId: USER_ID }),
    );
  });

  it('logs error when invalidation fails without throwing', async () => {
    mockInvalidateUserCache.mockRejectedValue(new Error('Redis down'));

    await invalidateUserPermissions(USER_ID);

    expect(loggers.security.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to invalidate user cache'),
      expect.objectContaining({
        userId: USER_ID,
        staleTTLSeconds: 60,
        error: 'Redis down',
      }),
    );
  });

  it('handles non-Error thrown values during invalidation', async () => {
    mockInvalidateUserCache.mockRejectedValue('unknown failure');

    await invalidateUserPermissions(USER_ID);

    expect(loggers.security.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'unknown failure' }),
    );
  });
});

// ===========================================================================
// invalidateDrivePermissions
// ===========================================================================
describe('invalidateDrivePermissions', () => {
  it('calls invalidateDriveCache and logs success', async () => {
    await invalidateDrivePermissions(DRIVE_ID);

    expect(mockInvalidateDriveCache).toHaveBeenCalledWith(DRIVE_ID);
    expect(loggers.security.info).toHaveBeenCalledWith(
      expect.stringContaining('Invalidated cache for drive'),
      expect.objectContaining({ driveId: DRIVE_ID }),
    );
  });

  it('logs error when invalidation fails without throwing', async () => {
    mockInvalidateDriveCache.mockRejectedValue(new Error('Cache unavailable'));

    await invalidateDrivePermissions(DRIVE_ID);

    expect(loggers.security.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to invalidate drive cache'),
      expect.objectContaining({
        driveId: DRIVE_ID,
        staleTTLSeconds: 60,
        error: 'Cache unavailable',
      }),
    );
  });

  it('handles non-Error thrown values during invalidation', async () => {
    mockInvalidateDriveCache.mockRejectedValue(null);

    await invalidateDrivePermissions(DRIVE_ID);

    expect(loggers.security.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'null' }),
    );
  });
});

// ===========================================================================
// getPermissionCacheStats
// ===========================================================================
describe('getPermissionCacheStats', () => {
  it('returns cache stats from the PermissionCache singleton', () => {
    const stats = {
      memoryEntries: 42,
      redisAvailable: true,
      maxMemoryEntries: 1000,
      memoryUsagePercent: 4,
      metrics: { hits: 100, misses: 10, invalidations: 5, invalidationFailures: 0, ttlExpirations: 3, redisErrors: 0 },
    };
    mockGetCacheStats.mockReturnValue(stats);

    const result = getPermissionCacheStats();

    expect(result).toEqual(stats);
    expect(mockGetCacheStats).toHaveBeenCalled();
  });

  it('returns whatever getCacheStats provides (no transformation)', () => {
    const minimal = { memoryEntries: 0 };
    mockGetCacheStats.mockReturnValue(minimal);

    const result = getPermissionCacheStats();

    expect(result).toBe(minimal);
  });
});
