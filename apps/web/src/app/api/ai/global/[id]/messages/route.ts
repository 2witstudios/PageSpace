import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/server';
import {
  createAIProvider,
  updateUserProviderSettings,
  createProviderErrorResponse,
  isProviderError,
  type ProviderRequest
} from '@/lib/ai/core';
import { calculateTotalContextSize } from '@pagespace/lib/ai-context-calculator';
import {
  validateReadAuth,
  validateWriteAuth,
  validateBodySize,
  parsePostBody,
  validatePostRequest,
  parseGetPagination,
  createNotFoundResponse
} from './lib/validation';
import {
  getConversation,
  getMessagesPaginated,
  getConversationHistory,
  processUserMessage
} from './lib/message-queries';
import { buildGlobalAssistantSystemPrompt } from './lib/system-prompt-builder';
import { buildToolSet } from './lib/tools-builder';
import { createStream } from './lib/streaming';
import { checkRateLimit } from './lib/usage-tracking';

export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await validateReadAuth(request);
    if (authResult instanceof Response) return authResult;
    const { userId } = authResult;

    const { id } = await context.params;

    const conversation = await getConversation(id, userId);
    if (!conversation) {
      return createNotFoundResponse('Conversation');
    }

    const pagination = parseGetPagination(request);
    const { messages, hasMore, nextCursor, prevCursor } = await getMessagesPaginated(id, pagination);

    return NextResponse.json({
      messages,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        limit: pagination.limit,
        direction: pagination.direction
      }
    });
  } catch (error) {
    loggers.api.error('Error fetching messages:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();

  try {
    loggers.api.debug('Global Assistant Chat API: Starting request processing', {});

    const authResult = await validateWriteAuth(request);
    if (authResult instanceof Response) return authResult;
    const { userId } = authResult;

    const { id: conversationId } = await context.params;
    loggers.api.debug('Global Assistant Chat API: Authentication successful', { userId });

    const conversation = await getConversation(conversationId, userId);
    if (!conversation) {
      return createNotFoundResponse('Conversation');
    }

    const bodySizeError = validateBodySize(request);
    if (bodySizeError) return bodySizeError;

    const requestBody = await parsePostBody(request);
    loggers.api.debug('Global Assistant Chat API: Request body received', {
      messageCount: requestBody.messages?.length || 0,
      conversationId,
      selectedProvider: requestBody.selectedProvider,
      selectedModel: requestBody.selectedModel,
      hasLocationContext: !!requestBody.locationContext
    });

    const validation = validatePostRequest(requestBody, conversationId);
    if (validation instanceof Response) return validation;
    const { userMessage, readOnlyMode, webSearchMode } = validation;

    const mentionResult = await processUserMessage(userMessage, conversationId, userId, conversation);
    if (mentionResult instanceof Response) return mentionResult;
    const { mentionSystemPrompt } = mentionResult;

    const providerRequest: ProviderRequest = {
      selectedProvider: requestBody.selectedProvider,
      selectedModel: requestBody.selectedModel,
      googleApiKey: requestBody.googleApiKey,
      openRouterApiKey: requestBody.openRouterApiKey,
      openAIApiKey: requestBody.openAIApiKey,
      anthropicApiKey: requestBody.anthropicApiKey,
      xaiApiKey: requestBody.xaiApiKey,
      ollamaBaseUrl: requestBody.ollamaBaseUrl,
      glmApiKey: requestBody.glmApiKey,
    };

    const providerResult = await createAIProvider(userId, providerRequest);
    if (isProviderError(providerResult)) {
      return createProviderErrorResponse(providerResult);
    }
    const { model, provider: currentProvider, modelName: currentModel } = providerResult;

    await updateUserProviderSettings(userId, requestBody.selectedProvider, requestBody.selectedModel);

    const rateLimitResult = await checkRateLimit(userId, currentProvider, currentModel, conversationId);
    if (!rateLimitResult.allowed && rateLimitResult.response) {
      return rateLimitResult.response;
    }

    loggers.api.debug('Global Assistant Chat API: Read-only mode', { isReadOnly: readOnlyMode });

    loggers.api.debug('Global Assistant Chat API: Loading conversation history from database', {
      conversationId
    });

    const history = await getConversationHistory(conversationId);

    loggers.api.debug('Global Assistant Chat API: Loaded conversation history from database', {
      messageCount: history.uiMessages.length,
      conversationId
    });

    const { finalSystemPrompt, userTimezone } = await buildGlobalAssistantSystemPrompt({
      userId,
      conversation,
      locationContext: requestBody.locationContext,
      mentionSystemPrompt,
      readOnlyMode,
      showPageTree: requestBody.showPageTree ?? false,
    });

    const finalTools = await buildToolSet({
      userId,
      readOnlyMode,
      webSearchMode,
      locationContext: requestBody.locationContext,
      mcpTools: requestBody.mcpTools,
    });

    loggers.api.debug('Global Assistant Chat API: Starting streamText', {
      model: currentModel,
      isReadOnly: readOnlyMode
    });

    const contextCalculation = calculateTotalContextSize({
      systemPrompt: finalSystemPrompt,
      messages: history.sanitizedMessages,
      tools: finalTools,
      model: currentModel,
      provider: currentProvider,
    });

    loggers.api.debug('Global Assistant Chat API: Context calculation', {
      contextSize: contextCalculation.totalTokens,
      messageCount: contextCalculation.messageCount,
      systemPromptTokens: contextCalculation.systemPromptTokens,
      toolTokens: contextCalculation.toolDefinitionTokens,
      wasTruncated: contextCalculation.wasTruncated,
    });

    const { response } = createStream({
      model,
      provider: currentProvider,
      modelName: currentModel,
      userId,
      conversationId,
      userTimezone,
      locationContext: requestBody.locationContext,
      systemPrompt: finalSystemPrompt,
      messages: history.modelMessages,
      tools: finalTools,
      readOnlyMode,
      startTime,
      contextCalculation: {
        totalTokens: contextCalculation.totalTokens,
        messageCount: contextCalculation.messageCount,
        messageIds: contextCalculation.messageIds,
        wasTruncated: contextCalculation.wasTruncated,
        truncationStrategy: contextCalculation.truncationStrategy,
        systemPromptTokens: contextCalculation.systemPromptTokens,
        toolDefinitionTokens: contextCalculation.toolDefinitionTokens,
        conversationTokens: contextCalculation.conversationTokens,
      },
    });

    loggers.api.debug('Global Assistant Chat API: Returning stream response', {});

    return response;

  } catch (error) {
    loggers.api.error('Global Assistant Chat API Error:', error as Error);
    return NextResponse.json({
      error: 'Failed to process chat request. Please try again.'
    }, { status: 500 });
  }
}
