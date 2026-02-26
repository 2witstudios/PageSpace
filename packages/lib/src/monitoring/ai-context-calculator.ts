/**
 * AI Context Calculator
 *
 * Calculates actual conversation context size (not cumulative billing tokens).
 * Tracks which messages are included in each API call to determine real context window usage.
 */

import { MODEL_CONTEXT_WINDOWS } from './model-context-windows';

/**
 * Minimal UIMessage type for token estimation
 * (Compatible with Vercel AI SDK UIMessage)
 */
export interface UIMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  parts?: Array<{
    type: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    // AI SDK canonical format
    args?: unknown;
    result?: unknown;
    // PageSpace DB format (tool-{toolName} parts)
    input?: unknown;
    output?: unknown;
    state?: string;
  }>;
}

/**
 * Configuration for context calculation
 */
export interface ContextConfig {
  systemPrompt?: string;
  messages: UIMessage[];
  tools?: Record<string, unknown>;
  model: string;
  provider?: string;
}

/**
 * Result of context calculation
 */
export interface ContextCalculation {
  totalTokens: number;
  systemPromptTokens: number;
  toolDefinitionTokens: number;
  conversationTokens: number;
  messageCount: number;
  messageIds: string[];
  wasTruncated: boolean;
  truncationStrategy: 'none' | 'oldest_first' | 'smart';
}

/**
 * Estimate tokens in a text string.
 * Uses ~4 chars/token for Latin text, ~2 chars/token when significant
 * non-ASCII / CJK content is detected (CJK characters often tokenize to 1-2 tokens each).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Count non-ASCII characters with a for-loop instead of regex to avoid
  // allocating a large match array on big strings.
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      nonAsciiCount++;
    }
  }
  const nonAsciiRatio = nonAsciiCount / text.length;

  // Use 2 chars/token when >20% non-ASCII (CJK-heavy), else 4 chars/token
  const charsPerToken = nonAsciiRatio > 0.2 ? 2 : 4;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate tokens in system prompt
 */
export function estimateSystemPromptTokens(prompt?: string): number {
  if (!prompt) return 0;
  return estimateTokens(prompt);
}

/**
 * Estimate tokens in tool definitions
 * Tool schemas can be quite large (JSON schemas, descriptions, etc.)
 */
export function estimateToolDefinitionTokens(tools?: Record<string, unknown>): number {
  if (!tools || Object.keys(tools).length === 0) return 0;

  try {
    // Convert tools to JSON to estimate size
    const toolsJson = JSON.stringify(tools);
    return estimateTokens(toolsJson);
  } catch (error) {
    // If tools can't be stringified, estimate based on count
    const toolCount = Object.keys(tools).length;
    return toolCount * 150; // Conservative estimate: 150 tokens per tool
  }
}

/**
 * Estimate tokens in a single message
 * Includes role, content, and any metadata
 */
export function estimateMessageTokens(message: UIMessage): number {
  let tokens = 0;

  // Role: ~3-5 tokens
  tokens += 5;

  // Content - handle message parts structure
  if (message.parts && Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (part.type === 'text' && part.text) {
        tokens += estimateTokens(part.text);
      } else if (part.type === 'tool-call' && part.toolCallId) {
        // AI SDK canonical tool-call format
        tokens += 10; // Tool call ID
        if (part.toolName) {
          tokens += estimateTokens(part.toolName);
        }
        if (part.args) {
          tokens += estimateTokens(JSON.stringify(part.args));
        }
      } else if (part.type === 'tool-result' && part.toolCallId) {
        // AI SDK canonical tool-result format
        tokens += 10; // Tool call ID
        if (part.result) {
          const resultStr = typeof part.result === 'string'
            ? part.result
            : JSON.stringify(part.result);
          tokens += estimateTokens(resultStr);
        }
      } else if (part.type.startsWith('tool-')) {
        // PageSpace DB format: tool-{toolName} parts with input/output/state fields
        tokens += 10; // Tool call ID overhead
        if (part.toolName) {
          tokens += estimateTokens(part.toolName);
        }
        if (part.input) {
          tokens += estimateTokens(JSON.stringify(part.input));
        }
        if (part.output) {
          const outputStr = typeof part.output === 'string'
            ? part.output
            : JSON.stringify(part.output);
          tokens += estimateTokens(outputStr);
        }
      }
    }
  }

  // Message overhead (timestamps, IDs, etc): ~10 tokens
  tokens += 10;

  return tokens;
}

/**
 * Get context window size for a model
 * Returns the maximum number of tokens the model can handle
 */
export function getContextWindowSize(model: string, provider?: string): number {
  // First, check canonical MODEL_CONTEXT_WINDOWS map for exact match
  const fullKey = provider ? `${provider}/${model}` : '';
  if (fullKey && fullKey in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[fullKey as keyof typeof MODEL_CONTEXT_WINDOWS];
  }
  if (model in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[model as keyof typeof MODEL_CONTEXT_WINDOWS];
  }

  // Fallback to heuristic pattern matching for unknown models
  const providerLower = provider?.toLowerCase() || '';
  const modelLower = model.toLowerCase();

  // OpenAI models
  if (providerLower === 'openai' || modelLower.includes('gpt')) {
    // GPT-5.2 models (400k/256k context)
    if (modelLower.includes('gpt-5.2')) {
      if (modelLower.includes('mini') || modelLower.includes('nano')) {
        return 256_000;
      }
      return 400_000;
    }
    // GPT-5.1 models (400k context)
    if (modelLower.includes('gpt-5.1')) {
      return 400_000;
    }
    // GPT-5.0 models (272k/128k context)
    if (modelLower.includes('gpt-5')) {
      if (modelLower.includes('mini') || modelLower.includes('nano')) {
        return 128_000;
      }
      return 272_000;
    }
    if (modelLower.includes('gpt-4o')) return 128_000;
    if (modelLower.includes('gpt-4-turbo')) return 128_000;
    if (modelLower.includes('gpt-4')) return 8_192;
    if (modelLower.includes('gpt-3.5')) return 16_385;
    return 200_000; // Default for newer OpenAI models
  }

  // Anthropic models
  if (providerLower === 'anthropic' || modelLower.includes('claude')) {
    if (modelLower.includes('claude-sonnet-4') || modelLower.includes('claude-4')) {
      return 200_000;
    }
    if (modelLower.includes('claude-3-5') || modelLower.includes('claude-3')) {
      return 200_000;
    }
    return 200_000; // Default for Anthropic
  }

  // Google models
  if (providerLower === 'google' || modelLower.includes('gemini')) {
    if (modelLower.includes('gemini-2.5-pro') || modelLower.includes('gemini-2-5-pro')) {
      return 2_000_000;
    }
    if (modelLower.includes('gemini-2.5-flash') || modelLower.includes('gemini-2-5-flash')) {
      return 1_000_000;
    }
    if (modelLower.includes('gemini-2.0-pro') || modelLower.includes('gemini-2-pro')) {
      return 2_000_000;
    }
    if (modelLower.includes('gemini-2.0-flash') || modelLower.includes('gemini-2-flash')) {
      return 1_000_000;
    }
    if (modelLower.includes('gemini-1.5-pro')) return 2_000_000;
    if (modelLower.includes('gemini-1.5-flash')) return 1_000_000;
    if (modelLower.includes('gemini-pro')) return 32_000;
    return 1_000_000; // Default for Google
  }

  // xAI models
  if (providerLower === 'xai' || modelLower.includes('grok')) {
    if (modelLower.includes('grok-4-fast')) return 2_000_000;
    if (modelLower.includes('grok')) return 128_000;
    return 128_000;
  }

  // PageSpace (GLM models)
  if (providerLower === 'pagespace' || modelLower.includes('glm')) {
    if (modelLower.includes('glm-5')) return 200_000;
    if (modelLower.includes('glm-4.7')) return 200_000;
    if (modelLower.includes('glm-4.6')) return 200_000;
    if (modelLower.includes('glm-4.5')) return 128_000;
    return 200_000; // Updated default for GLM
  }

  // MiniMax models
  if (providerLower === 'minimax' || modelLower.includes('minimax')) {
    if (modelLower.includes('m2.5')) return 1_000_000;
    return 128_000; // Default for older MiniMax models
  }

  // OpenRouter - use model-specific limits where known, else 200k conservative default
  if (providerLower === 'openrouter') {
    // Claude models via OpenRouter
    if (modelLower.includes('claude')) return 200_000;
    // Gemini models via OpenRouter
    if (modelLower.includes('gemini-2.5')) return 1_000_000;
    if (modelLower.includes('gemini-2.0') || modelLower.includes('gemini-1.5')) return 1_000_000;
    // GPT models via OpenRouter
    if (modelLower.includes('gpt-5.2')) {
      return modelLower.includes('mini') || modelLower.includes('nano') ? 256_000 : 400_000;
    }
    if (modelLower.includes('gpt-5.1')) return 400_000;
    if (modelLower.includes('gpt-5')) {
      return modelLower.includes('mini') || modelLower.includes('nano') ? 128_000 : 272_000;
    }
    if (modelLower.includes('gpt-4o') || modelLower.includes('gpt-4-turbo')) return 128_000;
    // DeepSeek models - commonly 64k or 128k
    if (modelLower.includes('deepseek-r1') || modelLower.includes('deepseek-v3')) return 128_000;
    if (modelLower.includes('deepseek')) return 64_000;
    // Qwen models
    if (modelLower.includes('qwen-2.5') || modelLower.includes('qwq')) return 128_000;
    if (modelLower.includes('qwen')) return 32_000;
    // Llama models
    if (modelLower.includes('llama-3') || modelLower.includes('llama3')) return 128_000;
    if (modelLower.includes('llama')) return 32_000;
    // Mistral models
    if (modelLower.includes('mistral-large') || modelLower.includes('mistral-nemo')) return 128_000;
    if (modelLower.includes('mistral')) return 32_000;
    // OpenRouter platform hard cap is 400k for many endpoints - use 200k as safe default
    return 200_000;
  }

  // Unknown provider/model - conservative default
  return 200_000;
}

/**
 * Calculate total context size for an AI call
 * This represents the ACTUAL tokens sent to the AI, not cumulative billing
 */
export function calculateTotalContextSize(config: ContextConfig): ContextCalculation {
  const systemPromptTokens = estimateSystemPromptTokens(config.systemPrompt);
  const toolDefinitionTokens = estimateToolDefinitionTokens(config.tools);

  // Calculate conversation tokens from messages
  let conversationTokens = 0;
  const messageIds: string[] = [];

  for (const message of config.messages) {
    conversationTokens += estimateMessageTokens(message);
    if (message.id) {
      messageIds.push(message.id);
    }
  }

  const totalTokens = systemPromptTokens + toolDefinitionTokens + conversationTokens;
  const messageCount = config.messages.length;

  // Check if context would be truncated
  const contextWindow = getContextWindowSize(config.model, config.provider);
  const wasTruncated = totalTokens > contextWindow;

  return {
    totalTokens,
    systemPromptTokens,
    toolDefinitionTokens,
    conversationTokens,
    messageCount,
    messageIds,
    wasTruncated,
    truncationStrategy: wasTruncated ? 'oldest_first' : 'none',
  };
}

/**
 * Determine which messages to include in context given a token budget
 * Returns messages that fit within the context window
 *
 * Strategy: Keep most recent messages, truncate oldest first
 */
export function determineMessagesToInclude(
  messages: UIMessage[],
  maxTokens: number,
  systemPromptTokens: number = 0,
  toolTokens: number = 0
): {
  includedMessages: UIMessage[];
  totalTokens: number;
  wasTruncated: boolean;
} {
  const budget = maxTokens - systemPromptTokens - toolTokens;

  if (budget <= 0) {
    return {
      includedMessages: [],
      totalTokens: systemPromptTokens + toolTokens,
      wasTruncated: true,
    };
  }

  // Start from most recent and work backwards
  const included: UIMessage[] = [];
  let currentTokens = systemPromptTokens + toolTokens;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const messageTokens = estimateMessageTokens(message);

    if (currentTokens + messageTokens <= maxTokens) {
      included.unshift(message); // Add to front to maintain order
      currentTokens += messageTokens;
    } else {
      // Would exceed budget, stop here
      return {
        includedMessages: included,
        totalTokens: currentTokens,
        wasTruncated: true,
      };
    }
  }

  // All messages fit
  return {
    includedMessages: included,
    totalTokens: currentTokens,
    wasTruncated: false,
  };
}
