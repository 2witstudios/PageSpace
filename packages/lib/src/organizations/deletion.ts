/**
 * Org deletion (Spec ORG-6): every org drive, including ones already in trash, is
 * resolved before the org row goes, in ONE transaction, so nothing is orphaned and
 * drives.orgId (ON DELETE RESTRICT) never blocks the delete half-way.
 *
 * - A live drive needs an explicit choice: transfer to a named org member (orgId
 *   cleared, ownerId = that person) or trash.
 * - A trashed-by-choice drive, and every drive already in trash, becomes a trashed
 *   drive owned by the org Owner (orgId cleared, still in trash, restorable).
 * - The former lead of a drive that changes hands loses their OWNER row with it.
 * - Deleting the org is every member leaving it: what each minted on a drive they do
 *   not end up owning (explicit key scopes, OAuth grants, share links, agent
 *   memberships) is revoked with it, as leaveOrganization revokes a leaver's.
 * - Everyone whose access the delete ends is kicked from the drive's realtime rooms
 *   after commit: the former lead, every org-materialized member, every org Owner or
 *   Admin who reached it through their org role alone, and every member who reached an
 *   Open drive implicitly. The drive's new owner, and
 *   anyone still invited to it, never is.
 * - Nothing moves silently: a live drive without a choice refuses the whole delete,
 *   and the returned steps name every drive's destination for the confirmation and
 *   for the per-drive audit event the caller writes.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { kickForDriveMembershipRevocation } from '../permissions/revocation-kick';
import { loadAcceptedDriveMemberPairs } from '../permissions/org-drive-membership';
import { revokeOrgDriveGrantsForMembers } from './leave';
import { settleInBatches } from '../services/org-membership-sync-core';

export type DriveDeletionChoice =
  | { driveId: string; action: 'transfer'; toUserId: string }
  | { driveId: string; action: 'trash' };

export interface OrgDriveForDeletion {
  id: string;
  name: string;
  isTrashed: boolean;
}

export interface OrgDeletionStep {
  driveId: string;
  driveName: string;
  destination: 'transfer' | 'owner_trash';
  ownerId: string;
  trashed: boolean;
}

export type OrgDeletionRefusal =
  | 'not_owner'
  | 'missing_choice'
  | 'unknown_drive'
  | 'duplicate_choice'
  | 'drive_already_trashed'
  | 'transfer_target_not_member';

export type OrgDeletionPlan =
  | { ok: true; steps: OrgDeletionStep[] }
  | { ok: false; reason: OrgDeletionRefusal; driveIds: string[] };

export const planOrgDeletion = ({
  actorId,
  ownerId,
  memberIds,
  drives: orgDrives,
  choices,
}: {
  /** The caller, re-checked against the Owner read under the org row lock. */
  actorId: string;
  ownerId: string;
  memberIds: readonly string[];
  drives: readonly OrgDriveForDeletion[];
  choices: readonly DriveDeletionChoice[];
}): OrgDeletionPlan => {
  const byId = new Map(orgDrives.map((drive) => [drive.id, drive]));
  const refuse = (reason: OrgDeletionRefusal, driveIds: string[]): OrgDeletionPlan => ({ ok: false, reason, driveIds });
  if (actorId !== ownerId) return refuse('not_owner', []);

  const unknown = choices.filter((choice) => !byId.has(choice.driveId)).map((choice) => choice.driveId);
  if (unknown.length > 0) return refuse('unknown_drive', unknown);

  const seen = new Set<string>();
  const duplicates = choices.filter((choice) => (seen.has(choice.driveId) ? true : (seen.add(choice.driveId), false)));
  if (duplicates.length > 0) return refuse('duplicate_choice', [...new Set(duplicates.map((c) => c.driveId))]);

  const onTrashed = choices.filter((choice) => byId.get(choice.driveId)?.isTrashed).map((choice) => choice.driveId);
  if (onTrashed.length > 0) return refuse('drive_already_trashed', onTrashed);

  const members = new Set(memberIds);
  const badTargets = choices
    .filter((choice) => choice.action === 'transfer' && !members.has(choice.toUserId))
    .map((choice) => choice.driveId);
  if (badTargets.length > 0) return refuse('transfer_target_not_member', badTargets);

  const choiceFor = new Map(choices.map((choice) => [choice.driveId, choice]));
  const missing = orgDrives.filter((drive) => !drive.isTrashed && !choiceFor.has(drive.id)).map((drive) => drive.id);
  if (missing.length > 0) return refuse('missing_choice', missing);

  const steps = orgDrives.map((drive): OrgDeletionStep => {
    const choice = choiceFor.get(drive.id);
    if (choice?.action === 'transfer') {
      return { driveId: drive.id, driveName: drive.name, destination: 'transfer', ownerId: choice.toUserId, trashed: false };
    }
    return { driveId: drive.id, driveName: drive.name, destination: 'owner_trash', ownerId, trashed: true };
  });
  return { ok: true, steps };
};

export type DeleteOrganizationResult =
  | { ok: true; steps: OrgDeletionStep[] }
  | { ok: false; status: 404; reason: 'not_found' }
  | { ok: false; status: 403; reason: 'not_owner' }
  | { ok: false; status: 400; reason: Exclude<OrgDeletionRefusal, 'not_owner'>; driveIds: string[] };

export interface DeleteOrganizationDeps {
  /** Drops a revoked person's live realtime connection from a drive's rooms; runs only after commit. */
  kick: (target: { userId: string; driveId: string }) => Promise<void>;
}

const deleteOrganizationDeps: DeleteOrganizationDeps = {
  kick: ({ userId, driveId }) => kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }),
};

type RevokedRow = { userId: string; driveId: string };

const pairKey = (row: RevokedRow) => `${row.driveId}:${row.userId}`;


/** Kicks in flight at once; each enumerates pages and conversations, as the org-membership publisher bounds its events. */
const KICK_CONCURRENCY = 20;

export async function deleteOrganization(
  input: {
    actorId: string;
    orgId: string;
    choices: readonly DriveDeletionChoice[];
    now: Date;
  },
  deps: DeleteOrganizationDeps = deleteOrganizationDeps,
): Promise<DeleteOrganizationResult> {
  const toKick: RevokedRow[] = [];
  const result = await db.transaction(async (tx): Promise<DeleteOrganizationResult> => {
    const [org] = await tx
      .select({ ownerId: organizations.ownerId })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .for('update');
    if (!org) return { ok: false, status: 404, reason: 'not_found' } as const;

    const orgDrives = await tx
      .select({ id: drives.id, name: drives.name, isTrashed: drives.isTrashed, ownerId: drives.ownerId, orgVisibility: drives.orgVisibility })
      .from(drives)
      .where(eq(drives.orgId, input.orgId))
      .for('update');
    const members = await tx
      .select({ userId: orgMembers.userId, role: orgMembers.role })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, input.orgId));

    const plan = planOrgDeletion({
      actorId: input.actorId,
      ownerId: org.ownerId,
      memberIds: members.map((member) => member.userId),
      drives: orgDrives,
      choices: input.choices,
    });
    if (!plan.ok) {
      return plan.reason === 'not_owner'
        ? ({ ok: false, status: 403, reason: 'not_owner' } as const)
        : ({ ok: false, status: 400, reason: plan.reason, driveIds: plan.driveIds } as const);
    }

    for (const step of plan.steps) {
      const before = orgDrives.find((drive) => drive.id === step.driveId);
      const alreadyTrashed = before?.isTrashed === true;
      await tx
        .update(drives)
        .set({
          orgId: null,
          ownerId: step.ownerId,
          ...(step.trashed && !alreadyTrashed ? { isTrashed: true, trashedAt: input.now } : {}),
        })
        .where(eq(drives.id, step.driveId));
      // The former lead's OWNER row would keep them inside a drive that is no longer theirs, and
      // come back with it on restore; drop it as reassignLedOrgDrives does.
      if (before && before.ownerId !== step.ownerId) {
        toKick.push(...(await tx.delete(driveMembers).where(and(
          eq(driveMembers.driveId, step.driveId),
          eq(driveMembers.userId, before.ownerId),
          eq(driveMembers.role, 'OWNER'),
        )).returning({ userId: driveMembers.userId, driveId: driveMembers.driveId })));
      }
    }

    // An explicit key scope or OAuth drive grant is never re-checked against its holder, so
    // it would outlive the org power that let them mint it (revokeOrgDriveGrants).
    await revokeOrgDriveGrantsForMembers(tx, {
      userIds: members.map((member) => member.userId),
      driveIds: plan.steps.map((step) => step.driveId),
      keep: plan.steps.map((step) => ({ userId: step.ownerId, driveId: step.driveId })),
    });

    const driveIds = plan.steps.map((step) => step.driveId);
    if (driveIds.length > 0) {
      // Org-materialized access means nothing once the drive has left the org;
      // leaving those rows would keep former org members inside a personal drive.
      const orgRows = await tx
        .delete(driveMembers)
        .where(and(inArray(driveMembers.driveId, driveIds), eq(driveMembers.source, 'org')))
        .returning({ userId: driveMembers.userId, driveId: driveMembers.driveId });
      // A drive's new owner keeps it through drives.ownerId, so their live connection stays.
      const newOwner = new Map(plan.steps.map((step) => [step.driveId, step.ownerId]));
      toKick.push(...orgRows.filter((row) => newOwner.get(row.driveId) !== row.userId));

      // Org access needs no row: an org Owner or Admin reaches every org drive, and every member
      // reaches an Open one (a member whose direct invite is still pending has no org row there).
      // All of it ends with the org.
      const openDrives = new Set(orgDrives.filter((drive) => drive.orgVisibility === 'OPEN').map((drive) => drive.id));
      const candidates = new Map<string, RevokedRow>();
      for (const row of toKick) candidates.set(pairKey(row), row);
      for (const step of plan.steps) {
        for (const { userId, role } of members) {
          const reached = role !== 'MEMBER' || openDrives.has(step.driveId);
          if (reached && userId !== step.ownerId) candidates.set(pairKey({ userId, driveId: step.driveId }), { userId, driveId: step.driveId });
        }
      }
      // Someone still invited to the drive keeps it, and their connection with it.
      const candidateUsers = [...new Set([...candidates.values()].map((row) => row.userId))];
      for (const row of await loadAcceptedDriveMemberPairs(tx, candidateUsers, driveIds)) candidates.delete(pairKey(row));
      toKick.splice(0, toKick.length, ...candidates.values());
    }

    await tx.delete(organizations).where(eq(organizations.id, input.orgId));
    return { ok: true, steps: plan.steps };
  });
  // Best effort once committed: a failed kick must not report a completed delete as failed.
  if (result.ok) await settleInBatches(toKick.map((row) => () => deps.kick(row)), KICK_CONCURRENCY);
  return result;
}
