/**
 * AI Usage Monitoring Module
 * Comprehensive tracking for AI provider usage, tokens, costs, and performance
 */

import { db } from '@pagespace/db/db';
import { sql, and, eq, gte, lte } from '@pagespace/db/operators';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { writeAiUsage } from '../logging/logger-database';
import { consumeCredits, releaseHold } from '../billing/credit-consume';
import { CACHE_READ_DISCOUNT_FACTOR_BPS } from '../billing/credit-pricing';
import { loggers } from '../logging/logger-config';
import { normalizeUsageSource, type AIUsageSource } from './usage-source';
import { isMeteringExempt } from '../ai/model-defaults';

/**
 * Providers NOT served through OpenRouter. Everything else is a cloud vendor
 * routed through OpenRouter and bills on real OpenRouter cost. This is an explicit
 * allowlist, not just the local/on-prem set: `openai_voice` (STT/TTS) hits OpenAI
 * directly and bills on list price, so a missing OpenRouter cost there is expected,
 * not a coverage gap.
 */
const NON_OPENROUTER_AI_PROVIDERS = new Set<string>([
  'ollama',
  'lmstudio',
  'azure_openai',
  'openai_voice',
]);

/**
 * AI Provider Pricing (per 1M tokens, USD)
 * Sources: OpenRouter /api/v1/models (per-token × 1M), Anthropic docs, Google AI docs, xAI docs
 * Updated: 2026-05
 */
export const AI_PRICING = {
  // OpenRouter - Anthropic (source: openrouter.ai/api/v1/models)
  'anthropic/claude-opus-4.8': { input: 5.00, output: 25.00 },
  'anthropic/claude-opus-4.8-fast': { input: 10.00, output: 50.00 },
  'anthropic/claude-opus-4.7': { input: 5.00, output: 25.00 },
  'anthropic/claude-opus-4.7-fast': { input: 30.00, output: 150.00 },
  'anthropic/claude-opus-4.6': { input: 5.00, output: 25.00 },
  'anthropic/claude-opus-4.6-fast': { input: 30.00, output: 150.00 },
  'anthropic/claude-sonnet-4.6': { input: 3.00, output: 15.00 },
  'anthropic/claude-opus-4.5': { input: 5.00, output: 25.00 },
  'anthropic/claude-sonnet-4.5': { input: 3.00, output: 15.00 },
  'anthropic/claude-haiku-4.5': { input: 1.00, output: 5.00 },
  'anthropic/claude-opus-4.1': { input: 15.00, output: 75.00 },
  'anthropic/claude-opus-4': { input: 15.00, output: 75.00 },
  'anthropic/claude-sonnet-4': { input: 3.00, output: 15.00 },
  'anthropic/claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'anthropic/claude-3.5-haiku': { input: 1.00, output: 5.00 },
  'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },

  // OpenRouter - OpenAI (source: openrouter.ai/api/v1/models)
  'openai/gpt-5.5-pro': { input: 30.00, output: 180.00 },
  'openai/gpt-5.2-pro': { input: 21.00, output: 168.00 },
  'openai/gpt-5.2-chat': { input: 1.75, output: 14.00 },
  'openai/gpt-5.1-chat': { input: 1.25, output: 10.00 },
  'openai/gpt-5.1-codex-max': { input: 1.25, output: 10.00 },
  'openai/gpt-5-pro': { input: 15.00, output: 120.00 },
  'openai/gpt-5-codex': { input: 1.25, output: 10.00 },
  'openai/o3': { input: 2.00, output: 8.00 },
  'openai/o3-pro': { input: 20.00, output: 80.00 },
  'openai/o4-mini': { input: 1.10, output: 4.40 },
  'openai/gpt-4.1': { input: 2.00, output: 8.00 },
  'openai/gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'openai/gpt-5.5': { input: 5.00, output: 30.00 },
  'openai/gpt-5.4-pro': { input: 30.00, output: 180.00 },
  'openai/gpt-5.4': { input: 2.50, output: 15.00 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'openai/gpt-5.4-nano': { input: 0.20, output: 1.25 },
  'openai/gpt-5.3-chat': { input: 1.75, output: 14.00 },
  'openai/gpt-5.3-chat-latest': { input: 1.75, output: 14.00 },
  'openai/gpt-5.3-codex': { input: 1.75, output: 14.00 },
  'openai/gpt-5.2': { input: 1.75, output: 14.00 },
  'openai/gpt-5.2-codex': { input: 1.75, output: 14.00 },
  'openai/gpt-5.2-mini': { input: 0.35, output: 2.80 },
  'openai/gpt-5.2-nano': { input: 0.07, output: 0.56 },
  'openai/gpt-5.1': { input: 10.00, output: 40.00 },
  'openai/gpt-5.1-codex': { input: 10.00, output: 40.00 },
  'openai/gpt-5.1-codex-mini': { input: 5.00, output: 20.00 },
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'openai/o3-deep-research': { input: 10.00, output: 40.00 },
  'openai/o4-mini-deep-research': { input: 2.00, output: 8.00 },
  'openai/gpt-5': { input: 1.25, output: 10.00 },
  'openai/gpt-5-mini': { input: 0.25, output: 2.00 },
  'openai/gpt-5-nano': { input: 0.05, output: 0.40 },
  'openai/gpt-oss-120b': { input: 0.00, output: 0.00 },
  'openai/gpt-oss-20b': { input: 0.00, output: 0.00 },

  // OpenRouter - Google (source: openrouter.ai/api/v1/models)
  'google/gemini-3.5-flash': { input: 1.50, output: 9.00 },
  'google/gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
  'google/gemini-3.1-pro-preview-customtools': { input: 2.00, output: 12.00 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
  'google/gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'google/gemini-3.1-flash-image-preview': { input: 0.50, output: 3.00 },
  'google/gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'google/gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'google/gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'google/gemini-2.5-flash-lite-preview-06-17': { input: 0.10, output: 0.40 },
  'google/gemini-2.0-pro': { input: 1.25, output: 5.00 },
  'google/gemma-4-31b-it': { input: 0.12, output: 0.37 },
  'google/gemma-4-26b-a4b-it': { input: 0.06, output: 0.33 },

  // OpenRouter - Meta (source: openrouter.ai/api/v1/models)
  'meta-llama/llama-4-maverick': { input: 0.10, output: 0.10 },
  'meta-llama/llama-4-scout': { input: 0.10, output: 0.10 },
  'meta-llama/llama-3.3-70b-instruct': { input: 0.10, output: 0.10 },
  'meta-llama/llama-3.1-405b-instruct': { input: 3.00, output: 3.00 },

  // OpenRouter - Mistral (source: openrouter.ai/api/v1/models)
  'mistralai/mistral-large-2512': { input: 0.50, output: 1.50 },
  'mistralai/mistral-medium-3-5': { input: 1.50, output: 7.50 },
  'mistralai/mistral-medium-3': { input: 0.40, output: 2.00 },
  'mistralai/devstral-2512': { input: 0.40, output: 2.00 },
  'mistralai/mistral-small-2603': { input: 0.15, output: 0.60 },
  'mistralai/mistral-medium-3.1': { input: 2.70, output: 8.10 },
  'mistralai/mistral-small-3.2-24b-instruct': { input: 0.20, output: 0.60 },
  'mistralai/codestral-2508': { input: 0.30, output: 0.90 },
  'mistralai/devstral-medium': { input: 0.40, output: 2.00 },
  'mistralai/devstral-small': { input: 0.10, output: 0.30 },

  // Z.ai GLM direct — GLM Coder Plan supported models only (source: z.ai/guides/overview/pricing)
  'glm-5.1':     { input: 1.40, output: 4.40 },
  'glm-5-turbo': { input: 1.20, output: 4.00 },
  'glm-4.7':     { input: 0.39, output: 1.90 },
  'glm-4.5-air': { input: 0.35, output: 1.55 },
  // Legacy fallback: historical ai_usage rows recorded under 'glm-5' before the
  // OpenRouter migration; must stay priced so old rows don't zero-cost.
  'glm-5':       { input: 1.00, output: 3.20 },

  // OpenRouter - Chinese/Asian (source: openrouter.ai/api/v1/models)
  'z-ai/glm-5.1': { input: 0.98, output: 3.08 },
  'z-ai/glm-5-turbo': { input: 1.20, output: 4.00 },
  'z-ai/glm-5': { input: 0.80, output: 2.56 },
  'z-ai/glm-4.7-flash': { input: 0.06, output: 0.40 },
  'z-ai/glm-4.7': { input: 0.39, output: 1.90 },
  'z-ai/glm-4.6': { input: 0.43, output: 1.74 },
  'z-ai/glm-4.5v': { input: 0.48, output: 1.44 },
  'z-ai/glm-4.5': { input: 0.48, output: 1.44 },
  'z-ai/glm-4.5-air': { input: 0.35, output: 1.55 },
  'z-ai/glm-4-32b': { input: 0.35, output: 1.55 },
  'qwen/qwen3.7-max': { input: 1.25, output: 3.75 },
  'qwen/qwen3.6-max-preview': { input: 1.04, output: 6.24 },
  'qwen/qwen3.6-plus': { input: 0.325, output: 1.95 },
  'qwen/qwen3.6-flash': { input: 0.1875, output: 1.125 },
  'qwen/qwen3.6-35b-a3b': { input: 0.15, output: 1.00 },
  'qwen/qwen3.6-27b': { input: 0.32, output: 3.20 },
  'qwen/qwen3.5-plus-20260420': { input: 0.30, output: 1.80 },
  'qwen/qwen3.5-flash-02-23': { input: 0.065, output: 0.26 },
  'qwen/qwen3.5-397b-a17b': { input: 0.80, output: 3.20 },
  'qwen/qwen3.5-122b-a10b': { input: 0.26, output: 2.08 },
  'qwen/qwen3.5-35b-a3b': { input: 0.139, output: 1.00 },
  'qwen/qwen3.5-27b': { input: 0.195, output: 1.56 },
  'qwen/qwen3-max-thinking': { input: 1.20, output: 6.00 },
  'qwen/qwen3-max': { input: 1.20, output: 6.00 },
  'qwen/qwen3-235b-a22b-thinking-2507': { input: 0.50, output: 2.00 },
  'qwen/qwen3-235b-a22b-2507': { input: 0.50, output: 2.00 },
  'qwen/qwen3-coder': { input: 0.50, output: 2.00 },
  'moonshotai/kimi-k2.6': { input: 0.684, output: 3.42 },
  'moonshotai/kimi-k2-thinking': { input: 0.60, output: 2.50 },
  'moonshotai/kimi-k2': { input: 0.48, output: 2.00 },
  'minimax/minimax-m3': { input: 0.30, output: 1.20 },
  'minimax/minimax-m2.7': { input: 0.279, output: 1.20 },
  'minimax/minimax-m2.5': { input: 0.30, output: 1.20 },
  'minimax/minimax-m2.1': { input: 0.29, output: 0.95 },
  'minimax/minimax-m1': { input: 0.44, output: 1.76 },
  'bytedance-seed/seed-2.0-lite': { input: 0.25, output: 2.00 },
  'bytedance-seed/seed-2.0-mini': { input: 0.10, output: 0.40 },

  // OpenRouter - DeepSeek (source: openrouter.ai/api/v1/models)
  'deepseek/deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek/deepseek-v4-flash': { input: 0.112, output: 0.224 },
  'deepseek/deepseek-v3.2': { input: 0.30, output: 1.20 },
  'deepseek/deepseek-v3.1-terminus': { input: 0.21, output: 0.32 },
  'deepseek/deepseek-r1-0528': { input: 0.50, output: 2.00 },

  // OpenRouter - AI21
  'ai21/jamba-mini-1.7': { input: 0.50, output: 0.70 },
  'ai21/jamba-large-1.7': { input: 0.50, output: 0.70 },

  // OpenRouter - xAI (source: openrouter.ai/api/v1/models)
  'x-ai/grok-4.3': { input: 1.25, output: 2.50 },
  'x-ai/grok-4.20': { input: 1.25, output: 2.50 },
  'x-ai/grok-4.20-multi-agent': { input: 2.00, output: 6.00 },
  'x-ai/grok-build-0.1': { input: 1.00, output: 2.00 },
  // Delisted from OpenRouter + removed from the selectable catalog, but pricing is kept
  // as a superset so any lingering saved selection still meters correctly (not $0).
  'x-ai/grok-4-fast': { input: 0.20, output: 0.50 },
  'x-ai/grok-4': { input: 3.00, output: 15.00 },

  // OpenRouter - Other (source: openrouter.ai/api/v1/models)
  'inception/mercury-2': { input: 0.25, output: 0.75 },
  'inception/mercury': { input: 0.50, output: 1.50 },
  'writer/palmyra-x5': { input: 0.60, output: 6.00 },

  // Google AI Direct (source: ai.google.dev/gemini-api/docs/pricing, 2026-05)
  'gemini-3.5-flash': { input: 1.50, output: 9.00 },
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-3.1-pro-preview-customtools': { input: 2.00, output: 12.00 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
  'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash-lite-preview-06-17': { input: 0.10, output: 0.40 },
  'gemini-2.0-pro-exp': { input: 0.00, output: 0.00 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-exp': { input: 0.00, output: 0.00 },
  'gemini-2.0-flash-lite': { input: 0.04, output: 0.16 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },

  // OpenAI Direct Models (platform.openai.com/docs/pricing, 2026)
  'gpt-5.4-pro': { input: 30.00, output: 180.00 },
  'gpt-5.4': { input: 2.50, output: 15.00 },
  'gpt-5.3-chat-latest': { input: 10.00, output: 40.00 },
  'gpt-5.3-codex': { input: 10.00, output: 40.00 },
  'gpt-5.2': { input: 1.75, output: 14.00 },
  'gpt-5.2-codex': { input: 1.75, output: 14.00 },
  'gpt-5.2-mini': { input: 0.35, output: 2.80 },
  'gpt-5.2-nano': { input: 0.07, output: 0.56 },
  'gpt-5.1': { input: 10.00, output: 40.00 },
  'gpt-5.1-codex': { input: 10.00, output: 40.00 },
  'gpt-5': { input: 1.25, output: 10.00 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-5-nano': { input: 0.05, output: 0.40 },
  'gpt-4.1-2025-04-14': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini-2025-04-14': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano-2025-04-14': { input: 0.10, output: 0.40 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o-audio-preview': { input: 2.50, output: 10.00 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'o4-mini-2025-04-16': { input: 1.10, output: 4.40 },
  'o3': { input: 2.00, output: 8.00 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 3.00, output: 12.00 },
  'o1-preview': { input: 15.00, output: 60.00 },

  // Anthropic Direct (source: platform.claude.com/docs/about-claude/models, 2026-05)
  'claude-opus-4-7': { input: 5.00, output: 25.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-opus-4-6': { input: 5.00, output: 25.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-opus-4-5-20251101': { input: 5.00, output: 25.00 },
  'claude-opus-4-5': { input: 5.00, output: 25.00 },
  'claude-opus-4-1-20250805': { input: 15.00, output: 75.00 },
  'claude-opus-4-1': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-1-20250805': { input: 3.00, output: 15.00 },
  'claude-3-7-sonnet-20250219': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022': { input: 1.00, output: 5.00 },
  'claude-3-5-haiku-latest': { input: 1.00, output: 5.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-opus-latest': { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229': { input: 3.00, output: 15.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

  // xAI Direct (source: docs.x.ai/docs/models, 2026-05)
  'grok-4.3': { input: 1.25, output: 2.50 },
  'grok-4': { input: 3.00, output: 15.00 },
  'grok-4-fast-reasoning': { input: 1.25, output: 2.50 },
  'grok-4-fast-non-reasoning': { input: 1.25, output: 2.50 },
  'grok-code-fast-1': { input: 0.20, output: 0.50 },
  'grok-3': { input: 3.00, output: 15.00 },
  'grok-3-latest': { input: 3.00, output: 15.00 },
  'grok-3-fast': { input: 0.20, output: 0.50 },
  'grok-3-fast-latest': { input: 0.20, output: 0.50 },
  'grok-3-mini': { input: 1.00, output: 5.00 },
  'grok-3-mini-latest': { input: 1.00, output: 5.00 },
  'grok-3-mini-fast': { input: 0.20, output: 0.50 },
  'grok-3-mini-fast-latest': { input: 0.20, output: 0.50 },
  'grok-2': { input: 2.00, output: 10.00 },
  'grok-2-latest': { input: 2.00, output: 10.00 },
  'grok-2-1212': { input: 2.00, output: 10.00 },
  'grok-2-vision': { input: 2.00, output: 10.00 },
  'grok-2-vision-latest': { input: 2.00, output: 10.00 },
  'grok-2-vision-1212': { input: 2.00, output: 10.00 },
  'grok-beta': { input: 2.00, output: 10.00 },
  'grok-vision-beta': { input: 2.00, output: 10.00 },

  // MiniMax Direct Models (openrouter.ai, Dec 2025)
  'MiniMax-M2.1': { input: 0.30, output: 1.20 },
  'MiniMax-M2': { input: 0.30, output: 1.20 },
  'MiniMax-M2-Stable': { input: 0.30, output: 1.20 },

  // MiniMax Direct Models (Native)
  'MiniMax-M2.5': { input: 0.30, output: 1.20 },

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
 * Updated May 2026
 */
export const MODEL_CONTEXT_WINDOWS = {
  // OpenRouter Models - Anthropic
  'anthropic/claude-opus-4.8': 1000000,
  'anthropic/claude-opus-4.8-fast': 1000000,
  'anthropic/claude-opus-4.7': 1000000,
  'anthropic/claude-opus-4.7-fast': 1000000,
  'anthropic/claude-opus-4.6': 1000000,
  'anthropic/claude-opus-4.6-fast': 1000000,
  'anthropic/claude-sonnet-4.6': 1000000,
  'anthropic/claude-opus-4.5': 200000,
  'anthropic/claude-sonnet-4.5': 200000,
  'anthropic/claude-haiku-4.5': 200000,
  'anthropic/claude-opus-4.1': 200000,
  'anthropic/claude-opus-4': 200000,
  'anthropic/claude-sonnet-4': 1000000,
  'anthropic/claude-3.5-sonnet': 200000,
  'anthropic/claude-3.5-haiku': 200000,
  'anthropic/claude-3-haiku': 200000,

  // OpenRouter Models - OpenAI
  'openai/gpt-5.5-pro': 200000,
  'openai/gpt-5.2-pro': 400000,
  'openai/gpt-5.2-chat': 128000,
  'openai/gpt-5.1-chat': 128000,
  'openai/gpt-5.1-codex-max': 400000,
  'openai/gpt-5-pro': 400000,
  'openai/gpt-5-codex': 400000,
  'openai/o3': 200000,
  'openai/o3-pro': 200000,
  'openai/o4-mini': 200000,
  'openai/gpt-4.1': 1047576,
  'openai/gpt-4.1-mini': 1047576,
  'openai/gpt-5.5': 272000,
  'openai/gpt-5.4-pro': 200000,
  'openai/gpt-5.4': 272000,
  'openai/gpt-5.4-mini': 128000,
  'openai/gpt-5.4-nano': 128000,
  'openai/gpt-5.3-chat': 272000,
  'openai/gpt-5.3-chat-latest': 272000,
  'openai/gpt-5.3-codex': 272000,
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

  // OpenRouter Models - Google
  'google/gemini-3.5-flash': 1048576,
  'google/gemini-3.1-pro-preview': 1048576,
  'google/gemini-3.1-pro-preview-customtools': 1048576,
  'google/gemini-3.1-flash-lite': 1048576,
  'google/gemini-3.1-flash-lite-preview': 1048576,
  'google/gemini-3.1-flash-image-preview': 131072,
  'google/gemini-3-flash-preview': 1048576,
  'google/gemini-2.5-pro': 2000000,
  'google/gemini-2.5-flash': 1000000,
  'google/gemini-2.5-flash-lite': 1000000,
  'google/gemini-2.5-flash-lite-preview-06-17': 1000000,
  'google/gemini-2.0-pro': 2000000,
  'google/gemini-2.0-flash': 1000000,
  'google/gemma-4-31b-it': 262144,
  'google/gemma-4-26b-a4b-it': 262144,

  // OpenRouter Models - Meta
  'meta-llama/llama-4-maverick': 1048576,
  'meta-llama/llama-4-scout': 10000000,
  'meta-llama/llama-3.3-70b-instruct': 131072,
  'meta-llama/llama-3.1-405b-instruct': 128000,

  // OpenRouter Models - Mistral
  'mistralai/mistral-large-2512': 262144,
  'mistralai/mistral-medium-3': 131072,
  'mistralai/devstral-2512': 262144,
  'mistralai/mistral-medium-3-5': 262144,
  'mistralai/mistral-small-2603': 262144,
  'mistralai/mistral-medium-3.1': 128000,
  'mistralai/mistral-small-3.2-24b-instruct': 32000,
  'mistralai/codestral-2508': 32000,
  'mistralai/devstral-medium': 128000,
  'mistralai/devstral-small': 128000,

  // Z.ai GLM direct — GLM Coder Plan supported models only
  'glm-5.1':     202752,
  'glm-5-turbo': 202752,
  'glm-4.7':     200000,
  'glm-4.5-air': 128000,
  'glm-5':       202752, // legacy fallback for historical billing rows

  // OpenRouter Models - Chinese/Asian
  'z-ai/glm-5.1': 202752,
  'z-ai/glm-5-turbo': 202752,
  'z-ai/glm-5': 202752,
  'z-ai/glm-4.7-flash': 202752,
  'z-ai/glm-4.7': 200000,
  'z-ai/glm-4.6': 202752,
  'z-ai/glm-4.5v': 128000,
  'z-ai/glm-4.5': 128000,
  'z-ai/glm-4.5-air': 128000,
  'z-ai/glm-4-32b': 128000,
  'qwen/qwen3.6-max-preview': 131072,
  'qwen/qwen3.6-plus': 131072,
  'qwen/qwen3.6-flash': 131072,
  'qwen/qwen3.6-35b-a3b': 131072,
  'qwen/qwen3.6-27b': 131072,
  'qwen/qwen3.5-flash-02-23': 131072,
  'qwen/qwen3.5-397b-a17b': 131072,
  'qwen/qwen3.5-plus-20260420': 131072,
  'qwen/qwen3.5-122b-a10b': 131072,
  'qwen/qwen3.5-35b-a3b': 131072,
  'qwen/qwen3.5-27b': 131072,
  'qwen/qwen3-max-thinking': 128000,
  'qwen/qwen3-max': 128000,
  'qwen/qwen3-235b-a22b-thinking-2507': 128000,
  'qwen/qwen3-235b-a22b-2507': 128000,
  'qwen/qwen3-coder': 128000,
  'qwen/qwen3.7-max': 1000000,
  'moonshotai/kimi-k2.6': 262144,
  'moonshotai/kimi-k2-thinking': 262144,
  'moonshotai/kimi-k2': 128000,
  'minimax/minimax-m3': 1048576,
  'minimax/minimax-m2.7': 204800,
  'minimax/minimax-m2.5': 204800,
  'minimax/minimax-m2.1': 204800,
  'minimax/minimax-m1': 128000,
  'bytedance-seed/seed-2.0-lite': 262144,
  'bytedance-seed/seed-2.0-mini': 262144,

  // OpenRouter Models - DeepSeek
  'deepseek/deepseek-v4-pro': 1048576,
  'deepseek/deepseek-v4-flash': 1048576,
  'deepseek/deepseek-v3.2': 131072,
  'deepseek/deepseek-v3.1-terminus': 128000,
  'deepseek/deepseek-r1-0528': 163840,

  // OpenRouter Models - AI21
  'ai21/jamba-mini-1.7': 256000,
  'ai21/jamba-large-1.7': 256000,

  // OpenRouter Models - xAI (source: openrouter.ai/api/v1/models)
  'x-ai/grok-4.3': 1000000,
  'x-ai/grok-4.20': 2000000,
  'x-ai/grok-4.20-multi-agent': 2000000,
  'x-ai/grok-build-0.1': 256000,
  'x-ai/grok-4-fast': 2000000,
  'x-ai/grok-4': 128000,

  // OpenRouter Models - Other
  'inception/mercury-2': 128000,
  'inception/mercury': 128000,
  'writer/palmyra-x5': 1040000,

  // Google AI Direct (source: ai.google.dev/gemini-api/docs/models, 2026-05)
  'gemini-3.5-flash': 1048576,
  'gemini-3.1-pro-preview': 1048576,
  'gemini-3.1-pro-preview-customtools': 1048576,
  'gemini-3.1-flash-lite': 1048576,
  'gemini-3.1-flash-lite-preview': 1048576,
  'gemini-3-flash-preview': 1048576,
  'gemini-2.5-pro': 2097152,
  'gemini-2.5-flash': 1048576,
  'gemini-2.5-flash-lite': 1048576,
  'gemini-2.5-flash-lite-preview-06-17': 1048576,
  'gemini-2.0-pro-exp': 2097152,
  'gemini-2.0-flash': 1048576,
  'gemini-2.0-flash-exp': 1048576,
  'gemini-2.0-flash-lite': 1048576,
  'gemini-1.5-flash': 1048576,
  'gemini-1.5-flash-8b': 1048576,
  'gemini-1.5-pro': 2097152,

  // OpenAI Direct Models
  'gpt-5.4-pro': 200000,
  'gpt-5.4': 272000,
  'gpt-5.3-chat-latest': 272000,
  'gpt-5.3-codex': 272000,
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

  // Anthropic Direct (source: platform.claude.com/docs/about-claude/models, 2026-05)
  'claude-opus-4-7': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-haiku-4-5': 200000,
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4-5-20250929': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-opus-4-5-20251101': 200000,
  'claude-opus-4-5': 200000,
  'claude-opus-4-1-20250805': 200000,
  'claude-opus-4-1': 200000,
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
  'grok-4.3': 1000000,
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
 * Calculate cost based on tokens and model — the ESTIMATE fallback used only when
 * OpenRouter's authoritative returned cost is absent (direct providers, or an
 * OpenRouter call whose cost metadata went missing). Real provider cost, when present,
 * is billed verbatim and never routes through here.
 *
 * `opts.cachedInputTokens` is the cached SUBSET of `inputTokens` (prompt caching):
 * providers bill cache reads at a fraction of the fresh-input rate, so the cached
 * portion is discounted by CACHE_READ_DISCOUNT_FACTOR_BPS. `opts.reasoningTokens`
 * (emitted by reasoning models in addition to visible output) are billed at the OUTPUT
 * rate — omitting them undercharged reasoning-heavy calls. Both default to 0, so
 * existing 3-arg callers are unaffected.
 */
export function calculateCost(
  model: string,
  inputTokens: number = 0,
  outputTokens: number = 0,
  opts: { cachedInputTokens?: number; reasoningTokens?: number } = {}
): number {
  const pricing = AI_PRICING[model as keyof typeof AI_PRICING];
  if (!pricing) {
    return 0;
  }

  // Cached tokens are a subset of input; clamp to [0, inputTokens] so bad metadata
  // can't drive the cost negative or above the full-input cost. Fresh input bills at
  // the full rate, the cached remainder at the discounted rate.
  const cached = Math.min(Math.max(opts.cachedInputTokens ?? 0, 0), Math.max(inputTokens, 0));
  const freshInput = Math.max(inputTokens, 0) - cached;
  const cacheFactor = CACHE_READ_DISCOUNT_FACTOR_BPS / 10_000;
  const inputCost =
    (freshInput / 1_000_000) * pricing.input +
    (cached / 1_000_000) * pricing.input * cacheFactor;

  // Reasoning tokens bill at the output rate, added to the visible output count.
  const reasoning = Math.max(opts.reasoningTokens ?? 0, 0);
  const outputCost = ((Math.max(outputTokens, 0) + reasoning) / 1_000_000) * pricing.output;

  return Number((inputCost + outputCost).toFixed(6));
}

/**
 * A minimal view of an AI-SDK step carrying provider metadata. `streamText`'s
 * onFinish event and `generateText` results both expose a `steps` array whose
 * entries match this shape; we only read `providerMetadata`.
 */
export interface ProviderMetadataCarrier {
  providerMetadata?: Record<string, unknown> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract OpenRouter's authoritative request cost (USD) from AI-SDK steps.
 *
 * OpenRouter returns the real per-request cost under
 * `providerMetadata.openrouter.usage.cost` once usage accounting is enabled
 * (see provider-factory `openrouter.chat(model, { usage: { include: true } })`).
 * For standard (managed-key) routing `usage.cost` is the complete charge (OpenRouter
 * margin + upstream inference). `usage.costDetails.upstreamInferenceCost` is a
 * sub-breakdown of that total for auditing — NOT an additive fee. Adding both would
 * double-count the upstream portion and overcharge users by ~2.5×.
 *
 * Note: BYOK (bring-your-own-key) routing — where `cost` is only OpenRouter's small
 * routing fee and `upstreamInferenceCost` is a separate provider charge — is retired
 * in this product (provider-factory always uses the platform's managed API key).
 * If BYOK is ever re-introduced, this function must be revisited.
 *
 * Tool loops (`stepCountIs(n)`) issue one OpenRouter request PER step, each with
 * its own cost, so we sum across every step — mirroring how routes sum tokens via
 * `totalUsage`. The AI-SDK types `providerMetadata` as opaque JSON, so every field
 * is read defensively.
 *
 * Returns `undefined` when no step carries OpenRouter cost metadata, signalling the
 * caller to fall back to the static `calculateCost()` estimate.
 */
export function extractOpenRouterCostDollars(
  steps: ReadonlyArray<ProviderMetadataCarrier> | undefined,
): number | undefined {
  if (!steps || steps.length === 0) return undefined;

  let total = 0;
  let found = false;

  for (const step of steps) {
    const openrouter = asRecord(asRecord(step?.providerMetadata)?.openrouter);
    const usage = asRecord(openrouter?.usage);
    if (!usage) continue;

    const cost = asFiniteNumber(usage.cost);

    if (cost === undefined) continue;

    found = true;
    total += cost;
  }

  return found ? total : undefined;
}

/**
 * Extract OpenRouter's generation id(s) from AI-SDK steps. OpenRouter returns a stable
 * generation id (e.g. "gen-…") under `providerMetadata.openrouter.id`; that id is the
 * key for the authoritative `/api/v1/generation?id=` cost endpoint the async reconcile
 * cron queries. A tool loop issues one OpenRouter request per step, so collect a
 * de-duped, order-preserving list across every step. Returns `[]` when no step carries
 * an id (direct providers, or metadata went missing). Read defensively — providerMetadata
 * is opaque JSON.
 */
export function extractOpenRouterGenerationIds(
  steps: ReadonlyArray<ProviderMetadataCarrier> | undefined,
): string[] {
  if (!steps || steps.length === 0) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const openrouter = asRecord(asRecord(step?.providerMetadata)?.openrouter);
    const id = openrouter?.id;
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
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
  // Cached-input subset and reasoning tokens from the AI-SDK usage object. Used ONLY by
  // the estimate fallback (calculateCost) to discount cache reads and bill reasoning as
  // output; ignored when a real providerCostDollars is present. Also stamped into
  // metadata for observability.
  cachedInputTokens?: number;
  reasoningTokens?: number;
  duration?: number;
  streamingDuration?: number;
  conversationId?: string;
  messageId?: string;
  pageId?: string;
  driveId?: string;
  success?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;

  // Which product surface spent the credits (chat, pulse, memory, voice, …). Stamped
  // at each call site and grouped by the user-facing usage breakdown. Unknown/missing
  // folds to 'other' via normalizeUsageSource.
  source?: AIUsageSource;

  // Authoritative provider cost (USD) for this call, captured from OpenRouter's
  // returned usage accounting (providerMetadata.openrouter.usage.cost, summed
  // across tool-loop steps). When finite & >= 0 this is billed instead of the
  // static AI_PRICING estimate. Absent for direct providers (google/anthropic/
  // openai/ollama) that don't return a cost — those fall back to calculateCost().
  providerCostDollars?: number;

  // OpenRouter generation id(s) for this call (one per tool-loop step), captured from
  // providerMetadata.openrouter.id. Stamped into metadata.generationIds and used by the
  // async cost-reconcile cron to fetch the authoritative /generation cost. Absent for
  // direct providers and when metadata went missing.
  openrouterGenerationIds?: string[];

  // The reservation placed by the credit gate (canConsumeAI) at the top of the
  // request, released when this call's real cost is billed. Threaded from the
  // route → here → consumeCredits. Absent for un-gated calls (e.g. cron paths).
  holdId?: string;

  // Override the cost provenance stamped into metadata.costSource (which the admin
  // panel reads to classify coverage). Defaults to 'openrouter' when a finite
  // providerCostDollars is given, else 'estimate'. Voice routes pass 'list_price'
  // because their cost is deterministic (exact quantity × published OpenAI rate),
  // neither a live provider-returned figure nor a token-guess fallback. Typed as the
  // closed set the rollup recognizes so a typo can't silently fall through to the
  // provider-name heuristic.
  costSource?: 'openrouter' | 'estimate' | 'list_price';

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
    // Calculate total if not provided
    if (!totalTokens && (inputTokens || outputTokens)) {
      totalTokens = (inputTokens || 0) + (outputTokens || 0);
    }
    
    // Bill on OpenRouter's authoritative returned cost when present; otherwise
    // fall back to the static AI_PRICING estimate (direct providers, or an
    // OpenRouter call whose metadata went missing). Never drop the charge.
    const fallbackCost = calculateCost(data.model, inputTokens, outputTokens, {
      cachedInputTokens: data.cachedInputTokens,
      reasoningTokens: data.reasoningTokens,
    });
    const hasRealCost =
      typeof data.providerCostDollars === 'number' &&
      Number.isFinite(data.providerCostDollars) &&
      data.providerCostDollars >= 0;
    const cost = hasRealCost ? (data.providerCostDollars as number) : fallbackCost;
    const costSource = hasRealCost ? 'openrouter' : 'estimate';
    // Every cloud vendor is served through OpenRouter; only the providers on the
    // explicit non-OpenRouter allowlist (local runtimes + direct voice) are not.
    const isOpenRouter = !NON_OPENROUTER_AI_PROVIDERS.has(data.provider);
    if (!hasRealCost && isOpenRouter) {
      if (fallbackCost === 0 && ((inputTokens ?? 0) + (outputTokens ?? 0)) > 0) {
        // Model absent from AI_PRICING for a cloud provider — real coverage gap.
        // Local providers (ollama, lmstudio) run arbitrary model ids not in the
        // static list, so $0 there is expected; isOpenRouter already excludes them.
        loggers.ai.warn('unknown model pricing, billing $0', {
          model: data.model,
          provider: data.provider,
          inputTokens,
          outputTokens,
        });
      } else {
        // Known model but OpenRouter didn't return cost metadata — fall back to
        // the static estimate so billing is durable.
        loggers.ai.debug('openrouter cost metadata missing; falling back to estimate', {
          model: data.model,
          provider: data.provider,
        });
      }
    }
    const success = data.success !== false;

    // Mark the row for async cost reconcile only when it was billed on a real returned
    // cost AND carries OpenRouter generation id(s) to look up. The id presence — not the
    // UI provider string, which post-OpenRouter-routing is often an alias like 'pagespace'
    // — is the authoritative signal that this row went through OpenRouter and has a
    // /generation cost to reconcile against (extractOpenRouterGenerationIds only ever
    // reads providerMetadata.openrouter.id). Direct providers, missing metadata, and
    // id-less rows stay NULL so the reconcile cron never picks them up.
    const generationIds = data.openrouterGenerationIds ?? [];
    const reconcileStatus =
      hasRealCost && generationIds.length > 0 ? ('pending' as const) : undefined;

    // Persist the usage log, then debit the user's prepaid credit balance
    // (cost × markup) whenever real provider tokens were consumed — even if the
    // generation later errored/aborted mid-stream. Tokens burned before the error
    // are real spend the provider charges us for, so we must bill them. Only a
    // pre-generation failure (0 tokens, unsuccessful) is left unbilled.
    //
    // AWAITED, not fire-and-forget: callers reach this from a stream onFinish or
    // a post-response handler and `await` trackAIUsage. A detached promise can be
    // dropped when a serverless function freezes/returns, losing BOTH the usage
    // log AND the charge — and with no aiUsageLogs row the reconcile cron's orphan
    // sweep has nothing to recover from. Awaiting makes the write durable before
    // the request returns. Still never throws into the AI request (see catch).
    try {
      const aiUsageLogId = await writeAiUsage({
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
        success,
        error: data.error,
        source: normalizeUsageSource(data.source),

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
          // Provenance of the billed `cost`: 'openrouter' = real returned cost,
          // 'estimate' = static AI_PRICING fallback. Lets the admin panel be
          // honest about real vs estimated coverage. Callers that compute their own
          // authoritative cost (voice: 'list_price' = exact quantity × published
          // rate) override this, since they pass a finite providerCostDollars that
          // would otherwise be mislabeled 'openrouter'.
          costSource: data.costSource ?? costSource,
          // OpenRouter generation id(s) for the async cost-reconcile cron. Only stamped
          // when present (OpenRouter calls); the cron reads these to fetch authoritative
          // /generation costs and correct billing drift.
          ...(generationIds.length > 0 ? { generationIds } : {}),
        },
        reconcileStatus,
      });
      // Bill when real tokens were consumed, regardless of success. A token-less
      // failure (pre-generation error) carries 0 tokens and is skipped; a
      // zero-charge call still reaches consumeCredits, which settles it as
      // 'skipped' without churning a $0 ledger transaction.
      if (isMeteringExempt(data.provider)) {
        // Admin Z.ai Coder Plan (flat-rate external subscription): the usage row
        // above is kept for observability, but the call never bills against the
        // shared credit pool. The gate is normally skipped for this provider so no
        // hold exists; release one defensively if a caller placed it anyway.
        if (data.holdId) await releaseHold(data.holdId);
      } else if (aiUsageLogId && (success || (totalTokens ?? 0) > 0)) {
        await consumeCredits({
          aiUsageLogId,
          userId: data.userId,
          costDollars: cost,
          holdId: data.holdId,
          // Scope the live balance push so the per-conversation usage monitor
          // refreshes the right view; the navbar widget updates regardless.
          conversationId: data.conversationId,
          pageId: data.pageId,
        })
          .catch((error) => {
            loggers.ai.debug('credit consume failed', { error: (error as Error).message });
          });
      } else if (data.holdId) {
        // Token-less failure (pre-generation error): nothing to bill, but the gate
        // already placed a hold. Release it now instead of leaving it to the cron.
        await releaseHold(data.holdId);
      }
    } catch (error) {
      loggers.ai.debug('AI usage tracking failed', {
        error: (error as Error).message,
        model: data.model,
        provider: data.provider
      });
    }
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
  args?: unknown;
  result?: unknown;
  duration?: number;
  success?: boolean;
  error?: string;
  conversationId?: string;
  pageId?: string;
}

export function trackAIToolUsage(data: AIToolUsage): Promise<void> {
  // Return (not just call) trackAIUsage so the same durability guarantee applies
  // here: a caller that `await`s trackAIToolUsage waits for the tool-analytics log
  // (and its zero-charge ledger settlement) to persist before returning, instead
  // of resolving immediately and risking a dropped write on a serverless freeze.
  return trackAIUsage({
    userId: data.userId,
    provider: data.provider,
    model: data.model,
    duration: data.duration,
    conversationId: data.conversationId,
    pageId: data.pageId,
    success: data.success,
    error: data.error,
    source: 'tool',
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
        const metadata = record.metadata as Record<string, unknown>;
        const feature = (metadata.type as string) || (metadata.feature as string) || 'general_chat';
        
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