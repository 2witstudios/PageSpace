import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db, users, pages, drives, pagePermissions, driveMembers, eq } from '@pagespace/db';
import { getUserAccessLevel, canUserViewPage, canUserEditPage, canUserDeletePage, canUserSharePage } from '../permissions';
import { createId } from '@paralleldrive/cuid2';

describe('Zero-Trust Permission Boundaries (Integration)', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>;
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>;
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>;
  let testPage: Awaited<ReturnType<typeof factories.createPage>>;

  beforeEach(async () => {
    testUser = await factories.createUser();
    otherUser = await factories.createUser();
    testDrive = await factories.createDrive(testUser.id);
    testPage = await factories.createPage(testDrive.id);
  });

  afterEach(async () => {
    // Clean up only our test data to avoid interfering with parallel tests
    // Silent catch on each to ensure all cleanup runs even if one fails
    if (testPage) await db.delete(pagePermissions).where(eq(pagePermissions.pageId, testPage.id)).catch(() => {});
    if (testDrive) {
      await db.delete(pages).where(eq(pages.driveId, testDrive.id)).catch(() => {});
      await db.delete(driveMembers).where(eq(driveMembers.driveId, testDrive.id)).catch(() => {});
      await db.delete(drives).where(eq(drives.id, testDrive.id)).catch(() => {});
    }
    if (testUser) await db.delete(users).where(eq(users.id, testUser.id)).catch(() => {});
    if (otherUser) await db.delete(users).where(eq(users.id, otherUser.id)).catch(() => {});
  });

  describe('expired permission enforcement', () => {
    it('given permission with past expiresAt, should deny access', async () => {
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

      const result = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(result).toBeNull();
    });

    it('given permission with expiresAt in distant past, should deny access', async () => {
      const yearAgo = new Date('2020-01-01');

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        expiresAt: yearAgo,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(result).toBeNull();
    });

    it('given permission expiring at NOW boundary, should deny access', async () => {
      vi.useFakeTimers();
      try {
        const baseNow = new Date('2026-01-01T00:00:00.000Z');
        vi.setSystemTime(baseNow);
        const now = new Date();

        await factories.createPagePermission(testPage.id, otherUser.id, {
          canView: true,
          canEdit: true,
          canShare: true,
          canDelete: true,
          expiresAt: now,
          grantedBy: testUser.id,
        });

        await vi.advanceTimersByTimeAsync(50);

        const result = await getUserAccessLevel(otherUser.id, testPage.id);
        expect(result).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('non-expired permissions honored', () => {
    it('given permission with future expiresAt, should grant access', async () => {
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

      expect(result).not.toBeNull();
      expect(result?.canView).toBe(true);
      expect(result?.canEdit).toBe(true);
      expect(result?.canShare).toBe(false);
      expect(result?.canDelete).toBe(false);
    });

    it('given permission with null expiresAt (never expires), should grant access', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        expiresAt: null,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).not.toBeNull();
      expect(result?.canView).toBe(true);
      expect(result?.canEdit).toBe(true);
      expect(result?.canShare).toBe(true);
      expect(result?.canDelete).toBe(true);
    });

    it('given permission expiring far in future, should grant access', async () => {
      const nextYear = new Date();
      nextYear.setFullYear(nextYear.getFullYear() + 1);

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        expiresAt: nextYear,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).not.toBeNull();
      expect(result?.canView).toBe(true);
    });
  });

  describe('owner always has full access', () => {
    it('given drive owner, should have full access to all pages in drive', async () => {
      const result = await getUserAccessLevel(testUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given drive owner with explicit lower permissions, should still have full access', async () => {
      await factories.createPagePermission(testPage.id, testUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: otherUser.id,
      });

      const result = await getUserAccessLevel(testUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given drive owner, should access all pages regardless of type', async () => {
      const folderPage = await factories.createPage(testDrive.id, { type: 'FOLDER' });
      const aiChatPage = await factories.createPage(testDrive.id, {
        type: 'AI_CHAT',
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-sonnet',
      });

      const folderAccess = await getUserAccessLevel(testUser.id, folderPage.id);
      const aiChatAccess = await getUserAccessLevel(testUser.id, aiChatPage.id);

      expect(folderAccess?.canEdit).toBe(true);
      expect(aiChatAccess?.canEdit).toBe(true);
    });
  });

  describe('non-owner denied without explicit permissions', () => {
    it('given non-owner without any permissions, should return null', async () => {
      const result = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(result).toBeNull();
    });

    it('given random user not in system, should return null for any page', async () => {
      const randomUserId = createId();
      const result = await getUserAccessLevel(randomUserId, testPage.id);
      expect(result).toBeNull();
    });

    it('given non-owner with view-only permission, should not have edit access', async () => {
      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result?.canView).toBe(true);
      expect(result?.canEdit).toBe(false);
      expect(result?.canShare).toBe(false);
      expect(result?.canDelete).toBe(false);
    });
  });

  describe('admin role grants full access', () => {
    it('given user with ADMIN role on drive, should have full access to all pages', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given ADMIN with explicit lower permissions, should still have full access', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });
    });

    it('given ADMIN, should have access to all pages in drive', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });

      const secondPage = await factories.createPage(testDrive.id);
      const thirdPage = await factories.createPage(testDrive.id);

      const access1 = await getUserAccessLevel(otherUser.id, testPage.id);
      const access2 = await getUserAccessLevel(otherUser.id, secondPage.id);
      const access3 = await getUserAccessLevel(otherUser.id, thirdPage.id);

      expect(access1?.canEdit).toBe(true);
      expect(access2?.canEdit).toBe(true);
      expect(access3?.canEdit).toBe(true);
    });
  });

  describe('MEMBER role requires explicit page permissions', () => {
    it('given user with MEMBER role on drive, should NOT auto-access pages', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'MEMBER' });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toBeNull();
    });

    it('given MEMBER with explicit page permission, should have that access level', async () => {
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
      expect(result?.canDelete).toBe(false);
    });

    it('given MEMBER, should only access pages with explicit permissions', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'MEMBER' });

      const secondPage = await factories.createPage(testDrive.id);

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const access1 = await getUserAccessLevel(otherUser.id, testPage.id);
      const access2 = await getUserAccessLevel(otherUser.id, secondPage.id);

      expect(access1?.canView).toBe(true);
      expect(access2).toBeNull();
    });
  });

  describe('input validation boundary', () => {
    it('given null userId, should deny access', async () => {
      const result = await getUserAccessLevel(null, testPage.id);
      expect(result).toBeNull();
    });

    it('given undefined userId, should deny access', async () => {
      const result = await getUserAccessLevel(undefined, testPage.id);
      expect(result).toBeNull();
    });

    it('given empty string userId, should deny access', async () => {
      const result = await getUserAccessLevel('', testPage.id);
      expect(result).toBeNull();
    });

    it('given SQL injection attempt in userId, should deny access safely', async () => {
      const result = await getUserAccessLevel("'; DROP TABLE users; --", testPage.id);
      expect(result).toBeNull();
    });

    it('given null pageId, should deny access', async () => {
      const result = await getUserAccessLevel(testUser.id, null);
      expect(result).toBeNull();
    });

    it('given empty string pageId, should deny access', async () => {
      const result = await getUserAccessLevel(testUser.id, '');
      expect(result).toBeNull();
    });

    it('given numeric input for userId, should deny access', async () => {
      const result = await getUserAccessLevel(12345, testPage.id);
      expect(result).toBeNull();
    });

    it('given object input for pageId, should deny access', async () => {
      const result = await getUserAccessLevel(testUser.id, { $ne: '' });
      expect(result).toBeNull();
    });

    it('given excessively long userId, should deny access', async () => {
      const longId = 'a'.repeat(1000);
      const result = await getUserAccessLevel(longId, testPage.id);
      expect(result).toBeNull();
    });

    it('given excessively long pageId, should deny access', async () => {
      const longId = 'a'.repeat(1000);
      const result = await getUserAccessLevel(testUser.id, longId);
      expect(result).toBeNull();
    });
  });

  describe('convenience functions deny by default', () => {
    it('canUserViewPage returns false for invalid userId', async () => {
      const result = await canUserViewPage('', testPage.id);
      expect(result).toBe(false);
    });

    it('canUserEditPage returns false for invalid userId', async () => {
      const result = await canUserEditPage('', testPage.id);
      expect(result).toBe(false);
    });

    it('canUserSharePage returns false for invalid userId', async () => {
      const result = await canUserSharePage('', testPage.id);
      expect(result).toBe(false);
    });

    it('canUserDeletePage returns false for invalid userId', async () => {
      const result = await canUserDeletePage('', testPage.id);
      expect(result).toBe(false);
    });

    it('canUserViewPage returns false for user without permissions', async () => {
      const result = await canUserViewPage(otherUser.id, testPage.id);
      expect(result).toBe(false);
    });

    it('canUserViewPage returns true for user with view permission', async () => {
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
  });

  describe('non-existent resource handling', () => {
    it('given non-existent page (valid CUID2), should return null', async () => {
      const nonExistentPageId = createId();
      const result = await getUserAccessLevel(testUser.id, nonExistentPageId);
      expect(result).toBeNull();
    });

    it('given non-existent page, canUserViewPage returns false', async () => {
      const nonExistentPageId = createId();
      const result = await canUserViewPage(testUser.id, nonExistentPageId);
      expect(result).toBe(false);
    });

    it('given non-existent user but valid page, should return null', async () => {
      const nonExistentUserId = createId();
      const result = await getUserAccessLevel(nonExistentUserId, testPage.id);
      expect(result).toBeNull();
    });
  });

  describe('permission revocation scenarios', () => {
    it('given permission deleted from DB, should deny access', async () => {
      const permission = await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      const beforeRevoke = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(beforeRevoke?.canView).toBe(true);

      await db.delete(pagePermissions).where(eq(pagePermissions.id, permission.id));

      const afterRevoke = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(afterRevoke).toBeNull();
    });

    it('given permission expired after initial grant, should deny access', async () => {
      vi.useFakeTimers();
      try {
        const baseNow = new Date('2026-01-01T00:00:00.000Z');
        vi.setSystemTime(baseNow);
        const expiresIn500ms = new Date(Date.now() + 500);

        await factories.createPagePermission(testPage.id, otherUser.id, {
          canView: true,
          canEdit: true,
          canShare: false,
          canDelete: false,
          expiresAt: expiresIn500ms,
          grantedBy: testUser.id,
        });

        const beforeExpiry = await getUserAccessLevel(otherUser.id, testPage.id);
        expect(beforeExpiry?.canView).toBe(true);

        await vi.advanceTimersByTimeAsync(700);

        const afterExpiry = await getUserAccessLevel(otherUser.id, testPage.id);
        expect(afterExpiry).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
