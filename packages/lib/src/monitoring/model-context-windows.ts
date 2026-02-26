/**
 * Model Context Window Sizes (in tokens)
 *
 * Single source of truth for maximum context length for each model.
 * Shared between ai-context-calculator and ai-monitoring.
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
  'openai/gpt-5.2': 400000,
  'openai/gpt-5.2-codex': 400000,
  'openai/gpt-5.2-mini': 256000,
  'openai/gpt-5.2-nano': 256000,
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
  'z-ai/glm-4.7': 200000,
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
  'z-ai/glm-5': 202752,
  'minimax/minimax-m2.5': 204800,

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
  'gpt-5.2': 400000,
  'gpt-5.2-codex': 400000,
  'gpt-5.2-mini': 256000,
  'gpt-5.2-nano': 256000,
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
  'MiniMax-M2.5': 1000000,
  'MiniMax-M2.1': 128000,
  'MiniMax-M2': 128000,
  'MiniMax-M2-Stable': 128000,

  // PageSpace/GLM Models
  'glm-5': 200000,
  'glm-4.7': 200000,
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
  'default': 200000
} as const;
