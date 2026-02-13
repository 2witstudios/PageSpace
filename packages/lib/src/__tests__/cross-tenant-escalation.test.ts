/**
 * Cross-Tenant Escalation & Data Leakage Tests (Enterprise Integration Tests)
 *
 * Zero-trust tests that prove cross-tenant isolation at every seam using REAL
 * database operations. These create actual multi-tenant data scenarios and verify
 * that authorization boundaries cannot be bypassed.
 *
 * Security properties tested:
 * 1. IDOR: Forged page/drive IDs cannot access other tenants
 * 2. Drive membership isolation: Admin of driveA has NO access to driveB
 * 3. Page collaborator containment: Page permission doesn't grant drive access
 * 4. Enumeration prevention: All unauthorized pages return null (no info leak)
 * 5. Scope isolation in EnforcedAuthContext
 * 6. Resource binding enforcement
 * 7. Fail-closed on ambiguous state
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db, users, pages, drives, pagePermissions, driveMembers } from '@pagespace/db';
import { getUserAccessLevel, getUserDriveAccess } from '../permissions/permissions';
import { getUserDrivePermissions } from '../permissions/permissions-cached';
import { EnforcedAuthContext } from '../permissions/enforced-context';
import type { SessionClaims } from '../auth/session-service';
import { PermissionCache } from '../services/permission-cache';

// Helper to create session claims
function createClaims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sessionId: 'session-test',
    userId: 'user-test',
    userRole: 'user',
    tokenVersion: 1,
    adminRoleVersion: 0,
    type: 'user',
    scopes: ['*'],
    expiresAt: new Date(Date.now() + 3600000),
    ...overrides,
  };
}

describe('Cross-Tenant Escalation Prevention (Integration)', () => {
  // Alice owns driveA with pageA
  let alice: Awaited<ReturnType<typeof factories.createUser>>;
  let driveA: Awaited<ReturnType<typeof factories.createDrive>>;
  let pageA: Awaited<ReturnType<typeof factories.createPage>>;

  // Bob owns driveB with pageB
  let bob: Awaited<ReturnType<typeof factories.createUser>>;
  let driveB: Awaited<ReturnType<typeof factories.createDrive>>;
  let pageB: Awaited<ReturnType<typeof factories.createPage>>;

  // Mallory is an attacker with no drives
  let mallory: Awaited<ReturnType<typeof factories.createUser>>;

  beforeEach(async () => {
    // Clean in FK order to avoid deadlocks from cascade contention
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);

    // Clear permission cache
    await PermissionCache.getInstance().clearAll();

    // Create multi-tenant scenario
    alice = await factories.createUser();
    bob = await factories.createUser();
    mallory = await factories.createUser();

    driveA = await factories.createDrive(alice.id);
    driveB = await factories.createDrive(bob.id);

    pageA = await factories.createPage(driveA.id);
    pageB = await factories.createPage(driveB.id);
  });

  // ===========================================================================
  // 1. IDOR VIA FORGED PAGE IDS
  // ===========================================================================

  describe('IDOR via forged page IDs', () => {
    it('given Mallory supplies Alices page ID, should return null (no access)', async () => {
      const access = await getUserAccessLevel(mallory.id, pageA.id);

      expect(access).toBeNull();
    });

    it('given Bob supplies Alices page ID, should return null even though Bob is a drive owner', async () => {
      // Bob owns driveB but NOT driveA
      const access = await getUserAccessLevel(bob.id, pageA.id);

      expect(access).toBeNull();
    });

    it('given Alice supplies Bobs page ID, should return null', async () => {
      const access = await getUserAccessLevel(alice.id, pageB.id);

      expect(access).toBeNull();
    });

    it('given attacker enumerates page IDs, all should return null (no info leak)', async () => {
      // Create additional pages
      const pageA2 = await factories.createPage(driveA.id);
      const pageB2 = await factories.createPage(driveB.id);

      // Mallory tries multiple page IDs
      const results = await Promise.all([
        getUserAccessLevel(mallory.id, pageA.id),
        getUserAccessLevel(mallory.id, pageA2.id),
        getUserAccessLevel(mallory.id, pageB.id),
        getUserAccessLevel(mallory.id, pageB2.id),
      ]);

      // All return null - cannot distinguish which exist or who owns them
      expect(results.every((r) => r === null)).toBe(true);
    });

    it('given non-existent page ID, should return same null as existing unauthorized page', async () => {
      const { createId } = await import('@paralleldrive/cuid2');
      const nonExistentPageId = createId();

      // Both should return null - no info leak
      const existingUnauthorized = await getUserAccessLevel(mallory.id, pageA.id);
      const nonExistent = await getUserAccessLevel(mallory.id, nonExistentPageId);

      expect(existingUnauthorized).toBeNull();
      expect(nonExistent).toBeNull();
    });
  });

  // ===========================================================================
  // 2. DRIVE ACCESS ISOLATION
  // ===========================================================================

  describe('drive access isolation', () => {
    it('given Alice is owner of driveA, she should NOT have access to driveB', async () => {
      const aliceDriveA = await getUserDrivePermissions(alice.id, driveA.id);
      const aliceDriveB = await getUserDrivePermissions(alice.id, driveB.id);

      expect(aliceDriveA?.isOwner).toBe(true);
      expect(aliceDriveB).toBeNull();
    });

    it('given Bob is owner of driveB, he should NOT have access to driveA', async () => {
      const bobDriveB = await getUserDrivePermissions(bob.id, driveB.id);
      const bobDriveA = await getUserDrivePermissions(bob.id, driveA.id);

      expect(bobDriveB?.isOwner).toBe(true);
      expect(bobDriveA).toBeNull();
    });

    it('given Bob is ADMIN of driveB, should NOT grant any access to driveA', async () => {
      // Make Bob an admin of his own drive (not owner for this test)
      const charlie = await factories.createUser();
      const driveC = await factories.createDrive(charlie.id);
      await factories.createDriveMember(driveC.id, bob.id, { role: 'ADMIN' });

      const bobDriveC = await getUserDrivePermissions(bob.id, driveC.id);
      const bobDriveA = await getUserDrivePermissions(bob.id, driveA.id);

      expect(bobDriveC?.isAdmin).toBe(true);
      expect(bobDriveA).toBeNull();
    });

    it('given MEMBER role in driveB, should NOT grant access to driveA pages', async () => {
      await factories.createDriveMember(driveB.id, mallory.id, { role: 'MEMBER' });

      // MEMBER of driveB
      const malloryDriveB = await getUserDriveAccess(mallory.id, driveB.id);
      expect(malloryDriveB).toBe(true);

      // But NO access to driveA pages
      const malloryPageA = await getUserAccessLevel(mallory.id, pageA.id);
      expect(malloryPageA).toBeNull();
    });
  });

  // ===========================================================================
  // 3. PAGE COLLABORATOR CANNOT ESCAPE TO DRIVE LEVEL
  // ===========================================================================

  describe('page collaborator cannot escape to drive-level access', () => {
    it('given Mallory has page-level canView on Alices page, should NOT have drive access', async () => {
      // Grant page-level access to Mallory
      await factories.createPagePermission(pageA.id, mallory.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: alice.id,
      });

      // Mallory can access pageA
      const pageAccess = await getUserAccessLevel(mallory.id, pageA.id);
      expect(pageAccess?.canView).toBe(true);

      // But Mallory has NO drive-level permissions
      const drivePermissions = await getUserDrivePermissions(mallory.id, driveA.id);
      expect(drivePermissions).toBeNull();
    });

    it('given page collaborator, should NOT access other pages in same drive', async () => {
      const pageA2 = await factories.createPage(driveA.id);

      // Grant access only to pageA
      await factories.createPagePermission(pageA.id, mallory.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: alice.id,
      });

      // Mallory can access pageA
      const pageAAccess = await getUserAccessLevel(mallory.id, pageA.id);
      expect(pageAAccess?.canView).toBe(true);

      // But NOT pageA2
      const pageA2Access = await getUserAccessLevel(mallory.id, pageA2.id);
      expect(pageA2Access).toBeNull();
    });

    it('given page edit permission, should NOT grant page delete permission', async () => {
      await factories.createPagePermission(pageA.id, mallory.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: alice.id,
      });

      const access = await getUserAccessLevel(mallory.id, pageA.id);

      expect(access?.canEdit).toBe(true);
      expect(access?.canDelete).toBe(false);
    });

    it('given page share permission, should NOT grant page delete permission', async () => {
      await factories.createPagePermission(pageA.id, mallory.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: false,
        grantedBy: alice.id,
      });

      const access = await getUserAccessLevel(mallory.id, pageA.id);

      expect(access?.canShare).toBe(true);
      expect(access?.canDelete).toBe(false);
    });
  });

  // ===========================================================================
  // 4. ENFORCED CONTEXT BOUNDARY INTEGRITY
  // ===========================================================================

  describe('EnforcedAuthContext cross-tenant boundaries', () => {
    it('given context bound to Alice drive, should not match Bob drive', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
          resourceType: 'drive',
          resourceId: driveA.id,
          driveId: driveA.id,
        })
      );

      expect(ctx.isBoundToResource('drive', driveA.id)).toBe(true);
      expect(ctx.isBoundToResource('drive', driveB.id)).toBe(false);
    });

    it('given context bound to pageA, should not match pageB', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
          resourceType: 'page',
          resourceId: pageA.id,
        })
      );

      expect(ctx.isBoundToResource('page', pageA.id)).toBe(true);
      expect(ctx.isBoundToResource('page', pageB.id)).toBe(false);
    });

    it('given context with no resource binding, isBoundToResource returns true for everything', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
          // No resourceType/resourceId
        })
      );

      // Unrestricted context - callers MUST additionally check permissions
      expect(ctx.isBoundToResource('drive', driveB.id)).toBe(true);
      expect(ctx.isBoundToResource('page', pageB.id)).toBe(true);
    });

    it('given context with mismatched resource type, should deny', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
          resourceType: 'page',
          resourceId: pageA.id,
        })
      );

      // Correct type + id
      expect(ctx.isBoundToResource('page', pageA.id)).toBe(true);
      // Wrong type
      expect(ctx.isBoundToResource('drive', pageA.id)).toBe(false);
      // Wrong id
      expect(ctx.isBoundToResource('page', pageB.id)).toBe(false);
    });

    it('given frozen context, mutation attempt should throw', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
        })
      );

      expect(Object.isFrozen(ctx)).toBe(true);

      expect(() => {
        // @ts-expect-error - Testing immutability
        ctx.userId = mallory.id;
      }).toThrow();
    });
  });

  // ===========================================================================
  // 5. SCOPE ISOLATION
  // ===========================================================================

  describe('scope isolation', () => {
    it('given context with files:read scope, should not match admin:* scope', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          scopes: ['files:read'],
        })
      );

      expect(ctx.hasScope('files:read')).toBe(true);
      expect(ctx.hasScope('files:write')).toBe(false);
      expect(ctx.hasScope('admin:read')).toBe(false);
      expect(ctx.hasScope('*')).toBe(false);
    });

    it('given context with namespace wildcard, should not cross namespaces', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          scopes: ['files:*'],
        })
      );

      expect(ctx.hasScope('files:read')).toBe(true);
      expect(ctx.hasScope('files:write')).toBe(true);
      expect(ctx.hasScope('files:delete')).toBe(true);
      expect(ctx.hasScope('admin:read')).toBe(false);
      expect(ctx.hasScope('pages:read')).toBe(false);
    });

    it('given global wildcard scope, should match everything', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          scopes: ['*'],
        })
      );

      expect(ctx.hasScope('files:read')).toBe(true);
      expect(ctx.hasScope('admin:write')).toBe(true);
      expect(ctx.hasScope('anything:else')).toBe(true);
    });

    it('given empty scopes, should deny all scope checks', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          scopes: [],
        })
      );

      expect(ctx.hasScope('files:read')).toBe(false);
      expect(ctx.hasScope('*')).toBe(false);
    });
  });

  // ===========================================================================
  // 6. FAIL-CLOSED ON AMBIGUOUS STATE
  // ===========================================================================

  describe('fail-closed on ambiguous state', () => {
    it('given no permission exists, access should be denied', async () => {
      const access = await getUserAccessLevel(mallory.id, pageA.id);

      expect(access).toBeNull();
    });

    it('given no drive permission exists, access should be denied', async () => {
      const access = await getUserDrivePermissions(mallory.id, driveA.id);

      expect(access).toBeNull();
    });

    it('given non-existent drive, should return null', async () => {
      const { createId } = await import('@paralleldrive/cuid2');
      const nonExistentDriveId = createId();

      const access = await getUserDrivePermissions(alice.id, nonExistentDriveId);

      expect(access).toBeNull();
    });

    it('given drive access returns false for unknown drive, user cannot access', async () => {
      const { createId } = await import('@paralleldrive/cuid2');
      const unknownDriveId = createId();

      const access = await getUserDriveAccess(alice.id, unknownDriveId);

      expect(access).toBe(false);
    });
  });

  // ===========================================================================
  // 7. MULTI-USER PERMISSION ISOLATION
  // ===========================================================================

  describe('multi-user permission isolation', () => {
    it('given Alice grants Bob page access, Mallory still has no access', async () => {
      // Alice shares pageA with Bob
      await factories.createPagePermission(pageA.id, bob.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: alice.id,
      });

      // Bob has access
      const bobAccess = await getUserAccessLevel(bob.id, pageA.id);
      expect(bobAccess?.canView).toBe(true);

      // Mallory still has no access
      const malloryAccess = await getUserAccessLevel(mallory.id, pageA.id);
      expect(malloryAccess).toBeNull();
    });

    it('given permission granted to Bob, should not apply to Mallory even with same email domain', async () => {
      // This tests that permissions are user-ID specific, not email-based
      await factories.createPagePermission(pageA.id, bob.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: alice.id,
      });

      const malloryAccess = await getUserAccessLevel(mallory.id, pageA.id);

      expect(malloryAccess).toBeNull();
    });

    it('given multiple pages with different permissions, isolation maintained', async () => {
      const pageA2 = await factories.createPage(driveA.id);
      const pageA3 = await factories.createPage(driveA.id);

      // Grant different permissions
      await factories.createPagePermission(pageA.id, mallory.id, {
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: alice.id,
      });

      await factories.createPagePermission(pageA2.id, mallory.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        grantedBy: alice.id,
      });

      // No permission for pageA3

      const accessA = await getUserAccessLevel(mallory.id, pageA.id);
      const accessA2 = await getUserAccessLevel(mallory.id, pageA2.id);
      const accessA3 = await getUserAccessLevel(mallory.id, pageA3.id);

      expect(accessA?.canEdit).toBe(false);
      expect(accessA2?.canEdit).toBe(true);
      expect(accessA3).toBeNull();
    });
  });

  // ===========================================================================
  // 8. DRIVE MEMBERSHIP ROLE BOUNDARIES
  // ===========================================================================

  describe('drive membership role boundaries', () => {
    it('given ADMIN in driveB, should NOT be ADMIN in driveA', async () => {
      await factories.createDriveMember(driveB.id, mallory.id, { role: 'ADMIN' });

      const driveAPerms = await getUserDrivePermissions(mallory.id, driveA.id);
      const driveBPerms = await getUserDrivePermissions(mallory.id, driveB.id);

      expect(driveBPerms?.isAdmin).toBe(true);
      expect(driveAPerms).toBeNull();
    });

    it('given MEMBER in driveB, should NOT be MEMBER in driveA', async () => {
      await factories.createDriveMember(driveB.id, mallory.id, { role: 'MEMBER' });

      const driveAAccess = await getUserDriveAccess(mallory.id, driveA.id);
      const driveBAccess = await getUserDriveAccess(mallory.id, driveB.id);

      expect(driveBAccess).toBe(true);
      expect(driveAAccess).toBe(false);
    });

    it('given owner of driveA, should not have ADMIN permissions in driveB', async () => {
      // Alice owns driveA
      const aliceDriveA = await getUserDrivePermissions(alice.id, driveA.id);
      const aliceDriveB = await getUserDrivePermissions(alice.id, driveB.id);

      expect(aliceDriveA?.isOwner).toBe(true);
      expect(aliceDriveB).toBeNull(); // Not even MEMBER
    });
  });

  // ===========================================================================
  // 9. EXPIRED CROSS-TENANT PERMISSIONS
  // ===========================================================================

  describe('expired cross-tenant permissions', () => {
    it('given expired page permission, should deny even if was previously granted', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      await factories.createPagePermission(pageA.id, mallory.id, {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
        expiresAt: yesterday,
        grantedBy: alice.id,
      });

      const access = await getUserAccessLevel(mallory.id, pageA.id);

      expect(access).toBeNull();
    });

    it('given non-expired permission, cross-tenant isolation still applies to other pages', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      await factories.createPagePermission(pageA.id, mallory.id, {
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
        expiresAt: tomorrow,
        grantedBy: alice.id,
      });

      // Has access to pageA
      const accessA = await getUserAccessLevel(mallory.id, pageA.id);
      expect(accessA?.canView).toBe(true);

      // But NOT to pageB in different tenant
      const accessB = await getUserAccessLevel(mallory.id, pageB.id);
      expect(accessB).toBeNull();
    });
  });

  // ===========================================================================
  // 10. CONTEXT USER ROLE
  // ===========================================================================

  describe('context user role', () => {
    it('given user role context, isAdmin returns false', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
          userRole: 'user',
        })
      );

      expect(ctx.isAdmin()).toBe(false);
    });

    it('given admin role context, isAdmin returns true', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
          userRole: 'admin',
        })
      );

      expect(ctx.isAdmin()).toBe(true);
    });

    it('given admin role in context, should still require proper resource binding', () => {
      const ctx = EnforcedAuthContext.fromSession(
        createClaims({
          userId: alice.id,
          userRole: 'admin',
          resourceType: 'drive',
          resourceId: driveA.id,
        })
      );

      // Admin role doesn't bypass resource binding
      expect(ctx.isAdmin()).toBe(true);
      expect(ctx.isBoundToResource('drive', driveA.id)).toBe(true);
      expect(ctx.isBoundToResource('drive', driveB.id)).toBe(false);
    });
  });
});
