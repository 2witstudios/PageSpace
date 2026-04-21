import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { pages, db, eq, inArray } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, getAllowedDriveIds, isMCPAuthResult } from '@/lib/auth';
import { canUserDeletePage } from '@pagespace/lib/server';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring';

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

    // Check MCP token scope for all source pages
    const allowedDriveIds = getAllowedDriveIds(auth);
    if (allowedDriveIds.length > 0) {
      const allowedSet = new Set(allowedDriveIds);
      for (const page of sourcePages) {
        if (!allowedSet.has(page.driveId)) {
          return NextResponse.json(
            { error: 'This token does not have access to one or more pages' },
            { status: 403 }
          );
        }
      }
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

    // Track affected drives for broadcast events
    const affectedDriveIds = new Set<string>();

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
          await trashChildrenRecursively(tx, page.id, now);
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

    // Log activity for each trashed page
    const actorInfo = await getActorInfo(userId);
    const isMCP = isMCPAuthResult(auth);
    const changeGroupId = createChangeGroupId();
    for (const page of sourcePages) {
      logPageActivity(userId, 'trash', {
        id: page.id,
        title: page.title ?? undefined,
        driveId: page.driveId,
      }, {
        ...actorInfo,
        changeGroupId,
        changeGroupType: 'user',
        updatedFields: ['isTrashed', 'trashedAt'],
        previousValues: { isTrashed: false },
        newValues: { isTrashed: true },
        metadata: {
          bulkOperation: 'delete',
          trashChildren,
          totalPages: pageIds.length,
          ...(isMCP && { source: 'mcp' }),
        },
      });
    }

    // Broadcast events
    for (const driveId of affectedDriveIds) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, '', 'trashed')
      );
    }

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'page', resourceId: 'bulk', details: { count: pageIds.length } });

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

async function trashChildrenRecursively(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentId: string,
  trashedAt: Date
): Promise<void> {
  const children = await tx.query.pages.findMany({
    where: eq(pages.parentId, parentId),
  });

  for (const child of children) {
    await tx.update(pages)
      .set({
        isTrashed: true,
        trashedAt: trashedAt,
        updatedAt: trashedAt,
      })
      .where(eq(pages.id, child.id));

    await trashChildrenRecursively(tx, child.id, trashedAt);
  }
}
