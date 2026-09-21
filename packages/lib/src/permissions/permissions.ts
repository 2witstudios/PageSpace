import { db } from '@pagespace/db/db';
import { and, eq, or, isNull, isNotNull, gt, inArray } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions, driveRoles } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { loggers } from '../logging/logger-config';
import { parseUserId, parsePageId } from '../validators/id-validators';
import { fetchCustomRolePermissions, resolveCustomRolePermissions, resolveDriveWideCanEdit, type CustomRolePerms, type PagePerm } from './membership-queries';
import { resolveRolePermissions } from './resolve-role-permissions';
import {
  loadEffectiveDriveMembership,
  loadOrgRolesForUser,
  resolveEffectiveDriveMemberships,
  type ResolveMembershipsOptions,
} from './org-drive-membership';
import { decideListedDriveRole } from './org-drive-resolution';
import type { DriveMemberRole, OrgDriveMembership } from './org-access';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';

/**
 * Permission level for a single page.
 */
export interface PermissionLevel {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}

/**
 * Granular drive permission level for service token validation.
 *
 * Unlike getUserDriveAccess (which returns a boolean for any access including
 * page-level), this returns detailed role information. Page-level
 * collaborators are NOT considered to have drive-wide access.
 */
export interface DrivePermissionLevel {
  hasAccess: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  canEdit: boolean;
}

/**
 * Get all drive IDs that a user has access to
 * Includes owned drives, member drives, and drives with page permissions
 */
export async function getDriveIdsForUser(userId: string): Promise<string[]> {
  if (ORGS_ENABLED) return getDriveIdsForUserWithOrgs(userId);

  const driveIdSet = new Set<string>();

  const ownedDrives = await db.select({ id: drives.id })
    .from(drives)
    .where(eq(drives.ownerId, userId));

  for (const drive of ownedDrives) {
    driveIdSet.add(drive.id);
  }

  const memberDrives = await db.select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ));

  for (const membership of memberDrives) {
    driveIdSet.add(membership.driveId);
  }

  const pageDrives = await db.select({ driveId: pages.driveId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pagePermissions.canView, true),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
    ));

  for (const page of pageDrives) {
    if (page.driveId) {
      driveIdSet.add(page.driveId);
    }
  }

  return Array.from(driveIdSet);
}

/**
 * getDriveIdsForUser while ORGS_ENABLED: the same drive set listAccessibleDrives lists (trashed
 * drives included, as before), decided by decideListedDriveRole. Owned drives, valid rows, page
 * shares on personal drives, and the OPEN drives of the user's orgs; a RESTRICTED or PRIVATE org
 * drive only once joined, and never through a page share alone (DRV-6, X-6). Every id is one the
 * user can open, so a cross-drive aggregate over it (mentions, calendar, sessions) still filters
 * per page.
 */
async function getDriveIdsForUserWithOrgs(userId: string): Promise<string[]> {
  const driveIdSet = new Set<string>();

  const ownedDrives = await db.select({ id: drives.id })
    .from(drives)
    .where(eq(drives.ownerId, userId));
  for (const drive of ownedDrives) driveIdSet.add(drive.id);

  const memberRows = await db.select({
    driveId: driveMembers.driveId,
    role: driveMembers.role,
    customRoleId: driveMembers.customRoleId,
    source: driveMembers.source,
  })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ));

  const pageDrives = await db.select({ driveId: pages.driveId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pagePermissions.canView, true),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
    ));

  const orgRoles = await loadOrgRolesForUser(userId);
  const openOrgDrives = orgRoles.size > 0
    ? await db.select({ id: drives.id })
      .from(drives)
      .where(and(inArray(drives.orgId, [...orgRoles.keys()]), eq(drives.orgVisibility, 'OPEN')))
    : [];

  const rowByDrive = new Map(memberRows.map((r) => [r.driveId, r]));
  const pageDriveIds = new Set(pageDrives.map((d) => d.driveId).filter((id): id is string => id !== null));
  const candidateIds = [...new Set([...rowByDrive.keys(), ...pageDriveIds, ...openOrgDrives.map((d) => d.id)])]
    .filter((id) => !driveIdSet.has(id));

  for (let i = 0; i < candidateIds.length; i += ID_CHUNK) {
    const candidates = await db.select({ id: drives.id, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
      .from(drives)
      .where(inArray(drives.id, candidateIds.slice(i, i + ID_CHUNK)));
    const factsById = new Map(candidates.map((d) => [d.id, d]));
    for (const id of candidateIds.slice(i, i + ID_CHUNK)) {
      const drive = factsById.get(id);
      if (!drive) continue;
      const row = rowByDrive.get(id);
      const listed = decideListedDriveRole({
        orgsEnabled: true,
        drive: { orgId: drive.orgId, orgVisibility: drive.orgVisibility },
        orgRole: drive.orgId ? orgRoles.get(drive.orgId) ?? null : null,
        row: row ? { role: row.role as DriveMemberRole, customRoleId: row.customRoleId, source: row.source } : null,
        viaPagePermission: pageDriveIds.has(id),
      });
      if (listed !== null) driveIdSet.add(id);
    }
  }

  return Array.from(driveIdSet);
}

/** Chunk size for id IN lists (Postgres bind parameter limit). */
const ID_CHUNK = 500;

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
export async function getUserAccessLevel(
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
      driveOrgId: drives.orgId,
      driveOrgVisibility: drives.orgVisibility,
      isPrivate: pages.isPrivate,
      type: pages.type,
    })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, validPageId))
    .limit(1);

    if (page.length === 0) {
      // Fall back to treating the ID as a drive (drive-as-root-node model)
      const drive = await db.select({
        id: drives.id,
        ownerId: drives.ownerId,
        orgId: drives.orgId,
        orgVisibility: drives.orgVisibility,
      })
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

      // Org Owner/Admin and implicit Open-drive membership resolve here too (ORG-4, DRV-5).
      // loadEffectiveDriveMembership reads only ACCEPTED drive_members rows (#2672).
      const membership = await loadEffectiveDriveMembership(validUserId, drive[0]);

      if (membership) {
        const isAdmin = membership.role === 'ADMIN';
        // The single drive-wide canEdit rule (#2627): a custom role bounds a
        // MEMBER to what its driveWidePermissions grant; an unresolvable or
        // foreign-drive role fails closed.
        const canEditMap = await resolveDriveWideCanEdit([
          { driveId: drive[0].id, role: isAdmin ? 'ADMIN' : 'MEMBER', customRoleId: membership.customRoleId },
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
      // Beside the drive-admin branch: an org Owner/Admin resolves ADMIN on an org drive (ORG-4).
      const memberRow = await loadEffectiveDriveMembership(validUserId, {
        id: pageData.driveId,
        orgId: pageData.driveOrgId,
        orgVisibility: pageData.driveOrgVisibility,
      });

      if (memberRow) {
        memberRole = memberRow.role;
        memberCustomRoleId = memberRow.customRoleId;

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
 * Check if user can view a page
 */
export async function canUserViewPage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canView ?? false;
}

/**
 * Check if user can edit a page
 */
export async function canUserEditPage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canEdit ?? false;
}

/**
 * Check if user can share a page
 */
export async function canUserSharePage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canShare ?? false;
}

/**
 * Check if user can delete a page
 */
export async function canUserDeletePage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canDelete ?? false;
}

/**
 * Check if user is owner or admin of a drive
 */
export async function isDriveOwnerOrAdmin(
  userId: string,
  driveId: string
): Promise<boolean> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length === 0) return false;
  if (drive[0].ownerId === userId) return true;

  // The shared org-aware membership (ORG-4: an org Owner/Admin is ADMIN on every org drive).
  const membership = await loadEffectiveDriveMembership(userId, drive[0]);
  return membership?.role === 'ADMIN';
}

/**
 * Check if user is a member of a drive (accepted members only)
 */
export async function isUserDriveMember(
  userId: string,
  driveId: string
): Promise<boolean> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length === 0) return false;
  if (drive[0].ownerId === userId) return true;

  return (await loadEffectiveDriveMembership(userId, drive[0])) !== null;
}

/**
 * Get all pages a user has access to in a drive
 */
export async function getUserAccessiblePagesInDrive(
  userId: string,
  driveId: string
): Promise<string[]> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  const isOwner = drive.length > 0 && drive[0].ownerId === userId;

  // One org-aware membership decides admin and member alike (implicit Open members use the
  // drive's default role; stale org and former-lead OWNER rows count for nothing).
  const memberRow = !isOwner && drive.length > 0
    ? await loadEffectiveDriveMembership(userId, drive[0])
    : null;
  const isAdmin = memberRow?.role === 'ADMIN';

  if (isOwner || isAdmin) {
    const allPages = await db.select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, driveId));

    return allPages.map((page: { id: string }) => page.id);
  }

  const pageIdSet = new Set<string>();

  if (memberRow) {
    const nonPrivatePages = await db.select({ id: pages.id })
      .from(pages)
      .where(and(
        eq(pages.driveId, driveId),
        eq(pages.isPrivate, false),
        eq(pages.isTrashed, false)
      ));
    for (const p of nonPrivatePages) pageIdSet.add(p.id);

    if (memberRow.customRoleId) {
      const role = await fetchCustomRolePermissions(memberRow.customRoleId, driveId);
      if (role) {
        const { permissions: rolePerms } = role;
        const visiblePageIds = Object.entries(rolePerms)
          .filter(([, p]) => p.canView)
          .map(([id]) => id);

        if (visiblePageIds.length > 0) {
          // Validate IDs against the DB to exclude stale, trashed, or out-of-drive pages
          const validRolePages = await db.select({ id: pages.id })
            .from(pages)
            .where(and(
              inArray(pages.id, visiblePageIds),
              eq(pages.driveId, driveId),
              eq(pages.isTrashed, false)
            ));
          for (const page of validRolePages) pageIdSet.add(page.id);
        }

        // Explicit deny beats Rule 4: remove non-private pages the role disallows
        for (const [id, p] of Object.entries(rolePerms)) {
          if (!p.canView) pageIdSet.delete(id);
        }

        // driveWidePermissions deny: remove Rule-4 pages not explicitly granted
        if (role.driveWidePermissions?.canView === false) {
          for (const id of [...pageIdSet]) {
            if (rolePerms[id]?.canView !== true) pageIdSet.delete(id);
          }
        }
      }
    }
  }

  const explicitPermissions = await db.select({ pageId: pagePermissions.pageId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pages.driveId, driveId),
      eq(pagePermissions.canView, true),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
    ));

  for (const entry of explicitPermissions) pageIdSet.add(entry.pageId);

  return Array.from(pageIdSet);
}

/**
 * Page with permission details type
 */
export type PageWithPermissions = {
  id: string;
  title: string;
  type: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  permissions: {
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
    canDelete: boolean;
  };
};

/**
 * Get all pages a user has access to in a drive with full page details and permissions
 * Optimized to avoid N+1 queries by using batch permission checks
 */
export async function getUserAccessiblePagesInDriveWithDetails(
  userId: string,
  driveId: string
): Promise<PageWithPermissions[]> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length === 0) {
    return [];
  }

  const isOwner = drive[0].ownerId === userId;

  const membership = isOwner ? null : await loadEffectiveDriveMembership(userId, drive[0]);
  const isAdmin = membership?.role === 'ADMIN';

  if (isOwner || isAdmin) {
    const allPages = await db.select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
      isTrashed: pages.isTrashed,
    })
    .from(pages)
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false)
    ));

    return allPages.map((page): PageWithPermissions => ({
      ...page,
      permissions: {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      }
    }));
  }

  const isMember = membership !== null;

  const pageMap = new Map<string, PageWithPermissions>();

  // Rule 4: MEMBER gets implicit canView on non-private pages
  if (isMember) {
    const nonPrivatePages = await db.select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
      isTrashed: pages.isTrashed,
    })
    .from(pages)
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      eq(pages.isPrivate, false)
    ));

    for (const page of nonPrivatePages) {
      pageMap.set(page.id, {
        ...page,
        permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
      });
    }
  }

  const memberCustomRoleId = membership?.customRoleId ?? null;
  if (memberCustomRoleId) {
    const role = await fetchCustomRolePermissions(memberCustomRoleId, driveId);
    if (role) {
      const { permissions: rolePerms, driveWidePermissions } = role;

      // Apply driveWidePermissions as default for non-private pages already in the map
      // that don't have an explicit per-page entry (per-page wins over drive-wide)
      if (driveWidePermissions) {
        for (const [pageId, pageData] of pageMap.entries()) {
          if (rolePerms[pageId] === undefined) {
            pageMap.set(pageId, {
              ...pageData,
              permissions: { ...driveWidePermissions, canDelete: false },
            });
          }
        }
      }

      const visiblePageIds = Object.entries(rolePerms)
        .filter(([, p]) => p.canView)
        .map(([id]) => id);

      if (visiblePageIds.length > 0) {
        const rolePages = await db.select({
          id: pages.id,
          title: pages.title,
          type: pages.type,
          parentId: pages.parentId,
          position: pages.position,
          isTrashed: pages.isTrashed,
        })
        .from(pages)
        .where(and(inArray(pages.id, visiblePageIds), eq(pages.driveId, driveId), eq(pages.isTrashed, false)));

        for (const page of rolePages) {
          const resolved = resolveCustomRolePermissions(role, page.id);
          pageMap.set(page.id, {
            ...page,
            permissions: { ...(resolved ?? rolePerms[page.id]!), canDelete: false },
          });
        }
      }

      // Explicit deny beats Rule 4: remove non-private pages the role disallows
      for (const [id, p] of Object.entries(rolePerms)) {
        if (!p.canView) {
          pageMap.delete(id);
        }
      }

      // driveWidePermissions deny: remove pages not covered by an explicit per-page grant
      if (driveWidePermissions?.canView === false) {
        for (const pageId of [...pageMap.keys()]) {
          if (rolePerms[pageId] === undefined) pageMap.delete(pageId);
        }
      }
    }
  }

  // Explicit pagePermissions override the defaults
  const explicitPages = await db.select({
    id: pages.id,
    title: pages.title,
    type: pages.type,
    parentId: pages.parentId,
    position: pages.position,
    isTrashed: pages.isTrashed,
    canView: pagePermissions.canView,
    canEdit: pagePermissions.canEdit,
    canShare: pagePermissions.canShare,
    canDelete: pagePermissions.canDelete,
  })
  .from(pages)
  .innerJoin(pagePermissions, eq(pages.id, pagePermissions.pageId))
  .where(and(
    eq(pages.driveId, driveId),
    eq(pages.isTrashed, false),
    eq(pagePermissions.userId, userId),
    eq(pagePermissions.canView, true),
    or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
  ));

  for (const page of explicitPages) {
    pageMap.set(page.id, {
      id: page.id,
      title: page.title,
      type: page.type,
      parentId: page.parentId,
      position: page.position,
      isTrashed: page.isTrashed,
      permissions: {
        canView: page.canView,
        canEdit: page.canEdit,
        canShare: page.canShare,
        canDelete: page.canDelete,
      },
    });
  }

  return Array.from(pageMap.values());
}

/**
 * Check if user has access to a drive by drive ID.
 * Returns true when the user owns the drive, is a drive member, or has
 * page-level permissions within the drive.
 */
export async function getUserDriveAccess(
  userId: string,
  driveId: string,
  options: { silent?: boolean } = {}
): Promise<boolean> {
  const { silent = true } = options;

  try {
    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Checking access for userId: ${userId}, driveId: ${driveId}`);
    }

    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_ACCESS] Drive not found: ${driveId}`);
      }
      return false;
    }

    const driveData = drive[0];

    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Drive found - id: ${driveData.id}, ownerId: ${driveData.ownerId}`);
    }

    if (driveData.ownerId === userId) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_ACCESS] User is drive owner - granting access`);
      }
      return true;
    }

    if (!silent) {
      loggers.api.debug('[DRIVE_ACCESS] User is NOT drive owner - checking drive membership');
    }

    const membership = await loadEffectiveDriveMembership(userId, driveData);

    if (membership) {
      if (!silent) {
        loggers.api.debug('[DRIVE_ACCESS] User is a drive member - granting access');
      }
      return true;
    }

    if (!silent) {
      loggers.api.debug('[DRIVE_ACCESS] User is not a drive member - checking page permissions');
    }

    const pageAccess = await db.select({ id: pagePermissions.id })
      .from(pagePermissions)
      .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
      .where(and(
        eq(pages.driveId, driveData.id),
        eq(pagePermissions.userId, userId),
        eq(pagePermissions.canView, true),
        or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
      ))
      .limit(1);

    const hasAccess = pageAccess.length > 0;

    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Page access check result: ${hasAccess}`);
    }

    return hasAccess;

  } catch (error) {
    loggers.api.error('[DRIVE_ACCESS] Error checking user drive access', {
      userId,
      driveId,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

/**
 * Get user's granular permissions for a drive (for service token validation).
 *
 * Page-level collaborators are NOT considered to have drive-wide access —
 * they must use page-scoped tokens instead. Use this for service token scope
 * validation where we need to distinguish owner / admin / member / viewer /
 * page-collaborator.
 */
export async function getUserDrivePermissions(
  userId: string,
  driveId: string,
  options: { silent?: boolean } = {}
): Promise<DrivePermissionLevel | null> {
  const { silent = true } = options;

  try {
    const drive = await db
      .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_PERMISSIONS] Drive not found: ${driveId}`);
      }
      return null;
    }

    const driveData = drive[0];
    const isOwner = driveData.ownerId === userId;

    if (isOwner) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_PERMISSIONS] User is drive owner`);
      }
      return {
        hasAccess: true,
        isOwner: true,
        isAdmin: false,
        isMember: false,
        canEdit: true,
      };
    }

    const membership = await loadEffectiveDriveMembership(userId, driveData);

    if (membership) {
      const { role, customRoleId } = membership;
      const isAdmin = role === 'ADMIN';
      let canEdit = isAdmin || role === 'MEMBER';

      // A custom role bounds a MEMBER's drive-wide edit to what the role's
      // driveWidePermissions explicitly grant (ADMINs bypass custom roles,
      // mirroring the agent/app permission paths). `canEdit` here answers the
      // DRIVE-WIDE question — drive-root uploads, sandbox/compute access —
      // so a view-only custom role must read false even though the member
      // may hold per-page edit grants (codex round 12). An unresolvable
      // custom role fails closed rather than degrading to plain-member edit.
      if (!isAdmin && customRoleId) {
        const customRole = await fetchCustomRolePermissions(customRoleId, driveId);
        canEdit = customRole?.driveWidePermissions?.canEdit === true;
      }

      if (!silent) {
        loggers.api.debug(
          `[DRIVE_PERMISSIONS] User is drive member with role: ${role}`
        );
      }

      return {
        hasAccess: true,
        isOwner: false,
        isAdmin,
        isMember: true,
        canEdit,
      };
    }

    if (!silent) {
      loggers.api.debug(
        `[DRIVE_PERMISSIONS] User has no drive-level membership (page collaborator or no access)`
      );
    }
    return null;
  } catch (error) {
    loggers.api.error('[DRIVE_PERMISSIONS] Error checking drive permissions', {
      userId,
      driveId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check whether two users share at least one drive, where "share" means each
 * is either the drive owner (`drives.ownerId`) or has an ACCEPTED
 * `drive_members` row for that drive. A pending, unaccepted invitation is not
 * an established shared context (see apps/web/src/lib/users/visibility.ts), so
 * it lets neither the invitee DM the drive's people nor them DM the invitee.
 * Page-level collaborators (page_permissions only) do NOT count either.
 *
 * Used to gate DM eligibility: drive co-members can DM each other without
 * needing a connections-level relationship.
 *
 * Fail-closed on error.
 */
export async function usersShareDrive(
  userIdA: string,
  userIdB: string
): Promise<boolean> {
  if (userIdA === userIdB) return false;

  try {
    const aDriveIds = new Set<string>();

    const aOwned = await db
      .select({ id: drives.id })
      .from(drives)
      .where(eq(drives.ownerId, userIdA));
    for (const d of aOwned) aDriveIds.add(d.id);

    const aMember = await db
      .select({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(and(eq(driveMembers.userId, userIdA), isNotNull(driveMembers.acceptedAt)));
    for (const m of aMember) aDriveIds.add(m.driveId);

    if (aDriveIds.size === 0) return false;
    const aIds = Array.from(aDriveIds);

    const bOwned = await db
      .select({ id: drives.id })
      .from(drives)
      .where(and(inArray(drives.id, aIds), eq(drives.ownerId, userIdB)))
      .limit(1);
    if (bOwned.length > 0) return true;

    const bMember = await db
      .select({ id: driveMembers.id })
      .from(driveMembers)
      .where(
        and(
          inArray(driveMembers.driveId, aIds),
          eq(driveMembers.userId, userIdB),
          isNotNull(driveMembers.acceptedAt)
        )
      )
      .limit(1);

    return bMember.length > 0;
  } catch (error) {
    loggers.api.error('[USERS_SHARE_DRIVE] Error checking shared drive membership', {
      userIdA,
      userIdB,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * One joined row of page + drive + this user's membership/grants, as selected by
 * both page-permission queries below.
 */
export interface PagePermissionRow {
  pageId: string;
  isTrashed: boolean | null;
  isPrivate: boolean | null;
  pageType: string | null;
  driveOwnerId: string | null;
  memberRole: string | null;
  explicitCanView: boolean | null;
  explicitCanEdit: boolean | null;
  explicitCanShare: boolean | null;
  explicitCanDelete: boolean | null;
  // Typed, not `unknown`: drive_roles.permissions and .driveWidePermissions
  // carry $type annotations that are structurally CustomRolePerms and PagePerm,
  // so both selects already yield these — nullable because they arrive through a
  // leftJoin. Declaring them here keeps the decision function free of casts.
  customRolePerms: CustomRolePerms | null;
  customRoleDriveWidePerms: PagePerm | null;
}

/**
 * The page-access decision itself, with no database in it.
 *
 * Extracted so the two directions of the same question — "which of these pages
 * can this user see?" (getBatchPagePermissions) and "which of these users can
 * see this page?" (getUsersWhoCanViewPage) — resolve through one implementation
 * and cannot drift apart. They had drifted: the channel inbox fan-out grew its
 * own recipient query that knew about owners, admins and explicit grants but
 * not about rule 4 or custom roles, so ordinary drive members silently stopped
 * receiving events for channels they can plainly read.
 *
 * Returns null when the row grants nothing (the caller's default deny stands).
 */
export function resolvePagePermissionRow(
  row: PagePermissionRow,
  userId: string
): PermissionLevel | null {
  if (row.isTrashed) return null;

  const isOwner = row.driveOwnerId === userId;
  const isAdmin = row.memberRole === 'ADMIN';
  const isMember = row.memberRole !== null;

  if (isOwner || isAdmin) {
    return { canView: true, canEdit: true, canShare: true, canDelete: true };
  }

  if (row.explicitCanView !== null) {
    return {
      canView: row.explicitCanView ?? false,
      canEdit: row.explicitCanEdit ?? false,
      canShare: row.explicitCanShare ?? false,
      canDelete: row.explicitCanDelete ?? false,
    };
  }

  if (row.customRolePerms) {
    const resolved = resolveCustomRolePermissions(
      {
        permissions: row.customRolePerms,
        driveWidePermissions: row.customRoleDriveWidePerms,
      },
      row.pageId,
    );
    if (resolved !== null) {
      // driveWidePermissions fallback must not grant access to private pages (getUserAccessLevel,
      // resolveExplicitAppRoleAccess and getAgentAccessLevel apply the same rule).
      if (row.isPrivate && row.customRolePerms[row.pageId] === undefined) return null;
      return resolved.canView ? { ...resolved, canDelete: false } : null;
    }
  }

  // Rule 4: any accepted drive member gets access to non-private pages.
  // Channels grant canEdit so members can post messages (Discord/Slack semantics).
  if (isMember && !row.isPrivate) {
    return {
      canView: true,
      canEdit: row.pageType === 'CHANNEL',
      canShare: false,
      canDelete: false,
    };
  }

  return null;
}

/** The drive and membership facts the org-aware membership needs, beside each page-permission row. */
const ORG_MEMBERSHIP_COLUMNS = {
  driveId: drives.id,
  driveOrgId: drives.orgId,
  driveOrgVisibility: drives.orgVisibility,
  memberCustomRoleId: driveMembers.customRoleId,
  memberSource: driveMembers.source,
};

type OrgMembershipFacts = {
  userId: string;
  driveId: string | null;
  driveOrgId: string | null;
  driveOrgVisibility: 'OPEN' | 'RESTRICTED' | 'PRIVATE' | null;
  memberCustomRoleId: string | null;
  memberSource: OrgDriveMembership['source'] | null;
};

/**
 * Replace each row's joined drive_members row with the user's EFFECTIVE membership, so the batch
 * resolvers answer exactly what getUserAccessLevel and getDriveAccess answer for the same user and
 * drive: an org Owner/Admin is ADMIN, an implicit Open member holds the drive's default custom
 * role, and a stale org row or a former lead's OWNER row counts for nothing.
 *
 * While ORGS_ENABLED is false, or when no row is on an org drive, the rows come back untouched
 * and no query runs. Each (user, drive) pair is resolved once however many pages it spans.
 */
async function withEffectiveMembership<R extends PagePermissionRow & OrgMembershipFacts>(
  rows: R[],
  options: ResolveMembershipsOptions,
): Promise<R[]> {
  if (!ORGS_ENABLED) return rows;

  const pairKey = (row: R) => `${row.userId}:${row.driveId}`;
  const pairs = new Map<string, R>();
  for (const row of rows) {
    if (row.driveId === null || row.driveOrgId === null || row.driveOwnerId === row.userId) continue;
    if (!pairs.has(pairKey(row))) pairs.set(pairKey(row), row);
  }
  if (pairs.size === 0) return rows;

  const representatives = [...pairs.values()];
  const effective = await resolveEffectiveDriveMemberships(
    representatives.map((row) => ({
      userId: row.userId,
      drive: { id: row.driveId as string, orgId: row.driveOrgId, orgVisibility: row.driveOrgVisibility },
      row: row.memberRole === null
        ? null
        : { role: row.memberRole as DriveMemberRole, customRoleId: row.memberCustomRoleId, source: row.memberSource ?? 'invite' },
    })),
    options,
  );
  const effectiveByPair = new Map(representatives.map((row, i) => [pairKey(row), effective[i]]));

  // A default role (or a dropped stale row's role) is not the custom role the query joined.
  const rolePerms = await fetchRolePermissionsById(
    representatives.flatMap((row, i) => {
      const customRoleId = effective[i]?.customRoleId ?? null;
      return customRoleId !== null && customRoleId !== row.memberCustomRoleId ? [customRoleId] : [];
    }),
  );

  return rows.map((row) => {
    if (!effectiveByPair.has(pairKey(row))) return row;
    const membership = effectiveByPair.get(pairKey(row)) ?? null;
    const customRoleId = membership?.customRoleId ?? null;
    const sameRole = customRoleId !== null && customRoleId === row.memberCustomRoleId;
    const role = customRoleId === null || sameRole ? null : rolePerms.get(customRoleId);
    const belongs = role !== undefined && role !== null && role.driveId === row.driveId;
    return {
      ...row,
      memberRole: membership?.role ?? null,
      memberCustomRoleId: customRoleId,
      customRolePerms: sameRole ? row.customRolePerms : belongs ? role.permissions : null,
      customRoleDriveWidePerms: sameRole ? row.customRoleDriveWidePerms : belongs ? role.driveWidePermissions : null,
    };
  });
}

async function fetchRolePermissionsById(
  roleIds: string[],
): Promise<Map<string, { driveId: string; permissions: CustomRolePerms; driveWidePermissions: PagePerm | null }>> {
  const roles = new Map<string, { driveId: string; permissions: CustomRolePerms; driveWidePermissions: PagePerm | null }>();
  const unique = [...new Set(roleIds)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const found = await db
      .select({ id: driveRoles.id, driveId: driveRoles.driveId, permissions: driveRoles.permissions, driveWidePermissions: driveRoles.driveWidePermissions })
      .from(driveRoles)
      .where(inArray(driveRoles.id, unique.slice(i, i + ID_CHUNK)));
    for (const r of found) {
      roles.set(r.id, { driveId: r.driveId, permissions: r.permissions, driveWidePermissions: r.driveWidePermissions });
    }
  }
  return roles;
}

/**
 * Batch permission lookup for multiple pages in a single DB round-trip.
 *
 * One SQL statement joins `pages`, `drives`, `drive_members` (for ADMIN role,
 * accepted members only), and `page_permissions` (with `expires_at` filter)
 * across all requested page IDs. Ordering is irrelevant; the result map keys
 * on pageId.
 *
 * Returns an entry for every `pageId` in input — pages the user cannot access
 * (including non-existent, trashed, or expired-grant pages) are represented
 * with all four flags set to `false`. Callers can therefore read
 * `map.get(pageId)?.canView` without conditional-path handling for missing
 * entries.
 */
export async function getBatchPagePermissions(
  userId: string,
  pageIds: string[]
): Promise<Map<string, PermissionLevel>> {
  const results = new Map<string, PermissionLevel>();

  if (pageIds.length === 0) {
    return results;
  }

  const deny: PermissionLevel = {
    canView: false,
    canEdit: false,
    canShare: false,
    canDelete: false,
  };

  for (const pageId of pageIds) {
    results.set(pageId, { ...deny });
  }

  try {
    const rows = await db
      .select({
        pageId: pages.id,
        isTrashed: pages.isTrashed,
        isPrivate: pages.isPrivate,
        pageType: pages.type,
        driveOwnerId: drives.ownerId,
        ...ORG_MEMBERSHIP_COLUMNS,
        memberRole: driveMembers.role,
        explicitCanView: pagePermissions.canView,
        explicitCanEdit: pagePermissions.canEdit,
        explicitCanShare: pagePermissions.canShare,
        explicitCanDelete: pagePermissions.canDelete,
        customRolePerms: driveRoles.permissions,
        customRoleDriveWidePerms: driveRoles.driveWidePermissions,
      })
      .from(pages)
      .leftJoin(drives, eq(drives.id, pages.driveId))
      .leftJoin(
        driveMembers,
        and(
          eq(driveMembers.driveId, pages.driveId),
          eq(driveMembers.userId, userId),
          isNotNull(driveMembers.acceptedAt)
        )
      )
      .leftJoin(
        pagePermissions,
        and(
          eq(pagePermissions.pageId, pages.id),
          eq(pagePermissions.userId, userId),
          or(
            isNull(pagePermissions.expiresAt),
            gt(pagePermissions.expiresAt, new Date())
          )
        )
      )
      .leftJoin(
        driveRoles,
        and(
          eq(driveRoles.id, driveMembers.customRoleId),
          eq(driveRoles.driveId, pages.driveId)
        )
      )
      .where(inArray(pages.id, pageIds));

    // The user's own request (search hits, badges, batch checks): org power used here is audited.
    const effectiveRows = await withEffectiveMembership(
      rows.map((row) => ({ ...row, userId })),
      { audit: true },
    );

    for (const row of effectiveRows) {
      const resolved = resolvePagePermissionRow(row, userId);
      if (resolved) {
        results.set(row.pageId, resolved);
      }
    }

    return results;
  } catch (error) {
    loggers.api.error('[BATCH_PERMISSIONS] Error in batch permission check', {
      userId,
      pageCount: pageIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return results;
  }
}

/**
 * Chunk size for the candidate list. Callers build it from drive membership,
 * which is unbounded — the channel fan-out's own findMany carries a lint
 * exemption saying so — and a whole drive's worth of ids in one `IN` list is
 * the thing to avoid. Mirrors PERMISSION_BATCH_SIZE in the sidebar badges route.
 */
const VIEWER_BATCH_SIZE = 200;

/**
 * Which of `candidateUserIds` can view `pageId` — the inverse of
 * getBatchPagePermissions, for fan-out paths that must decide who to notify.
 *
 * Same joins, pivoted over users instead of pages, and the same decision via
 * resolvePagePermissionRow, so the two can never disagree about who has access.
 * Fails closed: on error nobody is returned.
 */
export async function getUsersWhoCanViewPage(
  pageId: string,
  candidateUserIds: string[]
): Promise<Set<string>> {
  const viewers = new Set<string>();
  if (candidateUserIds.length === 0) return viewers;

  try {
    for (let i = 0; i < candidateUserIds.length; i += VIEWER_BATCH_SIZE) {
      const chunk = candidateUserIds.slice(i, i + VIEWER_BATCH_SIZE);
      const rows = await db
        .select({
          pageId: pages.id,
          userId: users.id,
          isTrashed: pages.isTrashed,
          isPrivate: pages.isPrivate,
          pageType: pages.type,
          driveOwnerId: drives.ownerId,
          ...ORG_MEMBERSHIP_COLUMNS,
          memberRole: driveMembers.role,
          explicitCanView: pagePermissions.canView,
          explicitCanEdit: pagePermissions.canEdit,
          explicitCanShare: pagePermissions.canShare,
          explicitCanDelete: pagePermissions.canDelete,
          customRolePerms: driveRoles.permissions,
          customRoleDriveWidePerms: driveRoles.driveWidePermissions,
        })
        .from(pages)
        // One row per candidate user for this single page, so every candidate is
        // evaluated even when they have no membership or grant rows at all.
        .innerJoin(users, inArray(users.id, chunk))
        .leftJoin(drives, eq(drives.id, pages.driveId))
        .leftJoin(
          driveMembers,
          and(
            eq(driveMembers.driveId, pages.driveId),
            eq(driveMembers.userId, users.id),
            isNotNull(driveMembers.acceptedAt)
          )
        )
        .leftJoin(
          pagePermissions,
          and(
            eq(pagePermissions.pageId, pages.id),
            eq(pagePermissions.userId, users.id),
            or(
              isNull(pagePermissions.expiresAt),
              gt(pagePermissions.expiresAt, new Date())
            )
          )
        )
        .leftJoin(
          driveRoles,
          and(
            eq(driveRoles.id, driveMembers.customRoleId),
            eq(driveRoles.driveId, pages.driveId)
          )
        )
        .where(eq(pages.id, pageId));

      // An audience, not an access: deciding who else can see the page audits nobody.
      for (const row of await withEffectiveMembership(rows, { audit: false })) {
        if (resolvePagePermissionRow(row, row.userId)?.canView) {
          viewers.add(row.userId);
        }
      }
    }
  } catch (error) {
    loggers.api.error('[PAGE_VIEWERS] Error resolving page viewers', {
      pageId,
      candidateCount: candidateUserIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set<string>();
  }

  return viewers;
}
