export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  content: string;
  author: string;
  date: string;
  readTime: string;
  category: string;
  image?: string;
}

export const blogPosts: Record<string, BlogPost> = {
  "your-workspace-is-the-context": {
    slug: "your-workspace-is-the-context",
    title:
      "Your Workspace Is the Context: How PageSpace Teaches AI Where It Is",
    description:
      "Most AI tools dump flat text into a prompt. PageSpace gives AI a map — a tree structure that encodes location, hierarchy, and meaning. Here's how workspace organization becomes AI understanding.",
    image: "/blog/workspace-is-the-context.png",
    content: `
## The Problem with Flat Context

Most AI tools work like this: take a blob of text, shove it into the system prompt, hope the model figures it out.

There's no structure. No location. No hierarchy. The AI doesn't know where it is, what's around it, or how the information relates to anything else. It's reading a book with no table of contents, no chapters, no page numbers.

You end up doing the work the AI should be doing — explaining what project this is, what files are relevant, what conventions apply. Every session. Every time.

The problem isn't the AI's capability. It's that nobody gave it a map.

## The Tree as a Semantic Structure

PageSpace organizes everything in a page tree. Folders, documents, AI agents, chat channels, spreadsheets, canvases — they all live in a hierarchical structure you design.

This isn't just a UI convenience. The tree *is* the context model.

Where a page lives tells the AI what it means. A document called "API Design" under \`/Engineering/Backend/\` carries different weight than a document with the same name under \`/Archive/Old Drafts/\`. The path encodes intent, scope, and relevance — without you writing a single annotation.

When you organize your workspace, you're not just tidying up for yourself. You're teaching the AI how your work is structured.

## Breadcrumb Path Injection

When you chat with an AI agent in PageSpace, the system builds a breadcrumb path from the page's position in the tree and injects it directly into the system prompt.

Here's what the AI actually receives — the real \`PAGE CONTEXT\` block from the system prompt builder:

\`\`\`
PAGE CONTEXT:
• Location: /engineering/backend/api-design
• Type: DOCUMENT
• Path: Engineering > Backend > API Design
• When users say "here", they mean this page
\`\`\`

The AI now knows it's looking at an API design document inside the backend section of the engineering workspace. When you say "here," it means something specific. When you say "update this," the AI knows exactly what "this" refers to.

No ambiguity. No guessing. The tree position resolves it.

## Workspace Structure as a Map

Beyond knowing its own location, the AI can receive the entire workspace tree — formatted as a visual hierarchy that mirrors the structure you built.

Here's the real format, generated from PageSpace's tree formatter:

\`\`\`
├── 📁 Engineering
│   ├── 📄 Architecture Overview
│   ├── 🤖 Code Review Agent
│   └── 📁 Backend
│       ├── 📄 API Design
│       └── 📄 Database Schema
└── 📁 Product
    ├── 📄 Roadmap
    └── 💬 Team Discussion
\`\`\`

The AI can see sibling pages, parent folders, and the full organizational context. It knows that "Architecture Overview" and "Code Review Agent" sit alongside the "Backend" folder. It can decide what to read based on structure, not guesswork.

When someone asks "what do we know about the backend?" the AI doesn't search blindly — it looks at the Backend folder, sees what's there, and reads what's relevant. The tree tells it where to look.

## Inline Instructions — What the AI Knows About Itself

Beyond location, the AI receives contextual rules that define how it should behave in this specific context. These come from PageSpace's inline instruction system:

\`\`\`
CONTEXT:
• Current location: "API Design" [DOCUMENT] at /eng/backend/api-design in "Engineering"
• DriveSlug: eng, DriveId: abc123
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives
\`\`\`

The AI also receives page type documentation — what each type can do, what operations make sense. It knows that a DOCUMENT page supports rich text editing and content updates. It knows that a SPREADSHEET page has structured data. It knows that an AI_CHAT page is a conversation.

Add workspace-level rules — your team's conventions, writing style preferences, tool restrictions — and the AI's behavior becomes specific to where it's operating, not generic across all contexts.

## The Tools — How the AI Explores

PageSpace doesn't just give the AI a static context dump. It gives the AI real tools to explore your workspace actively:

- **\`list_pages\`** — Browse the tree structure, see what's inside any folder
- **\`read_page\`** — Read the full content of any page in the workspace
- **\`regex_search\`** — Search content across pages with regex patterns, returns matches with line numbers and semantic paths
- **\`glob_search\`** — Find pages by path patterns like \`**/meeting-notes/*\` or \`engineering/**\`
- **\`multi_drive_search\`** — Search across all workspaces at once when the answer might live somewhere else
- **\`ask_agent\`** — Call another AI agent in the workspace, delegating specialized questions to agents with domain expertise

The AI doesn't just receive context passively — it can actively navigate. The tree gives it a map. The tools let it move through it. When the AI needs to find related documents, it doesn't ask you to paste them. It searches, reads, and synthesizes on its own.

## Page Agents: Context-Aware AI in the Tree

Page agents are AI_CHAT pages that live in the tree alongside your documents. They're not separate from your workspace — they're part of it.

Each agent can be configured with:

- **Custom system prompts** — specific instructions for what this agent knows and how it should behave
- **Tool permissions** — allow only read tools for a research agent, or write tools for an editor agent
- **Page tree visibility** — see only children of the current folder, or the full drive structure
- **Drive prompt inclusion** — inherit workspace-level instructions and conventions

Here's why the tree matters for agents: an agent nested under \`/Engineering/Backend/\` naturally has context about backend engineering. Its position in the tree encodes its purpose. A "Code Review Agent" sitting next to "Architecture Overview" and "API Design" inherently understands its scope — it's there to review code in the context of that architecture and those APIs.

You don't need to write elaborate prompts explaining what the agent should focus on. The tree already told it.

## The Composable Prompt

All of this comes together in how PageSpace assembles the final system prompt. It's not one monolithic block — it's built from discrete, composable layers:

1. **Core role definition** — the base personality and capabilities
2. **User personalization** — your bio, writing style, custom rules
3. **Location context** — breadcrumbs, drive info, page type
4. **Workspace structure** — the tree, visible as a map
5. **Inline instructions** — contextual rules for this specific location
6. **Timestamp context** — current date, time, and timezone
7. **Agent awareness** — list of other agents available to consult

Each layer is independently cacheable. Each is determined by the tree position — different locations produce different prompts. An agent in the Engineering folder gets engineering context. An agent in Product gets product context. Same underlying model, different understanding.

The tree isn't just organizing your files. It's programming the AI.

## Why This Matters

AI that knows where it is makes better decisions.

It doesn't need you to explain the project structure — it can see the tree. It doesn't need you to point at related documents — it can find them. It understands that a page under "Architecture Decisions" is different from a page under "Meeting Notes" even if they mention the same topic.

Structure is meaning. A flat list of documents is just noise. A tree is a semantic model — every folder boundary, every nesting level, every sibling relationship carries information about how your work fits together.

When you organize your PageSpace workspace, you're not doing busywork. You're building the context model that makes your AI actually useful. The workspace *is* the prompt.

Your workspace is the context. Make it a good one.
    `,
    author: "Jono",
    date: "2026-02-17",
    readTime: "9 min read",
    category: "Product",
  },
  "pagespace-as-memory-for-coding-agents": {
    slug: "pagespace-as-memory-for-coding-agents",
    title: "Using PageSpace as Memory for Your Coding Agent",
    description:
      "Coding agents are stateless. Every session starts from scratch. Here's how to give them persistent memory with PageSpace and MCP — including cloud agents that intelligently retrieve the right context.",
    image: "/blog/pagespace-memory-coding-agents.png",
    content: `
## The Problem: Your Coding Agent Has Amnesia

Every time you start a new session with your coding agent, it forgets everything. The architecture decisions you explained yesterday. The conventions your team agreed on last week. The debugging session where you finally figured out that weird race condition.

You re-explain the same context over and over. You paste the same docs into chat. You point at the same files and say "remember, we do it this way."

CLAUDE.md files help — they give your agent a starting point. But they're static, local to one repo, and limited in what they can capture. They're a sticky note on the monitor, not a knowledge base.

What if your coding agent could actually remember?

## What If Your Agent Had a Knowledge Base?

Imagine a persistent, organized workspace your coding agent can read from, write to, and search across. Not files buried in your repo — a structured knowledge system that:

- **Persists across sessions** — context survives after you close your terminal
- **Works across projects** — your React conventions apply whether you're in the frontend repo or the monorepo
- **Shares across machines** — same knowledge base on your laptop and your CI server
- **Stays organized** — not a flat dump of text, but a hierarchy of pages, folders, and agents

That's what PageSpace gives your coding agent.

## PageSpace + MCP: The Connection

PageSpace publishes an MCP server — \`pagespace-mcp\` on npm — that exposes your knowledge base to any coding agent that supports the Model Context Protocol.

Install it, point it at your PageSpace instance with a token, and your coding agent gets direct access to search, read, and write pages in your workspace.

MCP is the protocol. PageSpace is the memory.

## Setup

Add PageSpace to your coding agent's MCP configuration:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://your-instance.pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "your-mcp-token"
      }
    }
  }
}
\`\`\`

Generate an MCP token from your PageSpace workspace settings. The token is scoped to a specific drive, so you control exactly what your agent can access.

That's it. Your coding agent can now search your knowledge base, read pages, create new ones, and update existing content — all through natural tool calls.

## The Real Differentiator: Cloud Agents

Here's where PageSpace goes beyond "document storage your agent can read."

PageSpace has **page agents** — cloud AI agents with custom instructions that live inside your knowledge base. They're not just documents. They're intelligent retrieval and processing layers that sit between your coding agent and your knowledge.

When your coding agent calls PageSpace via MCP, it can talk to these page agents. That means:

**Smart retrieval, not keyword search.** Instead of your coding agent trying to guess which document has the answer, it can ask a page agent: "What are our conventions for error handling in API routes?" The page agent knows the knowledge base, understands the question, and returns the relevant context.

**Summarization on demand.** A page agent can digest a 20-page architecture doc into the three paragraphs your coding agent actually needs for its current task.

**Knowledge base maintenance.** Page agents can organize incoming information. Your coding agent writes a raw note about a decision you made — a page agent files it properly, links it to related docs, and keeps the knowledge base clean.

**Shared context across agents.** Multiple coding agents — yours, your teammate's, your CI pipeline's — all read from and write to the same workspace. Page agents ensure consistency. One source of truth, many consumers.

This is the difference between giving your agent a filing cabinet and giving it a research assistant.

## What to Put in Your Knowledge Base

Start with what you find yourself re-explaining to your coding agent:

- **Architecture decisions and rationale** — why you chose that database, why the auth works that way, why you split that service
- **Coding conventions and patterns** — how you structure components, naming rules, error handling patterns, test conventions
- **API documentation** — internal APIs, external integrations, authentication flows
- **Debugging playbooks** — "when X happens, check Y" knowledge that's hard to capture in code comments
- **Meeting notes and decisions** — the context behind the code, not just the code itself
- **Project roadmaps** — what's planned, what's in progress, what's blocked and why

The key insight: anything you'd explain verbally to a new team member belongs in your knowledge base. Your coding agent is a new team member every single session.

## Security

Giving an AI agent access to your knowledge base requires trust in the access model:

- **Drive-scoped tokens** — each MCP token is scoped to a single drive. Your agent sees only what you explicitly share
- **Audit logging** — every read and write through MCP is logged
- **Fail-closed permissions** — if the token doesn't grant access, the request is denied. No fallbacks, no defaults

You control the boundary. The agent works within it.

## Getting Started

1. Create a PageSpace account and set up a drive for your project knowledge
2. Add your architecture docs, conventions, and patterns as pages
3. Create page agents with instructions tailored to your workflow
4. Generate an MCP token and add the config to your coding agent
5. Start a session and ask your agent to check the knowledge base

Your coding agent just got a memory. Use it.
    `,
    author: "Jono",
    date: "2026-02-17",
    readTime: "8 min read",
    category: "Guide",
  },
};
