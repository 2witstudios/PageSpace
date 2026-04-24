/**
 * AI Usage Log Lifecycle Functions
 *
 * Provides TTL-based row purge and user-scoped deletion for account removal.
 */

import { db, aiUsageLogs, lt, eq } from '@pagespace/db';

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
