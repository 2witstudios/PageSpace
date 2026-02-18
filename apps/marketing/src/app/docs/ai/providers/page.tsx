import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI Providers & Models",
  description: "Supported AI providers in PageSpace: OpenRouter, Google AI, OpenAI, Anthropic, xAI, and Ollama. Configuration, model capabilities, and setup.",
  path: "/docs/ai/providers",
  keywords: ["AI providers", "models", "OpenRouter", "Google AI", "OpenAI", "Anthropic", "xAI", "Ollama"],
});

const content = `
# Providers & Models

PageSpace supports 7 AI providers with 100+ models through a unified interface built on the Vercel AI SDK.

## Provider Overview

### PageSpace (Default)

The built-in provider uses OpenRouter with PageSpace's API key. No configuration required.

- **Free tier**: Includes models like Qwen3, DeepSeek R1, Mistral Small
- **No API key needed**: Works out of the box
- **Rate limited**: 50 AI calls/day on free plan

### OpenRouter

Access 200+ models from multiple providers through a single API key.

\`\`\`
Settings > AI > OpenRouter > Enter API key
\`\`\`

Models include Claude, GPT, Gemini, Llama, Mixtral, and many more. OpenRouter handles routing, rate limiting, and fallbacks.

### Google AI

Direct access to Google's Gemini models.

\`\`\`
Settings > AI > Google AI > Enter API key
\`\`\`

| Model | Context | Vision | Tools |
|-------|---------|--------|-------|
| Gemini 2.5 Pro | 1M tokens | Yes | Yes |
| Gemini 2.5 Flash | 1M tokens | Yes | Yes |
| Gemini 2.0 Flash | 1M tokens | Yes | Yes |

### OpenAI

Direct access to OpenAI models.

\`\`\`
Settings > AI > OpenAI > Enter API key
\`\`\`

| Model | Context | Vision | Tools |
|-------|---------|--------|-------|
| GPT-5 | 128K tokens | Yes | Yes |
| GPT-4.1 | 1M tokens | Yes | Yes |
| GPT-4.1 mini | 1M tokens | Yes | Yes |
| o3 | 200K tokens | Yes | Yes |
| o4-mini | 200K tokens | Yes | Yes |

### Anthropic

Direct access to Anthropic's Claude models.

\`\`\`
Settings > AI > Anthropic > Enter API key
\`\`\`

| Model | Context | Vision | Tools |
|-------|---------|--------|-------|
| Claude Opus 4.6 | 200K tokens | Yes | Yes |
| Claude Sonnet 4.6 | 200K tokens | Yes | Yes |
| Claude Haiku 4.5 | 200K tokens | Yes | Yes |

### xAI

Direct access to xAI's Grok models.

\`\`\`
Settings > AI > xAI > Enter API key
\`\`\`

| Model | Context | Vision | Tools |
|-------|---------|--------|-------|
| Grok 4 | 256K tokens | Yes | Yes |

### Ollama (Local)

Run AI models locally on your own hardware. Requires a running Ollama instance.

\`\`\`
Settings > AI > Ollama > Configure base URL (default: http://localhost:11434)
\`\`\`

Any model available in your Ollama installation is automatically discovered. Popular choices: Llama 3, CodeLlama, Mistral, Phi-3.

## Configuration Hierarchy

AI settings can be configured at three levels, with the most specific level winning:

1. **User default** — Your global AI provider/model preference
2. **Drive override** — Different provider/model for a specific workspace
3. **Page override** — Different provider/model for a specific AI chat page

\`\`\`typescript
// User default
Settings > AI > Default Provider: "anthropic"
Settings > AI > Default Model: "claude-sonnet-4-20250514"

// Drive override
Drive Settings > AI > Provider: "google"
Drive Settings > AI > Model: "gemini-2.5-pro-preview"

// Page override (AI_CHAT pages only)
Page Settings > AI Provider: "openai"
Page Settings > AI Model: "gpt-4.1"
\`\`\`

## API Key Security

API keys are stored encrypted in the \`user_ai_settings\` table:

- One key per provider per user
- Keys are encrypted at rest using server-side encryption
- Keys are never exposed in API responses
- Keys can be updated or deleted from Settings > AI

## Model Capability Detection

PageSpace automatically detects whether models support:

- **Vision** (image processing): Checked via static lookup tables and pattern matching on model names
- **Tool calling** (function execution): Checked via OpenRouter's capability API or pattern-based fallback

When a model doesn't support tools, PageSpace:
1. Falls back to text-only mode
2. Informs the user
3. Suggests tool-capable alternatives from the same provider

## Free Models

The PageSpace provider includes several free models via OpenRouter:

- **Qwen3 Coder** — Good for code generation
- **DeepSeek R1** — Strong reasoning model
- **Mistral Small** — Fast general-purpose model

Free models have usage limits based on your subscription plan. All free models support tool calling.
`;

export default function ProvidersPage() {
  return <DocsMarkdown content={content} />;
}
