/**
 * Read models the org settings pages show and no route served (D-OW-38, canvas "data: needs read
 * model"): the org's guests, each org drive's people, guests and storage, and each member's drive
 * count and last activity. One function per datum; the routes only authorize and serialize.
 *
 * Here, in permissions/, because each reads drive_members (the drive-access seam). None of them
 * decides access: they count what the access model already materialized. A pending (unaccepted)
 * row is listed as pending and never counted as a member.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull, max, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { sessions } from '@pagespace/db/schema/sessions';
import { files } from '@pagespace/db/schema/storage';
import { decryptUserRows } from '../auth/user-repository';
import { orgRoleAtLeast } from '../organizations/org-roles';
import { isStaleOrgRow } from './drive-member-labels';

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

export interface DriveMemberRow {
  driveId: string;
  userId: string;
  acceptedAt: Date | null;
  source: 'invite' | 'org';
}

/** A departed member's materialized row grants nothing (isStaleOrgRow): it is not a person in the drive. */
const ON_AN_ORG_DRIVE = 'org';
const counts = (row: DriveMemberRow, orgMemberIds: ReadonlySet<string>): boolean =>
  // Every row these models read is on one of the org's drives, so the drive's org is never null.
  !isStaleOrgRow({ driveOrgId: ON_AN_ORG_DRIVE, isOrgMember: orgMemberIds.has(row.userId), source: row.source });

export interface GuestRow extends DriveMemberRow {
  name: string | null;
  email: string | null;
  image: string | null;
  driveName: string;
}

export interface OrgGuest {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
  drives: { id: string; name: string; pending: boolean }[];
}

/** DRV-8: people in the org's drives who are not org members, once each, with every drive they are in. */
export function summarizeOrgGuests(rows: readonly GuestRow[], orgMemberIds: ReadonlySet<string>): OrgGuest[] {
  const byUser = new Map<string, OrgGuest>();
  for (const row of rows) {
    if (orgMemberIds.has(row.userId) || !counts(row, orgMemberIds)) continue;
    let guest = byUser.get(row.userId);
    if (!guest) {
      guest = { userId: row.userId, name: row.name, email: row.email, image: row.image, drives: [] };
      byUser.set(row.userId, guest);
    }
    if (!guest.drives.some((d) => d.id === row.driveId)) {
      guest.drives.push({ id: row.driveId, name: row.driveName, pending: row.acceptedAt === null });
    }
  }
  const label = (g: OrgGuest) => (g.name ?? g.email ?? g.userId).toLowerCase();
  return [...byUser.values()].sort((a, b) => label(a).localeCompare(label(b)));
}

export interface OrgDriveUsage {
  driveId: string;
  /** Distinct people with an accepted row. */
  memberCount: number;
  /** Of those, how many are not org members. */
  guestCount: number;
  /** Bytes of the drive's stored files (files.sizeBytes, the WAL-9 basis). */
  storageBytes: number;
}

export function summarizeDriveUsage(input: {
  driveIds: readonly string[];
  memberRows: readonly DriveMemberRow[];
  orgMemberIds: ReadonlySet<string>;
  fileBytes: readonly { driveId: string; bytes: number }[];
}): OrgDriveUsage[] {
  const people = new Map<string, Set<string>>();
  for (const row of input.memberRows) {
    if (row.acceptedAt === null || !counts(row, input.orgMemberIds)) continue;
    const set = people.get(row.driveId) ?? new Set<string>();
    set.add(row.userId);
    people.set(row.driveId, set);
  }
  const bytes = new Map(input.fileBytes.map((f) => [f.driveId, f.bytes]));
  return input.driveIds.map((driveId) => {
    const set = people.get(driveId) ?? new Set<string>();
    let guestCount = 0;
    for (const userId of set) if (!input.orgMemberIds.has(userId)) guestCount += 1;
    return { driveId, memberCount: set.size, guestCount, storageBytes: bytes.get(driveId) ?? 0 };
  });
}

export interface OrgMemberActivity {
  userId: string;
  /** Org drives the member can open: every one for an Owner or Admin (ORG-4), else those they hold an accepted row in. */
  driveCount: number;
  /** The member's most recent session use, ISO, or null when unknown. */
  lastActiveAt: string | null;
}

export function summarizeMemberActivity(input: {
  members: readonly { userId: string; role: OrgRole }[];
  orgDriveCount: number;
  memberRows: readonly DriveMemberRow[];
  lastUsed: readonly { userId: string; at: Date | null }[];
}): OrgMemberActivity[] {
  const drivesByUser = new Map<string, Set<string>>();
  for (const row of input.memberRows) {
    if (row.acceptedAt === null) continue;
    const set = drivesByUser.get(row.userId) ?? new Set<string>();
    set.add(row.driveId);
    drivesByUser.set(row.userId, set);
  }
  const last = new Map(input.lastUsed.map((l) => [l.userId, l.at]));
  return input.members.map((m) => ({
    userId: m.userId,
    driveCount: orgRoleAtLeast(m.role, 'ADMIN') ? input.orgDriveCount : (drivesByUser.get(m.userId)?.size ?? 0),
    lastActiveAt: last.get(m.userId)?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

const MAX_ROWS = 50_000;

async function liveOrgDrives(orgId: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: drives.id, name: drives.name })
    .from(drives)
    .where(and(eq(drives.orgId, orgId), eq(drives.isTrashed, false)))
    .limit(5000);
}

async function orgMemberRoles(orgId: string): Promise<{ userId: string; role: OrgRole }[]> {
  return db.select({ userId: orgMembers.userId, role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.orgId, orgId)).limit(5000);
}

async function memberRowsIn(driveIds: string[]): Promise<DriveMemberRow[]> {
  if (driveIds.length === 0) return [];
  const out: DriveMemberRow[] = [];
  for (let i = 0; i < driveIds.length; i += 500) {
    const chunk = driveIds.slice(i, i + 500);
    out.push(
      ...(await db
        .select({ driveId: driveMembers.driveId, userId: driveMembers.userId, acceptedAt: driveMembers.acceptedAt, source: driveMembers.source })
        .from(driveMembers)
        .where(inArray(driveMembers.driveId, chunk))
        .limit(MAX_ROWS)),
    );
  }
  return out;
}

/** GET /api/orgs/[orgId]/guests: the org's guests (Members & seats › Guests). */
export async function listOrgGuests(orgId: string): Promise<OrgGuest[]> {
  const orgDrives = await liveOrgDrives(orgId);
  if (orgDrives.length === 0) return [];
  const names = new Map(orgDrives.map((d) => [d.id, d.name]));
  const memberIds = new Set((await orgMemberRoles(orgId)).map((m) => m.userId));
  const rows: GuestRow[] = [];
  const ids = orgDrives.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = await db
      .select({
        driveId: driveMembers.driveId,
        userId: driveMembers.userId,
        acceptedAt: driveMembers.acceptedAt,
        source: driveMembers.source,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(driveMembers)
      .innerJoin(users, eq(users.id, driveMembers.userId))
      .where(inArray(driveMembers.driveId, ids.slice(i, i + 500)))
      .limit(MAX_ROWS);
    const outsiders = chunk.filter((r) => !memberIds.has(r.userId));
    for (const row of await decryptUserRows(outsiders)) rows.push({ ...row, driveName: names.get(row.driveId) ?? '' });
  }
  return summarizeOrgGuests(rows, memberIds);
}

/** GET /api/orgs/[orgId]/drives/usage: people, guests and storage per live org drive (Drives page). */
export async function listOrgDriveUsage(orgId: string): Promise<OrgDriveUsage[]> {
  const orgDrives = await liveOrgDrives(orgId);
  const driveIds = orgDrives.map((d) => d.id);
  if (driveIds.length === 0) return [];
  const [memberRows, roles, fileBytes] = await Promise.all([
    memberRowsIn(driveIds),
    orgMemberRoles(orgId),
    db
      .select({ driveId: files.driveId, bytes: sql<string | number>`COALESCE(SUM(${files.sizeBytes}), 0)` })
      .from(files)
      .innerJoin(drives, eq(drives.id, files.driveId))
      .where(eq(drives.orgId, orgId))
      .groupBy(files.driveId),
  ]);
  return summarizeDriveUsage({
    driveIds,
    memberRows,
    orgMemberIds: new Set(roles.map((r) => r.userId)),
    fileBytes: fileBytes.flatMap((f) => (f.driveId ? [{ driveId: f.driveId, bytes: Number(f.bytes) }] : [])),
  });
}

/** GET /api/orgs/[orgId]/members/activity: drive count and last activity per member (Members & seats). */
export async function listOrgMemberActivity(orgId: string): Promise<OrgMemberActivity[]> {
  const [orgDrives, members] = await Promise.all([liveOrgDrives(orgId), orgMemberRoles(orgId)]);
  const userIds = members.map((m) => m.userId);
  const [memberRows, lastUsed] = await Promise.all([
    memberRowsIn(orgDrives.map((d) => d.id)),
    userIds.length === 0
      ? Promise.resolve([] as { userId: string; at: Date | null }[])
      : db
          .select({ userId: sessions.userId, at: max(sessions.lastUsedAt) })
          .from(sessions)
          .where(and(inArray(sessions.userId, userIds), isNull(sessions.revokedAt)))
          .groupBy(sessions.userId),
  ]);
  const memberIds = new Set(userIds);
  return summarizeMemberActivity({
    members,
    orgDriveCount: orgDrives.length,
    memberRows: memberRows.filter((r) => memberIds.has(r.userId)),
    lastUsed,
  });
}

export interface OrgTrashedDrive {
  id: string;
  name: string;
  trashedAt: string | null;
  lead: { id: string; name: string | null };
}

/**
 * GET /api/orgs/[orgId]/drives/trashed: every trashed drive the org owns, Private ones included (the Drives
 * page's Trashed tab is Owner/Admin-only; ORG-4 gives them every org drive), not just those in the viewer's
 * own drive list.
 */
export async function listOrgTrashedDrives(orgId: string): Promise<OrgTrashedDrive[]> {
  const rows = await db
    .select({ id: drives.id, name: drives.name, trashedAt: drives.trashedAt, leadId: drives.ownerId })
    .from(drives)
    .where(and(eq(drives.orgId, orgId), eq(drives.isTrashed, true)))
    .limit(5000);
  const leadIds = [...new Set(rows.map((r) => r.leadId))];
  const leads = leadIds.length === 0
    ? []
    : await decryptUserRows(await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, leadIds)));
  const leadName = new Map(leads.map((l) => [l.id, l.name ?? null]));
  return rows
    .map((r) => ({ id: r.id, name: r.name, trashedAt: r.trashedAt?.toISOString() ?? null, lead: { id: r.leadId, name: leadName.get(r.leadId) ?? null } }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
