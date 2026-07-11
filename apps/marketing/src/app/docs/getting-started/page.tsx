import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";
import { MONTHLY_CREDITS } from "@/lib/credits";

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

No credit card required. The free tier includes 500 MB storage, ${MONTHLY_CREDITS.free}/month of credits, and a 20 MB max file size.

After signup, PageSpace sets you up with a starter **drive** (workspace) so you can jump straight in.

## 2. Understand Drives and Pages

PageSpace organizes everything into **drives** and **pages**:

- **Drives** are top-level workspaces. You can create multiple drives and invite members to each.
- **Pages** are the universal content primitive. Everything is a page — documents, folders, AI chats, channels, task lists, sheets, canvases, code files, and uploaded files.

Pages form a tree hierarchy. A document can live inside a folder, which lives inside another folder. This structure gives AI meaningful context; access is controlled by drive membership and explicit per-page permissions (no inheritance from parent folders).

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

PageSpace gives you one catalogue of models from many vendors, organised by vendor, so you reach them all without supplying any API keys — PageSpace manages the credentials. The default model is \`openai/gpt-5.3-chat\`.

| Vendor | What it is |
|--------|-----------|
| OpenAI | GPT-5.4 / 5.3 / 5.2 families |
| Anthropic | Claude 4.6 / 4.5 / 4.1 families |
| Google | Gemini 3 and 2.5 families |
| xAI | Grok 4 family |
| DeepSeek, Qwen, Mistral, Moonshot, MiniMax, Meta, and more | Additional open and frontier models in the catalogue |

Open **Settings > AI** to pick a model. The model you pick becomes your account-level default; any individual AI Chat page can override it. Each call draws from your plan's monthly credit allowance based on the model's real cost. Free accounts use a curated allowlist — \`openai/gpt-5.3-chat\` (default), the GPT-5.4 nano and mini models, Claude Haiku 4.5, and the Gemini Flash family — while paid plans unlock the full catalogue.

## 5. Create an AI Agent

AI Chat pages are specialized AI conversations with custom configuration:

1. Right-click in the file tree and select **New AI Chat**
2. Open the agent's settings to configure:
   - **System prompt**: custom instructions for the agent's behavior
   - **Enabled tools**: which of the 76 workspace tools the agent can call
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
      "args": ["-y", "-p", "@pagespace/cli", "pagespace-mcp"],
      "env": {
        "PAGESPACE_TOKEN": "mcp_your_token_here"
      }
    }
  }
}
\`\`\`

Prefer the \`pagespace\` CLI end to end? \`npm install -g @pagespace/cli\`, then \`pagespace login\` and the \`pagespace keys\` wizard mint a drive-scoped key without ever copying a token. See the [MCP Integration guide](/docs/integrations/mcp) for full details.

## 7. Invite Your Team

To collaborate:

1. Go to **Drive Settings > Members**
2. Add members by email — they join as \`MEMBER\` by default
3. Promote members to \`ADMIN\` for drive management access
4. Set page-level permissions for fine-grained access control

Members can collaborate in real-time on documents, channels, and AI conversations.

## Next Steps

- **[Core Concepts](/docs/core-concepts)** — pages as primitives, context inheritance, the tree model
- **[Page Types](/docs/page-types)** — the 9 built-in page types and what each one is for
- **[Features](/docs/features)** — plain-language reference for the behaviours every page shares
- **[MCP Integration](/docs/integrations/mcp)** — connect Claude Desktop, Cursor, or your own MCP client
`;

export default function GettingStartedPage() {
  return <DocsMarkdown content={content} />;
}
