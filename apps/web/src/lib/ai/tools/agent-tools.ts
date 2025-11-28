import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, drives, eq, and, desc, isNull } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket/socket-utils';
import { maskIdentifier } from '@/lib/logging/mask';
import { ToolExecutionContext } from '../core/types';
import { pageSpaceTools } from '../core/ai-tools';

const agentLogger = loggers.ai.child({ module: 'agent-tools' });

export const agentTools = {
  /**
   * Create a fully configured AI agent with system prompt and tools
   */
  create_agent: tool({
    description: 'Create a new AI agent with custom system prompt and tool configuration. This is a specialized version of create_page optimized for AI agent creation. The agent will be created as an AI_CHAT page type with full configuration.',
    inputSchema: z.object({
      driveId: z.string().describe('The unique ID of the drive to create the agent in'),
      parentId: z.string().optional().describe('The unique ID of the parent page - REQUIRED when creating inside any page (folder, document, etc). Only omit for root-level agents.'),
      title: z.string().describe('The name/title of the AI agent (e.g., "Content Writer", "Code Assistant", "Research Helper")'),
      systemPrompt: z.string().describe('System prompt defining the agent\'s behavior, personality, expertise, and instructions. This controls how the agent responds and what role it plays.'),
      enabledTools: z.array(z.string()).optional().describe('Array of tool names to enable for this agent. Available tools include: regex_search, glob_search, multi_drive_search, read_page, create_page, rename_page, replace_lines, insert_lines, create_task_list, move_page, trash_page, and more. Leave empty for a chat-only agent.'),
      aiProvider: z.string().optional().describe('AI provider for this agent (e.g., "openrouter", "google", "anthropic"). Overrides user default.'),
      aiModel: z.string().optional().describe('AI model for this agent (e.g., "gpt-4", "claude-3-sonnet"). Overrides user default.'),
      welcomeMessage: z.string().optional().describe('Optional welcome message shown when users first interact with the agent.'),
    }),
    execute: async ({ driveId, parentId, title, systemPrompt, enabledTools = [], aiProvider, aiModel, welcomeMessage }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the drive directly by ID
        const [drive] = await db
          .select({ id: drives.id, ownerId: drives.ownerId })
          .from(drives)
          .where(eq(drives.id, driveId));
          
        if (!drive) {
          throw new Error(`Drive with ID "${driveId}" not found`);
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
            throw new Error(`Parent page with ID "${parentId}" not found in this drive`);
          }
        }

        // Check permissions for agent creation
        if (parentId) {
          // Creating in a folder - check permissions on parent page
          const canEdit = await canUserEditPage(userId, parentId);
          if (!canEdit) {
            throw new Error('Insufficient permissions to create agents in this folder');
          }
        } else {
          // Creating at root level - check if user owns the drive
          if (drive.ownerId !== userId) {
            throw new Error('Only drive owners can create agents at the root level');
          }
        }

        // Validate enabled tools
        if (enabledTools.length > 0) {
          const availableToolNames = Object.keys(pageSpaceTools);
          const invalidTools = enabledTools.filter(toolName => !availableToolNames.includes(toolName));
          if (invalidTools.length > 0) {
            throw new Error(`Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}`);
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

        // Prepare agent data with proper typing
        interface AgentInsertData {
          title: string;
          type: 'AI_CHAT';
          content: string;
          position: number;
          driveId: string;
          parentId: string | null;
          isTrashed: boolean;
          systemPrompt: string;
          enabledTools?: string[] | null;
          aiProvider?: string | null;
          aiModel?: string | null;
        }

        const agentData: AgentInsertData = {
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
        if (enabledTools.length > 0) {
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

        return {
          success: true,
          id: newAgent.id,
          title: newAgent.title,
          type: 'AI_CHAT',
          parentId: parentId || 'root',
          message: `Successfully created AI agent "${title}" with custom configuration`,
          summary: `Created AI agent "${title}" in ${parentId ? `parent ${parentId}` : 'drive root'} with ${enabledTools.length} tools`,
          agentConfig: {
            systemPrompt: systemPrompt.substring(0, 100) + (systemPrompt.length > 100 ? '...' : ''),
            enabledToolsCount: enabledTools.length,
            enabledTools: enabledTools,
            aiProvider: aiProvider || 'default',
            aiModel: aiModel || 'default',
            hasWelcomeMessage: !!welcomeMessage
          },
          stats: {
            pageType: 'AI_CHAT',
            location: parentId ? `Parent ID: ${parentId}` : 'Drive root',
            configuredTools: enabledTools.length,
            hasSystemPrompt: true
          },
          nextSteps: [
            `AI agent "${title}" is ready to use`,
            `Agent has access to ${enabledTools.length} tools: ${enabledTools.join(', ')}`,
            'Start a conversation to test the agent\'s behavior',
            `Agent ID: ${newAgent.id} - use this for further operations`,
            'Use read_page to view the agent\'s full configuration'
          ]
        };
      } catch (error) {
        agentLogger.error('Failed to create AI agent', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          driveId: maskIdentifier(driveId),
          parentId: maskIdentifier(parentId || undefined),
          title,
        });
        throw new Error(`Failed to create AI agent: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

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
    }),
    execute: async ({ agentPath, agentId, systemPrompt, enabledTools, aiProvider, aiModel }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the agent page
        const agent = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, agentId),
            eq(pages.type, 'AI_CHAT'),
            eq(pages.isTrashed, false)
          ),
        });

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
          updatedAt: Date;
          systemPrompt?: string | null;
          enabledTools?: string[] | null;
          aiProvider?: string | null;
          aiModel?: string | null;
        }

        const updateData: AgentUpdateData = {
          updatedAt: new Date(),
        };

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

        // Update the agent configuration
        await db
          .update(pages)
          .set(updateData)
          .where(eq(pages.id, agent.id));

        // Broadcast update event
        await broadcastPageEvent(
          createPageEventPayload(agent.driveId, agent.id, 'updated', {
            title: agent.title
          })
        );

        return {
          success: true,
          path: agentPath,
          id: agent.id,
          title: agent.title,
          message: `Successfully updated AI agent "${agent.title}" configuration`,
          summary: `Updated agent configuration${systemPrompt ? ' with new system prompt' : ''}${enabledTools ? ` and ${enabledTools.length} tools` : ''}`,
          updatedFields: Object.keys(updateData).filter(key => key !== 'updatedAt'),
          agentConfig: {
            hasSystemPrompt: !!updateData.systemPrompt || (systemPrompt === undefined && !!agent.systemPrompt),
            enabledToolsCount: enabledTools?.length || 0,
            enabledTools: enabledTools || agent.enabledTools || [],
            aiProvider: aiProvider || agent.aiProvider || 'default',
            aiModel: aiModel || agent.aiModel || 'default'
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