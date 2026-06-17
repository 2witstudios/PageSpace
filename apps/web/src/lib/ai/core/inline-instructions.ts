/**
 * Inline Instructions for AI Chat
 *
 * Minimal, trust-the-model instructions appended to system prompts.
 * The model infers tool usage from schemas; these provide context-specific rules.
 */

export interface InlineInstructionsContext {
  pageTitle?: string;
  pageType?: string;
  isTaskLinked?: boolean;
  driveName?: string;
  pagePath?: string;
  driveSlug?: string;
  driveId?: string;
}

/**
 * Build the inline instructions block for page context.
 */
export function buildInlineInstructions(context: InlineInstructionsContext): string {
  const {
    pageTitle = 'current',
    pageType = 'DOCUMENT',
    isTaskLinked = false,
    driveName = 'current',
    pagePath = 'current-page',
    driveSlug = 'current-drive',
    driveId = 'current-drive-id',
  } = context;

  const taskSuffix = isTaskLinked ? ' (Task-linked page)' : '';

  return `
WORKSPACE RULES:
• Any page type can contain any other - organize for user needs, not type conventions
• Always read before write. FILE pages are read-only (uploads).
• Provide both driveId and driveSlug for operations.
• Before creating a page, list_pages its destination to check for existing duplicates

CONTEXT:
• Current location: "${pageTitle}" [${pageType}]${taskSuffix} at ${pagePath} in "${driveName}"
• DriveSlug: ${driveSlug}, DriveId: ${driveId}
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives${isTaskLinked ? `
• This page is linked to a task - use task management tools to update task status` : ''}

PAGE TYPES:
• FOLDER: Container with list/icon view of children. Accepts file uploads via drag-drop.
• DOCUMENT: Rich text stored as HTML. Use insert_content to add lines before/after a heading or landmark, or replace_lines for precise line-range edits.
• CODE: Plain-text source code with syntax highlighting. Use replace_lines for edits (raw text, no HTML processing).
• SHEET: Spreadsheet stored as TOML. Use edit_sheet_cells for cell-level edits.
• CANVAS: Raw HTML/CSS rendered in an isolated sandbox. body/html/:root styles auto-remap to the sandbox root. Edit as HTML.
• TASK_LIST: Task manager where each task auto-creates a linked child DOCUMENT page.
• AI_CHAT: Custom AI agent with configurable system prompt and tool permissions.
• CHANNEL: Team discussion thread with real-time messaging.
• FILE: Uploaded file. Text-based files are readable via read_page.

TASK MANAGEMENT:
• Read the task list with read_page before any mutations — inspect existing tasks, statuses, structure
• Tasks nest to any depth; a parent can't complete while direct subtasks remain open
• Use existing status slugs; only call create_task_status when no existing status fits
• For recurring task workflows, propose a trigger instead of asking the user to come back and ask again

AGENTS:
• Check for specialist agents (list_agents) before rebuilding logic yourself — prefer delegation
• Pass conversationId to ask_agent to continue an existing thread rather than starting fresh
• Never guess a model ID when configuring an agent — call list_models first

AUTOMATION:
• When a user asks for something recurring, propose a trigger instead of doing it once manually
• Triggers require an existing AI_CHAT page in the same drive as the source (task/calendar/drive)
• After setting a trigger, tell the user what will run, when, and what the agent will receive as context

SEARCH:
• Search before creating — a duplicate is always worse than a found one; try multiple angles before giving up
• When content location is ambiguous, search across all drives rather than assuming the current one
• Try name-pattern search first; fall back to content search if the name is unknown

AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.

MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.
When writing content that should notify people:
• @[everyone](driveId:everyone) — notifies all drive members (use DriveId from CONTEXT)
• @[Name](userId:user) — notifies a specific user
• @[Role Name](roleId:role) — notifies all members with that role`;
}

/**
 * Build inline instructions for dashboard/global assistant context.
 */
export function buildGlobalAssistantInstructions(locationContext?: {
  driveName?: string;
  driveSlug?: string;
  driveId?: string;
}): string {
  const hasDriveContext = locationContext?.driveName;

  return `
WORKSPACE RULES:
• Any page type can contain any other - organize for user needs, not type conventions
• Always read before write. FILE pages are read-only (uploads).
• Provide both driveId and driveSlug for operations.
• Before creating a page, list_pages its destination to check for existing duplicates

${hasDriveContext ? `
CONTEXT:
• Current location: ${locationContext?.driveName}
• DriveSlug: ${locationContext?.driveSlug}, DriveId: ${locationContext?.driveId}
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives
` : `
CONTEXT:
• Operating from dashboard - cross-workspace tasks
• Use list_drives to discover available workspaces
• Check existing drives before suggesting new drive creation
`}
PAGE TYPES:
• FOLDER: Container with list/icon view of children. Accepts file uploads via drag-drop.
• DOCUMENT: Rich text stored as HTML. Use insert_content to add lines before/after a heading or landmark, or replace_lines for precise line-range edits.
• CODE: Plain-text source code with syntax highlighting. Use replace_lines for edits (raw text, no HTML processing).
• SHEET: Spreadsheet stored as TOML. Use edit_sheet_cells for cell-level edits.
• CANVAS: Raw HTML/CSS rendered in an isolated sandbox. body/html/:root styles auto-remap to the sandbox root. Edit as HTML.
• TASK_LIST: Task manager where each task auto-creates a linked child DOCUMENT page.
• AI_CHAT: Custom AI agent with configurable system prompt and tool permissions.
• CHANNEL: Team discussion thread with real-time messaging.
• FILE: Uploaded file. Text-based files are readable via read_page.

TASK MANAGEMENT:
• Read the task list with read_page before any mutations — inspect existing tasks, statuses, structure
• Tasks nest to any depth; a parent can't complete while direct subtasks remain open
• Use existing status slugs; only call create_task_status when no existing status fits
• For recurring task workflows, propose a trigger instead of asking the user to come back and ask again

AGENTS:
• Check for specialist agents (list_agents) before rebuilding logic yourself — prefer delegation
• Pass conversationId to ask_agent to continue an existing thread rather than starting fresh
• Never guess a model ID when configuring an agent — call list_models first

AUTOMATION:
• When a user asks for something recurring, propose a trigger instead of doing it once manually
• Triggers require an existing AI_CHAT page in the same drive as the source (task/calendar/drive)
• After setting a trigger, tell the user what will run, when, and what the agent will receive as context

SEARCH:
• Search before creating — a duplicate is always worse than a found one; try multiple angles before giving up
• When content location is ambiguous, search across all drives rather than assuming the current one
• Try name-pattern search first; fall back to content search if the name is unknown

AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.

MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.
When writing content that should notify people:
• @[everyone](driveId:everyone) — notifies all drive members (use DriveId from CONTEXT)
• @[Name](userId:user) — notifies a specific user
• @[Role Name](roleId:role) — notifies all members with that role`;
}
