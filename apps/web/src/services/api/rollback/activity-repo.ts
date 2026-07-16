/**
 * Activity repository shell.
 *
 * Reads activities and version history against the injected deps.db. Every read
 * swallows DB errors and returns null/empty/default — the four public callers
 * rely on that legacy contract (surfaced explicitly in a follow-up task).
 */
import { eq, and, desc, count } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { users } from '@pagespace/db/schema/auth';
import { mapActivityRow, buildHistoryConditions } from './activity-mapping';
import type { RollbackDeps } from './deps';
import type { ActivityLogForRollback } from './types';

/** Optional filters for a version-history query. */
export interface VersionHistoryOptions {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  actorId?: string;
  operation?: string;
  includeAiOnly?: boolean;
  resourceType?: string;
}

export async function getActivityById(
  deps: RollbackDeps,
  activityId: string
): Promise<ActivityLogForRollback | null> {
  deps.logger.debug('[Rollback:Fetch] Fetching activity by ID', { activityId });

  try {
    const result = await deps.db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.id, activityId))
      .limit(1);

    if (result.length === 0) {
      deps.logger.debug('[Rollback:Fetch] Activity not found', { activityId });
      return null;
    }

    return mapActivityRow(result[0]);
  } catch (error) {
    deps.logger.error('[RollbackService] Error fetching activity', {
      activityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getPageVersionHistory(
  deps: RollbackDeps,
  pageId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  const { limit = 50, offset = 0, startDate, endDate, actorId, operation, includeAiOnly } = options;

  deps.logger.debug('[History:Fetch] Fetching page version history', {
    pageId,
    userId,
    limit,
    offset,
    hasFilters: !!(startDate || endDate || actorId || operation || includeAiOnly),
  });

  try {
    const conditions = buildHistoryConditions(eq(activityLogs.pageId, pageId), {
      startDate,
      endDate,
      actorId,
      operation,
      includeAiOnly,
    });

    const [activities, countResult] = await Promise.all([
      deps.db
        .select()
        .from(activityLogs)
        .where(and(...conditions))
        .orderBy(desc(activityLogs.timestamp))
        .limit(limit)
        .offset(offset),
      deps.db
        .select({ value: count() })
        .from(activityLogs)
        .where(and(...conditions)),
    ]);

    return {
      activities: activities.map(mapActivityRow),
      total: countResult[0]?.value ?? 0,
    };
  } catch (error) {
    deps.logger.error('[RollbackService] Error fetching page version history', {
      pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { activities: [], total: 0 };
  }
}

export async function getDriveVersionHistory(
  deps: RollbackDeps,
  driveId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  const { limit = 50, offset = 0, startDate, endDate, actorId, operation, resourceType } = options;

  deps.logger.debug('[History:Fetch] Fetching drive version history', {
    driveId,
    userId,
    limit,
    offset,
    hasFilters: !!(startDate || endDate || actorId || operation || resourceType),
  });

  try {
    const conditions = buildHistoryConditions(eq(activityLogs.driveId, driveId), {
      startDate,
      endDate,
      actorId,
      operation,
      resourceType,
    });

    const [activities, countResult] = await Promise.all([
      deps.db
        .select()
        .from(activityLogs)
        .where(and(...conditions))
        .orderBy(desc(activityLogs.timestamp))
        .limit(limit)
        .offset(offset),
      deps.db
        .select({ value: count() })
        .from(activityLogs)
        .where(and(...conditions)),
    ]);

    return {
      activities: activities.map(mapActivityRow),
      total: countResult[0]?.value ?? 0,
    };
  } catch (error) {
    deps.logger.error('[RollbackService] Error fetching drive version history', {
      driveId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { activities: [], total: 0 };
  }
}

export async function getUserRetentionDays(deps: RollbackDeps, userId: string): Promise<number> {
  // Default retention days by tier (ordered: free < pro < founder < business)
  const defaultRetention: Record<string, number> = {
    free: 7,
    pro: 30,
    founder: 90,
    business: -1, // unlimited
  };

  try {
    const user = await deps.db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) {
      return defaultRetention.free;
    }

    const tier = user[0].subscriptionTier || 'free';
    return defaultRetention[tier] || defaultRetention.free;
  } catch (error) {
    deps.logger.error('[RollbackService] Error getting user retention days', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return defaultRetention.free;
  }
}
