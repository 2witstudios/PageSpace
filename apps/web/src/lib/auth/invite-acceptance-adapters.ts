import { hashToken } from '@pagespace/lib/auth/token-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { createDriveNotification } from '@pagespace/lib/notifications/notifications';
import type { AcceptancePorts } from '@pagespace/lib/services/invites';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import {
  broadcastDriveMemberEvent,
  broadcastDriveMemberEventToRecipients,
  createDriveMemberEventPayload,
} from '@/lib/websocket';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

/**
 * Concrete IO implementation of AcceptancePorts. Per the port contract in
 * `@pagespace/lib/services/invites/ports.ts`, every side-effect adapter
 * swallows + logs its own errors so a flaky websocket fan-out, audit-DB
 * blip, or activity-log failure cannot reverse a successful membership
 * write.
 */
export const buildAcceptancePorts = (request: Request): AcceptancePorts => ({
  loadInvite: async ({ token }) => {
    const tokenHash = hashToken(token);
    const row = await driveInviteRepository.findPendingInviteByTokenHash(tokenHash);
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      driveId: row.driveId,
      driveName: row.driveName,
      role: row.role,
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    };
  },

  findExistingMembership: async ({ driveId, userId }) =>
    driveInviteRepository.findExistingMember(driveId, userId),

  consumeInviteAndCreateMember: async ({ invite, userId, now }) => {
    const result = await driveInviteRepository.consumeInviteAndCreateMembership({
      inviteId: invite.id,
      driveId: invite.driveId,
      userId,
      role: invite.role,
      invitedBy: invite.invitedBy,
      acceptedAt: now,
    });
    if (result.ok) return { ok: true, memberId: result.memberId };
    return { ok: false, reason: result.reason };
  },

  broadcastMemberAdded: async (data) => {
    try {
      const payload = createDriveMemberEventPayload(
        data.driveId,
        data.invitedUserId,
        'member_added',
        { role: data.role, driveName: data.driveName },
      );
      await broadcastDriveMemberEvent(payload);
      try {
        const recipients = await getDriveRecipientUserIds(data.driveId);
        const others = recipients.filter((id) => id !== data.invitedUserId);
        if (others.length > 0) {
          await broadcastDriveMemberEventToRecipients(payload, others);
        }
      } catch (error) {
        loggers.api.warn('Failed to fan-out member_added to drive recipients', {
          driveId: data.driveId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      loggers.api.warn('Failed to broadcast member_added', {
        driveId: data.driveId,
        invitedUserId: data.invitedUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  notifyMemberAdded: async (data) => {
    try {
      await createDriveNotification(
        data.invitedUserId,
        data.driveId,
        'invited',
        data.role,
        data.inviterUserId,
      );
    } catch (error) {
      loggers.api.warn('Failed to create drive notification on member_added', {
        driveId: data.driveId,
        invitedUserId: data.invitedUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  trackInviteMember: async (data) => {
    try {
      trackDriveOperation(data.inviterUserId, 'invite_member', data.driveId, {
        invitedUserId: data.invitedUserId,
        role: data.role,
        permissionsGranted: data.permissionsGranted,
      });
    } catch (error) {
      loggers.api.warn('Failed to track invite_member operation', {
        driveId: data.driveId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const actorInfo = await getActorInfo(data.inviterUserId);
      logMemberActivity(
        data.inviterUserId,
        'member_add',
        {
          driveId: data.driveId,
          driveName: data.driveName,
          targetUserId: data.invitedUserId,
          targetUserEmail: data.inviteEmail,
          role: data.role,
        },
        actorInfo,
      );
    } catch (error) {
      loggers.api.warn('Failed to write member_add activity log', {
        driveId: data.driveId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  auditPermissionGranted: (data) => {
    try {
      auditRequest(request, {
        eventType: 'authz.permission.granted',
        userId: data.inviterUserId,
        resourceType: 'drive',
        resourceId: data.driveId,
        details: {
          targetUserId: data.invitedUserId,
          targetEmail: data.inviteEmail,
          role: data.role,
          operation: 'invite',
        },
      });
    } catch (error) {
      loggers.api.warn('Failed to audit authz.permission.granted on member_added', {
        driveId: data.driveId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
