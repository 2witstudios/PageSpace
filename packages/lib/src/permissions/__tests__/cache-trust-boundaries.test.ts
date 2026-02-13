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
import { createId } from '@paralleldrive/cuid2';

describe('Cache Trust Boundaries (Integration)', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>;
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>;
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>;
  let testPage: Awaited<ReturnType<typeof factories.createPage>>;

  beforeEach(async () => {
    await PermissionCache.getInstance().clearAll();
    PermissionCache.getInstance().resetMetrics();

    testUser = await factories.createUser();
    otherUser = await factories.createUser();
    testDrive = await factories.createDrive(testUser.id);
    testPage = await factories.createPage(testDrive.id);
  });

  afterEach(async () => {
    await PermissionCache.getInstance().clearAll();
    // Clean up only our test data to avoid interfering with parallel tests
    if (testDrive) {
      await db.delete(pagePermissions).where(eq(pagePermissions.pageId, testPage.id)).catch(() => {});
      await db.delete(pages).where(eq(pages.driveId, testDrive.id)).catch(() => {});
      await db.delete(driveMembers).where(eq(driveMembers.driveId, testDrive.id)).catch(() => {});
      await db.delete(drives).where(eq(drives.id, testDrive.id)).catch(() => {});
    }
    if (testUser) await db.delete(users).where(eq(users.id, testUser.id)).catch(() => {});
    if (otherUser) await db.delete(users).where(eq(users.id, otherUser.id)).catch(() => {});
  });

  describe('bypassCache enforcement', () => {
    it('given bypassCache: true, should return fresh data from database', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canEdit).toBe(true);

      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });

    it('given bypassCache: true after permission downgrade, should reflect downgrade', async () => {
      const permission = await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        grantedBy: testUser.id,
      });

      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canEdit).toBe(true);
      expect(cached?.canShare).toBe(true);

      await db.update(pagePermissions)
        .set({ canEdit: false, canShare: false, canDelete: false })
        .where(eq(pagePermissions.id, permission.id));

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

  describe('cache miss fallthrough', () => {
    it('given empty cache, should query database and return correct permissions', async () => {
      await PermissionCache.getInstance().clearAll();

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
      await getUserAccessLevel(testUser.id, testPage.id);

      const result = await getUserAccessLevel(testUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given non-owner, should not impersonate owner through cache', async () => {
      await getUserAccessLevel(testUser.id, testPage.id);

      const otherResult = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(otherResult).toBeNull();
    });
  });

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
      const member = await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });

      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canEdit).toBe(true);

      await db.delete(driveMembers).where(eq(driveMembers.id, member.id));

      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });
  });

  describe('cache invalidation', () => {
    it('invalidateUserPermissions should clear user cache', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const before = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(before?.canEdit).toBe(true);

      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      await invalidateUserPermissions(otherUser.id);

      const after = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(after).toBeNull();
    });

    it('invalidateDrivePermissions should clear drive cache', async () => {
      await getUserAccessLevel(testUser.id, testPage.id);

      const newPage = await factories.createPage(testDrive.id);

      await invalidateDrivePermissions(testDrive.id);

      const result = await getUserAccessLevel(testUser.id, newPage.id);
      expect(result?.canEdit).toBe(true);
    });

    it('cache invalidation failure should not throw', async () => {
      await expect(invalidateUserPermissions('nonexistent-user')).resolves.toBeUndefined();
      await expect(invalidateDrivePermissions('nonexistent-drive')).resolves.toBeUndefined();
    });
  });

  describe('stale permission prevention', () => {
    it('given cached elevated permissions then DB shows denied, bypassCache returns denied', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        grantedBy: testUser.id,
      });

      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canDelete).toBe(true);

      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });

    it('given permission expired after caching, bypassCache returns null', async () => {
      const expiresIn500ms = new Date(Date.now() + 500);

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        expiresAt: expiresIn500ms,
        grantedBy: testUser.id,
      });

      const cached = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(cached?.canView).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 700));

      const fresh = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true });
      expect(fresh).toBeNull();
    });
  });

  describe('page not found through cache', () => {
    it('given non-existent page, should return null', async () => {
      const nonExistentPageId = createId();

      const result = await getUserAccessLevel(testUser.id, nonExistentPageId);
      expect(result).toBeNull();
    });

    it('given non-existent page with bypassCache, should return null', async () => {
      const nonExistentPageId = createId();

      const result = await getUserAccessLevel(testUser.id, nonExistentPageId, { bypassCache: true });
      expect(result).toBeNull();
    });
  });

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

      const before = await canUserViewPage(otherUser.id, testPage.id);
      expect(before).toBe(true);

      await db.delete(pagePermissions).where(eq(pagePermissions.userId, otherUser.id));

      const after = await canUserViewPage(otherUser.id, testPage.id, { bypassCache: true });
      expect(after).toBe(false);
    });
  });

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
