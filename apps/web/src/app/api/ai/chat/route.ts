import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages, UIMessage, stepCountIs } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { authenticateRequest } from '@/lib/auth-utils';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
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
  createXAISettings
} from '@/lib/ai/ai-utils';
import { db, users, chatMessages, pages, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import { 
  extractMessageContent, 
  extractToolCalls, 
  extractToolResults,
  saveMessageToDatabase,
  sanitizeMessagesForModel
} from '@/lib/ai/assistant-utils';
import { processMentionsInMessage, buildMentionSystemPrompt } from '@/lib/ai/mention-processor';
import { AgentRoleUtils } from '@/lib/ai/agent-roles';
import { RolePromptBuilder } from '@/lib/ai/role-prompts';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';
import { loggers } from '@pagespace/lib/logger-config';
import { trackFeature } from '@pagespace/lib/activity-tracker';
import { AIMonitoring } from '@pagespace/lib/ai-monitoring';


// Allow streaming responses up to 60 seconds for longer AI conversations
export const maxDuration = 60;

/**
 * Next.js 15 compatible API route for AI chat
 * Implements reliable persistence by saving user messages immediately
 * Supports multi-provider architecture: OpenRouter and Google AI
 */
export async function POST(request: Request) {
  const startTime = Date.now();
  let userId: string | undefined;
  let chatId: string | undefined;
  let selectedProvider: string | undefined;
  let selectedModel: string | undefined;
  
  try {
    loggers.ai.info('AI Chat API: Starting request processing');
    
    // Authenticate the request
    const authResult = await authenticateRequest(request);
    userId = authResult.userId;
    if (authResult.error) {
      loggers.ai.warn('AI Chat API: Authentication failed');
      return authResult.error;
    }
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
      messages,
      chatId: requestChatId, // chat ID (page ID) - standard AI SDK pattern
      selectedProvider: requestSelectedProvider, 
      selectedModel: requestSelectedModel,
      openRouterApiKey,
      googleApiKey,
      openAIApiKey,
      anthropicApiKey,
      xaiApiKey,
      pageContext,
      agentRole: roleString
    }: {
      messages: UIMessage[],
      chatId?: string,
      selectedProvider?: string,
      selectedModel?: string,
      openRouterApiKey?: string,
      googleApiKey?: string,
      openAIApiKey?: string,
      anthropicApiKey?: string,
      xaiApiKey?: string,
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
      },
      agentRole?: string
    } = requestBody;

    // Assign to outer scope variables for error handling
    chatId = requestChatId;
    selectedProvider = requestSelectedProvider;
    selectedModel = requestSelectedModel;

    // Get agent role with fallback to default
    const agentRole = AgentRoleUtils.getRoleFromString(roleString);
    loggers.ai.debug('AI Page Chat API: Using agent role', { agentRole });

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
    console.log(`[AI_PERMISSIONS] Checking permissions for userId: ${userId}, chatId: ${chatId}`);
    const canView = await canUserViewPage(userId, chatId);
    console.log(`[AI_PERMISSIONS] Can view: ${canView}`);
    if (!canView) {
      loggers.ai.warn('AI Chat API: User lacks view permission', { userId, chatId });
      console.error(`[AI_PERMISSIONS] DENIED - User ${userId} cannot view chat ${chatId}`);
      return NextResponse.json({ error: 'You do not have permission to view this AI chat' }, { status: 403 });
    }

    const canEdit = await canUserEditPage(userId, chatId);
    console.log(`[AI_PERMISSIONS] Can edit: ${canEdit}`);
    if (!canEdit) {
      loggers.ai.warn('AI Chat API: User lacks edit permission', { userId, chatId });
      console.error(`[AI_PERMISSIONS] DENIED - User ${userId} cannot edit chat ${chatId}`);
      return NextResponse.json({ error: 'You do not have permission to send messages in this AI chat' }, { status: 403 });
    }
    
    console.log(`[AI_PERMISSIONS] GRANTED - User ${userId} has full access to chat ${chatId}`);
    
    loggers.ai.info('AI Chat API: Validation passed', { 
      messageCount: messages.length, 
      chatId 
    });
    
    // Process @mentions in the user's message
    let mentionSystemPrompt = '';
    let mentionedPageIds: string[] = [];
    
    // Save user's message immediately to database (database-first approach)
    const userMessage = messages[messages.length - 1]; // Last message is the new user message
    if (userMessage && userMessage.role === 'user') {
      try {
        const messageId = userMessage.id || createId();
        const messageContent = extractMessageContent(userMessage);
        
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
          userId,
          role: 'user',
          content: messageContent,
          toolCalls: null,
          toolResults: null,
          createdAt: new Date(),
          isActive: true,
          agentRole,
        });
        
        loggers.ai.debug('AI Chat API: User message saved to database');
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to save user message', error as Error);
        // Don't fail the request - continue with AI processing
      }
    }
    
    // Get user's current AI provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const currentProvider = selectedProvider || user?.currentAiProvider || 'pagespace';
    const currentModel = selectedModel || user?.currentAiModel || 'qwen/qwen3-coder:free';
    
    // Update page's AI provider/model if changed
    if (selectedProvider && selectedModel && chatId) {
      // Get the current page settings
      const [page] = await db.select().from(pages).where(eq(pages.id, chatId));
      
      if (page && (selectedProvider !== page.aiProvider || selectedModel !== page.aiModel)) {
        await db
          .update(pages)
          .set({
            aiProvider: selectedProvider,
            aiModel: selectedModel,
          })
          .where(eq(pages.id, chatId));
      }
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
                loggers.ai.error('Failed to inject fallback models', e as Error);
              }
            }
            return fetch(url, options);
          }
        });
        
        model = openrouter.chat(currentModel);
      }
    } else if (currentProvider === 'openrouter') {
      // Handle OpenRouter setup
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
      // Handle Google AI setup
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

      // Create Google provider instance with API key
      const googleProvider = createGoogleGenerativeAI({
        apiKey: googleSettings.apiKey,
      });
      model = googleProvider(currentModel);
      
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
      
    } else {
      return NextResponse.json({ 
        error: `Unsupported AI provider: ${currentProvider}` 
      }, { status: 400 });
    }

    // Convert UIMessages to ModelMessages for the AI model
    // First sanitize messages to remove tool parts without results (prevents "input-available" state errors)
    const sanitizedMessages = sanitizeMessagesForModel(messages);
    const modelMessages = convertToModelMessages(sanitizedMessages);

    // Build role-aware system prompt with page context
    const systemPrompt = RolePromptBuilder.buildSystemPrompt(
      agentRole,
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

    // Filter tools based on agent role permissions
    const roleFilteredTools = ToolPermissionFilter.filterTools(pageSpaceTools, agentRole);
    
    loggers.ai.debug('AI Chat API: Role-filtered tools', { toolCount: Object.keys(roleFilteredTools).length });
    loggers.ai.info('AI Chat API: Starting streamText', { model: currentModel, agentRole });
    
    // Wrap streamText in try-catch for better error handling
    let result;
    try {
      result = streamText({
      model,
      system: systemPrompt + mentionSystemPrompt + `

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
• CANVAS: Create custom HTML/CSS pages for navigation, dashboards, client-facing content, or any custom design (e.g., "Project Dashboard", "Client Portal", "Navigation Hub", "Company Homepage")
• DATABASE: Create structured data collections (deprecated but available for legacy support)

WHEN TO CREATE EACH PAGE TYPE:
- AI_CHAT pages when users need context-specific AI assistance, isolated AI conversations, or persistent AI context tied to workspace areas
- CHANNEL pages when users need team collaboration spaces, persistent chat history for topics, or organized discussions separate from main communication
- CANVAS pages when users need custom HTML/CSS pages with full design control, navigation hubs, client-facing portals, dashboard pages with custom layouts, or interactive pages requiring custom functionality

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
      tools: roleFilteredTools,
      stopWhen: stepCountIs(100), // Allow up to 100 tool calls per conversation turn
      experimental_context: { userId }, // Pass userId to tools for permission checking
      maxRetries: 20, // Increase from default 2 to 20 for better handling of rate limits
    });
    } catch (streamError) {
      loggers.ai.error('AI Chat API: Failed to create stream', streamError as Error, {
        message: streamError instanceof Error ? streamError.message : 'Unknown error',
        stack: streamError instanceof Error ? streamError.stack : undefined
      });
      throw streamError; // Re-throw to be handled by the outer catch
    }

    loggers.ai.debug('AI Chat API: Returning stream response with database-first persistence');
    
    // Return UI message stream response with database-first persistence
    return result.toUIMessageStreamResponse({
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
              userId: null, // AI message
              role: 'assistant',
              content: messageContent,
              toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
              toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
              uiMessage: responseMessage, // NEW: Pass complete UIMessage to preserve part ordering
              agentRole, // NEW: Pass agent role for tracking
            });
            
            loggers.ai.debug('AI Chat API: AI response message saved to database with tools');
            
            // Track enhanced AI usage with token counting and cost calculation
            const duration = Date.now() - startTime;
            
            // Use enhanced AI monitoring with token usage from SDK
            await AIMonitoring.trackUsage({
              userId: userId!,
              provider: currentProvider,
              model: currentModel,
              inputTokens: undefined,
              outputTokens: undefined, 
              totalTokens: undefined,
              prompt: undefined, // Last user message
              completion: messageContent?.substring(0, 1000),
              duration,
              conversationId: chatId,
              messageId,
              pageId: chatId,
              driveId: pageContext?.driveId,
              success: true,
              metadata: {
                agentRole,
                toolCallsCount: extractedToolCalls.length,
                toolResultsCount: extractedToolResults.length,
                hasTools: extractedToolCalls.length > 0 || extractedToolResults.length > 0
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
                  conversationId: chatId,
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

  } catch (error) {
    loggers.ai.error('AI Chat API Error', error as Error, {
      userId,
      chatId,
      provider: selectedProvider,
      model: selectedModel,
      responseTime: Date.now() - startTime
    });
    
    // Track AI usage even for errors using enhanced monitoring
    await AIMonitoring.trackUsage({
      userId: userId || 'unknown',
      provider: selectedProvider || 'unknown',
      model: selectedModel || 'unknown',
      duration: Date.now() - startTime,
      conversationId: chatId,
      pageId: chatId,
      driveId: undefined,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      metadata: {
        errorType: error instanceof Error ? error.name : 'UnknownError'
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
    const { userId, error } = await authenticateRequest(request);
    if (error) return error;

    // Get pageId from query params
    const url = new URL(request.url);
    const pageId = url.searchParams.get('pageId');
    
    // Get user's current provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    
    // Get page-specific settings if pageId provided
    let currentProvider = user?.currentAiProvider || 'pagespace';
    let currentModel = user?.currentAiModel || 'qwen/qwen3-coder:free';
    
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
      },
      isAnyProviderConfigured: !!pageSpaceSettings?.isConfigured || !!openRouterSettings?.isConfigured || !!googleSettings?.isConfigured,
    });

  } catch (error) {
    loggers.ai.error('Error checking provider settings', error as Error);
    return NextResponse.json({ 
      error: 'Failed to check settings' 
    }, { status: 500 });
  }
}

/**
 * PATCH handler to update page-specific AI settings
 */
export async function PATCH(request: Request) {
  try {
    const { error } = await authenticateRequest(request);
    if (error) return error;

    const body = await request.json();
    const { pageId, provider, model } = body;

    // Validate input
    if (!pageId) {
      return NextResponse.json(
        { error: 'pageId is required' },
        { status: 400 }
      );
    }

    if (!provider || !model) {
      return NextResponse.json(
        { error: 'Provider and model are required' },
        { status: 400 }
      );
    }

    // Verify the user has access to this page
    // TODO: Add proper permission check here
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (!page) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }

    // Update page settings
    await db
      .update(pages)
      .set({
        aiProvider: provider,
        aiModel: model,
      })
      .where(eq(pages.id, pageId));

    return NextResponse.json({
      success: true,
      message: 'Page AI settings updated successfully',
      provider,
      model,
    });
  } catch (error) {
    loggers.ai.error('Failed to update page AI settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}