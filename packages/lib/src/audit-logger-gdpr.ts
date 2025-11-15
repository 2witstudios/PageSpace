/**
 * GDPR Utilities for Audit Logger
 *
 * Handles user data anonymization and retention policies while preserving audit integrity
 */

import { db, auditLogs } from '@pagespace/db';
import { eq, lt, and } from 'drizzle-orm';
import { createHash } from 'crypto';

/**
 * Anonymize user data in audit logs
 *
 * This is called when a user exercises their GDPR "right to be forgotten"
 * We preserve the audit trail but anonymize personal identifiable information
 */
export async function anonymizeUserAuditLogs(userId: string): Promise<number> {
  try {
    // Generate anonymous identifier (consistent hash of userId)
    const anonymousId = createHash('sha256').update(userId).digest('hex').substring(0, 16);
    const anonymousEmail = `anonymous_${anonymousId}@deleted.user`;

    // Update all audit logs for this user
    const result = await db
      .update(auditLogs)
      .set({
        userId: anonymousId,
        userEmail: anonymousEmail,
        anonymized: true,
        // Clear potentially identifying metadata
        ip: null,
        userAgent: null,
        metadata: null,
      })
      .where(eq(auditLogs.userId, userId));

    console.log(`[AuditLogger GDPR] Anonymized ${result.rowCount || 0} audit logs for user ${userId}`);
    return result.rowCount || 0;
  } catch (error) {
    console.error('[AuditLogger GDPR] Failed to anonymize user audit logs:', error);
    throw error;
  }
}

/**
 * Delete expired audit logs based on retention policy
 *
 * Should be run as a scheduled background job (e.g., daily)
 */
export async function deleteExpiredAuditLogs(): Promise<number> {
  try {
    const now = new Date();

    const result = await db
      .delete(auditLogs)
      .where(
        and(
          lt(auditLogs.retentionDate, now),
          eq(auditLogs.anonymized, true) // Only delete logs that have already been anonymized
        )
      );

    console.log(`[AuditLogger GDPR] Deleted ${result.rowCount || 0} expired audit logs`);
    return result.rowCount || 0;
  } catch (error) {
    console.error('[AuditLogger GDPR] Failed to delete expired audit logs:', error);
    throw error;
  }
}

/**
 * Export user audit logs (GDPR right to data portability)
 */
export async function exportUserAuditLogs(userId: string): Promise<any[]> {
  try {
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId));

    console.log(`[AuditLogger GDPR] Exported ${logs.length} audit logs for user ${userId}`);
    return logs;
  } catch (error) {
    console.error('[AuditLogger GDPR] Failed to export user audit logs:', error);
    throw error;
  }
}

/**
 * Get audit log retention statistics
 */
export async function getRetentionStatistics(): Promise<{
  total: number;
  anonymized: number;
  expiredButNotDeleted: number;
  willExpireSoon: number; // Within 30 days
}> {
  try {
    const now = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const [
      totalLogs,
      anonymizedLogs,
      expiredLogs,
      expiringSoonLogs
    ] = await Promise.all([
      db.select({ count: db.$count() }).from(auditLogs),
      db.select({ count: db.$count() }).from(auditLogs).where(eq(auditLogs.anonymized, true)),
      db.select({ count: db.$count() }).from(auditLogs).where(lt(auditLogs.retentionDate, now)),
      db.select({ count: db.$count() }).from(auditLogs).where(
        and(
          lt(auditLogs.retentionDate, thirtyDaysFromNow),
          eq(auditLogs.anonymized, false)
        )
      ),
    ]);

    return {
      total: totalLogs[0]?.count || 0,
      anonymized: anonymizedLogs[0]?.count || 0,
      expiredButNotDeleted: expiredLogs[0]?.count || 0,
      willExpireSoon: expiringSoonLogs[0]?.count || 0,
    };
  } catch (error) {
    console.error('[AuditLogger GDPR] Failed to get retention statistics:', error);
    throw error;
  }
}

/**
 * Schedule automatic retention cleanup
 *
 * This should be called on application startup to register the cleanup job
 */
export function scheduleRetentionCleanup(intervalHours = 24): NodeJS.Timeout {
  const interval = intervalHours * 60 * 60 * 1000;

  const timer = setInterval(async () => {
    try {
      console.log('[AuditLogger GDPR] Running scheduled retention cleanup...');
      const deletedCount = await deleteExpiredAuditLogs();
      console.log(`[AuditLogger GDPR] Retention cleanup completed. Deleted ${deletedCount} logs.`);
    } catch (error) {
      console.error('[AuditLogger GDPR] Retention cleanup failed:', error);
    }
  }, interval);

  // Run immediately on startup
  deleteExpiredAuditLogs().catch(error => {
    console.error('[AuditLogger GDPR] Initial retention cleanup failed:', error);
  });

  return timer;
}
