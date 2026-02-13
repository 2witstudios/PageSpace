/**
 * Cache Trust Boundary Tests (Enterprise Integration Tests)
 *
 * Zero-trust tests for the permission caching layer using REAL database operations.
 * These verify that cached permissions cannot be exploited to bypass authorization,
 * and that cache bypass works correctly for sensitive operations.
 *
 * Security properties tested:
 * 1. bypassCache: true always hits the database directly
 * 2. Cache miss falls through to database correctly
 * 3. Cached positive results reflect database state after bypass
 * 4. Default (non-bypass) uses cache for performance
 * 5. Drive owner identification works through cache layer
 * 6. Admin role recognized through cache layer
 * 7. Permission revocation reflected when using bypassCache
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db, users, pages, drives, pagePermissions, driveMembers, eq } from '@pagespace/db';
import {
  getUserAccessLevel,
  invalidateUserPermissions,
  invalidateDrivePermissions,
  canUserViewPage,
  canUserEditPage,
} from '../permissions-cached';
import { PermissionCache } from '../../services/permission-cache';

describe('Cache Trust Boundaries (Integration)', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>;
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>;
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>;
  let testPage: Awaited<ReturnType<typeof factories.createPage>>;

  beforeEach(async () => {
    // Clean in FK order to avoid deadlocks from cascade contention
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);

    // Clear permission cache to ensure test isolation
    await PermissionCache.getInstance().clearAll();
    PermissionCache.getInstance().resetMetrics();

    // Create base fixtures
    testUser = await factories.createUser();
    otherUser = await factories.createUser();
    testDrive = await factories.createDrive(testUser.id);
    testPage = await factories.createPage(testDrive.id);
  });

  afterEach(async () => {
    // Clear cache after each test
    await PermissionCache.getInstance().clearAll();
  });

  // ===========================================================================
  // 1. bypassCache ALWAYS HITS DATABASE
  // ===========================================================================

  describe('bypassCache enforcement', () => {
    it('given bypassCache: true, should return fresh data from database', async () => {
      // Grant permission
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      // First call with cache
      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canEdit).toBe(true);

      // Revoke permission directly in DB
      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      // bypassCache should return fresh (revoked) data
      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });

    it('given bypassCache: true after permission downgrade, should reflect downgrade', async () => {
      // Grant full permissions
      const permission = await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        grantedBy: testUser.id,
      });

      // Cache the permission
      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canEdit).toBe(true);
      expect(cached?.canShare).toBe(true);

      // Downgrade permission directly in DB
      await db.update(pagePermissions)
        .set({ canEdit: false, canShare: false, canDelete: false })
        .where(eq(pagePermissions.id, permission.id));

      // bypassCache should reflect downgrade
      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh?.canView).toBe(true);
      expect(fresh?.canEdit).toBe(false);
      expect(fresh?.canShare).toBe(false);
    });

    it('given bypassCache: true, should work for drive owner', async () => {
      const result = await getUserAccessLevel(testUser.id, testPage.id, { bypassCache: true });

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });
  });

  // ===========================================================================
  // 2. CACHE MISS FALLS THROUGH TO DATABASE
  // ===========================================================================

  describe('cache miss fallthrough', () => {
    it('given empty cache, should query database and return correct permissions', async () => {
      // Clear cache to force miss
      await PermissionCache.getInstance().clearAll();

      // Grant permission
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });
    });

    it('given empty cache, drive owner should get full permissions', async () => {
      await PermissionCache.getInstance().clearAll();

      const result = await getUserAccessLevel(testUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given empty cache and no permissions, should return null', async () => {
      await PermissionCache.getInstance().clearAll();

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 3. DRIVE OWNER IDENTIFICATION THROUGH CACHE
  // ===========================================================================

  describe('drive owner identification through cache', () => {
    it('given drive owner, should get full permissions (cache miss)', async () => {
      await PermissionCache.getInstance().clearAll();

      const result = await getUserAccessLevel(testUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given drive owner, should get full permissions (cache hit)', async () => {
      // First call caches
      await getUserAccessLevel(testUser.id, testPage.id);

      // Second call uses cache
      const result = await getUserAccessLevel(testUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given non-owner, should not impersonate owner through cache', async () => {
      // Cache owner's permissions
      await getUserAccessLevel(testUser.id, testPage.id);

      // Other user should not get owner permissions from cache
      const otherResult = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(otherResult).toBeNull();
    });
  });

  // ===========================================================================
  // 4. ADMIN ROLE THROUGH CACHE
  // ===========================================================================

  describe('admin role through cache', () => {
    it('given ADMIN member, should get full permissions (cache miss)', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });
      await PermissionCache.getInstance().clearAll();

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given ADMIN role removed, bypassCache should reflect removal', async () => {
      // Add ADMIN role
      const member = await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });

      // Cache the admin permissions
      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canEdit).toBe(true);

      // Remove admin role from DB
      await db.delete(driveMembers).where(eq(driveMembers.id, member.id));

      // bypassCache should show no access
      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });
  });

  // ===========================================================================
  // 5. CACHE INVALIDATION
  // ===========================================================================

  describe('cache invalidation', () => {
    it('invalidateUserPermissions should clear user cache', async () => {
      // Cache some permissions
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const before = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(before?.canEdit).toBe(true);

      // Revoke in DB
      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      // Invalidate cache
      await invalidateUserPermissions(otherUser.id);

      // Should now return fresh data (null)
      const after = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(after).toBeNull();
    });

    it('invalidateDrivePermissions should clear drive cache', async () => {
      // Cache owner permissions
      await getUserAccessLevel(testUser.id, testPage.id);

      // Create new page in same drive
      const newPage = await factories.createPage(testDrive.id);

      // Invalidate drive cache
      await invalidateDrivePermissions(testDrive.id);

      // Should still work (cache invalidation doesn't break functionality)
      const result = await getUserAccessLevel(testUser.id, newPage.id);
      expect(result?.canEdit).toBe(true);
    });

    it('cache invalidation failure should not throw', async () => {
      // This should not throw even if Redis is unavailable
      await expect(invalidateUserPermissions('nonexistent-user')).resolves.toBeUndefined();
      await expect(invalidateDrivePermissions('nonexistent-drive')).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // 6. STALE PERMISSION PREVENTION
  // ===========================================================================

  describe('stale permission prevention', () => {
    it('given cached elevated permissions then DB shows denied, bypassCache returns denied', async () => {
      // Grant elevated permissions
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        grantedBy: testUser.id,
      });

      // Cache the elevated permissions
      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canDelete).toBe(true);

      // Revoke ALL permissions in DB
      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      // Regular call might return stale (cached) data - this is expected for performance
      // But bypassCache MUST return fresh (denied) data
      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });

    it('given permission expired after caching, bypassCache returns null', async () => {
      // Grant permission expiring very soon
      const expiresIn50ms = new Date(Date.now() + 50);

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        expiresAt: expiresIn50ms,
        grantedBy: testUser.id,
      });

      // Cache the permission while still valid
      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canView).toBe(true);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      // bypassCache should return null (expired)
      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });
  });

  // ===========================================================================
  // 7. PAGE NOT FOUND
  // ===========================================================================

  describe('page not found through cache', () => {
    it('given non-existent page, should return null', async () => {
      const { createId } = await import('@paralleldrive/cuid2');
      const nonExistentPageId = createId();

      const result = await getUserAccessLevel(testUser.id, nonExistentPageId);

      expect(result).toBeNull();
    });

    it('given non-existent page with bypassCache, should return null', async () => {
      const { createId } = await import('@paralleldrive/cuid2');
      const nonExistentPageId = createId();

      const result = await getUserAccessLevel(testUser.id, nonExistentPageId, { bypassCache: true });

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 8. CONVENIENCE FUNCTIONS WITH CACHE
  // ===========================================================================

  describe('convenience functions with cache', () => {
    it('canUserViewPage returns true for user with permission', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const result = await canUserViewPage(otherUser.id, testPage.id);

      expect(result).toBe(true);
    });

    it('canUserEditPage returns false for user with only view permission', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const result = await canUserEditPage(otherUser.id, testPage.id);

      expect(result).toBe(false);
    });

    it('canUserViewPage with bypassCache reflects revoked permission', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      // Cache it
      const before = await canUserViewPage(otherUser.id, testPage.id);
      expect(before).toBe(true);

      // Revoke in DB
      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      // bypassCache should show revoked
      const after = await canUserViewPage(otherUser.id, testPage.id, { bypassCache: true });
      expect(after).toBe(false);
    });
  });

  // ===========================================================================
  // 9. MEMBER ROLE THROUGH CACHE
  // ===========================================================================

  describe('MEMBER role through cache', () => {
    it('given MEMBER without explicit page permission, should return null', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'MEMBER' });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toBeNull();
    });

    it('given MEMBER with explicit page permission, should return that permission', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'MEMBER' });
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result?.canView).toBe(true);
      expect(result?.canEdit).toBe(true);
      expect(result?.canShare).toBe(false);
    });
  });

  // ===========================================================================
  // 10. EXPIRED PERMISSION THROUGH CACHE
  // ===========================================================================

  describe('expired permissions through cache', () => {
    it('given expired permission, should return null even on cache miss', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        expiresAt: yesterday,
        grantedBy: testUser.id,
      });

      // Clear cache to force DB query
      await PermissionCache.getInstance().clearAll();

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toBeNull();
    });

    it('given non-expired permission, should return permissions', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        expiresAt: tomorrow,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result?.canView).toBe(true);
      expect(result?.canEdit).toBe(true);
    });
  });
});
