/**
 * Target-value shaping for rollback.
 *
 * Pure functions that derive the values a rollback/redo should restore and the
 * human-readable change summary, from a recorded activity plus an already
 * resolved content snapshot (the snapshot read is an effect done by the shell).
 */
import type { ActivityChangeSummary } from '@/types/activity-actions';
import type { ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';
import { getOperationSummaryLabel } from './operations';
import type { ActivityLogForRollback } from './types';

/**
 * Check if this activity represents rolling back a previous rollback (effectively redo)
 */
export function isRollingBackRollback(activity: ActivityLogForRollback): boolean {
  return activity.operation === 'rollback';
}

/**
 * The operation whose handler should run. For a rollback-of-a-rollback this is
 * the recorded source operation (or null when it was not captured); otherwise
 * the activity's own operation.
 */
export function getEffectiveOperation(
  activity: ActivityLogForRollback
): ActivityOperation | null {
  if (activity.operation === 'rollback') {
    return (activity.rollbackSourceOperation as ActivityOperation | null) ?? null;
  }
  return activity.operation as ActivityOperation;
}

/** Human-readable description of the changed resource: title, else target email, else resourceType. */
export function getChangeDescription(activity: ActivityLogForRollback): string {
  const metadata = activity.metadata as { targetUserEmail?: string } | null;
  return activity.resourceTitle || metadata?.targetUserEmail || activity.resourceType;
}

/** Build the single-entry ActivityChangeSummary describing what the action will undo. */
export function buildChangeSummary(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null
): ActivityChangeSummary[] {
  const operation = activity.operation;
  const label = `Undo ${getOperationSummaryLabel(operation)}`;
  const fields = activity.updatedFields?.length
    ? activity.updatedFields
    : targetValues
      ? Object.keys(targetValues)
      : [];
  return [
    {
      id: activity.id,
      label,
      description: getChangeDescription(activity),
      fields: fields.length > 0 ? fields : undefined,
      resource: {
        type: activity.resourceType,
        id: activity.resourceId,
        title: activity.resourceTitle || activity.resourceType,
      },
    },
  ];
}

/**
 * Values a plain rollback should restore. For a create, that is the recorded
 * previousValues (rolling a create back means trashing). Otherwise the resolved
 * content snapshot is injected as `content` — but only when the base values do
 * not already carry a content field (an existing content is never overwritten).
 */
export function buildRollbackTargetValues(
  activity: ActivityLogForRollback,
  contentSnapshot?: string | null
): Record<string, unknown> | null {
  const baseValues = activity.previousValues ? { ...activity.previousValues } : null;
  if (activity.operation === 'create') {
    return baseValues;
  }
  const resolvedContent = contentSnapshot ?? activity.contentSnapshot;
  if (resolvedContent && (!baseValues || !Object.prototype.hasOwnProperty.call(baseValues, 'content'))) {
    return {
      ...(baseValues ?? {}),
      content: resolvedContent,
    };
  }
  return baseValues;
}

/**
 * Values an action (rollback or rollback-of-rollback) should apply. Rolling back
 * a rollback restores the state captured before the rollback happened
 * (previousValues); everything else defers to buildRollbackTargetValues.
 */
export function buildActionTargetValues(
  activity: ActivityLogForRollback,
  contentSnapshot?: string | null
): Record<string, unknown> | null {
  if (activity.operation === 'rollback') {
    return activity.previousValues ? { ...activity.previousValues } : null;
  }
  return buildRollbackTargetValues(activity, contentSnapshot);
}
