/**
 * Monitoring Data Cleanup for Account Deletion
 *
 * Deletes user-scoped rows from monitoring tables during account removal.
 * security_audit_log is intentionally excluded — legal retention requirement
 * (tamper-evident hash chain must remain intact for compliance).
 *
 * Erasure must reach BOTH stores wherever subject data COULD live: it gates
 * on CH being configured at all (getClickHouseGdprClient), NOT on the
 * write-cutover flag — a flag rollback after rows landed in CH must not
 * strand them (#890 Phase 3). Both legs are fail-closed — a partial erasure
 * must surface to the caller, never report success.
 *
 * error_resolutions rows (admin resolution notes keyed by error id) are
 * cleaned here too: the subject's error ids are collected from both stores
 * BEFORE the error rows are deleted, because the CH delete destroys the only
 * join key and would leave the notes as unreachable orphans whose free text
 * can echo subject PII. A subject who RESOLVED errors also gets their id
 * nulled out of resolvedBy.
 */

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import {
  systemLogs,
  apiMetrics,
  errorLogs,
  userActivities,
  errorResolutions,
} from '@pagespace/db/schema/monitoring';
import { getClickHouseGdprClient } from '../observability/clickhouse-client';
import { deleteChUserAnalytics, collectChUserErrorIds } from '../observability/analytics-gdpr';

export interface MonitoringDeleteResult {
  systemLogs: number;
  apiMetrics: number;
  errorLogs: number;
  userActivities: number;
  errorResolutions: number;
}

export async function deleteMonitoringDataForUser(userId: string): Promise<MonitoringDeleteResult> {
  // Throws on partial CH config — an eraser that cannot reach a store that
  // may hold subject rows must not pretend it erased.
  const client = getClickHouseGdprClient();

  // Join keys first: after the deletes below they no longer exist anywhere.
  const pgErrorIdRows = await db
    .select({ id: errorLogs.id })
    .from(errorLogs)
    .where(eq(errorLogs.userId, userId));
  const chErrorIds = client ? await collectChUserErrorIds(client, userId) : [];
  const subjectErrorIds = [...pgErrorIdRows.map((row) => row.id), ...chErrorIds];

  const resolutionRows = subjectErrorIds.length
    ? await db
        .delete(errorResolutions)
        .where(inArray(errorResolutions.errorId, subjectErrorIds))
        .returning({ errorId: errorResolutions.errorId })
    : [];
  await db
    .update(errorResolutions)
    .set({ resolvedBy: null })
    .where(eq(errorResolutions.resolvedBy, userId));

  const [sysResult, apiResult, errResult, actResult] = await Promise.all([
    db.delete(systemLogs).where(eq(systemLogs.userId, userId)).returning({ id: systemLogs.id }),
    db.delete(apiMetrics).where(eq(apiMetrics.userId, userId)).returning({ id: apiMetrics.id }),
    db.delete(errorLogs).where(eq(errorLogs.userId, userId)).returning({ id: errorLogs.id }),
    db.delete(userActivities).where(eq(userActivities.userId, userId)).returning({ id: userActivities.id }),
  ]);

  if (client) await deleteChUserAnalytics(client, userId);

  return {
    systemLogs: sysResult.length,
    apiMetrics: apiResult.length,
    errorLogs: errResult.length,
    userActivities: actResult.length,
    errorResolutions: resolutionRows.length,
  };
}
