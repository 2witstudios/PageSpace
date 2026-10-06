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
  visibilityChangeOnlyRestricts,
  type ImplicitMembersChoice,
  type OrgDriveCreationPolicy,
  type OrgDriveRefusal,
} from '../organizations/org-drive-ownership';
import { retryOnDeadlock } from '../organizations/repository';
import { openDriveFloorRefusal } from '../organizations/open-role-floor';
import { holdOrgGuestsUnderPolicy, kickSuspendedGuests } from '../permissions/guest-holds';
import { checkOrgActive, checkOrgMayLoosen, type OrgLapsedRefusal } from '../organizations/status';
import { removeFormerLeadOwnerRow } from '../permissions/org-drive-membership';
import { getActorInfo, logActivityWithTx } from '../monitoring/activity-logger';
import { reattributeDriveStorageInTx, type StorageReattributionResult } from './storage-limits';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';

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
  | OrgLapsedRefusal
  | DriveNotFound;

/** A lapsed org (SEAT-9) refuses a new drive and a move in; moving a drive OUT stays open. */
export type CreateOrgDriveResult = { ok: true; drive: DriveRow } | OrgDriveRefusal | OrgLapsedRefusal;

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

/**
 * POL-6: a drive about to be an Open drive of `orgId` whose default role (none, for a new drive) is below the org's
 * Open-drive role floor is refused. Called with the org row locked.
 */
async function openFloorCheck(tx: OrgDriveTx, input: { driveId: string | null; orgId: string; visibilityAfter: OrgDriveVisibility }): Promise<OrgDriveRefusal | null> {
  const refusal = await openDriveFloorRefusal(tx, input);
  return refusal ? { ok: false, code: 'POLICY_OPEN_ROLE_FLOOR', status: 403, message: refusal.message } : null;
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
    // POL-5: moving a drive in makes it an org drive, so it is judged by the same who-can-create policy as creating one.
    const creation = decideCreateDriveInOrg({ actorOrgRole, creationPolicy: await deps.getOrgDriveCreationPolicy(tx, input.orgId) });
    if (!creation.ok) return creation;
    // SEAT-9: judged after the permission verdict, so only someone who may move the drive in
    // learns the org's billing state; read under the org row lock taken above.
    const active = await checkOrgActive(input.orgId, { executor: tx });
    if (!active.ok) return active;
    // An unchosen visibility is the column default, Open.
    const floor = await openFloorCheck(tx, { driveId, orgId: input.orgId, visibilityAfter: input.orgVisibility ?? 'OPEN' });
    if (floor) return floor;

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
    // POL-2 (Review #2762 P1-1): the drive brings its outsiders with it. Under the org row lock taken above, the
    // org's guests policy decides them as it decides any admission: off parks them (restored when guests come back
    // on), approve queues them for an Owner or Admin, on leaves them. The move itself is never refused for it.
    const heldGuests = await holdOrgGuestsUnderPolicy(tx, { orgId: input.orgId, driveId });
    return { ok: true as const, drive: moved, storageReattribution, publish, heldGuests };
  })));

  if (!outcome.ok) return outcome;
  const { publish, heldGuests, ...moved } = outcome;
  await publish();
  await kickSuspendedGuests(heldGuests);
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    driveId,
    eventType: 'org.drive.moved_in',
    actorId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { orgVisibility: moved.drive.orgVisibility },
  });
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
  await recordOrgAuditEventAfterCommit({
    orgId: rest.orgId,
    driveId,
    eventType: 'org.drive.moved_out',
    actorId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { implicitMembers: input.implicitMembers },
  });
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
    // SEAT-9: creating org drives is an org-only capability (after the permission verdict, as above).
    const active = await checkOrgActive(input.orgId, { executor: tx });
    if (!active.ok) return active;
    // A new drive has no default role yet, so it holds the plain MEMBER role: Open is refused under an edit floor.
    const floor = await openFloorCheck(tx, { driveId: null, orgId: input.orgId, visibilityAfter: input.orgVisibility ?? 'OPEN' });
    if (floor) return floor;

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
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    driveId: created.drive.id,
    eventType: 'org.drive.created',
    actorId,
    resourceType: 'drive',
    resourceId: created.drive.id,
    details: { orgVisibility: created.drive.orgVisibility },
  });
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
  | OrgLapsedRefusal
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
    // [D-OW-33] a lapsed org may only make a drive less open: the one guard, reading the lapse under the org's share lock.
    const lapsed = await checkOrgMayLoosen(tx, drive.orgId, !visibilityChangeOnlyRestricts(verdict.from, verdict.to));
    if (lapsed) return lapsed;
    if (!verdict.changed) {
      return { ok: true as const, changed: false, drive, from: verdict.from, to: verdict.to, publish: async () => {} };
    }
    const floor = await openFloorCheck(tx, { driveId, orgId: drive.orgId, visibilityAfter: verdict.to });
    if (floor) return floor;

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
  if (changed.changed && changed.drive.orgId !== null) {
    await recordOrgAuditEventAfterCommit({
      orgId: changed.drive.orgId,
      driveId,
      eventType: 'org.drive.visibility_changed',
      actorId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { from: changed.from, to: changed.to },
    });
  }
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
  if (changed.changed && changed.drive.orgId !== null) {
    await recordOrgAuditEventAfterCommit({
      orgId: changed.drive.orgId,
      driveId,
      eventType: 'org.drive.lead_changed',
      actorId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { fromUserId: changed.fromUserId, toUserId: changed.toUserId, reason: 'lead_changed' },
    });
  }
  return changed;
}
