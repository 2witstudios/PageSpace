/**
 * Concrete IO implementation of RevokePorts for the
 * `revokePendingInvite` pipe (DELETE /api/drives/[driveId]/pending-invites/[inviteId]).
 *
 * Per the port contract in `@pagespace/lib/services/invites/ports.ts`:
 * - `loadPendingInviteForDrive` and `findActorDriveRole` are pre-commit ports
 *   and MAY throw — the route catches and surfaces a 5xx so the user can retry.
 * - `deletePendingInviteForDrive` is the commit and MAY throw.
 * - `auditPermissionRevoked` is a post-commit side-effect port and MUST NOT
 *   throw — wraps its own try/catch + log so a flaky audit pipeline cannot
 *   reverse the delete.
 *
 * `findActorDriveRole` answers with the actor's effective drive role from the
 * permissions layer (the lead, else the org-aware membership, which reads
 * ACCEPTED rows only), and `validateRevokeRequest` keeps the "OWNER/ADMIN"
 * decision. This file reads no drive_members row of its own.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import { driveRoleOf } from '@pagespace/lib/permissions/drive-relationship';
import { loadDriveRelationship } from '@pagespace/lib/permissions/drive-relationship-loader';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { RevokePorts } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

export const buildRevokePorts = (request: Request): RevokePorts => ({
  loadPendingInviteForDrive: async ({ inviteId, driveId }) =>
    driveInviteRepository.findUnconsumedInviteForDrive({ inviteId, driveId }),

  findActorDriveRole: async ({ driveId, actorId }) => {
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
      columns: { id: true, ownerId: true, orgId: true, orgVisibility: true },
    });
    if (!drive) return null;
    return driveRoleOf(await loadDriveRelationship(actorId, drive));
  },

  deletePendingInviteForDrive: async ({ inviteId, driveId }) =>
    driveInviteRepository.deletePendingInviteForDrive({ inviteId, driveId }),

  auditPermissionRevoked: ({ inviteId, driveId, actorId, targetEmail, role }) => {
    try {
      auditRequest(request, {
        eventType: 'authz.permission.revoked',
        userId: actorId,
        resourceType: 'drive',
        resourceId: driveId,
        details: {
          inviteId,
          targetEmail,
          role,
          operation: 'revoke_invite',
        },
      });
    } catch (error) {
      loggers.api.warn('Failed to audit authz.permission.revoked on revoke', {
        driveId,
        inviteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
