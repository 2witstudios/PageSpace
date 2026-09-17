/**
 * Org-owned drives: move a drive into an org, move it out, create one in an org
 * (Spec DRV-1..DRV-4, O-7, O-9, O-10).
 *
 * The decisions are pure (organizations/org-drive-ownership.ts); this module is the IO edge.
 * Each operation runs in one transaction: lock the drive, lock the org, read the actor's org
 * role, decide, write drives.orgId, and run the org-membership sync, so a refused or failed
 * sync leaves the drive exactly as it was.
 *
 * A move rewrites drives.orgId (and, on move-in, the slug when it collides inside the org and
 * the visibility). Members, custom roles, pages, envs, and publishSubdomain are keyed by
 * driveId and are not touched (DRV-2).
 */

import { db } from '@pagespace/db/db';
import { and, eq, like, sql } from '@pagespace/db/operators';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { organizations, type OrgRole } from '@pagespace/db/schema/organizations';
import { loggers } from '../logging/logger-config';
import { slugify } from '../utils/utils';
import { resolveUniqueSlug } from './drive-guards';
import { allocatePublishSubdomain } from './drive-service';
import {
  decideCreateDriveInOrg,
  decideMoveDriveIntoOrg,
  decideMoveDriveOutOfOrg,
  orgDriveVisibilityForInsert,
  STORAGE_REATTRIBUTION_LEAF_ID,
  type ImplicitMembersChoice,
  type OrgDriveCreationPolicy,
  type OrgDriveRefusal,
} from '../organizations/org-drive-ownership';

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

/**
 * Storage re-attribution on move (O-9) is owned by the storage-attribution leaf. Until it
 * lands, a move reports the work as deferred, loudly, instead of silently skipping it.
 */
export interface StorageReattribution {
  status: 'deferred';
  leafId: typeof STORAGE_REATTRIBUTION_LEAF_ID;
}

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

// TODO(t1759m6mfxrj5hyaleu1mdqs): re-attribute the drive's stored bytes between the lead's
// personal quota and the org (O-9, D-OW-9) when the storage-attribution leaf lands.
function deferStorageReattribution(driveId: string, direction: 'into-org' | 'out-of-org', orgId: string): StorageReattribution {
  loggers.api.warn('Org drive move: storage re-attribution deferred', {
    driveId,
    orgId,
    direction,
    leafId: STORAGE_REATTRIBUTION_LEAF_ID,
  });
  return { status: 'deferred', leafId: STORAGE_REATTRIBUTION_LEAF_ID };
}

async function lockDrive(tx: OrgDriveTx, driveId: string): Promise<DriveRow | null> {
  const [row] = await tx.select().from(drives).where(eq(drives.id, driveId)).for('update');
  return row ?? null;
}

/**
 * Share-lock the org row so the actor's membership and the org's ownership cannot change
 * under the decision (leaving an org and transferring ownership lock it FOR UPDATE).
 * Returns false when the org does not exist.
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
  const outcome = await db.transaction(async (tx) => {
    const drive = await lockDrive(tx, driveId);
    if (!drive) return driveNotFound();

    const orgExists = await lockOrg(tx, input.orgId);
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

    const publish = await deps.syncOrgMembership(tx, { kind: 'move-in', driveId, orgId: input.orgId });
    return { ok: true as const, drive: moved, publish };
  });

  if (!outcome.ok) return outcome;
  const { publish, ...moved } = outcome;
  await publish();
  return { ...moved, orgId: input.orgId, storageReattribution: deferStorageReattribution(driveId, 'into-org', input.orgId) };
}

export async function moveDriveOutOfOrg(
  actorId: string,
  driveId: string,
  input: { implicitMembers: ImplicitMembersChoice | null },
  deps: OrgDriveServiceDeps
): Promise<MoveDriveResult> {
  const outcome = await db.transaction(async (tx) => {
    const drive = await lockDrive(tx, driveId);
    if (!drive) return driveNotFound();

    const { orgId } = drive;
    const actorOrgRole =
      orgId !== null && (await lockOrg(tx, orgId)) ? await deps.getOrgRole(tx, orgId, actorId) : null;
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

    const publish = await deps.syncOrgMembership(tx, {
      kind: 'move-out',
      driveId,
      orgId,
      implicitMembers: verdict.implicitMembers,
    });
    return { ok: true as const, drive: moved, orgId, publish };
  });

  if (!outcome.ok) return outcome;
  const { orgId, publish, ...rest } = outcome;
  await publish();
  return { ...rest, storageReattribution: deferStorageReattribution(driveId, 'out-of-org', orgId) };
}

export async function createOrgDrive(
  actorId: string,
  input: { name: string; orgId: string; orgVisibility?: OrgDriveVisibility },
  deps: OrgDriveServiceDeps
): Promise<CreateOrgDriveResult> {
  const outcome = await db.transaction(async (tx) => {
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
  });

  if (!outcome.ok) return outcome;
  const { publish, ...created } = outcome;
  await publish();
  return created;
}
