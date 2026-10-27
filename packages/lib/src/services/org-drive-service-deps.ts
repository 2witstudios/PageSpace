/**
 * Production wiring for the org-drive service (org-drive-service.ts): org roles through the one
 * org authorization function (ORG-5), membership rows through the materialization sync
 * (D-OW-6, D-OW-10), and the "who can create org drives" policy seam (POL-5).
 */

import { and, eq } from '@pagespace/db/operators';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { requireOrgRole } from '../organizations/authorize';
import { drives } from '@pagespace/db/schema/core';
import { db } from '@pagespace/db/db';
import { loadEffectiveDriveMembership } from '../permissions/org-drive-membership';
import { closeStaleDriveJoinRequests } from '../permissions/drive-join-request-closure';
import { publishDriveAccessEvents, publishOrgMembershipSyncEvents, syncDriveOrgMembership, type OrgMembershipSyncPorts } from './org-membership-sync';
import { publishDriveTransitionInvalidation } from './drive-transition-invalidation';
import type { OrgDriveServiceDeps, OrgMembershipSyncCall } from './org-drive-service';
import { getOrgPolicies } from '../organizations/policy-reader';

/**
 * The ARCH-2 post-commit invalidation for one transition call, or null when the call cannot
 * change access (a create: a new drive holds no rooms). The governing org before and after
 * decides whether the realtime policy fanout must re-decide held rooms.
 */
function transitionInvalidationFor(call: OrgMembershipSyncCall): (() => Promise<void>) | null {
  switch (call.kind) {
    case 'move-in':
      if (!call.audienceBefore) return null;
      return () => publishDriveTransitionInvalidation({ driveId: call.driveId, orgIdBefore: null, orgIdAfter: call.orgId, audienceBefore: call.audienceBefore ?? [] });
    case 'move-out':
      if (!call.audienceBefore) return null;
      return () => publishDriveTransitionInvalidation({ driveId: call.driveId, orgIdBefore: call.orgId, orgIdAfter: null, audienceBefore: call.audienceBefore ?? [] });
    case 'visibility':
      if (!call.audienceBefore) return null;
      return () => publishDriveTransitionInvalidation({ driveId: call.driveId, orgIdBefore: call.orgId, orgIdAfter: call.orgId, audienceBefore: call.audienceBefore ?? [] });
    case 'lead-change':
      if (!call.audienceBefore) return null;
      return () => publishDriveTransitionInvalidation({ driveId: call.driveId, orgIdBefore: call.orgId, orgIdAfter: call.orgId, audienceBefore: call.audienceBefore ?? [] });
    case 'create':
      return null;
  }
}

export const orgDriveServiceDeps: OrgDriveServiceDeps = {
  // The decision stays requireOrgRole's (ORG-5); only the membership read is bound to the move's
  // transaction. FOR SHARE on the org_members row makes a concurrent leave or account deletion
  // (which deletes that row) wait for the move, or the move wait for it, so the service never
  // commits an org drive whose lead has already left (D-OW-7). Read outside the transaction, an
  // uncommitted deletion is invisible and its users cascade later deletes the new org drive.
  getOrgRole: async (tx, orgId, userId) => {
    const authorization = await requireOrgRole(userId, orgId, 'MEMBER', {
      findMembershipRole: async (memberOrgId, memberUserId) => {
        const [row] = await tx
          .select({ role: orgMembers.role })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, memberOrgId), eq(orgMembers.userId, memberUserId)))
          .for('share');
        return row?.role ?? null;
      },
    });
    return authorization.ok ? authorization.role : null;
  },

  syncOrgMembership: async (tx, call) => {
    const result = await syncDriveOrgMembership(call.driveId, {
      tx,
      // D-OW-10: on move-out, "keep" leaves org members on the drive as invited members.
      removedOrgRows: call.kind === 'move-out' && call.implicitMembers === 'keep' ? 'keepAsInvite' : 'delete',
    });
    // DRV-6: a visibility change off Restricted, a move out, or a requester made lead leaves their
    // pending request asking for nothing; it closes in the same transaction.
    await closeStaleDriveJoinRequests(tx, [call.driveId]);
    // ARCH-2: the transition's full access delta, on top of the row sync's events — a move,
    // visibility change or lead change can end rowless access and change the drive's governing
    // sign-in policy, and neither is visible in the deleted rows the sync alone publishes.
    const invalidation = transitionInvalidationFor(call);
    const rowEvents = () => publishOrgMembershipSyncEvents(result);
    if (!invalidation) return rowEvents;
    if (call.kind !== 'lead-change') {
      return async () => { await rowEvents(); await invalidation(); };
    }
    return async () => {
      await rowEvents();
      await publishLeadChangeEvents(call.driveId, call.fromUserId, call.toUserId);
      await invalidation();
    };
  },

  // POL-5: who may create org drives is the org's policy, read now inside the creating transaction.
  getOrgDriveCreationPolicy: async (tx, orgId) => (await getOrgPolicies(orgId, tx)).whoCanCreateDrives,
};

/**
 * After a lead change commits (X-4): both people's drive lists refetch, and the former lead, if
 * their own membership no longer opens the drive, is kicked from its realtime rooms. Their access
 * ended with no row deleted (the lead holds none), so the sync alone would never kick them.
 */
export async function publishLeadChangeEvents(
  driveId: string,
  fromUserId: string,
  toUserId: string,
  ports?: OrgMembershipSyncPorts,
): Promise<void> {
  const [drive] = await db
    .select({ id: drives.id, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive) return;
  // audit: false — this asks what the former lead can reach now; nobody accessed anything.
  const formerStillMember = (await loadEffectiveDriveMembership(fromUserId, drive, { audit: false })) !== null;
  await publishDriveAccessEvents({
    affectedUsers: [
      { userId: toUserId, operation: 'member_role_changed', driveIds: [driveId] },
      { userId: fromUserId, operation: formerStillMember ? 'member_role_changed' : 'member_removed', driveIds: [driveId] },
    ],
    revoked: formerStillMember ? [] : [{ userId: fromUserId, driveId }],
  }, ports);
}
