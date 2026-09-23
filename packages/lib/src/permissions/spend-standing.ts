import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { isDriveLead, isDriveMemberRelationship } from './drive-relationship';
import { loadDriveRelationships } from './drive-relationship-loader';
import type { WalletStanding } from './wallet-access';

/**
 * A person's standing in the drive an AI call runs in, for the wallet-aware credit gate
 * (SPEND-1, DRV-8): the drive's org and owner, whether they are an effective member of the
 * drive (the one org-aware access model), and whether they hold a seat in its org (an
 * accepted org member). A pending, unaccepted invite grants nothing: org_members rows exist
 * only for accepted members, and the drive membership model counts accepted rows only.
 *
 * Null when the drive does not exist. Never throws on a non-member: that is an answer
 * (`isDriveMember: false`), and the gate treats it as a guest.
 */
export interface DriveSpendStanding {
  driveId: string;
  orgId: string | null;
  /** The drive's lead, whose personal wallet parents a personal drive's wallet (WAL-2). */
  ownerId: string;
  /** The caller leads this drive. */
  isLead: boolean;
  isDriveMember: boolean;
  isOrgMember: boolean;
}

export async function loadDriveSpendStanding(userId: string, driveId: string): Promise<DriveSpendStanding | null> {
  const [drive] = await db
    .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive) return null;

  // The gate reads this for the caller's own request, whose drive access was already
  // decided (and audited) by the route; this read only classifies the spender.
  const relationships = await loadDriveRelationships(userId, [drive], { audit: false });
  const relationship = relationships.get(drive.id);
  const isDriveMember = relationship ? isDriveMemberRelationship(relationship) : false;

  let isOrgMember = false;
  if (drive.orgId !== null) {
    const [membership] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, drive.orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    isOrgMember = membership !== undefined;
  }

  return {
    driveId: drive.id,
    orgId: drive.orgId,
    ownerId: drive.ownerId,
    isLead: isDriveLead(userId, drive),
    isDriveMember,
    isOrgMember,
  };
}

/**
 * Which SHARED legs a person may draw at all in a drive — the authorization for spend, decided
 * here and never by the spend actor's guest flag (review 5296437500, P1-2). The drive wallet
 * opens only to an effective member of the drive (the lead, an accepted member, an org
 * Owner/Admin, an org member of an Open drive): an org member with no membership of a
 * Restricted or Private org drive draws nothing there, whatever source or wallet id they
 * name. A seat is the per-consumer leg on the org pool, so it additionally needs an accepted
 * org membership (a guest holds none, DRV-8). A person's own credits are theirs everywhere and
 * are not decided here. A missing drive opens nothing.
 */
export function sharedSpendLegsFor(standing: DriveSpendStanding | null): { driveWallet: boolean; seat: boolean } {
  if (standing === null || !standing.isDriveMember) return { driveWallet: false, seat: false };
  return { driveWallet: true, seat: standing.orgId !== null && standing.isOrgMember };
}

/** A person's standing for the drive-wallet surfaces, with the drive facts the service needs. */
export interface DriveWalletStanding extends WalletStanding {
  driveId: string;
  ownerId: string;
}

/**
 * The standing a drive-wallet route decides on (wallet-access `walletViewerRole`): effective
 * drive membership through the one org-aware access model — audited, since an org Owner or
 * Admin reaching a Private drive through org power is an ORG-4 audit event — and the person's
 * ACCEPTED role in the drive's org (org_members holds accepted members only; a pending invite
 * is no role). Null when the drive does not exist or is trashed.
 */
export async function loadDriveWalletStanding(userId: string, driveId: string): Promise<DriveWalletStanding | null> {
  const [drive] = await db
    .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility, isTrashed: drives.isTrashed })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive || drive.isTrashed) return null;

  const relationship = (await loadDriveRelationships(userId, [drive])).get(drive.id);
  let orgRole: WalletStanding['orgRole'] = null;
  if (drive.orgId !== null) {
    const [membership] = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, drive.orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    orgRole = membership?.role ?? null;
  }
  return {
    driveId: drive.id,
    ownerId: drive.ownerId,
    orgId: drive.orgId,
    isLead: isDriveLead(userId, drive),
    isDriveMember: relationship ? isDriveMemberRelationship(relationship) : false,
    orgRole,
  };
}
