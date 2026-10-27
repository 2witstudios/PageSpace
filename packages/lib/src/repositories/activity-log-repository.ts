/**
 * Activity Log Repository - Clean seam for activity log operations
 *
 * Provides testable boundary for activity log database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';

export interface AnonymizeResult {
  success: boolean;
  error?: string;
}

export const activityLogRepository = {
  /**
   * Anonymize activity logs for a user (GDPR compliance).
   * Replaces actor email with anonymized identifier, sets display name to 'Deleted User',
   * and clears resourceTitle (#541 — resourceTitle can carry the user's own email, e.g. on
   * account_delete rows). resourceTitle is excluded from the tamper-evident hash chain
   * (see serializeLogDataForHash in monitoring/activity-logger.ts), so nulling it here does
   * not invalidate any stored hash.
   */
  anonymizeForUser: async (
    userId: string,
    anonymizedEmail: string
  ): Promise<AnonymizeResult> => {
    try {
      await db
        .update(activityLogs)
        .set({
          actorEmail: anonymizedEmail,
          actorDisplayName: 'Deleted User',
          resourceTitle: null,
        })
        .where(eq(activityLogs.userId, userId));

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

export type ActivityLogRepository = typeof activityLogRepository;
