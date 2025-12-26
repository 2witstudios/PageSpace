import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { executeRedo, previewRedo, getActivityById } from '@/services/api';
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
} from '@/lib/websocket';
import { db } from '@pagespace/db';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

const bodySchema = z.object({
  context: z.enum(['page', 'drive', 'ai_tool', 'user_dashboard']),
  dryRun: z.boolean().optional().default(false),
  /** Force redo even if resource was modified since the rollback */
  force: z.boolean().optional().default(false),
});

/**
 * POST /api/activities/[activityId]/redo
 *
 * Execute a redo to undo a rollback
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

  loggers.api.debug('[Redo:Route] POST request received', {
    activityId: maskIdentifier(activityId),
    userId: maskIdentifier(userId),
  });

  let body;
  try {
    body = await request.json();
  } catch {
    loggers.api.debug('[Redo:Route] Invalid JSON body');
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parseResult = bodySchema.safeParse(body);
  if (!parseResult.success) {
    loggers.api.debug('[Redo:Route] Body validation failed');
    return NextResponse.json(
      { error: parseResult.error.issues.map(i => i.message).join('. ') },
      { status: 400 }
    );
  }

  const { context: rollbackContext, dryRun, force } = parseResult.data;

  if (dryRun) {
    const preview = await previewRedo(activityId, userId, rollbackContext as RollbackContext, { force });
    return NextResponse.json({ preview });
  }

  const result = await db.transaction(async (tx) => {
    return executeRedo(activityId, userId, rollbackContext as RollbackContext, { tx, force });
  });

  if (!result.success) {
    return NextResponse.json(
      { error: result.message, warnings: result.warnings },
      { status: 400 }
    );
  }

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
      const metadata = activity.metadata;
      const targetUserId = typeof metadata === 'object'
        && metadata !== null
        && 'targetUserId' in metadata
        && typeof (metadata as { targetUserId?: unknown }).targetUserId === 'string'
        ? (metadata as { targetUserId: string }).targetUserId
        : undefined;
      const sourceOperation = activity.rollbackSourceOperation;
      if (targetUserId && sourceOperation) {
        const memberOperation = sourceOperation === 'member_add' ? 'member_added'
          : sourceOperation === 'member_remove' ? 'member_removed'
          : 'member_role_changed';
        await broadcastDriveMemberEvent(
          createDriveMemberEventPayload(activity.driveId, targetUserId, memberOperation, {
            driveName: activity.resourceTitle ?? undefined,
          })
        );
      }
    } else if (activity.resourceType === 'role' && activity.driveId) {
      await broadcastDriveEvent(
        createDriveEventPayload(activity.driveId, 'updated', {
          name: activity.resourceTitle ?? undefined,
        })
      );
    }
  }

  return NextResponse.json({
    ...result,
  });
}
