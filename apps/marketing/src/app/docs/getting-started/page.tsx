import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Getting Started",
  description: "Set up PageSpace and create your first AI-powered workspace. Covers account creation, workspace setup, documents, AI agents, and collaboration.",
  path: "/docs/getting-started",
  keywords: ["getting started", "setup", "quickstart", "tutorial"],
});

const content = `
# Getting Started

Get up and running with PageSpace in under five minutes. This guide walks you through creating your workspace, adding content, and connecting AI.

## 1. Create Your Account

Sign up at **pagespace.ai** with email/password or Google OAuth. No credit card required — the free tier includes 500 MB storage and 50 daily AI calls.

After signup, PageSpace automatically creates a **personal drive** (workspace) for you.

## 2. Understand Drives and Pages

PageSpace organizes everything into **drives** and **pages**:

- **Drives** are top-level workspaces. You can create multiple drives and invite members to each.
- **Pages** are the universal content primitive. Everything is a page — documents, folders, AI chats, channels, task lists, sheets, canvases, code files, and uploaded files.

Pages form a tree hierarchy. A document can live inside a folder, which lives inside another folder. This structure encodes meaning — AI and permissions both flow through the tree.

\`\`\`
📁 Marketing/
├── 📁 Q1 Campaign/
│   ├── 📄 Brand Guidelines
│   ├── 📋 Task List
│   ├── 💬 Team Channel
│   └── 🤖 Campaign AI Agent
├── 📁 Assets/
│   └── 📎 logo.png
└── 🤖 Marketing Assistant
\`\`\`

## 3. Create Your First Document

Click the **+** button in the sidebar or right-click to create a new page. Select **Document** and start typing.

Documents use a TipTap-powered rich text editor with:
- Full markdown support (headings, lists, code blocks, tables)
- Real-time collaboration — multiple users see changes instantly
- Slash commands for formatting
- File uploads via drag-and-drop

## 4. Set Up AI

PageSpace supports 7 AI providers with 100+ models:

| Provider | Models | Key Required |
|----------|--------|--------------|
| PageSpace | Free models via OpenRouter | No — included |
| OpenRouter | 200+ models | Your API key |
| Google AI | Gemini 2.5 Pro, Flash | Your API key |
| OpenAI | GPT-5, GPT-4.1 | Your API key |
| Anthropic | Claude 4.1 Opus/Sonnet | Your API key |
| xAI | Grok 4 | Your API key |
| Ollama | Local models | Self-hosted |

To configure a provider, go to **Settings > AI** and enter your API key. You can set different providers per drive or per page.

## 5. Create an AI Agent

AI Chat pages are specialized AI conversations with custom configuration:

1. Right-click in the file tree and select **New AI Chat**
2. Open the agent's settings to configure:
   - **System prompt**: Custom instructions for the agent's behavior
   - **Enabled tools**: Which workspace tools the agent can use (from 13+ available)
   - **Provider/Model**: Which AI model powers this agent
3. The agent inherits context from its position in the hierarchy — an agent inside a project folder understands that project

Agents can also consult each other via the \`ask_agent\` tool, enabling multi-agent collaboration.

## 6. Connect External AI Tools (MCP)

If you use Claude Desktop, Claude Code, Cursor, or other MCP-compatible tools, you can connect them to your PageSpace workspace:

1. Go to **Settings > MCP** and create a token
2. Add the PageSpace MCP server to your tool's config:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "mcp_your_token_here"
      }
    }
  }
}
\`\`\`

See the [MCP Integration guide](/docs/mcp) for full details.

## 7. Invite Your Team

To collaborate:

1. Go to **Drive Settings > Members**
2. Add members by email — they join as \`MEMBER\` by default
3. Promote members to \`ADMIN\` for drive management access
4. Set page-level permissions for fine-grained access control

Members can collaborate in real-time on documents, channels, and AI conversations.

## Next Steps

- **[Core Concepts](/docs/core-concepts)** — Understand pages as primitives, context inheritance, and the tree model
- **[Page Types](/docs/page-types)** — Explore all 9 page types in detail
- **[AI System](/docs/ai)** — Deep dive into multi-provider AI, tool calling, and agents
- **[API Reference](/docs/api)** — Build integrations with the PageSpace REST API
`;

export default function GettingStartedPage() {
  return <DocsMarkdown content={content} />;
}
