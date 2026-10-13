/**
 * drive-transition-invalidation — ARCH-2: the access delta of ONE drive transition
 * (move in, move out, visibility, lead change, trash), published after the transition
 * commits.
 *
 * A drive transition can end access WITHOUT deleting any row — org Owner/Admin power over a
 * moved-out Private drive is rowless, an OPEN drive's implicit membership has no row either —
 * and it can change WHICH org's sign-in policy governs every held room of the drive. Both
 * stale-live paths are closed here, on top of the row sync's own events:
 *
 *   1. Per person in the union of the BEFORE and AFTER audiences, the effective membership is
 *      re-resolved against the COMMITTED state. Null → a realtime room kick (revocation-kick:
 *      drive rooms, pages, conversations, sessions). Otherwise a drive-list event so their
 *      views refetch. The drive's owner is never revoked: ownership opens a personal drive
 *      with no row at all.
 *   2. When the governing org changed (a move), `org:changed {change: 'policy'}` is announced
 *      to the transition's audience — the realtime policy fanout re-decides EVERY watch, and
 *      a room whose credential fails the drive's NEW governing sign-in policy is left at once.
 *      This is what evicts a kept-row holder whose credential the stronger policy now refuses
 *      (the row sync alone cannot: nothing about their row changed).
 *
 * Best-effort, like every publish: the transition has committed; failures are logged.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { listDriveAudience } from '../permissions/drive-audience';
import { loadEffectiveDriveMembership } from '../permissions/org-drive-membership';
import { publishDriveAccessEvents, type OrgMembershipSyncPorts } from './org-membership-sync';
import { announceOrgChangeTo } from '../organizations/org-change-events';
import { loggers } from '../logging/logger-config';

export interface DriveTransitionInvalidationInput {
  driveId: string;
  /** The org whose sign-in policy governed the drive BEFORE the transition (null = personal). */
  orgIdBefore: string | null;
  /** The org whose sign-in policy governs the drive AFTER the transition (null = personal). */
  orgIdAfter: string | null;
  /** Everyone with effective access to the drive BEFORE the transition committed. */
  audienceBefore: readonly string[];
  ports?: OrgMembershipSyncPorts;
}

export async function publishDriveTransitionInvalidation(input: DriveTransitionInvalidationInput): Promise<void> {
  try {
    const [drive] = await db
      .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility, isTrashed: drives.isTrashed })
      .from(drives)
      .where(eq(drives.id, input.driveId));
    const audience = [...new Set([...input.audienceBefore, ...(drive ? await listDriveAudience(input.driveId) : []).map((m) => m.userId)])];

    const affected: Array<{ userId: string; operation: 'member_role_changed'; driveIds: string[] }> = [];
    const revoked: Array<{ userId: string; driveId: string }> = [];
    for (const userId of audience) {
      const stillAccesses = drive !== undefined && drive.ownerId === userId
        ? true
        : Boolean(drive && !drive.isTrashed && await loadEffectiveDriveMembership(userId, drive, { audit: false }));
      if (stillAccesses) affected.push({ userId, operation: 'member_role_changed', driveIds: [input.driveId] });
      else revoked.push({ userId, driveId: input.driveId });
    }
    await publishDriveAccessEvents({ affectedUsers: affected, revoked }, input.ports);

    if (input.orgIdBefore !== input.orgIdAfter) {
      const triggerOrg = input.orgIdAfter ?? input.orgIdBefore;
      if (triggerOrg) await announceOrgChangeTo(triggerOrg, 'policy', audience);
    }
  } catch (error) {
    loggers.realtime.warn('drive transition invalidation failed', {
      error: error instanceof Error ? error.message : String(error),
      driveId: input.driveId,
      orgIdBefore: input.orgIdBefore,
      orgIdAfter: input.orgIdAfter,
    });
  }
}
