import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI System",
  description: "PageSpace AI architecture: AI conversations as pages, 12-provider support, 37 workspace tools, and agent collaboration.",
  path: "/docs/ai",
  keywords: ["AI", "LLM", "providers", "tool calling", "agents"],
});

const content = `
# AI System

AI conversations in PageSpace are pages, not a separate chatbot. They live inside drives and folders, inherit permissions, show up in search, and use the same tools that operate on the rest of your workspace.

## AI conversations are pages

Each AI chat is an \`AI_CHAT\` page type. It sits in the tree next to documents, folders, and channels:

\`\`\`
📁 Project Alpha/
├── 📄 Requirements.md
├── 📁 Research/
│   ├── 🤖 Research Assistant    ← AI_CHAT page
│   └── 📄 Market Analysis.md
└── 🤖 Project Planning AI       ← AI_CHAT page
\`\`\`

Consequences:

- AI inherits drive and page permissions — it can only see content the calling user can see.
- AI conversations are searchable and mentionable like any other page.
- Different parts of a workspace can host different agents with different configs.

## Message persistence

Every message — user or assistant — is a row in \`chat_messages\`. Columns used today:

| Column | Purpose |
|---|---|
| \`id\` | Message id |
| \`pageId\` | Owning AI_CHAT page |
| \`conversationId\` | Groups messages into a session within a page |
| \`role\` | \`user\` or \`assistant\` |
| \`content\` | Message text |
| \`toolCalls\`, \`toolResults\` | JSONB tool-call payloads |
| \`userId\` | Who sent it (null for assistant) |
| \`sourceAgentId\` | Set when one agent sent on behalf of another via \`ask_agent\` |
| \`messageType\` | \`standard\` or \`todo_list\` |
| \`isActive\`, \`editedAt\` | Edit / regenerate support |
| \`createdAt\` | Timestamp |

Source: \`packages/db/src/schema/core.ts\`.

Persisting per-message enables multi-user conversations (several people sharing one agent), real-time sync via Socket.IO, and full tool-call history for debugging and context.

## Context inheritance

Every tool call receives an execution context with the caller's user id, timezone, active provider and model, and the page + drive it is running inside. Agents use this context to scope search, resolve "here", and pick the correct drive for new pages. Source: \`apps/web/src/lib/ai/core/types.ts\`.

## Providers and models

PageSpace routes AI through the Vercel AI SDK across 12 providers:

| Provider | Default model | Who supplies the key |
|---|---|---|
| PageSpace | \`glm-4.7\` (Standard), \`glm-5\` (Pro) | Built-in (GLM backend) |
| OpenRouter (Paid) | user-selected | User |
| OpenRouter (Free) | user-selected | User (no cost) |
| Google AI | \`gemini-2.5-flash\` | User |
| OpenAI | user-selected | User |
| Anthropic | user-selected | User |
| xAI (Grok) | user-selected | User |
| GLM (Coder Plan) | user-selected | User |
| MiniMax | user-selected | User |
| Ollama | discovered from local instance | N/A (local server) |
| LM Studio | discovered from local instance | N/A (local server) |
| Azure OpenAI | user's deployment name | User |

Full list with model IDs: \`apps/web/src/lib/ai/core/ai-providers-config.ts\`.

## Tools

AI has access to 37 workspace tools. They cover page reads and writes, drive management, search, calendar, channels, tasks, agent discovery and consultation, activity queries, and web search. See [Tool Calling](/docs/ai/tool-calling) for the full reference.

Tools run with the calling user's permissions. An AI cannot read, write, or delete anything the user cannot.

## Read-only and web-search toggles

Each AI_CHAT page exposes two runtime toggles that filter the tool set:

- **Read-only mode** — excludes every write tool (create, edit, delete, send). The agent can still read, search, and plan.
- **Web search enabled** — includes \`web_search\`; off by default.

Source: \`apps/web/src/lib/ai/core/tool-filtering.ts\`. A page can also pin a specific subset of tools via \`enabledTools\` on the page config.

## Agent-to-agent consultation

An agent can call another agent via \`ask_agent\`, passing a question and optional context. Target agent loads its conversation history, runs with its own system prompt and tools, persists the exchange, and returns a response. A depth limit of 2 prevents chains deeper than the original → first sub-agent. Source: \`apps/web/src/lib/ai/tools/agent-communication-tools.ts\`.

## Real-time collaboration

AI messages are broadcast over Socket.IO to every user viewing the AI_CHAT page. Tool calls, tool results, and streaming response deltas all reach connected clients. Multi-user chat with a single agent works out of the box.

## Model capability detection

Before running a tool-capable workflow, PageSpace checks whether the selected model supports tool calling and vision. If tools aren't supported, the stream falls back to text-only and the UI suggests tool-capable alternatives from the same provider. OpenRouter capability is queried at runtime; other providers use pattern matching on the model id.

## Learn more

- **[Providers & Models](/docs/ai/providers)** — per-provider setup, model ids, and API-key storage.
- **[Tool Calling](/docs/ai/tool-calling)** — the 37-tool catalog, execution context, retries, and custom tool sets.
- **[Agents](/docs/ai/agents)** — configuring AI_CHAT pages, system prompts, and agent-to-agent flows.
`;

export default function AIPage() {
  return <DocsMarkdown content={content} />;
}
