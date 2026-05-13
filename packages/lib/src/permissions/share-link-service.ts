import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import type { DriveShareLink, ShareLinkPermission } from '@pagespace/db/schema/share-links';
import { createId } from '@paralleldrive/cuid2';
import { generateToken, hashToken } from '../auth/token-utils';
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
  useCount: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface PageShareLinkView {
  id: string;
  permissions: ShareLinkPermission[];
  useCount: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ShareTokenInfo {
  type: 'drive' | 'page';
  linkId: string;
  driveId: string;
  driveName?: string;
  pageId?: string;
  pageTitle?: string;
  role?: DriveShareLink['role'];
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
  opts: { role?: 'MEMBER' | 'ADMIN'; expiresAt?: Date }
): Promise<ShareLinkResult<{ id: string; rawToken: string }>> {
  const isAuthorized = await isDriveOwnerOrAdmin(ctx.userId, driveId);
  if (!isAuthorized) return { ok: false, error: 'UNAUTHORIZED' };

  const { token, hash } = generateToken('ps_share');
  const role = opts.role ?? 'MEMBER';

  const [inserted] = await db
    .insert(driveShareLinks)
    .values({
      id: createId(),
      driveId,
      tokenHash: hash,
      role,
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
      useCount: driveShareLinks.useCount,
      expiresAt: driveShareLinks.expiresAt,
      createdAt: driveShareLinks.createdAt,
    })
    .from(driveShareLinks)
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
  | { ok: true; data: { driveId: string; linkId: string } }
  | { ok: false; error: 'ALREADY_MEMBER'; driveId: string }
  | { ok: false; error: 'NOT_FOUND' }
> {
  const tokenHash = hashToken(rawToken);

  const rows = await db
    .select({
      id: driveShareLinks.id,
      driveId: driveShareLinks.driveId,
      role: driveShareLinks.role,
      isActive: driveShareLinks.isActive,
      expiresAt: driveShareLinks.expiresAt,
      useCount: driveShareLinks.useCount,
    })
    .from(driveShareLinks)
    .where(eq(driveShareLinks.tokenHash, tokenHash))
    .limit(1);

  if (rows.length === 0 || !isValidShareLink(rows[0])) {
    return { ok: false, error: 'NOT_FOUND' };
  }

  const link = rows[0];

  const alreadyMember = await isUserDriveMember(ctx.userId, link.driveId);
  if (alreadyMember) return { ok: false, error: 'ALREADY_MEMBER', driveId: link.driveId };

  await db.insert(driveMembers).values({
    id: createId(),
    driveId: link.driveId,
    userId: ctx.userId,
    role: link.role,
    acceptedAt: new Date(),
  }).onConflictDoUpdate({
    target: [driveMembers.driveId, driveMembers.userId],
    set: {
      acceptedAt: new Date(),
      // Preserve ADMIN role — never downgrade an existing ADMIN via a MEMBER share link
      role: sql`CASE WHEN ${driveMembers.role} = 'ADMIN' THEN ${driveMembers.role} ELSE EXCLUDED.role END`,
    },
  });

  await db
    .update(driveShareLinks)
    .set({ useCount: sql`${driveShareLinks.useCount} + 1` })
    .where(eq(driveShareLinks.id, link.id));

  return { ok: true, data: { driveId: link.driveId, linkId: link.id } };
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

  const { token, hash } = generateToken('ps_share');

  const [inserted] = await db
    .insert(pageShareLinks)
    .values({
      id: createId(),
      pageId,
      tokenHash: hash,
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
  const tokenHash = hashToken(rawToken);

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
    .leftJoin(pages, eq(pageShareLinks.pageId, pages.id))
    .where(eq(pageShareLinks.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row || !row.driveId || !isValidShareLink(row)) {
    return { ok: false, error: 'NOT_FOUND' };
  }

  const link = { ...row, driveId: row.driveId as string };

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

  const canView = link.permissions.includes('VIEW');
  const canEdit = link.permissions.includes('EDIT');

  await db
    .insert(pagePermissions)
    .values({
      id: createId(),
      pageId: link.pageId,
      userId: ctx.userId,
      canView,
      canEdit,
      canShare: false,
      canDelete: false,
      grantedBy: null,
      grantedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pagePermissions.pageId, pagePermissions.userId],
      set: {
        canView: sql`${pagePermissions.canView} OR EXCLUDED."canView"`,
        canEdit: sql`${pagePermissions.canEdit} OR EXCLUDED."canEdit"`,
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
  const tokenHash = hashToken(rawToken);

  const driveRows = await db
    .select({
      id: driveShareLinks.id,
      driveId: driveShareLinks.driveId,
      role: driveShareLinks.role,
      isActive: driveShareLinks.isActive,
      expiresAt: driveShareLinks.expiresAt,
      useCount: driveShareLinks.useCount,
      driveName: drives.name,
      creatorName: users.name,
    })
    .from(driveShareLinks)
    .leftJoin(drives, eq(driveShareLinks.driveId, drives.id))
    .leftJoin(users, eq(driveShareLinks.createdBy, users.id))
    .where(eq(driveShareLinks.tokenHash, tokenHash))
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
    .where(eq(pageShareLinks.tokenHash, tokenHash))
    .limit(1);

  if (pageRows.length > 0) {
    const row = pageRows[0];
    if (!isValidShareLink(row) || !row.driveId) return null;
    const pageDriveId = row.driveId as string;
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
