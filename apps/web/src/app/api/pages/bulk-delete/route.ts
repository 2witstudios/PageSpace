import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, pageTreeCache, agentAwarenessCache } from '@pagespace/lib/server';
import { pages, db, eq, inArray } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserDeletePage } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const requestSchema = z.object({
  pageIds: z.array(z.string()).min(1, 'At least one page ID is required'),
  trashChildren: z.boolean().default(true),
});

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await request.json();

    const parseResult = requestSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const { pageIds, trashChildren } = parseResult.data;

    // Fetch source pages
    const sourcePages = await db.query.pages.findMany({
      where: inArray(pages.id, pageIds),
    });

    if (sourcePages.length !== pageIds.length) {
      return NextResponse.json({ error: 'Some pages not found' }, { status: 404 });
    }

    // Verify delete permissions for all pages
    for (const page of sourcePages) {
      const canDelete = await canUserDeletePage(userId, page.id);
      if (!canDelete) {
        return NextResponse.json(
          { error: `You do not have permission to delete page: ${page.title}` },
          { status: 403 }
        );
      }
    }

    // Track affected drives for cache invalidation
    const affectedDriveIds = new Set<string>();
    let hasAIChatPages = sourcePages.some(p => p.type === 'AI_CHAT');

    // Trash pages in transaction
    await db.transaction(async (tx) => {
      const now = new Date();

      for (const page of sourcePages) {
        affectedDriveIds.add(page.driveId);

        // Trash the page
        await tx.update(pages)
          .set({
            isTrashed: true,
            trashedAt: now,
            updatedAt: now,
          })
          .where(eq(pages.id, page.id));

        // Recursively trash children if requested
        if (trashChildren) {
          const trashedAIChat = await trashChildrenRecursively(tx, page.id, now);
          if (trashedAIChat) {
            hasAIChatPages = true;
          }
        } else {
          // Move children to parent's parent
          await tx.update(pages)
            .set({
              parentId: page.parentId,
              updatedAt: now,
            })
            .where(eq(pages.parentId, page.id));
        }
      }
    });

    // Invalidate caches and broadcast events
    for (const driveId of affectedDriveIds) {
      await pageTreeCache.invalidateDriveTree(driveId);

      if (hasAIChatPages) {
        await agentAwarenessCache.invalidateDriveAgents(driveId);
      }

      await broadcastPageEvent(
        createPageEventPayload(driveId, '', 'trashed')
      );
    }

    return NextResponse.json({
      success: true,
      trashedCount: pageIds.length,
    });
  } catch (error) {
    loggers.api.error('Error bulk deleting pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete pages' },
      { status: 500 }
    );
  }
}

// Recursively trash children and return whether any AI_CHAT pages were trashed
async function trashChildrenRecursively(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentId: string,
  trashedAt: Date
): Promise<boolean> {
  const children = await tx.query.pages.findMany({
    where: eq(pages.parentId, parentId),
  });

  let hasAIChatChild = false;

  for (const child of children) {
    if (child.type === 'AI_CHAT') {
      hasAIChatChild = true;
    }

    await tx.update(pages)
      .set({
        isTrashed: true,
        trashedAt: trashedAt,
        updatedAt: trashedAt,
      })
      .where(eq(pages.id, child.id));

    // Recursively trash grandchildren
    const grandchildHasAIChat = await trashChildrenRecursively(tx, child.id, trashedAt);
    if (grandchildHasAIChat) {
      hasAIChatChild = true;
    }
  }

  return hasAIChatChild;
}
