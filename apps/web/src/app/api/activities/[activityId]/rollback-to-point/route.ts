import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  previewRollbackToPoint,
  executeRollbackToPoint,
  type RollbackToPointContext,
} from '@/services/api';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  broadcastPageEvent,
  createPageEventPayload,
  broadcastDriveEvent,
  createDriveEventPayload,
} from '@/lib/websocket';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const bodySchema = z.object({
  context: z.enum(['page', 'drive', 'user_dashboard']),
  force: z.boolean().optional().default(false),
});

/**
 * GET /api/activities/[activityId]/rollback-to-point
 *
 * Preview what will be rolled back from this activity forward
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ activityId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { activityId } = await context.params;
  const userId = auth.userId;
  const { searchParams } = new URL(request.url);
  const contextParam = searchParams.get('context') || 'page';

  // Validate context parameter
  const validContexts: RollbackToPointContext[] = ['page', 'drive', 'user_dashboard'];
  if (!validContexts.includes(contextParam as RollbackToPointContext)) {
    return NextResponse.json(
      { error: `Invalid context. Must be one of: ${validContexts.join(', ')}` },
      { status: 400 }
    );
  }
  const rollbackContext = contextParam as RollbackToPointContext;

  loggers.api.debug('[RollbackToPoint:Route] GET request received', {
    activityId: maskIdentifier(activityId),
    userId: maskIdentifier(userId),
    context: rollbackContext,
  });

  try {
    const preview = await previewRollbackToPoint(activityId, userId, rollbackContext);

    if (!preview) {
      return NextResponse.json({ error: 'Activity not found or preview failed' }, { status: 404 });
    }

    loggers.api.debug('[RollbackToPoint:Route] Preview generated', {
      activitiesCount: preview.activitiesAffected.length,
      warningsCount: preview.warnings.length,
    });

    return NextResponse.json(preview);
  } catch (error) {
    loggers.api.error('[RollbackToPoint:Route] Preview failed', {
      activityId: maskIdentifier(activityId),
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Preview failed' },
      { status: 400 }
    );
  }
}

/**
 * POST /api/activities/[activityId]/rollback-to-point
 *
 * Execute rollback of all activities from this point forward
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ activityId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { activityId } = await context.params;
  const userId = auth.userId;

  loggers.api.debug('[RollbackToPoint:Route] POST request received', {
    activityId: maskIdentifier(activityId),
    userId: maskIdentifier(userId),
  });

  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch {
    loggers.api.debug('[RollbackToPoint:Route] Invalid JSON body');
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parseResult = bodySchema.safeParse(body);
  if (!parseResult.success) {
    loggers.api.debug('[RollbackToPoint:Route] Body validation failed');
    return NextResponse.json(
      { error: parseResult.error.issues.map((i) => i.message).join('. ') },
      { status: 400 }
    );
  }

  const { context: rollbackContext, force } = parseResult.data;

  loggers.api.debug('[RollbackToPoint:Route] Request validated', {
    context: rollbackContext,
    force,
  });

  // Get preview first to know what we're rolling back
  const preview = await previewRollbackToPoint(activityId, userId, rollbackContext);
  if (!preview) {
    return NextResponse.json({ error: 'Activity not found or preview failed' }, { status: 404 });
  }

  // Execute in transaction
  loggers.api.debug('[RollbackToPoint:Route] Executing rollback in transaction');
  const result = await executeRollbackToPoint(activityId, userId, rollbackContext, preview, {
    force,
  });

  if (!result.success) {
    loggers.api.debug('[RollbackToPoint:Route] Rollback failed', {
      errors: result.errors,
    });
    return NextResponse.json(
      {
        error: result.errors[0] || 'Rollback failed',
        errors: result.errors,
        result,
      },
      { status: 400 }
    );
  }

  loggers.api.debug('[RollbackToPoint:Route] Rollback succeeded', {
    activitiesRolledBack: result.activitiesRolledBack,
  });

  // Broadcast real-time updates for affected resources
  const broadcastedPages = new Set<string>();
  const broadcastedDrives = new Set<string>();

  for (const activity of preview.activitiesAffected) {
    if (activity.resourceType === 'page' && activity.pageId && activity.driveId) {
      if (!broadcastedPages.has(activity.pageId)) {
        broadcastedPages.add(activity.pageId);
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
      }
    } else if (activity.resourceType === 'drive' && activity.driveId) {
      if (!broadcastedDrives.has(activity.driveId)) {
        broadcastedDrives.add(activity.driveId);
        await broadcastDriveEvent(
          createDriveEventPayload(activity.driveId, 'updated', {
            name: activity.resourceTitle ?? undefined,
          })
        );
      }
    }
  }

  loggers.api.debug('[RollbackToPoint:Route] Broadcasts sent', {
    pageCount: broadcastedPages.size,
    driveCount: broadcastedDrives.size,
  });

  return NextResponse.json({
    ...result,
    message: `Rolled back ${result.activitiesRolledBack} changes`,
  });
}
