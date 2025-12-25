import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { executeRollback, previewRollback } from '@/services/api';
import type { RollbackContext } from '@pagespace/lib/permissions';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

const bodySchema = z.object({
  context: z.enum(['page', 'drive', 'ai_tool', 'user_dashboard']),
  dryRun: z.boolean().optional().default(false),
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

  const { context: rollbackContext, dryRun } = parseResult.data;

  loggers.api.debug('[Rollback:Route] Request validated', {
    context: rollbackContext,
    dryRun,
  });

  // If dry run, just return the preview
  if (dryRun) {
    loggers.api.debug('[Rollback:Route] Dry run - fetching preview');
    const preview = await previewRollback(activityId, userId, rollbackContext as RollbackContext);
    loggers.api.debug('[Rollback:Route] Dry run complete', {
      canRollback: preview.canRollback,
    });
    return NextResponse.json({
      dryRun: true,
      ...preview,
    });
  }

  // Execute the rollback
  loggers.api.debug('[Rollback:Route] Executing rollback');
  const result = await executeRollback(activityId, userId, rollbackContext as RollbackContext);

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

  return NextResponse.json({
    success: true,
    rollbackActivityId: result.rollbackActivityId,
    restoredValues: result.restoredValues,
    message: result.message,
    warnings: result.warnings,
  });
}
