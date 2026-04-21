import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI Tool Calling",
  description: "Reference for PageSpace AI tools: 37 workspace automation tools covering pages, drives, search, tasks, channels, calendar, and agent coordination.",
  path: "/docs/ai/tool-calling",
  keywords: ["AI tools", "tool calling", "function calling", "workspace automation"],
});

const content = `
# Tool Calling

PageSpace AI agents expose 37 workspace tools. Tools are the only way an agent reads, writes, or searches content — nothing happens inside the model alone. Source: \`apps/web/src/lib/ai/tools/*.ts\`.

## Tool catalog

### Page reads

| Tool | Description |
|---|---|
| \`list_pages\` | Walk a drive's page tree. |
| \`read_page\` | Read a page's content and metadata. |
| \`list_trash\` | List trashed pages in a drive. |
| \`list_conversations\` | List AI_CHAT conversations on a page. |
| \`read_conversation\` | Read a single AI_CHAT conversation. |

### Page writes

| Tool | Description |
|---|---|
| \`create_page\` | Create a page of any non-experimental type: FOLDER, DOCUMENT, CHANNEL, AI_CHAT, CANVAS, FILE, SHEET, TASK_LIST, CODE. |
| \`rename_page\` | Rename a page. |
| \`move_page\` | Reparent and reorder. |
| \`replace_lines\` | Replace a line range in a DOCUMENT. Empty \`content\` deletes lines. |
| \`edit_sheet_cells\` | Write cells on a SHEET page. |
| \`trash\` | Move a page or drive to trash. Supports \`withChildren\`. |
| \`restore\` | Restore a page or drive from trash. |

### Drives

| Tool | Description |
|---|---|
| \`list_drives\` | List drives the user can access. |
| \`create_drive\` | Create a new workspace. |
| \`rename_drive\` | Rename a workspace. |
| \`update_drive_context\` | Edit the drive-level AI prompt. |

### Search

| Tool | Description |
|---|---|
| \`regex_search\` | Regex content search, scoped to a drive and optional page types. |
| \`glob_search\` | Glob search by page title (e.g. \`**/README*\`). |
| \`multi_drive_search\` | Search across every accessible drive. |
| \`web_search\` | External web search. Only present when the agent's **Web search** toggle is on. |

### Tasks

| Tool | Description |
|---|---|
| \`update_task\` | Create or update a task on a TASK_LIST page. |
| \`get_assigned_tasks\` | List tasks assigned to the caller. |

### Channels

| Tool | Description |
|---|---|
| \`send_channel_message\` | Post to a CHANNEL page. |

### Calendar (read)

| Tool | Description |
|---|---|
| \`list_calendar_events\` | List events in a time range. |
| \`get_calendar_event\` | Fetch a single event. |
| \`check_calendar_availability\` | Free/busy check. |

### Calendar (write)

| Tool | Description |
|---|---|
| \`create_calendar_event\` | Create an event. |
| \`update_calendar_event\` | Edit an event. |
| \`delete_calendar_event\` | Delete an event. |
| \`rsvp_calendar_event\` | Respond to an invite. |
| \`invite_calendar_attendees\` | Add attendees. |
| \`remove_calendar_attendee\` | Remove an attendee. |

### Agents

| Tool | Description |
|---|---|
| \`list_agents\` | Discover AI_CHAT agents inside one drive. |
| \`multi_drive_list_agents\` | Discover agents across every drive the user can see. |
| \`ask_agent\` | Consult another agent, optionally continuing an existing conversation. |
| \`update_agent_config\` | Update another agent's system prompt, tools, provider, or model. |

### Activity

| Tool | Description |
|---|---|
| \`get_activity\` | Query the activity log with time windows, page types, and deltas. |

A special \`finish\` signal tool lives alongside these — the model calls it to end a turn. It isn't selectable in the UI.

## Permission enforcement

Every tool validates the caller's access before running:

\`\`\`typescript
const canView = await canUserViewPage(userId, pageId);   // reads
const canEdit = await canUserEditPage(userId, pageId);   // writes
const canDelete = await canUserDeletePage(userId, pageId); // trash/delete
\`\`\`

Tools cannot bypass the permission system. If a user can't see a page, the agent acting on their behalf can't either.

## Execution context

Every tool receives an \`experimental_context\` object with everything it needs to act contextually:

\`\`\`typescript
{
  userId: "user-123",
  timezone: "America/New_York",
  aiProvider: "anthropic",
  aiModel: "claude-sonnet-4-6-20260217",
  conversationId: "conv-789",
  locationContext: {
    currentPage: { id: "page-456", title: "Project AI", type: "AI_CHAT", path: "/marketing/ai" },
    currentDrive: { id: "drive-789", name: "Marketing", slug: "marketing" },
    breadcrumbs: ["Marketing", "AI"],
  },
  modelCapabilities: { hasVision: true, hasTools: true },
  chatSource: { type: "page", agentPageId: "page-456", agentTitle: "Project AI" },
  // Present when invoked from ask_agent:
  agentCallDepth: 0,
  agentChain: [],
  requestOrigin: "user",
}
\`\`\`

Source: \`apps/web/src/lib/ai/core/types.ts\`, \`apps/web/src/app/api/ai/chat/route.ts\`.

## Multi-step turns

Tool calls chain up to **100 steps** per turn. The model keeps calling tools until it either calls \`finish\` or hits the step cap. Source: \`stepCountIs(100)\` in \`apps/web/src/app/api/ai/chat/route.ts\`.

\`\`\`
User: "Set up a new project called Q2 Campaign"

AI:
1. create_page(type: "FOLDER", title: "Q2 Campaign")
2. create_page(type: "DOCUMENT", title: "Brief", parentId: folder)
3. create_page(type: "TASK_LIST", title: "Milestones", parentId: folder)
4. create_page(type: "CHANNEL", title: "Team Chat", parentId: folder)
5. create_page(type: "AI_CHAT", title: "Campaign AI", parentId: folder)
6. update_agent_config(agentId: <new>, systemPrompt: "…")
7. update_task(pageId: milestones, title: "Define target audience", priority: "high")
8. update_task(pageId: milestones, title: "Create content calendar")
9. finish()
\`\`\`

## Read-only and web-search filters

Two page-level toggles decide which tools are actually available at runtime:

- **Read-only mode** (\`isReadOnly: true\`) — every write tool is stripped: \`create_page\`, \`rename_page\`, \`replace_lines\`, \`move_page\`, \`edit_sheet_cells\`, \`create_drive\`, \`rename_drive\`, \`update_drive_context\`, \`trash\`, \`restore\`, \`update_agent_config\`, \`update_task\`, \`send_channel_message\`, and all calendar writes.
- **Web search enabled** (\`webSearchEnabled: true\`) — controls whether \`web_search\` is exposed. Default is off.

Source: \`apps/web/src/lib/ai/core/tool-filtering.ts\`.

## Per-agent tool sets

AI_CHAT pages pin an \`enabledTools\` array. Behaviour:

| \`enabledTools\` | Tools available |
|---|---|
| \`null\` | None. Agent chats but cannot act. |
| \`[]\` | None. Agent chats but cannot act. |
| \`["read_page", "regex_search"]\` | Exactly those, further filtered by read-only and web-search toggles. |

Source: \`apps/web/src/app/api/ai/chat/route.ts\` (line comment: "null or [] = no tools enabled"). This differs from historical docs — an empty array is not a wildcard.

\`\`\`typescript
// Content editor
enabledTools: ["read_page", "replace_lines"]

// Research analyst
enabledTools: ["read_page", "regex_search", "glob_search", "multi_drive_search"]

// Project manager
enabledTools: ["create_page", "read_page", "update_task", "list_pages", "ask_agent"]
\`\`\`

## Examples

### Reading and editing

\`\`\`typescript
read_page({ pageId: "page-123" })
// → { title, type, content, wordCount, path, ... }

replace_lines({
  pageId: "page-123",
  startLine: 5,
  endLine: 7,
  content: "Updated content for lines 5-7"
})
\`\`\`

### Searching

\`\`\`typescript
regex_search({
  driveId: "drive-789",
  pattern: "\\\\b\\\\d{4}-\\\\d{2}-\\\\d{2}\\\\b",
  pageTypes: ["DOCUMENT"],
  maxResults: 50
})

glob_search({ driveId: "drive-789", pattern: "**/README*" })

multi_drive_search({
  query: "marketing campaign",
  searchType: "content",
  includeSnippets: true
})
\`\`\`

### Consulting another agent

\`\`\`typescript
ask_agent({
  agentId: "page-ai-finance-456",
  agentPath: "/finance/Budget Analyst",
  question: "What's our Q4 budget status?",
  context: "Preparing board presentation",
  // Omit to start a new conversation; pass to continue one.
  conversationId: undefined
})
\`\`\`

## Errors and retries

Tool errors are returned as structured results — the model sees them and adapts, rather than the turn ending.

- **Permission denied** — the agent surfaces the required permission to the user.
- **Not found** — the agent tries a different id or suggests alternatives.
- **Rate limit / transient provider error** — the streamText call retries up to 20 times before failing. Source: \`maxRetries: 20\` in \`apps/web/src/app/api/ai/chat/route.ts\`.
- **Sub-agent calls** (\`ask_agent\`) retry up to 3 times and are capped at 20 internal steps.

## Agent depth

\`ask_agent\` increments a depth counter on the execution context. When the counter reaches **2**, further calls throw. The cap prevents runaway chains of agents calling agents. Source: \`MAX_AGENT_DEPTH\` in \`apps/web/src/lib/ai/tools/agent-communication-tools.ts\`.

## Real-time broadcasting

Content-mutating tools emit Socket.IO events so every connected client updates without refresh: page created/renamed/moved, content edited, task updated, channel message sent. Broadcast happens after the DB write succeeds.

## Observability

Tool invocations are logged with provider, model, tool name, duration, success/failure, and conversation context. Activity-modifying tools (creates, edits, deletes) also emit activity-log entries attributed to the calling user — and, when via \`ask_agent\`, to the chain of agents that made the call.
`;

export default function ToolCallingPage() {
  return <DocsMarkdown content={content} />;
}
