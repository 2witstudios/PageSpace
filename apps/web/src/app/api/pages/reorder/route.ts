import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, pageTreeCache } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { pageReorderService } from '@/services/api';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

const reorderSchema = z.object({
  pageId: z.string(),
  newParentId: z.string().nullable(),
  newPosition: z.number().int().gte(0, 'Position must be a non-negative integer'),
});

export async function PATCH(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const body = await request.json();
    const { pageId, newParentId, newPosition } = reorderSchema.parse(body);

    // Validate parent change to prevent circular references
    const validation = await pageReorderService.validateMove(pageId, newParentId);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    // Execute the reorder operation
    const result = await pageReorderService.reorderPage({
      pageId,
      newParentId,
      newPosition,
      userId: auth.userId,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Broadcast event and invalidate cache on success
    await broadcastPageEvent(
      createPageEventPayload(result.driveId, pageId, 'moved', {
        parentId: newParentId,
        title: result.pageTitle || undefined,
      }),
    );

    await pageTreeCache.invalidateDriveTree(result.driveId);

    // Log activity for audit trail (page moves affect tree structure)
    const actorInfo = await getActorInfo(auth.userId);
    logPageActivity(auth.userId, 'reorder', {
      id: pageId,
      title: result.pageTitle ?? undefined,
      driveId: result.driveId,
    }, {
      ...actorInfo,
      metadata: {
        newParentId,
        newPosition,
      },
    });

    return NextResponse.json({ message: 'Page reordered successfully' });
  } catch (error) {
    loggers.api.error('Error reordering page:', error as Error);

    // Handle Zod validation errors
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || 'Validation failed' }, { status: 400 });
    }

    const errorMessage = error instanceof Error ? error.message : 'Failed to reorder page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
