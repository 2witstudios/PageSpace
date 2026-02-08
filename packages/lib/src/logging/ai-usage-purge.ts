/**
 * AI Usage Log Lifecycle Functions
 *
 * Provides TTL-based content anonymization, full row purge,
 * and user-scoped deletion for account removal.
 */

import { db, aiUsageLogs, lt, eq, and, or, isNotNull } from '@pagespace/db';

/**
 * Anonymize prompt/completion text for logs older than the cutoff date.
 * Preserves metadata (tokens, cost, model) for analytics while removing PII.
 */
export async function anonymizeAiUsageContent(olderThan: Date): Promise<number> {
  const result = await db
    .update(aiUsageLogs)
    .set({ prompt: null, completion: null })
    .where(
      and(
        lt(aiUsageLogs.timestamp, olderThan),
        or(isNotNull(aiUsageLogs.prompt), isNotNull(aiUsageLogs.completion))
      )
    )
    .returning({ id: aiUsageLogs.id });

  return result.length;
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
