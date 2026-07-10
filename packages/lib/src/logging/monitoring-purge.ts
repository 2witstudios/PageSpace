/**
 * Monitoring Data Cleanup for Account Deletion
 *
 * Deletes user-scoped rows from monitoring tables during account removal.
 * security_audit_log is intentionally excluded — legal retention requirement
 * (tamper-evident hash chain must remain intact for compliance).
 *
 * With CLICKHOUSE_ENABLED, erasure must reach BOTH stores: pre-cutover rows
 * still live in main PG until the Phase 6 drop, post-cutover rows live only
 * in ClickHouse (#890 Phase 3). Both legs are fail-closed — a partial
 * erasure must surface to the caller, never report success.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { systemLogs, apiMetrics, errorLogs, userActivities } from '@pagespace/db/schema/monitoring';
import { isClickHouseEnabled, getClickHouseClient } from '../observability/clickhouse-client';
import { deleteChUserAnalytics } from '../observability/analytics-gdpr';

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

  if (isClickHouseEnabled()) {
    // getClickHouseClient throws on misconfiguration — that propagates too:
    // an eraser that cannot reach its store must not pretend it erased.
    const client = getClickHouseClient();
    if (client) await deleteChUserAnalytics(client, userId);
  }

  return {
    systemLogs: sysResult.length,
    apiMetrics: apiResult.length,
    errorLogs: errResult.length,
    userActivities: actResult.length,
  };
}
