import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib';
import { getPageVersionHistory, getUserRetentionDays } from '@/services/api';
import { isActivityEligibleForRollback } from '@pagespace/lib/permissions';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  actorId: z.string().optional(),
  operation: z.string().optional(),
  includeAiOnly: z.coerce.boolean().optional(),
});

/**
 * GET /api/pages/[pageId]/history
 *
 * Fetch version history for a specific page
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { pageId } = await context.params;
  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  // Check permission to view the page
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json(
      { error: 'Unauthorized - you do not have access to this page' },
      { status: 403 }
    );
  }

  // Parse query params
  const parseResult = querySchema.safeParse({
    limit: searchParams.get('limit') ?? undefined,
    offset: searchParams.get('offset') ?? undefined,
    startDate: searchParams.get('startDate') ?? undefined,
    endDate: searchParams.get('endDate') ?? undefined,
    actorId: searchParams.get('actorId') ?? undefined,
    operation: searchParams.get('operation') ?? undefined,
    includeAiOnly: searchParams.get('includeAiOnly') ?? undefined,
  });

  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.issues.map(i => i.message).join('. ') },
      { status: 400 }
    );
  }

  const params = parseResult.data;

  // Get user's retention limit
  const retentionDays = await getUserRetentionDays(userId);

  // Apply retention limit to startDate if not unlimited (-1)
  let effectiveStartDate = params.startDate;
  if (retentionDays > 0) {
    const retentionCutoff = new Date();
    retentionCutoff.setDate(retentionCutoff.getDate() - retentionDays);

    if (!effectiveStartDate || effectiveStartDate < retentionCutoff) {
      effectiveStartDate = retentionCutoff;
    }
  }

  // Fetch version history
  const { activities, total } = await getPageVersionHistory(pageId, userId, {
    limit: params.limit,
    offset: params.offset,
    startDate: effectiveStartDate,
    endDate: params.endDate,
    actorId: params.actorId,
    operation: params.operation,
    includeAiOnly: params.includeAiOnly,
  });

  // Add rollback eligibility to each activity
  const versionsWithRollback = activities.map((activity) => ({
    ...activity,
    canRollback: isActivityEligibleForRollback(activity),
  }));

  return NextResponse.json({
    versions: versionsWithRollback,
    pagination: {
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + activities.length < total,
    },
    retentionDays,
  });
}
