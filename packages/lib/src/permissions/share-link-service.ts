import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { decryptField } from '../encryption/field-crypto';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import type { DriveShareLink, ShareLinkPermission } from '@pagespace/db/schema/share-links';
import type { SuspensionKind } from '@pagespace/db/schema/organizations';
import { createId } from '@paralleldrive/cuid2';
import { generateToken } from '../auth/token-utils';
import { EnforcedAuthContext } from './enforced-context';
import { isDriveOwnerOrAdmin, canUserSharePage, isUserDriveMember } from './permissions';
import { getDrivePolicies } from '../organizations/policy-reader';
import { decideOrgDriveAdmission } from './guest-admission';
import { requestGuestApproval, type ClaimedGuestApproval } from './guest-holds';
import { shareLinkCreationDecision, shareLinkUsable } from '../organizations/sharing-decisions';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { checkDriveMayLoosen } from './org-lapse-guard';

// ============================================================================
// Result types
// ============================================================================


/** AUD-1: a link redemption the org's guest policy queued for approval (POL-2). The redeemer is the actor. */
async function recordGuestHeldEvent(orgId: string, driveId: string, userId: string, holdId: string, origin: 'drive_link' | 'page_link'): Promise<void> {
  await recordOrgAuditEventAfterCommit({
    orgId,
    driveId,
    eventType: 'org.guest.requested',
    actorId: userId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { holdId, origin, target: 'user' },
  });
}

export type ShareLinkError =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'ALREADY_MEMBER'
  | 'INVALID_PERMISSIONS'
  | 'HOME_DRIVE'
  /** POL-2: the org's guests policy is `approve`; the redeemer is queued and nothing has been granted. */
  | 'PENDING_APPROVAL';

/** POL-3: the org's public-share-links policy is off. Carries the policy's own message for the caller to show. */
export type ShareLinkPolicyRefusal = { ok: false; error: 'POLICY_FORBIDDEN'; message: string };

/** [D-OW-33] the drive's org is lapsed: a new link would loosen access (SEAT-9 copy in `message`). */
export type ShareLinkLapseRefusal = { ok: false; error: 'ORG_LAPSED'; message: string };

export type ShareLinkResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ShareLinkError }
  | ShareLinkPolicyRefusal
  | ShareLinkLapseRefusal;

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

/** POL-3, read at the moment of redemption: the marker AND the live policy of the link's drive's org. */
async function linkUsableNow(driveId: string, link: { suspendedByPolicy: SuspensionKind | null }): Promise<boolean> {
  return shareLinkUsable((await getDrivePolicies(driveId))?.policies ?? null, link);
}

/**
 * Create (or refresh) the drive membership a drive share link grants. Shared by redemption and by the approval of a
 * queued redeemer, so a person admitted after approval gets exactly what an immediate redeemer gets.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * POL-2, again at the write: the caller asked the guests policy before, but it may have been turned OFF since. Run
 * the write in a transaction that first re-asks under the org row's share lock (guest-admission.ts), so the write
 * either commits before the policy change parks it, or sees "off" and writes nothing (null).
 */
async function admittedWrite<T>(driveId: string, userId: string, write: (tx: Tx) => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const admission = await decideOrgDriveAdmission({ driveId, userId }, tx);
    if (admission.decision === 'refuse') return null;
    // [D-OW-33] a link redeemed while the org is lapsed admits nobody, an org member included (outsiders were already
    // refused above): it answers like a link that does not exist, so the holder learns nothing about the org.
    if (await checkDriveMayLoosen(tx, driveId, true)) return null;
    return write(tx);
  });
}

async function insertDriveLinkMember(
  tx: Tx,
  userId: string,
  link: { driveId: string; role: DriveShareLink['role']; customRoleId: string | null },
): Promise<{ memberId: string; customRoleId: string | null }> {
  // Defense-in-depth: older links may pre-date the ADMIN gate; keep ADMIN+null invariant.
  const customRoleId = link.role === 'ADMIN' ? null : link.customRoleId;

  const [inserted] = await tx.insert(driveMembers).values({
    id: createId(),
    driveId: link.driveId,
    userId,
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
  return { memberId: inserted.id, customRoleId };
}

/**
 * Make `userId` a GUEST of the page's drive carrying the page grant the link gives: a row that holds that page and
 * nothing drive-wide (see isGuestRole). An existing row — a pending invite, a real membership, an earlier guest
 * row — is left exactly as it is: redeeming a page link must never accept an invite nor change a role.
 */
async function insertPageLinkGuest(
  tx: Tx,
  userId: string,
  link: { driveId: string; pageId: string; permissions: ShareLinkPermission[] },
): Promise<true> {
  await tx.insert(driveMembers).values({
    id: createId(),
    driveId: link.driveId,
    userId,
    role: 'GUEST',
    acceptedAt: new Date(),
  }).onConflictDoNothing({
    target: [driveMembers.driveId, driveMembers.userId],
  });

  const canView   = link.permissions.includes('VIEW');
  const canEdit   = link.permissions.includes('EDIT');
  const canShare  = link.permissions.includes('SHARE');
  const canDelete = link.permissions.includes('DELETE');

  await tx
    .insert(pagePermissions)
    .values({
      id: createId(),
      pageId: link.pageId,
      userId,
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

  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { kind: true },
  });
  if (drive?.kind === 'HOME') return { ok: false, error: 'HOME_DRIVE' };

  // POL-3: an org that turned public share links off creates none, read now, not cached.
  const creation = shareLinkCreationDecision((await getDrivePolicies(driveId))?.policies ?? null);
  if (!creation.ok) return { ok: false, error: 'POLICY_FORBIDDEN', message: creation.message };

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

  // [D-OW-33] a new join link loosens access: refused while the drive's org is lapsed, read in the insert's transaction.
  return db.transaction(async (tx): Promise<ShareLinkResult<{ id: string; rawToken: string }>> => {
    const lapsed = await checkDriveMayLoosen(tx, driveId, true);
    if (lapsed) return { ok: false, error: 'ORG_LAPSED', message: lapsed.message };
    const [inserted] = await tx
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
  });
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
  | { ok: false; error: 'PENDING_APPROVAL'; driveId: string }
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
      suspendedByPolicy: driveShareLinks.suspendedByPolicy,
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

  // POL-3: a suspended link, or any link of an org that has turned public share links off, answers exactly as a
  // link that does not exist: the holder learns nothing about the org, the drive or why.
  if (!(await linkUsableNow(link.driveId, link))) return { ok: false, error: 'NOT_FOUND' };

  const alreadyMember = await isUserDriveMember(ctx.userId, link.driveId);
  if (alreadyMember) return { ok: false, error: 'ALREADY_MEMBER', driveId: link.driveId };

  // POL-2: an outsider redeeming a link to an org drive is a guest. Off answers like a link that does not exist;
  // approve queues them and grants nothing; on proceeds. Asked here, where the membership would be created.
  const admission = await decideOrgDriveAdmission({ driveId: link.driveId, userId: ctx.userId });
  if (admission.decision === 'refuse') return { ok: false, error: 'NOT_FOUND' };
  if (admission.decision === 'hold' && admission.orgId) {
    const item = await requestGuestApproval({
      orgId: admission.orgId,
      driveId: link.driveId,
      userId: ctx.userId,
      origin: 'drive_link',
      request: { linkId: link.id, role: link.role === 'ADMIN' ? 'ADMIN' : 'MEMBER', customRoleId: link.customRoleId },
      requestedBy: link.createdBy,
    });
    await recordGuestHeldEvent(admission.orgId, link.driveId, ctx.userId, item.holdId, 'drive_link');
    return { ok: false, error: 'PENDING_APPROVAL', driveId: link.driveId };
  }

  const inserted = await admittedWrite(link.driveId, ctx.userId, (tx) => insertDriveLinkMember(tx, ctx.userId, link));
  if (!inserted) return { ok: false, error: 'NOT_FOUND' };
  const { memberId, customRoleId } = inserted;

  await db
    .update(driveShareLinks)
    .set({ useCount: sql`${driveShareLinks.useCount} + 1` })
    .where(eq(driveShareLinks.id, link.id));

  return {
    ok: true,
    data: {
      driveId: link.driveId,
      linkId: link.id,
      memberId,
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

  const pageRow = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });
  if (pageRow) {
    const driveRow = await db.query.drives.findFirst({
      where: eq(drives.id, pageRow.driveId),
      columns: { kind: true },
    });
    if (driveRow?.kind === 'HOME') return { ok: false, error: 'HOME_DRIVE' };
    const creation = shareLinkCreationDecision((await getDrivePolicies(pageRow.driveId))?.policies ?? null);
    if (!creation.ok) return { ok: false, error: 'POLICY_FORBIDDEN', message: creation.message };
  }

  const { token } = generateToken('ps_share');

  // [D-OW-33] a new page link loosens access: refused while the page's drive's org is lapsed.
  return db.transaction(async (tx): Promise<ShareLinkResult<{ id: string; rawToken: string }>> => {
    const lapsed = pageRow ? await checkDriveMayLoosen(tx, pageRow.driveId, true) : null;
    if (lapsed) return { ok: false, error: 'ORG_LAPSED', message: lapsed.message };
    const [inserted] = await tx
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
  });
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
      suspendedByPolicy: pageShareLinks.suspendedByPolicy,
    })
    .from(pageShareLinks)
    .innerJoin(pages, eq(pageShareLinks.pageId, pages.id))
    .where(eq(pageShareLinks.token, rawToken))
    .limit(1);

  const row = rows[0];
  if (!row || !isValidShareLink(row)) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  // POL-3: indistinguishable from a link that does not exist.
  if (!(await linkUsableNow(row.driveId, row))) return { ok: false, error: 'NOT_FOUND' };

  const link = row;

  const existingPerms = await db
    .select({ canView: pagePermissions.canView })
    .from(pagePermissions)
    .where(and(eq(pagePermissions.pageId, link.pageId), eq(pagePermissions.userId, ctx.userId)))
    .limit(1);
  const alreadyHasAccess = existingPerms.length > 0 && existingPerms[0].canView;

  // POL-2: an outsider redeeming a page link to an org drive is a guest (D-OW-24). Off answers like a link that does
  // not exist; approve queues them and grants nothing; on proceeds.
  const admission = await decideOrgDriveAdmission({ driveId: link.driveId, userId: ctx.userId });
  if (admission.decision === 'refuse') return { ok: false, error: 'NOT_FOUND' };
  if (admission.decision === 'hold' && admission.orgId) {
    const item = await requestGuestApproval({
      orgId: admission.orgId,
      driveId: link.driveId,
      userId: ctx.userId,
      origin: 'page_link',
      request: { linkId: link.id, pageId: link.pageId },
      requestedBy: null,
    });
    await recordGuestHeldEvent(admission.orgId, link.driveId, ctx.userId, item.holdId, 'page_link');
    return { ok: false, error: 'PENDING_APPROVAL' };
  }

  // A page link makes the redeemer a GUEST: a row that carries the page grant and nothing drive-wide.
  if (!(await admittedWrite(link.driveId, ctx.userId, (tx) => insertPageLinkGuest(tx, ctx.userId, link)))) return { ok: false, error: 'NOT_FOUND' };

  if (!alreadyHasAccess) {
    await db
      .update(pageShareLinks)
      .set({ useCount: sql`${pageShareLinks.useCount} + 1` })
      .where(eq(pageShareLinks.id, link.id));
  }

  return { ok: true, data: { pageId: link.pageId, driveId: link.driveId, linkId: link.id } };
}

// ============================================================================
// Approved guests (POL-2): replay a queued link redemption
// ============================================================================

export type ApprovedLinkAdmission =
  | { ok: true; driveId: string; userId: string; memberId: string | null; role: DriveShareLink['role'] | 'GUEST'; customRoleId: string | null; driveName: string; createdBy: string | null }
  | { ok: false; error: 'NOT_A_LINK_REQUEST' | 'LINK_GONE' | 'POLICY_OFF' };

/**
 * An Owner or Admin approved a queued link redeemer: admit them exactly as the redemption would have, provided the
 * offer still stands. The link must still exist, be live and not suspended, and the org's policies must still allow
 * the admission (guests not off, public share links not off); otherwise nothing is granted and the caller is told
 * why. The queue row is already claimed by the caller; nothing here can admit the same request twice.
 */
export async function completeApprovedLinkAdmission(claim: ClaimedGuestApproval): Promise<ApprovedLinkAdmission> {
  const linkId = claim.request.linkId;
  if (!claim.userId || !linkId || (claim.origin !== 'drive_link' && claim.origin !== 'page_link')) return { ok: false, error: 'NOT_A_LINK_REQUEST' };

  const policies = (await getDrivePolicies(claim.driveId))?.policies ?? null;
  if (policies?.guests === 'off') return { ok: false, error: 'POLICY_OFF' };

  if (claim.origin === 'drive_link') {
    const [link] = await db
      .select({
        id: driveShareLinks.id, driveId: driveShareLinks.driveId, role: driveShareLinks.role, customRoleId: driveShareLinks.customRoleId,
        isActive: driveShareLinks.isActive, expiresAt: driveShareLinks.expiresAt, suspendedByPolicy: driveShareLinks.suspendedByPolicy,
        createdBy: driveShareLinks.createdBy, driveName: drives.name,
      })
      .from(driveShareLinks)
      .innerJoin(drives, eq(drives.id, driveShareLinks.driveId))
      .where(and(eq(driveShareLinks.id, linkId), eq(driveShareLinks.driveId, claim.driveId)))
      .limit(1);
    if (!link || !isValidShareLink(link) || !shareLinkUsable(policies, link)) return { ok: false, error: 'LINK_GONE' };
    const userId = claim.userId;
    const inserted = await admittedWrite(link.driveId, userId, (tx) => insertDriveLinkMember(tx, userId, link));
    if (!inserted) return { ok: false, error: 'POLICY_OFF' };
    const { memberId, customRoleId } = inserted;
    await db.update(driveShareLinks).set({ useCount: sql`${driveShareLinks.useCount} + 1` }).where(eq(driveShareLinks.id, link.id));
    return { ok: true, driveId: link.driveId, userId: claim.userId, memberId, role: link.role, customRoleId, driveName: link.driveName, createdBy: link.createdBy };
  }

  const [link] = await db
    .select({
      id: pageShareLinks.id, pageId: pageShareLinks.pageId, driveId: pages.driveId, permissions: pageShareLinks.permissions,
      isActive: pageShareLinks.isActive, expiresAt: pageShareLinks.expiresAt, suspendedByPolicy: pageShareLinks.suspendedByPolicy,
      driveName: drives.name,
    })
    .from(pageShareLinks)
    .innerJoin(pages, eq(pages.id, pageShareLinks.pageId))
    .innerJoin(drives, eq(drives.id, pages.driveId))
    .where(and(eq(pageShareLinks.id, linkId), eq(pages.driveId, claim.driveId)))
    .limit(1);
  if (!link || !isValidShareLink(link) || !shareLinkUsable(policies, link)) return { ok: false, error: 'LINK_GONE' };
  const userId = claim.userId;
  if (!(await admittedWrite(link.driveId, userId, (tx) => insertPageLinkGuest(tx, userId, link)))) return { ok: false, error: 'POLICY_OFF' };
  await db.update(pageShareLinks).set({ useCount: sql`${pageShareLinks.useCount} + 1` }).where(eq(pageShareLinks.id, link.id));
  return { ok: true, driveId: link.driveId, userId: claim.userId, memberId: null, role: 'GUEST', customRoleId: null, driveName: link.driveName, createdBy: null };
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
      suspendedByPolicy: driveShareLinks.suspendedByPolicy,
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
    // POL-3: the landing page would otherwise name the drive and its creator to anyone holding a paused link.
    if (!(await linkUsableNow(row.driveId, row))) return null;
    return {
      type: 'drive',
      linkId: row.id,
      driveId: row.driveId,
      driveName: row.driveName ?? undefined,
      role: row.role,
      customRoleId: row.customRoleId,
      customRoleName: row.customRoleName,
      customRoleColor: row.customRoleColor,
      // Decrypt PII at the edge (GDPR #965) so the creator name is plaintext.
      creatorName: (await decryptField(row.creatorName)) ?? 'Unknown',
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
      suspendedByPolicy: pageShareLinks.suspendedByPolicy,
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
    if (!(await linkUsableNow(pageDriveId, row))) return null;
    return {
      type: 'page',
      linkId: row.id,
      driveId: pageDriveId,
      pageId: row.pageId,
      pageTitle: row.pageTitle ?? undefined,
      driveName: row.driveName ?? undefined,
      permissions: row.permissions,
      // Decrypt PII at the edge (GDPR #965) so the creator name is plaintext.
      creatorName: (await decryptField(row.creatorName)) ?? 'Unknown',
      expiresAt: row.expiresAt ?? null,
      useCount: row.useCount,
    };
  }

  return null;
}
