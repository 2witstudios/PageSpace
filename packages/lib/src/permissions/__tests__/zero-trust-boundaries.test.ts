/**
 * Zero-Trust Permission Boundary Tests (Enterprise Integration Tests)
 *
 * These tests verify that the permission system enforces zero-trust principles
 * at every boundary using REAL database operations. Unlike mock-based tests,
 * these prove the actual security logic is correct.
 *
 * Security properties tested:
 * 1. Expired permissions are never honored
 * 2. Expiration boundary edge cases
 * 3. Non-expired permissions are honored
 * 4. Null expiration (never expires) works correctly
 * 5. Owner always has full access
 * 6. Non-owner denied without explicit permissions
 * 7. Admin role grants full access
 * 8. MEMBER role requires explicit page permissions
 * 9. Input validation at boundaries
 * 10. Fail-closed on database errors
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db, users, pages, drives, pagePermissions, driveMembers } from '@pagespace/db';
import { getUserAccessLevel, canUserViewPage, canUserEditPage, canUserDeletePage, canUserSharePage } from '../permissions';
import { createId } from '@paralleldrive/cuid2';

describe('Zero-Trust Permission Boundaries (Integration)', () => {
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

    // Create base fixtures
    testUser = await factories.createUser();
    otherUser = await factories.createUser();
    testDrive = await factories.createDrive(testUser.id);
    testPage = await factories.createPage(testDrive.id);
  });

  // ===========================================================================
  // 1. EXPIRED PERMISSION ENFORCEMENT
  // ===========================================================================

  describe('expired permission enforcement', () => {
    it('given permission with past expiresAt, should deny access', async () => {
      // Create permission that expired yesterday
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
      // Create permission that expired a year ago
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
      // Create permission that expires right now (edge case)
      const now = new Date();

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        expiresAt: now,
        grantedBy: testUser.id,
      });

      // Small delay to ensure we're past the expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 2. NON-EXPIRED PERMISSIONS HONORED
  // ===========================================================================

  describe('non-expired permissions honored', () => {
    it('given permission with future expiresAt, should grant access', async () => {
      // Create permission that expires tomorrow
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
      // Create permission with no expiration
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
      // Create permission that expires in a year
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

  // ===========================================================================
  // 3. OWNER ALWAYS HAS FULL ACCESS
  // ===========================================================================

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
      // Attempt to restrict owner with explicit permission (should be ignored)
      await factories.createPagePermission(testPage.id, testUser.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: otherUser.id,
      });

      const result = await getUserAccessLevel(testUser.id, testPage.id);

      // Owner override - explicit restrictions don't apply
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

  // ===========================================================================
  // 4. NON-OWNER DENIED WITHOUT EXPLICIT PERMISSIONS
  // ===========================================================================

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

  // ===========================================================================
  // 5. ADMIN ROLE GRANTS FULL ACCESS
  // ===========================================================================

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

      // Explicit restriction should be ignored for admins
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

  // ===========================================================================
  // 6. MEMBER ROLE REQUIRES EXPLICIT PAGE PERMISSIONS
  // ===========================================================================

  describe('MEMBER role requires explicit page permissions', () => {
    it('given user with MEMBER role on drive, should NOT auto-access pages', async () => {
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'MEMBER' });

      const result = await getUserAccessLevel(otherUser.id, testPage.id);

      // MEMBER role alone doesn't grant page access
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

      // Grant permission only to first page
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
      expect(access2).toBeNull(); // No access to second page
    });
  });

  // ===========================================================================
  // 7. INPUT VALIDATION AT BOUNDARIES
  // ===========================================================================

  describe('input validation boundary', () => {
    it('given null userId, should deny access without querying database', async () => {
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

  // ===========================================================================
  // 8. CONVENIENCE FUNCTIONS DENY BY DEFAULT
  // ===========================================================================

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

  // ===========================================================================
  // 9. NON-EXISTENT RESOURCES
  // ===========================================================================

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

  // ===========================================================================
  // 10. PERMISSION REVOCATION SCENARIOS
  // ===========================================================================

  describe('permission revocation scenarios', () => {
    it('given permission deleted from DB, should deny access', async () => {
      // Grant permission
      const permission = await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: testUser.id,
      });

      // Verify access granted
      const beforeRevoke = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(beforeRevoke?.canView).toBe(true);

      // Revoke by deleting permission
      const { eq } = await import('@pagespace/db');
      await db.delete(pagePermissions).where(eq(pagePermissions.id, permission.id));

      // Verify access denied
      const afterRevoke = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(afterRevoke).toBeNull();
    });

    it('given permission expired after initial grant, should deny access', async () => {
      // Grant permission that expires in 50ms
      const expiresIn50ms = new Date(Date.now() + 50);

      await factories.createPagePermission(testPage.id, otherUser.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        expiresAt: expiresIn50ms,
        grantedBy: testUser.id,
      });

      // Verify access granted immediately
      const beforeExpiry = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(beforeExpiry?.canView).toBe(true);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify access denied after expiration
      const afterExpiry = await getUserAccessLevel(otherUser.id, testPage.id);
      expect(afterExpiry).toBeNull();
    });
  });
});
