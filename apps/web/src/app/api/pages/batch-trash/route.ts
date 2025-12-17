import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, agentAwarenessCache, pageTreeCache } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { pageService } from '@/services/api';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

const batchTrashSchema = z.object({
  pageIds: z.array(z.string()).min(1, 'At least one page ID is required'),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const body = await request.json();
    const { pageIds } = batchTrashSchema.parse(body);

    const result = await pageService.batchTrashPages(pageIds, auth.userId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Broadcast events and invalidate caches for all affected drives
    for (const driveId of result.driveIds) {
      // Broadcast a batch trash event
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageIds[0], 'batch-trashed', {
          pageIds,
          count: result.trashedCount,
        })
      );

      // Invalidate page tree cache
      await pageTreeCache.invalidateDriveTree(driveId);

      // Invalidate agent awareness cache if AI_CHAT pages were trashed
      if (result.hasAIChatPages) {
        await agentAwarenessCache.invalidateDriveAgents(driveId);
      }
    }

    return NextResponse.json({
      message: `${result.trashedCount} pages moved to trash successfully.`,
      trashedCount: result.trashedCount,
    });
  } catch (error) {
    loggers.api.error('Error batch trashing pages:', error as Error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || 'Validation failed' },
        { status: 400 }
      );
    }

    const errorMessage = error instanceof Error ? error.message : 'Failed to batch trash pages';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
