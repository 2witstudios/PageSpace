import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI Providers & Models",
  description: "Supported AI providers in PageSpace: PageSpace, OpenRouter (Paid/Free), Google, OpenAI, Anthropic, xAI, GLM, MiniMax, Ollama, LM Studio, Azure OpenAI.",
  path: "/docs/ai/providers",
  keywords: ["AI providers", "models", "OpenRouter", "Google AI", "OpenAI", "Anthropic", "xAI", "Ollama", "LM Studio", "Azure OpenAI", "GLM", "MiniMax"],
});

const content = `
# Providers & Models

PageSpace routes AI through the Vercel AI SDK across 12 providers. Each user configures the providers they want in **Settings > AI**. Keys are stored encrypted per user, per provider. Source: \`apps/web/src/lib/ai/core/ai-providers-config.ts\`.

## Configuration hierarchy

Three levels, most specific wins:

1. **User default** — global provider and model.
2. **Drive override** — different model for a whole workspace.
3. **Page override** — different model for a single AI_CHAT page.

## Providers

### PageSpace (default)

Built-in. No key required. Runs against a GLM backend (\`getBackendProvider('pagespace') → 'glm'\`).

| Alias | Model | Tier |
|---|---|---|
| \`standard\` | \`glm-4.7\` | Free, Pro, Founder, Business |
| \`pro\` | \`glm-5\` | Pro, Founder, Business |

Aliases resolve at call time via \`PAGESPACE_MODEL_ALIASES\`, so an agent pinned to \`standard\` stays on whatever backend model the team ships today.

Daily call limits by plan:

| Plan | Standard / day | Pro / day |
|---|---|---|
| Free | 50 | 0 |
| Pro | 200 | 50 |
| Founder | 500 | 100 |
| Business | 1000 | 500 |

Source: \`apps/web/src/lib/subscription/usage-service.ts\`.

### OpenRouter (Paid)

One key, many frontier models — Anthropic, OpenAI, Google, Meta, Mistral, xAI, Qwen, DeepSeek, GLM, MiniMax, and more. The config file ships a curated paid-model list; OpenRouter's catalog is broader.

\`\`\`
Settings > AI > OpenRouter > Enter API key
\`\`\`

### OpenRouter (Free)

Same key (or none on free-only models), routed to free-tier models. Curated list includes Qwen3 Coder, DeepSeek R1, Llama 3.1 405B, Mistral Small, Gemma 3, GLM 4.5 Air. Subject to OpenRouter's free-tier rate limits.

### Google AI

Direct Gemini access.

\`\`\`
Settings > AI > Google AI > Enter API key
\`\`\`

Models include Gemini 3 Pro, 3.1 Pro Preview, 3.1 Flash Lite Preview, 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite, 2.0 Pro (Experimental), 2.0 Flash, and 1.5 Pro / Flash / Flash 8B. Default model: \`gemini-2.5-flash\`.

### OpenAI

Direct OpenAI access.

\`\`\`
Settings > AI > OpenAI > Enter API key
\`\`\`

Models span GPT-5.4, 5.3, 5.2 (incl. Codex / mini / nano), 5.1 / 5 (incl. Codex, Mini, Nano), 4.1 series (\`gpt-4.1-2025-04-14\`, mini, nano), 4o (incl. audio preview), 4 Turbo, and reasoning models o4-mini, o3, o3-mini, o1 + preview.

### Anthropic

Direct Claude access.

\`\`\`
Settings > AI > Anthropic > Enter API key
\`\`\`

| Model ID | Name |
|---|---|
| \`claude-opus-4-6-20260204\` | Claude Opus 4.6 |
| \`claude-sonnet-4-6-20260217\` | Claude Sonnet 4.6 |
| \`claude-opus-4-5-20251124\` | Claude Opus 4.5 |
| \`claude-sonnet-4-5-20250929\` | Claude Sonnet 4.5 |
| \`claude-haiku-4-5-20251001\` | Claude Haiku 4.5 |
| \`claude-opus-4-1-20250805\` | Claude Opus 4.1 |
| \`claude-sonnet-4-1-20250805\` | Claude Sonnet 4.1 |

Plus Claude 3.7 Sonnet and the 3.5 / 3 family.

### xAI (Grok)

Direct Grok access.

\`\`\`
Settings > AI > xAI > Enter API key
\`\`\`

Models include \`grok-4\`, \`grok-4-fast-reasoning\`, \`grok-4-fast-non-reasoning\`, \`grok-code-fast-1\`, and the Grok 3 / 2 / vision-beta families.

### GLM (Coder Plan)

Direct GLM access for users on the GLM Coder Plan. Backend is OpenAI-compatible.

\`\`\`
Settings > AI > GLM > Enter API key
\`\`\`

Models: \`glm-5\`, \`glm-4.7\`, \`glm-4.6\`, \`glm-4.5-air\`.

### MiniMax

Direct MiniMax access.

\`\`\`
Settings > AI > MiniMax > Enter API key
\`\`\`

Models: \`MiniMax-M2.5\`, \`M2.1\`, \`M2\`, \`M2-Stable\`.

### Ollama (local)

Run models locally via an Ollama server. Requires the server to be reachable from the app.

\`\`\`
Settings > AI > Ollama > Configure base URL (default: http://localhost:11434)
\`\`\`

The installed model list is discovered at request time — PageSpace ships no static fallback.

### LM Studio (local)

Same pattern as Ollama: connect to a running LM Studio server; available models are enumerated dynamically.

### Azure OpenAI

Point at an Azure deployment. Users enter the deployment name as the model id; the provider resolves it against the Azure endpoint.

## Configuring a specific model

\`\`\`typescript
// User default (Settings > AI)
Provider: "anthropic"
Model: "claude-sonnet-4-6-20260217"

// Drive override (Drive Settings > AI)
Provider: "google"
Model: "gemini-2.5-pro"

// Page override (AI_CHAT page settings)
Provider: "openai"
Model: "gpt-4.1-2025-04-14"
\`\`\`

Always use the model id shown in \`ai-providers-config.ts\` — unversioned aliases like \`gpt-4.1\` or \`gemini-2.5-pro-preview\` are not accepted (except the PageSpace provider, which accepts \`standard\` / \`pro\`).

## API-key storage

User keys live in \`user_ai_settings\` (one row per user + provider), encrypted with \`ENCRYPTION_KEY\` before insert. Keys are never returned by the API — only presence is exposed. Source: \`packages/db/src/schema/ai.ts\`, \`apps/web/src/lib/ai/core/ai-utils.ts\`.

## Model capability detection

PageSpace checks each model for:

- **Vision** — image input support. Verified via a static capability map and model-id pattern matching.
- **Tool calling** — function-calling support. OpenRouter models are verified against OpenRouter's capability API; others use model-id patterns.

When a model lacks tool support, tool calls are suppressed for that stream and the UI suggests tool-capable alternatives from the same provider.
`;

export default function ProvidersPage() {
  return <DocsMarkdown content={content} />;
}
