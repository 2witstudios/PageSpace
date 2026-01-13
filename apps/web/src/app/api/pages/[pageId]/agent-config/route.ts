import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage, agentAwarenessCache } from '@pagespace/lib/server';
import { db, pages, drives, eq } from '@pagespace/db';
import { pageSpaceTools } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/server';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';

const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

/**
 * GET - Get Page AI agent configuration
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { pageId } = await context.params;

    // Check if user has permission to view this page
    const canView = await canUserEditPage(userId, pageId);
    if (!canView) {
      return NextResponse.json(
        { error: 'You do not have permission to view this page configuration' },
        { status: 403 }
      );
    }

    // Get page configuration
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (!page) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }

    // Get available tools for the UI
    const availableTools = Object.keys(pageSpaceTools).map(toolName => ({
      name: toolName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      description: (pageSpaceTools as any)[toolName].description || `${toolName} tool`,
      // You could add more metadata here like categories, etc.
    }));

    // Fetch the drive's prompt for reference in UI
    let drivePrompt: string | null = null;
    try {
      const [drive] = await db
        .select({ drivePrompt: drives.drivePrompt })
        .from(drives)
        .where(eq(drives.id, page.driveId))
        .limit(1);
      drivePrompt = drive?.drivePrompt || null;
    } catch (error) {
      loggers.api.error('Error fetching drive prompt:', error as Error);
      // Continue without drive prompt on error
    }

    return NextResponse.json({
      pageId,
      systemPrompt: page.systemPrompt || '',
      enabledTools: page.enabledTools as string[] || [],
      availableTools,
      aiProvider: page.aiProvider || '',
      aiModel: page.aiModel || '',
      includeDrivePrompt: page.includeDrivePrompt ?? false,
      drivePrompt,
      agentDefinition: page.agentDefinition || '',
      visibleToGlobalAssistant: page.visibleToGlobalAssistant ?? true,
      includePageTree: page.includePageTree ?? false,
      pageTreeScope: page.pageTreeScope ?? 'children',
    });
  } catch (error) {
    loggers.api.error('Error fetching page agent configuration:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch agent configuration' },
      { status: 500 }
    );
  }
}

/**
 * PATCH - Update Page AI agent configuration
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { pageId } = await context.params;
    const body = await request.json();
    const {
      systemPrompt,
      enabledTools,
      aiProvider,
      aiModel,
      includeDrivePrompt,
      agentDefinition,
      visibleToGlobalAssistant,
      includePageTree,
      pageTreeScope,
      expectedRevision,
    } = body;

    // Check if user has permission to edit this page
    const canEdit = await canUserEditPage(userId, pageId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'You do not have permission to edit this page configuration' },
        { status: 403 }
      );
    }

    // Validate the page exists
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (!page) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }

    // Validate enabled tools (ensure they exist in available tools)
    if (enabledTools && Array.isArray(enabledTools)) {
      const availableToolNames = Object.keys(pageSpaceTools);
      const invalidTools = enabledTools.filter(tool => !availableToolNames.includes(tool));
      if (invalidTools.length > 0) {
        return NextResponse.json(
          { error: `Invalid tools: ${invalidTools.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Update page configuration
    const updateData: Partial<typeof page> = {};
    
    if (systemPrompt !== undefined) {
      updateData.systemPrompt = systemPrompt.trim() || null;
    }
    
    if (enabledTools !== undefined) {
      // Preserve empty arrays - don't convert to null
      updateData.enabledTools = Array.isArray(enabledTools) ? enabledTools : null;
    }
    
    if (aiProvider !== undefined) {
      updateData.aiProvider = aiProvider.trim() || null;
    }
    
    if (aiModel !== undefined) {
      updateData.aiModel = aiModel.trim() || null;
    }

    if (includeDrivePrompt !== undefined) {
      updateData.includeDrivePrompt = Boolean(includeDrivePrompt);
    }

    if (agentDefinition !== undefined) {
      updateData.agentDefinition = agentDefinition.trim() || null;
    }

    if (visibleToGlobalAssistant !== undefined) {
      updateData.visibleToGlobalAssistant = Boolean(visibleToGlobalAssistant);
    }

    if (includePageTree !== undefined) {
      updateData.includePageTree = Boolean(includePageTree);
    }

    if (pageTreeScope !== undefined) {
      // Validate scope value
      if (pageTreeScope === 'children' || pageTreeScope === 'drive') {
        updateData.pageTreeScope = pageTreeScope;
      }
    }

    // Only update if there are changes
    let responsePage = page;
    if (Object.keys(updateData).length > 0) {
      try {
        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'agent_config_update',
          updates: updateData,
          updatedFields: Object.keys(updateData),
          expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName,
            resourceType: 'agent',
          },
        });
      } catch (error) {
        if (error instanceof PageRevisionMismatchError) {
          return NextResponse.json(
            {
              error: error.message,
              currentRevision: error.currentRevision,
              expectedRevision: error.expectedRevision,
            },
            { status: error.expectedRevision === undefined ? 428 : 409 }
          );
        }
        throw error;
      }

      const [updatedPage] = await db
        .select()
        .from(pages)
        .where(eq(pages.id, pageId))
        .limit(1);
      if (updatedPage) {
        responsePage = updatedPage;
      }

      // Invalidate agent awareness cache if this is an AI_CHAT page and
      // visibility or definition changed
      if (page.type === 'AI_CHAT' &&
          (agentDefinition !== undefined || visibleToGlobalAssistant !== undefined)) {
        await agentAwarenessCache.invalidateDriveAgents(page.driveId);
      }

      loggers.api.info('Page agent configuration updated', {
        pageId,
        userId,
        updatedFields: Object.keys(updateData),
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Agent configuration updated successfully',
      systemPrompt: responsePage.systemPrompt || '',
      enabledTools: responsePage.enabledTools as string[] || [],
      aiProvider: responsePage.aiProvider || '',
      aiModel: responsePage.aiModel || '',
      includeDrivePrompt: responsePage.includeDrivePrompt ?? false,
      agentDefinition: responsePage.agentDefinition || '',
      visibleToGlobalAssistant: responsePage.visibleToGlobalAssistant ?? true,
      includePageTree: responsePage.includePageTree ?? false,
      pageTreeScope: responsePage.pageTreeScope ?? 'children',
    });
  } catch (error) {
    loggers.api.error('Error updating page agent configuration:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update agent configuration' },
      { status: 500 }
    );
  }
}

/**
 * PUT - Update Page AI agent configuration (alias for PATCH)
 */
export { PATCH as PUT };
