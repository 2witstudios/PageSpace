import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, canPrincipalEditPage, isScopedMCPAuth } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { filterToolsForMcpScope } from '@/lib/ai/core/tool-filtering';
import { describeAgentToolSurface, formatConfigSurfaceNotes, toolSurfaceEcho } from '@/lib/ai/core/agent-tool-surface';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { pageAgentRepository, type AgentConfigUpdate } from '@/lib/repositories/page-agent-repository';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';

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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent', resourceId: 'config', details: { reason: 'auth_failed', method: 'PUT', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
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
      toolExposureMode,
      sandboxEnabled,
      defaultEnvId,
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
    const canEdit = await canPrincipalEditPage(auth, agentId);
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

    // Validate enabled tools if provided. A drive-scoped MCP token cannot
    // newly enable an account-level-only tool (e.g. create_drive) — mirrors
    // the runtime chat/consult tool-list filtering.
    if (Array.isArray(requestedEnabledTools.sanitized) && requestedEnabledTools.sanitized.length > 0) {
      const availableToolNames = Object.keys(filterToolsForMcpScope(pageSpaceTools, isScopedMCPAuth(auth)));
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
    if (toolExposureMode !== undefined) {
      if (toolExposureMode !== 'upfront' && toolExposureMode !== 'search') {
        return NextResponse.json(
          { error: 'toolExposureMode must be "upfront" or "search"' },
          { status: 400 }
        );
      }
      updateData.toolExposureMode = toolExposureMode;
      updatedFields.push('toolExposureMode');
    }
    if (sandboxEnabled !== undefined) {
      // REJECTED, not coerced (CodeRabbit): `Boolean("false")` is `true`, and
      // this is the switch that decides whether a stored sandbox allowlist is
      // granted at all — a JSON string turning the sandbox family ON is not a
      // silent conversion anyone wants. The neighbouring booleans still coerce;
      // they decide sidebar visibility and prompt assembly, not tool grants.
      if (typeof sandboxEnabled !== 'boolean') {
        return NextResponse.json(
          { error: 'sandboxEnabled must be a boolean' },
          { status: 400 }
        );
      }
      // The same field the settings tab and `update_agent_config` write, gated
      // by the same edit permission. Before issue #2460 this door could store
      // `enabledTools: ['bash', …]` and had no way to turn on the switch that
      // grants them — a config that reads as configured and means nothing.
      updateData.sandboxEnabled = sandboxEnabled;
      updatedFields.push('sandboxEnabled');
    }
    if (defaultEnvId !== undefined) {
      // Same validation the web Settings PATCH route (`/api/pages/[pageId]/
      // agent-config`) applies — reject rather than coerce, and resolve
      // through `resolveEnvInDrive` so this door cannot be used to enumerate
      // env ids across drives the caller cannot see (review — general-
      // purpose self-review, PR #2513: this MCP/API-facing route supported
      // every other agent-config field but had no way to read or write the
      // agent's default environment at all).
      if (defaultEnvId !== null && (typeof defaultEnvId !== 'string' || defaultEnvId === '')) {
        return NextResponse.json(
          { error: 'defaultEnvId must be a non-empty string or null' },
          { status: 400 }
        );
      }
      if (defaultEnvId === null) {
        updateData.defaultEnvId = null;
      } else {
        const env = await resolveEnvInDrive(defaultEnvId, agent.driveId);
        if (!env) {
          return NextResponse.json(
            { error: 'Environment not found' },
            { status: 404 }
          );
        }
        updateData.defaultEnvId = defaultEnvId;
      }
      updatedFields.push('defaultEnvId');
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

    // STORED vs EFFECTIVE, both reported (issue #2460): the allowlist above is
    // what was saved, and this is what the gates downstream of it will leave
    // the agent actually able to call.
    const toolSurface = describeAgentToolSurface({
      enabledTools: Array.isArray(updatedAgent.enabledTools) ? updatedAgent.enabledTools : null,
      sandboxEnabled: Boolean(updatedAgent.sandboxEnabled),
      toolExposureMode: updatedAgent.toolExposureMode === 'search' ? 'search' : 'upfront',
      registeredToolNames: Object.keys(filterToolsForMcpScope(pageSpaceTools, isScopedMCPAuth(auth))),
    });
    const toolSurfaceNotes = formatConfigSurfaceNotes(toolSurface);

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
        hasSystemPrompt: !!(systemPrompt || agent.systemPrompt),
        toolExposureMode: updatedAgent.toolExposureMode ?? 'upfront',
        sandboxEnabled: Boolean(updatedAgent.sandboxEnabled),
        defaultEnvId: updatedAgent.defaultEnvId ?? null,
        ...toolSurfaceEcho(toolSurface),
      },
      ...(toolSurfaceNotes.length > 0 ? { warnings: toolSurfaceNotes } : {}),
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
