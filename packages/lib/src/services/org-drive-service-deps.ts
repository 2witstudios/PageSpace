/**
 * Production wiring for the org-drive service (org-drive-service.ts): org roles through the one
 * org authorization function (ORG-5), membership rows through the materialization sync
 * (D-OW-6, D-OW-10), and the "who can create org drives" policy seam (POL-5).
 */

import { and, eq } from '@pagespace/db/operators';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { requireOrgRole } from '../organizations/authorize';
import { publishOrgMembershipSyncEvents, syncDriveOrgMembership } from './org-membership-sync';
import type { OrgDriveServiceDeps } from './org-drive-service';

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
    return () => publishOrgMembershipSyncEvents(result);
  },

  // TODO(lyt8275djmdcwlwm8wvk2xa5): read POL-5 through the org policy reader when Wave E lands.
  // Until then every org member may create org drives, which is DRV-3 without a policy.
  getOrgDriveCreationPolicy: async () => 'members',
};
