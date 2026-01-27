import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { executeRollback, previewRollback, getActivityById } from '@/services/api';
import type { RollbackContext } from '@pagespace/lib/permissions';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  broadcastPageEvent,
  createPageEventPayload,
  broadcastDriveEvent,
  createDriveEventPayload,
  broadcastDriveMemberEvent,
  createDriveMemberEventPayload,
  kickUserFromDrive,
  kickUserFromDriveActivity,
  kickUserFromPage,
  kickUserFromPageActivity,
} from '@/lib/websocket';
import { db } from '@pagespace/db';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const bodySchema = z.object({
  context: z.enum(['page', 'drive', 'ai_tool', 'user_dashboard']),
  dryRun: z.boolean().optional().default(false),
  /** Force rollback even if resource was modified since this activity (may lose recent changes) */
  force: z.boolean().optional().default(false),
});

/**
 * POST /api/activities/[activityId]/rollback
 *
 * Execute a rollback to restore state from a specific activity log
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ activityId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { activityId } = await context.params;
  const userId = auth.userId;

  loggers.api.debug('[Rollback:Route] POST request received', {
    activityId: maskIdentifier(activityId),
    userId: maskIdentifier(userId),
  });

  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch {
    loggers.api.debug('[Rollback:Route] Invalid JSON body');
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parseResult = bodySchema.safeParse(body);
  if (!parseResult.success) {
    loggers.api.debug('[Rollback:Route] Body validation failed');
    return NextResponse.json(
      { error: parseResult.error.issues.map(i => i.message).join('. ') },
      { status: 400 }
    );
  }

  const { context: rollbackContext, dryRun, force } = parseResult.data;

  loggers.api.debug('[Rollback:Route] Request validated', {
    context: rollbackContext,
    dryRun,
    force,
  });

  // If dry run, just return the preview
  if (dryRun) {
    loggers.api.debug('[Rollback:Route] Dry run - fetching preview');
    const preview = await previewRollback(activityId, userId, rollbackContext as RollbackContext, { force });
    loggers.api.debug('[Rollback:Route] Dry run complete', {
      canExecute: preview.canExecute,
      hasConflict: preview.hasConflict,
    });
    return NextResponse.json({
      preview,
    });
  }

  // Fix 9: Execute rollback within transaction for atomicity
  loggers.api.debug('[Rollback:Route] Executing rollback in transaction');
  const result = await db.transaction(async (tx) => {
    return executeRollback(activityId, userId, rollbackContext as RollbackContext, { tx, force });
  });

  if (!result.success) {
    loggers.api.debug('[Rollback:Route] Rollback failed', {
      message: result.message,
    });
    return NextResponse.json(
      { error: result.message, warnings: result.warnings, result },
      { status: 400 }
    );
  }

  loggers.api.debug('[Rollback:Route] Rollback succeeded', {
    rollbackActivityId: result.rollbackActivityId,
  });

  // Broadcast real-time updates for affected resources
  const activity = await getActivityById(activityId);
  if (activity) {
    if (activity.resourceType === 'page' && activity.pageId && activity.driveId) {
      await broadcastPageEvent(
        createPageEventPayload(activity.driveId, activity.pageId, 'updated', {
          title: activity.resourceTitle ?? undefined,
        })
      );
      await broadcastPageEvent(
        createPageEventPayload(activity.driveId, activity.pageId, 'content-updated', {
          title: activity.resourceTitle ?? undefined,
        })
      );
    } else if (activity.resourceType === 'drive' && activity.driveId) {
      await broadcastDriveEvent(
        createDriveEventPayload(activity.driveId, 'updated', {
          name: activity.resourceTitle ?? undefined,
        })
      );
    } else if (activity.resourceType === 'member' && activity.driveId) {
      // Broadcast member updates on rollback
      // Determine the appropriate event based on the original operation being rolled back
      const targetUserId = (activity.metadata as Record<string, unknown>)?.targetUserId as string | undefined;
      if (targetUserId) {
        // Determine the broadcast event based on what's happening to the member
        // For regular rollbacks: undoing the operation (member_add → member_removed)
        // For rollback-of-rollback: restoring the original operation (member_add → member_added)
        let memberOperation: 'member_added' | 'member_removed' | 'member_role_changed';
        if (activity.operation === 'rollback') {
          // Rolling back a rollback = restoring what was originally done
          const sourceOp = activity.rollbackSourceOperation;
          if (!sourceOp) {
            // Source operation unknown - fall back to generic role change broadcast
            memberOperation = 'member_role_changed';
          } else {
            memberOperation = sourceOp === 'member_add' ? 'member_added'
              : sourceOp === 'member_remove' ? 'member_removed'
              : 'member_role_changed';
          }
        } else {
          // Regular rollback = undoing what was done
          memberOperation = activity.operation === 'member_add' ? 'member_removed'
            : activity.operation === 'member_remove' ? 'member_added'
            : 'member_role_changed';
        }
        await broadcastDriveMemberEvent(
          createDriveMemberEventPayload(activity.driveId, targetUserId, memberOperation, {
            driveName: activity.resourceTitle ?? undefined,
          })
        );

        // CRITICAL: If member was removed via rollback, kick from real-time rooms
        if (memberOperation === 'member_removed') {
          await Promise.all([
            kickUserFromDrive(activity.driveId, targetUserId, 'member_removed', activity.resourceTitle ?? undefined),
            kickUserFromDriveActivity(activity.driveId, targetUserId, 'member_removed'),
          ]);
        }
      }
    } else if (activity.resourceType === 'permission' && activity.pageId) {
      // Permission rollbacks - if revoking access, kick from page rooms
      const targetUserId = (activity.metadata as Record<string, unknown>)?.targetUserId as string | undefined;
      if (targetUserId && activity.operation === 'permission_grant') {
        // Rolling back a permission grant = revoking access
        await Promise.all([
          kickUserFromPage(activity.pageId, targetUserId, 'permission_revoked'),
          kickUserFromPageActivity(activity.pageId, targetUserId, 'permission_revoked'),
        ]);
      }
    } else if (activity.resourceType === 'role' && activity.driveId) {
      // Fix 16: Role changes affect all drive members - broadcast drive update
      await broadcastDriveEvent(
        createDriveEventPayload(activity.driveId, 'updated', {
          name: activity.resourceTitle ?? undefined,
        })
      );
    }
    loggers.api.debug('[Rollback:Route] Broadcast sent', {
      resourceType: activity.resourceType,
    });
  }

  return NextResponse.json({
    ...result,
  });
}
