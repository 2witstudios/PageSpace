import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };
import { db, pages } from '@pagespace/db';
import { canUserEditPage, getUserDriveAccess } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket/socket-utils';
import { loggers } from '@pagespace/lib/server';

/**
 * POST /api/pages/bulk/create-structure
 * Create a complex folder structure with multiple nested folders and documents
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { driveId, parentId, structure } = body;

    if (!driveId) {
      return NextResponse.json(
        { error: 'driveId is required' },
        { status: 400 }
      );
    }

    if (!structure || !Array.isArray(structure) || structure.length === 0) {
      return NextResponse.json(
        { error: 'structure array is required and must not be empty' },
        { status: 400 }
      );
    }

    // Validate structure items
    for (const item of structure) {
      if (!item.title || !item.type) {
        return NextResponse.json(
          { error: 'Each structure item must have title and type fields' },
          { status: 400 }
        );
      }
      if (!['FOLDER', 'DOCUMENT', 'AI_CHAT', 'CHANNEL', 'CANVAS', 'SHEET'].includes(item.type)) {
        return NextResponse.json(
          { error: 'Invalid type. Must be one of: FOLDER, DOCUMENT, AI_CHAT, CHANNEL, CANVAS, SHEET' },
          { status: 400 }
        );
      }
    }

    // Verify drive access
    const hasDriveAccess = await getUserDriveAccess(userId, driveId);
    if (!hasDriveAccess) {
      return NextResponse.json(
        { error: 'You don\'t have access to this drive' },
        { status: 403 }
      );
    }

    // Check parent permissions if specified
    if (parentId) {
      const canEdit = await canUserEditPage(userId, parentId);
      if (!canEdit) {
        return NextResponse.json(
          { error: 'No permission to create structure in target location' },
          { status: 403 }
        );
      }
    }

    const createdPages: Array<{ id: string; title: string; type: string; parentId: string | null; path: string }> = [];

    // Recursive function to create structure
    const createStructureRecursive = async (
      items: typeof structure,
      currentParentId: string | null,
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
    ) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Create the page
        const [newPage] = await tx
          .insert(pages)
          .values({
            title: item.title,
            type: item.type as 'FOLDER' | 'DOCUMENT' | 'AI_CHAT' | 'CHANNEL' | 'CANVAS' | 'SHEET',
            content: item.content || '',
            driveId,
            parentId: currentParentId,
            position: i + 1,
            isTrashed: false,
          })
          .returning();

        createdPages.push({
          id: newPage.id,
          title: newPage.title,
          type: newPage.type,
          parentId: currentParentId,
          path: currentParentId ? `${currentParentId}/${newPage.title}` : newPage.title,
        });

        // Create children if any
        if (item.children && item.children.length > 0) {
          await createStructureRecursive(item.children, newPage.id, tx);
        }
      }
    };

    // Execute in transaction
    await db.transaction(async (tx) => {
      await createStructureRecursive(structure, parentId || null, tx);
    });

    // Broadcast creation events
    for (const page of createdPages) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, page.id, 'created', {
          parentId: page.parentId,
          title: page.title,
          type: page.type,
        })
      );
    }

    // Build statistics
    const stats = {
      totalCreated: createdPages.length,
      byType: {} as Record<string, number>,
      maxDepth: 0,
    };

    for (const page of createdPages) {
      stats.byType[page.type] = (stats.byType[page.type] || 0) + 1;
      const depth = page.path.split('/').length;
      stats.maxDepth = Math.max(stats.maxDepth, depth);
    }

    loggers.api.info('Create folder structure completed', {
      driveId,
      parentId,
      structureItemCount: structure.length,
      totalCreated: createdPages.length,
      userId
    });

    return NextResponse.json({
      success: true,
      createdPages: createdPages.map(p => ({
        id: p.id,
        title: p.title,
        type: p.type,
        semanticPath: p.path,
      })),
      summary: `Created ${createdPages.length} page${createdPages.length === 1 ? '' : 's'} in hierarchical structure`,
      stats,
      rootPages: createdPages.filter(p => p.parentId === parentId).map(p => ({
        id: p.id,
        title: p.title,
        type: p.type,
      })),
      nextSteps: [
        'Use list_pages to explore the created structure',
        'Add content to the created documents',
        'Continue building on the structure as needed',
      ]
    });

  } catch (error) {
    loggers.api.error('Error creating folder structure:', error as Error);
    return NextResponse.json(
      { error: `Failed to create folder structure: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
