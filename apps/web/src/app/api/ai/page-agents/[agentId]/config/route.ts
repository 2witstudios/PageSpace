import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { pageSpaceTools } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { pageAgentRepository, type AgentConfigUpdate } from '@/lib/repositories/page-agent-repository';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';

const REMOVED_TOOL_NAMES = new Set(['import_from_github']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((toolName) => typeof toolName === 'string');
}

function parseEnabledToolsInput(value: unknown): {
  value: string[] | null | undefined;
  isValid: boolean;
} {
  if (value === undefined || value === null) {
    return { value, isValid: true };
  }

  if (isStringArray(value)) {
    return { value, isValid: true };
  }

  return { value: undefined, isValid: false };
}

function sanitizeRemovedToolNames(enabledTools: string[] | null | undefined): {
  sanitized: string[] | null | undefined;
  removed: string[];
} {
  if (!isStringArray(enabledTools)) {
    return { sanitized: enabledTools, removed: [] };
  }

  const removed = enabledTools.filter((toolName) => REMOVED_TOOL_NAMES.has(toolName));
  if (removed.length === 0) {
    return { sanitized: enabledTools, removed };
  }

  return {
    sanitized: enabledTools.filter((toolName) => !REMOVED_TOOL_NAMES.has(toolName)),
    removed,
  };
}

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
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent', resourceId: 'config', details: { reason: 'auth_failed', method: 'PUT' }, riskScore: 0.5 });
      return auth.error;
    }
    const { userId } = auth;

    const { agentId } = await context.params;
    const body = await request.json();
    const {
      systemPrompt,
      enabledTools,
      aiProvider,
      aiModel,
      agentDefinition,
      visibleToGlobalAssistant,
      expectedRevision,
    } = body;

    // Get the agent page
    const agent = await pageAgentRepository.getAgentById(agentId);

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

    // Enforce MCP token scope
    const scopeError = checkMCPDriveScope(auth, agent.driveId);
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent', resourceId: agentId, details: { reason: 'mcp_drive_scope_denied', driveId: agent.driveId, method: 'PUT' }, riskScore: 0.5 });
      return scopeError;
    }

    // Check permissions
    const canEdit = await canUserEditPage(userId, agentId);
    if (!canEdit) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent', resourceId: agentId, details: { reason: 'no_edit_permission', method: 'PUT' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Insufficient permissions to update this agent' },
        { status: 403 }
      );
    }

    const parsedEnabledTools = parseEnabledToolsInput(enabledTools);
    if (!parsedEnabledTools.isValid) {
      return NextResponse.json(
        { error: 'enabledTools must be an array of strings, null, or undefined' },
        { status: 400 }
      );
    }

    const requestedEnabledTools = sanitizeRemovedToolNames(parsedEnabledTools.value);
    const persistedEnabledTools = sanitizeRemovedToolNames(
      parseEnabledToolsInput(agent.enabledTools).value
    );

    // Validate enabled tools if provided
    if (Array.isArray(requestedEnabledTools.sanitized) && requestedEnabledTools.sanitized.length > 0) {
      const availableToolNames = Object.keys(pageSpaceTools);
      const invalidTools = requestedEnabledTools.sanitized.filter(
        (toolName: string) => !availableToolNames.includes(toolName)
      );
      if (invalidTools.length > 0) {
        return NextResponse.json(
          { error: `Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Build update object with only provided fields
    const updateData: AgentConfigUpdate = {};
    const updatedFields: string[] = [];

    if (systemPrompt !== undefined) {
      updateData.systemPrompt = systemPrompt;
      updatedFields.push('systemPrompt');
    }
    if (enabledTools !== undefined) {
      updateData.enabledTools = requestedEnabledTools.sanitized;
      updatedFields.push('enabledTools');
    } else if (persistedEnabledTools.removed.length > 0) {
      updateData.enabledTools = persistedEnabledTools.sanitized;
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

    let updatedAgent = agent;
    try {
      const actorInfo = await getActorInfo(userId);
      await applyPageMutation({
        pageId: agentId,
        operation: 'agent_config_update',
        updates: updateData as Record<string, unknown>,
        updatedFields,
        expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : undefined,
        context: {
          userId,
          actorEmail: actorInfo.actorEmail,
          actorDisplayName: actorInfo.actorDisplayName,
          resourceType: 'agent',
        },
      });
      updatedAgent = { ...agent, ...updateData };
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

    const responseEnabledTools = Array.isArray(updatedAgent.enabledTools)
      ? updatedAgent.enabledTools
      : [];

    // Broadcast agent update event
    await broadcastPageEvent(
      createPageEventPayload(updatedAgent.driveId, updatedAgent.id, 'updated', {
        parentId: agent.parentId,
        title: updatedAgent.title,
        type: updatedAgent.type
      })
    );

    loggers.api.info('AI agent configuration updated', {
      agentId: updatedAgent.id,
      title: updatedAgent.title,
      updatedFields,
      userId
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'page_agent', resourceId: agentId, details: {
      action: 'update_config',
      updatedFields,
    } });

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
        enabledToolsCount: responseEnabledTools.length,
        enabledTools: responseEnabledTools,
        aiProvider: aiProvider || agent.aiProvider || 'default',
        aiModel: aiModel || agent.aiModel || 'default',
        hasSystemPrompt: !!(systemPrompt || agent.systemPrompt)
      },
      stats: {
        pageType: 'AI_CHAT',
        updatedFields: updatedFields.length,
        configuredTools: responseEnabledTools.length,
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
