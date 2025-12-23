import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { executeRollback, previewRollback } from '@/services/api';
import type { RollbackContext } from '@pagespace/lib/permissions';

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

  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parseResult = bodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.issues.map(i => i.message).join('. ') },
      { status: 400 }
    );
  }

  const { context: rollbackContext, dryRun } = parseResult.data;

  // If dry run, just return the preview
  if (dryRun) {
    const preview = await previewRollback(activityId, userId, rollbackContext as RollbackContext);
    return NextResponse.json({
      dryRun: true,
      ...preview,
    });
  }

  // Execute the rollback
  const result = await executeRollback(activityId, userId, rollbackContext as RollbackContext);

  if (!result.success) {
    return NextResponse.json(
      { error: result.message, warnings: result.warnings },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
    rollbackActivityId: result.rollbackActivityId,
    restoredValues: result.restoredValues,
    message: result.message,
    warnings: result.warnings,
  });
}
