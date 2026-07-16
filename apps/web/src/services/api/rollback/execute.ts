/**
 * Execute shell.
 *
 * Orchestrates a rollback: previews, then dispatches to the rollback/redo
 * executors by resource type, logs the rollback activity, and fires mention
 * notifications. The activity and its content snapshot are fetched exactly once
 * and threaded through preview, the handler, and the audit log. When options.tx
 * is provided it becomes deps.db (via withTx) so one transaction threads through
 * every handler, createPageVersion, and logRollbackActivity.
 */
import type { db } from '@pagespace/db/db';
import type { ActivityAction, ActivityActionResult, ActivityActionPreview } from '@/types/activity-actions';
import type { DeferredWorkflowTrigger, ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';
import type { RollbackContext } from '@pagespace/lib/permissions/rollback-permissions';
import { withTx, type RollbackDeps, type PageUpdateContext, type PageMutationMeta } from './deps';
import { AGENT_CONFIG_ROLLBACK_FIELDS } from './operations';
import { isRollingBackRollback } from './target-values';
import { getActivityById } from './activity-repo';
import { resolveActivityContentSnapshot } from './content-snapshot';
import { previewFromActivity, previewActivityAction } from './preview';
import {
  rollbackPageChange,
  rollbackDriveChange,
  rollbackPermissionChange,
  rollbackAgentConfigChange,
  rollbackMemberChange,
  rollbackRoleChange,
  rollbackMessageChange,
} from './rollback-executors';
import {
  redoPageChange,
  redoDriveChange,
  redoPermissionChange,
  redoAgentConfigChange,
  redoMemberChange,
  redoRoleChange,
  redoMessageChange,
} from './redo-executors';

/**
 * Result of executing a rollback
 */
export interface RollbackResult extends ActivityActionResult {
  success: boolean;
  rollbackActivityId?: string;
  restoredValues?: Record<string, unknown>;
  deferredWorkflowTrigger?: DeferredWorkflowTrigger;
}

export async function previewRollback(
  deps: RollbackDeps,
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { force?: boolean; undoGroupActivityIds?: string[] }
): Promise<ActivityActionPreview> {
  return previewActivityAction(deps, 'rollback', activityId, userId, context, options);
}

export async function executeRollback(
  deps: RollbackDeps,
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { tx?: typeof db; force?: boolean; undoGroupActivityIds?: string[] }
): Promise<RollbackResult> {
  const { tx, force, undoGroupActivityIds } = options ?? {};
  deps.logger.debug('[Rollback:Execute] Starting execution', { activityId, userId, context, usingTransaction: !!tx, force });

  const action: ActivityAction = 'rollback';

  // Fetch the activity and its content snapshot exactly once, then reuse them
  // for the preview, the handler, and the audit log.
  const activity = await getActivityById(deps, activityId);
  if (!activity) {
    deps.logger.debug('[Rollback:Execute] Aborting - activity not found', { activityId });
    return {
      success: false,
      action,
      status: 'failed',
      message: 'Activity not found',
      warnings: [],
      changesApplied: [],
    };
  }

  const resolvedContentSnapshot = await resolveActivityContentSnapshot(deps, activity);
  const preview = await previewFromActivity(deps, action, activity, resolvedContentSnapshot, userId, context, { force, undoGroupActivityIds });

  if (!preview.canExecute) {
    deps.logger.debug('[Rollback:Execute] Aborting - preview check failed', {
      canExecute: preview.canExecute,
      reason: preview.reason,
      isNoOp: preview.isNoOp,
    });
    return {
      success: preview.isNoOp,
      action,
      status: preview.isNoOp ? 'no_op' : 'failed',
      message: preview.reason || 'Cannot rollback this activity',
      warnings: preview.warnings,
      changesApplied: preview.changes,
    };
  }

  const warnings: string[] = [...preview.warnings];
  const txDeps = withTx(deps, tx);
  const changeGroupId = deps.genChangeGroupId();
  const changeGroupType = deps.inferChangeGroupType({ isAiGenerated: false });

  const rollingBackRollback = isRollingBackRollback(activity);
  if (rollingBackRollback && !activity.rollbackSourceOperation) {
    return {
      success: false,
      action,
      status: 'failed',
      message: 'Rollback source operation not available for this activity',
      warnings: preview.warnings,
      changesApplied: preview.changes,
    };
  }
  const effectiveSourceOperation = rollingBackRollback
    ? activity.rollbackSourceOperation as ActivityOperation
    : activity.operation as ActivityOperation;

  const pageUpdateContext: PageUpdateContext = {
    userId,
    changeGroupId,
    changeGroupType,
    source: 'restore',
    metadata: {
      action: 'rollback',
      rollbackFromActivityId: activityId,
      rollbackSourceOperation: effectiveSourceOperation,
      rollbackSourceTimestamp: activity.timestamp,
    },
  };

  try {
    const actorInfo = await deps.getActorInfo(userId);

    let restoredValues: Record<string, unknown> = {};
    let pageMutationMeta: PageMutationMeta | undefined;

    deps.logger.debug('[Rollback:Execute] Executing handler', {
      resourceType: activity.resourceType,
      operation: activity.operation,
      effectiveSourceOperation,
      rollingBackRollback,
      resourceId: activity.resourceId,
    });

    switch (activity.resourceType) {
      case 'page': {
        const result = rollingBackRollback
          ? await redoPageChange(txDeps, activity, preview.targetValues, effectiveSourceOperation, pageUpdateContext)
          : await rollbackPageChange(txDeps, activity, pageUpdateContext);
        restoredValues = result.restoredValues;
        pageMutationMeta = result.pageMutationMeta;
        break;
      }

      case 'drive':
        restoredValues = rollingBackRollback
          ? await redoDriveChange(txDeps, activity, preview.targetValues, effectiveSourceOperation, pageUpdateContext)
          : await rollbackDriveChange(txDeps, activity, pageUpdateContext);
        break;

      case 'permission':
        restoredValues = rollingBackRollback
          ? await redoPermissionChange(txDeps, activity, preview.targetValues, effectiveSourceOperation)
          : await rollbackPermissionChange(txDeps, activity);
        break;

      case 'agent': {
        const result = rollingBackRollback
          ? await redoAgentConfigChange(txDeps, activity, preview.targetValues, pageUpdateContext, AGENT_CONFIG_ROLLBACK_FIELDS)
          : await rollbackAgentConfigChange(txDeps, activity, pageUpdateContext, AGENT_CONFIG_ROLLBACK_FIELDS);
        restoredValues = result.restoredValues;
        pageMutationMeta = result.pageMutationMeta;
        break;
      }

      case 'member':
        restoredValues = rollingBackRollback
          ? await redoMemberChange(txDeps, activity, preview.targetValues, effectiveSourceOperation)
          : await rollbackMemberChange(txDeps, activity);
        break;

      case 'role':
        restoredValues = rollingBackRollback
          ? await redoRoleChange(txDeps, activity, preview.targetValues, effectiveSourceOperation)
          : await rollbackRoleChange(txDeps, activity);
        break;

      case 'message':
        restoredValues = rollingBackRollback
          ? await redoMessageChange(txDeps, activity, preview.targetValues, effectiveSourceOperation)
          : await rollbackMessageChange(txDeps, activity);
        break;

      case 'conversation':
        deps.logger.debug('[Rollback:Execute] Conversation undo cannot be rolled back', {
          activityId: activity.id,
          operation: activity.operation,
        });
        return {
          success: false,
          action,
          status: 'failed',
          message: 'Conversation undo operations cannot be rolled back. The affected messages remain soft-deleted and can be restored individually if needed.',
          warnings,
          changesApplied: preview.changes,
        };

      default:
        deps.logger.debug('[Rollback:Execute] Unsupported resource type', { resourceType: activity.resourceType });
        return {
          success: false,
          action,
          status: 'failed',
          message: `Rollback not supported for resource type: ${activity.resourceType}`,
          warnings,
          changesApplied: preview.changes,
        };
    }

    deps.logger.debug('[Rollback:Execute] Handler completed', {
      resourceType: activity.resourceType,
      restoredFieldsCount: Object.keys(restoredValues).length,
    });

    // Reuse the snapshot resolved once at the top of this function.
    const logOptions: Parameters<RollbackDeps['logRollbackActivity']>[4] = {
      restoredValues,
      replacedValues: preview.currentValues ?? undefined,
      contentSnapshot: resolvedContentSnapshot ?? undefined,
      contentFormat: pageMutationMeta?.contentFormatAfter ?? activity.contentFormat ?? undefined,
      rollbackSourceOperation: effectiveSourceOperation,
      rollbackSourceTimestamp: rollingBackRollback
        ? (activity.rollbackSourceTimestamp ?? activity.timestamp)
        : activity.timestamp,
      rollbackSourceTitle: activity.resourceTitle ?? undefined,
      metadata: activity.metadata ? { sourceMetadata: activity.metadata } : undefined,
      changeGroupId,
      changeGroupType,
      tx,
    };

    if (pageMutationMeta) {
      logOptions.streamId = activity.pageId ?? activity.resourceId;
      logOptions.streamSeq = pageMutationMeta.nextRevision;
      logOptions.stateHashBefore = pageMutationMeta.stateHashBefore;
      logOptions.stateHashAfter = pageMutationMeta.stateHashAfter;
      logOptions.contentRef = pageMutationMeta.contentRefAfter ?? undefined;
      logOptions.contentSize = pageMutationMeta.contentSizeAfter ?? undefined;
    }

    const deferredWorkflowTrigger = await deps.logRollbackActivity(
      userId,
      activityId,
      {
        resourceType: activity.resourceType,
        resourceId: activity.resourceId,
        resourceTitle: activity.resourceTitle ?? undefined,
        driveId: activity.driveId,
        pageId: activity.pageId ?? undefined,
      },
      actorInfo,
      logOptions
    );

    deps.logger.debug('[Rollback:Execute] Rollback completed successfully', {
      activityId,
      resourceType: activity.resourceType,
      resourceId: activity.resourceId,
    });

    // Send notifications for newly mentioned users after all operations complete (fire-and-forget)
    const mentionsResult = pageMutationMeta?.mentionsResult;
    if (mentionsResult && mentionsResult.mentionedByUserId && mentionsResult.newlyMentionedUserIds.length > 0) {
      for (const targetUserId of mentionsResult.newlyMentionedUserIds) {
        deps.createMentionNotification(targetUserId, mentionsResult.sourcePageId, mentionsResult.mentionedByUserId)
          .catch((error: unknown) => {
            deps.logger.error('Failed to send mention notification:', error as Error);
          });
      }
    }

    return {
      success: true,
      action,
      status: 'success',
      restoredValues,
      message: 'Change undone',
      warnings,
      changesApplied: preview.changes,
      deferredWorkflowTrigger,
    };
  } catch (error) {
    deps.logger.error('[RollbackService] Error executing rollback', {
      activityId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      action,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Failed to execute rollback',
      warnings,
      changesApplied: preview.changes,
    };
  }
}
