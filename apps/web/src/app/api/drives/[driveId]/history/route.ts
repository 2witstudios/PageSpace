import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib';
import { getDriveVersionHistory, getUserRetentionDays } from '@/services/api';
import { isRollbackableOperation } from '@pagespace/lib/permissions';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  actorId: z.string().optional(),
  operation: z.string().optional(),
  resourceType: z.string().optional(),
});

/**
 * GET /api/drives/[driveId]/history
 *
 * Fetch version history for a drive (admin view)
 * Only drive owners and admins can access this endpoint
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { driveId } = await context.params;
  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  // Check if user is drive owner or admin
  const isAdmin = await isDriveOwnerOrAdmin(userId, driveId);
  if (!isAdmin) {
    return NextResponse.json(
      { error: 'Unauthorized - only drive owners and admins can view drive history' },
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
    resourceType: searchParams.get('resourceType') ?? undefined,
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
  const { activities, total } = await getDriveVersionHistory(driveId, userId, {
    limit: params.limit,
    offset: params.offset,
    startDate: effectiveStartDate,
    endDate: params.endDate,
    actorId: params.actorId,
    operation: params.operation,
  });

  // Add rollback eligibility to each activity
  const versionsWithRollback = activities.map((activity) => ({
    ...activity,
    canRollback: isRollbackableOperation(activity.operation) &&
      (activity.previousValues !== null || activity.contentSnapshot !== null),
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
