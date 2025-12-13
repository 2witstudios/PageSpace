import { NextResponse } from 'next/server';
import {
  streamText,
  convertToModelMessages,
  UIMessage,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModelUsage,
} from 'ai';
import { incrementUsage, getCurrentUsage, getUserUsageSummary } from '@/lib/subscription/usage-service';
import { requiresProSubscription, createRateLimitResponse } from '@/lib/subscription/rate-limit-middleware';
import { broadcastUsageEvent } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import {
  createAIProvider,
  updateUserProviderSettings,
  createProviderErrorResponse,
  isProviderError,
  type ProviderRequest,
  getUserOpenRouterSettings,
  getUserGoogleSettings,
  getDefaultPageSpaceSettings,
  getUserOpenAISettings,
  getUserAnthropicSettings,
  getUserXAISettings,
  getUserOllamaSettings,
  getUserLMStudioSettings,
  getUserGLMSettings,
  pageSpaceTools,
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
  saveMessageToDatabase,
  sanitizeMessagesForModel,
  convertDbMessageToUIMessage,
  processMentionsInMessage,
  buildTimestampSystemPrompt,
  buildSystemPrompt,
  filterToolsForReadOnly,
  getPageTreeContext,
  getModelCapabilities,
  convertMCPToolsToAISDKSchemas,
  parseMCPToolName,
} from '@/lib/ai/core';
import { db, users, chatMessages, pages, drives, eq, and } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { trackFeature } from '@pagespace/lib/activity-tracker';
import { AIMonitoring } from '@pagespace/lib/ai-monitoring';
import type { MCPTool } from '@/types/mcp';
import { getMCPBridge } from '@/lib/mcp';


// Allow streaming responses up to 5 minutes for complex AI agent interactions
export const maxDuration = 300;


/**
 * Next.js 15 compatible API route for AI chat
 * Implements reliable persistence by saving user messages immediately
 * Supports multi-provider architecture: OpenRouter and Google AI
 */
export async function POST(request: Request) {
  const startTime = Date.now();
  let userId: string | undefined;
  let chatId: string | undefined;
  let conversationId: string | undefined;
  let selectedProvider: string | undefined;
  let selectedModel: string | undefined;
  let usagePromise: Promise<LanguageModelUsage | undefined> | undefined;
  const usageLogger = loggers.ai.child({ module: 'page-ai-usage' });
  const permissionLogger = loggers.ai.child({ module: 'page-ai-permissions' });

  try {
    loggers.ai.info('AI Chat API: Starting request processing');

    // Authenticate the request
    const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(authResult)) {
      loggers.ai.warn('AI Chat API: Authentication failed');
      return authResult.error;
    }
    userId = authResult.userId;
    loggers.ai.debug('AI Chat API: Authentication successful', { userId });

    // Parse request body for AI SDK v5 pattern
    const requestBody = await request.json();
    loggers.ai.debug('AI Chat API: Request body received', {
      messageCount: requestBody.messages?.length || 0,
      chatId: requestBody.chatId,
      selectedProvider: requestBody.selectedProvider,
      selectedModel: requestBody.selectedModel,
      hasOpenRouterKey: !!requestBody.openRouterApiKey,
      hasGoogleKey: !!requestBody.googleApiKey
    });
    
    const {
      messages, // Used ONLY to extract new user message, NOT for conversation history
      chatId: requestChatId, // chat ID (page ID) - standard AI SDK pattern
      conversationId: requestConversationId, // Conversation session ID (auto-generated if not provided)
      selectedProvider: requestSelectedProvider,
      selectedModel: requestSelectedModel,
      openRouterApiKey,
      googleApiKey,
      openAIApiKey,
      anthropicApiKey,
      xaiApiKey,
      ollamaBaseUrl,
      glmApiKey,
      pageContext,
      mcpTools, // MCP tool schemas from desktop client (optional)
      isReadOnly, // Optional read-only mode toggle
    }: {
      messages: UIMessage[],
      chatId?: string,
      conversationId?: string, // Optional - will be auto-generated if not provided
      selectedProvider?: string,
      selectedModel?: string,
      openRouterApiKey?: string,
      googleApiKey?: string,
      openAIApiKey?: string,
      anthropicApiKey?: string,
      xaiApiKey?: string,
      ollamaBaseUrl?: string,
      glmApiKey?: string,
      mcpTools?: MCPTool[], // MCP tool schemas from desktop (client-side execution)
      isReadOnly?: boolean, // Optional read-only mode toggle
      pageContext?: {
        pageId: string,
        pageTitle: string,
        pageType: string,
        pagePath: string,
        parentPath: string,
        breadcrumbs: string[],
        driveId?: string,
        driveName: string,
        driveSlug: string,
      }
    } = requestBody;

    // Assign to outer scope variables for error handling
    chatId = requestChatId;
    selectedProvider = requestSelectedProvider;
    selectedModel = requestSelectedModel;

    // For Page AI, we'll use custom agent configuration instead of fixed roles
    // Global assistant will continue to use the role system
    loggers.ai.debug('AI Page Chat API: Page AI using custom agent configuration');

    // Validate required parameters
    if (!messages || messages.length === 0) {
      loggers.ai.warn('AI Chat API: No messages provided');
      return NextResponse.json({ error: 'messages are required' }, { status: 400 });
    }
    
    if (!chatId) {
      loggers.ai.warn('AI Chat API: No chatId provided');
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 });
    }

    // Ensure userId and chatId are defined
    if (!userId) {
      loggers.ai.warn('AI Chat API: No userId after authentication');
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
    }

    // Check if user has permission to view and edit this AI chat page
    const maskedUserId = maskIdentifier(userId);
    const maskedChatId = maskIdentifier(chatId);
    permissionLogger.debug('Evaluating Page AI permissions', {
      userId: maskedUserId,
      chatId: maskedChatId,
    });
    const canView = await canUserViewPage(userId, chatId);
    permissionLogger.debug('Page AI view permission evaluated', {
      userId: maskedUserId,
      chatId: maskedChatId,
      allowed: canView,
    });
    if (!canView) {
      loggers.ai.warn('AI Chat API: User lacks view permission', { userId: maskedUserId, chatId: maskedChatId });
      permissionLogger.warn('Page AI view permission denied', {
        userId: maskedUserId,
        chatId: maskedChatId,
      });
      return NextResponse.json({ error: 'You do not have permission to view this AI chat' }, { status: 403 });
    }

    const canEdit = await canUserEditPage(userId, chatId);
    permissionLogger.debug('Page AI edit permission evaluated', {
      userId: maskedUserId,
      chatId: maskedChatId,
      allowed: canEdit,
    });
    if (!canEdit) {
      loggers.ai.warn('AI Chat API: User lacks edit permission', { userId: maskedUserId, chatId: maskedChatId });
      permissionLogger.warn('Page AI edit permission denied', {
        userId: maskedUserId,
        chatId: maskedChatId,
      });
      return NextResponse.json({ error: 'You do not have permission to send messages in this AI chat' }, { status: 403 });
    }

    permissionLogger.info('Page AI permissions granted', {
      userId: maskedUserId,
      chatId: maskedChatId,
    });
    
    loggers.ai.info('AI Chat API: Validation passed', { 
      messageCount: messages.length, 
      chatId 
    });

    // Get page configuration for custom agent settings (needed early for message saving)
    const [page] = await db.select().from(pages).where(eq(pages.id, chatId));
    if (!page) {
      loggers.ai.warn('AI Chat API: Page not found', { chatId });
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    // Extract custom agent configuration from page
    const customSystemPrompt = page.systemPrompt;
    const enabledTools = page.enabledTools as string[] | null;

    // Fetch drive prompt if page has includeDrivePrompt enabled
    let drivePromptPrefix = '';
    if (page.includeDrivePrompt) {
      try {
        const [drive] = await db
          .select({ drivePrompt: drives.drivePrompt })
          .from(drives)
          .where(eq(drives.id, page.driveId))
          .limit(1);

        if (drive?.drivePrompt?.trim()) {
          drivePromptPrefix = `## DRIVE INSTRUCTIONS\n\n${drive.drivePrompt}\n\n---\n\n`;
          loggers.ai.debug('AI Page Chat API: Including drive prompt', {
            driveId: page.driveId,
            promptLength: drive.drivePrompt.length
          });
        }
      } catch (error) {
        loggers.ai.error('AI Page Chat API: Failed to fetch drive prompt', error as Error);
        // Continue without drive prompt on error
      }
    }

    loggers.ai.debug('AI Page Chat API: Using custom agent configuration', {
      hasCustomSystemPrompt: !!customSystemPrompt,
      enabledToolsCount: enabledTools?.length || 0,
      pageName: page.title,
      includeDrivePrompt: page.includeDrivePrompt,
      hasDrivePrompt: !!drivePromptPrefix
    });

    // Auto-generate conversationId if not provided (seamless UX)
    conversationId = requestConversationId || createId();
    loggers.ai.debug('AI Chat API: Conversation session', {
      conversationId,
      isNewConversation: !requestConversationId
    });

    // Process @mentions in the user's message
    let mentionedPageIds: string[] = [];

    // Save user's message immediately to database (database-first approach)
    const userMessage = messages[messages.length - 1]; // Last message is the new user message
    let userPromptContent: string | undefined;
    if (userMessage && userMessage.role === 'user') {
      try {
        const messageId = userMessage.id || createId();
        const messageContent = extractMessageContent(userMessage);
        userPromptContent = messageContent;
        
        // Process @mentions in the user message
        const processedMessage = processMentionsInMessage(messageContent);
        mentionedPageIds = processedMessage.pageIds;
        
        if (processedMessage.mentions.length > 0) {
          loggers.ai.info('AI Chat API: Found @mentions in user message', {
            mentionCount: processedMessage.mentions.length,
            pageIds: mentionedPageIds
          });
        }
        
        loggers.ai.debug('AI Chat API: Saving user message immediately', { id: messageId, contentLength: messageContent.length });

        await db.insert(chatMessages).values({
          id: messageId,
          pageId: chatId,
          conversationId, // Group messages into conversation sessions
          userId,
          role: 'user',
          content: messageContent,
          toolCalls: null,
          toolResults: null,
          createdAt: new Date(),
          isActive: true,
        });
        
        loggers.ai.debug('AI Chat API: User message saved to database');
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to save user message', error as Error);
        return NextResponse.json({
          error: 'Failed to save message to database',
          details: error instanceof Error ? error.message : 'Unknown database error',
          userMessage: userMessage // Preserve user input for retry
        }, { status: 500 });
      }
    }
    
    // Get user's current AI provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const currentProvider = selectedProvider || user?.currentAiProvider || 'pagespace';
    const currentModel = selectedModel || user?.currentAiModel || 'glm-4.5-air';

    // Pro subscription check for special providers
    const { requiresProSubscription, createSubscriptionRequiredResponse } = await import('@/lib/subscription/rate-limit-middleware');

    // Check if provider requires Pro subscription
    if (requiresProSubscription(currentProvider, currentModel, user?.subscriptionTier)) {
      loggers.ai.warn('AI Chat API: Pro subscription required', {
        userId,
        provider: currentProvider,
        model: currentModel,
        subscriptionTier: user?.subscriptionTier
      });
      return createSubscriptionRequiredResponse();
    }

    // Usage tracking will be handled in onFinish callback for PageSpace providers only
    loggers.ai.debug('AI Chat API: Will track usage in onFinish for PageSpace providers', {
      userId,
      provider: currentProvider,
      isPageSpaceProvider: currentProvider === 'pagespace'
    });
    
    // Update page's AI provider/model if changed
    if (selectedProvider && selectedModel && chatId) {
      if (selectedProvider !== page.aiProvider || selectedModel !== page.aiModel) {
        await db
          .update(pages)
          .set({
            aiProvider: selectedProvider,
            aiModel: selectedModel,
          })
          .where(eq(pages.id, chatId));
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

    const { model } = providerResult;

    // Update user's current provider/model if changed
    await updateUserProviderSettings(userId, selectedProvider, selectedModel);

    // RATE LIMIT CHECK: Verify user has remaining quota BEFORE streaming
    // This prevents users from exceeding their daily AI call limits
    if (currentProvider === 'pagespace') {
      const isProModel = currentModel === 'glm-4.6';
      const providerType = isProModel ? 'pro' : 'standard';

      loggers.ai.debug('🚦 AI Chat API: Checking rate limit before streaming', {
        userId: maskIdentifier(userId),
        provider: currentProvider,
        model: currentModel,
        providerType,
        pageId: chatId
      });

      const currentUsage = await getCurrentUsage(userId, providerType);

      if (!currentUsage.success || currentUsage.remainingCalls <= 0) {
        loggers.ai.warn('🚫 AI Chat API: Rate limit exceeded', {
          userId: maskIdentifier(userId),
          providerType,
          currentCount: currentUsage.currentCount,
          limit: currentUsage.limit,
          remaining: currentUsage.remainingCalls,
          pageId: chatId
        });

        return createRateLimitResponse(providerType, currentUsage.limit);
      }

      loggers.ai.debug('✅ AI Chat API: Rate limit check passed', {
        userId: maskIdentifier(userId),
        providerType,
        remaining: currentUsage.remainingCalls,
        limit: currentUsage.limit,
        pageId: chatId
      });
    }

    // Parse read-only mode (defaults to false for full access)
    const readOnlyMode = isReadOnly === true;
    loggers.ai.debug('AI Page Chat API: Read-only mode', { isReadOnly: readOnlyMode });

    // Filter tools based on custom enabled tools configuration
    // - null or [] = no tools enabled (default behavior)
    // - ['tool1', 'tool2'] = specific tools → use only those
    let filteredTools;
    if (enabledTools === null || enabledTools.length === 0) {
      // No tools configured - default to no tools
      filteredTools = {};
      loggers.ai.debug('AI Page Chat API: No tools enabled', {
        totalTools: Object.keys(pageSpaceTools).length,
        enabledTools: 0,
        filteredTools: 0,
        isReadOnly: readOnlyMode
      });
    } else {
      // Filter tools based on the page's enabled tools configuration
      // Simple object filtering approach to avoid complex TypeScript issues
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filtered: Record<string, any> = {};
      for (const toolName of enabledTools) {
        if (toolName in pageSpaceTools) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filtered[toolName] = (pageSpaceTools as any)[toolName];
        }
      }
      // Apply read-only filtering on top of enabled tools
      filteredTools = filterToolsForReadOnly(filtered, readOnlyMode);

      loggers.ai.debug('AI Page Chat API: Filtered tools based on page configuration', {
        totalTools: Object.keys(pageSpaceTools).length,
        enabledTools: enabledTools.length,
        filteredTools: Object.keys(filteredTools).length,
        isReadOnly: readOnlyMode
      });
    }

    // DESKTOP MCP INTEGRATION: Merge MCP tools from client if provided
    if (mcpTools && mcpTools.length > 0) {
      try {
        loggers.ai.info('AI Chat API: Integrating MCP tools from desktop', {
          mcpToolCount: mcpTools.length,
          toolNames: mcpTools.map(t => `mcp:${t.serverName}:${t.name}`),
          userId: maskIdentifier(userId),
          chatId: maskIdentifier(chatId)
        });

        // Convert MCP tools to AI SDK format (schemas only, no execute functions)
        const mcpToolSchemas = convertMCPToolsToAISDKSchemas(mcpTools);

        // Create execute functions that signal client-side execution
        // The AI SDK will call these, but we throw a special error that the client intercepts
        const mcpToolsWithExecute: Record<string, unknown> = {};
        for (const [toolName, toolSchema] of Object.entries(mcpToolSchemas)) {
          mcpToolsWithExecute[toolName] = {
            ...toolSchema,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            execute: async (args: any) => {
              // Ensure userId is defined (it should be from authentication)
              if (!userId) {
                throw new Error('User ID not available for MCP tool execution');
              }

              // Parse tool name using shared parser (supports both mcp:server:tool and legacy mcp__server__tool)
              const parsed = parseMCPToolName(toolName);
              if (!parsed) {
                loggers.ai.error('AI Chat API: Invalid MCP tool name format', {
                  toolName,
                  userId: maskIdentifier(userId)
                });
                throw new Error(`Invalid MCP tool name format: ${toolName}`);
              }

              const { serverName, toolName: actualToolName } = parsed;

              loggers.ai.debug('AI Chat API: Executing MCP tool via WebSocket bridge', {
                toolName: actualToolName,
                serverName,
                userId: maskIdentifier(userId),
                hasArgs: !!args
              });

              try {
                const mcpBridge = getMCPBridge();

                // Check if user is connected
                if (!mcpBridge.isUserConnected(userId)) {
                  const errorMsg = 'Desktop app not connected. Please ensure PageSpace Desktop is running.';
                  loggers.ai.warn('AI Chat API: User not connected to desktop', {
                    userId: maskIdentifier(userId),
                    toolName: actualToolName,
                    serverName
                  });
                  throw new Error(errorMsg);
                }

                // Execute tool via WebSocket bridge
                const result = await mcpBridge.executeTool(
                  userId,
                  serverName,
                  actualToolName,
                  args
                );

                loggers.ai.info('AI Chat API: MCP tool execution succeeded', {
                  toolName: actualToolName,
                  serverName,
                  userId: maskIdentifier(userId)
                });

                return result;
              } catch (error) {
                loggers.ai.error('AI Chat API: MCP tool execution failed', error as Error, {
                  toolName: actualToolName,
                  serverName,
                  userId: maskIdentifier(userId)
                });
                throw error;
              }
            }
          };
        }

        // Merge MCP tools with PageSpace tools
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filteredTools = { ...filteredTools, ...mcpToolsWithExecute } as any;

        // Sanitize tool names for Gemini - it doesn't allow multiple colons in function names
        // Convert mcp:servername:toolname to mcp__servername__toolname format
        // The parseMCPToolName function already supports both formats, so execute still works
        if (currentProvider === 'google' && filteredTools) {
          const sanitizedTools: Record<string, unknown> = {};
          for (const [originalName, tool] of Object.entries(filteredTools)) {
            const sanitizedName = originalName.replace(/:/g, '__');
            sanitizedTools[sanitizedName] = tool;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filteredTools = sanitizedTools as any;
          loggers.ai.debug('AI Chat API: Sanitized tool names for Gemini compatibility', {
            originalCount: Object.keys(mcpToolSchemas).length,
            example: Object.keys(sanitizedTools)[0]
          });
        }

        loggers.ai.info('AI Chat API: Successfully merged MCP tools', {
          totalTools: Object.keys(filteredTools).length,
          mcpTools: Object.keys(mcpToolSchemas).length,
          pageSpaceTools: Object.keys(filteredTools).length - Object.keys(mcpToolSchemas).length
        });
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to integrate MCP tools', error as Error, {
          userId: maskIdentifier(userId),
          chatId: maskIdentifier(chatId)
        });
        // Continue without MCP tools rather than failing the entire request
      }
    } else {
      loggers.ai.debug('AI Chat API: No MCP tools provided in request', {
        userId: maskIdentifier(userId),
        chatId: maskIdentifier(chatId)
      });
    }

    // DATABASE-FIRST ARCHITECTURE:
    // PageSpace uses database as the single source of truth for all messages.
    // We MUST read conversation history from database, not from client's request.
    // This ensures edited messages, multi-user changes, and any database updates
    // are reflected in the AI's context immediately.
    loggers.ai.debug('AI Chat API: Loading conversation history from database', {
      pageId: chatId
    });

    // Read messages from current conversation only (NOT all conversations on this page)
    // This ensures each conversation is isolated and the AI only sees the current conversation's context
    const dbMessages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, chatId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true)
      ))
      .orderBy(chatMessages.createdAt);

    // Convert database messages to UI format using proper conversion function
    // This handles structured content, tool calls, and tool results
    const conversationHistory = dbMessages.map(msg =>
      convertDbMessageToUIMessage({
        id: msg.id,
        pageId: msg.pageId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        createdAt: msg.createdAt,
        isActive: msg.isActive,
        editedAt: msg.editedAt,
      })
    );

    loggers.ai.debug('AI Chat API: Loaded conversation history from database', {
      messageCount: conversationHistory.length,
      pageId: chatId
    });

    // Convert UIMessages to ModelMessages for the AI model
    // First sanitize messages to remove tool parts without results (prevents "input-available" state errors)
    // NOTE: We use database-loaded messages, NOT messages from client
    const sanitizedMessages = sanitizeMessagesForModel(conversationHistory);
    const modelMessages = convertToModelMessages(sanitizedMessages, {
      tools: filteredTools  // Use original tools - no wrapping needed
    });

    // Build system prompt for Page AI - use custom system prompt if available, otherwise use default
    let systemPrompt: string;
    if (customSystemPrompt) {
      // Use custom system prompt with page context injected
      // Prepend drive prompt if enabled and available
      systemPrompt = drivePromptPrefix + customSystemPrompt;
      if (pageContext) {
        systemPrompt += `\n\nYou are operating within the page "${pageContext.pageTitle}" in the "${pageContext.driveName}" drive. Your current location: ${pageContext.pagePath}`;
      }
      // Add read-only constraint if applicable
      if (readOnlyMode) {
        systemPrompt += `\n\nREAD-ONLY MODE:\n• You cannot modify, create, or delete any content\n• Focus on exploring, analyzing, and planning\n• Create actionable plans for the user to execute later`;
      }
    } else {
      // Fallback to default PageSpace system prompt with read-only mode
      systemPrompt = buildSystemPrompt(
        'page',
        pageContext ? {
          driveName: pageContext.driveName,
          driveSlug: pageContext.driveSlug,
          driveId: pageContext.driveId,
          pagePath: pageContext.pagePath,
          pageType: pageContext.pageType,
          breadcrumbs: pageContext.breadcrumbs,
        } : undefined,
        readOnlyMode
      );
    }
    
    // Build timestamp system prompt for temporal awareness
    const timestampSystemPrompt = buildTimestampSystemPrompt();

    // Build page tree context if enabled
    let pageTreePrompt = '';
    if (page.includePageTree && page.driveId) {
      const pageTreeContext = await getPageTreeContext(userId, {
        scope: (page.pageTreeScope as 'children' | 'drive') || 'children',
        pageId: chatId,
        driveId: page.driveId,
      });
      if (pageTreeContext) {
        pageTreePrompt = `\n\n## WORKSPACE STRUCTURE\n\nHere is the ${page.pageTreeScope === 'drive' ? 'complete workspace' : 'page subtree'} structure:\n\n${pageTreeContext}`;
        loggers.ai.debug('AI Chat API: Page tree context included', {
          pageId: chatId,
          scope: page.pageTreeScope,
          contextLength: pageTreeContext.length
        });
      }
    }

    loggers.ai.debug('AI Chat API: Tools configured for Page AI', { toolCount: Object.keys(filteredTools).length });
    loggers.ai.info('AI Chat API: Starting streamText for Page AI', { model: currentModel, pageName: page.title });
    
    // Create UI message stream with visual content injection support
    // This handles the case where tools return visual content that needs to be injected into the stream
    let result;
    try {
      const stream = createUIMessageStream({
        originalMessages: sanitizedMessages,
        execute: async ({ writer }) => {
          // Start the AI response
          const aiResult = streamText({
            model,
            system: systemPrompt + timestampSystemPrompt + pageTreePrompt,
            messages: modelMessages,
            tools: filteredTools,  // Use original tools directly
            stopWhen: stepCountIs(100), // Allow up to 100 tool calls per conversation turn
            abortSignal: request.signal, // Enable stop/abort functionality from client
            experimental_context: {
              userId,
              locationContext: pageContext ? {
                currentPage: {
                  id: pageContext.pageId,
                  title: pageContext.pageTitle,
                  type: pageContext.pageType,
                  path: pageContext.pagePath,
                },
                currentDrive: pageContext.driveId ? {
                  id: pageContext.driveId,
                  name: pageContext.driveName,
                  slug: pageContext.driveSlug,
                } : undefined,
                breadcrumbs: pageContext.breadcrumbs,
              } : undefined,
              modelCapabilities: getModelCapabilities(currentModel, currentProvider)
            }, // Pass userId, location context, and model capabilities to tools
            maxRetries: 20, // Increase from default 2 to 20 for better handling of rate limits
            onAbort: () => {
              loggers.ai.info('🛑 AI Chat API: Stream aborted by user', {
                userId: maskIdentifier(userId!),
                pageId: chatId,
                model: currentModel,
                provider: currentProvider
              });
            },
          });

          usagePromise = aiResult.totalUsage
            .then((usage) => usage)
            .catch((error) => {
              loggers.ai.debug('AI Chat API: Failed to retrieve token usage from stream', {
                error: error instanceof Error ? error.message : 'Unknown error',
              });
              return undefined;
            });

          // Stream the AI response directly to the client
          for await (const chunk of aiResult.toUIMessageStream()) {
            writer.write(chunk);
          }
        },
        onFinish: async ({ responseMessage }) => {
          loggers.ai.debug('AI Chat API: onFinish callback triggered for AI response');
          
          // Enhanced debugging: Log the complete message structure
          loggers.ai.debug('AI Chat API: Response message structure', {
            id: responseMessage?.id,
            role: responseMessage?.role,
            partsCount: responseMessage?.parts?.length || 0,
            partTypes: responseMessage?.parts?.map(p => p.type) || [],
          });
          
          // Log each part in detail
          responseMessage?.parts?.forEach((part, index) => {
            if (part.type === 'text') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const text = (part as any).text || '';
              loggers.ai.trace(`AI Chat API: Part ${index}: TEXT`, { preview: text.substring(0, 100) });
            } else if (part.type.startsWith('tool-')) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const toolPart = part as any;
              loggers.ai.trace(`AI Chat API: Part ${index}: TOOL`, { type: part.type, state: toolPart.state, hasOutput: !!toolPart.output });
            } else {
              loggers.ai.trace(`AI Chat API: Part ${index}`, { type: part.type });
            }
          });
          
          // Save the AI's response message with tool calls and results (database-first approach)
          if (chatId && responseMessage) {
            try {
              const messageId = responseMessage.id || createId();
              const messageContent = extractMessageContent(responseMessage);
              
              // Extract tool calls and results from the response
              const extractedToolCalls = extractToolCalls(responseMessage);
              const extractedToolResults = extractToolResults(responseMessage);
              
              loggers.ai.debug('AI Chat API: Saving AI response message', { 
                id: messageId, 
                contentLength: messageContent.length,
                contentPreview: messageContent.substring(0, 100),
                toolCallsCount: extractedToolCalls.length,
                toolResultsCount: extractedToolResults.length,
                hasContent: messageContent.length > 0,
                hasTools: extractedToolCalls.length > 0 || extractedToolResults.length > 0
              });
              
              loggers.ai.trace('AI Chat API: Tool tracking', { 
                toolCalls: extractedToolCalls.length,
                toolResults: extractedToolResults.length 
              });
              
              // Use the new helper function to save the message with complete UIMessage for chronological ordering
              await saveMessageToDatabase({
                messageId,
                pageId: chatId,
                conversationId: conversationId!, // Group messages into conversation sessions
                userId: null, // AI message
                role: 'assistant',
                content: messageContent,
                toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
                toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
                uiMessage: responseMessage, // Pass complete UIMessage to preserve part ordering
              });
              
              loggers.ai.debug('AI Chat API: AI response message saved to database with tools');

              // Track usage for PageSpace providers only (rate limiting/quota tracking)
              const isPageSpaceProvider = currentProvider === 'pagespace';

              // Determine if this is pro model based on model name
              const isProModel = currentModel === 'glm-4.6';

              const maskedUserId = maskIdentifier(userId);
              const maskedMessageId = maskIdentifier(messageId);

              usageLogger.info('Page AI usage tracking decision', {
                userId: maskedUserId,
                provider: currentProvider,
                model: currentModel,
                isPageSpaceProvider,
                isProModel,
                messageId: maskedMessageId,
              });

              if (isPageSpaceProvider) {
                try {
                  const providerType = isProModel ? 'pro' : 'standard';

                  usageLogger.debug('Incrementing usage for Page AI response', {
                    userId: maskedUserId,
                    provider: currentProvider,
                    providerType,
                    messageId: maskedMessageId,
                  });

                  const usageResult = await incrementUsage(userId!, providerType);

                  usageLogger.info('Page AI usage incremented', {
                    userId: maskedUserId,
                    provider: currentProvider,
                    providerType,
                    messageId: maskedMessageId,
                    currentCount: usageResult.currentCount,
                    limit: usageResult.limit,
                    remaining: usageResult.remainingCalls,
                    success: usageResult.success,
                  });

                  // Broadcast usage event for real-time updates
                  try {
                    const currentUsageSummary = await getUserUsageSummary(userId!);

                    await broadcastUsageEvent({
                      userId: userId!,
                      operation: 'updated',
                      subscriptionTier: currentUsageSummary.subscriptionTier as 'free' | 'pro',
                      standard: currentUsageSummary.standard,
                      pro: currentUsageSummary.pro
                    });

                    usageLogger.debug('Page AI usage broadcast sent', {
                      userId: maskedUserId,
                    });
                  } catch (broadcastError) {
                    usageLogger.error('Page AI usage broadcast failed', broadcastError instanceof Error ? broadcastError : undefined, {
                      userId: maskedUserId,
                    });
                  }

                } catch (usageError) {
                  usageLogger.error('Page AI usage tracking failed', usageError as Error, {
                    userId: maskedUserId,
                    provider: currentProvider,
                    messageId: maskedMessageId,
                  });

                  // Don't fail the request - usage tracking errors shouldn't break the chat
                }
              } else {
                usageLogger.debug('Skipping usage tracking for non-PageSpace provider', {
                  provider: currentProvider,
                  userId: maskedUserId,
                  messageId: maskedMessageId,
                });
              }

              // Track enhanced AI usage with token counting and cost calculation
              const duration = Date.now() - startTime;

              const usage = usagePromise ? await usagePromise : undefined;
              const inputTokens = usage?.inputTokens ?? undefined;
              const outputTokens = usage?.outputTokens ?? undefined;
              const totalTokens =
                usage?.totalTokens ??
                ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined);

              // Use enhanced AI monitoring with token usage from SDK
              await AIMonitoring.trackUsage({
                userId: userId!,
                provider: currentProvider,
                model: currentModel,
                inputTokens,
                outputTokens,
                totalTokens,
                prompt: userPromptContent?.substring(0, 1000),
                completion: messageContent?.substring(0, 1000),
                duration,
                conversationId, // Use actual conversation ID instead of pageId
                messageId,
                pageId: chatId,
                driveId: pageContext?.driveId,
                success: true,
                metadata: {
                  pageName: page.title,
                  toolCallsCount: extractedToolCalls.length,
                  toolResultsCount: extractedToolResults.length,
                  hasTools: extractedToolCalls.length > 0 || extractedToolResults.length > 0,
                  reasoningTokens: usage?.reasoningTokens,
                  cachedInputTokens: usage?.cachedInputTokens,
                }
              });
              
              // Track tool usage separately for analytics
              if (extractedToolCalls.length > 0) {
                for (const toolCall of extractedToolCalls) {
                  await AIMonitoring.trackToolUsage({
                    userId: userId!,
                    provider: currentProvider,
                    model: currentModel,
                    toolName: toolCall.toolName,
                    toolId: toolCall.toolCallId,
                    args: undefined,
                    conversationId, // Use actual conversation ID instead of pageId
                    pageId: chatId,
                    success: true
                  });
                }
                
                // Also track feature usage
                trackFeature(userId!, 'ai_tools_used', {
                  toolCount: extractedToolCalls.length,
                  provider: currentProvider,
                  model: currentModel
                });
              }
            } catch (error) {
              loggers.ai.error('AI Chat API: Failed to save AI response message', error as Error);
              // Don't fail the response - persistence errors shouldn't break the chat
            }
          } else {
            loggers.ai.warn('AI Chat API: No chatId or response message provided, skipping persistence');
          }
        },
      });

      result = { toUIMessageStreamResponse: () => createUIMessageStreamResponse({ stream }) };
    } catch (streamError) {
      loggers.ai.error('AI Chat API: Failed to create stream', streamError as Error, {
        message: streamError instanceof Error ? streamError.message : 'Unknown error',
        stack: streamError instanceof Error ? streamError.stack : undefined
      });
      throw streamError; // Re-throw to be handled by the outer catch
    }

    loggers.ai.debug('AI Chat API: Returning visual-content-aware stream response');
    
    // Return the enhanced UI message stream response with visual content injection
    return result.toUIMessageStreamResponse();

  } catch (error) {
    loggers.ai.error('AI Chat API Error', error as Error, {
      userId,
      chatId,
      provider: selectedProvider,
      model: selectedModel,
      responseTime: Date.now() - startTime
    });

    const usage = usagePromise ? await usagePromise : undefined;

    // Track AI usage even for errors using enhanced monitoring
    // Note: conversationId might not be available in error path, use chatId as fallback
    await AIMonitoring.trackUsage({
      userId: userId || 'unknown',
      provider: selectedProvider || 'unknown',
      model: selectedModel || 'unknown',
      inputTokens: usage?.inputTokens ?? undefined,
      outputTokens: usage?.outputTokens ?? undefined,
      totalTokens:
        usage?.totalTokens ??
        ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined),
      duration: Date.now() - startTime,
      conversationId: conversationId || chatId, // Use conversationId if available, fallback to chatId
      pageId: chatId,
      driveId: undefined,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      metadata: {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        reasoningTokens: usage?.reasoningTokens,
        cachedInputTokens: usage?.cachedInputTokens,
      }
    });
    
    // Return a proper error response
    return NextResponse.json({ 
      error: 'Failed to process chat request. Please try again.' 
    }, { status: 500 });
  }
}

/**
 * GET handler to check multi-provider configuration status and current settings
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get pageId from query params
    const url = new URL(request.url);
    const pageId = url.searchParams.get('pageId');
    
    // Get user's current provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    
    // Get page-specific settings if pageId provided
    let currentProvider = user?.currentAiProvider || 'pagespace';
    let currentModel = user?.currentAiModel || 'glm-4.5-air';
    
    if (pageId) {
      const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
      if (page) {
        // Use page-specific settings if they exist, otherwise fallback to user settings
        currentProvider = page.aiProvider || currentProvider;
        currentModel = page.aiModel || currentModel;
      }
    }
    
    // Check PageSpace default settings
    const pageSpaceSettings = await getDefaultPageSpaceSettings();

    // Check OpenRouter settings
    const openRouterSettings = await getUserOpenRouterSettings(userId);

    // Check Google AI settings
    const googleSettings = await getUserGoogleSettings(userId);

    // Check OpenAI settings
    const openAISettings = await getUserOpenAISettings(userId);

    // Check Anthropic settings
    const anthropicSettings = await getUserAnthropicSettings(userId);

    // Check xAI settings
    const xaiSettings = await getUserXAISettings(userId);

    // Check Ollama settings
    const ollamaSettings = await getUserOllamaSettings(userId);

    // Check LM Studio settings
    const lmstudioSettings = await getUserLMStudioSettings(userId);

    // Check GLM settings
    const glmSettings = await getUserGLMSettings(userId);

    return NextResponse.json({
      currentProvider,
      currentModel,
      providers: {
        pagespace: {
          isConfigured: !!pageSpaceSettings?.isConfigured,
          hasApiKey: !!pageSpaceSettings?.apiKey,
        },
        openrouter: {
          isConfigured: !!openRouterSettings?.isConfigured,
          hasApiKey: !!openRouterSettings?.apiKey,
        },
        google: {
          isConfigured: !!googleSettings?.isConfigured,
          hasApiKey: !!googleSettings?.apiKey,
        },
        openai: {
          isConfigured: !!openAISettings?.isConfigured,
          hasApiKey: !!openAISettings?.apiKey,
        },
        anthropic: {
          isConfigured: !!anthropicSettings?.isConfigured,
          hasApiKey: !!anthropicSettings?.apiKey,
        },
        xai: {
          isConfigured: !!xaiSettings?.isConfigured,
          hasApiKey: !!xaiSettings?.apiKey,
        },
        ollama: {
          isConfigured: !!ollamaSettings?.isConfigured,
          hasBaseUrl: !!ollamaSettings?.baseUrl,
        },
        lmstudio: {
          isConfigured: !!lmstudioSettings?.isConfigured,
          hasBaseUrl: !!lmstudioSettings?.baseUrl,
        },
        glm: {
          isConfigured: !!glmSettings?.isConfigured,
          hasApiKey: !!glmSettings?.apiKey,
        },
      },
      isAnyProviderConfigured: !!pageSpaceSettings?.isConfigured || !!openRouterSettings?.isConfigured || !!googleSettings?.isConfigured || !!openAISettings?.isConfigured || !!anthropicSettings?.isConfigured || !!xaiSettings?.isConfigured || !!ollamaSettings?.isConfigured || !!lmstudioSettings?.isConfigured || !!glmSettings?.isConfigured,
    });

  } catch (error) {
    loggers.ai.error('Error checking provider settings', error as Error);
    return NextResponse.json({ 
      error: 'Failed to check settings' 
    }, { status: 500 });
  }
}

/**
 * Validate provider and model combination
 * Ensures the provider/model pair is supported and user has access
 */
async function validateProviderModel(
  provider: string,
  model: string,
  userId: string
): Promise<{ valid: boolean; reason?: string }> {
  // Define valid providers
  const validProviders = [
    'pagespace',
    'openrouter',
    'openrouter_free',
    'google',
    'openai',
    'anthropic',
    'xai',
    'ollama',
    'lmstudio',
    'glm'
  ];

  // Check if provider is valid
  if (!validProviders.includes(provider)) {
    return {
      valid: false,
      reason: `Invalid provider: ${provider}. Supported providers: ${validProviders.join(', ')}`
    };
  }

  // Validate model string format (basic sanity check)
  if (!model || typeof model !== 'string' || model.length > 100) {
    return {
      valid: false,
      reason: 'Invalid model format'
    };
  }

  // Check subscription requirements for pro models
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (requiresProSubscription(provider, model, user?.subscriptionTier)) {
      return {
        valid: false,
        reason: 'Pro or Business subscription required for this model'
      };
    }
  } catch (error) {
    loggers.ai.error('Error checking subscription requirements', error as Error);
    return {
      valid: false,
      reason: 'Unable to validate subscription requirements'
    };
  }

  // Additional provider-specific validation could go here
  // For now, basic validation is sufficient

  return { valid: true };
}

/**
 * PATCH handler to update page-specific AI settings
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const body = await request.json();

    // Enhanced input validation with type checking
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { pageId, provider, model } = body;

    // Validate pageId (should be a CUID)
    if (!pageId || typeof pageId !== 'string' || pageId.length < 10 || pageId.length > 30) {
      return NextResponse.json(
        { error: 'Invalid pageId format' },
        { status: 400 }
      );
    }

    // Validate provider
    if (!provider || typeof provider !== 'string' || provider.length > 50) {
      return NextResponse.json(
        { error: 'Provider is required and must be a valid string' },
        { status: 400 }
      );
    }

    // Validate model
    if (!model || typeof model !== 'string' || model.length > 100) {
      return NextResponse.json(
        { error: 'Model is required and must be a valid string' },
        { status: 400 }
      );
    }

    // Sanitize inputs (trim whitespace and basic cleanup)
    const sanitizedProvider = provider.trim();
    const sanitizedModel = model.trim();
    const sanitizedPageId = pageId.trim();

    // Verify the user has access to this page
    const [page] = await db.select().from(pages).where(eq(pages.id, sanitizedPageId));
    if (!page) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }

    // Check if user has permission to edit this page (SECURITY: Critical permission enforcement)
    const canEdit = await canUserEditPage(auth.userId, sanitizedPageId);
    if (!canEdit) {
      loggers.ai.warn('AI Settings PATCH: User lacks edit permission', {
        userId: auth.userId,
        pageId: sanitizedPageId
      });
      return NextResponse.json(
        { error: 'You do not have permission to modify this page' },
        { status: 403 }
      );
    }

    // Validate provider and model combination (SECURITY: Validate permitted combinations)
    const validation = await validateProviderModel(sanitizedProvider, sanitizedModel, auth.userId);
    if (!validation.valid) {
      loggers.ai.warn('AI Settings PATCH: Invalid provider/model combination', {
        userId: auth.userId,
        pageId: sanitizedPageId,
        provider: sanitizedProvider,
        model: sanitizedModel,
        reason: validation.reason
      });
      return NextResponse.json(
        { error: validation.reason || 'Invalid provider/model combination' },
        { status: 400 }
      );
    }

    // Update page settings
    await db
      .update(pages)
      .set({
        aiProvider: sanitizedProvider,
        aiModel: sanitizedModel,
      })
      .where(eq(pages.id, sanitizedPageId));

    loggers.ai.info('AI Settings PATCH: Page settings updated successfully', {
      userId: auth.userId,
      pageId: sanitizedPageId,
      provider: sanitizedProvider,
      model: sanitizedModel
    });

    return NextResponse.json({
      success: true,
      message: 'Page AI settings updated successfully',
      provider: sanitizedProvider,
      model: sanitizedModel,
    });
  } catch (error) {
    loggers.ai.error('Failed to update page AI settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}