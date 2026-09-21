import type { db } from '@pagespace/db/db';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { loadAcceptedDriveMemberPairs } from './org-drive-membership';

/** A person who no longer reaches a drive. */
interface DriveAccessLoss {
  userId: string;
  driveId: string;
}

/** Where one org drive ends up when its org is deleted (Spec ORG-6). */
interface OrgDeletionDriveOutcome {
  driveId: string;
  /** Who owns the drive once it has left the org. */
  newOwnerId: string;
  /** Whether every org member reached it implicitly (orgVisibility OPEN). */
  open: boolean;
}

const pairKey = (pair: DriveAccessLoss) => `${pair.driveId}:${pair.userId}`;

/**
 * Who may lose each drive when its org is deleted, before anyone still invited is taken out:
 * everyone whose row on it the deletion removed, every org Owner or Admin (their org role reached
 * every org drive), and every member of an Open drive (reached implicitly, with no row). The drive's
 * new owner keeps it through drives.ownerId and is never among them. One entry per (person, drive).
 */
function orgDeletionAccessLossCandidates(input: {
  outcomes: readonly OrgDeletionDriveOutcome[];
  members: ReadonlyArray<{ userId: string; role: OrgRole }>;
  removedRows: readonly DriveAccessLoss[];
}): DriveAccessLoss[] {
  const newOwner = new Map(input.outcomes.map((outcome) => [outcome.driveId, outcome.newOwnerId]));
  const candidates = new Map<string, DriveAccessLoss>();
  const add = (pair: DriveAccessLoss) => {
    if (newOwner.get(pair.driveId) !== pair.userId) candidates.set(pairKey(pair), pair);
  };
  for (const row of input.removedRows) add({ userId: row.userId, driveId: row.driveId });
  for (const outcome of input.outcomes) {
    for (const { userId, role } of input.members) {
      if (role !== 'MEMBER' || outcome.open) add({ userId, driveId: outcome.driveId });
    }
  }
  return [...candidates.values()];
}

/**
 * Who loses each drive when its org is deleted (Spec ORG-6): orgDeletionAccessLossCandidates, minus
 * anyone who still holds an ACCEPTED drive_members row on it (a direct invite outlives the org).
 * Reads through `executor` after the deletion's own row deletes, inside its transaction.
 */
export async function resolveOrgDeletionAccessLoss(
  executor: Pick<typeof db, 'select'>,
  input: Parameters<typeof orgDeletionAccessLossCandidates>[0],
): Promise<DriveAccessLoss[]> {
  const candidates = orgDeletionAccessLossCandidates(input);
  if (candidates.length === 0) return [];
  const userIds = [...new Set(candidates.map((pair) => pair.userId))];
  const driveIds = input.outcomes.map((outcome) => outcome.driveId);
  const stillInvited = new Set((await loadAcceptedDriveMemberPairs(executor, userIds, driveIds)).map(pairKey));
  return candidates.filter((pair) => !stillInvited.has(pairKey(pair)));
}
