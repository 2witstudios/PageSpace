import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI System",
  description: "PageSpace AI architecture: multi-provider support, contextual intelligence, database-first persistence, tool calling, and agent collaboration.",
  path: "/docs/ai",
  keywords: ["AI", "artificial intelligence", "LLM", "providers", "tool calling", "agents"],
});

const content = `
# AI System

PageSpace treats AI not as an isolated chatbot, but as **contextual intelligence embedded within the workspace hierarchy**. AI conversations are pages, they inherit context from their location, and they participate in the same collaborative, permission-based ecosystem as documents, folders, and channels.

## Architecture

### Pages as AI Containers

AI conversations are \`AI_CHAT\` page types — first-class citizens in the PageSpace ecosystem:

\`\`\`
📁 Project Alpha/
├── 📄 Requirements.md
├── 📁 Research/
│   ├── 🤖 Research Assistant    ← AI_CHAT page
│   └── 📄 Market Analysis.md
└── 🤖 Project Planning AI      ← AI_CHAT page
\`\`\`

This means:
- AI conversations inherit permissions from their drive
- AI can reference and understand sibling documents
- AI conversations appear in search, mentions, and navigation
- Multiple AI contexts can exist at different hierarchy levels

### Database-First Message Persistence

Every message is immediately persisted to PostgreSQL as an individual row:

\`\`\`sql
chat_messages:
  id        | pageId   | userId | role      | content          | toolCalls | agentRole
  msg-1     | page-123 | user-1 | user      | "Analyze this"   | NULL      | PARTNER
  msg-2     | page-123 | NULL   | assistant | "Here's my..."   | [{...}]   | PARTNER
  msg-3     | page-123 | user-2 | user      | "Also check..."  | NULL      | PARTNER
\`\`\`

This enables:
- **Multi-user collaboration** — multiple people chat with the same AI
- **Real-time sync** — all participants see messages as they arrive
- **Message attribution** — clear record of who said what
- **Cross-conversation search** — find information across all AI interactions
- **Tool call persistence** — tool calls and results stored for context and debugging
- **Message versioning** — support for editing and regeneration via \`isActive\` flag

### Contextual Intelligence

AI conversations understand their position in the workspace hierarchy:

\`\`\`
📁 Marketing Campaign/
├── 📄 Brand Guidelines
├── 📄 Target Audience
└── 🤖 Campaign AI          ← Sees Brand Guidelines and Target Audience
\`\`\`

Context flows upward: an AI can reference parent and sibling pages (with permission). Context is limited by the user's access permissions — AI can only see what you can see.

## Multi-Provider Support

PageSpace supports 7 AI providers with a unified interface via the Vercel AI SDK:

| Provider | Key Models | Key Required |
|----------|-----------|--------------|
| PageSpace | Free models via OpenRouter | No |
| OpenRouter | 200+ models including Claude, GPT, Gemini | User's key |
| Google AI | Gemini 2.5 Pro, Gemini Flash | User's key |
| OpenAI | GPT-5, GPT-4.1, o3 | User's key |
| Anthropic | Claude 4.1 Opus, Claude Sonnet | User's key |
| xAI | Grok 4 | User's key |
| Ollama | Any local model | Self-hosted |

API keys are stored encrypted per-provider. You can set different providers per drive or per individual AI page.

## Tool Calling

AI agents have access to **13+ workspace automation tools** organized into 6 categories:

| Category | Tools | Capability |
|----------|-------|-----------|
| Core Page Ops | \`list_drives\`, \`list_pages\`, \`read_page\`, \`create_page\`, \`rename_page\`, \`move_page\` | Navigate and manage workspace |
| Content Editing | \`replace_lines\` | Precise line-based document editing |
| Trash Ops | \`trash\`, \`restore\` | Soft delete and recovery |
| Search | \`regex_search\`, \`glob_search\`, \`multi_drive_search\` | Pattern and cross-workspace search |
| Task Management | \`update_task\` | Create and update tasks on task lists |
| Agent Management | \`list_agents\`, \`multi_drive_list_agents\`, \`ask_agent\`, \`update_agent_config\` | Agent discovery and collaboration |

Tools are filtered by agent role and can be customized per page. See [Tool Calling](/docs/ai/tool-calling) for details.

## Agent Roles

Three built-in agent roles with different capabilities:

| Role | Read | Write | Delete | Use Case |
|------|------|-------|--------|----------|
| PARTNER | Yes | Yes | Yes | Collaborative AI partner with full capabilities |
| PLANNER | Yes | No | No | Strategic planning — read-only analysis |
| WRITER | Yes | Yes | Yes | Execution-focused — minimal conversation, maximum output |

Each role gets a different system prompt and filtered set of tools. You can further customize by setting \`enabledTools\` on individual AI pages.

## Real-Time Collaboration

AI messages are broadcast to all conversation participants via Socket.IO:

- User A sends a message → saved to database → broadcast to all users
- AI responds → response streamed to all users in real-time
- User B can continue the conversation immediately
- Tool calls and results are visible to all participants

## Model Capability Detection

PageSpace automatically detects model capabilities:

- **Vision**: Whether a model can process images (checked via static maps and pattern matching)
- **Tool calling**: Whether a model supports function calling (checked via OpenRouter API for OpenRouter models, pattern-based for others)

If a model doesn't support tools, PageSpace falls back to text-only mode and suggests tool-capable alternatives.

## Learn More

- **[Providers & Models](/docs/ai/providers)** — Detailed provider configuration and model list
- **[Tool Calling](/docs/ai/tool-calling)** — Complete tool reference with parameters and examples
- **[Agents](/docs/ai/agents)** — Custom agents, system prompts, and agent-to-agent communication
`;

export default function AIPage() {
  return <DocsMarkdown content={content} />;
}
