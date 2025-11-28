/**
 * Inline Instructions for AI Chat
 *
 * Minimal, trust-the-model instructions appended to system prompts.
 * The model infers tool usage from schemas; these provide context-specific rules.
 */

export interface InlineInstructionsContext {
  pageTitle?: string;
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
    driveName = 'current',
    pagePath = 'current-page',
    driveSlug = 'current-drive',
    driveId = 'current-drive-id',
  } = context;

  return `
WORKSPACE RULES:
• Any page type can contain any other - organize for user needs, not type conventions
• Always read before write. FILE pages are read-only (uploads).
• Provide both driveId and driveSlug for operations.

CONTEXT:
• Current location: "${pageTitle}" at ${pagePath} in "${driveName}"
• DriveSlug: ${driveSlug}, DriveId: ${driveId}
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives

PAGE TYPES:
• FOLDER: Organize content hierarchically
• DOCUMENT: Written content (notes, reports, SOPs)
• AI_CHAT: Contextual AI conversations for specific topics
• CHANNEL: Team discussions and collaboration
• CANVAS: Custom HTML/CSS pages for dashboards, portals, presentations
• SHEET: Structured data (deprecated but available)

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
• Use create_task_list for multi-step work (3+ actions)
• Update task status as you progress - users see real-time updates

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
AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.

MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.`;
}
