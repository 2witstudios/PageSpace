/**
 * Demoting an org member (Admin to Member) revokes what only the higher role could have handed out
 * in the org's drives (the #2669 review ruling: removal and demotion run leave's revocation, and
 * demotion revokes only what the lower role could not have created).
 *
 * Per org drive the decision compares the person's effective access before and after, through the
 * same pure resolveEffectiveDriveMembership every resolver uses:
 * - access gone (a RESTRICTED or PRIVATE drive org power alone opened): everything leave revokes
 *   there, since a Member could have created none of it.
 * - ADMIN became MEMBER (an OPEN drive): drive share links (owner/admin only), page share links on
 *   pages a Member could not share, and agent grants above the Member cap. Key scopes and OAuth
 *   grants stay: an inheriting scope follows the person, and org power never minted an explicit one.
 * - otherwise (a row still backs the access, a drive they lead, Owner to Admin): nothing.
 */

import { and, eq, gt, inArray, isNull, or } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { resolveEffectiveDriveMembership } from '../permissions/org-drive-resolution';
import type { OrgDriveMembership } from '../permissions/org-access';
import { loadAcceptedRowsInDrives } from '../permissions/org-drive-membership';
import { resolveCustomRolePermissions, type CustomRolePerms, type PagePerm } from '../permissions/membership-queries';
import { recapAgentMembershipsGrantedBy } from '../services/drive-agent-service';
import { revokeOrgDriveGrants, type LeaveTx, type OrgDriveGrantCounts } from './leave';

// ── Pure decisions ────────────────────────────────────────────────────────────

export interface DemotionDrive {
  driveId: string;
  orgId: string;
  /** drives.ownerId */
  leadId: string;
  orgVisibility: OrgDriveVisibility;
  /** The demoted person's ACCEPTED drive_members row, if any. */
  row: OrgDriveMembership | null;
  /** The drive's default custom role (drive_roles.isDefault), if any. */
  defaultCustomRoleId: string | null;
}

export interface DemotionPlan {
  /** Drives the lower role cannot open at all. */
  revokeAll: string[];
  /** Drives where ADMIN reach became MEMBER reach, with the custom role that now caps it. */
  capToMember: Array<{ driveId: string; customRoleId: string | null }>;
}

export function planDemotionRevocation({
  userId,
  fromRole,
  toRole,
  drives: orgDrives,
}: {
  userId: string;
  fromRole: OrgRole;
  toRole: OrgRole;
  drives: DemotionDrive[];
}): DemotionPlan {
  const plan: DemotionPlan = { revokeAll: [], capToMember: [] };
  for (const d of orgDrives) {
    if (d.leadId === userId) continue;
    const resolve = (orgRole: OrgRole) => resolveEffectiveDriveMembership({
      orgsEnabled: true,
      drive: { orgId: d.orgId, orgVisibility: d.orgVisibility },
      orgRole,
      row: d.row,
      driveDefaultRole: { role: 'MEMBER', customRoleId: d.defaultCustomRoleId },
    });
    const before = resolve(fromRole);
    const after = resolve(toRole);
    if (before === null) continue;
    if (after === null) plan.revokeAll.push(d.driveId);
    else if (before.role === 'ADMIN' && after.role !== 'ADMIN') {
      plan.capToMember.push({ driveId: d.driveId, customRoleId: after.customRoleId });
    }
  }
  return plan;
}

/**
 * Whether a drive MEMBER could share a page (canShare), exactly as getUserAccessLevel decides it
 * for a non-admin: an explicit page permission decides alone; else the custom role, whose
 * drive-wide fallback never reaches a private page; else a plain member shares nothing.
 */
export function memberCouldSharePage({
  pageId,
  isPrivate,
  explicitCanShare,
  customRole,
}: {
  pageId: string;
  isPrivate: boolean;
  /** The member's unexpired page permission's canShare; null when they hold none. */
  explicitCanShare: boolean | null;
  customRole: { permissions: CustomRolePerms; driveWidePermissions: PagePerm | null } | null;
}): boolean {
  if (explicitCanShare !== null) return explicitCanShare;
  if (!customRole) return false;
  const resolved = resolveCustomRolePermissions(customRole, pageId);
  if (resolved === null) return false;
  if (isPrivate && customRole.permissions[pageId] === undefined) return false;
  return resolved.canView && resolved.canShare;
}

// ── IO ────────────────────────────────────────────────────────────────────────

export interface DemotionRevocationCounts extends OrgDriveGrantCounts {
  /** Agent grants reduced to, or revoked for exceeding, the Member cap on capped drives. */
  recappedAgentMemberships: number;
}

/**
 * Run the demotion revocation for `userId` in `orgId`, inside the role change's transaction, after
 * the org_members row was updated. Everything is read through `tx`.
 */
export async function revokeForDemotion(
  tx: LeaveTx,
  input: { orgId: string; userId: string; fromRole: OrgRole; toRole: OrgRole },
): Promise<DemotionRevocationCounts> {
  const { orgId, userId } = input;
  const orgDrives = await tx
    .select({ driveId: drives.id, leadId: drives.ownerId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(eq(drives.orgId, orgId));
  const driveIds = orgDrives.map((d) => d.driveId);

  const rowByDrive = await loadAcceptedRowsInDrives(tx, userId, driveIds);
  const defaults = driveIds.length === 0 ? [] : await tx
    .select({ driveId: driveRoles.driveId, id: driveRoles.id })
    .from(driveRoles)
    .where(and(inArray(driveRoles.driveId, driveIds), eq(driveRoles.isDefault, true)));

  const defaultByDrive = new Map(defaults.map((r) => [r.driveId, r.id]));
  const plan = planDemotionRevocation({
    userId,
    fromRole: input.fromRole,
    toRole: input.toRole,
    drives: orgDrives.map((d) => {
      return {
        ...d,
        orgId,
        row: rowByDrive.get(d.driveId) ?? null,
        defaultCustomRoleId: defaultByDrive.get(d.driveId) ?? null,
      };
    }),
  });

  const counts: DemotionRevocationCounts = {
    ...(await revokeOrgDriveGrants(tx, userId, plan.revokeAll)),
    recappedAgentMemberships: 0,
  };

  for (const { driveId, customRoleId } of plan.capToMember) {
    const driveLinks = await tx
      .delete(driveShareLinks)
      .where(and(eq(driveShareLinks.createdBy, userId), eq(driveShareLinks.driveId, driveId)))
      .returning({ id: driveShareLinks.id });
    counts.driveShareLinks += driveLinks.length;
    counts.pageShareLinks += await revokeUnshareablePageLinks(tx, userId, driveId, customRoleId);
    counts.recappedAgentMemberships += (await recapAgentMembershipsGrantedBy(driveId, userId, {
      executor: tx,
      granter: { maxRole: 'MEMBER', customRoleId },
    })).length;
  }

  return counts;
}

async function revokeUnshareablePageLinks(tx: LeaveTx, userId: string, driveId: string, customRoleId: string | null): Promise<number> {
  const links = await tx
    .select({ id: pageShareLinks.id, pageId: pageShareLinks.pageId, isPrivate: pages.isPrivate })
    .from(pageShareLinks)
    .innerJoin(pages, eq(pages.id, pageShareLinks.pageId))
    .where(and(eq(pageShareLinks.createdBy, userId), eq(pages.driveId, driveId)));
  if (links.length === 0) return 0;

  const explicit = await tx
    .select({ pageId: pagePermissions.pageId, canShare: pagePermissions.canShare })
    .from(pagePermissions)
    .where(and(
      eq(pagePermissions.userId, userId),
      inArray(pagePermissions.pageId, links.map((l) => l.pageId)),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date())),
    ));
  const explicitByPage = new Map(explicit.map((p) => [p.pageId, p.canShare]));
  const [role] = customRoleId === null ? [] : await tx
    .select({ permissions: driveRoles.permissions, driveWidePermissions: driveRoles.driveWidePermissions })
    .from(driveRoles)
    .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)));

  const unshareable = links.filter((l) => !memberCouldSharePage({
    pageId: l.pageId,
    isPrivate: l.isPrivate ?? false,
    explicitCanShare: explicitByPage.get(l.pageId) ?? null,
    customRole: role ?? null,
  }));
  if (unshareable.length === 0) return 0;
  await tx.delete(pageShareLinks).where(inArray(pageShareLinks.id, unshareable.map((l) => l.id)));
  return unshareable.length;
}
