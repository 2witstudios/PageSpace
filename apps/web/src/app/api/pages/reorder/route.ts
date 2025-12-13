import { NextResponse } from 'next/server';
import { pages, drives, driveMembers, db, and, eq } from '@pagespace/db';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, pageTreeCache } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

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

    // Validate parent change to prevent circular references
    const validation = await validatePageMove(pageId, newParentId);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    let driveId: string | null = null;
    let pageTitle: string | null = null;

    await db.transaction(async (tx) => {
      // First, get the page and its drive
      const [pageInfo] = await tx
        .select({
          driveId: pages.driveId,
          title: pages.title,
          ownerId: drives.ownerId,
        })
        .from(pages)
        .leftJoin(drives, eq(pages.driveId, drives.id))
        .where(eq(pages.id, pageId))
        .limit(1);

      if (!pageInfo) {
        throw new Error('Page not found.');
      }

      driveId = pageInfo.driveId;
      pageTitle = pageInfo.title;

      // Check if user is owner or admin
      const isOwner = pageInfo.ownerId === auth.userId;
      let isAdmin = false;

      if (!isOwner) {
        const adminMembership = await tx.select()
          .from(driveMembers)
          .where(and(
            eq(driveMembers.driveId, driveId),
            eq(driveMembers.userId, auth.userId),
            eq(driveMembers.role, 'ADMIN')
          ))
          .limit(1);

        isAdmin = adminMembership.length > 0;
      }

      if (!isOwner && !isAdmin) {
        throw new Error('Only drive owners and admins can reorder pages.');
      }

      if (newParentId) {
        const [parentPage] = await tx
          .select({ driveId: pages.driveId })
          .from(pages)
          .where(eq(pages.id, newParentId))
          .limit(1);

        if (!parentPage) {
          throw new Error('Parent page not found.');
        }

        if (parentPage.driveId !== driveId) {
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

      // Invalidate page tree cache when structure changes
      await pageTreeCache.invalidateDriveTree(driveId);
    }

    return NextResponse.json({ message: 'Page reordered successfully' });
  } catch (error) {
    loggers.api.error('Error reordering page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to reorder page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
