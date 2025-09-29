import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { generateText, convertToModelMessages, UIMessage, type Tool } from 'ai';
import { db, pages, chatMessages, drives, eq, and, asc, sql } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { convertDbMessageToUIMessage, sanitizeMessagesForModel } from '@/lib/ai/assistant-utils';
import { driveTools } from './drive-tools';
import { pageReadTools } from './page-read-tools';
import { pageWriteTools } from './page-write-tools';
import { searchTools } from './search-tools';
import { taskManagementTools } from './task-management-tools';
import { batchOperationsTools } from './batch-operations-tools';
import { agentTools } from './agent-tools';
import {
  createAIProvider,
  isProviderError,
  type ProviderRequest
} from '@/lib/ai/provider-factory';
import { buildTimestampSystemPrompt } from '@/lib/ai/timestamp-utils';
import { ToolExecutionContext } from '../types';
import { loggers } from '@pagespace/lib/server';
import { AI_PROVIDERS, getModelDisplayName } from '@/lib/ai/ai-providers-config';
import { augmentToolsWithInternetAccess } from '@/lib/ai/mcp/internet-tools';

// Constants
const MAX_AGENT_DEPTH = 3;
const MAX_CONVERSATION_WINDOW = 50; // Limit messages for performance

/**
 * Get configured AI model for agent using the centralized provider factory
 * Handles provider-specific setup and fallbacks
 */
async function getConfiguredModel(userId: string, agentConfig: { aiProvider?: string | null; aiModel?: string | null }) {
  const { aiProvider, aiModel } = agentConfig;

  // Use default provider/model if agent doesn't have specific configuration
  const selectedProvider = aiProvider || 'pagespace';
  const selectedModel = aiModel || (selectedProvider === 'pagespace' ? 'GLM-4.5-air' : undefined);

  const providerRequest: ProviderRequest = {
    selectedProvider,
    selectedModel,
  };

  const providerResult = await createAIProvider(userId, providerRequest);

  if (isProviderError(providerResult)) {
    throw new Error(providerResult.error);
  }

  return providerResult.model;
}

/**
 * Filter tools for agent configuration
 */
function filterToolsForAgent(enabledTools: string[] | null): Record<string, Tool> {
  if (!enabledTools || enabledTools.length === 0) {
    return {}; // No tools enabled
  }

  // Construct available tools from individual modules to avoid circular dependency
  const availableTools: Record<string, Tool> = {
    ...driveTools,
    ...pageReadTools,
    ...pageWriteTools,
    ...searchTools,
    ...taskManagementTools,
    ...batchOperationsTools,
    ...agentTools,
    // Note: Not including agentCommunicationTools to prevent infinite recursion
  };
  
  const filteredTools: Record<string, Tool> = {};

  for (const toolName of enabledTools) {
    const tool = availableTools[toolName];
    if (tool) {
      filteredTools[toolName] = tool;
    }
  }

  return filteredTools;
}

/**
 * Log agent interaction for audit trail
 */
async function logAgentInteraction(params: {
  requestingUserId: string;
  requestingAgent?: string;
  targetAgent: string;
  question: string;
  success: boolean;
  error?: string;
}) {
  try {
    loggers.ai.info('Agent-to-Agent interaction', {
      requestingUserId: params.requestingUserId,
      requestingAgent: params.requestingAgent,
      targetAgent: params.targetAgent,
      question: params.question.substring(0, 100),
      success: params.success,
      error: params.error
    });
  } catch (error) {
    loggers.ai.error('Failed to log agent interaction:', error as Error);
  }
}

export const agentCommunicationTools = {
  /**
   * List all AI agents in a specific drive
   */
  list_agents: tool({
    description: 'List all AI agents in a specific drive. Returns only AI_CHAT pages with their configuration.',
    inputSchema: z.object({
      driveId: z.string().describe('The unique ID of the drive to list agents from'),
      driveSlug: z.string().optional().describe('The drive slug for semantic context (e.g., "marketing", "dev-tools")'),
      includeSystemPrompt: z.boolean().optional().default(false).describe('Include the full system prompt for each agent'),
      includeTools: z.boolean().optional().default(true).describe('Include the list of enabled tools for each agent'),
    }),
    execute: async ({ driveId, driveSlug, includeSystemPrompt, includeTools }, { experimental_context }) => {
      const executionContext = experimental_context as ToolExecutionContext;
      const userId = executionContext?.userId;
      
      if (!userId) {
        throw new Error('User authentication required');
      }
      
      try {
        // Get the drive info
        const [drive] = await db
          .select({ id: drives.id, name: drives.name, ownerId: drives.ownerId })
          .from(drives)
          .where(eq(drives.id, driveId));
        
        if (!drive) {
          throw new Error(`Drive with ID "${driveId}" not found`);
        }
        
        // Query all AI agents in the drive
        const agents = await db
          .select({
            id: pages.id,
            title: pages.title,
            systemPrompt: pages.systemPrompt,
            enabledTools: pages.enabledTools,
            aiProvider: pages.aiProvider,
            aiModel: pages.aiModel,
            parentId: pages.parentId,
            createdAt: pages.createdAt,
          })
          .from(pages)
          .where(and(
            eq(pages.driveId, driveId),
            eq(pages.type, 'AI_CHAT'),
            eq(pages.isTrashed, false)
          ))
          .orderBy(pages.title);
        
        // Filter agents based on user permissions
        const accessibleAgents = [];
        for (const agent of agents) {
          const canView = await canUserViewPage(userId, agent.id);
          if (canView) {
            // Check if agent has conversation history
            const messageCount = await db
              .select({ count: sql<number>`count(*)` })
              .from(chatMessages)
              .where(eq(chatMessages.pageId, agent.id));
            
            const hasConversationHistory = messageCount[0]?.count > 0;
            
            // Get parent title if exists
            let parentTitle = undefined;
            if (agent.parentId) {
              const [parent] = await db
                .select({ title: pages.title })
                .from(pages)
                .where(eq(pages.id, agent.parentId));
              parentTitle = parent?.title;
            }
            
            accessibleAgents.push({
              id: agent.id,
              title: agent.title,
              path: `/${driveSlug || 'drive'}/${agent.title}`,
              systemPrompt: includeSystemPrompt ? agent.systemPrompt : undefined,
              enabledTools: includeTools ? (agent.enabledTools as string[] | null) : undefined,
              aiProvider: agent.aiProvider,
              aiModel: agent.aiModel,
              hasConversationHistory,
              parentId: agent.parentId,
              parentTitle,
            });
          }
        }
        
        return {
          success: true,
          driveId: drive.id,
          driveName: drive.name,
          agents: accessibleAgents,
          count: accessibleAgents.length,
          summary: `Found ${accessibleAgents.length} AI agent${accessibleAgents.length === 1 ? '' : 's'} in ${drive.name}`
        };
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        loggers.ai.error('Failed to list agents:', { error: errorMessage, driveId });
        
        return {
          success: false,
          error: errorMessage,
          driveId,
          agents: [],
          count: 0,
          summary: 'Failed to list agents'
        };
      }
    },
  }),

  /**
   * List all AI agents across all accessible drives
   */
  multi_drive_list_agents: tool({
    description: 'List all AI agents across ALL accessible drives. Useful for discovering agents throughout your entire workspace.',
    inputSchema: z.object({
      includeSystemPrompt: z.boolean().optional().default(false).describe('Include the full system prompt for each agent'),
      includeTools: z.boolean().optional().default(true).describe('Include the list of enabled tools for each agent'),
      groupByDrive: z.boolean().optional().default(true).describe('Group results by drive for better organization'),
    }),
    execute: async ({ includeSystemPrompt, includeTools, groupByDrive }, { experimental_context }) => {
      const executionContext = experimental_context as ToolExecutionContext;
      const userId = executionContext?.userId;
      
      if (!userId) {
        throw new Error('User authentication required');
      }
      
      try {
        // Get all drives the user has access to
        const userDrives = await db
          .select({
            id: drives.id,
            name: drives.name,
            slug: drives.slug,
          })
          .from(drives)
          .where(eq(drives.ownerId, userId)); // Simplified - you might want more complex permission logic
        
        let totalAgentCount = 0;
        const agentsByDrive = [];
        const allAgents = [];
        
        for (const drive of userDrives) {
          // Query AI agents in this drive
          const agents = await db
            .select({
              id: pages.id,
              title: pages.title,
              systemPrompt: pages.systemPrompt,
              enabledTools: pages.enabledTools,
              aiProvider: pages.aiProvider,
              aiModel: pages.aiModel,
              parentId: pages.parentId,
              createdAt: pages.createdAt,
            })
            .from(pages)
            .where(and(
              eq(pages.driveId, drive.id),
              eq(pages.type, 'AI_CHAT'),
              eq(pages.isTrashed, false)
            ))
            .orderBy(pages.title);
          
          const driveAgents = [];
          for (const agent of agents) {
            const canView = await canUserViewPage(userId, agent.id);
            if (canView) {
              // Check for conversation history
              const messageCount = await db
                .select({ count: sql<number>`count(*)` })
                .from(chatMessages)
                .where(eq(chatMessages.pageId, agent.id));
              
              const hasConversationHistory = messageCount[0]?.count > 0;
              
              // Get parent title if exists
              let parentTitle = undefined;
              if (agent.parentId) {
                const [parent] = await db
                  .select({ title: pages.title })
                  .from(pages)
                  .where(eq(pages.id, agent.parentId));
                parentTitle = parent?.title;
              }
              
              const agentData = {
                id: agent.id,
                title: agent.title,
                driveId: drive.id,
                driveName: drive.name,
                path: `/${drive.slug}/${agent.title}`,
                systemPrompt: includeSystemPrompt ? agent.systemPrompt : undefined,
                enabledTools: includeTools ? (agent.enabledTools as string[] | null) : undefined,
                aiProvider: agent.aiProvider,
                aiModel: agent.aiModel,
                hasConversationHistory,
                parentId: agent.parentId,
                parentTitle,
              };
              
              driveAgents.push(agentData);
              allAgents.push(agentData);
              totalAgentCount++;
            }
          }
          
          if (driveAgents.length > 0) {
            agentsByDrive.push({
              driveId: drive.id,
              driveName: drive.name,
              driveSlug: drive.slug,
              agentCount: driveAgents.length,
              agents: driveAgents
            });
          }
        }
        
        if (groupByDrive) {
          return {
            success: true,
            totalCount: totalAgentCount,
            driveCount: agentsByDrive.length,
            summary: `Found ${totalAgentCount} AI agent${totalAgentCount === 1 ? '' : 's'} across ${agentsByDrive.length} drive${agentsByDrive.length === 1 ? '' : 's'}`,
            agentsByDrive
          };
        } else {
          return {
            success: true,
            totalCount: totalAgentCount,
            driveCount: agentsByDrive.length,
            summary: `Found ${totalAgentCount} AI agent${totalAgentCount === 1 ? '' : 's'} across ${agentsByDrive.length} drive${agentsByDrive.length === 1 ? '' : 's'}`,
            agents: allAgents
          };
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        loggers.ai.error('Failed to list agents across drives:', { error: errorMessage });
        
        return {
          success: false,
          error: errorMessage,
          totalCount: 0,
          driveCount: 0,
          summary: 'Failed to list agents',
          agentsByDrive: [],
          agents: []
        };
      }
    },
  }),

  /**
   * Consult another AI agent in the workspace for specialized knowledge or assistance
   */
  ask_agent: tool({
    description: 'Consult another AI agent in the workspace for specialized knowledge or assistance. The target agent will process your question with its full conversation history and configuration, but the interaction will not be saved to the target agent\'s conversation.',
    inputSchema: z.object({
      agentPath: z.string().describe('Semantic path to the agent (e.g., "/finance/Budget Analyst", "/dev/Code Assistant") for context and user readability'),
      agentId: z.string().describe('Unique ID of the AI agent page to consult'), 
      question: z.string().describe('Question or request for the target agent. Be specific and provide context.'),
      context: z.string().optional().describe('Additional context about why you\'re asking this question or what you need the response for')
    }),
    execute: async ({ agentPath, agentId, question, context }, { experimental_context }) => {
      const executionContext = experimental_context as ToolExecutionContext;
      const userId = executionContext?.userId;
      
      if (!userId) {
        throw new Error('User authentication required for agent consultation');
      }
      
      // Track call depth to prevent infinite recursion
      const callDepth = (executionContext as ToolExecutionContext & { agentCallDepth?: number })?.agentCallDepth || 0;
      if (callDepth >= MAX_AGENT_DEPTH) {
        throw new Error(`Maximum agent consultation depth (${MAX_AGENT_DEPTH}) exceeded`);
      }
      
      const startTime = Date.now();
      
      try {
        // 1. Validate target agent exists and is AI_CHAT type
        const targetAgent = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, agentId),
            eq(pages.type, 'AI_CHAT'),
            eq(pages.isTrashed, false)
          ),
        });
        
        if (!targetAgent) {
          await logAgentInteraction({
            requestingUserId: userId,
            requestingAgent: executionContext?.locationContext?.currentPage?.id,
            targetAgent: agentId,
            question,
            success: false,
            error: 'Agent not found'
          });
          throw new Error(`AI agent with ID "${agentId}" not found or is not an AI chat agent`);
        }
        
        // 2. Check user permissions (inherit requesting user's permissions)
        const canView = await canUserViewPage(userId, agentId);
        if (!canView) {
          await logAgentInteraction({
            requestingUserId: userId,
            requestingAgent: executionContext?.locationContext?.currentPage?.id,
            targetAgent: agentId,
            question,
            success: false,
            error: 'Permission denied'
          });
          throw new Error(`Insufficient permissions to consult agent "${targetAgent.title}"`);
        }
        
        // 3. Load target agent's conversation history (with window limit for performance)
        const agentHistory = await db.select()
          .from(chatMessages)
          .where(and(
            eq(chatMessages.pageId, agentId),
            eq(chatMessages.isActive, true)
          ))
          .orderBy(asc(chatMessages.createdAt))
          .limit(MAX_CONVERSATION_WINDOW);
        
        // 4. Convert database messages to UI messages
        const historyMessages = agentHistory.map(convertDbMessageToUIMessage);
        
        // 5. Build message chain for target agent
        const userMessage: UIMessage = {
          id: `temp-${Date.now()}`,
          role: 'user' as const,
          parts: [{ 
            type: 'text', 
            text: `${context ? `Context: ${context}\n\n` : ''}${question}` 
          }]
        };
        
        const messages: UIMessage[] = [
          ...historyMessages,
          userMessage
        ];
        
        // 6. Sanitize messages for AI model
        const sanitizedMessages = sanitizeMessagesForModel(messages);
        
        // 7. Build system prompt with agent configuration
        let systemPrompt = targetAgent.systemPrompt || '';
        
        // Add timestamp context
        systemPrompt += '\n\n' + buildTimestampSystemPrompt();
        
        // Add cross-agent context
        systemPrompt += `\n\nYou are being consulted by another agent or user. Respond helpfully based on your expertise and conversation history.`;
        
        // 8. Get configured model for agent
        const model = await getConfiguredModel(userId, {
          aiProvider: targetAgent.aiProvider,
          aiModel: targetAgent.aiModel
        });
        
        // 9. Filter tools for agent
        const agentTools = filterToolsForAgent(targetAgent.enabledTools as string[] | null);

        // 10. Augment with internet-enabled tools when available
        const providerForTools = targetAgent.aiProvider || 'pagespace';
        const augmentation = await augmentToolsWithInternetAccess(agentTools, providerForTools);
        const toolsWithInternet = augmentation.tools;
        let internetDispose = augmentation.dispose;

        if (augmentation.addedToolCount > 0) {
          loggers.ai.debug('Agent communication: Internet tools enabled', {
            agentId,
            addedTools: augmentation.addedToolCount,
          });
        }

        // 11. Create enhanced execution context for nested calls
        const nestedContext = {
          ...executionContext,
          agentCallDepth: callDepth + 1,
          currentAgentId: agentId
        } as ToolExecutionContext & { agentCallDepth: number; currentAgentId: string };

        // 12. Process with target agent's configuration (ephemeral - no persistence)
        const hasTools = Object.keys(toolsWithInternet).length > 0;
        let response;
        try {
          response = hasTools
            ? await generateText({
                model,
                system: systemPrompt,
                messages: convertToModelMessages(sanitizedMessages),
                tools: toolsWithInternet as Parameters<typeof generateText>[0]['tools'],
                experimental_context: nestedContext,
                stopWhen: stepCountIs(100), // Match main conversation tool depth
                maxRetries: 3,
                onStepFinish: ({ toolCalls }) => {
                  if (toolCalls?.length > 0) {
                    loggers.ai.debug('Sub-agent tool execution:', {
                      agentId,
                      toolCalls: toolCalls.map(tc => tc.toolName),
                    });
                  }
                },
              })
            : await generateText({
                model,
                system: systemPrompt,
                messages: convertToModelMessages(sanitizedMessages),
                experimental_context: nestedContext,
                maxRetries: 3,
              });
        } finally {
          if (internetDispose) {
            await internetDispose();
            internetDispose = undefined;
          }
        }

        // 13. Extract response text with error checking
        const agentResponse = response.text;

        // Check for tool execution errors
        const toolErrors = response.steps?.flatMap(step =>
          step.content?.filter(part => part.type === 'tool-error') || []
        ) || [];

        if (toolErrors.length > 0) {
          loggers.ai.warn('Sub-agent tool execution errors:', {
            agentId,
            errors: toolErrors,
          });
        }
        
        // 13. Log successful interaction
        await logAgentInteraction({
          requestingUserId: userId,
          requestingAgent: executionContext?.locationContext?.currentPage?.id,
          targetAgent: agentId,
          question,
          success: true
        });
        
        // 14. Return structured response
        const processingTime = Date.now() - startTime;
        
        return {
          success: true,
          agent: targetAgent.title,
          agentPath: agentPath,
          question: question,
          response: agentResponse,
          context: context,
          metadata: {
            agentId: targetAgent.id,
            processingTime,
            messagesInHistory: historyMessages.length,
            callDepth: callDepth + 1,
            // Use display names from AI_PROVIDERS config
            provider: targetAgent.aiProvider
              ? (AI_PROVIDERS[targetAgent.aiProvider as keyof typeof AI_PROVIDERS]?.name || targetAgent.aiProvider)
              : AI_PROVIDERS.pagespace.name,
            model: targetAgent.aiProvider
              ? getModelDisplayName(targetAgent.aiProvider, targetAgent.aiModel || 'gemini-2.5-flash')
              : 'Default (Free)',  // PageSpace default model display name
            toolsEnabled: (targetAgent.enabledTools as string[] | null)?.length || 0,
            toolCalls: response.steps?.flatMap(step => step.toolCalls || []).length || 0,
            steps: response.steps?.length || 1
          }
        };
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Log failed interaction
        await logAgentInteraction({
          requestingUserId: userId,
          requestingAgent: executionContext?.locationContext?.currentPage?.id,
          targetAgent: agentId,
          question,
          success: false,
          error: errorMessage
        });
        
        loggers.ai.error('Agent consultation failed:', {
          agentPath,
          agentId,
          error: errorMessage,
          userId,
          processingTime: Date.now() - startTime
        });
        
        // Return error response instead of throwing to allow graceful degradation
        return {
          success: false,
          agent: agentPath,
          error: `Failed to consult agent: ${errorMessage}`,
          question: question,
          context: context,
          metadata: {
            processingTime: Date.now() - startTime,
            callDepth: callDepth + 1
          }
        };
      }
    },
  }),
};