/**
 * Activity repository shell.
 *
 * Reads activities and version history against the injected deps.db.
 *
 * The `load*` functions return an explicit RepoResult so a failing database is
 * distinguishable from a genuinely empty result — a DB outage must NOT render as
 * an empty history. The `get*` wrappers preserve the pre-refactor null/empty/
 * default contract that the four current callers still rely on; migrating those
 * callers to the explicit error is tracked as a follow-up task.
 */
import { eq, and, desc, count } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { users } from '@pagespace/db/schema/auth';
import { mapActivityRow, buildHistoryConditions } from './activity-mapping';
import type { RollbackDeps } from './deps';
import type { ActivityLogForRollback } from './types';

/** Explicit success/failure for a repository read. */
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

export interface VersionHistoryPage {
  activities: ActivityLogForRollback[];
  total: number;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Default retention days by tier (ordered: free < pro < founder < business)
const DEFAULT_RETENTION: Record<string, number> = {
  free: 7,
  pro: 30,
  founder: 90,
  business: -1, // unlimited
};
const FREE_RETENTION = DEFAULT_RETENTION.free;

// ─── Explicit-Result reads ────────────────────────────────────────────────────

export async function loadActivityById(
  deps: RollbackDeps,
  activityId: string
): Promise<RepoResult<ActivityLogForRollback | null>> {
  deps.logger.debug('[Rollback:Fetch] Fetching activity by ID', { activityId });

  try {
    const result = await deps.db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.id, activityId))
      .limit(1);

    if (result.length === 0) {
      deps.logger.debug('[Rollback:Fetch] Activity not found', { activityId });
      return { ok: true, value: null };
    }

    return { ok: true, value: mapActivityRow(result[0]) };
  } catch (error) {
    deps.logger.error('[RollbackService] Error fetching activity', { activityId, error: errorMessage(error) });
    return { ok: false, error: errorMessage(error) };
  }
}

async function loadVersionHistory(
  deps: RollbackDeps,
  scope: 'page' | 'drive',
  scopeId: string,
  userId: string,
  options: VersionHistoryOptions
): Promise<RepoResult<VersionHistoryPage>> {
  const { limit = 50, offset = 0, startDate, endDate, actorId, operation, includeAiOnly, resourceType } = options;

  deps.logger.debug('[History:Fetch] Fetching version history', {
    scope,
    scopeId,
    userId,
    limit,
    offset,
    hasFilters: !!(startDate || endDate || actorId || operation || includeAiOnly || resourceType),
  });

  try {
    const base = scope === 'page' ? eq(activityLogs.pageId, scopeId) : eq(activityLogs.driveId, scopeId);
    // Page history ignores resourceType; drive history ignores includeAiOnly (as before).
    const conditions = scope === 'page'
      ? buildHistoryConditions(base, { startDate, endDate, actorId, operation, includeAiOnly })
      : buildHistoryConditions(base, { startDate, endDate, actorId, operation, resourceType });

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
      ok: true,
      value: {
        activities: activities.map(mapActivityRow),
        total: countResult[0]?.value ?? 0,
      },
    };
  } catch (error) {
    deps.logger.error('[RollbackService] Error fetching version history', { scope, scopeId, error: errorMessage(error) });
    return { ok: false, error: errorMessage(error) };
  }
}

export function loadPageVersionHistory(
  deps: RollbackDeps,
  pageId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<RepoResult<VersionHistoryPage>> {
  return loadVersionHistory(deps, 'page', pageId, userId, options);
}

export function loadDriveVersionHistory(
  deps: RollbackDeps,
  driveId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<RepoResult<VersionHistoryPage>> {
  return loadVersionHistory(deps, 'drive', driveId, userId, options);
}

export async function loadUserRetentionDays(deps: RollbackDeps, userId: string): Promise<RepoResult<number>> {
  try {
    const user = await deps.db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) {
      return { ok: true, value: FREE_RETENTION };
    }

    const tier = user[0].subscriptionTier || 'free';
    return { ok: true, value: DEFAULT_RETENTION[tier] || FREE_RETENTION };
  } catch (error) {
    deps.logger.error('[RollbackService] Error getting user retention days', { userId, error: errorMessage(error) });
    return { ok: false, error: errorMessage(error) };
  }
}

// ─── Legacy null/empty/default wrappers (frozen public contract) ──────────────

export async function getActivityById(deps: RollbackDeps, activityId: string): Promise<ActivityLogForRollback | null> {
  const result = await loadActivityById(deps, activityId);
  return result.ok ? result.value : null;
}

export async function getPageVersionHistory(
  deps: RollbackDeps,
  pageId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<VersionHistoryPage> {
  const result = await loadPageVersionHistory(deps, pageId, userId, options);
  return result.ok ? result.value : { activities: [], total: 0 };
}

export async function getDriveVersionHistory(
  deps: RollbackDeps,
  driveId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<VersionHistoryPage> {
  const result = await loadDriveVersionHistory(deps, driveId, userId, options);
  return result.ok ? result.value : { activities: [], total: 0 };
}

export async function getUserRetentionDays(deps: RollbackDeps, userId: string): Promise<number> {
  const result = await loadUserRetentionDays(deps, userId);
  return result.ok ? result.value : FREE_RETENTION;
}
