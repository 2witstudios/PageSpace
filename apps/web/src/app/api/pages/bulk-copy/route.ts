import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, pageTreeCache } from '@pagespace/lib/server';
import { pages, drives, driveMembers, db, and, eq, inArray, desc, isNull } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, getAllowedDriveIds, isMCPAuthResult } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring';

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
    const copiedPages: Array<{ newId: string; sourceTitle: string | null; sourceId: string }> = [];

    // Copy pages in transaction
    await db.transaction(async (tx) => {
      for (const page of sourcePages) {
        const newPageId = createId();
        copiedPages.push({ newId: newPageId, sourceTitle: page.title, sourceId: page.id });

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
          // AI chat settings
          includeDrivePrompt: page.includeDrivePrompt,
          agentDefinition: page.agentDefinition,
          visibleToGlobalAssistant: page.visibleToGlobalAssistant,
          includePageTree: page.includePageTree,
          pageTreeScope: page.pageTreeScope,
          // File-specific fields
          fileSize: page.fileSize,
          mimeType: page.mimeType,
          originalFileName: page.originalFileName,
          filePath: page.filePath,
          fileMetadata: page.fileMetadata,
          // Processing status fields - reset so copies are reprocessed independently
          processingStatus: page.type === 'FILE' ? 'pending' : null,
          processingError: null,
          processedAt: null,
          extractionMethod: page.extractionMethod,
          extractionMetadata: page.extractionMetadata,
          contentHash: page.contentHash,
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

    // Log activity for each copied page
    const actorInfo = await getActorInfo(userId);
    const isMCP = isMCPAuthResult(auth);
    const changeGroupId = createChangeGroupId();
    for (const copied of copiedPages) {
      logPageActivity(userId, 'create', {
        id: copied.newId,
        title: copied.sourceTitle ? `${copied.sourceTitle} (Copy)` : 'Untitled (Copy)',
        driveId: targetDriveId,
      }, {
        ...actorInfo,
        changeGroupId,
        changeGroupType: 'user',
        metadata: {
          bulkOperation: 'copy',
          sourcePageId: copied.sourceId,
          totalPages: copiedPages.length,
          includeChildren,
          ...(isMCP && { source: 'mcp' }),
        },
      });
    }

    // Invalidate cache and broadcast event
    pageTreeCache.invalidateDriveTree(targetDriveId).catch(() => {});
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
      // AI chat settings
      includeDrivePrompt: child.includeDrivePrompt,
      agentDefinition: child.agentDefinition,
      visibleToGlobalAssistant: child.visibleToGlobalAssistant,
      includePageTree: child.includePageTree,
      pageTreeScope: child.pageTreeScope,
      // File-specific fields
      fileSize: child.fileSize,
      mimeType: child.mimeType,
      originalFileName: child.originalFileName,
      filePath: child.filePath,
      fileMetadata: child.fileMetadata,
      // Processing status fields - reset so copies are reprocessed independently
      processingStatus: child.type === 'FILE' ? 'pending' : null,
      processingError: null,
      processedAt: null,
      extractionMethod: child.extractionMethod,
      extractionMetadata: child.extractionMetadata,
      contentHash: child.contentHash,
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
