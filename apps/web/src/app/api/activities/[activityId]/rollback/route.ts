import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { executeRollback, previewRollback, getActivityById } from '@/services/api';
import type { RollbackContext } from '@pagespace/lib/permissions';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { broadcastPageEvent, createPageEventPayload, broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { db, activityLogs, eq, and } from '@pagespace/db';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

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
      canRollback: preview.canRollback,
      hasConflict: preview.hasConflict,
    });
    return NextResponse.json({
      dryRun: true,
      ...preview,
    });
  }

  // Fix 10: Idempotency check - prevent duplicate rollbacks
  const existingRollback = await db
    .select({ id: activityLogs.id })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.operation, 'rollback'),
        eq(activityLogs.resourceId, activityId)
      )
    )
    .limit(1);

  if (existingRollback.length > 0) {
    loggers.api.debug('[Rollback:Route] Already rolled back', {
      existingRollbackId: existingRollback[0].id,
    });
    return NextResponse.json({
      success: true,
      message: 'Already rolled back',
      rollbackActivityId: existingRollback[0].id,
      warnings: [],
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
      { error: result.message, warnings: result.warnings },
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
    } else if (activity.resourceType === 'drive' && activity.driveId) {
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
    success: true,
    rollbackActivityId: result.rollbackActivityId,
    restoredValues: result.restoredValues,
    message: result.message,
    warnings: result.warnings,
  });
}
