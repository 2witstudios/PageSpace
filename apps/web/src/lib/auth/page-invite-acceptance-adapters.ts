import { hashToken } from '@pagespace/lib/auth/token-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createPermissionNotification } from '@pagespace/lib/notifications/notifications';
import type { PageAcceptancePorts } from '@pagespace/lib/services/invites';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';

/**
 * Concrete IO implementation of PageAcceptancePorts. Membership is created
 * by the repository's transaction (drive_members + page_permissions atomic).
 * The side-effect ports here only fan out post-commit; per the port
 * contract they swallow + log their own errors so a flaky notification
 * cannot reverse the writes.
 */
export const buildPageAcceptancePorts = (request: Request): PageAcceptancePorts => ({
  loadInvite: async ({ token }) => {
    const tokenHash = hashToken(token);
    const row = await pageInviteRepository.findPendingInviteByTokenHash(tokenHash);
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      pageId: row.pageId,
      pageTitle: row.pageTitle,
      driveId: row.driveId,
      driveName: row.driveName,
      permissions: row.permissions,
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    };
  },

  findExistingPagePermission: async ({ pageId, userId }) =>
    pageInviteRepository.findExistingPagePermission(pageId, userId),

  consumeInviteAndGrantPage: async ({ invite, userId, now }) => {
    const result = await pageInviteRepository.consumeInviteAndGrantPage({
      inviteId: invite.id,
      pageId: invite.pageId,
      driveId: invite.driveId,
      userId,
      permissions: invite.permissions,
      invitedBy: invite.invitedBy,
      grantedAt: now,
    });
    return result;
  },

  broadcastPagePermissionGranted: async (_data) => {
    // Page permission grants don't currently use a dedicated websocket
    // channel — clients re-fetch on focus. This port stays a no-op so the
    // pipe contract is honored and a future broadcast can land here without
    // touching call sites.
  },

  notifyPagePermissionGranted: async (data) => {
    try {
      await createPermissionNotification(
        data.invitedUserId,
        data.pageId,
        'granted',
        {
          canView: data.permissions.includes('VIEW'),
          canEdit: data.permissions.includes('EDIT'),
          canShare: data.permissions.includes('SHARE'),
          canDelete: false,
        },
        data.inviterUserId,
      );
    } catch (error) {
      loggers.api.warn('Failed to create page-permission notification on invite acceptance', {
        pageId: data.pageId,
        invitedUserId: data.invitedUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  auditPagePermissionGranted: (data) => {
    try {
      auditRequest(request, {
        eventType: 'authz.permission.granted',
        userId: data.inviterUserId,
        resourceType: 'page',
        resourceId: data.pageId,
        details: {
          targetUserId: data.invitedUserId,
          permissions: data.permissions,
          operation: 'invite',
          inviteId: data.inviteId,
          targetEmail: data.inviteEmail,
        },
      });
    } catch (error) {
      loggers.api.warn('Failed to audit authz.permission.granted on page invite acceptance', {
        pageId: data.pageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
