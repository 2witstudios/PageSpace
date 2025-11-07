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
import { broadcastUsageEvent } from '@/lib/socket-utils';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import {
  createAIProvider,
  updateUserProviderSettings,
  createProviderErrorResponse,
  isProviderError,
  type ProviderRequest
} from '@/lib/ai/provider-factory';
import {
  getUserOpenRouterSettings,
  getUserGoogleSettings,
  getDefaultPageSpaceSettings,
  getUserOpenAISettings,
  getUserAnthropicSettings,
  getUserXAISettings,
  getUserOllamaSettings,
  getUserLMStudioSettings,
  getUserGLMSettings,
} from '@/lib/ai/ai-utils';
import { db, users, chatMessages, pages, eq, and } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import {
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
  saveMessageToDatabase,
  sanitizeMessagesForModel,
  convertDbMessageToUIMessage
} from '@/lib/ai/assistant-utils';
import { processMentionsInMessage, buildMentionSystemPrompt } from '@/lib/ai/mention-processor';
import { buildTimestampSystemPrompt } from '@/lib/ai/timestamp-utils';
import { RolePromptBuilder } from '@/lib/ai/role-prompts';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';
import { AgentRole } from '@/lib/ai/agent-roles';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { trackFeature } from '@pagespace/lib/activity-tracker';
import { AIMonitoring } from '@pagespace/lib/ai-monitoring';
import { getModelCapabilities } from '@/lib/ai/model-capabilities';
import { convertMCPToolsToAISDKSchemas, parseMCPToolName } from '@/lib/ai/mcp-tool-converter';
import type { MCPTool } from '@/types/mcp';
import { getMCPBridge } from '@/lib/mcp-bridge';


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
    const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
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
      // Note: agentRole no longer needed - handled server-side via page configuration
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

    loggers.ai.debug('AI Page Chat API: Using custom agent configuration', {
      hasCustomSystemPrompt: !!customSystemPrompt,
      enabledToolsCount: enabledTools?.length || 0,
      pageName: page.title
    });

    // Auto-generate conversationId if not provided (seamless UX)
    conversationId = requestConversationId || createId();
    loggers.ai.debug('AI Chat API: Conversation session', {
      conversationId,
      isNewConversation: !requestConversationId
    });

    // Process @mentions in the user's message
    let mentionSystemPrompt = '';
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
          mentionSystemPrompt = buildMentionSystemPrompt(processedMessage.mentions);
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
          agentRole: page.title || 'Page AI', // Use page title as agent role
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

    // Filter tools based on custom enabled tools or use all tools if not configured
    let filteredTools;
    if (enabledTools && enabledTools.length > 0) {
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
      filteredTools = filtered;

      loggers.ai.debug('AI Page Chat API: Filtered tools based on page configuration', {
        totalTools: Object.keys(pageSpaceTools).length,
        enabledTools: enabledTools.length,
        filteredTools: Object.keys(filteredTools).length
      });
    } else {
      // No tool restrictions configured, use default role-based filtering for compatibility
      filteredTools = ToolPermissionFilter.filterTools(pageSpaceTools, AgentRole.PARTNER);
      loggers.ai.debug('AI Page Chat API: Using default tool filtering (PARTNER role)');
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
      systemPrompt = customSystemPrompt;
      if (pageContext) {
        systemPrompt += `\n\nYou are operating within the page "${pageContext.pageTitle}" in the "${pageContext.driveName}" drive. Your current location: ${pageContext.pagePath}`;
      }
    } else {
      // Fallback to default PageSpace system prompt for compatibility
      systemPrompt = RolePromptBuilder.buildSystemPrompt(
        AgentRole.PARTNER, // Default fallback role for pages without custom configuration
        'page',
        pageContext ? {
          driveName: pageContext.driveName,
          driveSlug: pageContext.driveSlug,
          driveId: pageContext.driveId,
          pagePath: pageContext.pagePath,
          pageType: pageContext.pageType,
          breadcrumbs: pageContext.breadcrumbs,
        } : undefined
      );
    }
    
    // Build timestamp system prompt for temporal awareness
    const timestampSystemPrompt = buildTimestampSystemPrompt();
    
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
            system: systemPrompt + mentionSystemPrompt + timestampSystemPrompt + `

CRITICAL NESTING PRINCIPLE:
• NO RESTRICTIONS on what can contain what - organize based on logical user needs
• Documents can contain AI chats, channels, folders, and canvas pages
• AI chats can contain documents, other AI chats, folders, and any page type
• Channels can contain any page type for organized discussion threads
• Canvas pages can contain any page type for custom navigation structures
• Think creatively about nesting - optimize for user workflow, not type conventions

IMPORTANT BEHAVIOR RULES:
1. Page-First Exploration - ALWAYS start with your context:
   - You are operating within the page "${pageContext?.pageTitle || 'current'}" in the "${pageContext?.driveName || 'current'}" drive
   - Your current location: ${pageContext?.pagePath || 'current-page'}
   - ALWAYS use list_pages on the current drive with driveSlug: "${pageContext?.driveSlug || 'current-drive'}" and driveId: "${pageContext?.driveId || 'current-drive-id'}" when:
     • User asks about content in this area or the drive
     • User wants to create, write, or modify ANYTHING
     • User references files/folders that might exist
     • User asks what's available or what's here
     • You need structural context for any operation
   - Default action: list_pages with driveSlug: "${pageContext?.driveSlug || 'current-drive'}" and driveId: "${pageContext?.driveId || 'current-drive-id'}"
2. Proactive exploration pattern:
   - FIRST: Always list_pages on current drive to understand structure
   - THEN: Read specific pages including THIS page if needed
   - ONLY explore OTHER drives if explicitly requested
3. When users say "here", "this", or don't specify - they mean current context
4. When creating content, ALWAYS check what exists first via list_pages
5. SUGGEST AND CREATE contextual AI_CHAT and CHANNEL pages for organization
6. Use INFINITE NESTING creatively - any page type inside any other

PAGE TYPES AND STRATEGIC USAGE:
• FOLDER: Organize related content hierarchically (e.g., "Project Alpha", "Team Resources", "Q1 Planning")
• DOCUMENT: Create written content, SOPs, notes, reports (e.g., "Meeting Notes", "Project Requirements", "User Guide")
• AI_CHAT: Create contextual AI conversation spaces for specific topics/projects (e.g., "Project Alpha AI Assistant", "Marketing Strategy AI", "Code Review AI")
• CHANNEL: Create team discussion spaces for collaborative conversations (e.g., "Project Alpha Team Chat", "Marketing Team", "Engineering Discussions")
• CANVAS: Create custom HTML/CSS pages with complete creative freedom - blank canvas for any visual design. Use for: dashboards, landing pages, graphics, demos, portfolios, presentations, prototypes, or any custom layout. Always start with <style> tags for CSS, then HTML. White background by default (theme-independent). Navigation syntax: <a href="/dashboard/DRIVE_ID/PAGE_ID">Link Text</a>
• DATABASE: Create structured data collections (deprecated but available for legacy support)

WHEN TO CREATE EACH PAGE TYPE:
- AI_CHAT pages when users need context-specific AI assistance, isolated AI conversations, or persistent AI context tied to workspace areas
- CHANNEL pages when users need team collaboration spaces, persistent chat history for topics, or organized discussions separate from main communication
- CANVAS pages when users want complete creative control over HTML/CSS layout - any visual design need. Use for landing pages, graphics, portfolios, demos, prototypes, presentations, or custom interfaces. Structure: Always start with <style> tags containing CSS, followed by HTML. Navigation links: <a href="/dashboard/DRIVE_ID/PAGE_ID">Link Text</a> (get DRIVE_ID from pageContext.driveId, PAGE_ID from list_pages results).

AVAILABLE TOOLS AND WHEN TO USE THEM:
- list_drives: Use ONLY when user explicitly asks about other workspaces
- list_pages: ALWAYS use FIRST on current drive with driveSlug: "${pageContext?.driveSlug || 'current-drive'}" and driveId: "${pageContext?.driveId || 'current-drive-id'}" when working with content
- read_page: Use to read specific content after exploring with list_pages
- create_page: Use to create new documents, folders, AI chats, team channels, or canvas pages
- rename_page: Use to rename existing pages (title changes only)
- replace_lines: Use to replace specific lines in a document with new content
- insert_lines: Use to insert new content at a specific line number
- delete_lines: Use to delete specific lines from a document
- append_to_page: Use to add content to the end of a page
- prepend_to_page: Use to add content to the beginning of a page
- trash_page: Use to delete individual pages when requested
- trash_page_with_children: Use to delete a page and all its children recursively
- restore_page: Use to restore trashed pages back to their original location
- move_page: Use to move pages between folders or reorder them
- list_trash: Use to see what pages are in the trash for a drive

ADVANCED PAGE CREATION STRATEGIES:
When organizing work, PROACTIVELY suggest and create:
- AI_CHAT pages inside project folders for context-specific AI assistance
- CHANNEL pages for team collaboration within projects
- CANVAS pages for custom dashboards, navigation hubs, and client-facing content
- Nested folder structures that group related AI chats and team discussions

MULTI-STEP WORKFLOW EXAMPLES:
When asked "Create 5 SOPs for onboarding":
1. Use list_drives and list_pages to explore structure
2. Create a "HR/Onboarding" folder if it doesn't exist
3. Create each SOP document with appropriate content
4. Create "HR/Onboarding/AI Assistant" (AI_CHAT) for onboarding Q&A
5. Create "HR/Onboarding/Team Discussion" (CHANNEL) for HR team collaboration
6. Create "HR/Onboarding/Portal" (CANVAS) for custom onboarding dashboard

When asked "Set up a new project":
1. Create main project folder
2. Create project documents (requirements, timeline, etc.)
3. Create "Project Name/AI Assistant" (AI_CHAT) for project-specific AI help
4. Create "Project Name/Team Chat" (CHANNEL) for team coordination
5. Create "Project Name/Dashboard" (CANVAS) for custom project overview page

When asked "Create client workspace":
1. Create client folder structure
2. Create project documents and deliverables
3. Create "Client Name/Portal" (CANVAS) for client-facing dashboard
4. Create "Client Name/Internal Discussion" (CHANNEL) for team coordination

CREATIVE NESTING EXAMPLES (any type can contain any type):
- Create "Meeting Notes/Follow-up AI" (AI_CHAT inside DOCUMENT) for document-specific questions
- Create "Project Dashboard/Team Discussions" (FOLDER inside CANVAS) to organize all project chats within the dashboard
- Create "Daily Standup Channel/Meeting AI" (AI_CHAT inside CHANNEL) for meeting-specific assistance
- Create "Client Portal/Internal Team Notes" (DOCUMENT inside CANVAS) for private coordination within client pages

MULTI-LEVEL ORGANIZATIONAL WORKFLOWS:
When asked "Set up complete operations structure":
1. Create "Operations" (FOLDER) at root level
2. Create "Operations/Finance" (FOLDER) for financial operations
3. Create "Operations/Finance/Overview" (DOCUMENT) for finance documentation
4. Create "Operations/Finance/Finance AI" (AI_CHAT) for financial assistance
5. Create "Operations/Finance/Budget Discussions" (CHANNEL) for team coordination
6. Create "Operations/Finance/Finance AI/Expense Reports" (FOLDER) for AI context documents
7. Create "Operations/Finance/Budget Discussions/Monthly Review" (AI_CHAT) for meeting-specific AI help

When asked "Create comprehensive client management system":
1. Create "Clients/Acme Corp/Project Alpha" (FOLDER) for main project
2. Create "Clients/Acme Corp/Project Alpha/Client Portal" (CANVAS) for client-facing dashboard
3. Create "Clients/Acme Corp/Project Alpha/Internal Team" (CHANNEL) for team coordination
4. Create "Clients/Acme Corp/Project Alpha/Client Portal/Weekly Reports" (FOLDER) within the portal
5. Create "Clients/Acme Corp/Project Alpha/Internal Team/Strategy AI" (AI_CHAT) for strategy assistance
6. Create "Clients/Acme Corp/Project Alpha/Internal Team/Strategy AI/Research Notes" (DOCUMENT) for AI context
7. Create "Clients/Acme Corp/Project Alpha/Client Portal/Weekly Reports/Week 1 Update" (DOCUMENT) for deliverables

CRITICAL POST-TOOL EXECUTION BEHAVIOR:
After executing any tools, ALWAYS provide a comprehensive conversational summary that includes:
1. What was accomplished - Clearly explain what actions were taken and their results
2. Key findings - Highlight important information discovered or created
3. Impact and context - Explain what this means for the user's workspace or goals
4. Next steps - Suggest logical follow-up actions or ask relevant questions when appropriate
5. Any issues - If something failed or was unexpected, explain what happened and alternatives

NEVER end your response immediately after tool execution. Always bridge back to natural conversation with a summary that helps the user understand what happened and what they might want to do next.

Examples of good post-tool summaries:
- "I've successfully created 5 SOP documents in your 'Operations' folder. Each document includes the standard structure I found in your existing SOPs. Would you like me to review and enhance any specific SOP, or shall we move on to creating training materials?"
- "I found 12 documents related to your project across 3 different folders. The most recent updates were made to the requirements document yesterday. Based on what I've read, it looks like you're in the implementation phase. Would you like me to help organize these documents or create a project status summary?"
- "I've updated the page with your new content and the changes are now live. The document now includes the 3 new sections you requested, and I've maintained the existing formatting style. Is there anything specific you'd like me to adjust in the content or structure?"

Be helpful and context-aware. Focus on the current location unless the user's request requires exploring elsewhere. Don't ask for information you can discover with your tools.

MENTION PROCESSING:
• When users @mention documents using @[Label](id:type) format, you MUST read those documents first
• Use the read_page tool for each mentioned document before providing your main response
• Let mentioned document content inform and enrich your response
• Don't explicitly mention that you're reading @mentioned docs unless relevant to the conversation`,
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
                uiMessage: responseMessage, // NEW: Pass complete UIMessage to preserve part ordering
                agentRole: page.title || 'Page AI', // Use page title as agent role
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
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