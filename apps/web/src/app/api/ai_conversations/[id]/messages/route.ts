import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs, UIMessage } from 'ai';
import { incrementUsage, getUserUsageSummary } from '@/lib/subscription/usage-service';
import { broadcastUsageEvent } from '@/lib/socket-utils';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createOllama } from 'ollama-ai-provider-v2';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
import {
  getUserOpenRouterSettings,
  createOpenRouterSettings,
  getUserGoogleSettings,
  createGoogleSettings,
  getDefaultPageSpaceSettings,
  getUserOpenAISettings,
  createOpenAISettings,
  getUserAnthropicSettings,
  createAnthropicSettings,
  getUserXAISettings,
  createXAISettings,
  getUserOllamaSettings,
  createOllamaSettings,
  getUserGLMSettings,
  createGLMSettings
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
import { buildTimestampSystemPrompt } from '@/lib/ai/timestamp-utils';
import { AgentRoleUtils } from '@/lib/ai/agent-roles';
import { RolePromptBuilder } from '@/lib/ai/role-prompts';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';
import { getModelCapabilities } from '@/lib/ai/model-capabilities';
import { loggers } from '@pagespace/lib/logger-config';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

/**
 * GET - Get all messages for a conversation
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

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
    
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) {
      loggers.api.debug('❌ Global Assistant Chat API: Authentication failed', {});
      return auth.error;
    }
    const { userId } = auth;

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
      openAIApiKey,
      anthropicApiKey,
      xaiApiKey,
      ollamaBaseUrl,
      glmApiKey,
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
    const currentModel = selectedModel || user?.currentAiModel || 'GLM-4.5-air';
    
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
      // Use default PageSpace settings (now Google AI with Gemini 2.5 Flash)
      const pageSpaceSettings = await getDefaultPageSpaceSettings();

      if (!pageSpaceSettings) {
        // Fall back to user's Google settings if no default key
        let googleSettings = await getUserGoogleSettings(userId);

        if (!googleSettings && googleApiKey) {
          await createGoogleSettings(userId, googleApiKey);
          googleSettings = { apiKey: googleApiKey, isConfigured: true };
        }

        if (!googleSettings) {
          return NextResponse.json({
            error: 'No default API key configured. Please provide your own Google AI API key.'
          }, { status: 400 });
        }

        const googleProvider = createGoogleGenerativeAI({
          apiKey: googleSettings.apiKey,
        });
        model = googleProvider(currentModel);
      } else {
        // Use the appropriate provider based on the configuration
        if (pageSpaceSettings.provider === 'google') {
          const googleProvider = createGoogleGenerativeAI({
            apiKey: pageSpaceSettings.apiKey,
          });
          model = googleProvider(currentModel);
        } else if (pageSpaceSettings.provider === 'glm') {
          // Use GLM provider with OpenAI-compatible endpoint
          const glmProvider = createOpenAICompatible({
            name: 'glm',
            apiKey: pageSpaceSettings.apiKey,
            baseURL: 'https://api.z.ai/api/coding/paas/v4',
          });
          model = glmProvider(currentModel);
        } else {
          return NextResponse.json({
            error: `Unsupported PageSpace provider: ${pageSpaceSettings.provider}`
          }, { status: 400 });
        }
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

    } else if (currentProvider === 'ollama') {
      // Handle Ollama setup
      let ollamaSettings = await getUserOllamaSettings(userId);

      if (!ollamaSettings && ollamaBaseUrl) {
        await createOllamaSettings(userId, ollamaBaseUrl);
        ollamaSettings = { baseUrl: ollamaBaseUrl, isConfigured: true };
      }

      if (!ollamaSettings) {
        return NextResponse.json({
          error: 'Ollama base URL not configured. Please provide a base URL for your local Ollama instance.'
        }, { status: 400 });
      }

      // Create Ollama provider instance with base URL
      // Add /api suffix for ollama-ai-provider-v2 which expects full API endpoint
      const ollamaApiUrl = `${ollamaSettings.baseUrl}/api`;
      const ollamaProvider = createOllama({
        baseURL: ollamaApiUrl,
      });
      model = ollamaProvider(currentModel);

    } else if (currentProvider === 'openai') {
      // Handle OpenAI setup
      let openAISettings = await getUserOpenAISettings(userId);

      if (!openAISettings && openAIApiKey) {
        await createOpenAISettings(userId, openAIApiKey);
        openAISettings = { apiKey: openAIApiKey, isConfigured: true };
      }

      if (!openAISettings) {
        return NextResponse.json({
          error: 'OpenAI API key not configured. Please provide an API key.'
        }, { status: 400 });
      }

      // Create OpenAI provider instance with API key
      const openai = createOpenAI({
        apiKey: openAISettings.apiKey,
      });
      model = openai(currentModel);

    } else if (currentProvider === 'anthropic') {
      // Handle Anthropic setup
      let anthropicSettings = await getUserAnthropicSettings(userId);

      if (!anthropicSettings && anthropicApiKey) {
        await createAnthropicSettings(userId, anthropicApiKey);
        anthropicSettings = { apiKey: anthropicApiKey, isConfigured: true };
      }

      if (!anthropicSettings) {
        return NextResponse.json({
          error: 'Anthropic API key not configured. Please provide an API key.'
        }, { status: 400 });
      }

      // Create Anthropic provider instance with API key
      const anthropic = createAnthropic({
        apiKey: anthropicSettings.apiKey,
      });
      model = anthropic(currentModel);

    } else if (currentProvider === 'xai') {
      // Handle xAI setup
      let xaiSettings = await getUserXAISettings(userId);

      if (!xaiSettings && xaiApiKey) {
        await createXAISettings(userId, xaiApiKey);
        xaiSettings = { apiKey: xaiApiKey, isConfigured: true };
      }

      if (!xaiSettings) {
        return NextResponse.json({
          error: 'xAI API key not configured. Please provide an API key.'
        }, { status: 400 });
      }

      // Create xAI provider instance with API key
      const xai = createXai({
        apiKey: xaiSettings.apiKey,
      });
      model = xai(currentModel);

    } else if (currentProvider === 'glm') {
      // Handle GLM Coder Plan setup
      let glmSettings = await getUserGLMSettings(userId);

      if (!glmSettings && glmApiKey) {
        await createGLMSettings(userId, glmApiKey);
        glmSettings = { apiKey: glmApiKey, isConfigured: true };
      }

      if (!glmSettings) {
        return NextResponse.json({
          error: 'GLM API key not configured. Please provide an API key.'
        }, { status: 400 });
      }

      // Create GLM provider instance using OpenAI-compatible endpoint
      const glmProvider = createOpenAICompatible({
        name: 'glm',
        apiKey: glmSettings.apiKey,
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
      });
      model = glmProvider(currentModel);

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
        locationContext,
        modelCapabilities: getModelCapabilities(currentModel, currentProvider)
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

            // Track usage for PageSpace providers only (rate limiting/quota tracking)
            const isPageSpaceProvider = currentProvider === 'pagespace';

            loggers.api.info('Global Assistant API: USAGE TRACKING DECISION', {
              userId,
              currentProvider,
              isPageSpaceProvider,
              messageId,
              conversationId,
              timestamp: new Date().toISOString()
            });

            if (isPageSpaceProvider) {
              try {
                // Determine if this is thinking model based on model name
                const isThinkingModel = currentModel === 'GLM-4.5';
                const providerType = isThinkingModel ? 'extra_thinking' : 'normal';

                loggers.api.info('Global Assistant API: CALLING incrementUsage', {
                  userId,
                  provider: currentProvider,
                  providerType,
                  messageId,
                  conversationId,
                  timestamp: new Date().toISOString()
                });

                const usageResult = await incrementUsage(userId, providerType);

                loggers.api.info('Global Assistant API: USAGE TRACKED SUCCESSFULLY', {
                  userId,
                  provider: currentProvider,
                  providerType,
                  messageId,
                  conversationId,
                  usageResult,
                  timestamp: new Date().toISOString()
                });

                // Also log to console for immediate visibility
                console.log('🟢 GLOBAL ASSISTANT USAGE TRACKED:', {
                  userId,
                  provider: currentProvider,
                  providerType,
                  conversationId,
                  currentCount: usageResult.currentCount,
                  limit: usageResult.limit,
                  remaining: usageResult.remainingCalls,
                  success: usageResult.success
                });

                // Broadcast usage event for real-time updates
                try {
                  const currentUsageSummary = await getUserUsageSummary(userId);

                  await broadcastUsageEvent({
                    userId,
                    operation: 'updated',
                    subscriptionTier: currentUsageSummary.subscriptionTier as 'free' | 'pro',
                    free: currentUsageSummary.free,
                    extraThinking: currentUsageSummary.extraThinking
                  });

                  console.log('🔔 Usage broadcast sent for Global Assistant');
                } catch (broadcastError) {
                  console.error('Failed to broadcast usage event (non-fatal):', broadcastError);
                }

              } catch (usageError) {
                loggers.api.error('Global Assistant API: USAGE TRACKING FAILED', usageError as Error, {
                  userId,
                  provider: currentProvider,
                  messageId,
                  conversationId,
                  timestamp: new Date().toISOString()
                });

                // Also log to console for immediate visibility
                console.error('🔴 GLOBAL ASSISTANT USAGE TRACKING FAILED:', {
                  userId,
                  provider: currentProvider,
                  conversationId,
                  error: usageError instanceof Error ? usageError.message : usageError,
                  stack: usageError instanceof Error ? usageError.stack : undefined
                });

                // Don't fail the request - usage tracking errors shouldn't break the chat
              }
            } else {
              loggers.api.info('Global Assistant API: SKIPPING usage tracking for non-PageSpace provider', {
                provider: currentProvider,
                isPageSpaceProvider,
                userId,
                messageId,
                conversationId,
                timestamp: new Date().toISOString()
              });

              // Also log to console for immediate visibility
              console.log('⚪ GLOBAL ASSISTANT USAGE TRACKING SKIPPED:', {
                provider: currentProvider,
                conversationId,
                reason: 'Not a PageSpace provider',
                expectedProviders: ['pagespace']
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