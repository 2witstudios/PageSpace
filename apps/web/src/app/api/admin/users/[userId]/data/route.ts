import { withAdminAuth } from '@/lib/auth/auth';
import { loggers, accountRepository, activityLogRepository } from '@pagespace/lib/server';
import { deleteAiUsageLogsForUser } from '@pagespace/lib';
import { createAnonymizedActorEmail } from '@pagespace/lib/compliance/anonymize';
import { getActorInfo, logUserActivity } from '@pagespace/lib/monitoring/activity-logger';

type DataRouteContext = { params: Promise<{ userId: string }> };

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
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const reason = (typeof body.reason === 'string' ? body.reason : 'Admin DSAR deletion').substring(0, 200);

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

        const countByDrive = new Map(memberCounts.map(m => [m.driveId, m.memberCount]));
        const multiMemberDrives = ownedDrives.filter(d => (countByDrive.get(d.id) || 0) > 1);

        if (multiMemberDrives.length > 0) {
          return Response.json(
            {
              error: 'User owns drives with other members. Transfer ownership first.',
              multiMemberDrives: multiMemberDrives.map(d => d.name),
            },
            { status: 400 }
          );
        }

        // Auto-delete solo drives in parallel
        const soloDriveIds = ownedDrives
          .filter(d => (countByDrive.get(d.id) || 0) <= 1)
          .map(d => d.id);

        await Promise.all(soloDriveIds.map(id => accountRepository.deleteDrive(id)));
      }

      // Log BEFORE anonymization (GDPR compliance)
      const actorInfo = await getActorInfo(adminUser.id);
      logUserActivity(adminUser.id, 'account_delete', {
        targetUserId: userId,
        targetUserEmail: user.email,
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
