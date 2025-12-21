/**
 * AI Usage Monitoring Module
 * Comprehensive tracking for AI provider usage, tokens, costs, and performance
 */

import { db, aiUsageLogs, sql, and, eq, gte, lte } from '@pagespace/db';
import { writeAiUsage } from '../logging/logger-database';
import { loggers } from '../logging/logger-config';

/**
 * AI Provider Pricing (per 1M tokens)
 * Prices in USD as of 2025-01
 */
export const AI_PRICING = {
  // OpenRouter Paid Models - Anthropic
  'anthropic/claude-opus-4.5': { input: 15.00, output: 75.00 },
  'anthropic/claude-sonnet-4.5': { input: 3.00, output: 15.00 },
  'anthropic/claude-haiku-4.5': { input: 0.80, output: 4.00 },
  'anthropic/claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
  'anthropic/claude-opus-4.1': { input: 15.00, output: 75.00 },

  // OpenRouter Paid Models - OpenAI
  'openai/gpt-5.1': { input: 10.00, output: 40.00 },
  'openai/gpt-5.1-codex': { input: 10.00, output: 40.00 },
  'openai/gpt-5.1-codex-mini': { input: 5.00, output: 20.00 },
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'openai/o3-deep-research': { input: 10.00, output: 40.00 },
  'openai/o4-mini-deep-research': { input: 2.00, output: 8.00 },
  'openai/gpt-5': { input: 10.00, output: 40.00 },
  'openai/gpt-5-mini': { input: 1.00, output: 4.00 },
  'openai/gpt-5-nano': { input: 0.10, output: 0.40 },
  'openai/gpt-oss-120b': { input: 0.00, output: 0.00 },
  'openai/gpt-oss-20b': { input: 0.00, output: 0.00 },

  // OpenRouter Paid Models - Google
  'google/gemini-3-pro-preview': { input: 1.25, output: 5.00 },
  'google/gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'meta-llama/llama-3.1-405b-instruct': { input: 3.00, output: 3.00 },
  'mistralai/mistral-medium-3.1': { input: 2.70, output: 8.10 },
  'mistralai/mistral-small-3.2-24b-instruct': { input: 0.20, output: 0.60 },
  'mistralai/codestral-2508': { input: 0.30, output: 0.90 },
  'mistralai/devstral-medium': { input: 0.40, output: 2.00 },
  'mistralai/devstral-small': { input: 0.10, output: 0.30 },
  'google/gemini-2.5-pro': { input: 1.25, output: 5.00 },
  'google/gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'google/gemini-2.5-flash-lite': { input: 0.02, output: 0.08 },
  'google/gemini-2.5-flash-lite-preview-06-17': { input: 0.02, output: 0.08 },
  'google/gemini-2.0-pro': { input: 1.25, output: 5.00 },

  // OpenRouter Paid Models - Chinese/Asian
  'z-ai/glm-4.5v': { input: 0.10, output: 0.40 },
  'z-ai/glm-4.5': { input: 0.10, output: 0.40 },
  'z-ai/glm-4.5-air': { input: 0.10, output: 0.40 },
  'z-ai/glm-4-32b': { input: 0.10, output: 0.40 },
  'qwen/qwen3-max': { input: 0.50, output: 1.50 },
  'qwen/qwen3-235b-a22b-thinking-2507': { input: 0.50, output: 1.50 },
  'qwen/qwen3-235b-a22b-2507': { input: 0.50, output: 1.50 },
  'qwen/qwen3-coder': { input: 0.50, output: 1.50 },
  'moonshotai/kimi-k2': { input: 0.20, output: 0.60 },
  'minimax/minimax-m1': { input: 0.20, output: 0.60 },

  // OpenRouter Paid Models - DeepSeek
  'deepseek/deepseek-v3.1-terminus': { input: 0.14, output: 0.28 },

  // OpenRouter Paid Models - AI21
  'ai21/jamba-mini-1.7': { input: 0.50, output: 0.70 },
  'ai21/jamba-large-1.7': { input: 0.50, output: 0.70 },

  // OpenRouter Paid Models - xAI
  'x-ai/grok-4-fast': { input: 5.00, output: 15.00 },
  'x-ai/grok-4': { input: 5.00, output: 15.00 },

  // OpenRouter Paid Models - Other
  'inception/mercury': { input: 0.50, output: 1.50 },

  // Google AI Direct Models
  'gemini-3-pro': { input: 1.25, output: 5.00 },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'gemini-2.5-pro': { input: 1.25, output: 5.00 },
  'gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash-lite': { input: 0.02, output: 0.08 },
  'gemini-2.0-pro-exp': { input: 0.00, output: 0.00 }, // Free during preview
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-exp': { input: 0.00, output: 0.00 }, // Free during preview
  'gemini-2.0-flash-lite': { input: 0.04, output: 0.16 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },

  // OpenAI Direct Models
  'gpt-5.1': { input: 10.00, output: 40.00 },
  'gpt-5.1-codex': { input: 10.00, output: 40.00 },
  'gpt-5': { input: 10.00, output: 40.00 },
  'gpt-5-mini': { input: 1.00, output: 4.00 },
  'gpt-5-nano': { input: 0.10, output: 0.40 },
  'gpt-4.1-2025-04-14': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini-2025-04-14': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano-2025-04-14': { input: 0.10, output: 0.40 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o-audio-preview': { input: 2.50, output: 10.00 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'o4-mini-2025-04-16': { input: 15.00, output: 60.00 },
  'o3': { input: 15.00, output: 60.00 },
  'o3-mini': { input: 15.00, output: 60.00 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 15.00, output: 60.00 },
  'o1-preview': { input: 15.00, output: 60.00 },

  // Anthropic Direct Models
  'claude-opus-4-5-20251124': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-opus-4-1-20250805': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-1-20250805': { input: 3.00, output: 15.00 },
  'claude-3-7-sonnet-20250219': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
  'claude-3-5-haiku-latest': { input: 0.80, output: 4.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-opus-latest': { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229': { input: 3.00, output: 15.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

  // xAI Direct Models
  'grok-4': { input: 5.00, output: 15.00 },
  'grok-4-fast-reasoning': { input: 5.00, output: 15.00 },
  'grok-4-fast-non-reasoning': { input: 5.00, output: 15.00 },
  'grok-code-fast-1': { input: 5.00, output: 15.00 },
  'grok-3': { input: 5.00, output: 15.00 },
  'grok-3-latest': { input: 5.00, output: 15.00 },
  'grok-3-fast': { input: 5.00, output: 15.00 },
  'grok-3-fast-latest': { input: 5.00, output: 15.00 },
  'grok-3-mini': { input: 5.00, output: 15.00 },
  'grok-3-mini-latest': { input: 5.00, output: 15.00 },
  'grok-3-mini-fast': { input: 5.00, output: 15.00 },
  'grok-3-mini-fast-latest': { input: 5.00, output: 15.00 },
  'grok-2': { input: 5.00, output: 15.00 },
  'grok-2-latest': { input: 5.00, output: 15.00 },
  'grok-2-1212': { input: 5.00, output: 15.00 },
  'grok-2-vision': { input: 5.00, output: 15.00 },
  'grok-2-vision-latest': { input: 5.00, output: 15.00 },
  'grok-2-vision-1212': { input: 5.00, output: 15.00 },
  'grok-beta': { input: 5.00, output: 15.00 },
  'grok-vision-beta': { input: 5.00, output: 15.00 },

  // MiniMax Direct Models
  'MiniMax-M2': { input: 0.20, output: 0.60 },
  'MiniMax-M2-Stable': { input: 0.20, output: 0.60 },

  // GLM Direct Models
  'glm-4.6': { input: 0.10, output: 0.40 },

  // Ollama (local) - no cost
  'llama3.2': { input: 0, output: 0 },
  'llama3.2-vision': { input: 0, output: 0 },
  'llama3.1': { input: 0, output: 0 },
  'qwen2.5-coder': { input: 0, output: 0 },
  'deepseek-r1': { input: 0, output: 0 },
  'gemma2': { input: 0, output: 0 },
  'mistral': { input: 0, output: 0 },
  'phi3': { input: 0, output: 0 },
  
  // Default/Unknown models
  'default': { input: 0, output: 0 }
} as const;

/**
 * Model Context Window Sizes (in tokens)
 * Maximum context length for each model
 * Updated November 2025
 */
export const MODEL_CONTEXT_WINDOWS = {
  // OpenRouter Models - Anthropic
  'anthropic/claude-opus-4.5': 200000,
  'anthropic/claude-sonnet-4.5': 200000,
  'anthropic/claude-haiku-4.5': 200000,
  'anthropic/claude-3.5-sonnet': 200000,
  'anthropic/claude-3-haiku': 200000,
  'anthropic/claude-opus-4.1': 200000,

  // OpenRouter Models - OpenAI
  'openai/gpt-5.1': 400000,
  'openai/gpt-5.1-codex': 400000,
  'openai/gpt-5.1-codex-mini': 400000,
  'openai/gpt-4o': 128000,
  'openai/gpt-4o-mini': 128000,
  'openai/o3-deep-research': 200000,
  'openai/o4-mini-deep-research': 200000,
  'openai/gpt-5': 272000,
  'openai/gpt-5-mini': 128000,
  'openai/gpt-5-nano': 128000,
  'openai/gpt-oss-120b': 128000,
  'openai/gpt-oss-20b': 128000,

  // OpenRouter Models - Other
  'meta-llama/llama-3.1-405b-instruct': 128000,
  'mistralai/mistral-medium-3.1': 128000,
  'mistralai/mistral-small-3.2-24b-instruct': 32000,
  'mistralai/codestral-2508': 32000,
  'mistralai/devstral-medium': 128000,
  'mistralai/devstral-small': 128000,

  // OpenRouter Models - Google
  'google/gemini-3-pro-preview': 1048576,
  'google/gemini-3-flash-preview': 1048576,
  'google/gemini-2.5-pro': 2000000,
  'google/gemini-2.5-flash': 1000000,
  'google/gemini-2.5-flash-lite': 1000000,
  'google/gemini-2.5-flash-lite-preview-06-17': 1000000,
  'google/gemini-2.0-pro': 2000000,
  'google/gemini-2.0-flash': 1000000,

  // OpenRouter Models - Chinese/Asian
  'z-ai/glm-4.5v': 128000,
  'z-ai/glm-4.5': 128000,
  'z-ai/glm-4.5-air': 128000,
  'z-ai/glm-4-32b': 128000,
  'qwen/qwen3-max': 128000,
  'qwen/qwen3-235b-a22b-thinking-2507': 128000,
  'qwen/qwen3-235b-a22b-2507': 128000,
  'qwen/qwen3-coder': 128000,
  'moonshotai/kimi-k2': 128000,
  'minimax/minimax-m1': 128000,

  // OpenRouter Models - DeepSeek
  'deepseek/deepseek-v3.1-terminus': 128000,

  // OpenRouter Models - AI21
  'ai21/jamba-mini-1.7': 256000,
  'ai21/jamba-large-1.7': 256000,

  // OpenRouter Models - xAI
  'x-ai/grok-4-fast': 2000000,
  'x-ai/grok-4': 128000,

  // OpenRouter Models - Other
  'inception/mercury': 128000,

  // Google AI Direct Models
  'gemini-3-pro': 1048576,
  'gemini-3-flash-preview': 1048576,
  'gemini-2.5-pro': 2000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-flash-lite': 1000000,
  'gemini-2.0-pro-exp': 2000000,
  'gemini-2.0-flash': 1000000,
  'gemini-2.0-flash-exp': 1000000,
  'gemini-2.0-flash-lite': 1000000,
  'gemini-1.5-flash': 1000000,
  'gemini-1.5-flash-8b': 1000000,
  'gemini-1.5-pro': 2000000,

  // OpenAI Direct Models
  'gpt-5.1': 400000,
  'gpt-5.1-codex': 400000,
  'gpt-5': 272000,
  'gpt-5-mini': 128000,
  'gpt-5-nano': 128000,
  'gpt-4.1-2025-04-14': 400000,
  'gpt-4.1-mini-2025-04-14': 400000,
  'gpt-4.1-nano-2025-04-14': 400000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4o-audio-preview': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'o4-mini-2025-04-16': 200000,
  'o3': 200000,
  'o3-mini': 200000,
  'o1': 200000,
  'o1-mini': 200000,
  'o1-preview': 200000,

  // Anthropic Direct Models
  'claude-opus-4-5-20251124': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4-5-20250929': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-opus-4-1-20250805': 200000,
  'claude-sonnet-4-1-20250805': 200000,
  'claude-3-7-sonnet-20250219': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-5-sonnet-latest': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-5-haiku-latest': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-opus-latest': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,

  // xAI Models
  'grok-4': 128000,
  'grok-4-fast-reasoning': 2000000,
  'grok-4-fast-non-reasoning': 2000000,
  'grok-code-fast-1': 128000,
  'grok-3': 128000,
  'grok-3-latest': 128000,
  'grok-3-fast': 128000,
  'grok-3-fast-latest': 128000,
  'grok-3-mini': 128000,
  'grok-3-mini-latest': 128000,
  'grok-3-mini-fast': 128000,
  'grok-3-mini-fast-latest': 128000,
  'grok-2': 128000,
  'grok-2-latest': 128000,
  'grok-2-1212': 128000,
  'grok-2-vision': 128000,
  'grok-2-vision-latest': 128000,
  'grok-2-vision-1212': 128000,
  'grok-beta': 128000,
  'grok-vision-beta': 128000,

  // MiniMax Direct Models
  'MiniMax-M2': 128000,
  'MiniMax-M2-Stable': 128000,

  // PageSpace/GLM Models
  'glm-4.6': 200000,
  'glm-4.5': 128000,
  'glm-4.5-air': 128000,

  // Ollama (local) - context varies by model and configuration
  'llama3.2': 128000,
  'llama3.2-vision': 128000,
  'llama3.1': 128000,
  'qwen2.5-coder': 32000,
  'deepseek-r1': 64000,
  'gemma2': 8192,
  'mistral': 32000,
  'phi3': 128000,

  // Default
  'default': 200000 // Updated default for newer models
} as const;

/**
 * Get context window size for a model
 */
export function getContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model as keyof typeof MODEL_CONTEXT_WINDOWS] || MODEL_CONTEXT_WINDOWS.default;
}

/**
 * Calculate cost based on tokens and model
 */
export function calculateCost(
  model: string,
  inputTokens: number = 0,
  outputTokens: number = 0
): number {
  const pricing = AI_PRICING[model as keyof typeof AI_PRICING] || AI_PRICING.default;
  
  // Convert from per-million to actual cost
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  
  return Number((inputCost + outputCost).toFixed(6));
}

/**
 * Estimate tokens from text (rough approximation)
 * Generally 1 token ≈ 4 characters for English text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Enhanced AI usage tracking with token counting and cost calculation
 */
export interface AIUsageData {
  userId: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  prompt?: string;
  completion?: string;
  duration?: number;
  streamingDuration?: number;
  conversationId?: string;
  messageId?: string;
  pageId?: string;
  driveId?: string;
  success?: boolean;
  error?: string;
  metadata?: any;

  // Context tracking - track actual conversation context vs billing tokens
  contextMessages?: string[]; // Array of message IDs included in this call's context
  contextSize?: number; // Actual tokens in context (input + system prompt + tools)
  systemPromptTokens?: number; // Tokens used by system prompt
  toolDefinitionTokens?: number; // Tokens used by tool schemas
  conversationTokens?: number; // Tokens from actual messages
  messageCount?: number; // Number of messages in context
  wasTruncated?: boolean; // Whether context was truncated
  truncationStrategy?: string; // 'none' | 'oldest_first' | 'smart'
}

/**
 * Track AI usage with automatic cost calculation
 */
export async function trackAIUsage(data: AIUsageData): Promise<void> {
  try {
    // Calculate tokens if not provided
    let { inputTokens, outputTokens, totalTokens } = data;
    
    // If we have prompt/completion but no tokens, estimate them
    if (!inputTokens && data.prompt) {
      inputTokens = estimateTokens(data.prompt);
    }
    if (!outputTokens && data.completion) {
      outputTokens = estimateTokens(data.completion);
    }
    
    // Calculate total if not provided
    if (!totalTokens && (inputTokens || outputTokens)) {
      totalTokens = (inputTokens || 0) + (outputTokens || 0);
    }
    
    // Calculate cost
    const cost = calculateCost(data.model, inputTokens, outputTokens);
    
    // Fire and forget - don't await
    writeAiUsage({
      userId: data.userId,
      provider: data.provider,
      model: data.model,
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
      duration: data.duration,
      conversationId: data.conversationId,
      messageId: data.messageId,
      pageId: data.pageId,
      driveId: data.driveId,
      success: data.success !== false,
      error: data.error,

      // Context tracking
      contextMessages: data.contextMessages,
      contextSize: data.contextSize,
      systemPromptTokens: data.systemPromptTokens,
      toolDefinitionTokens: data.toolDefinitionTokens,
      conversationTokens: data.conversationTokens,
      messageCount: data.messageCount,
      wasTruncated: data.wasTruncated,
      truncationStrategy: data.truncationStrategy,

      metadata: {
        ...data.metadata,
        streamingDuration: data.streamingDuration,
        prompt: data.prompt?.substring(0, 1000),
        completion: data.completion?.substring(0, 1000)
      },
    }).catch((error) => {
      loggers.ai.debug('AI usage tracking failed', {
        error: (error as Error).message,
        model: data.model,
        provider: data.provider
      });
    });
  } catch (error) {
    loggers.ai.debug('AI usage calculation failed', { 
      error: (error as Error).message 
    });
  }
}

/**
 * Track AI tool usage
 */
export interface AIToolUsage {
  userId: string;
  provider: string;
  model: string;
  toolName: string;
  toolId?: string;
  args?: any;
  result?: any;
  duration?: number;
  success?: boolean;
  error?: string;
  conversationId?: string;
  pageId?: string;
}

export async function trackAIToolUsage(data: AIToolUsage): Promise<void> {
  trackAIUsage({
    userId: data.userId,
    provider: data.provider,
    model: data.model,
    duration: data.duration,
    conversationId: data.conversationId,
    pageId: data.pageId,
    success: data.success,
    error: data.error,
    metadata: {
      type: 'tool_call',
      toolName: data.toolName,
      toolId: data.toolId,
      args: data.args,
      result: data.result
    }
  });
}

/**
 * Get AI usage statistics for a user
 */
export async function getUserAIStats(
  userId: string,
  startDate?: Date,
  endDate?: Date
): Promise<{
  totalCost: number;
  totalTokens: number;
  requestCount: number;
  successRate: number;
  averageDuration: number;
  byProvider: Record<string, { cost: number; tokens: number; requests: number }>;
  byModel: Record<string, { cost: number; tokens: number; requests: number }>;
}> {
  try {
    const conditions = [eq(aiUsageLogs.userId, userId)];
    
    if (startDate) {
      conditions.push(gte(aiUsageLogs.timestamp, startDate));
    }
    if (endDate) {
      conditions.push(lte(aiUsageLogs.timestamp, endDate));
    }
    
    const usage = await db
      .select({
        provider: aiUsageLogs.provider,
        model: aiUsageLogs.model,
        cost: aiUsageLogs.cost,
        totalTokens: aiUsageLogs.totalTokens,
        duration: aiUsageLogs.duration,
        success: aiUsageLogs.success,
      })
      .from(aiUsageLogs)
      .where(and(...conditions));
    
    // Calculate statistics
    let totalCost = 0;
    let totalTokens = 0;
    let totalDuration = 0;
    let successCount = 0;
    const byProvider: Record<string, { cost: number; tokens: number; requests: number }> = {};
    const byModel: Record<string, { cost: number; tokens: number; requests: number }> = {};
    
    for (const record of usage) {
      const cost = record.cost || 0;
      const tokens = record.totalTokens || 0;
      
      totalCost += cost;
      totalTokens += tokens;
      
      if (record.duration) {
        totalDuration += record.duration;
      }
      
      if (record.success) {
        successCount++;
      }
      
      // Aggregate by provider
      if (!byProvider[record.provider]) {
        byProvider[record.provider] = { cost: 0, tokens: 0, requests: 0 };
      }
      byProvider[record.provider].cost += cost;
      byProvider[record.provider].tokens += tokens;
      byProvider[record.provider].requests++;
      
      // Aggregate by model
      if (!byModel[record.model]) {
        byModel[record.model] = { cost: 0, tokens: 0, requests: 0 };
      }
      byModel[record.model].cost += cost;
      byModel[record.model].tokens += tokens;
      byModel[record.model].requests++;
    }
    
    return {
      totalCost: Number(totalCost.toFixed(6)),
      totalTokens,
      requestCount: usage.length,
      successRate: usage.length > 0 ? (successCount / usage.length) * 100 : 0,
      averageDuration: usage.length > 0 ? Math.round(totalDuration / usage.length) : 0,
      byProvider,
      byModel,
    };
  } catch (error) {
    loggers.ai.error('Failed to get AI usage stats', error as Error);
    return {
      totalCost: 0,
      totalTokens: 0,
      requestCount: 0,
      successRate: 0,
      averageDuration: 0,
      byProvider: {},
      byModel: {},
    };
  }
}

/**
 * Get popular AI features
 */
export async function getPopularAIFeatures(
  limit: number = 10,
  startDate?: Date,
  endDate?: Date
): Promise<Array<{ feature: string; count: number; users: number }>> {
  try {
    const conditions = [];
    
    if (startDate) {
      conditions.push(gte(aiUsageLogs.timestamp, startDate));
    }
    if (endDate) {
      conditions.push(lte(aiUsageLogs.timestamp, endDate));
    }
    
    // Query to get feature usage from metadata
    const query = conditions.length > 0 
      ? db.select({
          metadata: aiUsageLogs.metadata,
          userId: aiUsageLogs.userId,
        })
        .from(aiUsageLogs)
        .where(and(...conditions))
      : db.select({
          metadata: aiUsageLogs.metadata,
          userId: aiUsageLogs.userId,
        })
        .from(aiUsageLogs);
    
    const usage = await query;
    
    // Extract and count features
    const featureMap = new Map<string, Set<string>>();
    
    for (const record of usage) {
      if (record.metadata && typeof record.metadata === 'object') {
        const metadata = record.metadata as any;
        const feature = metadata.type || metadata.feature || 'general_chat';
        
        if (!featureMap.has(feature)) {
          featureMap.set(feature, new Set());
        }
        featureMap.get(feature)!.add(record.userId);
      }
    }
    
    // Convert to array and sort
    const features = Array.from(featureMap.entries())
      .map(([feature, users]) => ({
        feature,
        count: users.size,
        users: users.size,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    
    return features;
  } catch (error) {
    loggers.ai.error('Failed to get popular AI features', error as Error);
    return [];
  }
}

/**
 * Detect error patterns in AI usage
 */
export async function detectAIErrorPatterns(
  limit: number = 10,
  startDate?: Date
): Promise<Array<{ 
  pattern: string; 
  count: number; 
  providers: string[]; 
  models: string[];
  sample: string;
}>> {
  try {
    const conditions = [
      eq(aiUsageLogs.success, false)
    ];
    
    if (startDate) {
      conditions.push(gte(aiUsageLogs.timestamp, startDate));
    }
    
    const errors = await db
      .select({
        error: aiUsageLogs.error,
        provider: aiUsageLogs.provider,
        model: aiUsageLogs.model,
      })
      .from(aiUsageLogs)
      .where(and(...conditions))
      .limit(1000); // Analyze recent 1000 errors
    
    // Group errors by pattern
    const errorPatterns = new Map<string, {
      count: number;
      providers: Set<string>;
      models: Set<string>;
      sample: string;
    }>();
    
    for (const record of errors) {
      if (!record.error) continue;
      
      // Extract error pattern (simplified - could be enhanced)
      let pattern = 'unknown_error';
      const error = record.error.toLowerCase();
      
      if (error.includes('rate limit')) {
        pattern = 'rate_limit_exceeded';
      } else if (error.includes('timeout')) {
        pattern = 'request_timeout';
      } else if (error.includes('token') && error.includes('limit')) {
        pattern = 'token_limit_exceeded';
      } else if (error.includes('invalid') && error.includes('key')) {
        pattern = 'invalid_api_key';
      } else if (error.includes('network')) {
        pattern = 'network_error';
      } else if (error.includes('model not found')) {
        pattern = 'model_not_found';
      } else if (error.includes('context')) {
        pattern = 'context_length_exceeded';
      }
      
      if (!errorPatterns.has(pattern)) {
        errorPatterns.set(pattern, {
          count: 0,
          providers: new Set(),
          models: new Set(),
          sample: record.error,
        });
      }
      
      const patternData = errorPatterns.get(pattern)!;
      patternData.count++;
      patternData.providers.add(record.provider);
      patternData.models.add(record.model);
    }
    
    // Convert to array and sort
    return Array.from(errorPatterns.entries())
      .map(([pattern, data]) => ({
        pattern,
        count: data.count,
        providers: Array.from(data.providers),
        models: Array.from(data.models),
        sample: data.sample.substring(0, 200),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  } catch (error) {
    loggers.ai.error('Failed to detect AI error patterns', error as Error);
    return [];
  }
}

/**
 * Calculate token efficiency metrics
 */
export async function getTokenEfficiencyMetrics(
  userId?: string,
  startDate?: Date,
  endDate?: Date
): Promise<{
  averageTokensPerRequest: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  inputOutputRatio: number;
  costPerThousandTokens: number;
  mostEfficientModel: string | null;
  leastEfficientModel: string | null;
}> {
  try {
    const conditions = [];
    
    if (userId) {
      conditions.push(eq(aiUsageLogs.userId, userId));
    }
    if (startDate) {
      conditions.push(gte(aiUsageLogs.timestamp, startDate));
    }
    if (endDate) {
      conditions.push(lte(aiUsageLogs.timestamp, endDate));
    }
    
    const usage = await db
      .select({
        model: aiUsageLogs.model,
        inputTokens: aiUsageLogs.inputTokens,
        outputTokens: aiUsageLogs.outputTokens,
        totalTokens: aiUsageLogs.totalTokens,
        cost: aiUsageLogs.cost,
      })
      .from(aiUsageLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    
    if (usage.length === 0) {
      return {
        averageTokensPerRequest: 0,
        averageInputTokens: 0,
        averageOutputTokens: 0,
        inputOutputRatio: 0,
        costPerThousandTokens: 0,
        mostEfficientModel: null,
        leastEfficientModel: null,
      };
    }
    
    // Calculate metrics
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCost = 0;
    const modelEfficiency = new Map<string, { tokens: number; cost: number; count: number }>();
    
    for (const record of usage) {
      totalInputTokens += record.inputTokens || 0;
      totalOutputTokens += record.outputTokens || 0;
      totalTokens += record.totalTokens || 0;
      totalCost += record.cost || 0;
      
      // Track per-model efficiency
      if (!modelEfficiency.has(record.model)) {
        modelEfficiency.set(record.model, { tokens: 0, cost: 0, count: 0 });
      }
      const modelData = modelEfficiency.get(record.model)!;
      modelData.tokens += record.totalTokens || 0;
      modelData.cost += record.cost || 0;
      modelData.count++;
    }
    
    // Find most/least efficient models
    let mostEfficient: { model: string; costPerToken: number } | null = null;
    let leastEfficient: { model: string; costPerToken: number } | null = null;
    
    for (const [model, data] of modelEfficiency.entries()) {
      if (data.tokens > 0) {
        const costPerToken = data.cost / data.tokens;
        
        if (!mostEfficient || costPerToken < mostEfficient.costPerToken) {
          mostEfficient = { model, costPerToken };
        }
        if (!leastEfficient || costPerToken > leastEfficient.costPerToken) {
          leastEfficient = { model, costPerToken };
        }
      }
    }
    
    return {
      averageTokensPerRequest: Math.round(totalTokens / usage.length),
      averageInputTokens: Math.round(totalInputTokens / usage.length),
      averageOutputTokens: Math.round(totalOutputTokens / usage.length),
      inputOutputRatio: totalInputTokens > 0 ? Number((totalOutputTokens / totalInputTokens).toFixed(2)) : 0,
      costPerThousandTokens: totalTokens > 0 ? Number((totalCost / totalTokens * 1000).toFixed(4)) : 0,
      mostEfficientModel: mostEfficient?.model || null,
      leastEfficientModel: leastEfficient?.model || null,
    };
  } catch (error) {
    loggers.ai.error('Failed to calculate token efficiency metrics', error as Error);
    return {
      averageTokensPerRequest: 0,
      averageInputTokens: 0,
      averageOutputTokens: 0,
      inputOutputRatio: 0,
      costPerThousandTokens: 0,
      mostEfficientModel: null,
      leastEfficientModel: null,
    };
  }
}

/**
 * Export all monitoring functions for easy access
 */
export const AIMonitoring = {
  trackUsage: trackAIUsage,
  trackToolUsage: trackAIToolUsage,
  getUserStats: getUserAIStats,
  getPopularFeatures: getPopularAIFeatures,
  detectErrorPatterns: detectAIErrorPatterns,
  getEfficiencyMetrics: getTokenEfficiencyMetrics,
  calculateCost,
  estimateTokens,
  getContextWindow,
  pricing: AI_PRICING,
  contextWindows: MODEL_CONTEXT_WINDOWS,
};