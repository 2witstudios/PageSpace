import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI Agents",
  description: "Configure AI agents in PageSpace: system prompts, tool sets, read-only and web-search toggles, context inheritance, and agent-to-agent consultation.",
  path: "/docs/ai/agents",
  keywords: ["AI agents", "custom agents", "system prompts", "agent communication", "ask_agent"],
});

const content = `
# Agents

An agent is an AI_CHAT page with a custom configuration. Each agent is a specialized assistant: its own system prompt, tool set, provider, model, and toggles — all scoped to the page's place in the drive tree.

## Creating an agent

1. Create an AI_CHAT page: right-click in the sidebar → **New AI Chat**, or use the API (below).
2. Open the page's settings panel.
3. Configure the fields below.

| Setting | Effect |
|---|---|
| System Prompt | Custom instructions on behavior, expertise, and output format. |
| Enabled Tools | Array of tool names the agent may call. See below. |
| Read-only mode | Strips every write tool (create / edit / delete / send). |
| Web search enabled | Adds \`web_search\` to the tool set. Off by default. |
| AI Provider | Overrides the drive / user default for this page. |
| AI Model | Overrides the drive / user default for this page. |
| Include drive prompt | Prepends the drive's AI context to the system prompt. |
| Include page tree | Injects a tree snapshot of the page's children or drive. |

### Via API

\`\`\`typescript
// Step 1: create the AI_CHAT page
POST /api/pages
{
  "driveId": "drive-123",
  "title": "Research Assistant",
  "type": "AI_CHAT",
  "parentId": "project-folder-id"
}

// Step 2: configure the agent
PATCH /api/pages/{pageId}/agent-config
{
  "systemPrompt": "You are a research assistant specializing in market analysis. Always cite sources and provide data-driven insights.",
  "enabledTools": ["read_page", "regex_search", "glob_search", "multi_drive_search"],
  "aiProvider": "anthropic",
  "aiModel": "claude-sonnet-4-6-20260217"
}
\`\`\`

## Read-only mode and web search

PageSpace runs one unified system prompt for every agent. Two runtime toggles on the page decide what that agent can actually do.

- **Read-only** — appends a READ-ONLY constraint to the system prompt and strips every write tool. Use for research, planning, and analysis agents that must not touch content.
- **Web search** — adds \`web_search\`. Off by default so agents stay inside the workspace unless you opt in.

\`\`\`typescript
// Analysis agent: cannot modify anything
isReadOnly: true
webSearchEnabled: false
enabledTools: ["list_pages", "read_page", "regex_search", "glob_search", "multi_drive_search"]

// Research agent that also hits the web
isReadOnly: true
webSearchEnabled: true
enabledTools: ["list_pages", "read_page", "multi_drive_search", "web_search"]

// Full-authority project agent
isReadOnly: false
webSearchEnabled: false
enabledTools: ["list_pages", "read_page", "create_page", "rename_page", "move_page", "replace_lines", "update_task", "ask_agent"]
\`\`\`

## enabledTools is an allow-list

| \`enabledTools\` | Tools available at runtime |
|---|---|
| \`null\` | None — agent chats but cannot act. |
| \`[]\` | None — same as \`null\`. |
| \`["tool_a", "tool_b"]\` | Exactly those, then filtered by read-only and web-search toggles. |

Empty means empty. To give an agent everything, list every tool explicitly.

The 37 tool names live in [Tool Calling](/docs/ai/tool-calling).

## Context inheritance

An agent sees the same page tree its caller sees. Position in the tree decides default scope:

\`\`\`
📁 Website Redesign/
├── 📄 Brand Guidelines
├── 📄 User Research
├── 📁 UI Components/
│   ├── 📄 Button Spec
│   └── 🤖 UI Design AI     ← scoped to UI Components, can reach parent docs via tools
└── 🤖 Project AI            ← scoped to Website Redesign
\`\`\`

Every tool call carries \`locationContext\` with the current drive, current page, and breadcrumbs. When the user says "here", the agent resolves it against this context instead of guessing.

Optional flags expand the context further:

- \`includeDrivePrompt: true\` — prepend the drive's AI prompt to the agent's system prompt.
- \`includePageTree: true\` with \`pageTreeScope: "children"\` or \`"drive"\` — inject a tree snapshot of the relevant subtree.

## Agent-to-agent consultation

An agent can call another agent with \`ask_agent\`:

\`\`\`typescript
ask_agent({
  agentId: "page-ai-finance-456",
  agentPath: "/finance/Budget Analyst",
  question: "What's our Q4 budget for marketing campaigns?",
  context: "Planning new social media campaign",
  conversationId: undefined  // omit to start fresh, pass to continue
})
\`\`\`

What happens, in order:

1. Target agent is verified — must be AI_CHAT, not trashed, and visible to the calling user.
2. If a \`conversationId\` is passed, the persisted history is loaded; otherwise a new conversation is started.
3. The target agent runs with its own system prompt, provider, model, and \`enabledTools\` — but uses the caller's permissions.
4. The user's question and the assistant's response are persisted under the target page.
5. The response, the new or reused \`conversationId\`, and metadata (provider, model, call depth, tool-call count) return to the caller.

### Depth limit

Chain depth is tracked on the execution context and capped to prevent runaway agent-calling-agent loops.

### Discovering agents

\`\`\`typescript
list_agents({ driveId: "drive-123" })

multi_drive_list_agents({
  groupByDrive: true,
  includeTools: true
})
\`\`\`

By default an agent is visible to the global assistant; flip \`visibleToGlobalAssistant: false\` on a page to hide it from cross-drive discovery.

## Multi-user conversations

AI_CHAT pages support multiple users at once.

- User A sends a message → persisted, then broadcast to every connected user on the page.
- Assistant response streams over the real-time channel to all viewers.
- Every user message is attributed to its sender; assistant messages are unattributed.
- The agent sees the entire multi-user thread as it composes each reply.

## Best practices

1. **Be specific in system prompts.** Domain knowledge, response format, and constraints all belong here.
2. **Prefer smaller tool sets.** A research agent doesn't need \`create_page\` or \`trash\`. Fewer tools means fewer ways to go wrong and a smaller effective prompt.
3. **Place agents where their context lives.** An agent in a project folder automatically sees that project.
4. **Specialize.** Multiple focused agents, coordinated via \`ask_agent\`, beat one monolithic agent.
5. **Match model to task.** Use larger reasoning models for planning and synthesis; lean on fast / cheap models for straightforward edits.
`;

export default function AgentsPage() {
  return <DocsMarkdown content={content} />;
}
