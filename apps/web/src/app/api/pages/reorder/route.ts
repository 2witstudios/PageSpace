import { NextResponse } from 'next/server';
import { pages, drives, db, and, eq } from '@pagespace/db';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

const reorderSchema = z.object({
  pageId: z.string(),
  newParentId: z.string().nullable(),
  newPosition: z.number(),
});

export async function PATCH(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const body = await request.json();
    const { pageId, newParentId, newPosition } = reorderSchema.parse(body);

    let driveId: string | null = null;
    let pageTitle: string | null = null;

    await db.transaction(async (tx) => {
      const [pageToMove] = await tx
        .select({
          driveId: pages.driveId,
          title: pages.title,
        })
        .from(pages)
        .leftJoin(drives, eq(pages.driveId, drives.id))
        .where(and(eq(pages.id, pageId), eq(drives.ownerId, auth.userId)))
        .limit(1);

      if (!pageToMove) {
        throw new Error('Page not found or user does not have access.');
      }

      driveId = pageToMove.driveId;
      pageTitle = pageToMove.title;

      if (newParentId) {
        const [parentPage] = await tx
          .select({ driveId: pages.driveId })
          .from(pages)
          .leftJoin(drives, eq(pages.driveId, drives.id))
          .where(and(eq(pages.id, newParentId), eq(drives.ownerId, auth.userId)))
          .limit(1);

        if (!parentPage) {
          throw new Error('Parent page not found or user does not have access.');
        }

        if (parentPage.driveId !== pageToMove.driveId) {
          throw new Error('Cannot move pages between different drives.');
        }
      }

      await tx
        .update(pages)
        .set({
          parentId: newParentId,
          position: newPosition,
        })
        .where(eq(pages.id, pageId));
    });

    if (driveId) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageId, 'moved', {
          parentId: newParentId,
          title: pageTitle || undefined,
        }),
      );
    }

    return NextResponse.json({ message: 'Page reordered successfully' });
  } catch (error) {
    loggers.api.error('Error reordering page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to reorder page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
