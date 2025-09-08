import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { authenticateRequest } from '@/lib/auth-utils';
import { 
  getUserOpenRouterSettings,
  createOpenRouterSettings,
  getUserGoogleSettings,
  createGoogleSettings,
  getDefaultPageSpaceSettings 
} from '@/lib/ai/ai-utils';
import { db, users, conversations, messages, eq, and, asc } from '@pagespace/db';
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
import { AgentRoleUtils } from '@/lib/ai/agent-roles';
import { RolePromptBuilder } from '@/lib/ai/role-prompts';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';
import { loggers } from '@pagespace/lib/logger-config';

// Allow streaming responses up to 60 seconds
export const maxDuration = 60;

/**
 * GET - Get all messages for a conversation
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, error } = await authenticateRequest(request);
    if (error) return error;

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

    // Get messages for this conversation
    const conversationMessages = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.conversationId, id),
        eq(messages.isActive, true)
      ))
      .orderBy(asc(messages.createdAt));

    // Convert to UIMessage format with proper tool call reconstruction
    const uiMessages = conversationMessages.map(msg => 
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

    return NextResponse.json(uiMessages);
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
    loggers.api.debug('🚀 Global Assistant Chat API: Starting request processing', {});
    
    const { userId, error } = await authenticateRequest(request);
    if (error) {
      loggers.api.debug('❌ Global Assistant Chat API: Authentication failed', {});
      return error;
    }

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
      messages: requestMessages,
      selectedProvider, 
      selectedModel,
      openRouterApiKey,
      googleApiKey,
      locationContext,
      agentRole: roleString
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
      }
    }
    
    // Get user's current AI provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const currentProvider = selectedProvider || user?.currentAiProvider || 'pagespace';
    const currentModel = selectedModel || user?.currentAiModel || 'qwen/qwen3-coder:free';
    
    // Update user's current provider/model if changed
    if (selectedProvider && selectedModel && 
        (selectedProvider !== user?.currentAiProvider || selectedModel !== user?.currentAiModel)) {
      await db
        .update(users)
        .set({
          currentAiProvider: selectedProvider,
          currentAiModel: selectedModel,
        })
        .where(eq(users.id, userId));
    }

    // Handle multi-provider setup and validation
    let model;

    if (currentProvider === 'pagespace') {
      // Use default PageSpace settings (app's OpenRouter key)
      const pageSpaceSettings = await getDefaultPageSpaceSettings();
      
      if (!pageSpaceSettings) {
        // Fall back to user's OpenRouter settings if no default key
        let openRouterSettings = await getUserOpenRouterSettings(userId);
        
        if (!openRouterSettings && openRouterApiKey) {
          await createOpenRouterSettings(userId, openRouterApiKey);
          openRouterSettings = { apiKey: openRouterApiKey, isConfigured: true };
        }

        if (!openRouterSettings) {
          return NextResponse.json({ 
            error: 'No default API key configured. Please provide your own OpenRouter API key.' 
          }, { status: 400 });
        }
        
        const openrouter = createOpenRouter({
          apiKey: openRouterSettings.apiKey,
        });
        model = openrouter.chat(currentModel);
      } else {
        // Custom fetch to inject fallback models into the request
        const openrouter = createOpenRouter({
          apiKey: pageSpaceSettings.apiKey,
          fetch: async (url, options) => {
            if (options?.body) {
              try {
                const body = JSON.parse(options.body as string);
                // Add fallback models for PageSpace provider (max 3 allowed by OpenRouter)
                body.models = [
                  'qwen/qwen3-coder:free', // Primary model
                  'qwen/qwen3-8b:free',
                  'qwen/qwen3-14b:free'
                ];
                options.body = JSON.stringify(body);
              } catch (e) {
                loggers.api.error('Failed to inject fallback models:', e as Error);
              }
            }
            return fetch(url, options);
          }
        });
        
        model = openrouter.chat(currentModel);
      }
    } else if (currentProvider === 'openrouter') {
      let openRouterSettings = await getUserOpenRouterSettings(userId);
      
      if (!openRouterSettings && openRouterApiKey) {
        await createOpenRouterSettings(userId, openRouterApiKey);
        openRouterSettings = { apiKey: openRouterApiKey, isConfigured: true };
      }

      if (!openRouterSettings) {
        return NextResponse.json({ 
          error: 'OpenRouter API key not configured. Please provide an API key.' 
        }, { status: 400 });
      }

      const openrouter = createOpenRouter({
        apiKey: openRouterSettings.apiKey,
      });
      
      model = openrouter.chat(currentModel);
      
    } else if (currentProvider === 'openrouter_free') {
      // Handle OpenRouter Free - uses user's OpenRouter key same as regular OpenRouter
      let openRouterSettings = await getUserOpenRouterSettings(userId);
      
      if (!openRouterSettings && openRouterApiKey) {
        await createOpenRouterSettings(userId, openRouterApiKey);
        openRouterSettings = { apiKey: openRouterApiKey, isConfigured: true };
      }

      if (!openRouterSettings) {
        return NextResponse.json({ 
          error: 'OpenRouter API key not configured. Please provide an API key for free models.' 
        }, { status: 400 });
      }

      const openrouter = createOpenRouter({
        apiKey: openRouterSettings.apiKey,
      });
      
      model = openrouter.chat(currentModel);
      
    } else if (currentProvider === 'google') {
      let googleSettings = await getUserGoogleSettings(userId);
      
      if (!googleSettings && googleApiKey) {
        await createGoogleSettings(userId, googleApiKey);
        googleSettings = { apiKey: googleApiKey, isConfigured: true };
      }

      if (!googleSettings) {
        return NextResponse.json({ 
          error: 'Google AI API key not configured. Please provide an API key.' 
        }, { status: 400 });
      }

      const googleProvider = createGoogleGenerativeAI({
        apiKey: googleSettings.apiKey,
      });
      model = googleProvider(currentModel);
      
    } else {
      return NextResponse.json({ 
        error: `Unsupported AI provider: ${currentProvider}` 
      }, { status: 400 });
    }

    // Get agent role with fallback to default
    const agentRole = AgentRoleUtils.getRoleFromString(roleString);
    loggers.api.debug('🤖 Global Assistant Chat API: Using agent role', { agentRole });

    // Convert UIMessages to ModelMessages for the AI model
    const sanitizedMessages = sanitizeMessagesForModel(requestMessages);
    const modelMessages = convertToModelMessages(sanitizedMessages);

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

    // Add global assistant specific instructions
    const systemPrompt = baseSystemPrompt + mentionSystemPrompt + `

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
    const roleFilteredTools = ToolPermissionFilter.filterTools(pageSpaceTools, agentRole);
    
    loggers.api.debug('🔄 Global Assistant Chat API: Starting streamText', { model: currentModel, agentRole });
    
    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools: roleFilteredTools,
      stopWhen: stepCountIs(100),
      experimental_context: { 
        userId, 
        locationContext
      },
      maxRetries: 20, // Increase from default 2 to 20 for better handling of rate limits
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