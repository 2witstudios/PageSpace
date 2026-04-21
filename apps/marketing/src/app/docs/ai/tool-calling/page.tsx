import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI Tool Calling",
  description: "Complete reference for PageSpace AI tools: 13+ workspace automation tools for page operations, content editing, search, task management, and agent collaboration.",
  path: "/docs/ai/tool-calling",
  keywords: ["AI tools", "tool calling", "function calling", "workspace automation"],
});

const content = `
# Tool Calling

PageSpace AI agents have access to 13+ workspace automation tools. Tools let AI read, create, edit, search, and organize content across your entire workspace while respecting permissions.

## Tool Categories

### Core Page Operations

| Tool | Permission | Description |
|------|-----------|-------------|
| \`list_drives\` | Read | List all accessible workspaces |
| \`list_pages\` | Read | Navigate page hierarchies with tree structure |
| \`read_page\` | Read | Read page content with metadata |
| \`create_page\` | Write | Create pages of any type (DOCUMENT, FOLDER, AI_CHAT, CHANNEL, CANVAS, SHEET, TASK_LIST, CODE) |
| \`rename_page\` | Edit | Update page titles |
| \`move_page\` | Edit | Reorganize page hierarchy and ordering |

### Content Editing

| Tool | Permission | Description |
|------|-----------|-------------|
| \`replace_lines\` | Edit | Replace specific line ranges in documents. Use empty content to delete lines. |

### Trash Operations

| Tool | Permission | Description |
|------|-----------|-------------|
| \`trash\` | Delete | Move pages or drives to trash. Supports \`withChildren\` for recursive delete. |
| \`restore\` | Edit | Restore pages or drives from trash |

### Search & Discovery

| Tool | Permission | Description |
|------|-----------|-------------|
| \`regex_search\` | Read | Search content with regex patterns across drives |
| \`glob_search\` | Read | Find pages by name patterns (e.g., \`**/README*\`) |
| \`multi_drive_search\` | Read | Search across all accessible drives simultaneously |

### Task Management

| Tool | Permission | Description |
|------|-----------|-------------|
| \`update_task\` | Edit | Add or update tasks on TASK_LIST pages. Each task creates a linked DOCUMENT page. |

### Agent Management

| Tool | Permission | Description |
|------|-----------|-------------|
| \`list_agents\` | Read | Discover AI agents within a specific drive |
| \`multi_drive_list_agents\` | Read | Discover agents across all accessible drives |
| \`ask_agent\` | Read | Consult another agent for specialized expertise |
| \`update_agent_config\` | Edit | Modify agent system prompt, tools, and model |

## Tool Execution

### Permission Validation

Every tool execution validates the user's permissions before proceeding:

\`\`\`typescript
// Read operations check view permission
const canView = await canUserViewPage(userId, pageId);

// Write operations check edit permission
const canEdit = await canUserEditPage(userId, pageId);

// Delete operations check delete permission
const canDelete = await canUserDeletePage(userId, pageId);
\`\`\`

Tools cannot bypass the permission system. If a user doesn't have access to a page, the AI can't access it either.

### Execution Context

Each tool receives rich context for intelligent behavior:

\`\`\`typescript
{
  userId: "user-123",
  modelCapabilities: {
    hasVision: true,
    hasTools: true,
    model: "claude-sonnet-4-20250514",
    provider: "anthropic"
  },
  locationContext: {
    currentPage: { id: "page-456", title: "Project AI", type: "AI_CHAT" },
    driveId: "drive-789",
    driveName: "Marketing"
  }
}
\`\`\`

### Multi-Step Operations

AI agents can chain up to **100 tool calls** per conversation turn, enabling complex workflows:

\`\`\`
User: "Set up a new project called Q2 Campaign"

AI executes:
1. create_page(type: FOLDER, title: "Q2 Campaign")
2. create_page(type: DOCUMENT, title: "Brief", parentId: folder)
3. create_page(type: TASK_LIST, title: "Milestones", parentId: folder)
4. create_page(type: CHANNEL, title: "Team Chat", parentId: folder)
5. create_page(type: AI_CHAT, title: "Campaign AI", parentId: folder)
6. update_agent_config(systemPrompt: "Marketing specialist...")
7. update_task(title: "Define target audience", priority: "high")
8. update_task(title: "Create content calendar", priority: "medium")
\`\`\`

## Role-Based Tool Filtering

Tools are filtered based on the agent's role:

### PARTNER (Full Capabilities)

All tools enabled. Used for collaborative AI partners that need full workspace access.

### PLANNER (Read-Only)

Only read-based tools: \`list_drives\`, \`list_pages\`, \`read_page\`, \`regex_search\`, \`glob_search\`, \`multi_drive_search\`, \`list_agents\`, \`multi_drive_list_agents\`.

### WRITER (Execution-Focused)

Write and read tools, excluding agent management. Optimized for content creation and editing.

### Custom Tool Sets

Individual AI pages can specify exactly which tools are available:

\`\`\`typescript
// Content-focused agent
enabledTools: ["read_page", "create_page", "replace_lines"]

// Analysis-focused agent
enabledTools: ["read_page", "regex_search", "glob_search", "multi_drive_search"]

// Project management agent
enabledTools: ["create_page", "read_page", "update_task", "ask_agent"]
\`\`\`

## Tool Examples

### Reading and Editing Content

\`\`\`typescript
// Read a document
read_page({ pageId: "page-123" })
// Returns: { title, type, content, wordCount, path, ... }

// Edit specific lines
replace_lines({
  pageId: "page-123",
  startLine: 5,
  endLine: 7,
  content: "Updated content for lines 5-7"
})
\`\`\`

### Searching Across Workspace

\`\`\`typescript
// Find all documents containing dates
regex_search({
  pattern: "\\\\b\\\\d{4}-\\\\d{2}-\\\\d{2}\\\\b",
  pageTypes: ["DOCUMENT"],
  maxResults: 50
})

// Find all README files
glob_search({ pattern: "**/README*" })

// Search across all drives
multi_drive_search({
  query: "marketing campaign",
  searchType: "content",
  includeSnippets: true
})
\`\`\`

### Agent Collaboration

\`\`\`typescript
// Consult a specialized agent
ask_agent({
  agentId: "page-ai-456",
  agentPath: "/finance/Budget Analyst",
  question: "What's our Q4 budget status?",
  context: "Preparing board presentation"
})
\`\`\`

## Error Handling

Tool errors are captured and reported back to the AI, which can retry or adjust its approach:

- **Permission denied**: AI explains the permission requirement to the user
- **Page not found**: AI suggests alternative actions
- **Rate limited**: Built-in retry with up to 3 retries for rate limit errors
- **Validation errors**: AI adjusts parameters and retries

## Real-Time Broadcasting

When tools modify workspace content, changes are broadcast via Socket.IO to all connected users:

- Page created → sidebar updates for all users
- Content edited → document refreshes for collaborators
- Task updated → task list updates across all views

## Monitoring

All tool usage is tracked for analytics:

- Tool name, execution time, success/failure
- Provider and model used
- Conversation and page context
- Feature usage patterns
`;

export default function ToolCallingPage() {
  return <DocsMarkdown content={content} />;
}
