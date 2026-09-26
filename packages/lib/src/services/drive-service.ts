/**
 * Drive Service - Core business logic for drive operations
 *
 * This service encapsulates all drive-related database operations,
 * providing a clean seam for testing route handlers.
 */

import { db } from '@pagespace/db/db';
import { eq, ne, and, not, or, gt, inArray, isNotNull, isNull, like, sql } from '@pagespace/db/operators';
import { normalizeSubdomain } from '../validators/subdomain';
import { drives, pages, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { allocateUniqueSubdomainWithRetry } from './subdomain-allocation';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { slugify } from '../utils/utils';
import { customRoleBelongsToDrive, getMemberCustomRoleId, resolveDriveWideCanEdit } from '../permissions/membership-queries';
import { loadEffectiveDriveMembership, loadExplicitScopeAuthority, loadOrgRolesForUser, resolveEffectiveDriveMemberships } from '../permissions/org-drive-membership';
import { decideExplicitDriveScope, decideListedDriveRole, type ExplicitScopeAuthority } from '../permissions/org-drive-resolution';
import { driveMembershipRow } from '../permissions/drive-member-role';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { isDriveLead } from '../permissions/drive-relationship';
import { isGuestRole } from '../permissions/guest-role';

// ============================================================================
// Types
// ============================================================================

export interface DriveWithAccess {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  kind: 'STANDARD' | 'HOME';
  isTrashed: boolean;
  trashedAt: Date | null;
  drivePrompt: string | null;
  createdAt: Date;
  updatedAt: Date;
  isOwned: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  /**
   * Server-computed effective permission for root-level page create — the
   * drive-wide canEdit rule (custom-role bounded, fail closed). The UI's
   * create affordances gate on this flag instead of deriving from `role`
   * (#2627); the API still independently enforces it.
   */
  canCreatePages: boolean;
  lastAccessedAt: Date | null;
  homePageId: string | null;
  /** The owning org; null for a personal drive (picker grouping, DRV-9). */
  orgId: string | null;
  /** Meaningful only when orgId is set (DRV-4). */
  orgVisibility: OrgDriveVisibility;
}

export interface ListDrivesOptions {
  includeTrash?: boolean;
  /** When true, only returns drives where user is owner or member (excludes page-permission-only drives) */
  tokenScopable?: boolean;
}

export interface CreateDriveInput {
  name: string;
}

export interface UpdateDriveInput {
  name?: string;
  drivePrompt?: string | null;
  homePageId?: string | null;
  publishDefaultOgImageUrl?: string | null;
  notFoundPageId?: string | null;
  publishFaviconUrl?: string | null;
}

export interface DriveAccessInfo {
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  customRoleId: string | null;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * List all drives accessible to a user (owned + shared)
 * Handles deduplication when a drive appears in multiple sources
 *
 * The picker, the sidebar and accessible-drives all read this one list (DRV-9). While
 * ORGS_ENABLED it also lists the OPEN drives of the user's orgs and applies the org listing
 * rules (decideListedDriveRole); while dark it is exactly the pre-org listing.
 */
export async function listAccessibleDrives(
  userId: string,
  options: ListDrivesOptions = {}
): Promise<DriveWithAccess[]> {
  if (ORGS_ENABLED) return listAccessibleDrivesWithOrgs(userId, options);

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
  const memberRows = await db
    .selectDistinct({ driveId: driveMembers.driveId, role: driveMembers.role, customRoleId: driveMembers.customRoleId, lastAccessedAt: driveMembers.lastAccessedAt })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ));
  const memberDrives = memberRows.filter((d) => !isGuestRole(d.role));

  // 3. Get drives where user has page-level permissions
  // Skip this if tokenScopable is true (only owned + member drives can be scoped to tokens)
  const permissionDrives = tokenScopable
    ? []
    : await db
        .selectDistinct({ driveId: pages.driveId })
        .from(pagePermissions)
        .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
        .where(and(
          eq(pagePermissions.userId, userId),
          eq(pagePermissions.canView, true),
          // An expired share lists nothing, as it opens nothing (getUserAccessLevel, getDriveIdsForUser).
          or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date())),
        ));

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

async function listAccessibleDrivesWithOrgs(
  userId: string,
  options: ListDrivesOptions
): Promise<DriveWithAccess[]> {
  const { includeTrash = false, tokenScopable = false } = options;
  const trashFilter = includeTrash ? undefined : eq(drives.isTrashed, false);

  const ownedDrives = await db.query.drives.findMany({
    where: and(eq(drives.ownerId, userId), trashFilter),
  });

  const memberRows = await db
    .select({
      driveId: driveMembers.driveId,
      role: driveMembers.role,
      customRoleId: driveMembers.customRoleId,
      source: driveMembers.source,
      lastAccessedAt: driveMembers.lastAccessedAt,
    })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ));

  const permissionDrives = tokenScopable
    ? []
    : await db
        .selectDistinct({ driveId: pages.driveId })
        .from(pagePermissions)
        .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
        .where(and(
          eq(pagePermissions.userId, userId),
          eq(pagePermissions.canView, true),
          // An expired share lists nothing, as it opens nothing (getUserAccessLevel, getDriveIdsForUser).
          or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date())),
        ));

  const orgRoles = await loadOrgRolesForUser(userId);
  const openOrgDrives = orgRoles.size > 0
    ? await db
        .select({ id: drives.id })
        .from(drives)
        .where(and(inArray(drives.orgId, [...orgRoles.keys()]), eq(drives.orgVisibility, 'OPEN')))
    : [];

  const rowByDrive = new Map(memberRows.map((r) => [r.driveId, r]));
  const permissionDriveIds = new Set(
    permissionDrives.map((d) => d.driveId).filter((id): id is string => id !== null),
  );
  const candidateIds = [...new Set([
    ...rowByDrive.keys(),
    ...permissionDriveIds,
    ...openOrgDrives.map((d) => d.id),
  ])];

  const sharedDrives = candidateIds.length
    ? await db.query.drives.findMany({
        where: and(inArray(drives.id, candidateIds), not(eq(drives.ownerId, userId)), trashFilter),
      })
    : [];

  const lastAccessed = (driveId: string) => rowByDrive.get(driveId)?.lastAccessedAt ?? null;

  // Drive-wide create permission (#2627) from the EFFECTIVE membership, so an implicit Open member
  // is bounded by the drive's default custom role exactly as getUserAccessLevel bounds them. A drive
  // listed through a page permission alone has no membership and fails closed.
  const effective = await resolveEffectiveDriveMemberships(
    sharedDrives.map((drive) => {
      const row = rowByDrive.get(drive.id);
      return {
        userId,
        drive,
        row: driveMembershipRow(row),
      };
    }),
    { audit: false },
  );
  const canCreatePagesMap = await resolveDriveWideCanEdit(
    sharedDrives.flatMap((drive, i) => {
      const membership = effective[i];
      return membership
        ? [{ driveId: drive.id, role: membership.role === 'ADMIN' ? 'ADMIN' as const : 'MEMBER' as const, customRoleId: membership.customRoleId }]
        : [];
    }),
  );

  const listed: DriveWithAccess[] = ownedDrives.map((drive) => ({
    ...drive,
    isOwned: true,
    role: 'OWNER' as const,
    canCreatePages: true,
    lastAccessedAt: lastAccessed(drive.id),
  }));

  for (const drive of sharedDrives) {
    const row = rowByDrive.get(drive.id);
    const role = decideListedDriveRole({
      orgsEnabled: true,
      drive: { orgId: drive.orgId, orgVisibility: drive.orgVisibility },
      orgRole: drive.orgId ? orgRoles.get(drive.orgId) ?? null : null,
      row: driveMembershipRow(row),
      viaPagePermission: permissionDriveIds.has(drive.id),
    });
    if (role === null) continue;
    listed.push({
      ...drive,
      isOwned: false,
      role,
      canCreatePages: canCreatePagesMap.get(drive.id) ?? false,
      lastAccessedAt: lastAccessed(drive.id),
    });
  }

  return Array.from(new Map(listed.map((d) => [d.id, d])).values());
}

/**
 * Create a new drive
 */
export async function createDrive(
  userId: string,
  input: CreateDriveInput
): Promise<DriveWithAccess> {
  const { name } = input;

  const slug = slugify(name);

  const newDrive = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(drives)
      .values({
        name,
        slug,
        ownerId: userId,
        isTrashed: false,
        trashedAt: null,
        updatedAt: new Date(),
      })
      .returning();
    // Auto-allocate subdomain in the same transaction so insert + allocation are atomic.
    await allocatePublishSubdomain(created.id, slug, tx);
    return created;
  });

  return {
    ...newDrive,
    isOwned: true,
    role: 'OWNER' as const,
    canCreatePages: true,
    lastAccessedAt: null,
  };
}

/**
 * Get a drive by ID (raw, without access info)
 */
export async function getDriveById(driveId: string) {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
  });
  return drive || null;
}

/**
 * Get user's access level for a drive
 */
export async function getDriveAccess(
  driveId: string,
  userId: string
): Promise<DriveAccessInfo> {
  const drive = await getDriveById(driveId);

  if (!drive) {
    return { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };
  }

  const isOwner = isDriveLead(userId, drive);

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER', customRoleId: null };
  }

  // Check membership; an org Owner/Admin and an implicit Open-drive member resolve here too.
  // Only ACCEPTED rows count: a pending invite grants nothing (#2672).
  const membership = await loadEffectiveDriveMembership(userId, drive);

  if (membership) {
    const role = membership.role as 'ADMIN' | 'MEMBER';
    return {
      isOwner: false,
      isAdmin: role === 'ADMIN',
      isMember: true,
      role,
      customRoleId: membership.customRoleId ?? null,
    };
  }

  return { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };
}

export interface DriveScopeToValidate {
  id: string;
  role?: 'ADMIN' | 'MEMBER' | null;
  customRoleId?: string;
}

export interface DriveScopeValidationResult {
  invalidDriveIds: string[];
  unauthorizedRoles: string[];
  invalidCustomRoles: string[];
  unauthorizedCustomRoles: string[];
  /**
   * Org drives where an explicit role was asked for but the caller reaches the drive only through
   * the org (org Owner/Admin power, implicit Open membership, an org-materialized row). An explicit
   * role is never re-checked, so it must rest on a direct membership; these need an inheriting scope.
   */
  explicitRoleWithoutMembership: string[];
}

/**
 * Validate that `userId` may grant each of the given drive scopes: drive
 * membership/ownership, role authority (a MEMBER can't grant ADMIN), and
 * custom role ownership/assignment. Shared by the MCP token create (POST)
 * and edit (PATCH) routes, which each format their own error responses from
 * the returned categorized ID lists.
 */
export async function validateDriveScopeAccess(
  scopes: DriveScopeToValidate[],
  userId: string
): Promise<DriveScopeValidationResult> {
  const invalidDriveIds: string[] = [];
  const unauthorizedRoles: string[] = [];
  const invalidCustomRoles: string[] = [];
  const unauthorizedCustomRoles: string[] = [];
  const explicitRoleWithoutMembership: string[] = [];

  for (const scope of scopes) {
    const access = await getDriveAccess(scope.id, userId);
    if (!access.isOwner && !access.isMember) {
      invalidDriveIds.push(scope.id);
      continue;
    }
    // An explicit role on an org drive rests only on a direct membership row, capped to it.
    const explicit = scope.role === 'ADMIN' || scope.role === 'MEMBER';
    const scopeDecision = decideExplicitDriveScope({
      explicit,
      isOwner: access.isOwner,
      isAdmin: access.isAdmin,
      authority: explicit && !access.isOwner ? await loadExplicitScopeAuthority(userId, scope.id) : { orgDrive: false },
    });
    if (!scopeDecision.ok) {
      explicitRoleWithoutMembership.push(scope.id);
      continue;
    }
    const { isAdmin } = scopeDecision;
    // A MEMBER cannot grant ADMIN — cap to caller's actual authority
    if (scope.role === 'ADMIN' && !isAdmin) {
      unauthorizedRoles.push(scope.id);
    }
    // Prevent using a custom role that belongs to a different drive
    if (scope.customRoleId && !await customRoleBelongsToDrive(scope.customRoleId, scope.id)) {
      invalidCustomRoles.push(scope.id);
      continue;
    }
    // Non-admins can only use their own assigned custom role
    if (scope.customRoleId && !isAdmin && !access.isOwner) {
      const callerCustomRoleId = await getMemberCustomRoleId(scope.id, userId);
      if (scope.customRoleId !== callerCustomRoleId) {
        unauthorizedCustomRoles.push(scope.id);
      }
    }
  }

  return { invalidDriveIds, unauthorizedRoles, invalidCustomRoles, unauthorizedCustomRoles, explicitRoleWithoutMembership };
}

/**
 * Which membership may back an explicit-role token or OAuth drive scope on a drive the user does
 * not own (explicitScopeAuthorityRow). `orgDrive: false` while dark or on a personal drive.
 */
export async function getExplicitScopeAuthority(driveId: string, userId: string): Promise<ExplicitScopeAuthority> {
  return loadExplicitScopeAuthority(userId, driveId);
}

export interface DriveAccessWithDrive {
  drive: typeof drives.$inferSelect;
  access: DriveAccessInfo;
}

/**
 * Get drive and access info in a single operation
 * More efficient than calling getDriveById and getDriveAccess separately
 */
export async function getDriveAccessWithDrive(
  driveId: string,
  userId: string
): Promise<DriveAccessWithDrive | null> {
  const drive = await getDriveById(driveId);

  if (!drive) {
    return null;
  }

  const isOwner = isDriveLead(userId, drive);

  if (isOwner) {
    return {
      drive,
      access: { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER', customRoleId: null },
    };
  }

  // Check membership; an org Owner/Admin and an implicit Open-drive member resolve here too.
  // Only ACCEPTED rows count: a pending invite grants nothing (#2672).
  const membership = await loadEffectiveDriveMembership(userId, drive);

  if (membership) {
    const role = membership.role as 'ADMIN' | 'MEMBER';
    return {
      drive,
      access: {
        isOwner: false,
        isAdmin: role === 'ADMIN',
        isMember: true,
        role,
        customRoleId: membership.customRoleId ?? null,
      },
    };
  }

  return {
    drive,
    access: { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null },
  };
}

/**
 * Get drive with access info for a user
 */
export async function getDriveWithAccess(
  driveId: string,
  userId: string
): Promise<(DriveWithAccess & { isMember: boolean }) | null> {
  const drive = await getDriveById(driveId);

  if (!drive) {
    return null;
  }

  const access = await getDriveAccess(driveId, userId);

  if (!access.isOwner && !access.isMember) {
    return null;
  }

  const canCreatePagesMap = await resolveDriveWideCanEdit([
    {
      driveId,
      role: access.isOwner ? 'OWNER' : (access.role ?? 'MEMBER'),
      customRoleId: access.isMember && !access.isOwner ? access.customRoleId : null,
    },
  ]);

  return {
    ...drive,
    isOwned: access.isOwner,
    isMember: access.isMember,
    role: access.role || 'MEMBER',
    canCreatePages: canCreatePagesMap.get(driveId) ?? false,
    lastAccessedAt: null, // Not fetched here — only listAccessibleDrives queries driveMembers for this
  };
}

/**
 * Update a drive
 */
export async function updateDrive(
  driveId: string,
  input: UpdateDriveInput
): Promise<typeof drives.$inferSelect | null> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) {
    updateData.name = input.name;
    updateData.slug = slugify(input.name);
  }

  if (input.drivePrompt !== undefined) {
    updateData.drivePrompt = input.drivePrompt;
  }

  if (input.homePageId !== undefined) {
    updateData.homePageId = input.homePageId;
  }

  if (input.publishDefaultOgImageUrl !== undefined) {
    updateData.publishDefaultOgImageUrl = input.publishDefaultOgImageUrl;
  }

  if (input.notFoundPageId !== undefined) {
    updateData.notFoundPageId = input.notFoundPageId;
  }

  if (input.publishFaviconUrl !== undefined) {
    updateData.publishFaviconUrl = input.publishFaviconUrl;
  }

  // Home drives cannot be renamed; other updates (drivePrompt, homePageId) are allowed.
  const whereClause = input.name !== undefined
    ? and(eq(drives.id, driveId), ne(drives.kind, 'HOME'))
    : eq(drives.id, driveId);

  const [updated] = await db
    .update(drives)
    .set(updateData)
    .where(whereClause)
    .returning();

  return updated || null;
}

/**
 * Server-side gate for PATCH /api/drives/[driveId] homePageId: a page may be
 * a drive's home page only if it exists, belongs to that drive, and is not
 * trashed. Hard deletes are handled by the FK (ON DELETE set null).
 */
export async function isValidDriveHomePage(driveId: string, pageId: string): Promise<boolean> {
  const page = await db.query.pages.findFirst({
    where: and(
      eq(pages.id, pageId),
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false)
    ),
  });

  return !!page;
}

/**
 * Server-side gate for PATCH /api/drives/[driveId] notFoundPageId: a page may
 * be a drive's custom 404 page only if it exists, belongs to that drive, is
 * not trashed, AND is a CANVAS page — unlike the home page, the 404 page is
 * rendered through the canvas publish pipeline, so no other page type applies.
 */
export async function isValidDriveNotFoundPage(driveId: string, pageId: string): Promise<boolean> {
  const page = await db.query.pages.findFirst({
    where: and(
      eq(pages.id, pageId),
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      eq(pages.type, 'CANVAS')
    ),
  });

  return !!page;
}

/**
 * Soft-delete (trash) a drive
 */
export async function trashDrive(driveId: string): Promise<typeof drives.$inferSelect | null> {
  const [updated] = await db
    .update(drives)
    .set({
      isTrashed: true,
      trashedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(drives.id, driveId), ne(drives.kind, 'HOME')))
    .returning();

  return updated || null;
}

/**
 * Find the Home drive for a user (ignores isTrashed — Home is never trashed).
 */
export async function getHomeDrive(userId: string): Promise<typeof drives.$inferSelect | null> {
  const drive = await db.query.drives.findFirst({
    where: and(eq(drives.ownerId, userId), eq(drives.kind, 'HOME')),
  });
  return drive ?? null;
}

/**
 * Restore a trashed drive
 */
export async function restoreDrive(driveId: string): Promise<typeof drives.$inferSelect | null> {
  const [updated] = await db
    .update(drives)
    .set({
      isTrashed: false,
      trashedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(drives.id, driveId))
    .returning();

  return updated || null;
}

/**
 * Update a user's last accessed timestamp for a drive.
 *
 * Owner self-heal: the new acceptedAt gate (Epic 1) excludes drive_members
 * rows with acceptedAt IS NULL from member-list queries (lastAccessedAt
 * lookup, sidebar role display, recipient broadcast). Owners reach drives
 * via drives.ownerId so they are not locked out of authz, but a legacy
 * owner row with acceptedAt = NULL would stop populating those member-list
 * paths. The owner branch upserts and backfills acceptedAt via COALESCE on
 * conflict so the gate becomes a no-op for owner rows.
 *
 * Non-owners are never auto-accepted — pending invitations must be claimed
 * through the post-login acceptance flow (Epic 3).
 */
export async function updateDriveLastAccessed(userId: string, driveId: string): Promise<void> {
  const now = new Date();

  const [drive] = await db.select({ ownerId: drives.ownerId, orgId: drives.orgId })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  // Never on an org drive: its lead reaches it through drives.ownerId, the org Owner and Admins
  // through the org, and an OWNER row there would outlive a lead reassignment (B7b).
  if (drive && isDriveLead(userId, drive) && drive.orgId === null) {
    await db.insert(driveMembers)
      .values({
        driveId,
        userId,
        role: 'OWNER',
        invitedAt: now,
        acceptedAt: now,
        lastAccessedAt: now,
      })
      .onConflictDoUpdate({
        target: [driveMembers.driveId, driveMembers.userId],
        set: {
          lastAccessedAt: now,
          acceptedAt: sql`COALESCE(${driveMembers.acceptedAt}, ${now})`,
        },
      });
    return;
  }

  await db.update(driveMembers)
    .set({ lastAccessedAt: now })
    .where(and(
      eq(driveMembers.userId, userId),
      eq(driveMembers.driveId, driveId)
    ));
}

// ============================================================================
// Publish subdomain allocation
// ============================================================================

/** Reused Drizzle transaction type (works inside `db.transaction` or with the root `db`). */
type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Allocate a globally-unique `publishSubdomain` for a drive and write it to the DB.
 *
 * Returns the allocated subdomain. Race-safe: re-reads taken subdomains and
 * retries with an advanced suffix on a unique-constraint conflict. Works inside a
 * transaction (pass `tx`) or against the root `db`.
 */
export async function allocatePublishSubdomain(
  driveId: string,
  base: string,
  tx?: DbOrTx
): Promise<string> {
  const queryable = tx ?? db;

  // Idempotent: if the drive already has a subdomain, return it unchanged rather
  // than overwrite it (re-calling for an already-provisioned drive is a no-op).
  const existing = await queryable
    .select({ subdomain: drives.publishSubdomain })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (existing[0]?.subdomain) {
    return existing[0].subdomain;
  }

  const normalizedBase = normalizeSubdomain(base) || 'drive';

  return allocateUniqueSubdomainWithRetry({
    base,
    fetchTaken: async () => {
      // Narrow to the base-family only (e.g. 'acme', 'acme-2', 'acme-3') so this
      // is O(family size) not O(total drives).
      const rows: Array<{ subdomain: string | null }> = await queryable
        .select({ subdomain: drives.publishSubdomain })
        .from(drives)
        .where(and(isNotNull(drives.publishSubdomain), like(drives.publishSubdomain, `${normalizedBase}%`)));
      return rows
        .map((r) => r.subdomain)
        .filter((s): s is string => typeof s === 'string');
    },
    attempt: async (candidate) => {
      // Conditional update: only set when still null, so a concurrent allocation
      // for this drive can't be overwritten. If zero rows update, the race winner
      // already set it — re-read and return that value.
      const updated = await queryable
        .update(drives)
        .set({ publishSubdomain: candidate })
        .where(and(eq(drives.id, driveId), isNull(drives.publishSubdomain)))
        .returning({ subdomain: drives.publishSubdomain });
      if (updated.length === 0) {
        // Lost the race: another writer set it between our read and write.
        const reread = await queryable
          .select({ subdomain: drives.publishSubdomain })
          .from(drives)
          .where(eq(drives.id, driveId))
          .limit(1);
        if (!reread[0]?.subdomain) {
          throw new Error(`Race-recovery failed: publishSubdomain still null for drive ${driveId}`);
        }
        return reread[0].subdomain;
      }
    },
  });
}
