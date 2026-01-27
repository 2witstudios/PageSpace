/**
 * Zero-Trust Permission Mutations
 *
 * Security checks happen at the last possible moment before the side effect (DB write).
 * EnforcedAuthContext cannot be spoofed - private constructor, frozen object.
 * grantedBy is derived from ctx.userId, never accepted as parameter.
 */

import { z } from 'zod';
import { db, and, eq, pages, drives, driveMembers, pagePermissions, users } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { EnforcedAuthContext } from './enforced-context';
import { GrantInputSchema, RevokeInputSchema, type PermissionFlags } from './schemas';
import { permissionCache } from '../services/permission-cache';
import { logPermissionActivity, getActorInfo } from '../monitoring/activity-logger';

// ============================================================================
// Error Types
// ============================================================================

export type PermissionMutationError =
  | { code: 'VALIDATION_FAILED'; issues: z.ZodIssue[] }
  | { code: 'INVALID_PERMISSION_COMBINATION'; message: string }
  | { code: 'PAGE_NOT_ACCESSIBLE'; pageId: string }
  | { code: 'USER_NOT_FOUND'; userId: string }
  | { code: 'INSUFFICIENT_PERMISSION'; required: 'share' | 'admin' }
  | { code: 'SELF_PERMISSION_DENIED'; reason: string };

// ============================================================================
// Result Types
// ============================================================================

export type GrantResult =
  | { ok: true; data: { permissionId: string; isUpdate: boolean } }
  | { ok: false; error: PermissionMutationError };

export type RevokeResult =
  | { ok: true; data: { revoked: true; permissionId: string } }
  | { ok: true; data: { revoked: false; reason: 'not_found' } }
  | { ok: false; error: PermissionMutationError };

// ============================================================================
// Business Rule Validators (Pure Functions)
// ============================================================================

function validatePermissionCombination(
  permissions: PermissionFlags
): PermissionMutationError | null {
  if (
    !permissions.canView &&
    (permissions.canEdit || permissions.canShare || permissions.canDelete)
  ) {
    return {
      code: 'INVALID_PERMISSION_COMBINATION',
      message: 'Cannot grant edit/share/delete without view permission',
    };
  }
  return null;
}

function validateNotSelfGrant(
  actorId: string,
  targetUserId: string
): PermissionMutationError | null {
  if (actorId === targetUserId) {
    return {
      code: 'SELF_PERMISSION_DENIED',
      reason: 'Cannot modify your own permissions',
    };
  }
  return null;
}

// ============================================================================
// Helper: getPageIfCanShare
// ============================================================================

interface PageForSharing {
  pageId: string;
  driveId: string;
}

/**
 * Combined existence + authorization check.
 * Returns PAGE_NOT_ACCESSIBLE for both missing page and unauthorized user.
 * This prevents information leakage about page existence.
 */
async function getPageIfCanShare(
  userId: string,
  pageId: string
): Promise<{ ok: true; page: PageForSharing } | { ok: false; error: PermissionMutationError }> {
  // Get page with drive info
  const pageWithDrive = await db
    .select({
      id: pages.id,
      driveId: pages.driveId,
      driveOwnerId: drives.ownerId,
    })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, pageId))
    .limit(1);

  if (pageWithDrive.length === 0 || !pageWithDrive[0].driveId) {
    // Page doesn't exist - same error as unauthorized
    return {
      ok: false,
      error: { code: 'PAGE_NOT_ACCESSIBLE', pageId },
    };
  }

  const page = pageWithDrive[0];

  // Check if user is drive owner (can share)
  if (page.driveOwnerId === userId) {
    return {
      ok: true,
      page: { pageId: page.id, driveId: page.driveId },
    };
  }

  // Check if user is drive admin (can share)
  const adminMembership = await db
    .select({ id: driveMembers.id })
    .from(driveMembers)
    .where(
      and(
        eq(driveMembers.driveId, page.driveId),
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN')
      )
    )
    .limit(1);

  if (adminMembership.length > 0) {
    return {
      ok: true,
      page: { pageId: page.id, driveId: page.driveId },
    };
  }

  // Check if user has explicit share permission on the page
  const sharePermission = await db
    .select({ canShare: pagePermissions.canShare })
    .from(pagePermissions)
    .where(
      and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, userId)
      )
    )
    .limit(1);

  if (sharePermission.length > 0 && sharePermission[0].canShare) {
    return {
      ok: true,
      page: { pageId: page.id, driveId: page.driveId },
    };
  }

  // User cannot share - same error as page not found
  return {
    ok: false,
    error: { code: 'PAGE_NOT_ACCESSIBLE', pageId },
  };
}

// ============================================================================
// Helper: Check Target User Exists
// ============================================================================

async function checkUserExists(userId: string): Promise<boolean> {
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user.length > 0;
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Grant or update permissions for a user on a page.
 *
 * Zero-trust:
 * - ctx.userId is used as grantedBy (cannot be spoofed)
 * - Authorization check happens at point of mutation
 * - Returns Result type (authorization failures are expected, not exceptional)
 */
export async function grantPagePermission(
  ctx: EnforcedAuthContext,
  input: unknown
): Promise<GrantResult> {
  // 1. Parse (Zod validation)
  const parseResult = GrantInputSchema.safeParse(input);
  if (!parseResult.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', issues: parseResult.error.issues },
    };
  }

  const { pageId, targetUserId, permissions } = parseResult.data;

  // 2. Business rules - permission combination
  const combinationError = validatePermissionCombination(permissions);
  if (combinationError) {
    return { ok: false, error: combinationError };
  }

  // 3. Business rules - self-grant prevention
  const selfGrantError = validateNotSelfGrant(ctx.userId, targetUserId);
  if (selfGrantError) {
    return { ok: false, error: selfGrantError };
  }

  // 4. Authorization - can user share this page?
  const pageResult = await getPageIfCanShare(ctx.userId, pageId);
  if (!pageResult.ok) {
    return { ok: false, error: pageResult.error };
  }

  const { page } = pageResult;

  // 5. Target user existence check
  const userExists = await checkUserExists(targetUserId);
  if (!userExists) {
    return {
      ok: false,
      error: { code: 'USER_NOT_FOUND', userId: targetUserId },
    };
  }

  // 6. Transaction - upsert permission
  const result = await db.transaction(async (tx) => {
    // Check if permission already exists
    const existing = await tx
      .select({ id: pagePermissions.id })
      .from(pagePermissions)
      .where(
        and(
          eq(pagePermissions.pageId, pageId),
          eq(pagePermissions.userId, targetUserId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing permission
      await tx
        .update(pagePermissions)
        .set({
          canView: permissions.canView,
          canEdit: permissions.canEdit,
          canShare: permissions.canShare,
          canDelete: permissions.canDelete,
          grantedBy: ctx.userId,
          grantedAt: new Date(),
        })
        .where(eq(pagePermissions.id, existing[0].id));

      return { permissionId: existing[0].id, isUpdate: true };
    }

    // Create new permission
    const newId = createId();
    await tx.insert(pagePermissions).values({
      id: newId,
      pageId,
      userId: targetUserId,
      canView: permissions.canView,
      canEdit: permissions.canEdit,
      canShare: permissions.canShare,
      canDelete: permissions.canDelete,
      grantedBy: ctx.userId,
      grantedAt: new Date(),
    });

    return { permissionId: newId, isUpdate: false };
  });

  // 7. Cache invalidation
  await Promise.all([
    permissionCache.invalidateUserCache(targetUserId),
    permissionCache.invalidateDriveCache(page.driveId),
  ]);

  // 8. Audit log (fire-and-forget)
  getActorInfo(ctx.userId).then((actorInfo) => {
    logPermissionActivity(
      ctx.userId,
      result.isUpdate ? 'permission_update' : 'permission_grant',
      {
        pageId,
        driveId: page.driveId,
        targetUserId,
        permissions,
      },
      {
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName,
      }
    );
  });

  return { ok: true, data: result };
}

/**
 * Revoke permissions for a user on a page.
 *
 * Zero-trust:
 * - ctx.userId is verified for share rights
 * - Authorization check happens at point of mutation
 * - Idempotent: "permission no longer exists" is success
 */
export async function revokePagePermission(
  ctx: EnforcedAuthContext,
  input: unknown
): Promise<RevokeResult> {
  // 1. Parse (Zod validation)
  const parseResult = RevokeInputSchema.safeParse(input);
  if (!parseResult.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', issues: parseResult.error.issues },
    };
  }

  const { pageId, targetUserId } = parseResult.data;

  // 2. Business rules - self-revoke prevention
  const selfRevokeError = validateNotSelfGrant(ctx.userId, targetUserId);
  if (selfRevokeError) {
    return { ok: false, error: selfRevokeError };
  }

  // 3. Authorization - can user share (and thus revoke) this page?
  const pageResult = await getPageIfCanShare(ctx.userId, pageId);
  if (!pageResult.ok) {
    return { ok: false, error: pageResult.error };
  }

  const { page } = pageResult;

  // 4. Find existing permission
  const existing = await db
    .select({
      id: pagePermissions.id,
      canView: pagePermissions.canView,
      canEdit: pagePermissions.canEdit,
      canShare: pagePermissions.canShare,
      canDelete: pagePermissions.canDelete,
      grantedBy: pagePermissions.grantedBy,
    })
    .from(pagePermissions)
    .where(
      and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, targetUserId)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    // Idempotent success - permission doesn't exist
    return { ok: true, data: { revoked: false, reason: 'not_found' } };
  }

  const previousPermission = existing[0];

  // 5. Delete permission
  await db
    .delete(pagePermissions)
    .where(eq(pagePermissions.id, previousPermission.id));

  // 6. Cache invalidation
  await Promise.all([
    permissionCache.invalidateUserCache(targetUserId),
    permissionCache.invalidateDriveCache(page.driveId),
  ]);

  // 7. Audit log with previousValues (fire-and-forget)
  getActorInfo(ctx.userId).then((actorInfo) => {
    logPermissionActivity(
      ctx.userId,
      'permission_revoke',
      {
        pageId,
        driveId: page.driveId,
        targetUserId,
      },
      {
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName,
        previousValues: {
          canView: previousPermission.canView,
          canEdit: previousPermission.canEdit,
          canShare: previousPermission.canShare,
          canDelete: previousPermission.canDelete,
          grantedBy: previousPermission.grantedBy,
        },
      }
    );
  });

  return { ok: true, data: { revoked: true, permissionId: previousPermission.id } };
}
