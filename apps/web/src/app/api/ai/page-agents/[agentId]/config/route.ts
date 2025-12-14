import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };
import { db, pages, eq } from '@pagespace/db';
import { canUserEditPage, agentAwarenessCache } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { pageSpaceTools } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/server';

/**
 * PUT /api/ai/page-agents/{agentId}/config
 * Update the configuration of an existing AI agent
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { agentId } = await context.params;
    const body = await request.json();
    const { systemPrompt, enabledTools, aiProvider, aiModel, agentDefinition, visibleToGlobalAssistant } = body;

    // Get the agent page
    const [agent] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, agentId));

    if (!agent) {
      return NextResponse.json(
        { error: `Agent with ID "${agentId}" not found` },
        { status: 404 }
      );
    }

    // Verify it's an AI_CHAT page
    if (agent.type !== 'AI_CHAT') {
      return NextResponse.json(
        { error: `Page "${agentId}" is not an AI agent` },
        { status: 400 }
      );
    }

    // Check permissions
    const canEdit = await canUserEditPage(userId, agentId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Insufficient permissions to update this agent' },
        { status: 403 }
      );
    }

    // Validate enabled tools if provided
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

    // Build update object with only provided fields
    const updateData: {
      systemPrompt?: string | null;
      enabledTools?: string[] | null;
      aiProvider?: string | null;
      aiModel?: string | null;
      agentDefinition?: string | null;
      visibleToGlobalAssistant?: boolean;
    } = {};
    const updatedFields: string[] = [];

    if (systemPrompt !== undefined) {
      updateData.systemPrompt = systemPrompt;
      updatedFields.push('systemPrompt');
    }
    if (enabledTools !== undefined) {
      updateData.enabledTools = enabledTools;
      updatedFields.push('enabledTools');
    }
    if (aiProvider !== undefined) {
      updateData.aiProvider = aiProvider;
      updatedFields.push('aiProvider');
    }
    if (aiModel !== undefined) {
      updateData.aiModel = aiModel;
      updatedFields.push('aiModel');
    }
    if (agentDefinition !== undefined) {
      updateData.agentDefinition = agentDefinition?.trim() || null;
      updatedFields.push('agentDefinition');
    }
    if (visibleToGlobalAssistant !== undefined) {
      updateData.visibleToGlobalAssistant = Boolean(visibleToGlobalAssistant);
      updatedFields.push('visibleToGlobalAssistant');
    }

    if (updatedFields.length === 0) {
      return NextResponse.json(
        { error: 'No valid fields provided for update' },
        { status: 400 }
      );
    }

    // Update the agent
    const [updatedAgent] = await db
      .update(pages)
      .set(updateData)
      .where(eq(pages.id, agentId))
      .returning({ id: pages.id, title: pages.title, type: pages.type, driveId: pages.driveId });

    // Broadcast agent update event
    await broadcastPageEvent(
      createPageEventPayload(updatedAgent.driveId, updatedAgent.id, 'updated', {
        parentId: agent.parentId,
        title: updatedAgent.title,
        type: updatedAgent.type
      })
    );

    // Invalidate agent awareness cache if visibility or definition changed
    if (updatedFields.includes('agentDefinition') || updatedFields.includes('visibleToGlobalAssistant')) {
      await agentAwarenessCache.invalidateDriveAgents(updatedAgent.driveId);
    }

    loggers.api.info('AI agent configuration updated', {
      agentId: updatedAgent.id,
      title: updatedAgent.title,
      updatedFields,
      userId
    });

    return NextResponse.json({
      success: true,
      id: updatedAgent.id,
      title: updatedAgent.title,
      type: 'AI_CHAT',
      message: `Successfully updated AI agent configuration`,
      summary: `Updated ${updatedFields.length} configuration field(s): ${updatedFields.join(', ')}`,
      updatedFields,
      agentConfig: {
        systemPrompt: systemPrompt ? (systemPrompt.substring(0, 100) + (systemPrompt.length > 100 ? '...' : '')) : undefined,
        enabledToolsCount: enabledTools?.length || (Array.isArray(agent.enabledTools) ? agent.enabledTools.length : 0),
        enabledTools: enabledTools || (Array.isArray(agent.enabledTools) ? agent.enabledTools : []),
        aiProvider: aiProvider || agent.aiProvider || 'default',
        aiModel: aiModel || agent.aiModel || 'default',
        hasSystemPrompt: !!(systemPrompt || agent.systemPrompt)
      },
      stats: {
        pageType: 'AI_CHAT',
        updatedFields: updatedFields.length,
        configuredTools: enabledTools?.length || (Array.isArray(agent.enabledTools) ? agent.enabledTools.length : 0),
        hasSystemPrompt: !!(systemPrompt || agent.systemPrompt)
      },
      nextSteps: [
        'Test the agent to ensure the new configuration works as expected',
        'The changes will take effect immediately in new conversations',
        `Updated fields: ${updatedFields.join(', ')}`,
        `Agent ID: ${updatedAgent.id} - use this for further operations`,
        'Use read_page to view the agent\'s full configuration'
      ]
    });

  } catch (error) {
    loggers.api.error('Error updating AI agent configuration:', error as Error);
    return NextResponse.json(
      { error: `Failed to update AI agent configuration: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
