import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, pageTreeCache } from '@pagespace/lib/server';
import { pages, drives, driveMembers, db, and, eq, inArray, desc, isNull } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const requestSchema = z.object({
  pageIds: z.array(z.string()).min(1, 'At least one page ID is required'),
  targetDriveId: z.string().min(1, 'Target drive ID is required'),
  targetParentId: z.string().nullable(),
  includeChildren: z.boolean().default(true),
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

    const { pageIds, targetDriveId, targetParentId, includeChildren } = parseResult.data;

    // Verify target drive exists
    const targetDrive = await db.query.drives.findFirst({
      where: eq(drives.id, targetDriveId),
    });

    if (!targetDrive) {
      return NextResponse.json({ error: 'Target drive not found' }, { status: 404 });
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
        { error: 'You do not have permission to copy pages to this drive' },
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

    // Fetch source pages
    const sourcePages = await db.query.pages.findMany({
      where: inArray(pages.id, pageIds),
    });

    if (sourcePages.length !== pageIds.length) {
      return NextResponse.json({ error: 'Some pages not found' }, { status: 404 });
    }

    // Verify view permissions for all pages
    for (const page of sourcePages) {
      const canView = await canUserViewPage(userId, page.id);
      if (!canView) {
        return NextResponse.json(
          { error: `You do not have permission to copy page: ${page.title}` },
          { status: 403 }
        );
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
    let copiedCount = 0;

    // Copy pages in transaction
    await db.transaction(async (tx) => {
      for (const page of sourcePages) {
        const newPageId = createId();

        // Copy the page
        await tx.insert(pages).values({
          id: newPageId,
          title: page.title ? `${page.title} (Copy)` : 'Untitled (Copy)',
          type: page.type,
          content: page.content,
          driveId: targetDriveId,
          parentId: targetParentId,
          position: nextPosition,
          createdAt: new Date(),
          updatedAt: new Date(),
          revision: 0,
          stateHash: null,
          isTrashed: false,
          aiProvider: page.aiProvider,
          aiModel: page.aiModel,
          systemPrompt: page.systemPrompt,
          enabledTools: page.enabledTools,
          isPaginated: page.isPaginated,
        });

        copiedCount += 1;
        nextPosition += 1;

        // Recursively copy children if requested
        if (includeChildren) {
          const childCount = await copyChildrenRecursively(
            tx,
            page.id,
            newPageId,
            targetDriveId
          );
          copiedCount += childCount;
        }
      }
    });

    // Invalidate cache and broadcast event
    await pageTreeCache.invalidateDriveTree(targetDriveId);
    await broadcastPageEvent(
      createPageEventPayload(targetDriveId, '', 'created')
    );

    return NextResponse.json({
      success: true,
      copiedCount,
    });
  } catch (error) {
    loggers.api.error('Error bulk copying pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to copy pages' },
      { status: 500 }
    );
  }
}

// Recursively copy children
async function copyChildrenRecursively(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sourceParentId: string,
  newParentId: string,
  targetDriveId: string
): Promise<number> {
  const children = await tx.query.pages.findMany({
    where: and(
      eq(pages.parentId, sourceParentId),
      eq(pages.isTrashed, false)
    ),
  });

  let copiedCount = 0;

  for (const child of children) {
    const newChildId = createId();

    await tx.insert(pages).values({
      id: newChildId,
      title: child.title,
      type: child.type,
      content: child.content,
      driveId: targetDriveId,
      parentId: newParentId,
      position: child.position,
      createdAt: new Date(),
      updatedAt: new Date(),
      revision: 0,
      stateHash: null,
      isTrashed: false,
      aiProvider: child.aiProvider,
      aiModel: child.aiModel,
      systemPrompt: child.systemPrompt,
      enabledTools: child.enabledTools,
      isPaginated: child.isPaginated,
    });

    copiedCount += 1;

    // Recursively copy grandchildren
    const grandchildCount = await copyChildrenRecursively(
      tx,
      child.id,
      newChildId,
      targetDriveId
    );
    copiedCount += grandchildCount;
  }

  return copiedCount;
}
