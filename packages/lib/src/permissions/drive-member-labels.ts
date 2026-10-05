/**
 * drive-member-labels — how the drive Members page labels a person (Spec DRV-8, UI-5, D-OW-24).
 *
 *   - `source`: how their drive_members row came to be — `invite` (someone invited them) or `org`
 *     (materialized from org membership); the lead has no row and reads `lead`.
 *   - `isGuest` (DRV-8): a member of an ORG drive who holds no accepted role in that org. A
 *     personal drive has no org, so nobody on it is a guest.
 *   - page-link guests (D-OW-24): a GUEST row from a redeemed page share link is not a drive
 *     member at all (guest-role); the Members page lists them apart, as `guests`.
 *
 * The decisions are pure; the two reads below are the only queries, and they live here, in the
 * permissions layer, beside every other drive_members read.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions, userProfiles } from '@pagespace/db/schema/members';
import { decryptUserRow } from '../auth/user-repository';
import { orgMembers } from '@pagespace/db/schema/organizations';

export type DriveMemberSource = 'invite' | 'org' | 'lead';

/** DRV-8: a member of an org drive who is not an accepted member of its org. */
export function isDriveGuest(input: { driveOrgId: string | null; isOrgMember: boolean }): boolean {
  return input.driveOrgId !== null && !input.isOrgMember;
}

/**
 * A row materialized FROM org membership (`source: 'org'`) whose person has since left the org is
 * stale: it grants nothing (the one access model reads it as none), so the Members page does not
 * list it at all — and it is never labelled a guest. An INVITED outsider is a guest.
 */
export function isStaleOrgRow(input: { driveOrgId: string | null; isOrgMember: boolean; source: 'invite' | 'org' }): boolean {
  return input.source === 'org' && input.driveOrgId !== null && !input.isOrgMember;
}

/** The drive's org (null for a personal drive). */
export async function driveOrgIdOf(driveId: string): Promise<string | null> {
  const [row] = await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId));
  return row?.orgId ?? null;
}

/** Which of `userIds` hold an accepted role in `orgId`. */
export async function acceptedOrgMemberIds(orgId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), inArray(orgMembers.userId, userIds)));
  return new Set(rows.map((r) => r.userId));
}

/** One page-link guest (D-OW-24) as the Members page lists them: who, how they came, what they hold. */
export interface DrivePageLinkGuest {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  acceptedAt: Date | null;
  source: 'invite' | 'org';
  /** Pages in this drive the guest holds a grant on. */
  pageGrantCount: number;
}

/** Every accepted GUEST row of the drive (D-OW-24), by name. */
export async function listDrivePageLinkGuests(driveId: string): Promise<DrivePageLinkGuest[]> {
  const rows = await db
    .select({
      userId: driveMembers.userId,
      source: driveMembers.source,
      acceptedAt: driveMembers.acceptedAt,
      name: users.name,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      avatarUrl: userProfiles.avatarUrl,
      pageGrantCount: sql<number>`(SELECT count(*)::int FROM ${pagePermissions} pp JOIN ${pages} p ON pp."pageId" = p.id WHERE p."driveId" = ${driveId} AND pp."userId" = ${driveMembers.userId})`,
    })
    .from(driveMembers)
    .leftJoin(users, eq(users.id, driveMembers.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, driveMembers.userId))
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.role, 'GUEST'), isNotNull(driveMembers.acceptedAt)));
  const named = await Promise.all(rows.map(async (r) => ({ ...r, name: (await decryptUserRow({ name: r.name })).name ?? null })));
  return named
    .map((r) => ({
      userId: r.userId,
      displayName: r.displayName ?? r.name ?? r.username ?? 'Unknown user',
      username: r.username,
      avatarUrl: r.avatarUrl,
      acceptedAt: r.acceptedAt,
      source: r.source,
      pageGrantCount: Number(r.pageGrantCount ?? 0),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
