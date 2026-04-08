/**
 * Monitoring Data Cleanup for Account Deletion
 *
 * Deletes user-scoped rows from monitoring tables during account removal.
 * security_audit_log is intentionally excluded — legal retention requirement
 * (tamper-evident hash chain must remain intact for compliance).
 */

import { db, systemLogs, apiMetrics, errorLogs, userActivities, eq } from '@pagespace/db';

export interface MonitoringDeleteResult {
  systemLogs: number;
  apiMetrics: number;
  errorLogs: number;
  userActivities: number;
}

export async function deleteMonitoringDataForUser(userId: string): Promise<MonitoringDeleteResult> {
  const [sysResult, apiResult, errResult, actResult] = await Promise.all([
    db.delete(systemLogs).where(eq(systemLogs.userId, userId)).returning({ id: systemLogs.id }),
    db.delete(apiMetrics).where(eq(apiMetrics.userId, userId)).returning({ id: apiMetrics.id }),
    db.delete(errorLogs).where(eq(errorLogs.userId, userId)).returning({ id: errorLogs.id }),
    db.delete(userActivities).where(eq(userActivities.userId, userId)).returning({ id: userActivities.id }),
  ]);

  return {
    systemLogs: sysResult.length,
    apiMetrics: apiResult.length,
    errorLogs: errResult.length,
    userActivities: actResult.length,
  };
}
