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
 *
 * Tool parts in the Vercel AI SDK use type `tool-{toolName}` (e.g. "tool-search")
 * with fields: toolCallId, toolName, input, output, state.
 */
export interface UIMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  parts?: Array<{
    type: string;
    text?: string;
    // Tool invocation fields (Vercel AI SDK DynamicToolUIPart)
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    state?: string;
    // Legacy fields for backwards compatibility
    args?: unknown;
    result?: unknown;
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

  // Count non-ASCII characters efficiently via charCode loop (avoids regex array allocation)
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) nonAsciiCount++;
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
      } else if (part.type.startsWith('tool-')) {
        // Vercel AI SDK tool invocation parts: type is "tool-{toolName}"
        // Fields: toolCallId, toolName, input, output, state
        tokens += 10; // Tool call ID overhead
        if (part.toolName) {
          tokens += estimateTokens(part.toolName);
        }
        // Input (tool arguments)
        const inputData = part.input ?? part.args;
        if (inputData) {
          tokens += estimateTokens(JSON.stringify(inputData));
        }
        // Output (tool result) — only present when state is 'output-available'
        const outputData = part.output ?? part.result;
        if (outputData) {
          const resultStr = typeof outputData === 'string'
            ? outputData
            : JSON.stringify(outputData);
          tokens += estimateTokens(resultStr);
        }
      }
    }
  }

  // Message overhead (timestamps, IDs, etc): ~10 tokens
  tokens += 10;

  return tokens;
}

/**
 * Get context window size for a model.
 *
 * Uses MODEL_CONTEXT_WINDOWS from ai-monitoring.ts as the canonical source of truth.
 * Falls back to heuristic matching for models not in the map.
 */
export function getContextWindowSize(model: string, provider?: string): number {
  // 1. Try exact match against the canonical map (imported at bottom of file to avoid circular deps)
  const canonical = getCanonicalContextWindow(model, provider);
  if (canonical !== undefined) return canonical;

  // 2. Heuristic fallbacks for models not in the canonical map
  const modelLower = model.toLowerCase();
  const providerLower = provider?.toLowerCase() || '';

  // OpenAI models
  if (providerLower === 'openai' || modelLower.includes('gpt')) {
    if (modelLower.includes('gpt-5.2')) {
      return (modelLower.includes('mini') || modelLower.includes('nano')) ? 256_000 : 400_000;
    }
    if (modelLower.includes('gpt-5.1')) return 400_000;
    if (modelLower.includes('gpt-5')) {
      return (modelLower.includes('mini') || modelLower.includes('nano')) ? 128_000 : 272_000;
    }
    if (modelLower.includes('gpt-4o') || modelLower.includes('gpt-4-turbo')) return 128_000;
    if (modelLower.includes('gpt-4')) return 8_192;
    if (modelLower.includes('gpt-3.5')) return 16_385;
    return 200_000;
  }

  // Anthropic models
  if (providerLower === 'anthropic' || modelLower.includes('claude')) {
    return 200_000;
  }

  // Google models
  if (providerLower === 'google' || modelLower.includes('gemini')) {
    if (modelLower.includes('gemini-2.5-pro') || modelLower.includes('gemini-2-5-pro')) return 2_000_000;
    if (modelLower.includes('gemini-2.5-flash') || modelLower.includes('gemini-2-5-flash')) return 1_000_000;
    if (modelLower.includes('gemini-2.0-pro') || modelLower.includes('gemini-2-pro')) return 2_000_000;
    if (modelLower.includes('gemini-2.0-flash') || modelLower.includes('gemini-2-flash')) return 1_000_000;
    if (modelLower.includes('gemini-1.5-pro')) return 2_000_000;
    if (modelLower.includes('gemini-1.5-flash')) return 1_000_000;
    if (modelLower.includes('gemini-pro')) return 32_000;
    return 1_000_000;
  }

  // xAI models
  if (providerLower === 'xai' || modelLower.includes('grok')) {
    if (modelLower.includes('grok-4-fast')) return 2_000_000;
    return 128_000;
  }

  // PageSpace (GLM models)
  if (providerLower === 'pagespace' || modelLower.includes('glm')) {
    if (modelLower.includes('glm-4.5')) return 128_000;
    return 200_000;
  }

  // MiniMax models
  if (providerLower === 'minimax' || modelLower.includes('minimax')) {
    return 128_000;
  }

  // Unknown provider/model - conservative default
  return 200_000;
}

/**
 * Attempt exact lookup in MODEL_CONTEXT_WINDOWS from ai-monitoring.
 * Tries the model directly, then with provider prefix (e.g. "openai/gpt-5").
 */
function getCanonicalContextWindow(model: string, provider?: string): number | undefined {
  const windows = MODEL_CONTEXT_WINDOWS as Record<string, number>;

  // Direct match (e.g. "gpt-5.2" or "anthropic/claude-opus-4.5")
  if (windows[model] !== undefined) {
    return windows[model];
  }

  // Try with provider prefix (e.g. provider="openrouter", model="gpt-5.2" → "openai/gpt-5.2")
  if (provider) {
    const providerPrefixes = getProviderPrefixes(provider, model);
    for (const prefix of providerPrefixes) {
      const key = `${prefix}/${model}`;
      if (windows[key] !== undefined) {
        return windows[key];
      }
    }
  }

  return undefined;
}

/**
 * Map provider/model to possible MODEL_CONTEXT_WINDOWS key prefixes
 */
function getProviderPrefixes(provider: string, model: string): string[] {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();

  if (p === 'openai') return ['openai'];
  if (p === 'anthropic') return ['anthropic'];
  if (p === 'google') return ['google'];
  if (p === 'xai') return ['x-ai'];
  if (p === 'minimax') return ['minimax'];
  if (p === 'pagespace') return ['z-ai'];

  // OpenRouter: model strings already include the provider prefix (e.g. "anthropic/claude-3.5-sonnet")
  // but some may be bare model names — try common prefixes based on model name
  if (p === 'openrouter') {
    if (m.includes('claude')) return ['anthropic'];
    if (m.includes('gpt') || m.includes('o3') || m.includes('o4') || m.includes('o1')) return ['openai'];
    if (m.includes('gemini')) return ['google'];
    if (m.includes('grok')) return ['x-ai'];
    if (m.includes('llama')) return ['meta-llama'];
    if (m.includes('mistral') || m.includes('codestral') || m.includes('devstral')) return ['mistralai'];
    if (m.includes('deepseek')) return ['deepseek'];
    if (m.includes('qwen') || m.includes('qwq')) return ['qwen'];
    if (m.includes('minimax')) return ['minimax'];
    if (m.includes('glm')) return ['z-ai'];
  }

  return [];
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
