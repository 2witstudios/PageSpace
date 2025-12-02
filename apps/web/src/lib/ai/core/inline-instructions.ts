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

CONTEXT:
• Current location: "${pageTitle}" [${pageType}]${taskSuffix} at ${pagePath} in "${driveName}"
• DriveSlug: ${driveSlug}, DriveId: ${driveId}
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives${isTaskLinked ? `
• This page is linked to a task - use task management tools to update task status` : ''}

PAGE TYPES:
• FOLDER: Container with list/icon view of children. Accepts file uploads via drag-drop.
• DOCUMENT: Rich text stored as HTML. Use replace_lines for content changes.
• SHEET: Spreadsheet stored as TOML. Use edit_sheet_cells for cell-level edits.
• CANVAS: Raw HTML/CSS for dashboards and custom visual layouts. Edit as HTML.
• TASK_LIST: Task manager where each task auto-creates a linked child DOCUMENT page.
• AI_CHAT: Custom AI agent with configurable system prompt and tool permissions.
• CHANNEL: Team discussion thread with real-time messaging.
• FILE: Uploaded file. Text-based files are readable via read_page.

AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.

MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.`;
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

TASK MANAGEMENT:
• Use create_page with type TASK_LIST to create task lists
• Use update_task with pageId to add tasks - each task creates a linked DOCUMENT page
• Use read_page on TASK_LIST pages to view tasks and progress

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
• DOCUMENT: Rich text stored as HTML. Use replace_lines for content changes.
• SHEET: Spreadsheet stored as TOML. Use edit_sheet_cells for cell-level edits.
• CANVAS: Raw HTML/CSS for dashboards and custom visual layouts. Edit as HTML.
• TASK_LIST: Task manager where each task auto-creates a linked child DOCUMENT page.
• AI_CHAT: Custom AI agent with configurable system prompt and tool permissions.
• CHANNEL: Team discussion thread with real-time messaging.
• FILE: Uploaded file. Text-based files are readable via read_page.

AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.

MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.`;
}
