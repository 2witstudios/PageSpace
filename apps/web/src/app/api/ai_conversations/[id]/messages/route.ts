import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs, UIMessage } from 'ai';
import { incrementUsage, getCurrentUsage, getUserUsageSummary } from '@/lib/subscription/usage-service';
import { createRateLimitResponse } from '@/lib/subscription/rate-limit-middleware';
import { broadcastUsageEvent } from '@/lib/socket-utils';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  createAIProvider,
  updateUserProviderSettings,
  createProviderErrorResponse,
  isProviderError,
  type ProviderRequest
} from '@/lib/ai/provider-factory';
import { db, conversations, messages, eq, and, desc, gt, lt } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import { 
  extractMessageContent, 
  extractToolCalls, 
  extractToolResults,
  sanitizeMessagesForModel,
  convertGlobalAssistantMessageToUIMessage,
  saveGlobalAssistantMessageToDatabase
} from '@/lib/ai/assistant-utils';
import { processMentionsInMessage, buildMentionSystemPrompt } from '@/lib/ai/mention-processor';
import { buildTimestampSystemPrompt } from '@/lib/ai/timestamp-utils';
import { AgentRoleUtils } from '@/lib/ai/agent-roles';
import { RolePromptBuilder } from '@/lib/ai/role-prompts';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';
import { getModelCapabilities } from '@/lib/ai/model-capabilities';
import { convertMCPToolsToAISDKSchemas, parseMCPToolName } from '@/lib/ai/mcp-tool-converter';
import { getMCPBridge } from '@/lib/mcp-bridge';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import type { MCPTool } from '@/types/mcp';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * GET - Get all messages for a conversation
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id } = await context.params;

    // Verify user owns the conversation
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(
        eq(conversations.id, id),
        eq(conversations.userId, userId),
        eq(conversations.isActive, true)
      ));

    if (!conversation) {
      return NextResponse.json({ 
        error: 'Conversation not found' 
      }, { status: 404 });
    }

    // Parse pagination parameters
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const cursor = searchParams.get('cursor'); // Message ID for cursor-based pagination
    const direction = searchParams.get('direction') || 'before'; // 'before' or 'after'

    // Build query conditions
    const conditions = [
      eq(messages.conversationId, id),
      eq(messages.isActive, true)
    ];

    // Add cursor condition if provided
    if (cursor) {
      // First, get the timestamp of the cursor message
      const [cursorMessage] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, cursor))
        .limit(1);

      if (cursorMessage) {
        if (direction === 'before') {
          // Get messages created before the cursor (older messages)
          conditions.push(lt(messages.createdAt, cursorMessage.createdAt));
        } else {
          // Get messages created after the cursor (newer messages)
          conditions.push(gt(messages.createdAt, cursorMessage.createdAt));
        }
      }
    }

    // Get messages with pagination
    // Order by createdAt DESC to get newest first, then reverse for chronological display
    const conversationMessages = await db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1); // Get one extra to check if there are more

    // Check if there are more messages
    const hasMore = conversationMessages.length > limit;
    const messagesToReturn = hasMore ? conversationMessages.slice(0, limit) : conversationMessages;

    // Reverse messages to show in chronological order (oldest first)
    const orderedMessages = messagesToReturn.reverse();

    // Convert to UIMessage format with proper tool call reconstruction
    const uiMessages = orderedMessages.map(msg =>
      convertGlobalAssistantMessageToUIMessage({
        id: msg.id,
        conversationId: msg.conversationId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        createdAt: msg.createdAt,
        isActive: msg.isActive,
        agentRole: msg.agentRole,
        editedAt: msg.editedAt,
      })
    );

    // Determine cursors for pagination
    const nextCursor = hasMore && orderedMessages.length > 0
      ? orderedMessages[0].id // First message (oldest) for loading even older messages
      : null;

    const prevCursor = orderedMessages.length > 0
      ? orderedMessages[orderedMessages.length - 1].id // Last message (newest) for loading newer messages
      : null;

    return NextResponse.json({
      messages: uiMessages,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        limit,
        direction
      }
    });
  } catch (error) {
    loggers.api.error('Error fetching messages:', error as Error);
    return NextResponse.json({ 
      error: 'Failed to fetch messages' 
    }, { status: 500 });
  }
}

/**
 * POST - Send a message to the conversation (streaming chat)
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const usageLogger = loggers.api.child({ module: 'global-assistant-usage' });
    loggers.api.debug('🚀 Global Assistant Chat API: Starting request processing', {});

    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      loggers.api.debug('❌ Global Assistant Chat API: Authentication failed', {});
      return auth.error;
    }
    const userId = auth.userId;

    const { id: conversationId } = await context.params;
    loggers.api.debug('✅ Global Assistant Chat API: Authentication successful, userId:', { userId });

    // Verify user owns the conversation
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        eq(conversations.isActive, true)
      ));

    if (!conversation) {
      return NextResponse.json({ 
        error: 'Conversation not found' 
      }, { status: 404 });
    }

    // Parse request body
    const requestBody = await request.json();
    loggers.api.debug('📦 Global Assistant Chat API: Request body received:', {
      messageCount: requestBody.messages?.length || 0,
      conversationId,
      selectedProvider: requestBody.selectedProvider,
      selectedModel: requestBody.selectedModel,
      hasLocationContext: !!requestBody.locationContext
    });
    
    const {
      messages: requestMessages, // Used ONLY to extract new user message, NOT for conversation history
      selectedProvider,
      selectedModel,
      openRouterApiKey,
      googleApiKey,
      openAIApiKey,
      anthropicApiKey,
      xaiApiKey,
      ollamaBaseUrl,
      glmApiKey,
      locationContext,
      agentRole: roleString,
      mcpTools
    } = requestBody;

    // Validate required parameters
    if (!requestMessages || requestMessages.length === 0) {
      loggers.api.debug('❌ Global Assistant Chat API: No messages provided', {});
      return NextResponse.json({ error: 'messages are required' }, { status: 400 });
    }
    
    loggers.api.debug('✅ Global Assistant Chat API: Validation passed', { messageCount: requestMessages.length, conversationId });
    
    // Process @mentions in the user's message
    let mentionSystemPrompt = '';
    let mentionedPageIds: string[] = [];
    
    // Save user's message immediately to database
    const userMessage = requestMessages[requestMessages.length - 1];
    if (userMessage && userMessage.role === 'user') {
      try {
        const messageId = userMessage.id || createId();
        const messageContent = extractMessageContent(userMessage);
        
        // Process @mentions in the user message
        const processedMessage = processMentionsInMessage(messageContent);
        mentionedPageIds = processedMessage.pageIds;
        
        if (processedMessage.mentions.length > 0) {
          mentionSystemPrompt = buildMentionSystemPrompt(processedMessage.mentions);
          loggers.api.info('Global Assistant Chat API: Found @mentions in user message', {
            mentionCount: processedMessage.mentions.length,
            pageIds: mentionedPageIds
          });
        }
        
        loggers.api.debug('💾 Global Assistant Chat API: Saving user message immediately:', { id: messageId, contentLength: messageContent.length });
        
        await saveGlobalAssistantMessageToDatabase({
          messageId,
          conversationId,
          userId,
          role: 'user',
          content: messageContent,
          toolCalls: undefined,
          toolResults: undefined,
          uiMessage: userMessage, // Pass UIMessage to preserve part ordering
          agentRole: 'PARTNER',
        });

        // Update conversation lastMessageAt and auto-generate title if needed
        const updateData: {
          lastMessageAt: Date;
          updatedAt: Date;
          title?: string;
        } = {
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        };

        if (!conversation.title) {
          // Auto-generate title from first user message
          const title = messageContent.slice(0, 50) + (messageContent.length > 50 ? '...' : '');
          updateData.title = title;
        }

        await db
          .update(conversations)
          .set(updateData)
          .where(eq(conversations.id, conversationId));
        
        loggers.api.debug('✅ Global Assistant Chat API: User message saved to database', {});
      } catch (error) {
        loggers.api.error('❌ Global Assistant Chat API: Failed to save user message:', error as Error);
        return NextResponse.json({
          error: 'Failed to save message to database',
          details: error instanceof Error ? error.message : 'Unknown database error',
          userMessage: userMessage // Preserve user input for retry
        }, { status: 500 });
      }
    }
    
    // Create AI provider using factory service
    const providerRequest: ProviderRequest = {
      selectedProvider,
      selectedModel,
      googleApiKey,
      openRouterApiKey,
      openAIApiKey,
      anthropicApiKey,
      xaiApiKey,
      ollamaBaseUrl,
      glmApiKey,
    };

    const providerResult = await createAIProvider(userId, providerRequest);

    if (isProviderError(providerResult)) {
      return createProviderErrorResponse(providerResult);
    }

    const { model, provider: currentProvider, modelName: currentModel } = providerResult;

    // Update user's current provider/model if changed
    await updateUserProviderSettings(userId, selectedProvider, selectedModel);

    // RATE LIMIT CHECK: Verify user has remaining quota BEFORE streaming
    // This prevents users from exceeding their daily AI call limits
    if (currentProvider === 'pagespace') {
      const isProModel = currentModel === 'glm-4.6';
      const providerType = isProModel ? 'pro' : 'standard';

      loggers.api.debug('🚦 Global Assistant Chat API: Checking rate limit before streaming', {
        userId: maskIdentifier(userId),
        provider: currentProvider,
        model: currentModel,
        providerType,
        conversationId
      });

      const currentUsage = await getCurrentUsage(userId, providerType);

      if (!currentUsage.success || currentUsage.remainingCalls <= 0) {
        loggers.api.warn('🚫 Global Assistant Chat API: Rate limit exceeded', {
          userId: maskIdentifier(userId),
          providerType,
          currentCount: currentUsage.currentCount,
          limit: currentUsage.limit,
          remaining: currentUsage.remainingCalls,
          conversationId
        });

        return createRateLimitResponse(providerType, currentUsage.limit);
      }

      loggers.api.debug('✅ Global Assistant Chat API: Rate limit check passed', {
        userId: maskIdentifier(userId),
        providerType,
        remaining: currentUsage.remainingCalls,
        limit: currentUsage.limit,
        conversationId
      });
    }

    // Get agent role with fallback to default
    const agentRole = AgentRoleUtils.getRoleFromString(roleString);
    loggers.api.debug('🤖 Global Assistant Chat API: Using agent role', { agentRole });

    // DATABASE-FIRST ARCHITECTURE:
    // PageSpace uses database as the single source of truth for all messages.
    // We MUST read conversation history from database, not from client's request.
    // This ensures edited messages, multi-user changes, and any database updates
    // are reflected in the AI's context immediately.
    loggers.api.debug('📚 Global Assistant Chat API: Loading conversation history from database', {
      conversationId
    });

    // Read ALL active messages from database (source of truth)
    const dbMessages = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.conversationId, conversationId),
        eq(messages.isActive, true)
      ))
      .orderBy(messages.createdAt);

    // Convert database messages to UI format
    const conversationHistory = dbMessages.map(msg =>
      convertGlobalAssistantMessageToUIMessage({
        id: msg.id,
        conversationId: msg.conversationId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        createdAt: msg.createdAt,
        isActive: msg.isActive,
        agentRole: msg.agentRole,
        editedAt: msg.editedAt,
      })
    );

    loggers.api.debug('✅ Global Assistant Chat API: Loaded conversation history from database', {
      messageCount: conversationHistory.length,
      conversationId
    });

    // Convert UIMessages to ModelMessages for the AI model
    // NOTE: We use database-loaded messages, NOT requestMessages from client
    const sanitizedMessages = sanitizeMessagesForModel(conversationHistory);
    
    // Process messages to inject visual content from previous tool calls
    // Limit history to prevent memory issues with large conversations
    const MAX_MESSAGES_WITH_IMAGES = 10; // Limit messages with images to prevent memory issues
    const recentMessages = sanitizedMessages.slice(-MAX_MESSAGES_WITH_IMAGES);
    
    const processedMessages = recentMessages.map((msg: UIMessage) => {
      if (msg.role === 'assistant' && msg.parts) {
        // Check if any tool results contain visual content to inject
        const toolResults = msg.parts.filter((part) => {
          if (part && typeof part === 'object' && 'type' in part && part.type === 'tool-result') {
            const result = (part as { result?: unknown }).result;
            if (result && typeof result === 'object' && 'type' in result && 'imageDataUrl' in result) {
              return (result as { type: string }).type === 'visual_content';
            }
          }
          return false;
        });
        
        if (toolResults.length > 0) {
          // Create new parts array with injected images
          const newParts = [...msg.parts];
          
          // Add image parts for each visual result
          toolResults.forEach((toolResult) => {
            const result = (toolResult as { result?: { imageDataUrl?: string; title?: string } }).result;
            if (result?.imageDataUrl) {
              // Add a data part that contains the visual content
              // This will be processed by the client to display the image
              newParts.push({
                type: 'data-visual-content' as const,
                data: {
                  imageDataUrl: result.imageDataUrl,
                  title: result.title || 'Visual content'
                }
              });
              
              // Clear the original imageDataUrl from tool result to save memory
              const mutableResult = result as { imageDataUrl?: string; title?: string };
              delete mutableResult.imageDataUrl;
            }
          });
          
          return { ...msg, parts: newParts };
        }
      }
      return msg;
    });
    
    const modelMessages = convertToModelMessages(processedMessages);

    // Build role-aware system prompt with context
    const contextType = locationContext?.currentPage ? 'page' : 
                       locationContext?.currentDrive ? 'drive' : 
                       'dashboard';
    
    const baseSystemPrompt = RolePromptBuilder.buildSystemPrompt(
      agentRole,
      contextType,
      locationContext ? {
        driveName: locationContext.currentDrive?.name,
        driveSlug: locationContext.currentDrive?.slug,
        pagePath: locationContext.currentPage?.path,
        pageType: locationContext.currentPage?.type,
        breadcrumbs: locationContext.breadcrumbs,
      } : undefined
    );

    // Build timestamp system prompt for temporal awareness
    const timestampSystemPrompt = buildTimestampSystemPrompt();

    // Add global assistant specific instructions
    const systemPrompt = baseSystemPrompt + mentionSystemPrompt + timestampSystemPrompt + `

You are the Global Assistant for PageSpace - accessible from both the dashboard and sidebar.

TASK MANAGEMENT:
• Use create_task_list for any multi-step work (3+ actions) - this creates interactive UI components in the conversation
• Break complex requests into trackable tasks immediately upon receiving them  
• Update task status as you progress through work - users see real-time updates
• Task lists persist across conversations and appear as conversation messages

CRITICAL NESTING PRINCIPLE:
• NO RESTRICTIONS on what can contain what - organize based on logical user needs
• Documents can contain AI chats, channels, folders, and canvas pages
• AI chats can contain documents, other AI chats, folders, and any page type
• Channels can contain any page type for organized discussion threads  
• Canvas pages can contain any page type for custom navigation structures
• Think creatively about nesting - optimize for user workflow, not type conventions

${locationContext ? `
CONTEXT-AWARE BEHAVIOR:
• You are currently in: ${locationContext.currentDrive?.name || 'dashboard'} ${locationContext.currentPage ? `> ${locationContext.currentPage.title}` : ''}
• Default scope: Operations should focus on this location unless user indicates otherwise
• When user says "here" or "this", they mean the current location
• Only explore other drives/areas when explicitly mentioned or necessary for the task
• Start from current context, not from list_drives
` : `
DASHBOARD CONTEXT:
• You are in the dashboard view - focus on cross-workspace tasks and overview
• Use list_drives when you need to work across multiple workspaces
• Help with personal productivity and workspace organization
• create_drive: Use when user explicitly requests new workspace OR when their project clearly doesn't fit existing drives
• Always check existing drives first via list_drives before suggesting new drive creation
• Ask for confirmation unless user is explicit about creating new workspace
`}

SMART EXPLORATION RULES:
1. When in a drive context - ALWAYS explore it first:
   - If locationContext includes a drive, ALWAYS use list_pages on that drive when:
     • User asks about the drive, its contents, or what's available
     • User wants to create, write, or modify ANYTHING
     • User mentions something that MAY exist in the drive
     • User asks general questions about content or organization
     • You need to understand the workspace structure
   - Start with list_pages(driveId: '${locationContext?.currentDrive?.id || 'current-drive-id'}') BEFORE other actions
2. Context-first approach:
   - Default scope: Current drive/location is your primary workspace
   - Only explore OTHER drives when explicitly mentioned
   - When user says "here" or "this", they mean current context
3. Efficient exploration pattern:
   - FIRST: list_pages with driveId on current drive (if in a drive)
   - THEN: read specific pages as needed
   - ONLY IF NEEDED: explore other drives/workspaces
4. Proactive assistance:
   - Don't ask "what's in your drive" - use list_pages to discover
   - Suggest creating AI_CHAT and CHANNEL pages for organization
   - Be autonomous within current context

CONVERSATION TYPE: ${conversation.type.toUpperCase()}${conversation.contextId ? ` (Context: ${conversation.contextId})` : ''}

MENTION PROCESSING:
• When users @mention documents using @[Label](id:type) format, you MUST read those documents first
• Use the read_page tool for each mentioned document before providing your main response
• Let mentioned document content inform and enrich your response
• Don't explicitly mention that you're reading @mentioned docs unless relevant to the conversation`;

    // Filter tools based on agent role permissions
    let finalTools = ToolPermissionFilter.filterTools(pageSpaceTools, agentRole);

    // Merge MCP tools if provided
    if (mcpTools && mcpTools.length > 0) {
      try {
        loggers.api.info('Global Assistant Chat API: Integrating MCP tools from desktop', {
          mcpToolCount: mcpTools.length,
          toolNames: mcpTools.map((t: MCPTool) => `mcp:${t.serverName}:${t.name}`),
          userId: maskIdentifier(userId),
          conversationId
        });

        // Convert MCP tools to AI SDK format
        const mcpToolSchemas = convertMCPToolsToAISDKSchemas(mcpTools);

        // Create execute functions that proxy to WebSocket bridge
        const mcpToolsWithExecute: Record<string, unknown> = {};
        for (const [toolName, toolSchema] of Object.entries(mcpToolSchemas)) {
          mcpToolsWithExecute[toolName] = {
            ...toolSchema,
            execute: async (args: Record<string, unknown>) => {
              // Parse tool name using shared parser (supports both mcp:server:tool and legacy mcp__server__tool)
              const parsed = parseMCPToolName(toolName);
              if (!parsed) {
                throw new Error(`Invalid MCP tool name format: ${toolName}`);
              }
              const { serverName, toolName: originalToolName } = parsed;

              loggers.api.debug('MCP Tool Execute: Calling tool via bridge', {
                toolName,
                serverName,
                originalToolName,
                userId: maskIdentifier(userId)
              });

              // executeTool returns Promise<unknown> - resolves with result or rejects with error
              const result = await getMCPBridge().executeTool(userId, serverName, originalToolName, args);
              return result;
            }
          };
        }

        // Merge MCP tools with PageSpace tools
        finalTools = { ...finalTools, ...mcpToolsWithExecute } as Record<string, unknown>;

        loggers.api.info('Global Assistant Chat API: Successfully merged MCP tools', {
          totalTools: Object.keys(finalTools).length,
          mcpTools: Object.keys(mcpToolSchemas).length,
          pageSpaceTools: Object.keys(finalTools).length - Object.keys(mcpToolSchemas).length
        });
      } catch (error) {
        loggers.api.error('Global Assistant Chat API: Failed to integrate MCP tools', error as Error, {
          userId: maskIdentifier(userId),
          conversationId
        });
        // Continue without MCP tools rather than failing the entire request
      }
    } else {
      loggers.api.debug('Global Assistant Chat API: No MCP tools provided in request', {
        userId: maskIdentifier(userId),
        conversationId
      });
    }

    loggers.api.debug('🔄 Global Assistant Chat API: Starting streamText', { model: currentModel, agentRole });

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools: finalTools,
      stopWhen: stepCountIs(100),
      abortSignal: request.signal, // Enable stop/abort functionality from client
      experimental_context: {
        userId,
        locationContext,
        modelCapabilities: getModelCapabilities(currentModel, currentProvider)
      },
      maxRetries: 20, // Increase from default 2 to 20 for better handling of rate limits
      onAbort: () => {
        loggers.api.info('🛑 Global Assistant Chat API: Stream aborted by user', {
          userId: maskIdentifier(userId),
          conversationId,
          model: currentModel,
          provider: currentProvider
        });
      },
    });

    loggers.api.debug('📡 Global Assistant Chat API: Returning stream response', {});
    
    return result.toUIMessageStreamResponse({
      onFinish: async ({ responseMessage }) => {
        loggers.api.debug('🏁 Global Assistant Chat API: onFinish callback triggered for AI response', {});
        
        if (responseMessage) {
          try {
            const messageId = responseMessage.id || createId();
            const messageContent = extractMessageContent(responseMessage);
            const extractedToolCalls = extractToolCalls(responseMessage);
            const extractedToolResults = extractToolResults(responseMessage);
            
            loggers.api.debug('💾 Global Assistant Chat API: Saving AI response message:', { 
              id: messageId, 
              contentLength: messageContent.length,
              toolCallsCount: extractedToolCalls.length,
              toolResultsCount: extractedToolResults.length,
            });
            
            await saveGlobalAssistantMessageToDatabase({
              messageId,
              conversationId,
              userId,
              role: 'assistant',
              content: messageContent,
              toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
              toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
              uiMessage: responseMessage, // Pass complete UIMessage to preserve part ordering
              agentRole,
            });

            // Update conversation lastMessageAt
            await db
              .update(conversations)
              .set({
                lastMessageAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(conversations.id, conversationId));

            loggers.api.debug('✅ Global Assistant Chat API: AI response message saved to database', {});

            // Track usage for PageSpace providers only (rate limiting/quota tracking)
            const isPageSpaceProvider = currentProvider === 'pagespace';

            const maskedUserId = maskIdentifier(userId);
            const maskedConversationId = maskIdentifier(conversationId);
            const maskedMessageId = maskIdentifier(messageId);

            usageLogger.info('Global Assistant usage tracking decision', {
              userId: maskedUserId,
              provider: currentProvider,
              isPageSpaceProvider,
              messageId: maskedMessageId,
              conversationId: maskedConversationId,
            });

            if (isPageSpaceProvider) {
              try {
                // Determine if this is pro model based on model name
                const isProModel = currentModel === 'glm-4.6';
                const providerType = isProModel ? 'pro' : 'standard';

                usageLogger.debug('Incrementing usage for Global Assistant response', {
                  userId: maskedUserId,
                  provider: currentProvider,
                  providerType,
                  messageId: maskedMessageId,
                  conversationId: maskedConversationId,
                });

                const usageResult = await incrementUsage(userId, providerType);

                usageLogger.info('Global Assistant usage incremented', {
                  userId: maskedUserId,
                  provider: currentProvider,
                  providerType,
                  messageId: maskedMessageId,
                  conversationId: maskedConversationId,
                  currentCount: usageResult.currentCount,
                  limit: usageResult.limit,
                  remaining: usageResult.remainingCalls,
                  success: usageResult.success,
                });

                // Broadcast usage event for real-time updates
                try {
                  const currentUsageSummary = await getUserUsageSummary(userId);

                  await broadcastUsageEvent({
                    userId,
                    operation: 'updated',
                    subscriptionTier: currentUsageSummary.subscriptionTier as 'free' | 'pro',
                    standard: currentUsageSummary.standard,
                    pro: currentUsageSummary.pro
                  });

                  usageLogger.debug('Global Assistant usage broadcast sent', {
                    userId: maskedUserId,
                    conversationId: maskedConversationId,
                  });
                } catch (broadcastError) {
                  usageLogger.error('Global Assistant usage broadcast failed', broadcastError instanceof Error ? broadcastError : undefined, {
                    userId: maskedUserId,
                    conversationId: maskedConversationId,
                  });
                }

              } catch (usageError) {
                usageLogger.error('Global Assistant usage tracking failed', usageError as Error, {
                  userId: maskedUserId,
                  provider: currentProvider,
                  messageId: maskedMessageId,
                  conversationId: maskedConversationId,
                });

                // Don't fail the request - usage tracking errors shouldn't break the chat
              }
            } else {
              usageLogger.debug('Skipping usage tracking for non-PageSpace provider', {
                provider: currentProvider,
                userId: maskedUserId,
                messageId: maskedMessageId,
                conversationId: maskedConversationId,
              });
            }
          } catch (error) {
            loggers.api.error('❌ Global Assistant Chat API: Failed to save AI response message:', error as Error);
          }
        }
      },
    });

  } catch (error) {
    loggers.api.error('Global Assistant Chat API Error:', error as Error);
    
    return NextResponse.json({ 
      error: 'Failed to process chat request. Please try again.' 
    }, { status: 500 });
  }
}