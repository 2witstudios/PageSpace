import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, pageTreeCache } from '@pagespace/lib/server';
import { pages, drives, driveMembers, db, and, eq, inArray, desc, isNull } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, getAllowedDriveIds, isMCPAuthResult } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const requestSchema = z.object({
  pageIds: z.array(z.string()).min(1, 'At least one page ID is required'),
  targetDriveId: z.string().min(1, 'Target drive ID is required'),
  targetParentId: z.string().nullable(),
});

export async function POST(request: Request) {
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

    const { pageIds, targetDriveId, targetParentId } = parseResult.data;

    // Verify target drive exists
    const targetDrive = await db.query.drives.findFirst({
      where: eq(drives.id, targetDriveId),
    });

    if (!targetDrive) {
      return NextResponse.json({ error: 'Target drive not found' }, { status: 404 });
    }

    // Check MCP token scope for target drive
    const targetScopeError = checkMCPDriveScope(auth, targetDriveId);
    if (targetScopeError) {
      return targetScopeError;
    }

    // Check user has edit access to target drive
    const isOwner = targetDrive.ownerId === userId;
    let canEditDrive = isOwner;

    if (!isOwner) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, targetDriveId),
          eq(driveMembers.userId, userId)
        ),
      });
      canEditDrive = membership?.role === 'OWNER' || membership?.role === 'ADMIN';
    }

    if (!canEditDrive) {
      return NextResponse.json(
        { error: 'You do not have permission to move pages to this drive' },
        { status: 403 }
      );
    }

    // Verify target parent exists if specified
    if (targetParentId) {
      const targetParent = await db.query.pages.findFirst({
        where: and(
          eq(pages.id, targetParentId),
          eq(pages.driveId, targetDriveId),
          eq(pages.isTrashed, false)
        ),
      });
      if (!targetParent) {
        return NextResponse.json({ error: 'Target folder not found' }, { status: 404 });
      }
    }

    // Check user has edit access to all source pages
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
            { error: 'This token does not have access to one or more source pages' },
            { status: 403 }
          );
        }
      }
    }

    // Verify edit permissions for all pages
    for (const page of sourcePages) {
      const canEdit = await canUserEditPage(userId, page.id);
      if (!canEdit) {
        return NextResponse.json(
          { error: `You do not have permission to move page: ${page.title}` },
          { status: 403 }
        );
      }
    }

    // Validate move doesn't create circular references
    for (const pageId of pageIds) {
      if (targetParentId) {
        const validation = await validatePageMove(pageId, targetParentId);
        if (!validation.valid) {
          return NextResponse.json({ error: validation.error }, { status: 400 });
        }
      }
    }

    // Get the max position in target parent
    const lastPage = await db.query.pages.findFirst({
      where: and(
        eq(pages.driveId, targetDriveId),
        targetParentId ? eq(pages.parentId, targetParentId) : isNull(pages.parentId),
        eq(pages.isTrashed, false)
      ),
      orderBy: [desc(pages.position)],
    });

    let nextPosition = (lastPage?.position || 0) + 1;

    // Track affected drives for cache invalidation
    const affectedDriveIds = new Set<string>();
    affectedDriveIds.add(targetDriveId);

    // Move pages in transaction
    await db.transaction(async (tx) => {
      for (const page of sourcePages) {
        const sourceDriveId = page.driveId;
        affectedDriveIds.add(sourceDriveId);

        // Update page with new drive, parent, and position
        await tx.update(pages)
          .set({
            driveId: targetDriveId,
            parentId: targetParentId,
            position: nextPosition,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        // If moving to a different drive, recursively update all children's driveId
        if (page.driveId !== targetDriveId) {
          await updateChildrenDriveId(tx, page.id, targetDriveId);
        }

        nextPosition += 1;
      }
    });

    // Log activity for each moved page
    const actorInfo = await getActorInfo(userId);
    const isMCP = isMCPAuthResult(auth);
    const changeGroupId = createChangeGroupId();
    for (const page of sourcePages) {
      logPageActivity(userId, 'move', {
        id: page.id,
        title: page.title ?? undefined,
        driveId: targetDriveId,
      }, {
        ...actorInfo,
        changeGroupId,
        changeGroupType: 'user',
        updatedFields: ['driveId', 'parentId', 'position'],
        previousValues: { driveId: page.driveId, parentId: page.parentId },
        newValues: { driveId: targetDriveId, parentId: targetParentId },
        metadata: {
          bulkOperation: 'move',
          totalPages: pageIds.length,
          ...(isMCP && { source: 'mcp' }),
        },
      });
    }

    // Invalidate caches and broadcast events
    for (const driveId of affectedDriveIds) {
      pageTreeCache.invalidateDriveTree(driveId).catch(() => {});
      await broadcastPageEvent(
        createPageEventPayload(driveId, '', 'moved')
      );
    }

    return NextResponse.json({
      success: true,
      movedCount: pageIds.length,
    });
  } catch (error) {
    loggers.api.error('Error bulk moving pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to move pages' },
      { status: 500 }
    );
  }
}

// Recursively update driveId for all children
async function updateChildrenDriveId(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentId: string,
  newDriveId: string
) {
  const children = await tx.query.pages.findMany({
    where: eq(pages.parentId, parentId),
  });

  for (const child of children) {
    await tx.update(pages)
      .set({ driveId: newDriveId })
      .where(eq(pages.id, child.id));

    // Recursively update grandchildren
    await updateChildrenDriveId(tx, child.id, newDriveId);
  }
}
