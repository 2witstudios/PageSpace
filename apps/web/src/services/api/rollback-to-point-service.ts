/**
 * Rollback to Point Service
 *
 * Handles rolling back all changes from a specific activity forward.
 * Similar to AI undo but for any activities, not just AI-generated ones.
 */

import { db, activityLogs, eq, and, gte, desc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  executeRollback,
  previewRollback,
  getActivityById,
  type RollbackContext,
} from './rollback-service';
import type { ActivityActionPreview } from '@/types/activity-actions';

/**
 * Context for rollback-to-point operations
 */
export type RollbackToPointContext = 'page' | 'drive' | 'user_dashboard';

/**
 * Preview of what will be rolled back
 */
export interface RollbackToPointPreview {
  activityId: string;
  context: RollbackToPointContext;
  pageId: string | null;
  driveId: string | null;
  timestamp: Date;
  activitiesAffected: {
    id: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    resourceTitle: string | null;
    pageId: string | null;
    driveId: string | null;
    timestamp: Date;
    actorEmail: string | null;
    actorDisplayName: string | null;
    isAiGenerated: boolean;
    preview: ActivityActionPreview;
  }[];
  warnings: string[];
}

/**
 * Result of executing a rollback-to-point operation
 */
export interface RollbackToPointResult {
  success: boolean;
  activitiesRolledBack: number;
  errors: string[];
}

/**
 * Create a fallback preview for activities that fail to preview
 */
function fallbackPreview(reason: string): ActivityActionPreview {
  return {
    action: 'rollback',
    canExecute: false,
    reason,
    warnings: [],
    hasConflict: false,
    conflictFields: [],
    requiresForce: false,
    isNoOp: false,
    currentValues: null,
    targetValues: null,
    changes: [],
    affectedResources: [],
  };
}

/**
 * Preview what will be rolled back if we rollback from a specific activity
 */
export async function previewRollbackToPoint(
  activityId: string,
  userId: string,
  context: RollbackToPointContext
): Promise<RollbackToPointPreview | null> {
  loggers.api.debug('[RollbackToPoint:Preview] Starting preview', {
    activityId,
    userId,
    context,
  });

  try {
    // Get the starting activity
    const startActivity = await getActivityById(activityId);
    if (!startActivity) {
      loggers.api.warn('[RollbackToPoint] Activity not found', { activityId });
      return null;
    }

    const { timestamp, pageId, driveId } = startActivity;
    loggers.api.debug('[RollbackToPoint:Preview] Start activity resolved', {
      timestamp: timestamp.toISOString(),
      pageId,
      driveId,
    });

    // Validate that the activity has the required scope ID for the context
    if (context === 'page' && !pageId) {
      loggers.api.warn('[RollbackToPoint] Page context requested but activity has no pageId', {
        activityId,
        context,
      });
      throw new Error('Cannot rollback to this point: activity is not associated with a page');
    }
    if (context === 'drive' && !driveId) {
      loggers.api.warn('[RollbackToPoint] Drive context requested but activity has no driveId', {
        activityId,
        context,
      });
      throw new Error('Cannot rollback to this point: activity is not associated with a drive');
    }

    // Build query conditions based on context
    const conditions = [gte(activityLogs.timestamp, timestamp)];

    if (context === 'page') {
      // Page context: only activities for this page
      conditions.push(eq(activityLogs.pageId, pageId!));
    } else if (context === 'drive') {
      // Drive context: all activities in this drive
      conditions.push(eq(activityLogs.driveId, driveId!));
    } else if (context === 'user_dashboard') {
      // User dashboard: all activities by this user
      conditions.push(eq(activityLogs.userId, userId));
    }

    // Get all activities from this point forward
    const activities = await db
      .select()
      .from(activityLogs)
      .where(and(...conditions))
      .orderBy(desc(activityLogs.timestamp));

    loggers.api.debug('[RollbackToPoint:Preview] Found activities', {
      activitiesCount: activities.length,
    });

    // Collect all activity IDs for undo group logic (skip conflict/no-op detection within group)
    const undoGroupActivityIds = activities.map(a => a.id);

    // Check rollback eligibility for each activity
    const activitiesAffected: RollbackToPointPreview['activitiesAffected'] = [];
    const warnings: string[] = [];

    for (const activity of activities) {
      // Map context for previewRollback
      const rollbackContext: RollbackContext = activity.isAiGenerated
        ? 'ai_tool'
        : context === 'user_dashboard'
          ? 'user_dashboard'
          : context;

      loggers.api.debug('[RollbackToPoint:Preview] Checking activity eligibility', {
        activityId: activity.id,
        operation: activity.operation,
        resourceType: activity.resourceType,
        rollbackContext,
      });

      let preview: ActivityActionPreview;
      try {
        preview = await previewRollback(activity.id, userId, rollbackContext, { undoGroupActivityIds });
        if (!preview) {
          preview = fallbackPreview('Preview failed');
          warnings.push(`Could not preview rollback for activity ${activity.id}`);
        }
      } catch (error) {
        preview = fallbackPreview('Preview failed');
        warnings.push(
          `Failed to preview ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      loggers.api.debug('[RollbackToPoint:Preview] Activity eligibility result', {
        activityId: activity.id,
        canExecute: preview.canExecute,
        reason: preview.reason,
      });

      activitiesAffected.push({
        id: activity.id,
        operation: activity.operation,
        resourceType: activity.resourceType,
        resourceId: activity.resourceId,
        resourceTitle: activity.resourceTitle,
        pageId: activity.pageId,
        driveId: activity.driveId,
        timestamp: activity.timestamp,
        actorEmail: activity.actorEmail,
        actorDisplayName: activity.actorDisplayName,
        isAiGenerated: activity.isAiGenerated,
        preview,
      });

      // Collect warnings
      if (!preview.canExecute && preview.reason) {
        warnings.push(
          `Cannot undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${preview.reason}`
        );
      } else if (preview.warnings.length > 0) {
        warnings.push(...preview.warnings);
      }
    }

    loggers.api.debug('[RollbackToPoint:Preview] Preview complete', {
      activitiesTotal: activitiesAffected.length,
      activitiesRollbackable: activitiesAffected.filter((a) => a.preview.canExecute).length,
      warningsCount: warnings.length,
    });

    return {
      activityId,
      context,
      pageId,
      driveId,
      timestamp,
      activitiesAffected,
      warnings,
    };
  } catch (error) {
    loggers.api.error('[RollbackToPoint] Error previewing', {
      activityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Execute a rollback-to-point operation
 * @param existingPreview - Optional pre-computed preview to avoid redundant database queries
 */
export async function executeRollbackToPoint(
  activityId: string,
  userId: string,
  context: RollbackToPointContext,
  existingPreview?: RollbackToPointPreview,
  options?: { force?: boolean }
): Promise<RollbackToPointResult> {
  loggers.api.debug('[RollbackToPoint:Execute] Starting execution', {
    activityId,
    userId,
    context,
    hasExistingPreview: !!existingPreview,
  });

  const force = options?.force ?? false;
  const errors: string[] = [];
  let activitiesRolledBack = 0;

  try {
    // Use existing preview if provided, otherwise compute it
    const preview = existingPreview ?? (await previewRollbackToPoint(activityId, userId, context));
    if (!preview) {
      loggers.api.debug('[RollbackToPoint:Execute] Aborting - preview not available');
      return {
        success: false,
        activitiesRolledBack: 0,
        errors: ['Activity not found or preview failed'],
      };
    }

    loggers.api.debug('[RollbackToPoint:Execute] Preview resolved', {
      activitiesAffected: preview.activitiesAffected.length,
    });

    // Collect all activity IDs for undo group logic (skip conflict/no-op detection within group)
    const undoGroupActivityIds = preview.activitiesAffected.map(a => a.id);

    // Execute all rollbacks in a single transaction for atomicity
    loggers.api.debug('[RollbackToPoint:Execute] Starting transaction');

    await db.transaction(async (tx) => {
      // Rollback activities in reverse chronological order (newest first)
      for (const activity of preview.activitiesAffected) {
        const activityPreview = activity.preview;

        if (!activityPreview.canExecute) {
          if (!force || !activityPreview.requiresForce) {
            loggers.api.debug('[RollbackToPoint:Execute] Activity not rollbackable - aborting', {
              activityId: activity.id,
              reason: activityPreview.reason,
            });
            throw new Error(
              `Cannot undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${activityPreview.reason}`
            );
          }
        }

        // Determine context based on activity
        const rollbackContext: RollbackContext = activity.isAiGenerated
          ? 'ai_tool'
          : context === 'user_dashboard'
            ? 'user_dashboard'
            : context;

        loggers.api.debug('[RollbackToPoint:Execute] Rolling back activity', {
          activityId: activity.id,
          operation: activity.operation,
          resourceType: activity.resourceType,
          rollbackContext,
        });

        const result = await executeRollback(activity.id, userId, rollbackContext, { tx, force, undoGroupActivityIds });
        if (!result.success) {
          loggers.api.debug('[RollbackToPoint:Execute] Activity rollback failed - aborting', {
            activityId: activity.id,
            message: result.message,
          });
          throw new Error(
            `Failed to undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${result.message}`
          );
        }

        loggers.api.debug('[RollbackToPoint:Execute] Activity rollback succeeded', {
          activityId: activity.id,
        });

        activitiesRolledBack++;
      }

      loggers.api.debug('[RollbackToPoint:Execute] Transaction committing');
    });

    loggers.api.debug('[RollbackToPoint:Execute] Transaction committed successfully', {
      activitiesRolledBack,
    });

    loggers.api.info('[RollbackToPoint] Completed', {
      activityId,
      context,
      activitiesRolledBack,
      errorCount: errors.length,
    });

    return {
      success: errors.length === 0,
      activitiesRolledBack,
      errors,
    };
  } catch (error) {
    loggers.api.error('[RollbackToPoint] Error executing', {
      activityId,
      context,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      activitiesRolledBack: 0,
      errors: [...errors, error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}
