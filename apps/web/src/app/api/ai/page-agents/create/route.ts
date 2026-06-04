import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { pageSpaceTools, DEFAULT_PROVIDER, DEFAULT_MODEL, ONPREM_ALLOWED_PROVIDERS, isValidModel } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { pageAgentRepository, type AgentData } from '@/lib/repositories/page-agent-repository';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';

/**
 * POST /api/ai/page-agents/create
 * Create a new AI agent with custom system prompt and tool configuration
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent', resourceId: 'create', details: { reason: 'auth_failed', method: 'POST' }, riskScore: 0.5 });
      return auth.error;
    }
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
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent', resourceId: 'create', details: { reason: 'mcp_drive_scope_denied', driveId, method: 'POST' }, riskScore: 0.5 });
      return scopeError;
    }

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
        auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent', resourceId: 'create', details: { reason: 'no_edit_permission_on_parent', parentId, driveId, method: 'POST' }, riskScore: 0.5 });
        return NextResponse.json(
          { error: 'Insufficient permissions to create agents in this folder' },
          { status: 403 }
        );
      }
    } else {
      // Creating at root level - check if user owns the drive
      if (drive.ownerId !== userId) {
        auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent', resourceId: 'create', details: { reason: 'not_drive_owner', driveId, method: 'POST' }, riskScore: 0.5 });
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

    // Resolve the agent's (provider, model) as one atomic pair — never mix a caller
    // provider with the default model. A partial body (only one field) falls back to
    // the product default pair rather than synthesizing an impossible combination.
    let agentProvider: string;
    let agentModel: string;
    if (aiProvider && aiModel) {
      agentProvider = aiProvider;
      agentModel = aiModel;
    } else {
      agentProvider = DEFAULT_PROVIDER;
      agentModel = DEFAULT_MODEL;
    }

    // Reject an explicit, off-catalog cloud pair at this write boundary (like the
    // settings PATCH) so a broken selection is surfaced now, not as a 400 on first
    // use. Local/on-prem providers serve runtime-discovered models, so only their
    // provider name is gated, not the model id.
    if (!ONPREM_ALLOWED_PROVIDERS.has(agentProvider) && !isValidModel(agentProvider, agentModel)) {
      return NextResponse.json(
        { error: `Invalid AI model selection: ${agentProvider} / ${agentModel}` },
        { status: 400 }
      );
    }

    // Get next position
    const nextPosition = await pageAgentRepository.getNextPosition(drive.id, parentId || null);

    const agentData: AgentData = {
      title,
      type: 'AI_CHAT',
      content: welcomeMessage || '',
      position: nextPosition,
      driveId: drive.id,
      parentId: parentId || null,
      isTrashed: false,
      systemPrompt,
      aiProvider: agentProvider,
      aiModel: agentModel,
      createdBy: userId,
    };

    // Add optional configuration (save even if empty array)
    if (enabledTools !== undefined) {
      agentData.enabledTools = enabledTools;
    }

    // Create the agent and membership atomically so there is never an agent
    // without a drive role (partial failure rolls back both).
    const newAgent = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(pages)
        .values(agentData)
        .returning({ id: pages.id, title: pages.title, type: pages.type });

      await tx.insert(driveAgentMembers).values({
        driveId: drive.id,
        agentPageId: created.id,
        role: 'MEMBER',
        addedBy: userId,
      });

      return created;
    });

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

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'page_agent', resourceId: newAgent.id, details: {
      action: 'create_agent',
      driveId,
    } });

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
