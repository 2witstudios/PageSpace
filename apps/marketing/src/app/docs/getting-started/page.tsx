import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Getting Started",
  description: "Set up PageSpace: passwordless signup, drives and pages, documents, AI agents, MCP integration, and inviting a team.",
  path: "/docs/getting-started",
  keywords: ["getting started", "setup", "quickstart", "tutorial"],
});

const content = `
# Getting Started

This guide takes you from a fresh account to an AI agent calling workspace tools inside one of your drives.

## 1. Create Your Account

Sign up at **pagespace.ai** — there are no passwords. Pick one:

- **Passkey** (recommended): use Touch ID, Face ID, Windows Hello, or a hardware key.
- **Magic link**: enter your email and click the link we send.
- **Google** or **Apple** OAuth.

No credit card required. The free tier includes 500 MB storage, 50 AI calls per day, and a 20 MB max file size.

After signup, PageSpace creates a **personal drive** (workspace) for you.

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

Documents use a TipTap rich-text editor with:
- Markdown input shortcuts (type \`# \` for a heading, \`- \` for a list)
- Real-time collaboration via Socket.IO
- Bubble and floating toolbars for formatting
- Drag-and-drop file uploads
- An HTML / Markdown storage toggle per page

## 4. Set Up AI

PageSpace routes every model through the Vercel AI SDK across 12 providers:

| Provider | What it is | Key required |
|----------|-----------|--------------|
| PageSpace | Hosted GLM models (default — \`glm-4.7\` standard, \`glm-5\` pro) | No — included |
| OpenRouter (Paid) | Any model in OpenRouter's catalog | Your OpenRouter key |
| OpenRouter (Free) | Free-tier models curated in the config | Your OpenRouter key |
| Google AI | Gemini 3 and 2.5 families | Your Google AI key |
| OpenAI | GPT-5.4 / 5.3 / 5.2 families | Your OpenAI key |
| Anthropic | Claude 4.6 / 4.5 / 4.1 families | Your Anthropic key |
| xAI | Grok 4 family | Your xAI key |
| Azure OpenAI | Models from your Azure deployment | Endpoint + key |
| GLM | GLM-5, 4.7, 4.6, 4.5 Air | Your GLM key |
| MiniMax | MiniMax M2.x models | Your MiniMax key |
| Ollama | Models discovered from a local Ollama server | Local server URL |
| LM Studio | Models discovered from a running LM Studio server | Local server URL |

The full provider + model list lives in \`apps/web/src/lib/ai/core/ai-providers-config.ts\`. To configure a provider, go to **Settings > AI** and enter your key. You can set different providers per drive or per page.

## 5. Create an AI Agent

AI Chat pages are specialized AI conversations with custom configuration:

1. Right-click in the file tree and select **New AI Chat**
2. Open the agent's settings to configure:
   - **System prompt**: custom instructions for the agent's behavior
   - **Enabled tools**: which of the 38 workspace tools the agent can call
   - **Read-only toggle**: when on, the agent can only read and search — no writes, no trash, no task updates
   - **Web search toggle**: enables the \`web_search\` tool
   - **Provider / Model**: which AI model powers this agent
3. The agent inherits context from its position in the hierarchy — an agent inside a project folder understands that project.

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

- **[Core Concepts](/docs/core-concepts)** — pages as primitives, context inheritance, the tree model
- **[Page Types](/docs/page-types)** — the 9 built-in page types in detail
- **[AI System](/docs/ai)** — multi-provider AI, tool calling, and agents
- **[API Reference](/docs/api)** — the PageSpace REST API
`;

export default function GettingStartedPage() {
  return <DocsMarkdown content={content} />;
}
