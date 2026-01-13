/**
 * Drive Service - Core business logic for drive operations
 *
 * This service encapsulates all drive-related database operations,
 * providing a clean seam for testing route handlers.
 */

import {
  db,
  drives,
  driveMembers,
  pages,
  pagePermissions,
  eq,
  and,
  not,
  inArray,
} from '@pagespace/db';
import { slugify } from '../utils/utils';

// ============================================================================
// Types
// ============================================================================

export interface DriveWithAccess {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  isTrashed: boolean;
  trashedAt: Date | null;
  drivePrompt: string | null;
  createdAt: Date;
  updatedAt: Date;
  isOwned: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export interface ListDrivesOptions {
  includeTrash?: boolean;
}

export interface CreateDriveInput {
  name: string;
}

export interface UpdateDriveInput {
  name?: string;
  drivePrompt?: string | null;
}

export interface DriveAccessInfo {
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * List all drives accessible to a user (owned + shared)
 * Handles deduplication when a drive appears in multiple sources
 */
export async function listAccessibleDrives(
  userId: string,
  options: ListDrivesOptions = {}
): Promise<DriveWithAccess[]> {
  const { includeTrash = false } = options;

  // 1. Get owned drives
  const ownedDrives = await db.query.drives.findMany({
    where: includeTrash
      ? eq(drives.ownerId, userId)
      : and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)),
  });

  // 2. Get drives where user is a member
  const memberDrives = await db
    .selectDistinct({ driveId: driveMembers.driveId, role: driveMembers.role })
    .from(driveMembers)
    .where(eq(driveMembers.userId, userId));

  // 3. Get drives where user has page-level permissions
  const permissionDrives = await db
    .selectDistinct({ driveId: pages.driveId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(eq(pagePermissions.userId, userId), eq(pagePermissions.canView, true)));

  // 4. Build role map (membership role takes precedence)
  const driveRoles = new Map<string, 'OWNER' | 'ADMIN' | 'MEMBER'>();
  const allSharedDriveIds = new Set<string>();

  for (const d of memberDrives) {
    if (d.driveId) {
      allSharedDriveIds.add(d.driveId);
      driveRoles.set(d.driveId, d.role as 'OWNER' | 'ADMIN' | 'MEMBER');
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

  // 6. Combine and deduplicate (owned drives take precedence)
  const allDrives: DriveWithAccess[] = [
    ...ownedDrives.map((drive) => ({
      ...drive,
      isOwned: true,
      role: 'OWNER' as const,
    })),
    ...sharedDrives.map((drive) => ({
      ...drive,
      isOwned: false,
      role: driveRoles.get(drive.id) || ('MEMBER' as const),
    })),
  ];

  // Deduplicate by drive ID (first occurrence wins - owned drives first)
  const uniqueDrives = Array.from(new Map(allDrives.map((d) => [d.id, d])).values());

  return uniqueDrives;
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

  const [newDrive] = await db
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

  return {
    ...newDrive,
    isOwned: true,
    role: 'OWNER' as const,
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
    return { isOwner: false, isAdmin: false, isMember: false, role: null };
  }

  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' };
  }

  // Check membership
  const membership = await db
    .select({ role: driveMembers.role })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)))
    .limit(1);

  if (membership.length > 0) {
    const role = membership[0].role as 'ADMIN' | 'MEMBER';
    return {
      isOwner: false,
      isAdmin: role === 'ADMIN',
      isMember: true,
      role,
    };
  }

  return { isOwner: false, isAdmin: false, isMember: false, role: null };
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

  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return {
      drive,
      access: { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' },
    };
  }

  // Check membership
  const membership = await db
    .select({ role: driveMembers.role })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)))
    .limit(1);

  if (membership.length > 0) {
    const role = membership[0].role as 'ADMIN' | 'MEMBER';
    return {
      drive,
      access: {
        isOwner: false,
        isAdmin: role === 'ADMIN',
        isMember: true,
        role,
      },
    };
  }

  return {
    drive,
    access: { isOwner: false, isAdmin: false, isMember: false, role: null },
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

  return {
    ...drive,
    isOwned: access.isOwner,
    isMember: access.isMember,
    role: access.role || 'MEMBER',
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

  const [updated] = await db
    .update(drives)
    .set(updateData)
    .where(eq(drives.id, driveId))
    .returning();

  return updated || null;
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
    .where(eq(drives.id, driveId))
    .returning();

  return updated || null;
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
