import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, pageTreeCache } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { pageService } from '@/services/api';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

const batchMoveSchema = z.object({
  pageIds: z.array(z.string()).min(1, 'At least one page ID is required'),
  newParentId: z.string().nullable(),
  insertionIndex: z.number().int().optional(),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const body = await request.json();
    const { pageIds, newParentId } = batchMoveSchema.parse(body);

    const result = await pageService.batchMovePages(pageIds, newParentId, auth.userId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Broadcast events and invalidate caches for all affected drives
    for (const driveId of result.driveIds) {
      // Broadcast a batch move event
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageIds[0], 'batch-moved', {
          pageIds,
          count: result.movedCount,
          parentId: result.targetParentId ?? undefined,
        })
      );

      // Invalidate page tree cache
      await pageTreeCache.invalidateDriveTree(driveId);
    }

    return NextResponse.json({
      message: `${result.movedCount} pages moved successfully.`,
      movedCount: result.movedCount,
      targetParentId: result.targetParentId,
    });
  } catch (error) {
    loggers.api.error('Error batch moving pages:', error as Error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || 'Validation failed' },
        { status: 400 }
      );
    }

    const errorMessage = error instanceof Error ? error.message : 'Failed to batch move pages';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
