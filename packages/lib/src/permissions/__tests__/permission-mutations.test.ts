import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { grantPagePermission, revokePagePermission } from '../permission-mutations';
import { EnforcedAuthContext } from '../enforced-context';
import type { SessionClaims } from '../../auth/session-service';
import { factories } from '@pagespace/db/test/factories';
import { db, users, pagePermissions, driveMembers, pages, drives, eq, and } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// Generate fake but valid CUID2 IDs for "non-existent" entity tests
const nonExistentPageId = createId();
const nonExistentUserId = createId();

const createMockClaims = (userId: string, overrides: Partial<SessionClaims> = {}): SessionClaims => ({
  sessionId: 'test-session-id',
  userId,
  userRole: 'user',
  tokenVersion: 1,
  adminRoleVersion: 0,
  type: 'user',
  scopes: ['*'],
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  driveId: undefined,
  ...overrides,
});

describe('permission-mutations zero-trust', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>;
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>;
  let targetUser: Awaited<ReturnType<typeof factories.createUser>>;
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>;
  let testPage: Awaited<ReturnType<typeof factories.createPage>>;

  beforeEach(async () => {
    // Delete in foreign key order to avoid deadlocks from cascade contention
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);

    testUser = await factories.createUser();
    otherUser = await factories.createUser();
    targetUser = await factories.createUser();
    testDrive = await factories.createDrive(testUser.id);
    testPage = await factories.createPage(testDrive.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('grantPagePermission', () => {
    describe('validation', () => {
      it('rejects invalid pageId format', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: 'not-a-uuid',
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION_FAILED');
        }
      });

      it('rejects invalid targetUserId format', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: 'not-a-uuid',
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION_FAILED');
        }
      });

      it('rejects missing required fields', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION_FAILED');
        }
      });

      it('validates before making DB queries (ordering check)', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const dbSelectSpy = vi.spyOn(db, 'select');

        await grantPagePermission(ctx, {
          pageId: 'invalid-id',
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(dbSelectSpy).not.toHaveBeenCalled();
      });
    });

    describe('business rules', () => {
      it('rejects invalid permission combination (edit without view)', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: false, canEdit: true, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_PERMISSION_COMBINATION');
        }
      });

      it('rejects invalid permission combination (share without view)', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: false, canEdit: false, canShare: true, canDelete: false },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_PERMISSION_COMBINATION');
        }
      });

      it('rejects invalid permission combination (delete without view)', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: false, canEdit: false, canShare: false, canDelete: true },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_PERMISSION_COMBINATION');
        }
      });

      it('rejects self-grant', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: testUser.id,
          permissions: { canView: true, canEdit: true, canShare: true, canDelete: true },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('SELF_PERMISSION_DENIED');
        }
      });
    });

    describe('authorization', () => {
      it('returns PAGE_NOT_ACCESSIBLE when user lacks share permission', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('PAGE_NOT_ACCESSIBLE');
        }
      });

      it('returns PAGE_NOT_ACCESSIBLE for non-existent page', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: nonExistentPageId,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('PAGE_NOT_ACCESSIBLE');
        }
      });

      it('uses ctx.userId as grantedBy (cannot be spoofed)', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(true);

        const permission = await db
          .select({ grantedBy: pagePermissions.grantedBy })
          .from(pagePermissions)
          .where(
            and(
              eq(pagePermissions.pageId, testPage.id),
              eq(pagePermissions.userId, targetUser.id)
            )
          )
          .limit(1);

        expect(permission[0].grantedBy).toBe(testUser.id);
      });

      it('allows drive owner to grant permissions', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: true, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(true);
      });

      it('allows drive admin to grant permissions', async () => {
        await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(true);
      });

      it('allows user with share permission to grant permissions', async () => {
        await factories.createPagePermission(testPage.id, otherUser.id, {
          canView: true,
          canEdit: false,
          canShare: true,
          canDelete: false,
        });
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(true);
      });
    });

    describe('existence checks', () => {
      it('returns USER_NOT_FOUND for non-existent target user', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: nonExistentUserId,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('USER_NOT_FOUND');
        }
      });
    });

    describe('success cases', () => {
      it('creates new permission record', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: true, canShare: false, canDelete: false },
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.isUpdate).toBe(false);
          expect(result.data.permissionId).toBeDefined();
        }

        const permission = await db
          .select()
          .from(pagePermissions)
          .where(
            and(
              eq(pagePermissions.pageId, testPage.id),
              eq(pagePermissions.userId, targetUser.id)
            )
          )
          .limit(1);

        expect(permission.length).toBe(1);
        expect(permission[0].canView).toBe(true);
        expect(permission[0].canEdit).toBe(true);
        expect(permission[0].canShare).toBe(false);
        expect(permission[0].canDelete).toBe(false);
      });

      it('updates existing permission record', async () => {
        const existing = await factories.createPagePermission(testPage.id, targetUser.id, {
          canView: true,
          canEdit: false,
          canShare: false,
          canDelete: false,
        });

        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: true, canShare: true, canDelete: false },
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.isUpdate).toBe(true);
          expect(result.data.permissionId).toBe(existing.id);
        }

        const permission = await db
          .select()
          .from(pagePermissions)
          .where(eq(pagePermissions.id, existing.id))
          .limit(1);

        expect(permission[0].canEdit).toBe(true);
        expect(permission[0].canShare).toBe(true);
      });
    });

    describe('security (info leak prevention)', () => {
      it('returns same error for missing page and unauthorized access', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const missingResult = await grantPagePermission(ctx, {
          pageId: nonExistentPageId,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        const unauthorizedResult = await grantPagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        });

        expect(missingResult.ok).toBe(false);
        expect(unauthorizedResult.ok).toBe(false);
        if (!missingResult.ok && !unauthorizedResult.ok) {
          expect(missingResult.error.code).toBe('PAGE_NOT_ACCESSIBLE');
          expect(unauthorizedResult.error.code).toBe('PAGE_NOT_ACCESSIBLE');
        }
      });
    });
  });

  describe('revokePagePermission', () => {
    describe('validation', () => {
      it('rejects invalid pageId format', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: 'not-a-uuid',
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION_FAILED');
        }
      });

      it('rejects invalid targetUserId format', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: 'not-a-uuid',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION_FAILED');
        }
      });
    });

    describe('business rules', () => {
      it('rejects self-revoke', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: testUser.id,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('SELF_PERMISSION_DENIED');
        }
      });
    });

    describe('authorization', () => {
      it('returns PAGE_NOT_ACCESSIBLE when user lacks share permission', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('PAGE_NOT_ACCESSIBLE');
        }
      });

      it('returns PAGE_NOT_ACCESSIBLE for non-existent page', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: nonExistentPageId,
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('PAGE_NOT_ACCESSIBLE');
        }
      });
    });

    describe('idempotency', () => {
      it('returns success with revoked: false when permission does not exist', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.revoked).toBe(false);
          if (!result.data.revoked) {
            expect(result.data.reason).toBe('not_found');
          }
        }
      });

      it('succeeds twice in a row (idempotent)', async () => {
        await factories.createPagePermission(testPage.id, targetUser.id, {
          canView: true,
          canEdit: true,
        });

        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result1 = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        const result2 = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(result1.ok).toBe(true);
        expect(result2.ok).toBe(true);
        if (result1.ok && result2.ok) {
          expect(result1.data.revoked).toBe(true);
          expect(result2.data.revoked).toBe(false);
        }
      });
    });

    describe('success cases', () => {
      it('deletes existing permission record', async () => {
        const existing = await factories.createPagePermission(testPage.id, targetUser.id, {
          canView: true,
          canEdit: true,
          canShare: false,
          canDelete: false,
        });

        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.revoked).toBe(true);
          if (result.data.revoked) {
            expect(result.data.permissionId).toBe(existing.id);
          }
        }

        const permission = await db
          .select()
          .from(pagePermissions)
          .where(eq(pagePermissions.id, existing.id))
          .limit(1);

        expect(permission.length).toBe(0);
      });

      it('allows drive owner to revoke permissions', async () => {
        await factories.createPagePermission(testPage.id, targetUser.id, {
          canView: true,
        });

        const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(true);
      });

      it('allows drive admin to revoke permissions', async () => {
        await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' });
        await factories.createPagePermission(testPage.id, targetUser.id, {
          canView: true,
        });

        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(true);
      });

      it('allows user with share permission to revoke permissions', async () => {
        await factories.createPagePermission(testPage.id, otherUser.id, {
          canView: true,
          canShare: true,
        });
        await factories.createPagePermission(testPage.id, targetUser.id, {
          canView: true,
        });

        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const result = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(result.ok).toBe(true);
      });
    });

    describe('security (info leak prevention)', () => {
      it('returns same error for missing page and unauthorized access', async () => {
        const ctx = EnforcedAuthContext.fromSession(createMockClaims(otherUser.id));

        const missingResult = await revokePagePermission(ctx, {
          pageId: nonExistentPageId,
          targetUserId: targetUser.id,
        });

        const unauthorizedResult = await revokePagePermission(ctx, {
          pageId: testPage.id,
          targetUserId: targetUser.id,
        });

        expect(missingResult.ok).toBe(false);
        expect(unauthorizedResult.ok).toBe(false);
        if (!missingResult.ok && !unauthorizedResult.ok) {
          expect(missingResult.error.code).toBe('PAGE_NOT_ACCESSIBLE');
          expect(unauthorizedResult.error.code).toBe('PAGE_NOT_ACCESSIBLE');
        }
      });
    });
  });

  describe('EnforcedAuthContext security', () => {
    it('context is immutable (cannot be modified)', () => {
      const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

      expect(Object.isFrozen(ctx)).toBe(true);

      expect(() => {
        // @ts-expect-error - Testing immutability
        ctx.userId = 'hacked-user-id';
      }).toThrow();
    });

    it('userId cannot be spoofed via input', async () => {
      const ctx = EnforcedAuthContext.fromSession(createMockClaims(testUser.id));

      const result = await grantPagePermission(ctx, {
        pageId: testPage.id,
        targetUserId: targetUser.id,
        permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        grantedBy: otherUser.id,
      } as unknown);

      expect(result.ok).toBe(true);

      const permission = await db
        .select({ grantedBy: pagePermissions.grantedBy })
        .from(pagePermissions)
        .where(
          and(
            eq(pagePermissions.pageId, testPage.id),
            eq(pagePermissions.userId, targetUser.id)
          )
        )
        .limit(1);

      expect(permission[0].grantedBy).toBe(testUser.id);
      expect(permission[0].grantedBy).not.toBe(otherUser.id);
    });
  });
});
