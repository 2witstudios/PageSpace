import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };
import { db, pages, drives, eq, and, desc, isNull } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * POST /api/agents/create
 * Create a new AI agent with custom system prompt and tool configuration
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { driveId, parentId, title, systemPrompt, enabledTools, aiProvider, aiModel, welcomeMessage } = body;

    if (!driveId || !title || !systemPrompt) {
      return NextResponse.json(
        { error: 'driveId, title, and systemPrompt are required' },
        { status: 400 }
      );
    }

    // Get the drive directly by ID
    const [drive] = await db
      .select({ id: drives.id, ownerId: drives.ownerId })
      .from(drives)
      .where(eq(drives.id, driveId));

    if (!drive) {
      return NextResponse.json(
        { error: `Drive with ID "${driveId}" not found` },
        { status: 404 }
      );
    }

    // If parentId is provided, verify it exists and belongs to this drive
    if (parentId) {
      const [parentPage] = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(
          eq(pages.id, parentId),
          eq(pages.driveId, driveId),
          eq(pages.isTrashed, false)
        ));

      if (!parentPage) {
        return NextResponse.json(
          { error: `Parent page with ID "${parentId}" not found in this drive` },
          { status: 404 }
        );
      }
    }

    // Check permissions for agent creation
    if (parentId) {
      // Creating in a folder - check permissions on parent page
      const canEdit = await canUserEditPage(userId, parentId);
      if (!canEdit) {
        return NextResponse.json(
          { error: 'Insufficient permissions to create agents in this folder' },
          { status: 403 }
        );
      }
    } else {
      // Creating at root level - check if user owns the drive
      if (drive.ownerId !== userId) {
        return NextResponse.json(
          { error: 'Only drive owners can create agents at the root level' },
          { status: 403 }
        );
      }
    }

    // Validate enabled tools
    if (enabledTools && enabledTools.length > 0) {
      const availableToolNames = Object.keys(pageSpaceTools);
      const invalidTools = enabledTools.filter((toolName: string) => !availableToolNames.includes(toolName));
      if (invalidTools.length > 0) {
        return NextResponse.json(
          { error: `Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Get next position
    const siblingPages = await db
      .select({ position: pages.position })
      .from(pages)
      .where(and(
        eq(pages.driveId, drive.id),
        parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
        eq(pages.isTrashed, false)
      ))
      .orderBy(desc(pages.position));

    const nextPosition = siblingPages.length > 0 ? siblingPages[0].position + 1 : 1;

    // Prepare agent data
    const agentData: {
      title: string;
      type: 'AI_CHAT';
      content: string;
      position: number;
      driveId: string;
      parentId: string | null;
      isTrashed: boolean;
      systemPrompt?: string | null;
      enabledTools?: string[] | null;
      aiProvider?: string | null;
      aiModel?: string | null;
    } = {
      title,
      type: 'AI_CHAT',
      content: welcomeMessage || '',
      position: nextPosition,
      driveId: drive.id,
      parentId: parentId || null,
      isTrashed: false,
      systemPrompt,
    };

    // Add optional configuration
    if (enabledTools && enabledTools.length > 0) {
      agentData.enabledTools = enabledTools;
    }
    if (aiProvider) {
      agentData.aiProvider = aiProvider;
    }
    if (aiModel) {
      agentData.aiModel = aiModel;
    }

    // Create the agent
    const [newAgent] = await db
      .insert(pages)
      .values(agentData)
      .returning({ id: pages.id, title: pages.title, type: pages.type });

    // Broadcast agent creation event
    await broadcastPageEvent(
      createPageEventPayload(driveId, newAgent.id, 'created', {
        parentId,
        title: newAgent.title,
        type: newAgent.type
      })
    );

    loggers.api.info('AI agent created', {
      agentId: newAgent.id,
      title,
      driveId,
      parentId,
      userId
    });

    return NextResponse.json({
      success: true,
      id: newAgent.id,
      title: newAgent.title,
      type: 'AI_CHAT',
      parentId: parentId || 'root',
      message: `Successfully created AI agent "${title}" with custom configuration`,
      summary: `Created AI agent "${title}" in ${parentId ? `parent ${parentId}` : 'drive root'} with ${enabledTools?.length || 0} tools`,
      agentConfig: {
        systemPrompt: systemPrompt.substring(0, 100) + (systemPrompt.length > 100 ? '...' : ''),
        enabledToolsCount: enabledTools?.length || 0,
        enabledTools: enabledTools || [],
        aiProvider: aiProvider || 'default',
        aiModel: aiModel || 'default',
        hasWelcomeMessage: !!welcomeMessage
      },
      stats: {
        pageType: 'AI_CHAT',
        location: parentId ? `Parent ID: ${parentId}` : 'Drive root',
        configuredTools: enabledTools?.length || 0,
        hasSystemPrompt: true
      },
      nextSteps: [
        `AI agent "${title}" is ready to use`,
        `Agent has access to ${enabledTools?.length || 0} tools: ${(enabledTools || []).join(', ')}`,
        'Start a conversation to test the agent\'s behavior',
        `Agent ID: ${newAgent.id} - use this for further operations`,
        'Use read_page to view the agent\'s full configuration'
      ]
    });

  } catch (error) {
    loggers.api.error('Error creating AI agent:', error as Error);
    return NextResponse.json(
      { error: `Failed to create AI agent: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
