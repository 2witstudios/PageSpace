import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getActivityById, previewRollback } from '@/services/api';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions';
import type { RollbackContext } from '@pagespace/lib/permissions';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

const querySchema = z.object({
  context: z.enum(['page', 'drive', 'ai_tool', 'user_dashboard']).default('page'),
});

/**
 * GET /api/activities/[activityId]
 *
 * Fetch a single activity log with rollback eligibility
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ activityId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { activityId } = await context.params;
  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  // Parse query params
  const parseResult = querySchema.safeParse({
    context: searchParams.get('context') ?? undefined,
  });

  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.issues.map(i => i.message).join('. ') },
      { status: 400 }
    );
  }

  const rollbackContext = parseResult.data.context as RollbackContext;

  // Get the activity
  const activity = await getActivityById(activityId);
  if (!activity) {
    return NextResponse.json(
      { error: 'Activity not found' },
      { status: 404 }
    );
  }

  // Authorization check: User must have access to the associated resource
  if (activity.pageId) {
    const canView = await canUserViewPage(userId, activity.pageId);
    if (!canView) {
      return NextResponse.json(
        { error: 'Unauthorized - you do not have access to this page' },
        { status: 403 }
      );
    }
  } else if (activity.driveId) {
    const isMember = await isUserDriveMember(userId, activity.driveId);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Unauthorized - you do not have access to this drive' },
        { status: 403 }
      );
    }
  } else if (activity.userId !== userId) {
    // User-level activities can only be viewed by the activity owner
    return NextResponse.json(
      { error: 'Unauthorized - you do not have access to this activity' },
      { status: 403 }
    );
  }

  // Get rollback preview to determine eligibility
  const preview = await previewRollback(activityId, userId, rollbackContext);

  return NextResponse.json({
    activity,
    canRollback: preview.canRollback,
    rollbackReason: preview.reason,
    warnings: preview.warnings,
  });
}
