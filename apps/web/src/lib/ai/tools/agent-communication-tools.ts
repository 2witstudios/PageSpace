import { tool, stepCountIs, hasToolCall } from 'ai';
import { finishTool, FINISH_TOOL_NAME } from './finish-tool';
import { z } from 'zod';
import { generateText, UIMessage, type ToolSet, type Tool } from 'ai';
import { db } from '@pagespace/db/db'
import { eq, and, sql } from '@pagespace/db/operators'
import { pages, chatMessages, drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { prepareHistoryForModel, finishModelRequest } from '@/lib/ai/core/context-assembly';
import { runCompaction } from '@/lib/ai/core/compaction/compaction-service';
import { canActorViewPage, canActorAccessDrive, filterDriveIdsByAppTokenScope, isMcpScoped } from './actor-permissions';
import { filterToolsForMcpScope } from '@/lib/ai/core/tool-filtering';
import { createAIProvider, isProviderError, type ProviderRequest } from '@/lib/ai/core/provider-factory';
import { sanitizeMessagesForModel, saveMessageToDatabase, convertDbMessageToUIMessage } from '@/lib/ai/core/message-utils';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, AI_PROVIDERS, getModelDisplayName } from '@/lib/ai/core/ai-providers-config';
import { buildTimestampSystemPrompt } from '@/lib/ai/core/timestamp-utils';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
import { createId } from '@paralleldrive/cuid2';
import { driveTools } from './drive-tools';
import { pageReadTools } from './page-read-tools';
import { guardReadPageToolForVision } from './read-page-vision-output';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { pageWriteTools } from './page-write-tools';
import { searchTools } from './search-tools';
import { taskManagementTools } from './task-management-tools';
import { agentTools } from './agent-tools';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';

// Nesting cap. Intent is 3+ for richer agent-to-agent composition, but held at 2
// until inner stepCountIs budget is reworked — see PR #713. Raising this without
// also lowering stepCountIs risks 10k+ tool executions per top-level call.
const MAX_AGENT_DEPTH = 2;

/**
 * Get configured AI model for agent using the centralized provider factory
 * Handles provider-specific setup and fallbacks
 */
async function getConfiguredModel(userId: string, agentConfig: { aiProvider?: string | null; aiModel?: string | null }) {
  const { aiProvider, aiModel } = agentConfig;

  // Use default provider/model if agent doesn't have specific configuration
  const selectedProvider = aiProvider || DEFAULT_PROVIDER;
  const selectedModel = aiModel || DEFAULT_MODEL;

  const providerRequest: ProviderRequest = {
    selectedProvider,
    selectedModel,
  };

  const providerResult = await createAIProvider(userId, providerRequest);

  if (isProviderError(providerResult)) {
    throw new Error(providerResult.error);
  }

  return providerResult;
}

/**
 * Filter tools for agent configuration
 */
function filterToolsForAgent(enabledTools: string[] | null): Record<string, unknown> {
  if (!enabledTools || enabledTools.length === 0) {
    return {}; // No tools enabled
  }
  
  // Construct available tools from individual modules to avoid circular dependency
  const availableTools = {
    ...driveTools,
    ...pageReadTools,
    ...pageWriteTools,
    ...searchTools,
    ...taskManagementTools,
    ...agentTools,
    // Note: Not including agentCommunicationTools to prevent infinite recursion
  };
  
  const filteredTools: Record<string, unknown> = {};
  
  for (const toolName of enabledTools) {
    if (availableTools[toolName as keyof typeof availableTools]) {
      filteredTools[toolName] = availableTools[toolName as keyof typeof availableTools];
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

        if (!await canActorAccessDrive(executionContext, driveId)) {
          throw new Error(`You don't have access to the drive with ID "${driveId}"`);
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
          const canView = await canActorViewPage(executionContext, agent.id);
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
        const allUserDrives = await db
          .select({
            id: drives.id,
            name: drives.name,
            slug: drives.slug,
          })
          .from(drives)
          .where(eq(drives.ownerId, userId)); // Simplified - you might want more complex permission logic

        // Ceiling a scoped MCP token to its allowed drives (no-op otherwise).
        const allowedIds = new Set(
          await filterDriveIdsByAppTokenScope(executionContext, allUserDrives.map((d) => d.id)),
        );
        const userDrives = allUserDrives.filter((d) => allowedIds.has(d.id));

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
            const canView = await canActorViewPage(executionContext, agent.id);
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
    description: 'Consult another AI agent in the workspace for specialized knowledge or assistance. This tool supports PERSISTENT conversations - you can continue previous conversations by providing a conversationId, or start a new conversation. The conversationId is returned in the response so you can continue the conversation in subsequent calls.',
    inputSchema: z.object({
      agentPath: z.string().describe('Semantic path to the agent (e.g., "/finance/Budget Analyst", "/dev/Code Assistant") for context and user readability'),
      agentId: z.string().describe('Unique ID of the AI agent page to consult'),
      question: z.string().describe('Question or request for the target agent. Be specific and provide context.'),
      context: z.string().optional().describe('Additional context about why you\'re asking this question or what you need the response for'),
      conversationId: z.string().optional().describe('Optional conversation ID to continue a previous conversation. If not provided, a new conversation will be created. Use the conversationId returned in previous responses to continue the same conversation.')
    }),
    execute: async ({ agentPath, agentId, question, context, conversationId }, { experimental_context }) => {
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
        
        // 2. Check actor permissions
        const canView = await canActorViewPage(executionContext, agentId);
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

        // 3. Create or use existing conversation
        const activeConversationId = conversationId || createId();

        // Eagerly ensure a conversations row exists so this conversation is
        // listable via GET .../conversations (same fix as the consult route,
        // #1837 finding #1) — without it, chat_messages are persisted but the
        // listing query's ownership join never matches. createConversation
        // itself refuses to claim ownership of a supplied conversationId that
        // already has messages from a different user (see its doc comment) —
        // safe to call unconditionally.
        await conversationRepository.createConversation(activeConversationId, userId, agentId).catch(() => {});

        // 4. Load conversation history if continuing an existing conversation
        let messages: UIMessage[] = [];
        if (conversationId) {
          // Load existing conversation history
          const dbMessages = await db
            .select()
            .from(chatMessages)
            .where(and(
              eq(chatMessages.pageId, agentId),
              eq(chatMessages.conversationId, conversationId),
              eq(chatMessages.isActive, true)
            ))
            .orderBy(chatMessages.createdAt);

          messages = await Promise.all(dbMessages.map(convertDbMessageToUIMessage));

          loggers.ai.debug('Loaded conversation history for ask_agent:', {
            conversationId,
            messageCount: messages.length,
            agentId
          });
        }

        // 5. Build and save the user's question message
        const userMessageId = createId();
        const userMessageContent = `${context ? `Context: ${context}\n\n` : ''}${question}`;
        const userMessage: UIMessage = {
          id: userMessageId,
          role: 'user' as const,
          parts: [{
            type: 'text',
            text: userMessageContent
          }]
        };

        // Determine sourceAgentId - only set if the calling context is an AI_CHAT page
        const callingPage = executionContext?.locationContext?.currentPage;
        const sourceAgentId = callingPage?.type === 'AI_CHAT' ? callingPage.id : null;

        // Save user message to database
        await saveMessageToDatabase({
          messageId: userMessageId,
          pageId: agentId,
          conversationId: activeConversationId,
          userId: userId, // Track which user (via calling agent) asked the question
          role: 'user',
          content: userMessageContent,
          sourceAgentId, // Track which AI agent sent this message (for agent-to-agent communication)
        });

        // Add user message to conversation
        messages.push(userMessage);

        // 6. Sanitize messages for AI model
        const sanitizedMessages = sanitizeMessagesForModel(messages);
        
        // 7. Build system prompt with agent configuration
        let systemPrompt = targetAgent.systemPrompt || '';

        // Add timestamp context (using user's timezone from execution context)
        systemPrompt += '\n\n' + buildTimestampSystemPrompt(executionContext?.timezone);

        // Add location context if available (drive and page awareness)
        if (executionContext?.locationContext) {
          const loc = executionContext.locationContext;
          if (loc.currentDrive) {
            systemPrompt += `\n\nCONTEXT AWARENESS:\n`;
            systemPrompt += `• Current Drive: ${loc.currentDrive.name} (${loc.currentDrive.slug})\n`;
            systemPrompt += `• Drive ID: ${loc.currentDrive.id}\n`;
            if (loc.currentPage) {
              systemPrompt += `• Current Page: ${loc.currentPage.title}\n`;
              systemPrompt += `• Page Type: ${loc.currentPage.type}\n`;
              systemPrompt += `• Page Path: ${loc.currentPage.path}\n`;
            }
            if (loc.breadcrumbs && loc.breadcrumbs.length > 0) {
              systemPrompt += `• Breadcrumb Path: ${loc.breadcrumbs.join(' > ')}\n`;
            }
            systemPrompt += `\nYou are operating within this context. Use this drive and page information when using tools like list_pages, create_page, etc. Default to the current drive (${loc.currentDrive.id}) unless explicitly told otherwise.`;
          }
        }

        // Add cross-agent context
        systemPrompt += `\n\nYou are being consulted by another agent or user${executionContext?.locationContext?.currentPage?.title ? ` (${executionContext.locationContext.currentPage.title})` : ''}. This is a persistent conversation - you have access to the full conversation history. Respond helpfully based on your expertise and the conversation context.`;
        
        // 8. Get configured model for agent
        const { model, provider: resolvedProvider, modelName: resolvedModelName } =
          await getConfiguredModel(userId, {
            aiProvider: targetAgent.aiProvider,
            aiModel: targetAgent.aiModel
          });
        
        // 9. Filter tools for agent. Nested calls inherit the top-level caller's MCP
        // drive scope via nestedContext below, so a scoped token must not be able to
        // reach create_drive (or other account-level-only tools) through a consulted
        // agent's enabledTools either — same listing gate as the top-level routes.
        const agentTools = filterToolsForMcpScope(
          filterToolsForAgent(targetAgent.enabledTools as string[] | null),
          isMcpScoped(executionContext),
        );

        // try/catch: resolver failures degrade to built-in tools only rather than hard-failing the call
        let integrationTools: Record<string, unknown> = {};
        try {
          const { resolvePageAgentIntegrationTools } = await import('@/lib/ai/core/integration-tool-resolver');
          integrationTools = await resolvePageAgentIntegrationTools({
            agentId,
            userId,
            driveId: targetAgent.driveId,
          });
        } catch (error) {
          loggers.ai.error('ask_agent: failed to resolve integration tools, falling back to built-in tools only', error as Error);
        }
        // Key order is already deterministic — agentTools filters the module-constant
        // base map (stable insertion order) and the integration resolver returns
        // sorted keys — so the serialized tool bytes are prefix-cache-stable without
        // re-sorting here (same guarantee as the chat/global route merges).
        const allAgentTools = { ...agentTools, ...integrationTools };

        // Guard against a stale read_page tool-result (image bytes delivered on an
        // earlier turn when the target agent had a vision-capable model) being
        // re-embedded as an image when history is re-converted for a model that no
        // longer has vision (e.g. the agent's configured model changed since).
        if (allAgentTools.read_page) {
          allAgentTools.read_page = guardReadPageToolForVision(
            allAgentTools.read_page as Tool,
            hasVisionCapability(resolvedModelName),
          );
        }

        // 10. Create enhanced execution context for nested calls
        // Preserve locationContext so nested agents know which drive/page they're operating in
        // Include chain tracking for activity logging (Tier 1)
        const nestedContext = {
          ...executionContext,
          agentCallDepth: callDepth + 1,
          currentAgentId: agentId,
          locationContext: executionContext?.locationContext, // Explicitly preserve location context
          // Chain tracking for audit trail
          parentAgentId: executionContext?.locationContext?.currentPage?.id,
          parentConversationId: executionContext?.conversationId,
          agentChain: [
            ...(executionContext?.agentChain || []),
            agentId,
          ],
          requestOrigin: 'agent' as const,
        } as ToolExecutionContext & { agentCallDepth: number; currentAgentId: string };
        
        // 10b. Sliding-window compaction — fire-and-forget after generateText because
        // after() from next/server is unavailable inside tool execution mid-stream.
        // Role lookup is best-effort: if the query fails, compaction simply won't fire
        // (canUseCompaction returns false for role:null → exact legacy behaviour).
        let callerUserRole: string | null = null;
        try {
          const [callerUserRow] = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId));
          callerUserRole = callerUserRow?.role ?? null;
        } catch {
          // Fallback: role unknown → non-admin path
        }
        // Budget against the EXACT tool set generateText will receive below —
        // the tool-enabled branch adds finishTool, and undercounting schema
        // bytes here could pass context-window prep yet exceed the model limit
        // at generation time.
        const executionTools =
          Object.keys(allAgentTools).length > 0
            ? ({ ...allAgentTools, ...finishTool } as Record<string, unknown>)
            : (allAgentTools as Record<string, unknown>);

        // Full seam (sanitize → compact → elide): sub-agent histories accumulate the
        // same stale read-tool outputs as top-level chats, so they get the same
        // chunk-aligned elision treatment, not just compaction. The seam re-sanitizes
        // internally, which is idempotent over sanitizedMessages.
        const prepared = await prepareHistoryForModel({
          history: sanitizedMessages,
          conversationId: activeConversationId,
          source: 'page',
          pageId: agentId,
          model: resolvedModelName,
          provider: resolvedProvider,
          systemPrompt,
          tools: executionTools,
          user: { id: userId, role: callerUserRole },
        });
        const { modelMessages: agentModelMessages } = await finishModelRequest({ prepared, tools: executionTools as ToolSet });

        // 11. Process with target agent's configuration (ephemeral - no persistence)
        const response = Object.keys(allAgentTools).length > 0
          ? await generateText({
              model,
              system: systemPrompt,
              messages: agentModelMessages,
              tools: { ...allAgentTools, ...finishTool } as Parameters<typeof generateText>[0]['tools'],
              experimental_context: nestedContext,
              stopWhen: [hasToolCall(FINISH_TOOL_NAME), stepCountIs(20)],
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
              messages: agentModelMessages,
              experimental_context: nestedContext,
              maxRetries: 3,
            });

        // Fire-and-forget compaction: after() is unavailable inside tool execution,
        // so we launch directly — the parent stream is still open but this is safe
        // as a detached promise (no response coupling).
        if (prepared.pendingCompaction) {
          void runCompaction(prepared.pendingCompaction);
        }

        // Bill the requesting user for the sub-agent run. Use totalUsage so all
        // tool-loop round-trips (up to stepCountIs(20)) are metered, not just the
        // final step. Tracked against the resolved model name so the cost is real.
        // Awaited (not fire-and-forget): trackAIUsage persists the usage log and
        // debits the balance inside the returned promise, so awaiting here keeps the
        // sub-agent charge durable if the tool returns into a serverless freeze.
        // No holdId: this nested call runs inside an already-gated parent request;
        // the parent's hold covers its own settle, and these sub-agent decrements
        // draw the balance directly (no separate reservation to release).
        await AIMonitoring.trackUsage({
          userId,
          provider: resolvedProvider,
          model: resolvedModelName,
          source: 'page_agent',
          inputTokens: response.totalUsage?.inputTokens,
          outputTokens: response.totalUsage?.outputTokens,
          totalTokens: response.totalUsage?.totalTokens,
          conversationId: activeConversationId,
          pageId: agentId,
          driveId: targetAgent.driveId,
          success: true,
          metadata: { feature: 'ask_agent', agentCallDepth: callDepth + 1 },
        });

        // 12. Extract response text with error checking
        // Collect text from all steps — response.text only returns the final step,
        // which may be empty if the model's last action was calling the finish tool
        const agentResponse = response.steps?.map(s => s.text).filter(Boolean).join('') || '';

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

        // 13. Save assistant's response to database
        const assistantMessageId = createId();
        await saveMessageToDatabase({
          messageId: assistantMessageId,
          pageId: agentId,
          conversationId: activeConversationId,
          userId: null, // Assistant message, not from a user
          role: 'assistant',
          content: agentResponse,
          sourceAgentId: null, // Assistant responses are native to this agent, not forwarded
          mentionNotify: {
            driveId: targetAgent.driveId,
            triggeredByUserId: userId,
            mentionerName: targetAgent.title,
          },
        });

        loggers.ai.debug('Saved ask_agent conversation:', {
          conversationId: activeConversationId,
          agentId,
          questionLength: question.length,
          responseLength: agentResponse.length,
          isNewConversation: !conversationId
        });

        // 14. Log successful interaction
        await logAgentInteraction({
          requestingUserId: userId,
          requestingAgent: executionContext?.locationContext?.currentPage?.id,
          targetAgent: agentId,
          question,
          success: true
        });
        
        // 15. Return structured response
        const processingTime = Date.now() - startTime;

        return {
          success: true,
          agent: targetAgent.title,
          agentPath: agentPath,
          question: question,
          response: agentResponse,
          context: context,
          conversationId: activeConversationId, // Return conversationId for continuation
          metadata: {
            agentId: targetAgent.id,
            processingTime,
            persistent: true, // Indicate this conversation is persistent
            isNewConversation: !conversationId, // Flag if this started a new conversation
            callDepth: callDepth + 1,
            // Use display names from AI_PROVIDERS config
            provider: targetAgent.aiProvider
              ? (AI_PROVIDERS[targetAgent.aiProvider as keyof typeof AI_PROVIDERS]?.name || targetAgent.aiProvider)
              : AI_PROVIDERS[DEFAULT_PROVIDER as keyof typeof AI_PROVIDERS].name,
            model: getModelDisplayName(
              targetAgent.aiProvider || DEFAULT_PROVIDER,
              targetAgent.aiModel || DEFAULT_MODEL,
            ),
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