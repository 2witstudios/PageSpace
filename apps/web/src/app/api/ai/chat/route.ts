import { NextResponse } from 'next/server';
import {
  streamText,
  convertToModelMessages,
  UIMessage,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModelUsage,
  type TextUIPart,
  type ToolSet,
} from 'ai';
import { getPageSpaceModelTier } from '@/lib/ai/core/ai-providers-config';
import { mergeToolSets } from '@/lib/ai/core/tool-utils';
import { incrementUsage, getCurrentUsage, getUserUsageSummary } from '@/lib/subscription/usage-service';
import { createRateLimitResponse } from '@/lib/subscription/rate-limit-middleware';
import { broadcastUsageEvent } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage, canUserEditPage, getActorInfo } from '@pagespace/lib/server';
import {
  createAIProvider,
  updateUserProviderSettings,
  createProviderErrorResponse,
  isProviderError,
  type ProviderRequest,
  getDefaultPageSpaceSettings,
  getUserOpenRouterSettings,
  getUserGoogleSettings,
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
  buildPersonalizationPrompt,
  filterToolsForReadOnly,
  filterToolsForWebSearch,
  getPageTreeContext,
  getModelCapabilities,
  convertMCPToolsToAISDKSchemas,
  parseMCPToolName,
  sanitizeToolNamesForProvider,
  getUserPersonalization,
} from '@/lib/ai/core';
import { db, users, chatMessages, pages, drives, eq, and } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { loggers, conversationCache, type CachedMessage } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { trackFeature } from '@pagespace/lib/activity-tracker';
import { AIMonitoring } from '@pagespace/lib/ai-monitoring';
import type { MCPTool } from '@/types/mcp';
import { getMCPBridge } from '@/lib/mcp';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import {
  createStreamAbortController,
  removeStream,
  STREAM_ID_HEADER,
} from '@/lib/ai/core/stream-abort-registry';
import { validateUserMessageFileParts, hasFileParts } from '@/lib/ai/core/validate-image-parts';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';

export const maxDuration = 300;

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const VALID_PROVIDERS = [
  'pagespace',
  'openrouter',
  'openrouter_free',
  'google',
  'openai',
  'anthropic',
  'xai',
  'ollama',
  'lmstudio',
  'glm',
];

interface ChatRequest {
  messages: UIMessage[];
  chatId?: string;
  conversationId?: string;
  selectedProvider?: string;
  selectedModel?: string;
  openRouterApiKey?: string;
  googleApiKey?: string;
  openAIApiKey?: string;
  anthropicApiKey?: string;
  xaiApiKey?: string;
  ollamaBaseUrl?: string;
  glmApiKey?: string;
  mcpTools?: MCPTool[];
  isReadOnly?: boolean;
  webSearchEnabled?: boolean;
  pageContext?: {
    pageId: string;
    pageTitle: string;
    pageType: string;
    pagePath: string;
    parentPath: string;
    breadcrumbs: string[];
    driveId?: string;
    driveName: string;
    driveSlug: string;
  };
}

async function buildToolSet(params: {
  userId: string;
  chatId: string;
  page: typeof pages.$inferSelect;
  readOnlyMode: boolean;
  webSearchMode: boolean;
  mcpTools?: MCPTool[];
}): Promise<ToolSet> {
  const { userId, chatId, page, readOnlyMode, webSearchMode, mcpTools } = params;
  const enabledTools = page.enabledTools as string[] | null;

  let filteredTools: ToolSet;

  if (enabledTools === null || enabledTools.length === 0) {
    filteredTools = {};
  } else {
    const filtered: Record<string, (typeof pageSpaceTools)[keyof typeof pageSpaceTools]> = {};
    for (const toolName of enabledTools) {
      if (toolName in pageSpaceTools) {
        filtered[toolName] = pageSpaceTools[toolName as keyof typeof pageSpaceTools];
      }
    }
    const postReadOnlyFiltered = filterToolsForReadOnly(filtered, readOnlyMode);
    filteredTools = filterToolsForWebSearch(postReadOnlyFiltered, webSearchMode);
  }

  try {
    const { resolvePageAgentIntegrationTools } = await import('@/lib/ai/core/integration-tool-resolver');
    const integrationTools = await resolvePageAgentIntegrationTools({
      agentId: chatId,
      userId,
      driveId: page.driveId,
    });
    if (Object.keys(integrationTools).length > 0) {
      filteredTools = mergeToolSets(filteredTools, integrationTools);
    }
  } catch (error) {
    loggers.ai.error('Failed to resolve integration tools', error as Error);
  }

  if (mcpTools && mcpTools.length > 0) {
    filteredTools = await mergeMCPTools(filteredTools, mcpTools, userId, chatId);
  }

  return filteredTools;
}

async function mergeMCPTools(
  filteredTools: ToolSet,
  mcpTools: MCPTool[],
  userId: string,
  chatId: string
): Promise<ToolSet> {
  try {
    const mcpToolSchemas = convertMCPToolsToAISDKSchemas(mcpTools);
    const mcpToolsWithExecute: Record<string, unknown> = {};

    for (const [toolName, toolSchema] of Object.entries(mcpToolSchemas)) {
      mcpToolsWithExecute[toolName] = {
        ...toolSchema,
        execute: async (args: Record<string, unknown>) => {
          const parsed = parseMCPToolName(toolName);
          if (!parsed) {
            throw new Error(`Invalid MCP tool name format: ${toolName}`);
          }

          const { serverName, toolName: actualToolName } = parsed;

          try {
            const mcpBridge = getMCPBridge();
            if (!mcpBridge.isUserConnected(userId)) {
              throw new Error('Desktop app not connected. Please ensure PageSpace Desktop is running.');
            }
            return await mcpBridge.executeTool(userId, serverName, actualToolName, args);
          } catch (error) {
            loggers.ai.error('MCP tool execution failed', error as Error, {
              toolName: actualToolName,
              serverName,
              userId: maskIdentifier(userId),
            });
            throw error;
          }
        },
      };
    }

    return sanitizeToolNamesForProvider({ ...filteredTools, ...mcpToolsWithExecute } as Record<string, ToolSet[string]>) as ToolSet;
  } catch (error) {
    loggers.ai.error('Failed to integrate MCP tools', error as Error, {
      userId: maskIdentifier(userId),
      chatId: maskIdentifier(chatId),
    });
    return filteredTools;
  }
}

async function loadConversationHistory(pageId: string, conversationId: string): Promise<UIMessage[]> {
  const cachedConversation = await conversationCache.getConversation(pageId, conversationId);

  if (cachedConversation) {
    return cachedConversation.messages.map((msg: CachedMessage) =>
      convertDbMessageToUIMessage({
        id: msg.id,
        pageId,
        userId: null,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        createdAt: new Date(msg.createdAt),
        isActive: true,
        editedAt: msg.editedAt ? new Date(msg.editedAt) : null,
      })
    );
  }

  const dbMessages = await db
    .select()
    .from(chatMessages)
    .where(and(
      eq(chatMessages.pageId, pageId),
      eq(chatMessages.conversationId, conversationId),
      eq(chatMessages.isActive, true)
    ))
    .orderBy(chatMessages.createdAt);

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

  const messagesToCache: CachedMessage[] = dbMessages.map(msg => ({
    id: msg.id,
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content ?? '',
    toolCalls: (msg.toolCalls as string | null) ?? null,
    toolResults: (msg.toolResults as string | null) ?? null,
    createdAt: msg.createdAt.getTime(),
    editedAt: msg.editedAt?.getTime() ?? null,
    messageType: (msg.messageType as 'standard' | 'todo_list') ?? 'standard',
  }));

  conversationCache.setConversation(pageId, conversationId, messagesToCache).catch(err => {
    loggers.ai.warn('Failed to populate conversation cache', { error: err });
  });

  return conversationHistory;
}

async function buildCompleteSystemPrompt(params: {
  page: typeof pages.$inferSelect;
  pageContext?: ChatRequest['pageContext'];
  readOnlyMode: boolean;
  userTimezone?: string;
  userId: string;
  chatId: string;
}): Promise<string> {
  const { page, pageContext, readOnlyMode, userTimezone, userId, chatId } = params;

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
      }
    } catch (error) {
      loggers.ai.error('Failed to fetch drive prompt', error as Error);
    }
  }

  const personalization = await getUserPersonalization(userId);
  const customSystemPrompt = page.systemPrompt;

  let systemPrompt: string;
  if (customSystemPrompt) {
    systemPrompt = drivePromptPrefix + customSystemPrompt;
    if (pageContext) {
      systemPrompt += `\n\nYou are operating within the page "${pageContext.pageTitle}" in the "${pageContext.driveName}" drive. Your current location: ${pageContext.pagePath}`;
    }
    const personalizationPrompt = buildPersonalizationPrompt(personalization ?? undefined);
    if (personalizationPrompt) {
      systemPrompt += `\n\n${personalizationPrompt}`;
    }
    if (readOnlyMode) {
      systemPrompt += `\n\nREAD-ONLY MODE:\n• You cannot modify, create, or delete any content\n• Focus on exploring, analyzing, and planning\n• Create actionable plans for the user to execute later`;
    }
  } else {
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
      readOnlyMode,
      personalization ?? undefined
    );
  }

  const timestampSystemPrompt = buildTimestampSystemPrompt(userTimezone);

  let pageTreePrompt = '';
  if (page.includePageTree && page.driveId) {
    const pageTreeContext = await getPageTreeContext(userId, {
      scope: (page.pageTreeScope as 'children' | 'drive') || 'children',
      pageId: chatId,
      driveId: page.driveId,
    });
    if (pageTreeContext) {
      pageTreePrompt = `\n\n## WORKSPACE STRUCTURE\n\nHere is the ${page.pageTreeScope === 'drive' ? 'complete workspace' : 'page subtree'} structure:\n\n${pageTreeContext}`;
    }
  }

  return systemPrompt + timestampSystemPrompt + pageTreePrompt;
}

async function trackUsage(params: {
  userId: string;
  currentProvider: string;
  currentModel: string;
  chatId: string;
  messageId: string;
  messageContent: string;
  userPromptContent?: string;
  toolCallsCount: number;
  toolResultsCount: number;
  startTime: number;
  usagePromise?: Promise<LanguageModelUsage | undefined>;
  pageContext?: ChatRequest['pageContext'];
  page: typeof pages.$inferSelect;
  conversationId: string;
}): Promise<void> {
  const {
    userId,
    currentProvider,
    currentModel,
    chatId,
    messageId,
    messageContent,
    userPromptContent,
    toolCallsCount,
    startTime,
    usagePromise,
    pageContext,
    page,
    conversationId,
  } = params;

  const usageLogger = loggers.ai.child({ module: 'page-ai-usage' });
  const isPageSpaceProvider = currentProvider === 'pagespace';
  const maskedUserId = maskIdentifier(userId);
  const maskedMessageId = maskIdentifier(messageId);

  if (isPageSpaceProvider) {
    try {
      const providerType = getPageSpaceModelTier(currentModel) ?? 'standard';
      const usageResult = await incrementUsage(userId, providerType);

      usageLogger.info('Page AI usage incremented', {
        userId: maskedUserId,
        provider: currentProvider,
        providerType,
        messageId: maskedMessageId,
        currentCount: usageResult.currentCount,
        limit: usageResult.limit,
        remaining: usageResult.remainingCalls,
      });

      try {
        const currentUsageSummary = await getUserUsageSummary(userId);
        await broadcastUsageEvent({
          userId,
          operation: 'updated',
          subscriptionTier: currentUsageSummary.subscriptionTier as 'free' | 'pro',
          standard: currentUsageSummary.standard,
          pro: currentUsageSummary.pro,
        });
      } catch (broadcastError) {
        usageLogger.error('Page AI usage broadcast failed', broadcastError instanceof Error ? broadcastError : undefined);
      }
    } catch (usageError) {
      usageLogger.error('Page AI usage tracking failed', usageError as Error);
    }
  }

  const duration = Date.now() - startTime;
  const usage = usagePromise ? await usagePromise : undefined;

  await AIMonitoring.trackUsage({
    userId,
    provider: currentProvider,
    model: currentModel,
    inputTokens: usage?.inputTokens ?? undefined,
    outputTokens: usage?.outputTokens ?? undefined,
    totalTokens: usage?.totalTokens ?? ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined),
    prompt: userPromptContent?.substring(0, 1000),
    completion: messageContent?.substring(0, 1000),
    duration,
    conversationId,
    messageId,
    pageId: chatId,
    driveId: pageContext?.driveId,
    success: true,
    metadata: {
      pageName: page.title,
      toolCallsCount,
      toolResultsCount: params.toolResultsCount,
      hasTools: toolCallsCount > 0 || params.toolResultsCount > 0,
      reasoningTokens: usage?.reasoningTokens,
      cachedInputTokens: usage?.cachedInputTokens,
    },
  });

  if (toolCallsCount > 0) {
    trackFeature(userId, 'ai_tools_used', {
      toolCount: toolCallsCount,
      provider: currentProvider,
      model: currentModel,
    });
  }
}

async function validateProviderModel(
  provider: string,
  model: string,
  userId: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!VALID_PROVIDERS.includes(provider)) {
    return {
      valid: false,
      reason: `Invalid provider: ${provider}. Supported providers: ${VALID_PROVIDERS.join(', ')}`,
    };
  }

  if (!model || typeof model !== 'string' || model.length > 100) {
    return { valid: false, reason: 'Invalid model format' };
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const { requiresProSubscription } = await import('@/lib/subscription/rate-limit-middleware');
    if (requiresProSubscription(provider, model, user?.subscriptionTier)) {
      return { valid: false, reason: 'Pro or Business subscription required for this model' };
    }
  } catch {
    return { valid: false, reason: 'Unable to validate subscription requirements' };
  }

  return { valid: true };
}

export async function POST(request: Request) {
  const startTime = Date.now();
  let userId: string | undefined;
  let chatId: string | undefined;
  let conversationId: string | undefined;
  let selectedProvider: string | undefined;
  let selectedModel: string | undefined;
  let usagePromise: Promise<LanguageModelUsage | undefined> | undefined;

  try {
    const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(authResult)) {
      return authResult.error;
    }
    userId = authResult.userId;

    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'Request body too large (max 25MB)' }, { status: 413 });
    }

    const requestBody: ChatRequest = await request.json();
    const {
      messages,
      chatId: requestChatId,
      conversationId: requestConversationId,
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
      mcpTools,
      isReadOnly,
      webSearchEnabled,
    } = requestBody;

    chatId = requestChatId;
    selectedProvider = requestSelectedProvider;
    selectedModel = requestSelectedModel;

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: 'messages are required' }, { status: 400 });
    }

    if (!chatId) {
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 });
    }

    const mcpScopeError = await checkMCPPageScope(authResult, chatId);
    if (mcpScopeError) return mcpScopeError;

    if (!userId) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
    }

    const userMessageForValidation = messages[messages.length - 1];
    const messageHasImages = userMessageForValidation?.role === 'user' && hasFileParts(userMessageForValidation);
    if (messageHasImages) {
      const imageValidation = validateUserMessageFileParts(userMessageForValidation);
      if (!imageValidation.valid) {
        return NextResponse.json({ error: imageValidation.error }, { status: 400 });
      }
    }

    const canView = await canUserViewPage(userId, chatId);
    if (!canView) {
      return NextResponse.json({ error: 'You do not have permission to view this AI chat' }, { status: 403 });
    }

    const canEdit = await canUserEditPage(userId, chatId);
    if (!canEdit) {
      return NextResponse.json({ error: 'You do not have permission to send messages in this AI chat' }, { status: 403 });
    }

    const [page] = await db.select().from(pages).where(eq(pages.id, chatId));
    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    if (messageHasImages) {
      const effectiveModel = selectedModel || page.aiModel;
      if (effectiveModel && !hasVisionCapability(effectiveModel)) {
        return NextResponse.json(
          { error: `The selected model "${effectiveModel}" does not support image attachments. Please choose a vision-capable model.` },
          { status: 400 }
        );
      }
    }

    conversationId = requestConversationId || createId();

    const userMessage = messages[messages.length - 1];
    let userPromptContent: string | undefined;
    let mentionedPageIds: string[] = [];

    if (userMessage && userMessage.role === 'user') {
      const messageId = userMessage.id || createId();
      const messageContent = extractMessageContent(userMessage);
      userPromptContent = messageContent;

      const processedMessage = processMentionsInMessage(messageContent);
      mentionedPageIds = processedMessage.pageIds;

      try {
        await saveMessageToDatabase({
          messageId,
          pageId: chatId,
          conversationId,
          userId,
          role: 'user',
          content: messageContent,
          toolCalls: undefined,
          toolResults: undefined,
          uiMessage: userMessage,
        });
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to save user message', error as Error);
        return NextResponse.json({
          error: 'Failed to save message to database',
          details: error instanceof Error ? error.message : 'Unknown database error',
          userMessage,
        }, { status: 500 });
      }
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const currentProvider = selectedProvider || user?.currentAiProvider || 'pagespace';
    const currentModel = selectedModel || user?.currentAiModel || 'glm-4.5-air';

    const { requiresProSubscription: checkRequiresPro, createSubscriptionRequiredResponse } = await import('@/lib/subscription/rate-limit-middleware');

    if (checkRequiresPro(currentProvider, currentModel, user?.subscriptionTier)) {
      return createSubscriptionRequiredResponse();
    }

    if (selectedProvider && selectedModel && chatId) {
      if (selectedProvider !== page.aiProvider || selectedModel !== page.aiModel) {
        try {
          const actorInfo = await getActorInfo(userId);
          await applyPageMutation({
            pageId: chatId,
            operation: 'agent_config_update',
            updates: { aiProvider: selectedProvider, aiModel: selectedModel },
            updatedFields: ['aiProvider', 'aiModel'],
            expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
            context: {
              userId,
              actorEmail: actorInfo.actorEmail,
              actorDisplayName: actorInfo.actorDisplayName,
              resourceType: 'agent',
            },
          });
        } catch (error) {
          if (error instanceof PageRevisionMismatchError) {
            return NextResponse.json(
              { error: error.message, currentRevision: error.currentRevision, expectedRevision: error.expectedRevision },
              { status: error.expectedRevision === undefined ? 428 : 409 }
            );
          }
          throw error;
        }
      }
    }

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
    await updateUserProviderSettings(userId, selectedProvider, selectedModel);

    if (currentProvider === 'pagespace') {
      const providerType = getPageSpaceModelTier(currentModel) ?? 'standard';
      const currentUsage = await getCurrentUsage(userId, providerType);

      if (!currentUsage.success || currentUsage.remainingCalls <= 0) {
        return createRateLimitResponse(providerType, currentUsage.limit);
      }
    }

    const readOnlyMode = isReadOnly === true;
    const webSearchMode = webSearchEnabled === true;

    const filteredTools = await buildToolSet({
      userId,
      chatId,
      page,
      readOnlyMode,
      webSearchMode,
      mcpTools,
    });

    const conversationHistory = await loadConversationHistory(chatId, conversationId);
    const sanitizedMessages = sanitizeMessagesForModel(conversationHistory);
    const modelMessages = convertToModelMessages(sanitizedMessages, { tools: filteredTools });

    const userTimezone = user?.timezone ?? undefined;
    const systemPrompt = await buildCompleteSystemPrompt({
      page,
      pageContext,
      readOnlyMode,
      userTimezone,
      userId,
      chatId,
    });

    const serverAssistantMessageId = createId();
    const { streamId, signal: abortSignal } = createStreamAbortController({ userId });

    let result;

    try {
      const stream = createUIMessageStream({
        originalMessages: sanitizedMessages,
        execute: async ({ writer }) => {
          let startChunkSent = false;

          try {
            writer.write({ type: 'start', messageId: serverAssistantMessageId });
            startChunkSent = true;
          } catch {
            // Client disconnected before first write
          }

          const aiResult = streamText({
            model,
            system: systemPrompt,
            messages: modelMessages,
            tools: filteredTools,
            stopWhen: stepCountIs(100),
            abortSignal,
            experimental_context: {
              userId,
              timezone: userTimezone,
              aiProvider: currentProvider,
              aiModel: currentModel,
              conversationId,
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
              modelCapabilities: await getModelCapabilities(currentModel, currentProvider),
              chatSource: { type: 'page' as const, agentPageId: chatId, agentTitle: page.title },
            },
            maxRetries: 20,
            onAbort: () => {
              loggers.ai.info('AI Chat API: Stream aborted by user', {
                userId: maskIdentifier(userId!),
                pageId: chatId,
                streamId,
                model: currentModel,
                provider: currentProvider,
              });
            },
          });

          usagePromise = aiResult.totalUsage.then(u => u).catch(() => undefined);

          for await (const chunk of aiResult.toUIMessageStream()) {
            try {
              if (chunk.type === 'start') {
                if (startChunkSent) continue;
                writer.write({ type: 'start', messageId: serverAssistantMessageId });
                startChunkSent = true;
                continue;
              }
              writer.write(chunk);
            } catch {
              // Client disconnected
            }
          }
        },
        onFinish: async ({ responseMessage }) => {
          removeStream({ streamId });

          if (chatId && responseMessage) {
            try {
              const messageId = serverAssistantMessageId;
              const messageContent = extractMessageContent(responseMessage);
              const extractedToolCalls = extractToolCalls(responseMessage);
              const extractedToolResults = extractToolResults(responseMessage);

              await saveMessageToDatabase({
                messageId,
                pageId: chatId,
                conversationId: conversationId!,
                userId: null,
                role: 'assistant',
                content: messageContent,
                toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
                toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
                uiMessage: responseMessage,
              });

              await trackUsage({
                userId: userId!,
                currentProvider,
                currentModel,
                chatId,
                messageId,
                messageContent,
                userPromptContent,
                toolCallsCount: extractedToolCalls.length,
                toolResultsCount: extractedToolResults.length,
                startTime,
                usagePromise,
                pageContext,
                page,
                conversationId: conversationId!,
              });
            } catch (error) {
              loggers.ai.error('Failed to save AI response message', error as Error);
            }
          }
        },
      });

      result = {
        toUIMessageStreamResponse: () => createUIMessageStreamResponse({
          stream,
          headers: { [STREAM_ID_HEADER]: streamId },
        }),
      };
    } catch (streamError) {
      removeStream({ streamId });
      throw streamError;
    }

    return result.toUIMessageStreamResponse();

  } catch (error) {
    loggers.ai.error('AI Chat API Error', error as Error, {
      userId,
      chatId,
      provider: selectedProvider,
      model: selectedModel,
      responseTime: Date.now() - startTime,
    });

    const usage = usagePromise ? await usagePromise : undefined;

    await AIMonitoring.trackUsage({
      userId: userId || 'unknown',
      provider: selectedProvider || 'unknown',
      model: selectedModel || 'unknown',
      inputTokens: usage?.inputTokens ?? undefined,
      outputTokens: usage?.outputTokens ?? undefined,
      totalTokens: usage?.totalTokens ?? ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined),
      duration: Date.now() - startTime,
      conversationId: conversationId || chatId,
      pageId: chatId,
      driveId: undefined,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      metadata: {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        reasoningTokens: usage?.reasoningTokens,
        cachedInputTokens: usage?.cachedInputTokens,
      },
    });

    return NextResponse.json({ error: 'Failed to process chat request. Please try again.' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const url = new URL(request.url);
    const pageId = url.searchParams.get('pageId');

    const [user] = await db.select().from(users).where(eq(users.id, userId));

    let currentProvider = user?.currentAiProvider || 'pagespace';
    let currentModel = user?.currentAiModel || 'glm-4.5-air';

    if (pageId) {
      const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
      if (page) {
        currentProvider = page.aiProvider || currentProvider;
        currentModel = page.aiModel || currentModel;
      }
    }

    const [
      pageSpaceSettings,
      openRouterSettings,
      googleSettings,
      openAISettings,
      anthropicSettings,
      xaiSettings,
      ollamaSettings,
      lmstudioSettings,
      glmSettings,
    ] = await Promise.all([
      getDefaultPageSpaceSettings(),
      getUserOpenRouterSettings(userId),
      getUserGoogleSettings(userId),
      getUserOpenAISettings(userId),
      getUserAnthropicSettings(userId),
      getUserXAISettings(userId),
      getUserOllamaSettings(userId),
      getUserLMStudioSettings(userId),
      getUserGLMSettings(userId),
    ]);

    const providers = {
      pagespace: { isConfigured: !!pageSpaceSettings?.isConfigured, hasApiKey: !!pageSpaceSettings?.apiKey },
      openrouter: { isConfigured: !!openRouterSettings?.isConfigured, hasApiKey: !!openRouterSettings?.apiKey },
      google: { isConfigured: !!googleSettings?.isConfigured, hasApiKey: !!googleSettings?.apiKey },
      openai: { isConfigured: !!openAISettings?.isConfigured, hasApiKey: !!openAISettings?.apiKey },
      anthropic: { isConfigured: !!anthropicSettings?.isConfigured, hasApiKey: !!anthropicSettings?.apiKey },
      xai: { isConfigured: !!xaiSettings?.isConfigured, hasApiKey: !!xaiSettings?.apiKey },
      ollama: { isConfigured: !!ollamaSettings?.isConfigured, hasBaseUrl: !!ollamaSettings?.baseUrl },
      lmstudio: { isConfigured: !!lmstudioSettings?.isConfigured, hasBaseUrl: !!lmstudioSettings?.baseUrl },
      glm: { isConfigured: !!glmSettings?.isConfigured, hasApiKey: !!glmSettings?.apiKey },
    };

    return NextResponse.json({
      currentProvider,
      currentModel,
      providers,
      isAnyProviderConfigured: Object.values(providers).some(p => p.isConfigured),
    });

  } catch (error) {
    loggers.ai.error('Error checking provider settings', error as Error);
    return NextResponse.json({ error: 'Failed to check settings' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const body = await request.json();

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { pageId, provider, model, expectedRevision } = body;

    if (!pageId || typeof pageId !== 'string' || pageId.length < 10 || pageId.length > 30) {
      return NextResponse.json({ error: 'Invalid pageId format' }, { status: 400 });
    }

    if (!provider || typeof provider !== 'string' || provider.length > 50) {
      return NextResponse.json({ error: 'Provider is required and must be a valid string' }, { status: 400 });
    }

    if (!model || typeof model !== 'string' || model.length > 100) {
      return NextResponse.json({ error: 'Model is required and must be a valid string' }, { status: 400 });
    }

    const sanitizedProvider = provider.trim();
    const sanitizedModel = model.trim();
    const sanitizedPageId = pageId.trim();

    const [page] = await db.select().from(pages).where(eq(pages.id, sanitizedPageId));
    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    const canEdit = await canUserEditPage(auth.userId, sanitizedPageId);
    if (!canEdit) {
      return NextResponse.json({ error: 'You do not have permission to modify this page' }, { status: 403 });
    }

    const validation = await validateProviderModel(sanitizedProvider, sanitizedModel, auth.userId);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.reason || 'Invalid provider/model combination' }, { status: 400 });
    }

    try {
      const actorInfo = await getActorInfo(auth.userId);
      await applyPageMutation({
        pageId: sanitizedPageId,
        operation: 'agent_config_update',
        updates: { aiProvider: sanitizedProvider, aiModel: sanitizedModel },
        updatedFields: ['aiProvider', 'aiModel'],
        expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : undefined,
        context: {
          userId: auth.userId,
          actorEmail: actorInfo.actorEmail,
          actorDisplayName: actorInfo.actorDisplayName,
          resourceType: 'agent',
        },
      });
    } catch (error) {
      if (error instanceof PageRevisionMismatchError) {
        return NextResponse.json(
          { error: error.message, currentRevision: error.currentRevision, expectedRevision: error.expectedRevision },
          { status: error.expectedRevision === undefined ? 428 : 409 }
        );
      }
      throw error;
    }

    return NextResponse.json({
      success: true,
      message: 'Page AI settings updated successfully',
      provider: sanitizedProvider,
      model: sanitizedModel,
    });

  } catch (error) {
    loggers.ai.error('Failed to update page AI settings', error as Error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
