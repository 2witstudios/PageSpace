import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { incrementUsage, getCurrentUsage, getUserUsageSummary } from '@/lib/subscription/usage-service';
import { createRateLimitResponse } from '@/lib/subscription/rate-limit-middleware';
import { broadcastUsageEvent } from '@/lib/websocket';
import { getPageSpaceModelTier } from '@/lib/ai/core/ai-providers-config';
import { AIMonitoring } from '@pagespace/lib/ai-monitoring';
import { NextResponse } from 'next/server';

export interface RateLimitCheckResult {
  allowed: boolean;
  response?: Response;
  providerType?: 'standard' | 'pro';
  remainingCalls?: number;
  limit?: number;
}

export async function checkRateLimit(
  userId: string,
  provider: string,
  modelName: string,
  conversationId: string
): Promise<RateLimitCheckResult> {
  if (provider !== 'pagespace') {
    return { allowed: true };
  }

  const providerType = getPageSpaceModelTier(modelName) ?? 'standard';

  loggers.api.debug('Global Assistant Chat API: Checking rate limit before streaming', {
    userId: maskIdentifier(userId),
    provider,
    model: modelName,
    providerType,
    conversationId
  });

  const currentUsage = await getCurrentUsage(userId, providerType);

  if (!currentUsage.success || currentUsage.remainingCalls <= 0) {
    loggers.api.warn('Global Assistant Chat API: Rate limit exceeded', {
      userId: maskIdentifier(userId),
      providerType,
      currentCount: currentUsage.currentCount,
      limit: currentUsage.limit,
      remaining: currentUsage.remainingCalls,
      conversationId
    });

    return {
      allowed: false,
      response: createRateLimitResponse(providerType, currentUsage.limit),
    };
  }

  loggers.api.debug('Global Assistant Chat API: Rate limit check passed', {
    userId: maskIdentifier(userId),
    providerType,
    remaining: currentUsage.remainingCalls,
    limit: currentUsage.limit,
    conversationId
  });

  return {
    allowed: true,
    providerType,
    remainingCalls: currentUsage.remainingCalls,
    limit: currentUsage.limit,
  };
}

export interface AIMonitoringParams {
  userId: string;
  provider: string;
  modelName: string;
  conversationId: string;
  messageId: string;
  startTime: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextCalculation?: {
    totalTokens: number;
    messageCount: number;
    messageIds: string[];
    wasTruncated: boolean;
    truncationStrategy?: string;
    systemPromptTokens: number;
    toolDefinitionTokens: number;
    conversationTokens: number;
  };
  toolCallsCount: number;
  toolResultsCount: number;
  readOnlyMode: boolean;
}

export async function trackAIMonitoring(params: AIMonitoringParams): Promise<void> {
  const {
    userId,
    provider,
    modelName,
    conversationId,
    messageId,
    startTime,
    inputTokens,
    outputTokens,
    totalTokens,
    contextCalculation,
    toolCallsCount,
    toolResultsCount,
    readOnlyMode,
  } = params;

  if (!totalTokens || totalTokens <= 0) {
    return;
  }

  try {
    const duration = Date.now() - startTime;

    await AIMonitoring.trackUsage({
      userId,
      provider,
      model: modelName,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      totalTokens,
      duration,
      conversationId,
      messageId,
      success: true,
      contextMessages: contextCalculation?.messageIds ?? [],
      contextSize: contextCalculation?.totalTokens ?? 0,
      systemPromptTokens: contextCalculation?.systemPromptTokens ?? 0,
      toolDefinitionTokens: contextCalculation?.toolDefinitionTokens ?? 0,
      conversationTokens: contextCalculation?.conversationTokens ?? 0,
      messageCount: contextCalculation?.messageCount ?? 0,
      wasTruncated: contextCalculation?.wasTruncated ?? false,
      truncationStrategy: contextCalculation?.truncationStrategy,
      metadata: {
        toolCallsCount,
        toolResultsCount,
        isReadOnly: readOnlyMode,
      }
    });
  } catch (trackingError) {
    loggers.api.debug('Global Assistant: Could not track AI usage (stream aborted or failed)', {
      conversationId: maskIdentifier(conversationId),
      messageId: maskIdentifier(messageId),
      error: trackingError instanceof Error ? trackingError.message : 'Unknown error',
    });
  }
}

export async function trackPageSpaceUsage(params: {
  userId: string;
  modelName: string;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  const { userId, modelName, conversationId, messageId } = params;
  const usageLogger = loggers.api.child({ module: 'global-assistant-usage' });

  try {
    const providerType = getPageSpaceModelTier(modelName) ?? 'standard';

    const usageResult = await incrementUsage(userId, providerType);

    usageLogger.info('Global Assistant usage incremented', {
      userId: maskIdentifier(userId),
      provider: 'pagespace',
      providerType,
      messageId: maskIdentifier(messageId),
      conversationId: maskIdentifier(conversationId),
      currentCount: usageResult.currentCount,
      limit: usageResult.limit,
      remaining: usageResult.remainingCalls,
      success: usageResult.success,
    });

    try {
      const currentUsageSummary = await getUserUsageSummary(userId);
      await broadcastUsageEvent({
        userId,
        operation: 'updated',
        subscriptionTier: currentUsageSummary.subscriptionTier as 'free' | 'pro',
        standard: currentUsageSummary.standard,
        pro: currentUsageSummary.pro
      });
    } catch (broadcastError) {
      usageLogger.error('Global Assistant usage broadcast failed', broadcastError instanceof Error ? broadcastError : undefined, {
        userId: maskIdentifier(userId),
        conversationId: maskIdentifier(conversationId),
      });
    }
  } catch (usageError) {
    usageLogger.error('Global Assistant usage tracking failed', usageError as Error, {
      userId: maskIdentifier(userId),
      provider: 'pagespace',
      messageId: maskIdentifier(messageId),
      conversationId: maskIdentifier(conversationId),
    });
  }
}
