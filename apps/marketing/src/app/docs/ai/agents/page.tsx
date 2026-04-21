import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI Agents",
  description: "Create custom AI agents in PageSpace with system prompts, tool configuration, agent roles, and agent-to-agent communication.",
  path: "/docs/ai/agents",
  keywords: ["AI agents", "custom agents", "system prompts", "agent communication", "ask_agent"],
});

const content = `
# Agents

AI agents in PageSpace are \`AI_CHAT\` pages with custom configuration. Each agent has its own system prompt, tool set, model, and role — turning it into a specialized assistant for a specific domain.

## Creating an Agent

1. Create an \`AI_CHAT\` page (right-click > New AI Chat, or via the API)
2. Open the agent's settings panel
3. Configure:

| Setting | Description |
|---------|-------------|
| System Prompt | Custom instructions that define the agent's behavior and expertise |
| Enabled Tools | Which of the 13+ workspace tools this agent can use |
| AI Provider | Which provider powers this agent (overrides drive/user default) |
| AI Model | Which model to use (overrides drive/user default) |
| Agent Role | PARTNER, PLANNER, or WRITER |

### Via API

\`\`\`typescript
// Step 1: Create the AI_CHAT page
POST /api/pages
{
  "driveId": "drive-123",
  "title": "Research Assistant",
  "type": "AI_CHAT",
  "parentId": "project-folder-id"
}

// Step 2: Configure the agent
PATCH /api/pages/{pageId}/agent-config
{
  "systemPrompt": "You are a research assistant specializing in market analysis. Always cite sources and provide data-driven insights.",
  "enabledTools": ["read_page", "regex_search", "glob_search", "multi_drive_search"],
  "aiProvider": "anthropic",
  "aiModel": "claude-sonnet-4-20250514"
}
\`\`\`

## Agent Roles

Three built-in roles define the agent's baseline capabilities:

### PARTNER

The default role. Full read/write/delete capabilities with balanced conversation style.

- All tools available
- Creates, edits, and organizes content
- Best for: General-purpose AI assistants

### PLANNER

Read-only strategic planning role. Cannot modify workspace content.

- Read and search tools only
- Analyzes, plans, and recommends
- Best for: Strategy, analysis, planning without accidental modifications

### WRITER

Execution-focused role with minimal conversation. Writes and creates efficiently.

- Read, write, create, update, delete tools
- Concise responses, focuses on output
- Best for: Content generation, batch operations, automated workflows

## Context Inheritance

Agents understand their position in the workspace hierarchy:

\`\`\`
📁 Website Redesign/
├── 📄 Brand Guidelines
├── 📄 User Research
├── 📁 UI Components/
│   ├── 📄 Button Spec
│   └── 🤖 UI Design AI     ← Knows about UI Components, can reference parent docs
└── 🤖 Project AI            ← Knows about entire project
\`\`\`

- **Project AI** sees all documents in the Website Redesign folder
- **UI Design AI** has focused context on UI Components and can reference parent-level documents

No configuration is needed — context is automatic based on the page's position in the tree.

## Agent-to-Agent Communication

The \`ask_agent\` tool enables agents to consult each other:

\`\`\`typescript
// Marketing AI asks the Finance AI about budget
ask_agent({
  agentId: "page-ai-finance-456",
  agentPath: "/finance/Budget Analyst",
  question: "What's our Q4 budget for marketing campaigns?",
  context: "Planning new social media campaign"
})
\`\`\`

### How It Works

1. Agent A calls \`ask_agent\` with a question and target agent
2. PageSpace loads the target agent's conversation history and system prompt
3. The question is sent to the target agent's configured model
4. The response is returned to Agent A, which incorporates it into its own response

### Depth Control

Agent communication includes depth tracking to prevent infinite loops:

- Maximum depth: **2 levels** (Agent A → Agent B)
- Each nested call increments a depth counter
- Exceeding the limit returns an error instead of making another call

### Multi-Agent Discovery

Agents can discover other agents across the workspace:

\`\`\`typescript
// Find all agents in a specific drive
list_agents({ driveId: "drive-123" })

// Find all agents across all accessible drives
multi_drive_list_agents({
  groupByDrive: true,
  includeTools: true
})
\`\`\`

## Custom Tool Sets

Beyond role-based filtering, you can specify exactly which tools an agent can use:

\`\`\`typescript
// Content editor — only reads and edits
enabledTools: ["read_page", "replace_lines"]

// Research analyst — only searches
enabledTools: ["read_page", "regex_search", "glob_search", "multi_drive_search"]

// Project manager — creates and manages tasks
enabledTools: ["create_page", "read_page", "update_task", "list_pages", "ask_agent"]

// Full autonomy — all tools
enabledTools: [] // Empty = use role-based defaults (all tools for PARTNER)
\`\`\`

## Multi-User Conversations

AI agent conversations support multiple users simultaneously:

- **User A** sends a message → saved to database → broadcast to all users
- **AI responds** → response visible to both users in real-time
- **User B** can continue the conversation
- All messages are attributed to their sender
- The AI sees the complete multi-user context

This makes agents effective for team collaboration, not just individual use.

## Best Practices

1. **Specific system prompts**: The more specific your prompt, the better the agent performs. Include domain knowledge, preferred response format, and constraints.

2. **Minimal tool sets**: Give agents only the tools they need. A research agent doesn't need \`create_page\` or \`trash\`.

3. **Hierarchical placement**: Place agents near the content they need. An agent in a project folder automatically understands that project.

4. **Agent specialization**: Create multiple focused agents rather than one general-purpose agent. Use \`ask_agent\` for cross-domain questions.

5. **Model matching**: Use powerful models (Claude Opus, GPT-5) for complex reasoning tasks and faster models (Gemini Flash, GPT-4.1 mini) for simple tasks.
`;

export default function AgentsPage() {
  return <DocsMarkdown content={content} />;
}
