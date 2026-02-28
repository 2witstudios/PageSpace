import { createHash } from 'crypto';
import { withAdminAuth, type AdminRouteContext } from '@/lib/auth/auth';
import { loggers, accountRepository, activityLogRepository } from '@pagespace/lib/server';
import { deleteAiUsageLogsForUser } from '@pagespace/lib';
import { getActorInfo, logUserActivity } from '@pagespace/lib/monitoring/activity-logger';

type DataRouteContext = { params: Promise<{ userId: string }> };

function createAnonymizedActorEmail(userId: string): string {
  const hash = createHash('sha256').update(userId).digest('hex').slice(0, 12);
  return `deleted_user_${hash}`;
}

/**
 * DELETE /api/admin/users/[userId]/data
 *
 * Admin DSAR deletion endpoint — anonymizes and deletes user data.
 * Used for data subject erasure requests (GDPR Article 17).
 * Requires CSRF token (state-changing admin operation).
 */
export const DELETE = withAdminAuth<DataRouteContext>(
  async (adminUser, request, context) => {
    const { userId } = await context.params;

    if (userId === adminUser.id) {
      return Response.json(
        { error: 'Cannot delete your own account via admin endpoint. Use /api/account instead.' },
        { status: 400 }
      );
    }

    try {
      const body = await request.json().catch(() => ({}));
      const reason = (body as { reason?: string }).reason || 'Admin DSAR deletion';

      const user = await accountRepository.findById(userId);
      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      // Check for multi-member drives
      const ownedDrives = await accountRepository.getOwnedDrives(userId);
      if (ownedDrives.length > 0) {
        const driveIds = ownedDrives.map(d => d.id);
        const memberCounts = await Promise.all(
          driveIds.map(async (driveId) => ({
            driveId,
            memberCount: await accountRepository.getDriveMemberCount(driveId),
          }))
        );

        const multiMemberDrives = ownedDrives.filter(drive => {
          const mc = memberCounts.find(m => m.driveId === drive.id);
          return (mc?.memberCount || 0) > 1;
        });

        if (multiMemberDrives.length > 0) {
          return Response.json(
            {
              error: 'User owns drives with other members. Transfer ownership first.',
              multiMemberDrives: multiMemberDrives.map(d => d.name),
            },
            { status: 400 }
          );
        }

        // Auto-delete solo drives
        const soloDriveIds = ownedDrives
          .filter(drive => {
            const mc = memberCounts.find(m => m.driveId === drive.id);
            return (mc?.memberCount || 0) <= 1;
          })
          .map(d => d.id);

        for (const driveId of soloDriveIds) {
          await accountRepository.deleteDrive(driveId);
        }
      }

      // Log BEFORE anonymization (GDPR compliance)
      const actorInfo = await getActorInfo(adminUser.id);
      logUserActivity(adminUser.id, 'account_delete', {
        targetUserId: userId,
        targetUserEmail: user.email,
        adminAction: true,
        reason,
      }, actorInfo);

      // Anonymize activity logs
      await activityLogRepository.anonymizeForUser(
        userId,
        createAnonymizedActorEmail(userId)
      );

      // Clean up AI usage logs
      try {
        await deleteAiUsageLogsForUser(userId);
      } catch (error) {
        loggers.auth.error('Could not delete AI usage logs during admin DSAR deletion:', error as Error);
      }

      // Delete user record
      await accountRepository.deleteUser(userId);

      loggers.api.info(`Admin DSAR deletion: admin=${adminUser.id} target=${userId} reason="${reason}"`);

      return Response.json({ message: 'User data deleted and anonymized' });
    } catch (error) {
      loggers.api.error('Admin DSAR deletion error:', error as Error);
      return Response.json({ error: 'Failed to delete user data' }, { status: 500 });
    }
  }
);
