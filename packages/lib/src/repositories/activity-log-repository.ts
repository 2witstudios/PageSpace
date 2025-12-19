/**
 * Activity Log Repository - Clean seam for activity log operations
 *
 * Provides testable boundary for activity log database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db, activityLogs, eq } from '@pagespace/db';

export interface AnonymizeResult {
  success: boolean;
  error?: string;
}

export const activityLogRepository = {
  /**
   * Anonymize activity logs for a user (GDPR compliance).
   * Replaces actor email with anonymized identifier and sets display name to 'Deleted User'.
   * This preserves the audit trail while removing PII.
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
