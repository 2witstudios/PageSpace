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
• update_task, reorder_task, delete_task, get_assigned_tasks are all available
• set_task_trigger fires an agent on task due_date or completion

AGENTS:
• Discover agents: list_agents (current drive) or multi_drive_list_agents (all drives)
• Consult or delegate: ask_agent — pass conversationId to continue a prior thread
• Configure an agent: update_agent_config — always call list_models first for valid model IDs

AUTOMATION:
• Cron workflows (create_workflow): agent runs on a schedule — cron expression + timezone + agentPageId
• Task triggers (set_task_trigger): agent fires on task due_date or completion
• Calendar triggers (set_calendar_trigger): agent fires at event time or as a reminder
• All triggers require: agentPageId (an AI_CHAT page in the same drive) + prompt or instructionPageId

SEARCH:
• glob_search — find pages by name pattern ("Meeting Notes*", "**/*.md")
• regex_search — search page content or conversation history
• multi_drive_search — search across all drives simultaneously

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
• update_task, reorder_task, delete_task, get_assigned_tasks are all available
• set_task_trigger fires an agent on task due_date or completion

AGENTS:
• Discover agents: list_agents (current drive) or multi_drive_list_agents (all drives)
• Consult or delegate: ask_agent — pass conversationId to continue a prior thread
• Configure an agent: update_agent_config — always call list_models first for valid model IDs

AUTOMATION:
• Cron workflows (create_workflow): agent runs on a schedule — cron expression + timezone + agentPageId
• Task triggers (set_task_trigger): agent fires on task due_date or completion
• Calendar triggers (set_calendar_trigger): agent fires at event time or as a reminder
• All triggers require: agentPageId (an AI_CHAT page in the same drive) + prompt or instructionPageId

SEARCH:
• glob_search — find pages by name pattern ("Meeting Notes*", "**/*.md")
• regex_search — search page content or conversation history
• multi_drive_search — search across all drives simultaneously

AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.

MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.
When writing content that should notify people:
• @[everyone](driveId:everyone) — notifies all drive members (use DriveId from CONTEXT)
• @[Name](userId:user) — notifies a specific user
• @[Role Name](roleId:role) — notifies all members with that role`;
}
