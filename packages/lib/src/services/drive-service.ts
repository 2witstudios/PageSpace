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
import { customRoleBelongsToDrive, fetchCustomRolePermissions, getMemberCustomRoleId, resolveDriveWideCanEdit } from '../permissions/membership-queries';
import { memberAccessWidens } from '../organizations/loosening-core';
import { loadEffectiveDriveMembership, loadExplicitScopeAuthority, loadOrgRolesForUser, resolveEffectiveDriveMemberships } from '../permissions/org-drive-membership';
import { decideExplicitDriveScope, decideListedDriveRole, type ExplicitScopeAuthority } from '../permissions/org-drive-resolution';
import { driveMembershipRow } from '../permissions/drive-member-role';
import type { AccessActor } from '../permissions/access-actor';
import { checkActorDriveAuthentication, filterDrivesForActor } from '../permissions/actor-authentication';
import { isDriveLead } from '../permissions/drive-relationship';
import type { OpenRoleFloor } from '../organizations/policies-core';
import { homeDriveActionError, isHomeDrive } from './drive-guards';

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
  /** Initial drive context (workspace memory), e.g. set by the AI create_drive tool. */
  drivePrompt?: string | null;
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
 * The picker, the sidebar and accessible-drives all read this one list (DRV-9). It also lists the
 * OPEN drives of the user's orgs and applies the org listing rules (decideListedDriveRole).
 */
export async function listAccessibleDrives(
  actor: AccessActor,
  options: ListDrivesOptions = {}
): Promise<DriveWithAccess[]> {
  const listed = await listAccessibleDrivesWithOrgs(actor.userId, options);
  // SEC-2/3: an org drive whose sign-in policy the actor's credential fails is not listed (D-OW-45).
  const allowed = await filterDrivesForActor(actor, listed.map((drive) => drive.id));
  return listed.filter((drive) => allowed.has(drive.id));
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
        ? [{
          driveId: drive.id,
          role: membership.role === 'ADMIN' ? 'ADMIN' as const : 'MEMBER' as const,
          customRoleId: membership.customRoleId,
          openDriveFloor: membership.openDriveFloor,
        }]
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
        drivePrompt: input.drivePrompt ?? null,
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
  actor: AccessActor
): Promise<DriveAccessInfo> {
  const { isOwner, isAdmin, isMember, role, customRoleId } = await getDriveAccessWithFloor(driveId, actor);
  return { isOwner, isAdmin, isMember, role, customRoleId };
}

const NO_DRIVE_ACCESS = { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null, openDriveFloor: null } as const;

/** getDriveAccess plus the membership's POL-6 floor, for the drive-wide edit flag (getDriveWithAccess). */
async function getDriveAccessWithFloor(
  driveId: string,
  actor: AccessActor
): Promise<DriveAccessInfo & { openDriveFloor: OpenRoleFloor | null }> {
  const drive = await getDriveById(driveId);

  if (!drive || !(await checkActorDriveAuthentication(actor, driveId)).allowed) return NO_DRIVE_ACCESS;
  const { userId } = actor;

  const isOwner = isDriveLead(userId, drive);

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER', customRoleId: null, openDriveFloor: null };
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
      openDriveFloor: membership.openDriveFloor,
    };
  }

  return NO_DRIVE_ACCESS;
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
/** Would a MEMBER scope with `requestedRoleId` (null: the plain role) give more than the caller's own custom role? */
async function scopeWidensCaller(driveId: string, callerRoleId: string, requestedRoleId: string | null): Promise<boolean> {
  const grantOf = async (roleId: string) => {
    const role = await fetchCustomRolePermissions(roleId, driveId);
    // An unresolvable role grants nothing.
    return { permissions: role?.permissions ?? {}, driveWidePermissions: role?.driveWidePermissions ?? null };
  };
  return memberAccessWidens(
    { role: 'MEMBER', customRole: await grantOf(callerRoleId) },
    { role: 'MEMBER', customRole: requestedRoleId === null ? null : await grantOf(requestedRoleId) },
  );
}

export async function validateDriveScopeAccess(
  scopes: DriveScopeToValidate[],
  actor: AccessActor
): Promise<DriveScopeValidationResult> {
  const { userId } = actor;
  const invalidDriveIds: string[] = [];
  const unauthorizedRoles: string[] = [];
  const invalidCustomRoles: string[] = [];
  const unauthorizedCustomRoles: string[] = [];
  const explicitRoleWithoutMembership: string[] = [];

  for (const scope of scopes) {
    const access = await getDriveAccess(scope.id, actor);
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
        continue;
      }
    }
    // Review #2849 P1: a key never reaches past its owner. A member whose custom role restricts them may not mint (or
    // re-scope to) the plain MEMBER role, or any scope that gives more than their own role; refused, never stored.
    // (Resolution also intersects every explicit key with the owner's access: app-permissions.)
    if (scope.role === 'MEMBER' && !isAdmin && !access.isOwner) {
      const callerCustomRoleId = await getMemberCustomRoleId(scope.id, userId);
      if (callerCustomRoleId && (await scopeWidensCaller(scope.id, callerCustomRoleId, scope.customRoleId ?? null))) {
        unauthorizedCustomRoles.push(scope.id);
      }
    }
  }

  return { invalidDriveIds, unauthorizedRoles, invalidCustomRoles, unauthorizedCustomRoles, explicitRoleWithoutMembership };
}

/**
 * Which membership may back an explicit-role token or OAuth drive scope on a drive the user does
 * not own (explicitScopeAuthorityRow). `orgDrive: false` on a personal drive.
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
  actor: AccessActor
): Promise<DriveAccessWithDrive | null> {
  const drive = await getDriveById(driveId);

  if (!drive) {
    return null;
  }

  // SEC-2/3: a credential the drive's org refuses reads as no access to it.
  if (!(await checkActorDriveAuthentication(actor, driveId)).allowed) {
    return { drive, access: { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null } };
  }
  const { userId } = actor;

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
  actor: AccessActor
): Promise<(DriveWithAccess & { isMember: boolean }) | null> {
  const drive = await getDriveById(driveId);

  if (!drive) {
    return null;
  }

  const access = await getDriveAccessWithFloor(driveId, actor);

  if (!access.isOwner && !access.isMember) {
    return null;
  }

  const canCreatePagesMap = await resolveDriveWideCanEdit([
    {
      driveId,
      role: access.isOwner ? 'OWNER' : (access.role ?? 'MEMBER'),
      customRoleId: access.isMember && !access.isOwner ? access.customRoleId : null,
      openDriveFloor: access.openDriveFloor,
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
      //
      // The write runs in its own savepoint (a nested transaction inside the
      // caller's tx). A unique violation aborts the enclosing Postgres
      // transaction, so without the savepoint the retry's next query fails with
      // "current transaction is aborted" — which is what concurrent first
      // sign-ins hit when two Home drives race for the same "home-N".
      const updated = await queryable.transaction((savepoint) =>
        savepoint
          .update(drives)
          .set({ publishSubdomain: candidate })
          .where(and(eq(drives.id, driveId), isNull(drives.publishSubdomain)))
          .returning({ subdomain: drives.publishSubdomain }),
      );
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

/**
 * Hand a drive to a new owner.
 *
 * Imago needs nothing here (IMG-10.10): it acts with each user's own reach,
 * and the per-drive setting is each user's own choice, so both users keep
 * theirs — the previous owner's Imago follows their remaining access, the new
 * owner's their new one.
 *
 * Every ownership change goes through here — the transfer route and the drive
 * rollback/redo of an `ownership_transfer` — so pass `executor` to run inside a
 * caller's transaction (it becomes a savepoint there). Throws, changing
 * nothing, when `fromUserId` does not own the drive or the drive is a Home
 * drive: Home stays bound to its owner.
 */
export async function transferDriveOwnership(
  driveId: string,
  fromUserId: string,
  toUserId: string,
  executor: DbOrTx | typeof db = db,
): Promise<void> {
  await executor.transaction(async (tx) => {
    const [drive] = await tx
      .select({ kind: drives.kind })
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);
    if (drive && isHomeDrive(drive)) throw new Error(homeDriveActionError(drive, 'transfer')!);

    const updated = await tx
      .update(drives)
      .set({ ownerId: toUserId, updatedAt: new Date() })
      .where(and(eq(drives.id, driveId), eq(drives.ownerId, fromUserId), eq(drives.kind, 'STANDARD')))
      .returning({ id: drives.id });
    if (updated.length === 0) throw new Error(`Drive ${driveId} is not owned by ${fromUserId}`);
  });
}
