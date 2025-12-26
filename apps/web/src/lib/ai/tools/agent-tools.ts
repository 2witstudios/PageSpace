import { tool } from 'ai';
import { z } from 'zod';
import {
  canUserEditPage,
  getActorInfo,
  loggers,
  agentRepository,
} from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { maskIdentifier } from '@/lib/logging/mask';
import { type ToolExecutionContext, pageSpaceTools } from '../core';
import { applyPageMutation } from '@/services/api/page-mutation-service';

const agentLogger = loggers.ai.child({ module: 'agent-tools' });

export const agentTools = {
  /**
   * Update an existing AI agent's configuration
   */
  update_agent_config: tool({
    description: 'Update the configuration of an existing AI agent, including system prompt, enabled tools, AI provider, and model settings.',
    inputSchema: z.object({
      agentPath: z.string().describe('The agent path using titles like "/driveSlug/Agent Name" for semantic context'),
      agentId: z.string().describe('The unique ID of the AI agent to update'),
      systemPrompt: z.string().optional().describe('New system prompt for the agent. Leave empty to keep current prompt.'),
      enabledTools: z.array(z.string()).optional().describe('New array of enabled tool names. Leave empty to keep current tools.'),
      aiProvider: z.string().optional().describe('New AI provider for the agent'),
      aiModel: z.string().optional().describe('New AI model for the agent'),
      agentDefinition: z.string().max(500).optional().describe('New description of what this agent does (max 500 chars).'),
      visibleToGlobalAssistant: z.boolean().optional().describe('Whether this agent appears in the global assistant\'s available agents list.'),
      includeDrivePrompt: z.boolean().optional().describe('Include drive-level AI instructions in the agent\'s context.'),
      includePageTree: z.boolean().optional().describe('Include page tree structure in the agent\'s context.'),
      pageTreeScope: z.enum(['children', 'drive']).optional().describe('Scope for page tree: "children" or "drive".'),
    }),
    execute: async ({ agentPath, agentId, systemPrompt, enabledTools, aiProvider, aiModel, agentDefinition, visibleToGlobalAssistant, includeDrivePrompt, includePageTree, pageTreeScope }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the agent page via repository seam
        const agent = await agentRepository.findById(agentId);

        if (!agent) {
          throw new Error(`AI agent with ID "${agentId}" not found`);
        }

        // Check permissions
        const canEdit = await canUserEditPage(userId, agent.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to update this AI agent');
        }

        // Validate enabled tools if provided
        if (enabledTools && enabledTools.length > 0) {
          const availableToolNames = Object.keys(pageSpaceTools);
          const invalidTools = enabledTools.filter(toolName => !availableToolNames.includes(toolName));
          if (invalidTools.length > 0) {
            throw new Error(`Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}`);
          }
        }

        // Build update data with proper typing
        interface AgentUpdateData {
          systemPrompt?: string | null;
          enabledTools?: string[] | null;
          aiProvider?: string | null;
          aiModel?: string | null;
          agentDefinition?: string | null;
          visibleToGlobalAssistant?: boolean;
          includeDrivePrompt?: boolean;
          includePageTree?: boolean;
          pageTreeScope?: 'children' | 'drive';
        }

        const updateData: AgentUpdateData = {};

        if (systemPrompt !== undefined) {
          updateData.systemPrompt = systemPrompt || null;
        }
        if (enabledTools !== undefined) {
          updateData.enabledTools = enabledTools.length > 0 ? enabledTools : null;
        }
        if (aiProvider !== undefined) {
          updateData.aiProvider = aiProvider || null;
        }
        if (aiModel !== undefined) {
          updateData.aiModel = aiModel || null;
        }
        if (agentDefinition !== undefined) {
          updateData.agentDefinition = agentDefinition || null;
        }
        if (visibleToGlobalAssistant !== undefined) {
          updateData.visibleToGlobalAssistant = visibleToGlobalAssistant;
        }
        if (includeDrivePrompt !== undefined) {
          updateData.includeDrivePrompt = includeDrivePrompt;
        }
        if (includePageTree !== undefined) {
          updateData.includePageTree = includePageTree;
        }
        if (pageTreeScope !== undefined) {
          updateData.pageTreeScope = pageTreeScope;
        }

        const updatedFields = Object.keys(updateData);
        if (updatedFields.length === 0) {
          throw new Error('No valid fields provided for update');
        }

        const updatePayload: Record<string, unknown> = { ...updateData };
        const ctx = context as ToolExecutionContext;
        // Build chain metadata (Tier 1)
        const chainMetadata = {
          ...(ctx?.parentAgentId && { parentAgentId: ctx.parentAgentId }),
          ...(ctx?.parentConversationId && { parentConversationId: ctx.parentConversationId }),
          ...(ctx?.agentChain?.length && { agentChain: ctx.agentChain }),
          ...(ctx?.requestOrigin && { requestOrigin: ctx.requestOrigin }),
        };

        // Update the agent configuration with deterministic logging
        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId: agent.id,
          operation: 'agent_config_update',
          updates: updatePayload,
          updatedFields,
          expectedRevision: typeof agent.revision === 'number' ? agent.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            isAiGenerated: true,
            aiProvider: ctx?.aiProvider,
            aiModel: ctx?.aiModel,
            aiConversationId: ctx?.conversationId,
            metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
            resourceType: 'agent',
          },
        });

        const refreshedAgent = await agentRepository.findById(agent.id);
        const updatedAgent = refreshedAgent ?? { ...agent, ...updateData };
        const enabledToolsList = updatedAgent.enabledTools ?? [];

        // Broadcast update event
        await broadcastPageEvent(
          createPageEventPayload(updatedAgent.driveId, updatedAgent.id, 'updated', {
            title: updatedAgent.title
          })
        );

        return {
          success: true,
          path: agentPath,
          id: updatedAgent.id,
          title: updatedAgent.title,
          message: `Successfully updated AI agent "${updatedAgent.title}" configuration`,
          summary: `Updated agent configuration${systemPrompt ? ' with new system prompt' : ''}${enabledTools ? ` and ${enabledTools.length} tools` : ''}`,
          updatedFields,
          agentConfig: {
            hasSystemPrompt: Boolean(updatedAgent.systemPrompt),
            enabledToolsCount: enabledToolsList.length,
            enabledTools: enabledToolsList,
            aiProvider: updatedAgent.aiProvider ?? null,
            aiModel: updatedAgent.aiModel ?? null,
          },
          nextSteps: [
            'Test the agent to ensure the new configuration works as expected',
            'The changes will take effect immediately in new conversations'
          ]
        };
      } catch (error) {
        agentLogger.error('Failed to update AI agent configuration', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          agentId: maskIdentifier(agentId),
          agentPath,
        });
        throw new Error(`Failed to update agent configuration at ${agentPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
