import { hashToken } from '@pagespace/lib/auth/token-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createNotification } from '@pagespace/lib/notifications/notifications';
import type { ConnectionAcceptancePorts } from '@pagespace/lib/services/invites';
import { connectionInviteRepository } from '@/lib/repositories/connection-invite-repository';

/**
 * Concrete IO implementation of ConnectionAcceptancePorts. Connection
 * acceptance creates the row in PENDING state — the invited user still has
 * to confirm from the connections UI. The notification fired here mirrors
 * the existing in-platform "user-A asked user-B to connect" path.
 */
export const buildConnectionAcceptancePorts = (request: Request): ConnectionAcceptancePorts => ({
  loadInvite: async ({ token }) => {
    const tokenHash = hashToken(token);
    const row = await connectionInviteRepository.findPendingInviteByTokenHash(tokenHash);
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      invitedBy: row.invitedBy,
      inviterName: row.inviterName,
      requestMessage: row.requestMessage,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    };
  },

  findExistingConnection: async ({ userId, inviterId }) =>
    connectionInviteRepository.findExistingConnection(userId, inviterId),

  consumeInviteAndCreateConnection: async ({ invite, userId, now }) =>
    connectionInviteRepository.consumeInviteAndCreateConnection({
      inviteId: invite.id,
      invitedBy: invite.invitedBy,
      userId,
      requestMessage: invite.requestMessage,
      now,
    }),

  broadcastConnectionRequested: async (_data) => {
    // Connection requests fan out via the notifications channel; no
    // dedicated socket event today. Kept as a port so a future
    // connection_state_changed broadcast can land here.
  },

  notifyConnectionRequested: async (data) => {
    try {
      const inviter = await connectionInviteRepository.findInviterDisplay(data.inviterUserId);
      const senderName = inviter?.name || 'Someone';
      // The recipient is the user who just signed up (data.invitedUserId);
      // they need a CONNECTION_REQUEST in their inbox so they can accept or
      // decline from the connections UI.
      await createNotification({
        userId: data.invitedUserId,
        type: 'CONNECTION_REQUEST',
        title: 'New Connection Request',
        message: `${senderName} wants to connect with you`,
        metadata: {
          connectionId: data.connectionId,
          senderId: data.inviterUserId,
          requesterName: senderName,
        },
        triggeredByUserId: data.inviterUserId,
      });
    } catch (error) {
      loggers.api.warn('Failed to create CONNECTION_REQUEST notification on invite acceptance', {
        connectionId: data.connectionId,
        invitedUserId: data.invitedUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  auditConnectionRequested: (data) => {
    try {
      auditRequest(request, {
        eventType: 'authz.permission.granted',
        userId: data.inviterUserId,
        resourceType: 'connection',
        resourceId: data.connectionId,
        details: {
          targetUserId: data.invitedUserId,
          status: data.status,
          operation: 'invite',
          inviteId: data.inviteId,
          targetEmail: data.inviteEmail,
        },
      });
    } catch (error) {
      loggers.api.warn('Failed to audit connection invite acceptance', {
        connectionId: data.connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
