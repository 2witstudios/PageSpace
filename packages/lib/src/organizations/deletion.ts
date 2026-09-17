/**
 * Org deletion (Spec ORG-6): every org drive, including ones already in trash, is
 * resolved before the org row goes, in ONE transaction, so nothing is orphaned and
 * drives.orgId (ON DELETE RESTRICT) never blocks the delete half-way.
 *
 * - A live drive needs an explicit choice: transfer to a named org member (orgId
 *   cleared, ownerId = that person) or trash.
 * - A trashed-by-choice drive, and every drive already in trash, becomes a trashed
 *   drive owned by the org Owner (orgId cleared, still in trash, restorable).
 * - Nothing moves silently: a live drive without a choice refuses the whole delete,
 *   and the returned steps name every drive's destination for the confirmation and
 *   for the per-drive audit event the caller writes.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';

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
  | 'missing_choice'
  | 'unknown_drive'
  | 'duplicate_choice'
  | 'drive_already_trashed'
  | 'transfer_target_not_member';

export type OrgDeletionPlan =
  | { ok: true; steps: OrgDeletionStep[] }
  | { ok: false; reason: OrgDeletionRefusal; driveIds: string[] };

export const planOrgDeletion = ({
  ownerId,
  memberIds,
  drives: orgDrives,
  choices,
}: {
  ownerId: string;
  memberIds: readonly string[];
  drives: readonly OrgDriveForDeletion[];
  choices: readonly DriveDeletionChoice[];
}): OrgDeletionPlan => {
  const byId = new Map(orgDrives.map((drive) => [drive.id, drive]));
  const refuse = (reason: OrgDeletionRefusal, driveIds: string[]): OrgDeletionPlan => ({ ok: false, reason, driveIds });

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
  | { ok: false; status: 400; reason: OrgDeletionRefusal; driveIds: string[] };

export async function deleteOrganization(input: {
  orgId: string;
  choices: readonly DriveDeletionChoice[];
  now: Date;
}): Promise<DeleteOrganizationResult> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ ownerId: organizations.ownerId })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .for('update');
    if (!org) return { ok: false, status: 404, reason: 'not_found' } as const;

    const orgDrives = await tx
      .select({ id: drives.id, name: drives.name, isTrashed: drives.isTrashed })
      .from(drives)
      .where(eq(drives.orgId, input.orgId))
      .for('update');
    const members = await tx
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, input.orgId));

    const plan = planOrgDeletion({
      ownerId: org.ownerId,
      memberIds: members.map((member) => member.userId),
      drives: orgDrives,
      choices: input.choices,
    });
    if (!plan.ok) return { ok: false, status: 400, reason: plan.reason, driveIds: plan.driveIds } as const;

    for (const step of plan.steps) {
      const alreadyTrashed = orgDrives.find((drive) => drive.id === step.driveId)?.isTrashed === true;
      await tx
        .update(drives)
        .set({
          orgId: null,
          ownerId: step.ownerId,
          ...(step.trashed && !alreadyTrashed ? { isTrashed: true, trashedAt: input.now } : {}),
        })
        .where(eq(drives.id, step.driveId));
    }

    const driveIds = plan.steps.map((step) => step.driveId);
    if (driveIds.length > 0) {
      // Org-materialized access means nothing once the drive has left the org;
      // leaving those rows would keep former org members inside a personal drive.
      await tx
        .delete(driveMembers)
        .where(and(inArray(driveMembers.driveId, driveIds), eq(driveMembers.source, 'org')));
    }

    await tx.delete(organizations).where(eq(organizations.id, input.orgId));
    return { ok: true, steps: plan.steps };
  });
}
