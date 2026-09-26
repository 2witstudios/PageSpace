/**
 * FROZEN COPY of the four human drive resolvers as they were before org access was wired in
 * (pu/org-wallets at b2852bcfc: permissions.ts getUserAccessLevel, drive-service.ts
 * listAccessibleDrives, getDriveAccess, getDriveAccessWithDrive; re-copied from master at 12ef8f23b
 * when the master sync brought #2627's drive-wide canEdit rule, and again from master at 3a3353e5d
 * when sync 4 brought #2723's GUEST role), with only the export names
 * prefixed `legacy` and the imports adjusted. Do not edit or "fix" these bodies: they are the
 * reference the dark-flag equivalence test compares the live resolvers against, byte for byte.
 */
import { db } from '@pagespace/db/db';
import { and, eq, or, isNull, isNotNull, gt, inArray, not } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { loggers } from '../../../logging/logger-config';
import { parseUserId, parsePageId } from '../../../validators/id-validators';
import { fetchCustomRolePermissions, resolveCustomRolePermissions, resolveDriveWideCanEdit } from '../../membership-queries';
import { isGuestRole } from '../../guest-role';
import type { PermissionLevel } from '../../permissions';
import { getDriveById, type DriveAccessInfo, type DriveAccessWithDrive, type DriveWithAccess, type ListDrivesOptions } from '../../../services/drive-service';

/**
 * Get user access level for a page or drive (drive-as-root-node).
 *
 * If `pageId` does not resolve to a page, it is treated as a drive ID.
 * Drive owners and ADMIN members get full access; non-admin members get
 * canView/canEdit with canDelete=false. canShare follows the same owner/admin
 * gate as drive-level sharing (non-admin members cannot share the drive root).
 *
 * @param userId - User ID to check permissions for (validated as CUID2)
 * @param pageId - Page or drive ID to check permissions on (validated as CUID2)
 * @param options.silent - If false, log debug messages (default: true)
 * @returns Permission object or null if no access / invalid input
 */
export async function legacyGetUserAccessLevel(
  userId: unknown,
  pageId: unknown,
  options: { silent?: boolean } = {}
): Promise<PermissionLevel | null> {
  const { silent = true } = options;

  const userIdResult = parseUserId(userId);
  if (!userIdResult.success) {
    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Invalid userId: ${userIdResult.error.message}`);
    }
    return null;
  }

  const pageIdResult = parsePageId(pageId);
  if (!pageIdResult.success) {
    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Invalid pageId: ${pageIdResult.error.message}`);
    }
    return null;
  }

  const validUserId = userIdResult.data;
  const validPageId = pageIdResult.data;

  try {
    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Checking access for userId: ${validUserId}, pageId: ${validPageId}`);
    }

    const page = await db.select({
      id: pages.id,
      driveId: pages.driveId,
      driveOwnerId: drives.ownerId,
      isPrivate: pages.isPrivate,
      type: pages.type,
    })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, validPageId))
    .limit(1);

    if (page.length === 0) {
      // Fall back to treating the ID as a drive (drive-as-root-node model)
      const drive = await db.select({ id: drives.id, ownerId: drives.ownerId })
        .from(drives)
        .where(eq(drives.id, validPageId))
        .limit(1);

      if (drive.length === 0) {
        if (!silent) {
          loggers.api.debug(`[PERMISSIONS] Page not found: ${validPageId}`);
        }
        return null;
      }

      if (drive[0].ownerId === validUserId) {
        return { canView: true, canEdit: true, canShare: true, canDelete: true };
      }

      const membership = await db.select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId })
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, drive[0].id),
          eq(driveMembers.userId, validUserId),
          isNotNull(driveMembers.acceptedAt),
        ))
        .limit(1);

      // A GUEST holds pages, not the drive: no drive-root access.
      if (membership.length > 0 && !isGuestRole(membership[0].role)) {
        const isAdmin = membership[0].role === 'ADMIN';
        // The single drive-wide canEdit rule (#2627): a custom role bounds a
        // MEMBER to what its driveWidePermissions grant; an unresolvable or
        // foreign-drive role fails closed.
        const canEditMap = await resolveDriveWideCanEdit([
          { driveId: drive[0].id, role: isAdmin ? 'ADMIN' : 'MEMBER', customRoleId: membership[0].customRoleId },
        ]);
        return {
          canView: true,
          canEdit: canEditMap.get(drive[0].id) === true,
          canShare: isAdmin,
          canDelete: isAdmin,
        };
      }

      return null;
    }

    const pageData = page[0];

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Page found - driveId: ${pageData.driveId}, driveOwnerId: ${pageData.driveOwnerId}`);
    }

    if (pageData.driveOwnerId === validUserId) {
      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] User is drive owner - granting full access`);
      }
      return {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      };
    }

    let memberRole: string | null = null;
    let memberCustomRoleId: string | null = null;

    if (pageData.driveId) {
      const memberRow = await db.select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId })
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, pageData.driveId),
          eq(driveMembers.userId, validUserId),
          isNotNull(driveMembers.acceptedAt)
        ))
        .limit(1);

      // A GUEST row is not a membership here: it gets neither a custom role nor
      // rule 4 below, only its explicit page_permissions grants.
      if (memberRow.length > 0 && !isGuestRole(memberRow[0].role)) {
        memberRole = memberRow[0].role;
        memberCustomRoleId = memberRow[0].customRoleId;

        if (memberRole === 'ADMIN') {
          if (!silent) {
            loggers.api.debug(`[PERMISSIONS] User is drive admin - granting full access`);
          }
          return { canView: true, canEdit: true, canShare: true, canDelete: true };
        }
      }
    }

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] User is NOT drive owner or admin - checking explicit permissions`);
    }

    const permission = await db.select()
      .from(pagePermissions)
      .where(and(
        eq(pagePermissions.pageId, validPageId),
        eq(pagePermissions.userId, validUserId),
        or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
      ))
      .limit(1);

    if (permission.length === 0) {
      if (memberCustomRoleId && pageData.driveId) {
        const role = await fetchCustomRolePermissions(memberCustomRoleId, pageData.driveId);
        if (role) {
          const resolved = resolveCustomRolePermissions(role, validPageId);
          if (resolved !== null) {
            // driveWidePermissions fallback must not grant access to private pages
            if (pageData.isPrivate && role.permissions[validPageId] === undefined) return null;
            return resolved.canView ? { ...resolved, canDelete: false } : null;
          }
        }
      }

      if (memberRole !== null && pageData.driveId && !pageData.isPrivate) {
        if (!silent) {
          loggers.api.debug(`[PERMISSIONS] User is drive member, page is not private - granting read access`);
        }
        const canEdit = pageData.type === 'CHANNEL';
        return { canView: true, canEdit, canShare: false, canDelete: false };
      }

      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] No explicit permissions found (or expired) - denying access`);
      }
      return null;
    }

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Found explicit permissions - canView: ${permission[0].canView}, canEdit: ${permission[0].canEdit}`);
    }

    return {
      canView: permission[0].canView,
      canEdit: permission[0].canEdit,
      canShare: permission[0].canShare,
      canDelete: permission[0].canDelete,
    };

  } catch (error) {
    loggers.api.error('[PERMISSIONS] Error checking user access level', {
      userId: validUserId,
      pageId: validPageId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * List all drives accessible to a user (owned + shared)
 * Handles deduplication when a drive appears in multiple sources
 */
export async function legacyListAccessibleDrives(
  userId: string,
  options: ListDrivesOptions = {}
): Promise<DriveWithAccess[]> {
  const { includeTrash = false, tokenScopable = false } = options;

  // 1. Get owned drives
  const ownedDrives = await db.query.drives.findMany({
    where: includeTrash
      ? eq(drives.ownerId, userId)
      : and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)),
  });

  // 2. Get drives where user is a member (including last access time). A GUEST
  // row is not a membership: its drive is reached, like any page collaborator's,
  // through step 3 — never token-scopable, never drive-wide create.
  const memberDrives = (await db
    .selectDistinct({ driveId: driveMembers.driveId, role: driveMembers.role, customRoleId: driveMembers.customRoleId, lastAccessedAt: driveMembers.lastAccessedAt })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))).filter((d) => !isGuestRole(d.role));

  // 3. Get drives where user has page-level permissions
  // Skip this if tokenScopable is true (only owned + member drives can be scoped to tokens)
  const permissionDrives = tokenScopable
    ? []
    : await db
        .selectDistinct({ driveId: pages.driveId })
        .from(pagePermissions)
        .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
        .where(and(eq(pagePermissions.userId, userId), eq(pagePermissions.canView, true)));

  // 4. Build role map and lastAccessedAt map (membership role takes precedence)
  const driveRoles = new Map<string, 'OWNER' | 'ADMIN' | 'MEMBER'>();
  const driveLastAccessed = new Map<string, Date | null>();
  const memberCustomRoleIds = new Map<string, string | null>();
  const allSharedDriveIds = new Set<string>();

  for (const d of memberDrives) {
    if (d.driveId) {
      allSharedDriveIds.add(d.driveId);
      driveRoles.set(d.driveId, d.role as 'OWNER' | 'ADMIN' | 'MEMBER');
      memberCustomRoleIds.set(d.driveId, d.customRoleId ?? null);
      driveLastAccessed.set(d.driveId, d.lastAccessedAt);
    }
  }

  for (const d of permissionDrives) {
    if (d.driveId) {
      allSharedDriveIds.add(d.driveId);
      // Only set MEMBER if not already assigned a role from membership
      if (!driveRoles.has(d.driveId)) {
        driveRoles.set(d.driveId, 'MEMBER');
      }
    }
  }

  // 5. Fetch shared drive details (excluding owned drives)
  const sharedDriveIds = Array.from(allSharedDriveIds);
  const sharedDrives = sharedDriveIds.length
    ? await db.query.drives.findMany({
        where: includeTrash
          ? and(inArray(drives.id, sharedDriveIds), not(eq(drives.ownerId, userId)))
          : and(
              inArray(drives.id, sharedDriveIds),
              not(eq(drives.ownerId, userId)),
              eq(drives.isTrashed, false)
            ),
      })
    : [];

  // 6. Drive-wide create permission (#2627): one resolver for the DTO flag.
  // Owned drives enter as OWNER; shared drives only when the user holds an
  // actual membership — page-collaborator-only drives are not memberships
  // and fail closed below. Batched: a single custom-role query at most.
  const ownedDriveIds = new Set(ownedDrives.map((drive) => drive.id));
  const canCreatePagesMap = await resolveDriveWideCanEdit([
    ...ownedDrives.map((drive) => ({ driveId: drive.id, role: 'OWNER' as const, customRoleId: null })),
    ...memberDrives
      .filter((d) => d.driveId && !ownedDriveIds.has(d.driveId))
      .map((d) => ({
        driveId: d.driveId as string,
        role: d.role as 'OWNER' | 'ADMIN' | 'MEMBER',
        customRoleId: memberCustomRoleIds.get(d.driveId as string) ?? null,
      })),
  ]);

  // 7. Combine and deduplicate (owned drives take precedence)
  const allDrives: DriveWithAccess[] = [
    ...ownedDrives.map((drive) => ({
      ...drive,
      isOwned: true,
      role: 'OWNER' as const,
      canCreatePages: true,
      lastAccessedAt: driveLastAccessed.get(drive.id) ?? null,
    })),
    ...sharedDrives.map((drive) => ({
      ...drive,
      isOwned: false,
      role: driveRoles.get(drive.id) || ('MEMBER' as const),
      canCreatePages: canCreatePagesMap.get(drive.id) ?? false,
      lastAccessedAt: driveLastAccessed.get(drive.id) ?? null,
    })),
  ];

  // Deduplicate by drive ID (first occurrence wins - owned drives first)
  const uniqueDrives = Array.from(new Map(allDrives.map((d) => [d.id, d])).values());

  return uniqueDrives;
}

/**
 * Get user's access level for a drive
 */
export async function legacyGetDriveAccess(
  driveId: string,
  userId: string
): Promise<DriveAccessInfo> {
  const drive = await getDriveById(driveId);

  if (!drive) {
    return { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };
  }

  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER', customRoleId: null };
  }

  // Check membership
  const membership = await db
    .select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))
    .limit(1);

  // A GUEST (redeemed page share link) is a page collaborator, not a member.
  if (membership.length > 0 && !isGuestRole(membership[0].role)) {
    const role = membership[0].role as 'ADMIN' | 'MEMBER';
    return {
      isOwner: false,
      isAdmin: role === 'ADMIN',
      isMember: true,
      role,
      customRoleId: membership[0].customRoleId ?? null,
    };
  }

  return { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };
}

/**
 * Get drive and access info in a single operation
 * More efficient than calling getDriveById and getDriveAccess separately
 */
export async function legacyGetDriveAccessWithDrive(
  driveId: string,
  userId: string
): Promise<DriveAccessWithDrive | null> {
  const drive = await getDriveById(driveId);

  if (!drive) {
    return null;
  }

  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return {
      drive,
      access: { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER', customRoleId: null },
    };
  }

  // Check membership
  const membership = await db
    .select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))
    .limit(1);

  // A GUEST (redeemed page share link) is a page collaborator, not a member.
  if (membership.length > 0 && !isGuestRole(membership[0].role)) {
    const role = membership[0].role as 'ADMIN' | 'MEMBER';
    return {
      drive,
      access: {
        isOwner: false,
        isAdmin: role === 'ADMIN',
        isMember: true,
        role,
        customRoleId: membership[0].customRoleId ?? null,
      },
    };
  }

  return {
    drive,
    access: { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null },
  };
}
