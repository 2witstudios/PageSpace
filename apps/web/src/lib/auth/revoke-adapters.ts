import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { driveMembers } from '@pagespace/db/schema/members';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { RevokePorts } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

export const buildRevokePorts = (request: Request): RevokePorts => ({
  loadPendingInviteForDrive: ({ inviteId, driveId }) =>
    driveInviteRepository.findActivePendingInviteForDrive({ inviteId, driveId }),

  findActorMembership: async ({ driveId, actorId }) => {
    const rows = await db
      .select({ role: driveMembers.role, acceptedAt: driveMembers.acceptedAt })
      .from(driveMembers)
      .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, actorId)))
      .limit(1);
    return rows.at(0) ?? null;
  },

  deletePendingInviteForDrive: ({ inviteId, driveId }) =>
    driveInviteRepository.deletePendingInviteForDrive({ inviteId, driveId }),

  auditPermissionRevoked: ({ inviteId, driveId, actorId, targetEmail, role }) => {
    try {
      auditRequest(request, {
        eventType: 'authz.permission.revoked',
        userId: actorId,
        resourceType: 'drive',
        resourceId: driveId,
        details: {
          operation: 'revoke_pending_invite',
          inviteId,
          targetEmail,
          role,
        },
      });
    } catch (error) {
      loggers.api.warn('Failed to audit authz.permission.revoked', {
        driveId,
        inviteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
