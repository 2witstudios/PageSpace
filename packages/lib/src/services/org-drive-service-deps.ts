/**
 * Production wiring for the org-drive service (org-drive-service.ts): org roles through the one
 * org authorization function (ORG-5), membership rows through the materialization sync
 * (D-OW-6, D-OW-10), and the "who can create org drives" policy seam (POL-5).
 */

import { requireOrgRole } from '../organizations/authorize';
import { publishOrgMembershipSyncEvents, syncDriveOrgMembership } from './org-membership-sync';
import type { OrgDriveServiceDeps } from './org-drive-service';

export const orgDriveServiceDeps: OrgDriveServiceDeps = {
  getOrgRole: async (_tx, orgId, userId) => {
    const authorization = await requireOrgRole(userId, orgId, 'MEMBER');
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
