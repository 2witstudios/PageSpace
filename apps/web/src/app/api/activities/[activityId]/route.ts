import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, checkMCPDriveScope } from '@/lib/auth';
import { getActivityById, previewRollback } from '@/services/api';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions';
import type { RollbackContext } from '@pagespace/lib/permissions';
import { loggers, securityAudit } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

const querySchema = z.object({
  context: z.enum(['page', 'drive', 'ai_tool', 'user_dashboard']).default('page'),
});

/**
 * GET /api/activities/[activityId]
 *
 * Fetch a single activity log with rollback preview
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

  // Check MCP scope based on activity's associated resource
  if (activity.pageId) {
    const scopeError = await checkMCPPageScope(auth, activity.pageId);
    if (scopeError) return scopeError;
  } else if (activity.driveId) {
    const scopeError = checkMCPDriveScope(auth, activity.driveId);
    if (scopeError) return scopeError;
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

  securityAudit.logDataAccess(userId, 'read', 'activity', activityId).catch((error) => {
    loggers.security.warn('[Activities] audit log failed', { error: error instanceof Error ? error.message : String(error), userId });
  });

  // Get rollback preview to determine eligibility
  const preview = await previewRollback(activityId, userId, rollbackContext);

  return NextResponse.json({
    activity,
    preview,
  });
}
