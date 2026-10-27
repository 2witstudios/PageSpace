/**
 * AI Usage Log Lifecycle Functions
 *
 * Provides TTL-based row purge and user-scoped deletion for account removal.
 */

import { db } from '@pagespace/db/db';
import { lt, eq } from '@pagespace/db/operators';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';

/**
 * Distinct AI providers a user has invoked. Read BEFORE purging the rows so the
 * erasure pipeline can forward/record per-provider deletion evidence (#912).
 */
export async function getDistinctAiProvidersForUser(userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ provider: aiUsageLogs.provider })
    .from(aiUsageLogs)
    .where(eq(aiUsageLogs.userId, userId));
  return rows.map((r) => r.provider).filter((p): p is string => Boolean(p));
}

/**
 * Delete AI usage log rows older than the cutoff date.
 */
export async function purgeAiUsageLogs(olderThan: Date): Promise<number> {
  const result = await db
    .delete(aiUsageLogs)
    .where(lt(aiUsageLogs.timestamp, olderThan))
    .returning({ id: aiUsageLogs.id });

  return result.length;
}

/**
 * Delete all AI usage logs for a specific user.
 * Called during account deletion to clean up data without a FK cascade.
 */
export async function deleteAiUsageLogsForUser(userId: string): Promise<number> {
  const result = await db
    .delete(aiUsageLogs)
    .where(eq(aiUsageLogs.userId, userId))
    .returning({ id: aiUsageLogs.id });

  return result.length;
}
