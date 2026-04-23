import { withAdminAuth } from '@/lib/auth/auth';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log'
import { accountRepository, activityLogRepository } from '@pagespace/lib/repositories';
import { deleteAiUsageLogsForUser, deleteMonitoringDataForUser } from '@pagespace/lib';
import { createAnonymizedActorEmail } from '@pagespace/lib/compliance/anonymize';
import { getActorInfo, logUserActivity } from '@pagespace/lib/monitoring/activity-logger';

type DataRouteContext = { params: Promise<{ userId: string }> };

function maskEmail(email: string): string {
  const [localPart, domain] = email.split('@');
  if (!domain) return '***';
  return `${localPart.slice(0, 3)}***@${domain}`;
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
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const reason = (typeof body.reason === 'string' ? body.reason : 'Admin DSAR deletion').substring(0, 200);

      const user = await accountRepository.findById(userId);
      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      // Atomically check for multi-member drives and delete solo ones
      const { multiMemberDriveNames } = await accountRepository.checkAndDeleteSoloDrives(userId);
      if (multiMemberDriveNames.length > 0) {
        return Response.json(
          {
            error: 'User owns drives with other members. Transfer ownership first.',
            multiMemberDrives: multiMemberDriveNames,
          },
          { status: 400 }
        );
      }

      // Log BEFORE anonymization (GDPR compliance)
      const actorInfo = await getActorInfo(adminUser.id);
      logUserActivity(adminUser.id, 'account_delete', {
        targetUserId: userId,
        targetUserEmail: maskEmail(user.email),
      }, actorInfo);

      // Anonymize activity logs
      await activityLogRepository.anonymizeForUser(
        userId,
        createAnonymizedActorEmail(userId)
      );

      // Clean up AI usage logs (fail-closed: error surfaces to caller)
      await deleteAiUsageLogsForUser(userId);

      // Clean up monitoring tables (systemLogs, apiMetrics, errorLogs, userActivities)
      // Note: security_audit_log is intentionally NOT deleted — legal retention requirement
      await deleteMonitoringDataForUser(userId);

      // Delete user record
      await accountRepository.deleteUser(userId);

      loggers.api.info(`Admin DSAR deletion: admin=${adminUser.id} target=${userId} reason="${reason}"`);

      auditRequest(request, { eventType: 'data.delete', userId: adminUser.id, resourceType: 'user', resourceId: userId, details: {
        source: 'admin',
        operation: 'dsar-deletion',
      } });

      return Response.json({ message: 'User data deleted and anonymized' });
    } catch (error) {
      loggers.api.error('Admin DSAR deletion error:', error as Error);
      return Response.json({ error: 'Failed to delete user data' }, { status: 500 });
    }
  }
);
