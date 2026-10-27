/**
 * Activity-row mapping and history filters.
 *
 * Pure helpers shared by getActivityById and the two version-history readers.
 * `mapActivityRow` is the single place a raw activityLogs row becomes an
 * ActivityLogForRollback — add a column to the schema and only this function
 * changes. `buildHistoryConditions` builds the WHERE fragments (query data, no
 * DB access) so the page and drive readers stop duplicating the filter ladder.
 */
import { eq, gte, lte, type SQL } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import type { ActivityResourceType, ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';
import type { ChangeGroupType } from '@pagespace/lib/monitoring/change-group';
import type { PageContentFormat } from '@pagespace/lib/content/page-content-format';
import { isValidOperation } from './operations';
import type { ActivityLogForRollback } from './types';

export type ActivityRow = typeof activityLogs.$inferSelect;

/** Map a raw activityLogs row to the rollback activity shape (single source of truth). */
export function mapActivityRow(row: ActivityRow): ActivityLogForRollback {
  return {
    id: row.id,
    timestamp: row.timestamp,
    userId: row.userId,
    actorEmail: row.actorEmail,
    actorDisplayName: row.actorDisplayName,
    operation: row.operation,
    resourceType: row.resourceType as ActivityResourceType,
    resourceId: row.resourceId,
    resourceTitle: row.resourceTitle,
    driveId: row.driveId,
    pageId: row.pageId,
    isAiGenerated: row.isAiGenerated,
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    contentSnapshot: row.contentSnapshot,
    contentRef: row.contentRef,
    contentFormat: row.contentFormat as PageContentFormat | null,
    contentSize: row.contentSize,
    updatedFields: row.updatedFields as string[] | null,
    previousValues: row.previousValues as Record<string, unknown> | null,
    newValues: row.newValues as Record<string, unknown> | null,
    metadata: row.metadata as Record<string, unknown> | null,
    streamId: row.streamId,
    streamSeq: row.streamSeq,
    changeGroupId: row.changeGroupId,
    changeGroupType: row.changeGroupType as ChangeGroupType | null,
    stateHashBefore: row.stateHashBefore,
    stateHashAfter: row.stateHashAfter,
    rollbackFromActivityId: row.rollbackFromActivityId,
    rollbackSourceOperation: row.rollbackSourceOperation as ActivityOperation | null,
    rollbackSourceTimestamp: row.rollbackSourceTimestamp,
    rollbackSourceTitle: row.rollbackSourceTitle,
  };
}

/** Optional filters a version-history query can apply. */
export interface HistoryFilters {
  startDate?: Date;
  endDate?: Date;
  actorId?: string;
  operation?: string;
  includeAiOnly?: boolean;
  resourceType?: string;
}

/**
 * Build the WHERE conditions for a version-history query from a base scope
 * condition (page or drive) plus the active filters. Each filter that is set
 * contributes exactly one condition; an unrecognized operation is ignored,
 * matching the pre-refactor behavior.
 */
export function buildHistoryConditions(base: SQL, filters: HistoryFilters): SQL[] {
  const { startDate, endDate, actorId, operation, includeAiOnly, resourceType } = filters;
  const conditions: SQL[] = [base];

  if (startDate) {
    conditions.push(gte(activityLogs.timestamp, startDate));
  }
  if (endDate) {
    conditions.push(lte(activityLogs.timestamp, endDate));
  }
  if (actorId) {
    conditions.push(eq(activityLogs.userId, actorId));
  }
  if (operation && isValidOperation(operation)) {
    conditions.push(eq(activityLogs.operation, operation as typeof activityLogs.operation.enumValues[number]));
  }
  if (includeAiOnly) {
    conditions.push(eq(activityLogs.isAiGenerated, true));
  }
  if (resourceType) {
    conditions.push(eq(activityLogs.resourceType, resourceType as typeof activityLogs.resourceType.enumValues[number]));
  }

  return conditions;
}
