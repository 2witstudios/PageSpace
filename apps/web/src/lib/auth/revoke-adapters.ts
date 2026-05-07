/**
 * Concrete IO implementation of RevokePorts for the
 * `revokePendingInvite` pipe (DELETE /api/drives/[driveId]/pending-invites/[inviteId]).
 *
 * Per the port contract in `@pagespace/lib/services/invites/ports.ts`:
 * - `loadPendingInviteForDrive` and `findActorMembership` are pre-commit ports
 *   and MAY throw — the route catches and surfaces a 5xx so the user can retry.
 * - `deletePendingInviteForDrive` is the commit and MAY throw.
 * - `auditPermissionRevoked` is a post-commit side-effect port and MUST NOT
 *   throw — wraps its own try/catch + log so a flaky audit pipeline cannot
 *   reverse the delete.
 *
 * `findActorMembership` deliberately reads `driveMembers` WITHOUT
 * `isNotNull(acceptedAt)` and returns the raw `acceptedAt` so the strict
 * "accepted OWNER/ADMIN" gate lives in `validateRevokeRequest` (one source of
 * truth, easier to audit). The drive-member-gate-coverage test exempts this
 * file with that rationale.
 */

import { eq, and } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { driveMembers } from '@pagespace/db/schema/members';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { RevokePorts } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

export const buildRevokePorts = (request: Request): RevokePorts => ({
  loadPendingInviteForDrive: async ({ inviteId, driveId }) =>
    driveInviteRepository.findUnconsumedInviteForDrive({ inviteId, driveId }),

  findActorMembership: async ({ driveId, actorId }) => {
    const rows = await db
      .select({ role: driveMembers.role, acceptedAt: driveMembers.acceptedAt })
      .from(driveMembers)
      .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, actorId)))
      .limit(1);
    return rows.at(0) ?? null;
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
