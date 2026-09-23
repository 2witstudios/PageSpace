/**
 * Org-owned drives: move a drive into an org, move it out, create one in an org, change its
 * visibility, hand it to a new lead (Spec DRV-1..DRV-4, O-7, O-9, O-10).
 *
 * The decisions are pure (organizations/org-drive-ownership.ts); this module is the IO edge.
 * Each operation runs in one transaction: lock the drive, lock the org, read the actor's org
 * role, decide, write drives.orgId, re-attribute the drive's stored bytes (O-9), and run the
 * org-membership sync, so a refused or failed move leaves the drive and every quota exactly as
 * they were.
 *
 * A move rewrites drives.orgId (and, on move-in, the slug when it collides inside the org and
 * the visibility). Members, custom roles, pages, envs, and publishSubdomain are keyed by
 * driveId and are not touched (DRV-2).
 */

import { db } from '@pagespace/db/db';
import { and, eq, like, sql } from '@pagespace/db/operators';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { organizations, type OrgRole } from '@pagespace/db/schema/organizations';
import { slugify } from '../utils/utils';
import { resolveUniqueSlug } from './drive-guards';
import { allocatePublishSubdomain } from './drive-service';
import {
  decideChangeDriveVisibility,
  decideChangeOrgDriveLead,
  decideCreateDriveInOrg,
  decideMoveDriveIntoOrg,
  decideMoveDriveOutOfOrg,
  orgDriveVisibilityForInsert,
  retryOnOrgSlugConflict,
  type ImplicitMembersChoice,
  type OrgDriveCreationPolicy,
  type OrgDriveRefusal,
} from '../organizations/org-drive-ownership';
import { retryOnDeadlock } from '../organizations/repository';
import { removeFormerLeadOwnerRow } from '../permissions/org-drive-membership';
import { getActorInfo, logActivityWithTx } from '../monitoring/activity-logger';
import { reattributeDriveStorageInTx, type StorageReattributionResult } from './storage-limits';

export type OrgDriveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What the org-membership sync is asked to do for one drive (D-OW-6, D-OW-10). */
export type OrgMembershipSyncCall =
  | { kind: 'move-in'; driveId: string; orgId: string }
  | { kind: 'create'; driveId: string; orgId: string }
  | { kind: 'move-out'; driveId: string; orgId: string; implicitMembers: ImplicitMembersChoice }
  | { kind: 'visibility'; driveId: string; orgId: string }
  | { kind: 'lead-change'; driveId: string; orgId: string; fromUserId: string; toUserId: string };

/** Best-effort realtime publish, run only after the membership change has committed. */
export type PublishAfterCommit = () => Promise<void>;

export interface OrgDriveServiceDeps {
  /** The user's role in the org, or null when not a member. */
  getOrgRole(tx: OrgDriveTx, orgId: string, userId: string): Promise<OrgRole | null>;
  /**
   * Materialize or retire org-sourced drive_members rows inside the move's transaction.
   * Returns the realtime publish to run once the transaction has committed.
   */
  syncOrgMembership(tx: OrgDriveTx, call: OrgMembershipSyncCall): Promise<PublishAfterCommit>;
  /** "Who can create org drives" (POL-5). */
  getOrgDriveCreationPolicy(tx: OrgDriveTx, orgId: string): Promise<OrgDriveCreationPolicy>;
}

/** What the move did to stored-byte attribution (O-9, D-OW-9). */
export type StorageReattribution = StorageReattributionResult;

type DriveRow = typeof drives.$inferSelect;

export type DriveNotFound = { ok: false; code: 'DRIVE_NOT_FOUND'; status: 404; message: string };

export type MoveDriveResult =
  /** `orgId` is the org the drive moved into, or out of. */
  | { ok: true; drive: DriveRow; orgId: string; storageReattribution: StorageReattribution }
  | OrgDriveRefusal
  | DriveNotFound;

export type CreateOrgDriveResult = { ok: true; drive: DriveRow } | OrgDriveRefusal;

const driveNotFound = (): DriveNotFound => ({
  ok: false,
  code: 'DRIVE_NOT_FOUND',
  status: 404,
  message: 'Drive not found',
});

async function lockDrive(tx: OrgDriveTx, driveId: string): Promise<DriveRow | null> {
  const [row] = await tx.select().from(drives).where(eq(drives.id, driveId)).for('update');
  return row ?? null;
}

/**
 * Share-lock the org row so the org cannot be deleted or change Owner under the decision
 * (org deletion and ownership transfer lock it FOR UPDATE). The actor's membership is guarded
 * separately: deps.getOrgRole locks their org_members row, which leave and account deletion
 * delete. Returns false when the org does not exist.
 */
async function lockOrg(tx: OrgDriveTx, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for('share');
  return row !== undefined;
}

/** A slug free inside the org: org drive slugs are unique per org (D-OW-15). */
async function freeOrgSlug(tx: OrgDriveTx, orgId: string, base: string): Promise<string> {
  const rows = await tx
    .select({ slug: drives.slug })
    .from(drives)
    .where(and(eq(drives.orgId, orgId), like(drives.slug, `${base}%`)));
  return resolveUniqueSlug(rows.map((r) => r.slug), base);
}

export async function moveDriveToOrg(
  actorId: string,
  driveId: string,
  input: { orgId: string; orgVisibility?: OrgDriveVisibility },
  deps: OrgDriveServiceDeps
): Promise<MoveDriveResult> {
  // Org row before drive row, as every org-drive path locks (org deletion, joins, move-out); a
  // leave that reassigns a led drive locks both in one statement, so a deadlock retries whole.
  const outcome = await retryOnOrgSlugConflict(() => retryOnDeadlock(() => db.transaction(async (tx) => {
    const orgExists = await lockOrg(tx, input.orgId);
    const drive = await lockDrive(tx, driveId);
    if (!drive) return driveNotFound();

    const actorOrgRole = orgExists ? await deps.getOrgRole(tx, input.orgId, actorId) : null;
    const verdict = decideMoveDriveIntoOrg({ drive, actorId, actorOrgRole });
    if (!verdict.ok) return verdict;

    const slug = await freeOrgSlug(tx, input.orgId, drive.slug);
    const [moved] = await tx
      .update(drives)
      .set({
        orgId: input.orgId,
        slug,
        // An unchosen visibility resets to the column default rather than keeping whatever
        // an earlier stint in an org left behind (DRV-4).
        orgVisibility: input.orgVisibility ?? sql`DEFAULT`,
        updatedAt: new Date(),
      })
      .where(eq(drives.id, driveId))
      .returning();

    // O-9: the drive's bytes leave each uploader's personal quota in the same transaction that
    // makes them the org's; the org's usage is derived from its drives, so it follows orgId.
    const storageReattribution = await reattributeDriveStorageInTx(tx, { driveId, orgId: input.orgId, direction: 'into-org' });
    const publish = await deps.syncOrgMembership(tx, { kind: 'move-in', driveId, orgId: input.orgId });
    return { ok: true as const, drive: moved, storageReattribution, publish };
  })));

  if (!outcome.ok) return outcome;
  const { publish, ...moved } = outcome;
  await publish();
  return { ...moved, orgId: input.orgId };
}

export async function moveDriveOutOfOrg(
  actorId: string,
  driveId: string,
  input: { implicitMembers: ImplicitMembersChoice | null },
  deps: OrgDriveServiceDeps
): Promise<MoveDriveResult> {
  const outcome = await retryOnDeadlock(() => db.transaction(async (tx) => {
    // The org row before the drive row: org deletion and joining an org lock in that order, and
    // taking the drive first would close a lock cycle with either.
    const [current] = await tx.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId));
    if (!current) return driveNotFound();
    const orgLocked = current.orgId !== null && (await lockOrg(tx, current.orgId));
    const drive = await lockDrive(tx, driveId);
    if (!drive) return driveNotFound();

    const { orgId } = drive;
    // A drive that changed org between the read and the lock is judged as outside the org locked.
    const actorOrgRole =
      orgId !== null && orgId === current.orgId && orgLocked ? await deps.getOrgRole(tx, orgId, actorId) : null;
    const verdict = decideMoveDriveOutOfOrg({ drive, actorOrgRole, implicitMembers: input.implicitMembers });
    if (!verdict.ok) return verdict;
    if (orgId === null) throw new Error('Unreachable: move-out admitted a drive with no org');

    // The lead (ownerId) stays; the drive becomes their personal drive. Personal slugs are
    // not unique per owner, so the slug is kept as is.
    const [moved] = await tx
      .update(drives)
      .set({ orgId: null, updatedAt: new Date() })
      .where(eq(drives.id, driveId))
      .returning();

    // O-9: the drive's bytes go back onto each uploader's personal quota, atomically with orgId.
    const storageReattribution = await reattributeDriveStorageInTx(tx, { driveId, orgId, direction: 'out-of-org' });
    const publish = await deps.syncOrgMembership(tx, {
      kind: 'move-out',
      driveId,
      orgId,
      implicitMembers: verdict.implicitMembers,
    });
    return { ok: true as const, drive: moved, orgId, storageReattribution, publish };
  }));

  if (!outcome.ok) return outcome;
  const { publish, ...rest } = outcome;
  await publish();
  return rest;
}

export async function createOrgDrive(
  actorId: string,
  input: { name: string; orgId: string; orgVisibility?: OrgDriveVisibility },
  deps: OrgDriveServiceDeps
): Promise<CreateOrgDriveResult> {
  const outcome = await retryOnOrgSlugConflict(() => db.transaction(async (tx) => {
    const orgExists = await lockOrg(tx, input.orgId);
    const actorOrgRole = orgExists ? await deps.getOrgRole(tx, input.orgId, actorId) : null;
    const creationPolicy = orgExists ? await deps.getOrgDriveCreationPolicy(tx, input.orgId) : 'members';
    const verdict = decideCreateDriveInOrg({ actorOrgRole, creationPolicy });
    if (!verdict.ok) return verdict;

    const slug = await freeOrgSlug(tx, input.orgId, slugify(input.name));
    const [created] = await tx
      .insert(drives)
      .values({
        name: input.name,
        slug,
        ownerId: actorId,
        orgId: input.orgId,
        ...orgDriveVisibilityForInsert(input.orgVisibility),
        updatedAt: new Date(),
      })
      .returning();
    const publishSubdomain = await allocatePublishSubdomain(created.id, slug, tx);

    const publish = await deps.syncOrgMembership(tx, { kind: 'create', driveId: created.id, orgId: input.orgId });
    return { ok: true as const, drive: { ...created, publishSubdomain }, publish };
  }));

  if (!outcome.ok) return outcome;
  const { publish, ...created } = outcome;
  await publish();
  return created;
}

/**
 * Lock the drive's org (share) then the drive (update), the order every org-drive path takes, and
 * read the actor's org role under those locks. The role is null for a personal drive, or when the
 * drive changed org between the unlocked read and the lock.
 */
async function lockDriveWithOrg(
  tx: OrgDriveTx,
  driveId: string,
  actorId: string,
  deps: OrgDriveServiceDeps
): Promise<{ drive: DriveRow; actorOrgRole: OrgRole | null } | null> {
  const [current] = await tx.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId));
  if (!current) return null;
  const orgLocked = current.orgId !== null && (await lockOrg(tx, current.orgId));
  const drive = await lockDrive(tx, driveId);
  if (!drive) return null;
  const sameOrg = drive.orgId !== null && drive.orgId === current.orgId && orgLocked;
  const actorOrgRole = sameOrg && drive.orgId !== null ? await deps.getOrgRole(tx, drive.orgId, actorId) : null;
  return { drive, actorOrgRole };
}

export type ChangeVisibilityResult =
  | { ok: true; changed: boolean; drive: DriveRow; from: OrgDriveVisibility; to: OrgDriveVisibility }
  | OrgDriveRefusal
  | DriveNotFound;

/**
 * Change an org drive's visibility (DRV-4): the drive lead or an org Owner/Admin. The org membership
 * sync runs in the same transaction, so materialized rows follow at once: an Open drive gains a row
 * for every org member, a Restricted or Private one loses every org-sourced row (direct rows, from
 * an invitation or an approved join, stay). Events publish after commit.
 */
export async function changeDriveVisibility(
  actorId: string,
  driveId: string,
  input: { orgVisibility: OrgDriveVisibility },
  deps: OrgDriveServiceDeps
): Promise<ChangeVisibilityResult> {
  const outcome = await retryOnDeadlock(() => db.transaction(async (tx) => {
    const locked = await lockDriveWithOrg(tx, driveId, actorId, deps);
    if (!locked) return driveNotFound();
    const { drive, actorOrgRole } = locked;

    const verdict = decideChangeDriveVisibility({ drive, actorId, actorOrgRole, visibility: input.orgVisibility });
    if (!verdict.ok) return verdict;
    if (drive.orgId === null) throw new Error('Unreachable: a visibility change was admitted for a drive with no org');
    if (!verdict.changed) {
      return { ok: true as const, changed: false, drive, from: verdict.from, to: verdict.to, publish: async () => {} };
    }

    const [updated] = await tx
      .update(drives)
      .set({ orgVisibility: verdict.to, updatedAt: new Date() })
      .where(eq(drives.id, driveId))
      .returning();
    const publish = await deps.syncOrgMembership(tx, { kind: 'visibility', driveId, orgId: drive.orgId });
    return { ok: true as const, changed: true, drive: updated, from: verdict.from, to: verdict.to, publish };
  }));

  if (!outcome.ok) return outcome;
  const { publish, ...changed } = outcome;
  await publish();
  return changed;
}

export type ChangeLeadResult =
  | { ok: true; changed: boolean; drive: DriveRow; fromUserId: string; toUserId: string }
  | OrgDriveRefusal
  | DriveNotFound;

/**
 * Hand an org drive to a new lead (DRV-1, D-OW-7): the current lead or an org Owner/Admin names an
 * org member. In one transaction the former lead's OWNER row goes (demote) and drives.ownerId moves
 * (promote), then the org membership sync puts both people where their own membership puts them:
 * the new lead needs no row, the former lead keeps an Open drive through org membership and keeps a
 * direct row they hold, and otherwise loses access. An activity event names both people.
 */
export async function changeOrgDriveLead(
  actorId: string,
  driveId: string,
  input: { newLeadId: string },
  deps: OrgDriveServiceDeps
): Promise<ChangeLeadResult> {
  const outcome = await retryOnDeadlock(() => db.transaction(async (tx) => {
    const locked = await lockDriveWithOrg(tx, driveId, actorId, deps);
    if (!locked) return driveNotFound();
    const { drive, actorOrgRole } = locked;
    // Share-locks the target's org_members row too, so they cannot leave the org mid-handover.
    const targetOrgRole = actorOrgRole !== null && drive.orgId !== null
      ? await deps.getOrgRole(tx, drive.orgId, input.newLeadId)
      : null;

    const verdict = decideChangeOrgDriveLead({ drive, actorId, actorOrgRole, targetId: input.newLeadId, targetOrgRole });
    if (!verdict.ok) return verdict;
    if (drive.orgId === null) throw new Error('Unreachable: a lead change was admitted for a drive with no org');
    if (!verdict.changed) {
      return { ok: true as const, changed: false, drive, fromUserId: verdict.fromUserId, toUserId: verdict.toUserId, publish: async () => {} };
    }

    await removeFormerLeadOwnerRow(tx, driveId, verdict.fromUserId);
    const [updated] = await tx
      .update(drives)
      .set({ ownerId: verdict.toUserId, updatedAt: new Date() })
      .where(eq(drives.id, driveId))
      .returning();

    const actor = await getActorInfo(actorId);
    await logActivityWithTx(
      {
        userId: actorId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        operation: 'ownership_transfer',
        resourceType: 'drive',
        resourceId: driveId,
        driveId,
        previousValues: { ownerId: verdict.fromUserId },
        newValues: { ownerId: verdict.toUserId },
        metadata: { orgId: drive.orgId, reason: 'lead_changed' },
      },
      tx as unknown as typeof db,
    );

    const publish = await deps.syncOrgMembership(tx, {
      kind: 'lead-change',
      driveId,
      orgId: drive.orgId,
      fromUserId: verdict.fromUserId,
      toUserId: verdict.toUserId,
    });
    return { ok: true as const, changed: true, drive: updated, fromUserId: verdict.fromUserId, toUserId: verdict.toUserId, publish };
  }));

  if (!outcome.ok) return outcome;
  const { publish, ...changed } = outcome;
  await publish();
  return changed;
}
