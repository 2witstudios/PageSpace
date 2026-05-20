import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import type { DriveShareLink, ShareLinkPermission } from '@pagespace/db/schema/share-links';
import { createId } from '@paralleldrive/cuid2';
import { generateToken } from '../auth/token-utils';
import { EnforcedAuthContext } from './enforced-context';
import { isDriveOwnerOrAdmin, canUserSharePage, isUserDriveMember } from './permissions';

// ============================================================================
// Result types
// ============================================================================

export type ShareLinkError =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'ALREADY_MEMBER'
  | 'INVALID_PERMISSIONS';

export type ShareLinkResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ShareLinkError };

export interface DriveShareLinkView {
  id: string;
  role: DriveShareLink['role'];
  customRoleId: string | null;
  customRoleName: string | null;
  customRoleColor: string | null;
  useCount: number;
  expiresAt: Date | null;
  createdAt: Date;
  token: string;
}

export interface PageShareLinkView {
  id: string;
  permissions: ShareLinkPermission[];
  useCount: number;
  expiresAt: Date | null;
  createdAt: Date;
  token: string;
}

export interface DriveShareLinkRedemption {
  driveId: string;
  linkId: string;
  memberId: string;
  driveName: string;
  role: DriveShareLink['role'];
  customRoleId: string | null;
  createdBy: string;
}

export interface ShareTokenInfo {
  type: 'drive' | 'page';
  linkId: string;
  driveId: string;
  driveName?: string;
  pageId?: string;
  pageTitle?: string;
  role?: DriveShareLink['role'];
  customRoleId?: string | null;
  customRoleName?: string | null;
  customRoleColor?: string | null;
  permissions?: ShareLinkPermission[];
  creatorName: string;
  expiresAt: Date | null;
  useCount: number;
}

// ============================================================================
// Helpers
// ============================================================================

function isValidShareLink(link: {
  isActive: boolean;
  expiresAt: Date | null | undefined;
}): boolean {
  if (!link.isActive) return false;
  if (link.expiresAt && link.expiresAt <= new Date()) return false;
  return true;
}

// ============================================================================
// Drive share link functions
// ============================================================================

export async function createDriveShareLink(
  ctx: EnforcedAuthContext,
  driveId: string,
  opts: { role?: 'MEMBER' | 'ADMIN'; customRoleId?: string | null; expiresAt?: Date }
): Promise<ShareLinkResult<{ id: string; rawToken: string }>> {
  const isAuthorized = await isDriveOwnerOrAdmin(ctx.userId, driveId);
  if (!isAuthorized) return { ok: false, error: 'UNAUTHORIZED' };

  // ADMIN ceiling: customRoleId is meaningless for admins and must never be stored.
  const role = opts.role ?? 'MEMBER';
  const customRoleId = role === 'ADMIN' ? null : (opts.customRoleId ?? null);

  if (customRoleId) {
    const roleRow = await db
      .select({ id: driveRoles.id })
      .from(driveRoles)
      .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
      .limit(1);
    if (roleRow.length === 0) return { ok: false, error: 'NOT_FOUND' };
  }

  const { token } = generateToken('ps_share');

  const [inserted] = await db
    .insert(driveShareLinks)
    .values({
      id: createId(),
      driveId,
      token,
      role,
      customRoleId,
      createdBy: ctx.userId,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning({ id: driveShareLinks.id });

  return { ok: true, data: { id: inserted.id, rawToken: token } };
}

export async function revokeDriveShareLink(
  ctx: EnforcedAuthContext,
  linkId: string
): Promise<ShareLinkResult<undefined>> {
  const rows = await db
    .select({ id: driveShareLinks.id, driveId: driveShareLinks.driveId })
    .from(driveShareLinks)
    .where(eq(driveShareLinks.id, linkId))
    .limit(1);

  if (rows.length === 0) return { ok: false, error: 'NOT_FOUND' };

  const link = rows[0];
  const isAuthorized = await isDriveOwnerOrAdmin(ctx.userId, link.driveId);
  if (!isAuthorized) return { ok: false, error: 'UNAUTHORIZED' };

  await db
    .update(driveShareLinks)
    .set({ isActive: false })
    .where(eq(driveShareLinks.id, linkId));

  return { ok: true, data: undefined };
}

export async function listDriveShareLinks(
  ctx: EnforcedAuthContext,
  driveId: string
): Promise<ShareLinkResult<DriveShareLinkView[]>> {
  const isAuthorized = await isDriveOwnerOrAdmin(ctx.userId, driveId);
  if (!isAuthorized) return { ok: false, error: 'UNAUTHORIZED' };

  const rows = await db
    .select({
      id: driveShareLinks.id,
      role: driveShareLinks.role,
      customRoleId: driveShareLinks.customRoleId,
      customRoleName: driveRoles.name,
      customRoleColor: driveRoles.color,
      useCount: driveShareLinks.useCount,
      expiresAt: driveShareLinks.expiresAt,
      createdAt: driveShareLinks.createdAt,
      token: driveShareLinks.token,
    })
    .from(driveShareLinks)
    .leftJoin(driveRoles, eq(driveRoles.id, driveShareLinks.customRoleId))
    .where(
      and(
        eq(driveShareLinks.driveId, driveId),
        eq(driveShareLinks.isActive, true)
      )
    );

  return { ok: true, data: rows };
}

export async function redeemDriveShareLink(
  ctx: EnforcedAuthContext,
  rawToken: string
): Promise<
  | { ok: true; data: DriveShareLinkRedemption }
  | { ok: false; error: 'ALREADY_MEMBER'; driveId: string }
  | { ok: false; error: 'NOT_FOUND' }
> {
  const rows = await db
    .select({
      id: driveShareLinks.id,
      driveId: driveShareLinks.driveId,
      role: driveShareLinks.role,
      customRoleId: driveShareLinks.customRoleId,
      isActive: driveShareLinks.isActive,
      expiresAt: driveShareLinks.expiresAt,
      useCount: driveShareLinks.useCount,
      createdBy: driveShareLinks.createdBy,
      driveName: drives.name,
    })
    .from(driveShareLinks)
    .innerJoin(drives, eq(driveShareLinks.driveId, drives.id))
    .where(eq(driveShareLinks.token, rawToken))
    .limit(1);

  if (rows.length === 0 || !isValidShareLink(rows[0])) {
    return { ok: false, error: 'NOT_FOUND' };
  }

  const link = rows[0];

  const alreadyMember = await isUserDriveMember(ctx.userId, link.driveId);
  if (alreadyMember) return { ok: false, error: 'ALREADY_MEMBER', driveId: link.driveId };

  // Defense-in-depth: older links may pre-date the ADMIN gate; keep ADMIN+null invariant.
  const customRoleId = link.role === 'ADMIN' ? null : link.customRoleId;

  const [inserted] = await db.insert(driveMembers).values({
    id: createId(),
    driveId: link.driveId,
    userId: ctx.userId,
    role: link.role,
    customRoleId,
    acceptedAt: new Date(),
  }).onConflictDoUpdate({
    target: [driveMembers.driveId, driveMembers.userId],
    set: {
      acceptedAt: new Date(),
      // Never downgrade an existing ADMIN via a MEMBER share link.
      role: sql`CASE WHEN ${driveMembers.role} = 'ADMIN' THEN ${driveMembers.role} ELSE EXCLUDED.role END`,
      // Re-redeem applies the link's role template; existing ADMINs keep NULL to preserve ADMIN+null invariant.
      customRoleId: sql`CASE WHEN ${driveMembers.role} = 'ADMIN' THEN NULL ELSE EXCLUDED."customRoleId" END`,
    },
  }).returning({ id: driveMembers.id });

  await db
    .update(driveShareLinks)
    .set({ useCount: sql`${driveShareLinks.useCount} + 1` })
    .where(eq(driveShareLinks.id, link.id));

  return {
    ok: true,
    data: {
      driveId: link.driveId,
      linkId: link.id,
      memberId: inserted.id,
      driveName: link.driveName,
      role: link.role,
      customRoleId,
      createdBy: link.createdBy,
    },
  };
}

// ============================================================================
// Page share link functions
// ============================================================================

export async function createPageShareLink(
  ctx: EnforcedAuthContext,
  pageId: string,
  opts: { permissions?: ShareLinkPermission[]; expiresAt?: Date }
): Promise<ShareLinkResult<{ id: string; rawToken: string }>> {
  const perms: ShareLinkPermission[] = opts.permissions ?? ['VIEW'];

  if (!perms.includes('VIEW')) {
    return { ok: false, error: 'INVALID_PERMISSIONS' };
  }

  const isAuthorized = await canUserSharePage(ctx.userId, pageId);
  if (!isAuthorized) return { ok: false, error: 'UNAUTHORIZED' };

  const { token } = generateToken('ps_share');

  const [inserted] = await db
    .insert(pageShareLinks)
    .values({
      id: createId(),
      pageId,
      token,
      permissions: perms,
      createdBy: ctx.userId,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning({ id: pageShareLinks.id });

  return { ok: true, data: { id: inserted.id, rawToken: token } };
}

export async function revokePageShareLink(
  ctx: EnforcedAuthContext,
  linkId: string
): Promise<ShareLinkResult<undefined>> {
  const rows = await db
    .select({ id: pageShareLinks.id, pageId: pageShareLinks.pageId })
    .from(pageShareLinks)
    .where(eq(pageShareLinks.id, linkId))
    .limit(1);

  if (rows.length === 0) return { ok: false, error: 'NOT_FOUND' };

  const link = rows[0];
  const isAuthorized = await canUserSharePage(ctx.userId, link.pageId);
  if (!isAuthorized) return { ok: false, error: 'UNAUTHORIZED' };

  await db
    .update(pageShareLinks)
    .set({ isActive: false })
    .where(eq(pageShareLinks.id, linkId));

  return { ok: true, data: undefined };
}

export async function listPageShareLinks(
  ctx: EnforcedAuthContext,
  pageId: string
): Promise<ShareLinkResult<PageShareLinkView[]>> {
  const isAuthorized = await canUserSharePage(ctx.userId, pageId);
  if (!isAuthorized) return { ok: false, error: 'UNAUTHORIZED' };

  const rows = await db
    .select({
      id: pageShareLinks.id,
      permissions: pageShareLinks.permissions,
      useCount: pageShareLinks.useCount,
      expiresAt: pageShareLinks.expiresAt,
      createdAt: pageShareLinks.createdAt,
      token: pageShareLinks.token,
    })
    .from(pageShareLinks)
    .where(
      and(
        eq(pageShareLinks.pageId, pageId),
        eq(pageShareLinks.isActive, true)
      )
    );

  return { ok: true, data: rows };
}

export async function redeemPageShareLink(
  ctx: EnforcedAuthContext,
  rawToken: string
): Promise<ShareLinkResult<{ pageId: string; driveId: string; linkId: string }>> {
  const rows = await db
    .select({
      id: pageShareLinks.id,
      pageId: pageShareLinks.pageId,
      driveId: pages.driveId,
      permissions: pageShareLinks.permissions,
      isActive: pageShareLinks.isActive,
      expiresAt: pageShareLinks.expiresAt,
      useCount: pageShareLinks.useCount,
    })
    .from(pageShareLinks)
    .innerJoin(pages, eq(pageShareLinks.pageId, pages.id))
    .where(eq(pageShareLinks.token, rawToken))
    .limit(1);

  const row = rows[0];
  if (!row || !isValidShareLink(row)) {
    return { ok: false, error: 'NOT_FOUND' };
  }

  const link = row;

  const existingPerms = await db
    .select({ canView: pagePermissions.canView })
    .from(pagePermissions)
    .where(and(eq(pagePermissions.pageId, link.pageId), eq(pagePermissions.userId, ctx.userId)))
    .limit(1);
  const alreadyHasAccess = existingPerms.length > 0 && existingPerms[0].canView;

  await db.insert(driveMembers).values({
    id: createId(),
    driveId: link.driveId,
    userId: ctx.userId,
    role: 'MEMBER',
    acceptedAt: new Date(),
  }).onConflictDoUpdate({
    target: [driveMembers.driveId, driveMembers.userId],
    set: { acceptedAt: new Date() },
  });

  const canView   = link.permissions.includes('VIEW');
  const canEdit   = link.permissions.includes('EDIT');
  const canShare  = link.permissions.includes('SHARE');
  const canDelete = link.permissions.includes('DELETE');

  await db
    .insert(pagePermissions)
    .values({
      id: createId(),
      pageId: link.pageId,
      userId: ctx.userId,
      canView,
      canEdit,
      canShare,
      canDelete,
      grantedBy: null,
      grantedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pagePermissions.pageId, pagePermissions.userId],
      set: {
        canView:   sql`${pagePermissions.canView}   OR EXCLUDED."canView"`,
        canEdit:   sql`${pagePermissions.canEdit}   OR EXCLUDED."canEdit"`,
        canShare:  sql`${pagePermissions.canShare}  OR EXCLUDED."canShare"`,
        canDelete: sql`${pagePermissions.canDelete} OR EXCLUDED."canDelete"`,
        grantedAt: new Date(),
      },
    });

  if (!alreadyHasAccess) {
    await db
      .update(pageShareLinks)
      .set({ useCount: sql`${pageShareLinks.useCount} + 1` })
      .where(eq(pageShareLinks.id, link.id));
  }

  return { ok: true, data: { pageId: link.pageId, driveId: link.driveId, linkId: link.id } };
}

// ============================================================================
// Token resolution (for landing page display)
// ============================================================================

export async function resolveShareToken(rawToken: string): Promise<ShareTokenInfo | null> {
  const driveRows = await db
    .select({
      id: driveShareLinks.id,
      driveId: driveShareLinks.driveId,
      role: driveShareLinks.role,
      customRoleId: driveShareLinks.customRoleId,
      customRoleName: driveRoles.name,
      customRoleColor: driveRoles.color,
      isActive: driveShareLinks.isActive,
      expiresAt: driveShareLinks.expiresAt,
      useCount: driveShareLinks.useCount,
      driveName: drives.name,
      creatorName: users.name,
    })
    .from(driveShareLinks)
    .leftJoin(drives, eq(driveShareLinks.driveId, drives.id))
    .leftJoin(users, eq(driveShareLinks.createdBy, users.id))
    .leftJoin(driveRoles, eq(driveRoles.id, driveShareLinks.customRoleId))
    .where(eq(driveShareLinks.token, rawToken))
    .limit(1);

  if (driveRows.length > 0) {
    const row = driveRows[0];
    if (!isValidShareLink(row)) return null;
    return {
      type: 'drive',
      linkId: row.id,
      driveId: row.driveId,
      driveName: row.driveName ?? undefined,
      role: row.role,
      customRoleId: row.customRoleId,
      customRoleName: row.customRoleName,
      customRoleColor: row.customRoleColor,
      creatorName: row.creatorName ?? 'Unknown',
      expiresAt: row.expiresAt ?? null,
      useCount: row.useCount,
    };
  }

  const pageRows = await db
    .select({
      id: pageShareLinks.id,
      pageId: pageShareLinks.pageId,
      driveId: pages.driveId,
      permissions: pageShareLinks.permissions,
      isActive: pageShareLinks.isActive,
      expiresAt: pageShareLinks.expiresAt,
      useCount: pageShareLinks.useCount,
      pageTitle: pages.title,
      driveName: drives.name,
      creatorName: users.name,
    })
    .from(pageShareLinks)
    .leftJoin(pages, eq(pageShareLinks.pageId, pages.id))
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .leftJoin(users, eq(pageShareLinks.createdBy, users.id))
    .where(eq(pageShareLinks.token, rawToken))
    .limit(1);

  if (pageRows.length > 0) {
    const row = pageRows[0];
    if (!isValidShareLink(row) || !row.driveId) return null;
    const pageDriveId = row.driveId;
    return {
      type: 'page',
      linkId: row.id,
      driveId: pageDriveId,
      pageId: row.pageId,
      pageTitle: row.pageTitle ?? undefined,
      driveName: row.driveName ?? undefined,
      permissions: row.permissions,
      creatorName: row.creatorName ?? 'Unknown',
      expiresAt: row.expiresAt ?? null,
      useCount: row.useCount,
    };
  }

  return null;
}
