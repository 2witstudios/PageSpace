import { db } from '@pagespace/db/db';
import { and, eq, isNull } from '@pagespace/db/operators';
import { driveMembers } from '@pagespace/db/schema/members';
import { pendingInvites } from '@pagespace/db/schema/pending-invites';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { RevokePorts } from '@pagespace/lib/services/invites';

export const buildRevokePorts = (request: Request): RevokePorts => ({
  loadPendingInviteForDrive: async ({ inviteId, driveId }) => {
    const rows = await db
      .select({
        id: pendingInvites.id,
        email: pendingInvites.email,
        role: pendingInvites.role,
        driveId: pendingInvites.driveId,
      })
      .from(pendingInvites)
      .where(
        and(
          eq(pendingInvites.id, inviteId),
          eq(pendingInvites.driveId, driveId),
          isNull(pendingInvites.consumedAt),
        ),
      )
      .limit(1);
    return rows.at(0) ?? null;
  },

  findActorMembership: async ({ driveId, actorId }) => {
    const rows = await db
      .select({ role: driveMembers.role, acceptedAt: driveMembers.acceptedAt })
      .from(driveMembers)
      .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, actorId)))
      .limit(1);
    return rows.at(0) ?? null;
  },

  deletePendingInviteForDrive: async ({ inviteId, driveId }) => {
    const deleted = await db
      .delete(pendingInvites)
      .where(and(eq(pendingInvites.id, inviteId), eq(pendingInvites.driveId, driveId)))
      .returning({ id: pendingInvites.id });
    return { rowsDeleted: deleted.length };
  },

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
