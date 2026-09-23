/**
 * Org-owned drives: move a drive into an org, move it out, create one in an org
 * (Spec DRV-1..DRV-4, O-7, O-9, O-10).
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
import { reattributeDriveStorageInTx, type StorageReattributionResult } from './storage-limits';

export type OrgDriveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What the org-membership sync is asked to do for one drive (D-OW-6, D-OW-10). */
export type OrgMembershipSyncCall =
  | { kind: 'move-in'; driveId: string; orgId: string }
  | { kind: 'create'; driveId: string; orgId: string }
  | { kind: 'move-out'; driveId: string; orgId: string; implicitMembers: ImplicitMembersChoice };

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
