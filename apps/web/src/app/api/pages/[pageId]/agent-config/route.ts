import { NextResponse } from 'next/server';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { db, pages, eq } from '@pagespace/db';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * GET - Get Page AI agent configuration
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  try {
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

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

    return NextResponse.json({
      pageId,
      systemPrompt: page.systemPrompt || '',
      enabledTools: page.enabledTools as string[] || [],
      availableTools,
      aiProvider: page.aiProvider || '',
      aiModel: page.aiModel || '',
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
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { pageId } = await context.params;
    const body = await request.json();
    const { systemPrompt, enabledTools, aiProvider, aiModel } = body;

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
      updateData.enabledTools = Array.isArray(enabledTools) && enabledTools.length > 0 
        ? enabledTools 
        : null;
    }
    
    if (aiProvider !== undefined) {
      updateData.aiProvider = aiProvider.trim() || null;
    }
    
    if (aiModel !== undefined) {
      updateData.aiModel = aiModel.trim() || null;
    }

    // Only update if there are changes
    if (Object.keys(updateData).length > 0) {
      await db
        .update(pages)
        .set({
          ...updateData,
          updatedAt: new Date(),
        })
        .where(eq(pages.id, pageId));

      loggers.api.info('Page agent configuration updated', {
        pageId,
        userId,
        updatedFields: Object.keys(updateData),
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Agent configuration updated successfully',
      systemPrompt: updateData.systemPrompt,
      enabledTools: updateData.enabledTools,
      aiProvider: updateData.aiProvider,
      aiModel: updateData.aiModel,
    });
  } catch (error) {
    loggers.api.error('Error updating page agent configuration:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update agent configuration' },
      { status: 500 }
    );
  }
}