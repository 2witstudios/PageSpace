import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };
import { canUserEditPage, agentAwarenessCache } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { pageSpaceTools } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/server';
import { pageAgentRepository, type AgentData } from '@/lib/repositories/page-agent-repository';

/**
 * POST /api/ai/page-agents/create
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
    const drive = await pageAgentRepository.getDriveById(driveId);

    if (!drive) {
      return NextResponse.json(
        { error: `Drive with ID "${driveId}" not found` },
        { status: 404 }
      );
    }

    // Enforce MCP token scope
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    // If parentId is provided, verify it exists and belongs to this drive
    if (parentId) {
      const parentPage = await pageAgentRepository.getParentPage(parentId, driveId);

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
    const nextPosition = await pageAgentRepository.getNextPosition(drive.id, parentId || null);

    // Prepare agent data with default PageSpace provider and standard model
    const agentData: AgentData = {
      title,
      type: 'AI_CHAT',
      content: welcomeMessage || '',
      position: nextPosition,
      driveId: drive.id,
      parentId: parentId || null,
      isTrashed: false,
      systemPrompt,
      // Default to PageSpace provider with "standard" model
      // Agents can use 'standard' or 'pro' as friendly aliases
      aiProvider: aiProvider || 'pagespace',
      aiModel: aiModel || 'standard',
    };

    // Add optional configuration (save even if empty array)
    if (enabledTools !== undefined) {
      agentData.enabledTools = enabledTools;
    }

    // Create the agent
    const newAgent = await pageAgentRepository.createAgent(agentData);

    // Broadcast agent creation event
    await broadcastPageEvent(
      createPageEventPayload(driveId, newAgent.id, 'created', {
        parentId,
        title: newAgent.title,
        type: newAgent.type
      })
    );

    // Invalidate agent awareness cache for this drive
    await agentAwarenessCache.invalidateDriveAgents(driveId);

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
        aiProvider: agentData.aiProvider,
        aiModel: agentData.aiModel,
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
      { error: 'Failed to create AI agent' },
      { status: 500 }
    );
  }
}
