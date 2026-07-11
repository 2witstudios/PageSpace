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

// AUTHORING RULE: These sections correct format mistakes and non-intuitive workflows.
// Do NOT list tool names here — the model already receives a flat tool list and can call tool_search.
// Add a bullet only when the model predictably gets it wrong without explicit guidance.

// ---------------------------------------------------------------------------
// Shared sections — identical in both page-context and global-assistant flows
// ---------------------------------------------------------------------------

const WORKSPACE_RULES = `WORKSPACE RULES:
• Any page type can contain any other - organize for user needs, not type conventions
• Always read before write. FILE pages are read-only (uploads).
• Provide both driveId and driveSlug for operations.
• Before creating a page, list_pages its destination to check for existing duplicates`;

const PAGE_TYPES = `PAGE TYPES:
• FOLDER: Container with list/icon view of children. Accepts file uploads via drag-drop.
• DOCUMENT: Rich text stored as HTML. Use insert_content to add lines before/after a heading or landmark, or replace_lines for precise line-range edits.
• CODE: Plain-text source code with syntax highlighting. Use replace_lines for edits (raw text, no HTML processing).
• SHEET: Spreadsheet stored as TOML. Use edit_sheet_cells for cell-level edits.
• CANVAS: Raw HTML/CSS rendered in a sandboxed iframe. Author HTML renders into a real <body> — write standard HTML/CSS/JS. For uploaded FILE pages embedded in canvas HTML, use /dashboard/{driveId}/{filePageId}/view (not /api/files) so the same link works in unpublished iframes and can be rewritten for published canvases. For a signup/waitlist/contact form, call provision_form_target first — a hand-written <form> instead needs a human to finish wiring it to a Sheet in the page's Forms tab, since there's no tool for that step.
• TASK_LIST: Task manager where each task auto-creates a linked child TASK_LIST page for its description and sub-tasks.
• AI_CHAT: Custom AI agent with configurable system prompt and tool permissions.
• CHANNEL: Team discussion thread with real-time messaging.
• FILE: Uploaded file. Text-based files are readable via read_page.`;

const TASK_MANAGEMENT = `TASK MANAGEMENT:
• Read the task list with read_page before any mutations — inspect existing tasks, statuses, structure
• Tasks nest to any depth; a parent can't complete while direct subtasks remain open
• Use existing status slugs; only call create_task_status when no existing status fits
• For recurring task workflows, propose a trigger instead of asking the user to come back and ask again`;

const AGENTS = `AGENTS:
• Discover available agents first — each has its own system prompt, tools, and expertise; list_agents reveals what's configured
• Pass conversationId to continue an existing conversation — without it a new thread starts every time; save the id from each response for follow-ups
• The target agent does its own discovery and tool use — give it a clear question with context, not a pre-solved spec
• Never guess a model ID when configuring an agent — call list_models first`;

const AUTOMATION = `AUTOMATION:
• When a user asks for something recurring, propose a trigger instead of doing it once manually
• Triggers require an existing AI_CHAT page in the same drive as the source (task/calendar/drive)
• After setting a trigger, tell the user what will run, when, and what the agent will receive as context`;

const SEARCH = `SEARCH:
• list_pages returns one level at a time (ls-style) — navigate with parentId to drill into folders; use recursive: true for a full subtree dump
• Escalate: list_pages (structure) → glob_search (name pattern) → regex_search (content) → multi_drive_search (location unknown)
• When a task needs domain expertise, check list_agents — a workspace agent may already know the answer better than a page search will
• Try at least two angles before declaring something not found; a single failed search is not "not found"
• For external knowledge or a user-provided URL: web_search to discover, web_fetch to read a specific page`;

const AFTER_TOOLS = `AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.`;

/** Guidance for the ask_user tool. Exported so the Global Assistant route (which
 * builds its own bespoke system prompt rather than calling buildInlineInstructions)
 * can append the identical wording instead of drifting. */
export const ASK_USER_SECTION = `ASKING THE USER:
• Ask when missing context would materially shape the result — not just because a detail would help a little
• Skip asking if the user's signaled they want autonomous work (e.g. "just do it," "don't check in with me," running unattended)
• Never ask something you could find out yourself by searching or reading the drive first
• 1-4 questions per call, 2-4 concise options each — the UI adds a free-text "Other" option automatically, don't add your own catch-all
• After calling ask_user, stop — do not call finish or any other tool in the same turn; it resumes when the user answers
• The result may be {"dismissed": true} — the user replied in chat instead of picking an option; treat their message as the answer`;

/**
 * MENTIONS section — the @[everyone] bullet is conditional on whether a driveId
 * is available in context. Without one, instructing the model to use "DriveId from
 * CONTEXT" produces invalid mention payloads and broken notifications.
 */
function buildMentions(hasDriveId: boolean): string {
  const everyoneLine = hasDriveId
    ? `• @[everyone](driveId:everyone) — notifies all drive members (use DriveId from CONTEXT)`
    : `• @[everyone](driveId:everyone) — notifies all drive members; requires the target drive's ID — resolve via list_drives or from the resource you're working on`;

  return `MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.
When writing content that should notify people:
• @[Name](userId:user) — notifies a specific user
• @[Role Name](roleId:role) — notifies all members with that role
${everyoneLine}`;
}

// ---------------------------------------------------------------------------
// Exported builders
// ---------------------------------------------------------------------------

/** Returns true if any of `toolNames` appears in `availableTools`, or if `availableTools` is undefined (include-all sentinel). */
function hasAny(availableTools: string[] | undefined, toolNames: string[]): boolean {
  if (!availableTools) return true;
  return toolNames.some(t => availableTools.includes(t));
}

/**
 * Build the inline instructions block for page context.
 *
 * Pass `availableTools` (the filtered tool name list) to omit sections for
 * capabilities the agent doesn't have. Omitting `availableTools` includes
 * all sections — used by the admin prompt viewer for a complete preview.
 */
export function buildInlineInstructions(
  context: InlineInstructionsContext,
  availableTools?: string[]
): string {
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

  const includeTaskManagement = hasAny(availableTools, ['create_task', 'update_task', 'delete_task', 'create_task_status', 'reorder_task', 'get_assigned_tasks']);
  const includeAgents = hasAny(availableTools, ['ask_agent', 'list_agents', 'multi_drive_list_agents', 'update_agent_config', 'list_models']);
  const includeAutomation = hasAny(availableTools, ['set_task_trigger', 'delete_task_trigger', 'set_calendar_trigger', 'delete_calendar_trigger', 'create_workflow', 'list_workflows']);
  const includeSearch = hasAny(availableTools, ['glob_search', 'regex_search', 'multi_drive_search', 'web_search', 'web_fetch']);
  const includeAskUser = hasAny(availableTools, ['ask_user']);

  const sections = [
    WORKSPACE_RULES,
    `CONTEXT:
• Current location: "${pageTitle}" [${pageType}]${taskSuffix} at ${pagePath} in "${driveName}"
• DriveSlug: ${driveSlug}, DriveId: ${driveId}
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives${isTaskLinked ? `
• This page is linked to a task - use task management tools to update task status` : ''}`,
    PAGE_TYPES,
    includeTaskManagement ? TASK_MANAGEMENT : null,
    includeAgents ? AGENTS : null,
    includeAutomation ? AUTOMATION : null,
    includeSearch ? SEARCH : null,
    includeAskUser ? ASK_USER_SECTION : null,
    AFTER_TOOLS,
    buildMentions(true),
  ].filter(Boolean);

  return '\n' + sections.join('\n\n');
}

/**
 * Build inline instructions for dashboard/global assistant context.
 */
export function buildGlobalAssistantInstructions(locationContext?: {
  driveName?: string;
  driveSlug?: string;
  driveId?: string;
}): string {
  const hasDriveContext = !!locationContext?.driveName;

  const contextSection = hasDriveContext
    ? `CONTEXT:
• Current location: ${locationContext?.driveName}
• DriveSlug: ${locationContext?.driveSlug}, DriveId: ${locationContext?.driveId}
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives`
    : `CONTEXT:
• Operating from dashboard - cross-workspace tasks
• Use list_drives to discover available workspaces
• Check existing drives before suggesting new drive creation`;

  return `
${WORKSPACE_RULES}

${contextSection}

${PAGE_TYPES}

${TASK_MANAGEMENT}

${AGENTS}

${AUTOMATION}

${SEARCH}

${AFTER_TOOLS}

${buildMentions(hasDriveContext)}`;
}
