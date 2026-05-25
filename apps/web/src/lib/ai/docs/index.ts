export const TOOL_DOC_CATEGORIES = [
  'pages',
  'task-lists',
  'sheets',
  'calendar',
  'agents',
  'channels',
  'drives',
] as const;

export type ToolDocCategory = typeof TOOL_DOC_CATEGORIES[number];

const DOCS: Record<ToolDocCategory, string> = {
  pages: `# Pages — PageSpace Tool Guide

## Concept & Mental Model

A **page** is the universal content unit in PageSpace. Every piece of content — documents, sheets, task lists, agent chats, channels, files — is a page. Pages form a tree inside a drive using parent-child relationships. You navigate the tree with list_pages, create nodes with create_page, and restructure with move_page.

## Page Types

| Type | Use for |
|------|---------|
| DOCUMENT | Rich text notes, wikis, plans, reports |
| FOLDER | Structural container — no content, just children |
| SHEET | Spreadsheet data (A1-addressed cells) |
| TASK_LIST | Ordered list of tasks with statuses and assignees |
| CHANNEL | Persistent chat / broadcast log |
| AI_CHAT | AI agent with its own system prompt and tool grants |
| FILE | Binary upload (PDF, image, etc.) |
| CANVAS | Visual whiteboard |
| CODE | Code file with syntax highlighting |

## Common Workflows

**Create a folder hierarchy:**
1. create_page with type=FOLDER, title="Projects"
2. create_page with type=FOLDER, title="Project Alpha", parentId=<Projects page ID>
3. create_page with type=DOCUMENT, title="Brief", parentId=<Project Alpha page ID>

**Typical agent workspace layout:**
\`\`\`
Research/ (FOLDER)
  Findings (DOCUMENT)
  Raw Sources/ (FOLDER)
Outputs/ (FOLDER)
  Draft Report (DOCUMENT)
Review Queue (TASK_LIST)
Team Updates (CHANNEL)
\`\`\`

**Read a page's content:**
- Use read_page with the pageId. The response includes type, title, content, and for TASK_LIST pages also availableStatuses and tasks.

**Find pages by pattern:**
- glob_search for path patterns (e.g., "*/Reports/*")
- regex_search for content (e.g., search inside documents)

## Composition Patterns

- Create a TASK_LIST sibling to a DOCUMENT when work needs tracking
- Use a CHANNEL inside a drive for team updates from agents
- Nest FOLDER → FOLDER → TASK_LIST for multi-phase project organization
- Link a FILE page to reference documents in a DOCUMENT using its pageId

## Common Mistakes

- Creating a page without a driveId — always required
- Trying to write content to a FOLDER — folders have no content
- Using move_page with a parentId that's in a different drive — cross-drive moves are not supported
- Treating TASK_LIST page content as editable text — task data is structured; use update_task, not replace_lines
`,

  'task-lists': `# Task Lists — PageSpace Tool Guide

## Concept & Mental Model

A **TASK_LIST** page contains structured tasks, each with a status, priority, due date, and assignees. Tasks are not nested within themselves — instead, organize multi-phase work by grouping multiple TASK_LIST pages inside a FOLDER.

**Critical first step:** Before adding or updating tasks, always call read_page on the TASK_LIST to get:
- The page's own \`id\` — this is the \`pageId\` to pass to update_task when creating tasks
- \`availableStatuses\` — the valid status slugs for this list
- Existing tasks and their IDs

## Status Group System

Statuses belong to one of three **groups**:

| Group | Meaning | Default statuses in group |
|-------|---------|--------------------------|
| todo | Not started | pending |
| in_progress | Active work | in_progress, blocked |
| done | Complete | completed |

When filtering tasks, use the group (active/completed) not individual status slugs. When creating or updating a task, use the **slug** (e.g., "pending", "blocked"), not the display name.

## Data Model

\`\`\`
Task:
  id           — use as taskId when calling update_task to update or delete
  title        — display name (lives on linked DOCUMENT page)
  status       — slug from availableStatuses (e.g., "pending", "in_progress")
  priority     — "low" | "medium" | "high"
  dueDate      — ISO timestamp
  assigneeId   — user ID (human assignee)
  assigneeAgentId — agent page ID (AI assignee)
  position     — integer, lower = higher in list
\`\`\`

## Common Workflows

**Add a task to a task list:**
1. read_page on the TASK_LIST page → note the page \`id\` and \`availableStatuses\`
2. execute_tool("update_task", { pageId: "<TASK_LIST page id>", title: "...", status: "pending", priority: "medium" })

**Mark a task complete:**
execute_tool("update_task", { taskId: "<task id>", status: "completed" })

**Add a custom status before using it:**
execute_tool("create_task_status", { pageId: "<TASK_LIST page id>", name: "In Review", group: "in_progress" })
→ returns the new slug (e.g., "in_review") to use in subsequent update_task calls

**Build a multi-phase project:**
\`\`\`
Phase 1/ (FOLDER)
  Research Tasks (TASK_LIST)   ← statuses: todo / in_progress / done
  Design Tasks (TASK_LIST)
Phase 2/ (FOLDER)
  Development Tasks (TASK_LIST)
  QA Tasks (TASK_LIST)
\`\`\`

**Get tasks assigned to the current agent:**
execute_tool("get_assigned_tasks") — returns tasks where the agent is the assignee.

## Composition Patterns

- Assign tasks to an AI_CHAT agent using assigneeAgentId to route work automatically
- Use a CHANNEL sibling to the TASK_LIST for status updates ("Task X moved to in_progress")
- Create a DOCUMENT for the task's detailed spec, then link via a task's description

## Common Mistakes

- Using a status slug that's not in availableStatuses — always read_page first to confirm valid slugs
- Trying to create subtasks inside a task — not supported; use nested TASK_LIST pages in a FOLDER instead
- Passing taskListId instead of pageId when creating a task — update_task takes pageId (the TASK_LIST page's own ID), not the internal taskListId
- Passing a group name ("active") as a status slug — statuses are slugs like "in_progress", not group names
`,

  sheets: `# Sheets — PageSpace Tool Guide

## Concept & Mental Model

A **SHEET** page is a spreadsheet with cells addressed in A1 notation. Columns are letters (A, B, C... Z, AA, AB...) and rows are numbers starting at 1. The sheet expands automatically — writing to a new address extends its bounds.

## A1 Cell Addressing

| Address | Meaning |
|---------|---------|
| A1 | Column A, Row 1 (top-left) |
| B3 | Column B, Row 3 |
| Z10 | Column Z, Row 10 |
| AA1 | Column 27, Row 1 |
| AB5 | Column 28, Row 5 |

**Column letter logic:** A=1, B=2, ... Z=26, AA=27, AB=28, ... AZ=52, BA=53, etc.

## Using edit_sheet_cells

\`\`\`
execute_tool("edit_sheet_cells", {
  pageId: "<sheet page ID>",
  cells: [
    { address: "A1", value: "Name" },
    { address: "B1", value: "Score" },
    { address: "A2", value: "Alice" },
    { address: "B2", value: "95" },
    { address: "B3", value: "=SUM(B2:B2)" }
  ]
})
\`\`\`

**To clear a cell:** pass value as empty string \`""\`

**To write a formula:** start value with \`=\` (e.g., \`"=AVERAGE(B2:B10)"\`)

## Reading Sheet Content

Use read_page on the SHEET page. The response includes a \`cells\` object keyed by address:
\`\`\`
{ "A1": "Name", "B1": "Score", "A2": "Alice", "B2": "95" }
\`\`\`
Also returns \`rowCount\` and \`columnCount\` for the current sheet dimensions.

## Common Workflows

**Set up a header row:**
\`\`\`
cells: [
  { address: "A1", value: "Task" },
  { address: "B1", value: "Owner" },
  { address: "C1", value: "Due Date" },
  { address: "D1", value: "Status" }
]
\`\`\`

**Populate a data table starting at row 2:**
\`\`\`
cells: [
  { address: "A2", value: "Design mockups" },
  { address: "B2", value: "Alice" },
  { address: "C2", value: "2026-06-01" },
  { address: "D2", value: "In Progress" }
]
\`\`\`

**Add a totals row with a formula:**
\`\`\`
cells: [{ address: "B10", value: "=SUM(B2:B9)" }]
\`\`\`

## Common Mistakes

- Confusing row/column order — address is COLUMN then ROW (B3 = column B, row 3)
- Using numeric coordinates instead of A1 notation — the tool only accepts A1-style addresses
- Trying to write a range in one cell address — each cell is addressed individually
- Forgetting that formulas must start with \`=\` — without \`=\`, the value is treated as plain text
- Reading a SHEET with read_page and trying to use replace_lines to edit it — always use edit_sheet_cells for sheets
`,

  calendar: `# Calendar — PageSpace Tool Guide

## Concept & Mental Model

Calendar events live in a **drive** (visible to drive members) or as **personal** events (only creator sees). Events can be one-time or recurring. Attendees are invited and RSVP separately. All times require an explicit timezone.

## Event Visibility

| Visibility | Who sees it |
|-----------|------------|
| DRIVE | All members of the drive |
| ATTENDEES_ONLY | Only invited attendees |
| PRIVATE | Only the creator |

## Recurrence Rule Structure

\`\`\`json
{
  "frequency": "WEEKLY",
  "interval": 1,
  "byDay": ["MO", "WE", "FR"]
}
\`\`\`

| Field | Values | Meaning |
|-------|--------|---------|
| frequency | DAILY, WEEKLY, MONTHLY, YEARLY | Recurrence period |
| interval | integer | Every N periods |
| byDay | ["MO","TU","WE","TH","FR","SA","SU"] | Days of week (for WEEKLY) |
| byMonthDay | [1, 15] | Day of month (for MONTHLY) |
| count | integer | Stop after N occurrences |
| until | ISO date string | Stop on this date |

## Common Workflows

**Create a one-time event:**
\`\`\`
execute_tool("create_calendar_event", {
  driveId: "<drive ID>",
  title: "Team Standup",
  startAt: "2026-06-01T09:00:00",
  endAt: "2026-06-01T09:30:00",
  timezone: "America/New_York",
  visibility: "DRIVE"
})
\`\`\`

**Create a recurring weekly event:**
\`\`\`
execute_tool("create_calendar_event", {
  driveId: "<drive ID>",
  title: "Weekly Sync",
  startAt: "2026-06-02T14:00:00",
  endAt: "2026-06-02T14:30:00",
  timezone: "America/Los_Angeles",
  visibility: "DRIVE",
  recurrenceRule: { frequency: "WEEKLY", interval: 1, byDay: ["TU"] }
})
\`\`\`

**Check availability before scheduling:**
execute_tool("check_calendar_availability", { startAt: "...", endAt: "...", timezone: "..." })

**Add attendees after creating:**
execute_tool("invite_calendar_attendees", { eventId: "<id>", userIds: ["<user1>", "<user2>"] })

## Attendee RSVP States

PENDING (default) → ACCEPTED, DECLINED, or TENTATIVE

Use execute_tool("rsvp_calendar_event", { eventId, status: "ACCEPTED" }) to respond on behalf of the current user.

## Common Mistakes

- Omitting timezone — always pass an explicit timezone string (e.g., "America/New_York", "Europe/London", "UTC")
- Using PRIVATE visibility and then trying to invite attendees — PRIVATE events cannot have attendees
- Passing relative dates without converting to ISO format — always use ISO 8601 timestamps
- Modifying a recurring event's recurrenceRule on an instance — update the parent event to change recurrence for all instances
- Creating a personal event (no driveId) and expecting drive members to see it — personal events are private to the creator
`,

  agents: `# Agents — PageSpace Tool Guide

## Concept & Mental Model

An **agent** is an AI_CHAT page with a system prompt, model configuration, and a set of permitted tools. Agents can be invoked by users or by other agents via ask_agent. The global assistant discovers agents via list_agents and routes work to them.

## Key Configuration Fields

| Field | Purpose |
|-------|---------|
| systemPrompt | The agent's instructions and persona |
| aiModel | Model ID (e.g., "claude-opus-4-7", "gpt-4o") |
| aiProvider | Provider slug (e.g., "anthropic", "openai") |
| enabledTools | Array of integration/tool IDs this agent can use |
| agentDefinition | Description used by the global assistant to decide when to route to this agent |
| visibleToGlobalAssistant | If true, global assistant can discover and delegate to this agent |
| includeDrivePrompt | If true, the drive's shared context is prepended to the system prompt |
| includePageTree | If true, the drive or page tree is available in context |

## Common Workflows

**Create an agent:**
1. create_page with type=AI_CHAT, title="Research Agent", driveId=\`<drive>\`
2. execute_tool("update_agent_config", { pageId: "<new page ID>", systemPrompt: "You are a research assistant...", agentDefinition: "Use this agent to research topics and summarize findings", visibleToGlobalAssistant: true })

**Invoke an agent to do work:**
\`\`\`
execute_tool("ask_agent", {
  agentPageId: "<agent page ID>",
  prompt: "Research the top 5 competitors in the CRM market and write a summary in the Competitive Analysis document."
})
\`\`\`

**Discover available agents:**
execute_tool("list_agents", { driveId: "<drive ID>" }) — returns agents in a drive
execute_tool("multi_drive_list_agents") — returns agents across all drives

**Configure agent tools:**
Use execute_tool("update_agent_config", { pageId, enabledTools: ["github", "web_search"] })
Tool IDs come from the integrations system — use list_agents output or drive settings to see available IDs.

## Multi-Agent Composition Patterns

**Orchestrator → Worker pattern:**
1. Orchestrator (global assistant or another agent) calls ask_agent on a specialist
2. Specialist does focused work (e.g., research, writing, analysis)
3. Specialist writes results to a shared DOCUMENT or CHANNEL
4. Orchestrator reads the output and proceeds

**Agent pipeline:**
Research Agent → writes to DOCUMENT → Writing Agent reads it → produces final report → posts to CHANNEL

## Common Mistakes

- Creating an AI_CHAT page but not calling update_agent_config — the page exists but has no system prompt or tools
- Setting visibleToGlobalAssistant=true but no agentDefinition — the global assistant won't know when to use it
- Calling ask_agent without checking if the agent exists — use list_agents first to confirm the agent's pageId
- Giving an agent enabledTools that include write permissions in production without review — agents with write access can modify content
`,

  channels: `# Channels — PageSpace Tool Guide

## Concept & Mental Model

A **CHANNEL** page is a persistent, append-only message stream. Channels are ideal for team broadcasts, AI agent status updates, coordination logs, and notifications. Unlike documents, channels grow over time as messages are appended.

## Sending a Message

\`\`\`
execute_tool("send_channel_message", {
  channelId: "<CHANNEL page ID>",
  content: "Task X completed successfully. Results saved to /Reports/Q2 Analysis."
})
\`\`\`

The channelId is the pageId of a CHANNEL-type page.

## Reading Channel History

Use read_page on the CHANNEL page. The response includes a \`channelMessages\` array, each with:
\`\`\`
{
  lineNumber: 1,
  senderName: "Research Agent",
  senderType: "agent",  // or "user" or "global_assistant"
  content: "...",
  createdAt: "2026-05-23T10:00:00Z"
}
\`\`\`

## Common Workflows

**Agent status updates:**
After completing a task, the agent posts to a project channel:
\`\`\`
execute_tool("send_channel_message", {
  channelId: "<Project Updates channel ID>",
  content: "Research phase complete. 12 sources reviewed. Summary doc updated."
})
\`\`\`

**Coordination between agents:**
Agent A posts to a channel; Agent B reads the channel to pick up new work items. Use this as a lightweight message-passing mechanism.

**Create a channel for a project:**
create_page with type=CHANNEL, title="Project Alpha Updates", driveId=\`<drive>\`, parentId=\`<Project Alpha folder ID>\`

## Composition Patterns

- Put a CHANNEL next to a TASK_LIST so agents post status updates when tasks complete
- Create an "Inbox" CHANNEL where agents post requests for human review
- Use a CHANNEL as an audit log for automated agent actions in a drive

## Common Mistakes

- Confusing channelId with a user ID or drive ID — channelId is always the pageId of a CHANNEL page
- Trying to edit channel messages — channels are append-only; you can only send new messages
- Using replace_lines on a CHANNEL — not supported; use send_channel_message
- Sending very long messages in a single call — break large updates into logical chunks
`,

  drives: `# Drives — PageSpace Tool Guide

## Concept & Mental Model

A **drive** is the top-level workspace container. Everything — pages, agents, channels, calendars — lives inside a drive. Drives have their own member roles, AI context, and URL slug. Think of a drive as a project workspace or team folder.

## When to Create a New Drive vs. a Folder

| Situation | Use |
|-----------|-----|
| New team / project with separate members | Create a new drive |
| Subdivision within an existing team's work | Create a FOLDER inside an existing drive |
| Experiments or scratch space | Create a FOLDER in an existing drive |
| Completely separate initiative | Create a new drive |

## Drive Context (AI Instructions)

The **drive context** (drivePrompt) is a shared instruction set injected into all AI agents in the drive. Use it for:
- Project background all agents should know
- Conventions agents should follow ("Always cite sources", "Use Markdown formatting")
- Links to key documents agents should reference

\`\`\`
execute_tool("update_drive_context", {
  driveId: "<drive ID>",
  context: "This drive is for the Q3 marketing campaign. Key docs: /Brief, /Brand Guidelines. Always link to sources."
})
\`\`\`

## Common Workflows

**List all drives the user can access:**
execute_tool("list_drives") or use the core list_drives tool directly.

**Create a new drive:**
execute_tool("create_drive", { name: "Product Roadmap", description: "Strategic planning workspace" })

**Set up a drive's AI context:**
After creating a drive, call update_drive_context to give all agents shared background.

**Rename a drive:**
execute_tool("rename_drive", { driveId: "<id>", name: "New Name" })

## Drive Slug

Each drive has a URL-safe slug (e.g., "product-roadmap"). The slug appears in URLs and page paths. It's auto-generated from the drive name but can be renamed via rename_drive. Use the drive's ID (not slug) for all tool calls.

## Common Mistakes

- Passing the drive slug instead of the drive ID to tools — always use the drive's \`id\` field
- Creating a new drive for every small project — prefer folders inside an existing drive to avoid fragmentation
- Not setting drive context — agents in a drive without context have no shared background and produce inconsistent results
- Trying to move a page across drives with move_page — cross-drive moves are not supported; recreate the page in the target drive
`,
};

export function getToolDoc(category: string): string | null {
  return DOCS[category as ToolDocCategory] ?? null;
}
