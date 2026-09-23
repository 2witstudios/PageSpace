import { db } from '@pagespace/db/db';
import { and, asc, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { driveJoinRequests } from '@pagespace/db/schema/drive-join-requests';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { decryptUserRows } from '../auth/user-repository';
import type { DriveMemberRole } from './org-access';
import { decideDriveDirectoryEntry, type DirectoryEntry, type RequesterRow } from './drive-join-requests';

/**
 * The org Drives directory (Spec DRV-6, A-4): every drive of an org one member may see there, with
 * its visibility, whether they have joined it, their open join request, and its lead. The ONLY
 * place a Restricted drive is discovered before joining; the picker and sidebar never list it.
 * Which drive appears, and how, is decideDriveDirectoryEntry's; this is its IO.
 *
 * Constant queries however many drives: the viewer's org role, the org's live drives, the viewer's
 * rows and pending requests in them, and the leads' names.
 */

export interface OrgDriveDirectoryEntry extends DirectoryEntry {
  id: string;
  name: string;
  slug: string;
  orgVisibility: OrgDriveVisibility;
  lead: { id: string; name: string | null; image: string | null };
}

/** Chunk size for id IN lists (Postgres bind parameter limit). */
const IN_LIST_CHUNK = 500;

/** Most drives one org directory returns. */
const DIRECTORY_LIMIT = 5000;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_LIST_CHUNK) out.push(items.slice(i, i + IN_LIST_CHUNK));
  return out;
}

/**
 * The directory for `viewerId` in `orgId`, ordered by drive name, or null when the viewer is not a
 * member of the org (a non-member sees no directory at all).
 */
export async function listOrgDriveDirectory(orgId: string, viewerId: string): Promise<OrgDriveDirectoryEntry[] | null> {
  const [membership] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, viewerId)))
    .limit(1);
  if (!membership) return null;

  const orgDrives = await db
    .select({ id: drives.id, name: drives.name, slug: drives.slug, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility, isTrashed: drives.isTrashed })
    .from(drives)
    .where(and(eq(drives.orgId, orgId), eq(drives.isTrashed, false)))
    .orderBy(asc(drives.name), asc(drives.id))
    .limit(DIRECTORY_LIMIT);
  if (orgDrives.length === 0) return [];

  const rowByDrive = new Map<string, RequesterRow>();
  const pendingDrives = new Set<string>();
  for (const ids of chunks(orgDrives.map((d) => d.id))) {
    const rows = await db
      .select({ driveId: driveMembers.driveId, role: driveMembers.role, source: driveMembers.source, acceptedAt: driveMembers.acceptedAt })
      .from(driveMembers)
      .where(and(eq(driveMembers.userId, viewerId), inArray(driveMembers.driveId, ids)));
    for (const r of rows) {
      rowByDrive.set(r.driveId, { role: r.role as DriveMemberRole, source: r.source, accepted: r.acceptedAt !== null });
    }
    const requests = await db
      .select({ driveId: driveJoinRequests.driveId })
      .from(driveJoinRequests)
      .where(and(eq(driveJoinRequests.userId, viewerId), eq(driveJoinRequests.status, 'pending'), inArray(driveJoinRequests.driveId, ids)));
    for (const r of requests) pendingDrives.add(r.driveId);
  }

  const listed = orgDrives.flatMap((drive) => {
    const entry = decideDriveDirectoryEntry({
      viewerId,
      viewerOrgRole: membership.role,
      drive,
      viewerRow: rowByDrive.get(drive.id) ?? null,
      hasPendingRequest: pendingDrives.has(drive.id),
    });
    return entry ? [{ drive, entry }] : [];
  });

  const leads = new Map<string, { id: string; name: string | null; image: string | null }>();
  for (const ids of chunks([...new Set(listed.map(({ drive }) => drive.ownerId))])) {
    const rows = await decryptUserRows(await db
      .select({ id: users.id, name: users.name, image: users.image })
      .from(users)
      .where(inArray(users.id, ids)));
    for (const r of rows) leads.set(r.id, { id: r.id, name: r.name, image: r.image });
  }

  return listed.map(({ drive, entry }) => ({
    id: drive.id,
    name: drive.name,
    slug: drive.slug,
    orgVisibility: drive.orgVisibility,
    ...entry,
    lead: leads.get(drive.ownerId) ?? { id: drive.ownerId, name: null, image: null },
  }));
}
